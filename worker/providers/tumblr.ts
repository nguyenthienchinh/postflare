import { fetchesLeft } from "./budget";
import { ProviderError, type ProviderErrorKind } from "./errors";
import { clientFields, expiresAt, oauthToken, requestJson, requireApp } from "./http";
import { mediaPart, streamingMultipart } from "./multipart";
import type { AccountRecord, ConnectedAccount, MetricValues, PostMetricsResult, Provider, ProviderContext, PublishPost } from "./types";

const API = "https://api.tumblr.com/v2";
const SCOPES = "basic write offline_access";
const TEXT_BLOCK_LIMIT = 4096;



// ---------- tumblr ----------

// Tumblr wraps errors as { meta, errors: [{ code, detail }] }.
const classify = (status: number, body: any): ProviderErrorKind | undefined => {
  const codes: number[] = (body?.errors ?? []).map((e: any) => Number(e?.code));
  if (status === 401 || body?.error === "invalid_token" || body?.error === "invalid_grant") return "auth";
  if (codes.some((c) => c === 8006 || c === 8009)) return "transient";
  if (status === 429) return "rate_limit";
  return undefined;
};

const blogName = (account: AccountRecord) => (account.meta.blog as string) || account.username || account.externalId;

/**
 * One post's note totals via `/notes?mode=conversation` (the mode that also reports `total_likes` and
 * `total_reblogs`). null when Tumblr does not know the post (deleted, draft, queued).
 */
async function postNotes(ctx: ProviderContext, account: AccountRecord, id: string): Promise<MetricValues | null> {
  let res: any;
  try {
    res = await requestJson<any>(ctx, `${API}/blog/${encodeURIComponent(blogName(account))}/notes`, {
      token: account.credentials.accessToken,
      query: { id, mode: "conversation" },
      classify,
    });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 404) return null;
    throw err;
  }
  const r = res?.response;
  if (!r || typeof r.total_notes !== "number") return null;
  // Notes = likes + reblogs + replies (+ other note types) combined: kept in extra so they are not counted twice.
  const out: MetricValues = { extra: { notes: r.total_notes } };
  if (typeof r.total_likes === "number") out.likes = r.total_likes;
  if (typeof r.total_reblogs === "number") out.reposts = r.total_reblogs;
  return out;
}

const avatar = (blog: string) => `${API}/blog/${encodeURIComponent(`${blog}.tumblr.com`)}/avatar/128`;

async function blogAccounts(ctx: ProviderContext, token: { access_token: string; refresh_token?: string; expires_in?: number }): Promise<ConnectedAccount[]> {
  const info = await requestJson<any>(ctx, `${API}/user/info`, { token: token.access_token, classify });
  const blogs: any[] = info?.response?.user?.blogs ?? [];
  return blogs.map((b) => ({
    externalId: b.uuid || b.name,
    name: b.title || b.name,
    username: b.name,
    avatarUrl: b.avatar?.[0]?.url ?? avatar(b.name),
    profileUrl: b.url || `https://${b.name}.tumblr.com/`,
    credentials: { accessToken: token.access_token, refreshToken: token.refresh_token },
    expiresAt: expiresAt(token.expires_in),
    meta: { blog: b.name, uuid: b.uuid ?? null, primary: !!b.primary },
  }));
}

function textBlocks(text: string) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => {
      const cps = Array.from(p);
      const out: string[] = [];
      for (let i = 0; i < cps.length; i += TEXT_BLOCK_LIMIT) out.push(cps.slice(i, i + TEXT_BLOCK_LIMIT).join(""));
      return out;
    })
    .map((text) => ({ type: "text", text }));
}

const normalizeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

export function npfContent(post: PublishPost) {
  const s = post.settings;
  const content: any[] = [];
  if (s.title) content.push({ type: "text", subtype: "heading1", text: String(s.title) });
  content.push(...textBlocks(post.content ?? ""));
  if (s.link) content.push({ type: "link", url: normalizeUrl(String(s.link)) });
  post.media.forEach((m, i) => {
    const media = { type: m.mime, identifier: `media-${i}`, ...(m.width && m.height ? { width: m.width, height: m.height } : {}) };
    if (m.kind === "video") content.push({ type: "video", provider: "tumblr", media });
    else content.push({ type: "image", media: [media], ...(m.alt ? { alt_text: m.alt } : {}) });
  });
  if (!content.length) content.push({ type: "text", text: "" });
  return content;
}

function tagList(tags: unknown): string | undefined {
  const list = (Array.isArray(tags) ? tags : String(tags ?? "").split(","))
    .map((t) => String(t).trim().replace(/^#/, ""))
    .filter(Boolean);
  return list.length ? list.join(",") : undefined;
}

/** Creates the post: text as JSON, or media and post in one multipart request. Either way it is the commit. */
async function createPost(ctx: ProviderContext, url: string, account: AccountRecord, post: PublishPost, payload: Record<string, unknown>): Promise<any> {
  if (!post.media.length)
    return requestJson(ctx, url, { method: "POST", token: account.credentials.accessToken, json: payload, classify, commit: true });
  const mp = streamingMultipart([
    { name: "json", value: JSON.stringify(payload), type: "application/json" },
    ...post.media.map((m, i) => mediaPart(ctx, `media-${i}`, m)),
  ]);
  return requestJson(ctx, url, {
    method: "POST",
    token: account.credentials.accessToken,
    headers: mp.headers,
    body: mp.body,
    duplex: "half",
    classify,
    commit: true,
  } as any);
}

export const tumblr: Provider = {
  id: "tumblr",
  name: "Tumblr",
  color: "36465D",
  icon: "tumblr",
  category: "blog",
  auth: "oauth2",
  appFields: clientFields("OAuth Consumer Key", "OAuth Consumer Secret"),
  docsUrl: "https://www.tumblr.com/oauth/apps",
  setupNotes: [
    "1. Register an application at [tumblr.com/oauth/apps](https://www.tumblr.com/oauth/apps).",
    "2. Set **Default callback URL** and **OAuth2 redirect URLs** to `{{redirectUri}}`.",
    "3. Copy the **OAuth Consumer Key** and **Secret** here.",
    "Each blog of the Tumblr user becomes a separate account.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: [
    {
      key: "state",
      label: "Post state",
      type: "select",
      default: "published",
      options: [
        { value: "published", label: "Publish now" },
        { value: "queue", label: "Add to queue" },
        { value: "draft", label: "Draft" },
        { value: "private", label: "Private" },
      ],
    },
    { key: "title", label: "Title", type: "text", maxLength: 4096, help: "Optional heading block above the text." },
    { key: "tags", label: "Tags", type: "tags", help: "Without #." },
    { key: "link", label: "Link", type: "url", help: "Adds a link block with a preview." },
    { key: "sourceUrl", label: "Source URL", type: "url" },
  ],
  capabilities: {
    maxLength: 32_768,
    text: "optional",
    media: { images: 30, videos: 1, mixed: true, required: false },
    thread: false,
  },

  validate(post) {
    if (post.media.filter((m) => m.kind === "video").some((m) => m.size > 500 * 1024 * 1024)) return ["Tumblr videos must be under 500MB"];
    return [];
  },

  authorize(ctx, { state }) {
    const app = requireApp(ctx, "Tumblr", "clientId", "clientSecret");
    const u = new URL("https://www.tumblr.com/oauth2/authorize");
    u.search = new URLSearchParams({ client_id: app.clientId, response_type: "code", scope: SCOPES, state, redirect_uri: ctx.redirectUri }).toString();
    return u.toString();
  },

  async callback(ctx, { code }) {
    const app = requireApp(ctx, "Tumblr", "clientId", "clientSecret");
    const token = await oauthToken(ctx, `${API}/oauth2/token`, {
      grant_type: "authorization_code",
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: ctx.redirectUri,
    });
    return blogAccounts(ctx, token);
  },

  async refresh(ctx, account) {
    const app = requireApp(ctx, "Tumblr", "clientId", "clientSecret");
    if (!account.credentials.refreshToken) throw new ProviderError("Tumblr refresh token missing, reconnect the account", "auth");
    const token = await oauthToken(ctx, `${API}/oauth2/token`, {
      grant_type: "refresh_token",
      refresh_token: account.credentials.refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    return {
      credentials: { accessToken: token.access_token, refreshToken: token.refresh_token ?? account.credentials.refreshToken },
      expiresAt: expiresAt(token.expires_in),
    };
  },

  async publish(ctx, account, post) {
    const blog = blogName(account);
    const payload: Record<string, unknown> = { content: npfContent(post), state: post.settings.state || "published" };
    const tags = tagList(post.settings.tags);
    if (tags) payload.tags = tags;
    if (post.settings.sourceUrl) payload.source_url = normalizeUrl(String(post.settings.sourceUrl));

    const url = `${API}/blog/${encodeURIComponent(blog)}/posts`;
    let res: any;
    try {
      res = await createPost(ctx, url, account, post, payload);
    } catch (err) {
      // 4xx media errors (8006/8009) are refusals (nothing was created) that may succeed later: retryable, not
      // ambiguous like a lost or 5xx answer.
      if (err instanceof ProviderError && err.kind === "ambiguous" && err.status && err.status < 500 && err.status !== 408)
        throw new ProviderError(err.message, "transient", err.status, err.body);
      throw err;
    }
    const id = String(res?.response?.id_string ?? res?.response?.id ?? "");
    if (!id) throw new ProviderError("Tumblr did not return a post id", "transient");
    return { status: "published", externalId: id, url: `https://www.tumblr.com/${blog}/${id}` };
  },

  // Tumblr has no batch lookup: one `/notes` request per post, within the fetch budget.
  metrics: { post: ["likes", "reposts"], account: ["followers", "posts"], batch: 10, scopes: ["basic"] },

  async postMetrics(ctx, account, items) {
    const todo = items.slice(0, Math.max(0, fetchesLeft(ctx)));
    const values = await Promise.all(todo.map((it) => postNotes(ctx, account, it.externalId)));
    const out: PostMetricsResult = {};
    todo.forEach((it, i) => (out[it.externalId] = values[i]));
    return out;
  },

  async accountMetrics(ctx, account) {
    // `followers` is only returned to the blog's owner (our token); `posts` is the published post count.
    const res = await requestJson<any>(ctx, `${API}/blog/${encodeURIComponent(blogName(account))}/info`, {
      token: account.credentials.accessToken,
      classify,
    });
    const b = res?.response?.blog ?? {};
    const out: MetricValues = {};
    if (typeof b.followers === "number") out.followers = b.followers;
    if (typeof b.posts === "number") out.posts = b.posts;
    return out;
  },
};
