import { ProviderError } from "./errors";
import { counted, fetchesLeft } from "./budget";
import { clientFields, expiresAt, oauthToken, requireApp, sleep } from "./http";
import { THREADS_GRAPH, bestEffort, graph, graphReply, insightValues, metricsFailure, metricsGet } from "./meta-shared";
import type { AccountRecord, MediaItem, MetricKey, MetricValues, PostMetricsResult, Provider, ProviderContext, PublishPost, PublishResult } from "./types";

const METRICS_SCOPES = ["threads_manage_insights"];
const SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_replies", ...METRICS_SCOPES];
/** Threads media insights: metric name → normalized key (same names). */
const POST_METRICS: MetricKey[] = ["views", "likes", "replies", "reposts", "quotes", "shares"];
const IMAGE_MIMES = /^image\/(jpeg|jpg|pjpeg|png)$/i;
/** Max time a reply may wait for its containers inside one call (replies have no pending flow). */
const REPLY_WAIT_MS = 25_000;
/** Creating N carousel children + N statuses + parent, status, publish, permalink stays within MAX_FETCHES (40). */
const MAX_REPLY_MEDIA = 18;

type Form = Record<string, string | number | boolean | undefined>;

type ThreadsState =
  | { step: "children"; childIds: string[]; parent: Form }
  | { step: "container"; containerId: string };

const token = (account: AccountRecord) => account.credentials.accessToken as string;

function mediaForm(m: MediaItem): Form {
  if (m.kind === "image" && !IMAGE_MIMES.test(m.mime))
    throw new ProviderError(`Threads only accepts JPEG or PNG images (${m.filename} is ${m.mime})`, "invalid");
  return m.kind === "video"
    ? { media_type: "VIDEO", video_url: m.url, alt_text: m.alt ?? undefined }
    : { media_type: "IMAGE", image_url: m.url, alt_text: m.alt ?? undefined };
}

async function createContainer(ctx: ProviderContext, account: AccountRecord, form: Form) {
  return (await graph<{ id: string }>(ctx, `${THREADS_GRAPH}/${account.externalId}/threads`, { method: "POST", token: token(account), form })).id;
}

type Status = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED";

async function containerStatus(ctx: ProviderContext, account: AccountRecord, id: string): Promise<Status> {
  const res = await graph<{ status?: Status; error_message?: string }>(ctx, `${THREADS_GRAPH}/${id}`, {
    token: token(account),
    query: { fields: "status,error_message" },
  });
  const status = res.status ?? "IN_PROGRESS";
  if (status === "ERROR" || status === "EXPIRED")
    throw new ProviderError(`Threads could not process the media (${status}): ${res.error_message || "no details"}`, "invalid", 200, res);
  return status;
}

async function publishContainer(ctx: ProviderContext, account: AccountRecord, containerId: string) {
  const { id } = await graph<{ id: string }>(ctx, `${THREADS_GRAPH}/${account.externalId}/threads_publish`, {
    method: "POST",
    token: token(account),
    form: { creation_id: containerId },
    commit: true,
  });
  const fallback = account.username ? `https://www.threads.net/@${account.username}` : null;
  const url = await bestEffort(
    async () => (await graph<{ permalink?: string }>(ctx, `${THREADS_GRAPH}/${id}`, { token: token(account), query: { fields: "permalink" } })).permalink ?? fallback,
    fallback,
  );
  return { id, url };
}

/** Creates the container(s) for one post or reply. Carousels return their children; the parent is created once they finished. */
async function createFor(ctx: ProviderContext, account: AccountRecord, post: PublishPost, extra: Form): Promise<ThreadsState> {
  const text = post.content || undefined;
  if (post.media.length > 1) {
    const childIds: string[] = [];
    for (const m of post.media) childIds.push(await createContainer(ctx, account, { ...mediaForm(m), is_carousel_item: true }));
    return { step: "children", childIds, parent: { ...extra, media_type: "CAROUSEL", text } };
  }
  const form: Form = post.media.length ? { ...extra, ...mediaForm(post.media[0]), text } : { ...extra, media_type: "TEXT", text };
  return { step: "container", containerId: await createContainer(ctx, account, form) };
}

/** One step of the container state machine: wait → (create carousel parent) → publish. Never publishes twice. */
async function advance(ctx: ProviderContext, account: AccountRecord, state: ThreadsState): Promise<PublishResult> {
  const wait = (s: ThreadsState, retryAfterSeconds = 10): PublishResult => ({ status: "pending", state: s as unknown as Record<string, unknown>, retryAfterSeconds });
  if (state.step === "children") {
    for (const id of state.childIds) if ((await containerStatus(ctx, account, id)) === "IN_PROGRESS") return wait(state);
    // An orphaned parent from a crashed attempt is invisible, so re-creating it is harmless.
    const containerId = await createContainer(ctx, account, { ...state.parent, children: state.childIds.join(",") });
    return advance(ctx, account, { step: "container", containerId });
  }
  const status = await containerStatus(ctx, account, state.containerId);
  if (status === "IN_PROGRESS") return wait(state);
  if (status === "PUBLISHED") {
    ctx.log("warn", "Threads reports the post as already published; not publishing again");
    return { status: "published", externalId: state.containerId, url: account.username ? `https://www.threads.net/@${account.username}` : null };
  }
  const { id, url } = await publishContainer(ctx, account, state.containerId);
  return { status: "published", externalId: id, url };
}

export const threads: Provider = {
  id: "threads",
  name: "Threads",
  color: "000000",
  icon: "threads",
  category: "social",
  auth: "oauth2",
  appFields: clientFields("Threads App ID", "Threads App Secret"),
  docsUrl: "https://developers.facebook.com/apps",
  setupNotes: [
    "1. Create an app at [developers.facebook.com/apps](https://developers.facebook.com/apps) and choose the **Access the Threads API** use case.",
    `2. In the use case settings, enable ${SCOPES.map((s) => `\`${s}\``).join(", ")}.`,
    "3. Under *Settings*, add `{{redirectUri}}` to the *Redirect Callback URLs* (uninstall callback: `{{baseUrl}}`; delete callback: `{{baseUrl}}/oauth/meta/data-deletion`).",
    "4. While the app is unpublished, add your Threads profile as a *Threads Tester* and accept the invite in Threads (Settings → Account → Website permissions).",
    "5. Copy the **Threads App ID** and **Threads App Secret** (not the Facebook App ID). Tokens last 60 days and are refreshed automatically.",
    "Analytics need `threads_manage_insights`; accounts connected before analytics existed must reconnect.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: [
    {
      key: "reply_control",
      label: "Who can reply",
      type: "select",
      default: "everyone",
      options: [
        { value: "everyone", label: "Everyone" },
        { value: "accounts_you_follow", label: "Accounts you follow" },
        { value: "followers_only", label: "Followers only" },
        { value: "mentioned_only", label: "Mentioned only" },
      ],
    },
    { key: "topic_tag", label: "Topic", type: "text", maxLength: 50, help: "One topic tag (no #)." },
    { key: "link_attachment", label: "Link preview", type: "url", help: "Link card for text-only posts." },
    { key: "quote_post_id", label: "Quote post ID", type: "text", help: "Media id of a Threads post to quote." },
  ],
  capabilities: {
    maxLength: 500,
    text: "optional",
    media: { images: 20, videos: 20, mixed: true, required: false },
    thread: true,
    threadLabel: "Thread replies",
  },

  validate(post) {
    const errors: string[] = [];
    const bad = post.media.filter((m) => m.kind === "image" && !IMAGE_MIMES.test(m.mime));
    if (bad.length) errors.push(`Threads only accepts JPEG or PNG images (${bad.map((m) => m.filename).join(", ")})`);
    if (!post.content.trim() && !post.media.length) errors.push("Threads posts need text or media");
    return errors;
  },

  authorize(ctx, { state }) {
    requireApp(ctx, "Threads", "clientId", "clientSecret");
    // threads.net/oauth/authorize bounces signed-in threads.com users to their feed and drops the request.
    const u = new URL("https://www.threads.com/oauth/authorize");
    u.searchParams.set("client_id", ctx.app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("scope", SCOPES.join(","));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async callback(ctx, { code }) {
    requireApp(ctx, "Threads", "clientId", "clientSecret");
    const short = await oauthToken(ctx, "https://graph.threads.net/oauth/access_token", {
      client_id: ctx.app.clientId,
      client_secret: ctx.app.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: ctx.redirectUri,
      code: code.replace(/#_$/, ""),
    });
    const long = await graph<{ access_token: string; expires_in?: number }>(ctx, "https://graph.threads.net/access_token", {
      query: { grant_type: "th_exchange_token", client_secret: ctx.app.clientSecret, access_token: short.access_token },
    });
    const me = await graph<{ id: string; username?: string; name?: string; threads_profile_picture_url?: string }>(ctx, `${THREADS_GRAPH}/me`, {
      token: long.access_token,
      query: { fields: "id,username,name,threads_profile_picture_url" },
    });
    return [
      {
        externalId: me.id,
        name: me.name || me.username || "Threads",
        username: me.username ?? null,
        avatarUrl: me.threads_profile_picture_url ?? null,
        profileUrl: me.username ? `https://www.threads.net/@${me.username}` : null,
        credentials: { accessToken: long.access_token },
        expiresAt: expiresAt(long.expires_in ?? 60 * 24 * 3600),
        // The long-lived token refreshes itself (th_refresh_token): it must be refreshed before it expires.
        refreshExpiresAt: expiresAt(long.expires_in ?? 60 * 24 * 3600),
      },
    ];
  },

  async profile(ctx, account) {
    const me = await graph<{ threads_profile_picture_url?: string }>(ctx, `${THREADS_GRAPH}/me`, {
      token: token(account),
      query: { fields: "threads_profile_picture_url" },
    });
    return { avatarUrl: me.threads_profile_picture_url ?? null };
  },

  async refresh(ctx, account) {
    const res = await graph<{ access_token: string; expires_in?: number }>(ctx, "https://graph.threads.net/refresh_access_token", {
      query: { grant_type: "th_refresh_token", access_token: token(account) },
    });
    const exp = expiresAt(res.expires_in ?? 60 * 24 * 3600);
    return { credentials: { ...account.credentials, accessToken: res.access_token }, expiresAt: exp, refreshExpiresAt: exp };
  },

  async publish(ctx, account, post) {
    const errors = threads.validate!(post);
    if (errors.length) throw new ProviderError(errors.join("; "), "invalid");
    const s = post.settings ?? {};
    const extra: Form = {
      reply_control: s.reply_control && s.reply_control !== "everyone" ? String(s.reply_control) : undefined,
      topic_tag: s.topic_tag ? String(s.topic_tag).replace(/^#/, "") : undefined,
      link_attachment: !post.media.length && s.link_attachment ? String(s.link_attachment) : undefined,
      quote_post_id: s.quote_post_id ? String(s.quote_post_id) : undefined,
    };
    const state = await createFor(ctx, account, post, extra);
    // Text containers are usually ready at once; media needs processing time, so hand over to checkStatus.
    if (state.step === "container" && !post.media.length) return advance(ctx, account, state);
    return { status: "pending", state: state as unknown as Record<string, unknown>, retryAfterSeconds: post.media.some((m) => m.kind === "video") ? 30 : 10 };
  },

  checkStatus: (ctx, account, state) => advance(ctx, account, state as unknown as ThreadsState),

  async reply(ctx, account, target, post) {
    const c = counted(ctx);
    // reply() cannot return pending: creating the containers plus one full publish round must fit in one call.
    if (post.media.length > MAX_REPLY_MEDIA)
      throw new ProviderError(`Threads replies can carry at most ${MAX_REPLY_MEDIA} media items here (subrequest limit)`, "invalid");
    let state = await createFor(c, account, post, { reply_to_id: target.parentId });
    // Nothing is visible before threads_publish, so giving up (and being retried) here cannot duplicate the reply.
    const deadline = Date.now() + REPLY_WAIT_MS;
    for (;;) {
      const result = await advance(c, account, state);
      if (result.status === "published") return { externalId: result.externalId, url: result.url ?? null };
      state = result.state as unknown as ThreadsState;
      // Next round worst case: a status per child, the carousel parent, its status, publish and permalink.
      const cost = (state.step === "children" ? state.childIds.length + 1 : 0) + 3;
      if (Date.now() > deadline || c.left() < cost) throw new ProviderError("Threads is still processing the reply media", "transient");
      await sleep(2000);
    }
  },

  // Threads has no batch endpoint: one insights GET per post, within the fetch budget.
  metrics: { post: POST_METRICS, account: ["followers"], batch: 10, scopes: METRICS_SCOPES },

  async postMetrics(ctx, account, items) {
    const result: PostMetricsResult = {};
    for (const { externalId: id } of items) {
      if (fetchesLeft(ctx) < 1) break;
      const r = await graphReply(ctx, `${THREADS_GRAPH}/${id}/insights`, { token: token(account), query: { metric: POST_METRICS.join(",") } });
      if (r.ok) {
        const v = insightValues(r.body?.data);
        const out: MetricValues = {};
        for (const k of POST_METRICS) if (k in v) out[k] = v[k];
        result[id] = out;
      } else {
        if (metricsFailure("Threads", METRICS_SCOPES, r) === "invalid") ctx.log("warn", `Threads metrics of ${id}: ${r.body?.error?.message ?? r.status}`);
        result[id] = null;
      }
    }
    return result;
  },

  async accountMetrics(ctx, account) {
    const res = await metricsGet(
      ctx,
      `${THREADS_GRAPH}/${account.externalId}/threads_insights`,
      { token: token(account), query: { metric: "followers_count" } },
      "Threads",
      METRICS_SCOPES,
    );
    const v = insightValues(res?.data);
    return typeof v.followers_count === "number" ? { followers: v.followers_count } : {};
  },
};
