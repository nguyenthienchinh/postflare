import { missingScope, ProviderError } from "./errors";
import { request, requestJson, sleep } from "./http";
import { counted, fetchesLeft, type CountedContext } from "./budget";
import { mediaPart, streamingMultipart } from "./multipart";
import type { AccountRecord, MediaItem, MetricValues, PostMetricsResult, Provider, ProviderContext, PublishPost } from "./types";

const DEFAULT_MAX = 500;
/** GET /api/v1/statuses?id[]= (Mastodon 4.3+) returns at most 20 statuses. Older servers: one request per status. */
const METRICS_BATCH = 20;

function instanceUrl(raw: string): string {
  const v = (raw || "").trim().replace(/\/+$/, "");
  const url = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`);
  return url.origin;
}

const api = (account: AccountRecord) => account.meta.instance as string;
const token = (account: AccountRecord) => account.credentials.accessToken as string;

// Mastodon answers 401 for revoked/invalid tokens, 422 for invalid statuses.
const classify = (status: number, body: any) =>
  status === 403 && /token|scope/i.test(String(body?.error ?? "")) ? ("auth" as const) : undefined;

async function uploadMedia(ctx: ProviderContext, account: AccountRecord, item: MediaItem): Promise<{ id: string; ready: boolean }> {
  const parts = [mediaPart(ctx, "file", item), ...(item.alt ? [{ name: "description", value: item.alt.slice(0, 1500) }] : [])];
  const mp = streamingMultipart(parts);
  const res = await request(ctx, `${api(account)}/api/v2/media`, {
    method: "POST",
    token: token(account),
    headers: mp.headers,
    body: mp.body,
    duplex: "half",
    classify,
  } as any);
  const body = await res.json<{ id: string; url: string | null }>();
  // 202 = still processing (url is null until done).
  return { id: String(body.id), ready: res.status === 200 && !!body.url };
}

async function mediaReady(ctx: ProviderContext, account: AccountRecord, id: string): Promise<boolean> {
  const res = await request(ctx, `${api(account)}/api/v1/media/${id}`, { token: token(account), classify });
  if (res.status === 206) return false;
  const body = await res.json<{ url: string | null }>().catch(() => ({ url: null }));
  return !!body.url;
}

/**
 * Polls until the media is processed, bounded by time and by the call's subrequest budget: a round costs one
 * fetch per pending item, and one fetch is kept for posting the status.
 */
async function waitForMedia(ctx: CountedContext, account: AccountRecord, ids: string[], ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  let pending = ids;
  for (;;) {
    const states = await Promise.all(pending.map((id) => mediaReady(ctx, account, id)));
    pending = pending.filter((_, i) => !states[i]);
    if (!pending.length) return true;
    if (Date.now() >= until || ctx.left() - 1 < pending.length) return false;
    await sleep(2000);
  }
}

export function statusParams(post: PublishPost, mediaIds: string[]): Record<string, unknown> {
  const s = post.settings;
  const params: Record<string, unknown> = { status: post.content ?? "", visibility: s.visibility || "public" };
  if (mediaIds.length) params.media_ids = mediaIds;
  if (s.spoiler) params.spoiler_text = String(s.spoiler);
  if (s.sensitive || s.spoiler) params.sensitive = true;
  if (s.language) params.language = String(s.language).trim();
  if (s.poll) {
    const options = String(s.pollOptions ?? "")
      .split("\n")
      .map((o) => o.trim())
      .filter(Boolean);
    if (options.length < 2) throw new ProviderError("A Mastodon poll needs at least 2 options (one per line)", "invalid");
    if (mediaIds.length) throw new ProviderError("Mastodon polls cannot be combined with media", "invalid");
    params.poll = { options, expires_in: Number(s.pollExpiresIn) || 86_400, multiple: !!s.pollMultiple };
  }
  return params;
}

async function postStatus(ctx: ProviderContext, account: AccountRecord, params: Record<string, unknown>, idempotencyKey: string) {
  const max = Number(account.meta.maxCharacters) || DEFAULT_MAX;
  if (String(params.status ?? "").length > max) throw new ProviderError(`This Mastodon instance allows at most ${max} characters`, "invalid");
  const res = await requestJson<{ id: string; url: string | null; uri: string }>(ctx, `${api(account)}/api/v1/statuses`, {
    method: "POST",
    token: token(account),
    // Mastodon caches the result per key for an hour: a retried step does not post twice. That is why this
    // create is not marked `commit: true` (docs/provider-brief.md "Commit semantics"): failures stay retryable.
    headers: { "idempotency-key": idempotencyKey },
    json: params,
    classify,
  });
  return { externalId: String(res.id), url: res.url ?? res.uri ?? null };
}

async function uploadAll(ctx: ProviderContext, account: AccountRecord, post: PublishPost) {
  const uploads = [];
  for (const m of post.media) uploads.push(await uploadMedia(ctx, account, m));
  return { ids: uploads.map((u) => u.id), processing: uploads.filter((u) => !u.ready).map((u) => u.id) };
}

// ---------- metrics ----------

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Drop keys the platform did not report. */
function compact(m: MetricValues): MetricValues {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as MetricValues;
}

const statusMetrics = (st: any): MetricValues =>
  compact({
    likes: num(st.favourites_count),
    reposts: num(st.reblogs_count),
    replies: num(st.replies_count),
    quotes: num(st.quotes_count),
  });

/** GET for analytics. A 403 (token without the read scope) only flags analytics as reconnect_required. */
async function readJson<T = any>(ctx: ProviderContext, account: AccountRecord, path: string, scope: string): Promise<T> {
  try {
    return await requestJson<T>(ctx, `${api(account)}${path}`, { token: token(account) });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 403) throw missingScope("Mastodon", scope);
    throw err;
  }
}

/**
 * Multi-get of up to 20 statuses in one request (Mastodon 4.3+; `ids[]` is the Pleroma/Akkoma spelling).
 * Returns null when the server does not support it (404/405 on older versions).
 */
async function multiGet(ctx: ProviderContext, account: AccountRecord, ids: string[]): Promise<any[] | null> {
  const q = new URLSearchParams();
  for (const id of ids) q.append("id[]", id);
  for (const id of ids) q.append("ids[]", id);
  try {
    const res = await readJson<any[]>(ctx, account, `/api/v1/statuses?${q}`, "read:statuses");
    return Array.isArray(res) ? res : null;
  } catch (err) {
    if (err instanceof ProviderError && [404, 405].includes(err.status ?? 0)) return null;
    throw err;
  }
}

export const mastodon: Provider = {
  id: "mastodon",
  name: "Mastodon",
  color: "6364FF",
  icon: "mastodon",
  category: "social",
  auth: "credentials",
  appFields: [],
  docsUrl: "https://docs.joinmastodon.org/client/token/",
  setupNotes:
    "No developer app needed. On your instance open **Preferences → Development → New application**, keep the scopes `read` and `write` (or at least `read:accounts`, `read:statuses`, `write:statuses`, `write:media`), save, and copy **Your access token**. Analytics (favourites, boosts, replies, followers) need `read:statuses` and `read:accounts`: a token without them must be replaced.",
  credentialFields: [
    { key: "instance", label: "Instance URL", type: "url", required: true, default: "https://mastodon.social", placeholder: "https://mastodon.social" },
    { key: "accessToken", label: "Access token", type: "password", required: true, help: "Preferences → Development → your application." },
  ],
  settingsFields: [
    {
      key: "visibility",
      label: "Visibility",
      type: "select",
      default: "public",
      options: [
        { value: "public", label: "Public" },
        { value: "unlisted", label: "Quiet public (unlisted)" },
        { value: "private", label: "Followers only" },
        { value: "direct", label: "Mentioned people only" },
      ],
    },
    { key: "spoiler", label: "Content warning", type: "text", placeholder: "Spoiler / CW text" },
    { key: "sensitive", label: "Mark media as sensitive", type: "checkbox", default: false },
    { key: "language", label: "Language", type: "text", placeholder: "en", help: "ISO 639-1 code." },
    { key: "poll", label: "Add a poll", type: "checkbox", default: false },
    { key: "pollOptions", label: "Poll options", type: "textarea", help: "One option per line (2-4).", showIf: { key: "poll", equals: true } },
    {
      key: "pollExpiresIn",
      label: "Poll duration",
      type: "select",
      default: "86400",
      showIf: { key: "poll", equals: true },
      options: [
        { value: "300", label: "5 minutes" },
        { value: "1800", label: "30 minutes" },
        { value: "3600", label: "1 hour" },
        { value: "21600", label: "6 hours" },
        { value: "86400", label: "1 day" },
        { value: "259200", label: "3 days" },
        { value: "604800", label: "7 days" },
      ],
    },
    { key: "pollMultiple", label: "Allow multiple choices", type: "checkbox", default: false, showIf: { key: "poll", equals: true } },
  ],
  capabilities: {
    // Instance-specific: the real limit is read at connect time and enforced in publish.
    maxLength: DEFAULT_MAX,
    text: "optional",
    media: { images: 4, videos: 1, mixed: false, required: false },
    thread: true,
    threadLabel: "Thread replies",
  },

  metrics: {
    post: ["likes", "reposts", "replies", "quotes"],
    account: ["followers", "following", "posts"],
    batch: METRICS_BATCH,
    scopes: ["read:statuses", "read:accounts"],
  },

  async connect(ctx, values) {
    const instance = instanceUrl(values.instance);
    const accessToken = values.accessToken.trim();
    const me = await requestJson<any>(ctx, `${instance}/api/v1/accounts/verify_credentials`, { token: accessToken, classify });
    const info = await requestJson<any>(ctx, `${instance}/api/v2/instance`).catch(() => null);
    const host = new URL(instance).host;
    const cfg = info?.configuration;
    return [
      {
        externalId: `${me.id}@${host}`,
        name: me.display_name || me.username,
        username: `@${me.username}@${host}`,
        avatarUrl: me.avatar ?? null,
        profileUrl: me.url ?? `${instance}/@${me.username}`,
        credentials: { accessToken },
        meta: {
          instance,
          accountId: String(me.id),
          maxCharacters: cfg?.statuses?.max_characters ?? DEFAULT_MAX,
          maxMedia: cfg?.statuses?.max_media_attachments ?? 4,
          pollMaxOptions: cfg?.polls?.max_options ?? 4,
        },
      },
    ];
  },

  async publish(ctx, account, post) {
    const c = counted(ctx);
    const { ids, processing } = await uploadAll(c, account, post);
    const params = statusParams(post, ids);
    if (processing.length && !(await waitForMedia(c, account, processing, 20_000)))
      return { status: "pending", state: { params, processing, key: post.id }, retryAfterSeconds: 10 };
    return { status: "published", ...(await postStatus(ctx, account, params, post.id)) };
  },

  async checkStatus(ctx, account, state) {
    if (!(await waitForMedia(counted(ctx), account, state.processing as string[], 0))) return { status: "pending", state, retryAfterSeconds: 10 };
    return { status: "published", ...(await postStatus(ctx, account, state.params as Record<string, unknown>, state.key as string)) };
  },

  async reply(ctx, account, target, post) {
    const c = counted(ctx);
    const { ids, processing } = await uploadAll(c, account, post);
    const params = { ...statusParams({ ...post, settings: { ...post.settings, poll: false } }, ids), in_reply_to_id: target.parentId };
    // reply() cannot return pending: wait longer, then let the step retry.
    if (processing.length && !(await waitForMedia(c, account, processing, 90_000)))
      throw new ProviderError("Mastodon is still processing the reply media", "transient");
    return postStatus(ctx, account, params, post.id);
  },

  /**
   * One multi-get request for the batch; on servers without it (before 4.3), one GET per status within the call's
   * fetch budget (the rest stay due). Statuses missing from the response / 404 (deleted, unknown) → null.
   */
  async postMetrics(ctx, account, items) {
    const ids = [...new Set(items.map((i) => i.externalId))].slice(0, METRICS_BATCH);
    const out: PostMetricsResult = {};
    if (!ids.length) return out;
    const many = await multiGet(ctx, account, ids);
    if (many) {
      const found = new Map(many.map((st) => [String(st.id), st]));
      for (const id of ids) out[id] = found.has(id) ? statusMetrics(found.get(id)) : null;
      return out;
    }
    for (const id of ids) {
      if (fetchesLeft(ctx) < 1) break;
      try {
        out[id] = statusMetrics(await readJson(ctx, account, `/api/v1/statuses/${encodeURIComponent(id)}`, "read:statuses"));
      } catch (err) {
        if (err instanceof ProviderError && err.status === 404) out[id] = null;
        else throw err;
      }
    }
    return out;
  },

  /** Followers, following and status count of the token's account. */
  async accountMetrics(ctx, account) {
    const me = await readJson<any>(ctx, account, "/api/v1/accounts/verify_credentials", "read:accounts");
    return compact({ followers: num(me?.followers_count), following: num(me?.following_count), posts: num(me?.statuses_count) });
  },
};
