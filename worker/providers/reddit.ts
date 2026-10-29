import type { FieldOption } from "../../shared/types";
import { missingScope, ProviderError } from "./errors";
import { checkedCommit, clientFields, expiresAt, oauthToken, requestJson, requireApp, type RequestOptions } from "./http";
import { postFormStreaming, xmlTag } from "./s3-form-upload";
import type { AccountRecord, MediaItem, MetricValues, PostMetricsResult, Provider, ProviderContext, PublishResult } from "./types";

const OAUTH = "https://oauth.reddit.com";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const SCOPES = ["identity", "submit", "read", "mysubreddits", "flair"];
// Reddit throttles generic user agents hard; it asks for "<platform>:<app id>:<version> (by ...)".
const USER_AGENT = "web:postflare:1.0 (self-hosted social scheduler)";
/** /api/info accepts up to 100 fullnames per request. */
const METRICS_BATCH = 100;
/** Media posts are matched against the user's submissions for this many checks before giving up. */
const MAX_LOOKUPS = 40;

const subredditName = (v: unknown) =>
  String(v ?? "")
    .trim()
    .replace(/^(https?:\/\/(www\.)?reddit\.com)?\/?r\//i, "")
    .replace(/\/+$/, "");

function rd<T = any>(ctx: ProviderContext, account: AccountRecord, path: string, opts: RequestOptions = {}) {
  return requestJson<T>(ctx, `${OAUTH}${path}`, {
    ...opts,
    token: account.credentials.accessToken as string,
    headers: { "user-agent": USER_AGENT, ...(opts.headers as any) },
    query: { raw_json: 1, ...opts.query },
  });
}

const basic = (ctx: ProviderContext) => {
  const app = requireApp(ctx, "Reddit", "clientId", "clientSecret");
  return { basicAuth: { id: app.clientId, secret: app.clientSecret }, headers: { "user-agent": USER_AGENT } };
};

/** `{ json: { errors: [[code, message, field]] } }` comes back with HTTP 200. */
function checkErrors(res: any, what: string) {
  const errors: string[][] = res?.json?.errors ?? [];
  if (!errors.length) return;
  const text = errors.map((e) => e[1] || e[0]).join("; ");
  const kind = errors.some((e) => e[0] === "RATELIMIT") ? "rate_limit" : errors.some((e) => e[0] === "USER_REQUIRED") ? "auth" : "invalid";
  throw new ProviderError(`Reddit rejected the ${what}: ${text}`, kind, 200, res);
}

/** Media asset lease → S3 form upload. Returns the hosted URL to submit. */
async function uploadMedia(ctx: ProviderContext, account: AccountRecord, item: MediaItem): Promise<string> {
  const lease = await rd<{ args: { action: string; fields: Array<{ name: string; value: string }> } }>(ctx, account, "/api/media/asset.json", {
    method: "POST",
    form: { filepath: item.filename, mimetype: item.mime },
  });
  const action = lease.args.action.startsWith("//") ? `https:${lease.args.action}` : lease.args.action;
  const fields = lease.args.fields.map((f) => [f.name, f.value] as [string, string]);
  const res = await postFormStreaming(ctx, action, fields, {
    field: "file",
    filename: item.filename,
    type: item.mime,
    size: item.size,
    stream: await ctx.media.stream(item),
  });
  const key = fields.find(([k]) => k === "key")?.[1];
  const location = xmlTag(await res.text().catch(() => ""), "Location");
  if (location) return decodeURIComponent(location);
  if (key) return `${action.replace(/\/$/, "")}/${key}`;
  throw new ProviderError("Reddit media upload did not return a location", "transient");
}

/** Image/video submissions return no id (Reddit processes them asynchronously): find them in the user's submissions. */
async function findSubmission(ctx: ProviderContext, account: AccountRecord, state: Record<string, any>) {
  const res = await rd<{ data: { children: Array<{ data: any }> } }>(ctx, account, `/user/${encodeURIComponent(state.username)}/submitted`, {
    query: { sort: "new", limit: 25 },
  });
  return res.data?.children
    ?.map((c) => c.data)
    .find(
      (d) =>
        String(d.subreddit).toLowerCase() === String(state.subreddit).toLowerCase() &&
        d.title === state.title &&
        d.created_utc * 1000 >= state.since - 60_000,
    );
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Drop keys the platform did not report (and an empty `extra`). */
function compact(m: MetricValues): MetricValues {
  const out: MetricValues = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "extra") {
      const extra = Object.fromEntries(Object.entries(v as Record<string, number | undefined>).filter(([, x]) => x !== undefined));
      if (Object.keys(extra).length) out.extra = extra as Record<string, number>;
    } else if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}

/** Fullname (t3_xxx) of a published post; null for ids that never resolved (`unresolved:...`). */
function fullname(externalId: string): string | null {
  if (externalId.startsWith("t3_")) return externalId;
  return /^[a-z0-9]+$/i.test(externalId) ? `t3_${externalId}` : null;
}

/** GET for analytics: a 403 (token without the `read` scope) only flags analytics as reconnect_required. */
async function rdRead<T = any>(ctx: ProviderContext, account: AccountRecord, path: string, opts: RequestOptions = {}) {
  try {
    return await rd<T>(ctx, account, path, opts);
  } catch (err) {
    if (err instanceof ProviderError && err.status === 403) throw missingScope("Reddit", path.startsWith("/api/v1/me") ? "identity" : "read");
    throw err;
  }
}

export const reddit: Provider = {
  id: "reddit",
  name: "Reddit",
  color: "FF4500",
  icon: "reddit",
  category: "community",
  auth: "oauth2",
  appFields: clientFields(),
  docsUrl: "https://www.reddit.com/prefs/apps",
  setupNotes: [
    "1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) and click **create another app**.",
    "2. Choose type **web app** and set the redirect uri to `{{redirectUri}}`.",
    "3. Copy the client id (under the app name) and the secret here.",
    `Scopes requested: \`${SCOPES.join(" ")}\`. Reddit may require you to register for API access for commercial use.`,
    "Analytics (score, comments, upvote ratio, karma) use the `read` and `identity` scopes.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: [
    {
      key: "subreddit",
      label: "Subreddit",
      type: "text",
      required: true,
      dynamicOptions: true,
      placeholder: "r/test",
      help: "Pick one of your subreddits or type any name.",
    },
    { key: "title", label: "Title", type: "text", required: true, maxLength: 300 },
    {
      key: "kind",
      label: "Post type",
      type: "select",
      default: "self",
      options: [
        { value: "self", label: "Text" },
        { value: "link", label: "Link" },
        { value: "media", label: "Image / video (attached media)" },
      ],
    },
    { key: "url", label: "Link URL", type: "url", required: true, showIf: { key: "kind", equals: "link" } },
    { key: "flair", label: "Flair", type: "select", dynamicOptions: true, help: "Loaded for the chosen subreddit." },
    { key: "nsfw", label: "NSFW", type: "checkbox", default: false },
    { key: "spoiler", label: "Spoiler", type: "checkbox", default: false },
    { key: "sendReplies", label: "Send replies to my inbox", type: "checkbox", default: true },
  ],
  capabilities: {
    maxLength: 40_000,
    text: "optional",
    // Media posts take one image, or one video plus an optional poster image.
    media: { images: 1, videos: 1, mixed: true, required: false },
    thread: true,
    threadLabel: "Comments",
  },

  metrics: {
    post: ["likes", "comments", "views"],
    account: ["followers"],
    batch: METRICS_BATCH,
    scopes: ["read", "identity"],
  },

  authorize(ctx, { state }) {
    const app = requireApp(ctx, "Reddit", "clientId", "clientSecret");
    const u = new URL("https://www.reddit.com/api/v1/authorize");
    u.search = new URLSearchParams({
      client_id: app.clientId,
      response_type: "code",
      state,
      redirect_uri: ctx.redirectUri,
      duration: "permanent",
      scope: SCOPES.join(" "),
    }).toString();
    return u.toString();
  },

  async callback(ctx, { code }) {
    const tok = await oauthToken(ctx, TOKEN_URL, { grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri }, basic(ctx));
    const me = await requestJson<{ id: string; name: string; icon_img?: string; snoovatar_img?: string }>(ctx, `${OAUTH}/api/v1/me`, {
      token: tok.access_token,
      headers: { "user-agent": USER_AGENT },
      query: { raw_json: 1 },
    });
    return [
      {
        externalId: me.id,
        name: `u/${me.name}`,
        username: me.name,
        avatarUrl: (me.snoovatar_img || me.icon_img || "").split("?")[0] || null,
        profileUrl: `https://www.reddit.com/user/${me.name}/`,
        credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
        expiresAt: expiresAt(tok.expires_in),
      },
    ];
  },

  async refresh(ctx, account) {
    if (!account.credentials.refreshToken) throw new ProviderError("No refresh token: reconnect the Reddit account", "auth");
    const tok = await oauthToken(ctx, TOKEN_URL, { grant_type: "refresh_token", refresh_token: account.credentials.refreshToken }, basic(ctx));
    return {
      credentials: { ...account.credentials, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? account.credentials.refreshToken },
      expiresAt: expiresAt(tok.expires_in),
    };
  },

  async options(ctx, account, key, settings): Promise<FieldOption[]> {
    if (key === "subreddit") {
      const seen = new Map<string, FieldOption>();
      for (const where of ["moderator", "subscriber"]) {
        const res = await rd<{ data: { children: Array<{ data: { display_name: string; display_name_prefixed: string } }> } }>(
          ctx,
          account,
          `/subreddits/mine/${where}`,
          { query: { limit: 100 } },
        );
        for (const { data } of res.data?.children ?? []) {
          if (!seen.has(data.display_name.toLowerCase())) seen.set(data.display_name.toLowerCase(), { value: data.display_name, label: data.display_name_prefixed });
        }
      }
      return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
    }
    if (key === "flair") {
      const sr = subredditName(settings.subreddit);
      if (!sr) return [];
      try {
        const flairs = await rd<Array<{ id: string; text: string }>>(ctx, account, `/r/${encodeURIComponent(sr)}/api/link_flair_v2`);
        return (flairs ?? []).map((f) => ({ value: f.id, label: f.text || f.id }));
      } catch (err) {
        // Subreddits without (or with restricted) link flair answer 403/404.
        if (err instanceof ProviderError && err.kind === "invalid") return [];
        throw err;
      }
    }
    return [];
  },

  validate(post) {
    const s = post.settings;
    const errors: string[] = [];
    const kind = s.kind || "self";
    const videos = post.media.filter((m) => m.kind === "video").length;
    const images = post.media.filter((m) => m.kind === "image").length;
    if (!subredditName(s.subreddit)) errors.push('Reddit: "Subreddit" is required');
    if (!String(s.title ?? "").trim()) errors.push('Reddit: "Title" is required');
    if (kind === "media" && !post.media.length) errors.push("Reddit: attach an image or a video for a media post");
    if (kind !== "media" && post.media.length) errors.push('Reddit: set "Post type" to Image / video to post media');
    if (kind === "media" && !videos && images > 1) errors.push("Reddit: only one image per post");
    if (kind === "link" && !/^https?:\/\//i.test(String(s.url ?? ""))) errors.push("Reddit: a link post needs a valid URL");
    return errors;
  },

  async publish(ctx, account, post): Promise<PublishResult> {
    const s = post.settings;
    const sr = subredditName(s.subreddit);
    const title = String(s.title ?? "").trim();
    if (!sr || !title) throw new ProviderError("Reddit: subreddit and title are required", "invalid");
    const form: Record<string, string | boolean | undefined> = {
      api_type: "json",
      sr,
      title,
      nsfw: !!s.nsfw,
      spoiler: !!s.spoiler,
      sendreplies: s.sendReplies !== false,
      flair_id: s.flair || undefined,
      resubmit: true,
    };
    const kind = s.kind || "self";
    if (kind === "link") {
      Object.assign(form, { kind: "link", url: String(s.url ?? "") });
    } else if (kind === "media") {
      const video = post.media.find((m) => m.kind === "video");
      const poster = post.media.find((m) => m.kind === "image");
      if (video) {
        form.kind = "video";
        form.url = await uploadMedia(ctx, account, video);
        if (poster) form.video_poster_url = await uploadMedia(ctx, account, poster);
      } else if (poster) {
        form.kind = "image";
        form.url = await uploadMedia(ctx, account, poster);
      } else {
        throw new ProviderError("Reddit: attach an image or a video for a media post", "invalid");
      }
    } else {
      Object.assign(form, { kind: "self", text: post.content });
    }

    // The submit is the commit; Reddit reports refusals (rate limit, rules) as 200 + json.errors.
    const res = await checkedCommit(
      ctx,
      () => rd(ctx, account, "/api/submit", { method: "POST", form, commit: true }),
      (r) => checkErrors(r, "post"),
    );
    const data = res?.json?.data ?? {};
    if (data.name || data.id) {
      const name = data.name ?? `t3_${data.id}`;
      return { status: "published", externalId: name, url: data.url ?? `https://www.reddit.com/comments/${name.slice(3)}/` };
    }
    return {
      status: "pending",
      state: { username: account.username, subreddit: sr, title, since: Date.now(), lookups: 0, fallbackUrl: data.user_submitted_page ?? null },
      retryAfterSeconds: 10,
    };
  },

  async checkStatus(ctx, account, state) {
    const found = state.username ? await findSubmission(ctx, account, state) : undefined;
    if (found) return { status: "published", externalId: found.name, url: `https://www.reddit.com${found.permalink}` };
    const lookups = Number(state.lookups ?? 0) + 1;
    if (lookups < MAX_LOOKUPS) return { status: "pending", state: { ...state, lookups }, retryAfterSeconds: 15 };
    // The submission was accepted but never showed up (still processing or filtered): don't fail, it may well be live.
    ctx.log("warn", "Reddit accepted the media post but it did not appear in your submissions yet");
    return {
      status: "published",
      externalId: `unresolved:${state.subreddit}:${state.since}`,
      url: (state.fallbackUrl as string) || `https://www.reddit.com/r/${state.subreddit}/new/`,
    };
  },

  async reply(ctx, account, target, post) {
    if (!target.rootId.startsWith("t3_")) throw new ProviderError("Reddit: the post id is unknown, cannot comment", "invalid");
    if (post.media.length) ctx.log("warn", "Reddit comments are text-only; media was skipped");
    const res = await checkedCommit(
      ctx,
      () => rd(ctx, account, "/api/comment", { method: "POST", form: { api_type: "json", thing_id: target.rootId, text: post.content }, commit: true }),
      (r) => checkErrors(r, "comment"),
    );
    const c = res?.json?.data?.things?.[0]?.data ?? {};
    return { externalId: c.name ?? `t1_${c.id}`, url: c.permalink ? `https://www.reddit.com${c.permalink}` : null };
  },

  /**
   * One /api/info request for the whole batch. score → likes (net upvotes), plus extra upvote_ratio / crossposts.
   * view_count is almost always null (only reported to moderators): left out then. Unknown or unresolved ids → null.
   */
  async postMetrics(ctx, account, items) {
    const out: PostMetricsResult = {};
    const names = new Map<string, string>();
    for (const item of items.slice(0, METRICS_BATCH)) {
      const name = fullname(item.externalId);
      if (name) names.set(name, item.externalId);
      else out[item.externalId] = null;
    }
    if (!names.size) return out;
    const res = await rdRead<{ data?: { children?: Array<{ kind: string; data: any }> } }>(ctx, account, "/api/info", {
      query: { id: [...names.keys()].join(","), limit: METRICS_BATCH },
    });
    const found = new Map((res?.data?.children ?? []).map((c) => [String(c.data?.name), c.data]));
    for (const [name, externalId] of names) {
      const d = found.get(name);
      out[externalId] = d
        ? compact({
            likes: num(d.score),
            comments: num(d.num_comments),
            views: num(d.view_count),
            extra: { upvote_ratio: num(d.upvote_ratio), crossposts: num(d.num_crossposts) } as Record<string, number>,
          })
        : null;
    }
    return out;
  },

  /** Karma of the user (extra) and the followers of their profile (its user subreddit's subscribers). */
  async accountMetrics(ctx, account) {
    const me = await rdRead<any>(ctx, account, "/api/v1/me");
    return compact({
      followers: num(me?.subreddit?.subscribers),
      extra: {
        total_karma: num(me?.total_karma),
        link_karma: num(me?.link_karma),
        comment_karma: num(me?.comment_karma),
      } as Record<string, number>,
    });
  },
};
