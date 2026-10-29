// Helpers shared by the Meta providers (Facebook, Instagram via Facebook login, Instagram login, Threads).
import type { FieldDef, MetricKey, MetricValues, ProviderCapabilities } from "../../shared/types";
import { fetchesLeft } from "./budget";
import { ProviderError, missingScope, type ProviderErrorKind } from "./errors";
import { checkedCommit, requestJson, type RequestOptions } from "./http";
import type { AccountRecord, MediaItem, MetricsItem, PostMetricsResult, ProviderContext, PublishPost, PublishResult } from "./types";

/** Graph API version used by every Meta provider except Threads (which has its own v1.0). */
export const GRAPH_VERSION = "v25.0";
export const FB_GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const IG_GRAPH = `https://graph.instagram.com/${GRAPH_VERSION}`;
export const THREADS_GRAPH = "https://graph.threads.net/v1.0";

const AUTH_CODES = new Set([102, 190]);
// 4 app limit, 17 user limit, 32 page limit, 613 custom limit, 80001-80014 business use case limits.
const RATE_CODES = new Set([4, 17, 32, 613]);
// Subcodes that require the user to reconnect (expired/changed password/revoked/not authorised for the page).
const AUTH_SUBCODES = new Set([458, 460, 463, 464, 467, 490, 1404078]);

/**
 * Map a Graph API error body to a kind. Graph errors look like
 * `{ error: { message, type: "OAuthException", code, error_subcode, is_transient } }`.
 * `type: "OAuthException"` alone is not an auth error (code 100 "invalid parameter" uses it too).
 */
export function classifyGraphError(status: number, body: any): ProviderErrorKind | undefined {
  const e = body?.error;
  if (!e || typeof e !== "object") return status === 401 ? "auth" : undefined;
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  if (AUTH_CODES.has(code) || AUTH_SUBCODES.has(sub)) return "auth";
  if (RATE_CODES.has(code) || (code >= 80001 && code <= 80014) || sub === 1390008) return "rate_limit";
  if (e.is_transient || code === 1 || code === 2 || sub === 2207003 || sub === 2207082 || sub === 4279009) return "transient";
  if (status === 401) return "auth";
  return undefined;
}

export interface GraphOptions extends Omit<RequestOptions, "token" | "classify"> {
  /** Sent as the `access_token` query parameter (accepted by every Meta graph host). */
  token?: string;
}

/** requestJson with Meta error classification. Also throws on 200 responses that carry an `error` object. */
export async function graph<T = any>(ctx: Pick<ProviderContext, "fetch" | "commit">, url: string, opts: GraphOptions = {}): Promise<T> {
  const { token, query, ...rest } = opts;
  const send = () =>
    requestJson(ctx, url, {
      ...rest,
      query: token ? { ...query, access_token: token } : query,
      classify: classifyGraphError,
    });
  // A 200 carrying an error is a refusal: on a commit it created nothing (checkedCommit undoes `accepted`).
  const out = await checkedCommit(ctx, send, (out) => {
    if (!out || typeof out !== "object" || !(out as any).error) return;
    const err = (out as any).error;
    throw new ProviderError(
      `${new URL(url).host}: ${err.error_user_msg || err.message || JSON.stringify(err)}`,
      classifyGraphError(200, out) ?? "invalid",
      200,
      out,
    );
  });
  return out as T;
}

/** Follow `paging.next` cursors and collect `data`. */
export async function graphPaged<T = any>(
  ctx: Pick<ProviderContext, "fetch">,
  url: string,
  opts: GraphOptions = {},
  maxPages = 20,
): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = url;
  let first = true;
  for (let i = 0; next && i < maxPages; i++) {
    // `next` URLs already carry every parameter (including the token).
    const res: { data?: T[]; paging?: { next?: string } } = await graph(ctx, next, first ? opts : {});
    items.push(...(res?.data ?? []));
    next = res?.paging?.next;
    first = false;
  }
  return items;
}

/** Wraps `fn`, returning `fallback` on any error (for cosmetic lookups such as permalinks once a post is live). */
export async function bestEffort<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return (await fn()) ?? fallback;
  } catch {
    return fallback;
  }
}

export const isJpeg = (m: MediaItem) => /^image\/(jpeg|jpg|pjpeg)$/i.test(m.mime);

// ---------------------------------------------------------------------------
// Facebook Login (used by the Facebook Page and Instagram-via-Facebook providers)

export function facebookAuthorizeUrl(ctx: ProviderContext, state: string, scopes: string[]): string {
  const u = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set("client_id", ctx.app.clientId);
  u.searchParams.set("redirect_uri", ctx.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  // Facebook Login for Business apps use a configuration id instead of a scope list.
  if (ctx.app.configId) u.searchParams.set("config_id", ctx.app.configId);
  else u.searchParams.set("scope", scopes.join(","));
  return u.toString();
}

/** Code → short-lived user token → long-lived (~60 days) user token. Page tokens derived from it never expire. */
export async function facebookUserToken(ctx: ProviderContext, code: string): Promise<{ token: string; expiresIn?: number }> {
  const short = await graph<{ access_token: string }>(ctx, `${FB_GRAPH}/oauth/access_token`, {
    query: { client_id: ctx.app.clientId, client_secret: ctx.app.clientSecret, redirect_uri: ctx.redirectUri, code },
  });
  const long = await graph<{ access_token: string; expires_in?: number }>(ctx, `${FB_GRAPH}/oauth/access_token`, {
    query: {
      grant_type: "fb_exchange_token",
      client_id: ctx.app.clientId,
      client_secret: ctx.app.clientSecret,
      fb_exchange_token: short.access_token,
    },
  });
  return { token: long.access_token, expiresIn: long.expires_in };
}

/**
 * The app-scoped id of the Facebook user who logged in, kept in the accounts' `meta.metaUserId`: Meta's data deletion
 * callback identifies the user by it (lib/meta-deletion.ts). Best effort: null when /me fails.
 */
export async function facebookUserId(ctx: ProviderContext, userToken: string): Promise<string | null> {
  const me = await bestEffort(() => graph<{ id?: string }>(ctx, `${FB_GRAPH}/me`, { token: userToken, query: { fields: "id" } }), null);
  return me?.id ? String(me.id) : null;
}

/**
 * Every Page the user granted: `/me/accounts`, plus Pages owned by / shared with their Business Manager
 * businesses (those are not always listed by /me/accounts). Deduplicated by id.
 */
export async function facebookPages<T extends { id: string }>(ctx: ProviderContext, userToken: string, fields: string): Promise<T[]> {
  const seen = new Map<string, T>();
  const add = (list: T[]) => list.forEach((p) => p?.id && !seen.has(p.id) && seen.set(p.id, p));
  add(await graphPaged<T>(ctx, `${FB_GRAPH}/me/accounts`, { token: userToken, query: { fields, limit: 100 } }));
  const businesses = await bestEffort(
    () => graphPaged<{ id: string }>(ctx, `${FB_GRAPH}/me/businesses`, { token: userToken, query: { fields: "id", limit: 100 } }),
    [],
  );
  for (const b of businesses) {
    for (const edge of ["owned_pages", "client_pages"]) {
      add(await bestEffort(() => graphPaged<T>(ctx, `${FB_GRAPH}/${b.id}/${edge}`, { token: userToken, query: { fields, limit: 100 } }), []));
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Instagram content publishing (shared by graph.facebook.com and graph.instagram.com flavours)

export const instagramCapabilities: ProviderCapabilities = {
  maxLength: 2200,
  text: "optional",
  media: { images: 10, videos: 10, mixed: true, required: true },
  thread: true,
  threadLabel: "Comments",
};

export const instagramSettingsFields: FieldDef[] = [
  {
    key: "post_type",
    label: "Post type",
    type: "select",
    default: "post",
    options: [
      { value: "post", label: "Post / Reel / Carousel" },
      { value: "story", label: "Story (each media becomes a story)" },
    ],
  },
  {
    key: "collaborators",
    label: "Collaborators",
    type: "tags",
    help: "Up to 3 Instagram usernames invited as collaborators (public professional accounts).",
    showIf: { key: "post_type", equals: "post" },
  },
  {
    key: "share_to_feed",
    label: "Also show the Reel in the feed",
    type: "checkbox",
    default: true,
    help: "Single-video posts are published as Reels.",
    showIf: { key: "post_type", equals: "post" },
  },
  {
    key: "is_trial_reel",
    label: "Trial Reel (shown to non-followers first)",
    type: "checkbox",
    default: false,
    showIf: { key: "post_type", equals: "post" },
  },
  {
    key: "graduation_strategy",
    label: "Trial Reel graduation",
    type: "select",
    default: "MANUAL",
    options: [
      { value: "MANUAL", label: "Manual (share to followers from the app)" },
      { value: "SS_PERFORMANCE", label: "Automatic, if it performs well" },
    ],
    showIf: { key: "is_trial_reel", equals: true },
  },
  {
    key: "cover_url",
    label: "Reel cover image URL",
    type: "url",
    help: "Optional public JPEG used as the Reel cover.",
    showIf: { key: "post_type", equals: "post" },
  },
  {
    key: "thumb_offset",
    label: "Reel cover frame (ms)",
    type: "number",
    help: "Video frame used as cover when no cover image is set.",
    showIf: { key: "post_type", equals: "post" },
  },
];

const stripHandle = (h: string) => h.trim().replace(/^@+/, "");
const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";

export function instagramValidate(post: PublishPost): string[] {
  const errors: string[] = [];
  const s = post.settings ?? {};
  const story = s.post_type === "story";
  const nonJpeg = post.media.filter((m) => m.kind === "image" && !isJpeg(m));
  if (nonJpeg.length) errors.push(`Instagram only accepts JPEG images (${nonJpeg.map((m) => m.filename).join(", ")})`);
  const collaborators: string[] = Array.isArray(s.collaborators) ? s.collaborators : [];
  if (!story && collaborators.length > 3) errors.push("Instagram allows at most 3 collaborators");
  if (!story && truthy(s.is_trial_reel) && (post.media.length !== 1 || post.media[0].kind !== "video"))
    errors.push("A Trial Reel must be a single video");
  if ((post.content.match(/(^|\s)#\w/g) ?? []).length > 30) errors.push("Instagram allows at most 30 hashtags");
  return errors;
}

export interface IgState {
  host: string;
  kind: "single" | "carousel" | "stories";
  /** A single video, published as a reel (its insights include watch time). */
  reel?: boolean;
  containers: string[];
  caption?: string;
  collaborators?: string[];
  /** Carousel parent container, created once every child finished processing. */
  carouselId?: string;
  /** Story containers already published (with the resulting media ids). */
  published?: string[];
  mediaIds?: string[];
}

export interface IgAccount {
  igUserId: string;
  token: string;
  username?: string | null;
}

/** Create the media containers. Nothing is visible until media_publish (the commit), so this is safe to retry. */
export async function instagramCreate(ctx: ProviderContext, host: string, acc: IgAccount, post: PublishPost): Promise<PublishResult> {
  const errors = instagramValidate(post);
  if (errors.length) throw new ProviderError(errors.join("; "), "invalid");
  if (!post.media.length) throw new ProviderError("Instagram posts need at least one image or video", "invalid");
  const s = post.settings ?? {};
  const story = s.post_type === "story";
  const carousel = !story && post.media.length > 1;
  const collaborators: string[] = !story && Array.isArray(s.collaborators) ? s.collaborators.map(stripHandle).filter(Boolean) : [];
  const create = (form: Record<string, string | number | boolean | undefined>) =>
    graph<{ id: string }>(ctx, `${host}/${acc.igUserId}/media`, { method: "POST", token: acc.token, form });

  const containers: string[] = [];
  for (const m of post.media) {
    const media = m.kind === "video" ? { video_url: m.url } : { image_url: m.url };
    let form: Record<string, string | number | boolean | undefined>;
    if (story) {
      form = { ...media, media_type: "STORIES" };
    } else if (carousel) {
      form = { ...media, is_carousel_item: true, media_type: m.kind === "video" ? "VIDEO" : undefined, alt_text: m.kind === "image" ? m.alt ?? undefined : undefined };
    } else if (m.kind === "video") {
      form = {
        ...media,
        media_type: "REELS",
        caption: post.content,
        share_to_feed: s.share_to_feed === undefined ? undefined : truthy(s.share_to_feed),
        cover_url: s.cover_url || undefined,
        thumb_offset: !s.cover_url && s.thumb_offset !== undefined && s.thumb_offset !== "" ? Number(s.thumb_offset) : undefined,
        trial_params: truthy(s.is_trial_reel) ? JSON.stringify({ graduation_strategy: s.graduation_strategy || "MANUAL" }) : undefined,
        collaborators: collaborators.length ? JSON.stringify(collaborators) : undefined,
      };
    } else {
      form = {
        ...media,
        caption: post.content,
        alt_text: m.alt ?? undefined,
        collaborators: collaborators.length ? JSON.stringify(collaborators) : undefined,
      };
    }
    containers.push((await create(form)).id);
  }
  const state: IgState = {
    host,
    kind: story ? "stories" : carousel ? "carousel" : "single",
    ...(!story && !carousel && post.media[0]?.kind === "video" ? { reel: true } : {}),
    containers,
    caption: carousel ? post.content : undefined,
    collaborators: carousel && collaborators.length ? collaborators : undefined,
    published: [],
    mediaIds: [],
  };
  const hasVideo = post.media.some((m) => m.kind === "video");
  return { status: "pending", state: state as unknown as Record<string, unknown>, retryAfterSeconds: hasVideo ? 30 : 5 };
}

type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED";

async function containerStatus(ctx: ProviderContext, host: string, token: string, id: string): Promise<ContainerStatus> {
  const res = await graph<{ status_code?: ContainerStatus; status?: string }>(ctx, `${host}/${id}`, {
    token,
    query: { fields: "status_code,status" },
  });
  const code = res.status_code ?? "IN_PROGRESS";
  if (code === "ERROR" || code === "EXPIRED")
    throw new ProviderError(`Instagram could not process the media (${code}): ${res.status || "no details"}`, "invalid", 200, res);
  return code;
}

async function igPermalink(ctx: ProviderContext, host: string, acc: IgAccount, mediaId: string, fallback: string) {
  return bestEffort(async () => (await graph<{ permalink?: string }>(ctx, `${host}/${mediaId}`, { token: acc.token, query: { fields: "permalink" } })).permalink ?? fallback, fallback);
}

/**
 * Advance a pending Instagram publish. Never publishes twice: a container whose status is already
 * PUBLISHED (a previous attempt died after media_publish) is treated as done.
 */
export async function instagramCheck(ctx: ProviderContext, acc: IgAccount, raw: Record<string, unknown>): Promise<PublishResult> {
  const state = raw as unknown as IgState;
  const host = state.host;
  const profile = acc.username ? `https://www.instagram.com/${acc.username}/` : "https://www.instagram.com/";
  const pending = (s: IgState, retryAfterSeconds = 10): PublishResult => ({ status: "pending", state: s as unknown as Record<string, unknown>, retryAfterSeconds });
  const publish = (creationId: string) =>
    graph<{ id: string }>(ctx, `${host}/${acc.igUserId}/media_publish`, { method: "POST", token: acc.token, form: { creation_id: creationId }, commit: true });

  if (state.kind === "stories") {
    const published = [...(state.published ?? [])];
    const mediaIds = [...(state.mediaIds ?? [])];
    for (const id of state.containers) {
      if (published.includes(id)) continue;
      const status = await containerStatus(ctx, host, acc.token, id);
      // Keep story order: stop at the first container still processing.
      if (status === "IN_PROGRESS") return pending({ ...state, published, mediaIds });
      if (status === "FINISHED") mediaIds.push((await publish(id)).id);
      published.push(id);
    }
    const last = mediaIds.at(-1);
    return {
      status: "published",
      externalId: last ?? state.containers.at(-1)!,
      url: acc.username ? `https://www.instagram.com/stories/${acc.username}/` : profile,
      data: { mediaIds },
    };
  }

  let creationId = state.carouselId;
  if (state.kind === "carousel" && !creationId) {
    for (const id of state.containers) {
      if ((await containerStatus(ctx, host, acc.token, id)) === "IN_PROGRESS") return pending(state);
    }
    // An orphaned parent from a crashed attempt is invisible, so re-creating it is harmless.
    const parent = await graph<{ id: string }>(ctx, `${host}/${acc.igUserId}/media`, {
      method: "POST",
      token: acc.token,
      form: {
        media_type: "CAROUSEL",
        children: state.containers.join(","),
        caption: state.caption ?? "",
        collaborators: state.collaborators?.length ? JSON.stringify(state.collaborators) : undefined,
      },
    });
    return pending({ ...state, carouselId: parent.id }, 5);
  }
  creationId ??= state.containers[0];

  const status = await containerStatus(ctx, host, acc.token, creationId);
  if (status === "IN_PROGRESS") return pending(state);
  if (status === "PUBLISHED") {
    ctx.log("warn", "Instagram reports the post as already published; not publishing again");
    return { status: "published", externalId: creationId, url: profile, data: { creationId, ...(state.reel ? { reel: true } : {}) } };
  }
  const { id } = await publish(creationId);
  return { status: "published", externalId: id, url: await igPermalink(ctx, host, acc, id, profile), data: { creationId, ...(state.reel ? { reel: true } : {}) } };
}

/** Comment on the root post (Instagram comments are text-only). */
export async function instagramComment(ctx: ProviderContext, host: string, acc: IgAccount, rootId: string, post: PublishPost) {
  if (post.media.length) ctx.log("warn", "Instagram comments cannot contain media; only the text is posted");
  if (!post.content.trim()) throw new ProviderError("Instagram comments need text", "invalid");
  const { id } = await graph<{ id: string }>(ctx, `${host}/${rootId}/comments`, {
    method: "POST",
    token: acc.token,
    form: { message: post.content },
    commit: true,
  });
  const url = await bestEffort(async () => (await graph<{ permalink?: string }>(ctx, `${host}/${rootId}`, { token: acc.token, query: { fields: "permalink" } })).permalink ?? null, null);
  // Instagram comments have no public permalink: link the post, the log names the comment id.
  return { externalId: id, url, urlIsPost: true };
}

// ---------------------------------------------------------------------------
// Metrics (analytics)

/** One Graph read that did not throw: the parsed body, or the error body of a failed (sub-)request. */
export type GraphReply = { ok: true; body: any } | { ok: false; status: number; body: any };

/** `graph()` that returns error bodies instead of throwing (network errors still throw). */
export async function graphReply(ctx: Pick<ProviderContext, "fetch">, url: string, opts: GraphOptions = {}): Promise<GraphReply> {
  try {
    return { ok: true, body: await graph(ctx, url, opts) };
  } catch (err) {
    if (err instanceof ProviderError && err.body && typeof err.body === "object") return { ok: false, status: err.status ?? 0, body: err.body };
    throw err;
  }
}

/** Max sub-requests of one Graph Batch API call. */
export const GRAPH_BATCH_MAX = 50;

/**
 * Graph Batch API (graph.facebook.com only): GET `relativeUrls` (e.g. `123/insights?metric=reach`, unversioned: the
 * batch endpoint's version applies) in one fetch per 50. Sub-responses are independent. Returns one reply per url;
 * `undefined` = not fetched (fetch budget ran out) or timed out inside the batch (Graph returns null for it).
 */
export async function graphBatch(ctx: ProviderContext, token: string, relativeUrls: string[]): Promise<Array<GraphReply | undefined>> {
  const out: Array<GraphReply | undefined> = new Array(relativeUrls.length).fill(undefined);
  for (let start = 0; start < relativeUrls.length && fetchesLeft(ctx) > 0; start += GRAPH_BATCH_MAX) {
    const chunk = relativeUrls.slice(start, start + GRAPH_BATCH_MAX);
    const res = await graph<Array<{ code: number; body?: string } | null>>(ctx, FB_GRAPH, {
      method: "POST",
      form: { access_token: token, include_headers: false, batch: JSON.stringify(chunk.map((relative_url) => ({ method: "GET", relative_url }))) },
    });
    chunk.forEach((_, i) => {
      const r = Array.isArray(res) ? res[i] : null;
      if (!r) return;
      let body: any = null;
      try {
        body = r.body ? JSON.parse(r.body) : null;
      } catch {
        body = { error: { message: String(r.body) } };
      }
      out[start + i] = r.code >= 200 && r.code < 300 && !body?.error ? { ok: true, body } : { ok: false, status: r.code, body };
    });
  }
  return out;
}

/**
 * Classify a failed metrics read. Throws `missingScope` for permission errors (codes 10, 200-299, "permission"
 * messages) and a ProviderError for auth / rate limit / transient errors. Returns "missing" when the object is gone
 * or has no insights (deleted, expired story, too few viewers), else "invalid" (the caller decides).
 */
export function metricsFailure(platform: string, scopes: string[], reply: { status: number; body: any }): "missing" | "invalid" {
  const e = reply.body?.error ?? {};
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  const msg = `${e.message ?? ""} ${e.error_user_msg ?? ""}`;
  const kind = classifyGraphError(reply.status, reply.body);
  if (kind) throw new ProviderError(`${platform} metrics: ${e.message || reply.status}`, kind, reply.status, reply.body);
  // Subcode 33's message also says "missing permissions", so it is checked before the permission rules.
  if (sub === 33 || code === 803 || reply.status === 404 || /not enough viewers|posted before/i.test(msg)) return "missing";
  if (code === 10 || (code >= 200 && code <= 299) || /permission/i.test(msg)) throw missingScope(platform, scopes, e.message);
  if (/does not exist|cannot be loaded|no longer available|not available/i.test(msg)) return "missing";
  return "invalid";
}

/** `{ name: value }` of an insights `data` array (`values[0].value` or `total_value.value`; numbers only). */
export function insightValues(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    const v = m?.total_value?.value ?? m?.values?.[0]?.value;
    if (m?.name && typeof v === "number") out[m.name] = v;
  }
  return out;
}

/** Account metrics read: one Graph GET with metrics error mapping (a missing object is an "invalid" ProviderError). */
export async function metricsGet(ctx: ProviderContext, url: string, opts: GraphOptions, platform: string, scopes: string[]): Promise<any> {
  const r = await graphReply(ctx, url, opts);
  if (r.ok) return r.body;
  metricsFailure(platform, scopes, r);
  throw new ProviderError(`${platform} metrics: ${r.body?.error?.message ?? r.status}`, "invalid", r.status, r.body);
}

// Instagram media insights. Graph fails the whole request (#100) for a metric the media type does not support, so
// feed posts / reels and stories use separate lists. `impressions` / `plays` are gone since v22: `views` replaces them.
const IG_FEED_METRICS = "views,reach,saved,shares,total_interactions,likes,comments";
const IG_STORY_METRICS = "views,reach,replies,shares,total_interactions";
/**
 * Asked on top of the feed list: reels (publish data `reel`) have watch time, photo and carousel posts the profile
 * visits and follows they brought. A media that rejects them (#100: older reels without the flag, other types) is read
 * again with the plain feed list.
 */
const IG_REEL_EXTRA = "ig_reels_avg_watch_time,ig_reels_video_view_total_time";
const IG_POST_EXTRA = "profile_visits,follows";
const IG_KEYS: Record<string, MetricKey> = { views: "views", reach: "reach", saved: "saves", shares: "shares", likes: "likes", comments: "comments", replies: "replies" };

export const instagramMetricKeys = {
  post: ["views", "reach", "likes", "comments", "shares", "saves", "replies", "watchTimeMinutes", "avgViewDurationSeconds"] as MetricKey[],
  account: ["followers", "following", "posts"] as MetricKey[],
};

function igMetrics(data: unknown): MetricValues {
  const v = insightValues(data);
  const out: MetricValues = {};
  for (const [name, key] of Object.entries(IG_KEYS)) if (name in v) out[key] = v[name];
  // total_interactions overlaps likes/comments/shares/saves: kept apart so engagements are not double counted.
  if ("total_interactions" in v) out.extra = { total_interactions: v.total_interactions };
  // Reels watch time comes in milliseconds.
  if ("ig_reels_avg_watch_time" in v) out.avgViewDurationSeconds = Math.round(v.ig_reels_avg_watch_time / 100) / 10;
  if ("ig_reels_video_view_total_time" in v) out.watchTimeMinutes = Math.round(v.ig_reels_video_view_total_time / 6000) / 10;
  for (const k of ["profile_visits", "follows"]) if (k in v) (out.extra ??= {})[k] = v[k];
  return out;
}

/** Story frames: counts are summed, reach is the largest frame's (unique viewers cannot be added up). */
function combineFrames(list: MetricValues[]): MetricValues {
  if (list.length === 1) return list[0];
  const out: MetricValues = {};
  for (const m of list) {
    for (const [k, v] of Object.entries(m)) {
      if (k === "extra" || typeof v !== "number") continue;
      const key = k as MetricKey;
      out[key] = key === "reach" ? Math.max(out[key] ?? 0, v) : (out[key] ?? 0) + v;
    }
    if (m.extra) for (const [k, v] of Object.entries(m.extra)) (out.extra ??= {})[k] = (out.extra[k] ?? 0) + v;
  }
  return out;
}

/**
 * Instagram post metrics. Stories (publish data `mediaIds`) read every frame; feed posts / reels read the post.
 * `batch`: use the Graph Batch API (graph.facebook.com); otherwise one GET per media, within `fetchesLeft`.
 */
export async function instagramPostMetrics(
  ctx: ProviderContext,
  p: { host: string; token: string; scopes: string[]; batch: boolean },
  items: MetricsItem[],
): Promise<PostMetricsResult> {
  const targets = items.map((item) => {
    const frames = Array.isArray(item.data?.mediaIds) ? (item.data!.mediaIds as unknown[]).map(String).filter(Boolean) : [];
    const story = frames.length > 0;
    return { item, story, ids: story ? frames : [item.externalId] };
  });
  const extraFor = (t: (typeof targets)[number]) => (t.story ? "" : t.item.data?.reel ? IG_REEL_EXTRA : IG_POST_EXTRA);
  const path = (id: string, story: boolean, extra = "") => `${id}/insights?metric=${story ? IG_STORY_METRICS : IG_FEED_METRICS}${extra ? `,${extra}` : ""}`;
  const replies: Array<Array<GraphReply | undefined>> = [];
  if (p.batch) {
    const flat = await graphBatch(ctx, p.token, targets.flatMap((t) => t.ids.map((id) => path(id, t.story, extraFor(t)))));
    let i = 0;
    for (const t of targets) replies.push(t.ids.map(() => flat[i++]));
  } else {
    for (const t of targets) {
      if (fetchesLeft(ctx) < t.ids.length) break;
      const list: GraphReply[] = [];
      for (const id of t.ids) list.push(await graphReply(ctx, `${p.host}/${path(id, t.story, extraFor(t))}`, { token: p.token }));
      replies.push(list);
    }
  }
  // Posts that rejected the extra metrics (#100, unsupported metric for this media type): once more without them.
  const unsupported = (r: GraphReply | undefined) =>
    !!r && !r.ok && r.body?.error?.code === 100 && r.body?.error?.error_subcode !== 33 && /metric/i.test(String(r.body?.error?.message ?? ""));
  const retry = targets.map((t, i) => (!t.story && extraFor(t) && replies[i]?.length === 1 && unsupported(replies[i][0]) ? i : -1)).filter((i) => i >= 0);
  if (retry.length) {
    if (p.batch) {
      const again = await graphBatch(ctx, p.token, retry.map((i) => path(targets[i].ids[0], false)));
      retry.forEach((i, j) => (replies[i] = [again[j]]));
    } else {
      for (const i of retry) {
        if (fetchesLeft(ctx) < 1) {
          replies[i] = [undefined];
          continue;
        }
        replies[i] = [await graphReply(ctx, `${p.host}/${path(targets[i].ids[0], false)}`, { token: p.token })];
      }
    }
  }

  const result: PostMetricsResult = {};
  targets.forEach((t, i) => {
    const list = replies[i];
    if (!list || list.some((r) => !r)) return; // not fetched: stays due
    const frames: MetricValues[] = [];
    for (const r of list as GraphReply[]) {
      if (r.ok) frames.push(igMetrics(r.body?.data));
      else if (metricsFailure("Instagram", p.scopes, r) === "invalid")
        ctx.log("warn", `Instagram metrics of ${t.item.externalId}: ${r.body?.error?.message ?? r.status}`);
    }
    result[t.item.externalId] = frames.length ? combineFrames(frames) : null;
  });
  return result;
}

/** followers / following / posts of an Instagram professional account (IG user node). */
export async function instagramAccountMetrics(ctx: ProviderContext, host: string, account: AccountRecord, scopes: string[]): Promise<MetricValues> {
  const res = await metricsGet(
    ctx,
    `${host}/${account.externalId}`,
    { token: account.credentials.accessToken as string, query: { fields: "followers_count,follows_count,media_count" } },
    "Instagram",
    scopes,
  );
  const out: MetricValues = {};
  if (typeof res?.followers_count === "number") out.followers = res.followers_count;
  if (typeof res?.follows_count === "number") out.following = res.follows_count;
  if (typeof res?.media_count === "number") out.posts = res.media_count;
  return out;
}
