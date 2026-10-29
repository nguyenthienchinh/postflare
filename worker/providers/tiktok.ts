import { MetricsUnavailableError, missingScope, ProviderError } from "./errors";
import { checkedCommit, commitCall, expiresAt, oauthToken, request, requestJson, requireApp } from "./http";
import {
  allowInteraction,
  bool,
  commercialDisclosed,
  commonSettings,
  compactMetrics,
  firstBigId,
  isTiktokScopeError,
  metricNum,
  isVideoPost,
  privacyOptions,
  quoteBigIds,
  statusResult,
  tiktokAppFields,
  tiktokAuthorizeUrl,
  tiktokClassify,
  tiktokError,
  tiktokNotice,
  tiktokPostId,
  tiktokValidate,
} from "./tiktok-shared";
import type { AccountRecord, ConnectedAccount, MediaItem, PostMetricsResult, Provider, ProviderContext, PublishPost, PublishResult } from "./types";

const NAME = "TikTok";
const API = "https://open.tiktokapis.com/v2";
/** Analytics: `video.list` (Display API video/query) and `user.info.stats` (follower/like/video counts). */
const METRICS_SCOPES = ["video.list", "user.info.stats"];
const SCOPES = ["user.info.basic", "user.info.profile", "video.publish", "video.upload"];
/**
 * TikTok refuses the whole authorization when a scope is not approved for the app, so the analytics scopes are only
 * requested once the admin confirms they were added (app field `analytics`, off by default).
 */
const analyticsOn = (ctx: ProviderContext) => ctx.app.analytics === "on";
const scopesFor = (ctx: ProviderContext) => (analyticsOn(ctx) ? [...SCOPES, ...METRICS_SCOPES] : SCOPES);
const analyticsOff = () =>
  new MetricsUnavailableError(
    "not_supported",
    `${NAME} analytics are off: add the video.list and user.info.stats scopes to the TikTok app, then turn on "Analytics scopes" on the Platforms page and reconnect the account`,
  );
/** Display API /video/query/ accepts at most 20 video ids. */
const METRICS_BATCH = 20;

/**
 * TikTok chunk rules: 5-64MB per chunk, the last chunk takes the remainder (up to 128MB), count = floor(size / chunk).
 * The largest chunk keeps the number of PUTs (subrequests) low; each one is streamed from R2 without a copy.
 */
const CHUNK = 64 * 1024 * 1024;
/** Per call (workflow step): at most this many PUTs / this much time, then continue in checkStatus. */
const STEP_PUTS = 16;
const STEP_MS = 3 * 60 * 1000;

export function chunkPlan(size: number) {
  // Up to 64MB (including under 5MB) the whole file is one chunk.
  if (size <= CHUNK) return { chunkSize: size, count: 1 };
  return { chunkSize: CHUNK, count: Math.floor(size / CHUNK) };
}

interface CreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

interface UploadState {
  [key: string]: unknown;
  phase: "upload" | "status";
  publishId: string;
  username: string | null;
  uploadUrl?: string;
  video?: MediaItem;
  chunkSize?: number;
  count?: number;
  /** Next chunk index to send. */
  next?: number;
}

/**
 * POST to the Content Posting API; the envelope is `{ data, error: { code: "ok" | ... } }`. `commit`: this call
 * creates the post (docs/provider-brief.md "Commit semantics"); a 200 with an error code is still a refusal.
 */
async function api<T = any>(ctx: ProviderContext, token: string, path: string, json?: unknown, commit = false): Promise<T> {
  const send = () =>
    requestJson<{ data?: T; error?: { code?: string; message?: string } }>(ctx, `${API}${path}`, {
      method: "POST",
      token,
      headers: { "content-type": "application/json; charset=UTF-8" },
      json: json ?? {},
      classify: tiktokClassify,
      commit,
    }).catch((err) => {
      // Non-2xx responses carry the same envelope: surface the TikTok error code, not just its generic message.
      const body = err instanceof ProviderError ? (err.body as any) : undefined;
      throw body?.error?.code ? tiktokError(NAME, body.error, err.kind, err.status) : err;
    });
  const res = await checkedCommit(ctx, send, (res) => {
    if (res?.error?.code && res.error.code !== "ok") throw tiktokError(NAME, res.error);
  });
  return res.data as T;
}

async function userInfo(ctx: ProviderContext, token: string) {
  const res = await requestJson<{ data?: { user?: any }; error?: { code?: string } }>(ctx, `${API}/user/info/`, {
    token,
    query: { fields: "open_id,union_id,avatar_url,display_name,username" },
    classify: tiktokClassify,
  });
  if (res?.error?.code && res.error.code !== "ok") throw tiktokError(NAME, res.error);
  return res.data?.user ?? {};
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>) {
  const { clientKey, clientSecret } = requireApp(ctx, NAME, "clientKey", "clientSecret");
  const tok = await oauthToken(ctx, `${API}/oauth/token/`, { client_key: clientKey, client_secret: clientSecret, ...params });
  // Errors can come back as HTTP 200 with an `error` field.
  if ((tok as any).error || !tok.access_token) {
    const code = String((tok as any).error ?? "");
    throw new ProviderError(
      `TikTok token request failed: ${(tok as any).error_description ?? code}`,
      code === "invalid_grant" || code === "invalid_request" ? "auth" : "invalid",
    );
  }
  return tok;
}

export function creatorInfo(ctx: ProviderContext, token: string) {
  return api<CreatorInfo>(ctx, token, "/post/publish/creator_info/query/");
}

/** Validated post_info for a direct post. */
export function postInfo(post: PublishPost, info: CreatorInfo, video: boolean) {
  const s = post.settings;
  const allowed = info.privacy_level_options ?? [];
  if (!s.privacy_level) throw new ProviderError('TikTok: choose "Who can view" for this post', "invalid");
  const privacy = String(s.privacy_level);
  const commercial = commercialDisclosed(s);
  if (allowed.length && !allowed.includes(privacy)) {
    throw new ProviderError(`TikTok: privacy "${privacy}" is not available for this account (allowed: ${allowed.join(", ")})`, "invalid");
  }
  if (commercial && bool(s.brandContent) && privacy === "SELF_ONLY") throw new ProviderError("TikTok: branded content cannot be private", "invalid");
  const common = {
    privacy_level: privacy,
    disable_comment: !allowInteraction(s, "Comment") || !!info.comment_disabled,
    brand_content_toggle: commercial && bool(s.brandContent),
    brand_organic_toggle: commercial && bool(s.brandOrganic),
  };
  if (video) {
    return {
      ...(post.content ? { title: post.content } : {}),
      ...common,
      disable_duet: !allowInteraction(s, "Duet") || !!info.duet_disabled,
      disable_stitch: !allowInteraction(s, "Stitch") || !!info.stitch_disabled,
      is_aigc: bool(s.aiGenerated),
      ...(s.coverTimestampMs !== undefined && s.coverTimestampMs !== "" ? { video_cover_timestamp_ms: Number(s.coverTimestampMs) } : {}),
    };
  }
  return {
    ...(s.title ? { title: String(s.title).slice(0, 90) } : {}),
    ...(post.content ? { description: post.content } : {}),
    ...common,
    auto_add_music: bool(s.autoAddMusic),
  };
}

/**
 * The last chunk is the commit of a video post: once TikTok has every byte it publishes (or sends to the inbox), and
 * re-sending the chunk after a lost answer cannot be told apart from a refusal, so it is never retried. Earlier chunks
 * go to the same upload URL and are safe to resend.
 */
async function putChunk(ctx: ProviderContext, state: UploadState, index: number) {
  if (index === state.count! - 1) return commitCall(ctx, () => sendChunk(ctx, state, index));
  return sendChunk(ctx, state, index);
}

async function sendChunk(ctx: ProviderContext, state: UploadState, index: number) {
  const video = state.video!;
  const start = index * state.chunkSize!;
  const end = index === state.count! - 1 ? video.size - 1 : start + state.chunkSize! - 1;
  let res: Response;
  try {
    res = await ctx.fetch(state.uploadUrl!, {
      method: "PUT",
      headers: { "content-type": video.mime || "video/mp4", "content-range": `bytes ${start}-${end}/${video.size}` },
      body: await ctx.media.rangeStream(video, start, end - start + 1),
      // Required by Node/undici for stream bodies; ignored by Workers.
      duplex: "half",
    } as RequestInit);
  } catch (err) {
    throw new ProviderError(`Network error uploading to TikTok: ${(err as Error).message}`, "transient");
  }
  if (res.status === 200 || res.status === 201 || res.status === 206) return;
  const text = await res.text().catch(() => "");
  throw tiktokError(`TikTok upload failed (${res.status})`, text, res.status >= 500 || res.status === 429 ? "transient" : "invalid", res.status);
}

/** Upload chunks until done (-> status phase) or the step budget is used (-> resume later). */
async function uploadChunks(ctx: ProviderContext, state: UploadState): Promise<PublishResult> {
  const started = Date.now();
  let puts = 0;
  let next = state.next ?? 0;
  try {
    while (next < state.count!) {
      if (puts >= STEP_PUTS || Date.now() - started > STEP_MS) {
        ctx.log("info", `TikTok: uploaded ${next}/${state.count} chunks`);
        return { status: "pending", state: { ...state, next }, retryAfterSeconds: 5 };
      }
      await putChunk(ctx, state, next);
      puts++;
      next++;
    }
  } catch (err) {
    if (err instanceof ProviderError && err.retryable) {
      ctx.log("warn", `TikTok upload interrupted at chunk ${next + 1}/${state.count}, will resume: ${err.message}`);
      return { status: "pending", state: { ...state, next }, retryAfterSeconds: 30 };
    }
    throw err;
  }
  const { uploadUrl: _u, video: _v, ...rest } = state;
  return { status: "pending", state: { ...rest, phase: "status", next }, retryAfterSeconds: 10 };
}

async function fetchStatus(ctx: ProviderContext, token: string, state: UploadState): Promise<PublishResult> {
  const res = await request(ctx, `${API}/post/publish/status/fetch/`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json; charset=UTF-8" },
    json: { publish_id: state.publishId },
    classify: tiktokClassify,
  });
  const raw = await res.text();
  const body = JSON.parse(raw || "{}");
  if (body?.error?.code && body.error.code !== "ok") throw tiktokError(NAME, body.error);
  const data = body?.data ?? {};
  return statusResult(NAME, data.status, data.fail_reason, state.publishId, firstBigId(raw, "publicaly_available_post_id"), state.username, state);
}

function accountFrom(user: any, tok: { access_token: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number }): ConnectedAccount {
  return {
    externalId: String(user.open_id),
    name: user.display_name || user.username || "TikTok",
    username: user.username ?? null,
    avatarUrl: user.avatar_url ?? null,
    profileUrl: user.username ? `https://www.tiktok.com/@${user.username}` : null,
    credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
    expiresAt: expiresAt(tok.expires_in),
    refreshExpiresAt: expiresAt(tok.refresh_expires_in),
    meta: { openId: user.open_id, username: user.username ?? null },
  };
}

const token = (account: AccountRecord) => String(account.credentials.accessToken);

/**
 * Analytics request (Display API). Returns the raw `data` with int64 `id`s quoted. A missing scope
 * (`scope_not_authorized`, HTTP 401 or an error code) means "reconnect for analytics", not ProviderError("auth").
 */
async function readApi(ctx: ProviderContext, t: string, path: string, fields: string, json?: unknown): Promise<any> {
  let raw: string;
  try {
    const res = await request(ctx, `${API}${path}`, {
      method: json === undefined ? "GET" : "POST",
      token: t,
      query: { fields },
      ...(json === undefined ? {} : { headers: { "content-type": "application/json; charset=UTF-8" }, json }),
      classify: tiktokClassify,
    });
    raw = await res.text();
  } catch (err) {
    const body = err instanceof ProviderError ? (err.body as any) : undefined;
    if (isTiktokScopeError(body)) throw missingScope(NAME, METRICS_SCOPES);
    throw body?.error?.code ? tiktokError(NAME, body.error, (err as ProviderError).kind, (err as ProviderError).status) : err;
  }
  const body = JSON.parse(quoteBigIds(raw || "{}", "id"));
  if (body?.error?.code && body.error.code !== "ok") {
    if (isTiktokScopeError(body.error)) throw missingScope(NAME, METRICS_SCOPES);
    throw tiktokError(NAME, body.error);
  }
  return body?.data ?? {};
}

export const tiktok: Provider = {
  id: "tiktok",
  name: NAME,
  color: "000000",
  icon: "tiktok",
  category: "video",
  auth: "oauth2",
  status: "verified",
  statusNote: "Publishing verified with a sandbox app; unaudited apps post privately",
  docsUrl: "https://developers.tiktok.com/apps",
  setupNotes: [
    "1. Create an app on [TikTok for Developers](https://developers.tiktok.com/apps) and add the products **Login Kit** and **Content Posting API** (enable *Direct Post*).",
    "2. Request the scopes `user.info.basic`, `user.info.profile`, `video.upload` and `video.publish`, plus `video.list` and `user.info.stats` for analytics (add the **Display API** product; these scopes need TikTok's app review approval). Set **Analytics scopes** to *On* below only once they are added: TikTok refuses the whole login when a requested scope is not approved.",
    "3. In Login Kit, add the redirect URI `{{redirectUri}}`.",
    "4. Paste the client key and secret here.",
    "",
    "**Unaudited apps** can only post with privacy **Only me** (SELF_ONLY), so that is the default: change the visibility in the TikTok app afterwards, or submit the app for the Direct Post audit to post publicly. Unaudited apps are also limited to a few users and posts per day.",
    "",
    "Analytics: accounts connected before `video.list` / `user.info.stats` were added must be **reconnected**. Post metrics need the public post id, which TikTok only returns for public posts after moderation: private (\"Only me\") posts, inbox drafts and posts of sandbox/unaudited apps have no metrics.",
    "",
    "Videos are uploaded as files (no domain verification needed). **Photo posts** are pulled by TikTok from this server's media URLs, so the domain of `{{baseUrl}}` must be added and verified as a **URL property** of the app (Content Posting API > Verify domains). With a custom media domain (`MEDIA_PUBLIC_URL`), verify that domain instead (or both).",
  ].join("\n"),
  appFields: [
    ...tiktokAppFields,
    {
      key: "analytics",
      label: "Analytics scopes",
      type: "select",
      default: "off",
      options: [
        { value: "off", label: "Off (video.list / user.info.stats not approved yet)" },
        { value: "on", label: "On: request video.list and user.info.stats" },
      ],
      help: "Turn on once the scopes are added to the app (and approved in app review), then reconnect TikTok accounts.",
    },
  ],
  credentialFields: [],
  composerNotice: tiktokNotice,
  settingsFields: [
    ...commonSettings({ draftLabel: "Send to TikTok inbox as a draft" }),
    {
      key: "privacy_level",
      label: "Who can view",
      type: "select",
      dynamicOptions: true,
      // No default: TikTok requires the creator to pick the audience themselves.
      required: true,
      placeholder: "Choose who can view",
      showIf: { key: "postMode", equals: "direct" },
      options: privacyOptions(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]),
    },
    {
      key: "coverTimestampMs",
      label: "Cover frame (ms into the video)",
      type: "number",
      showIf: { key: "postMode", equals: "direct" },
    },
  ],
  capabilities: {
    maxLength: 2200,
    text: "optional",
    media: { images: 35, videos: 1, mixed: false, required: true },
    thread: false,
  },

  metrics: {
    post: ["views", "likes", "comments", "shares"],
    account: ["followers", "following", "posts"],
    batch: METRICS_BATCH,
    scopes: METRICS_SCOPES,
  },

  authorize(ctx, { state }) {
    // TikTok's web Login Kit has no PKCE (code_challenge is only for desktop/mobile, and there it is hex SHA-256, not base64url).
    return tiktokAuthorizeUrl(ctx, NAME, scopesFor(ctx), state);
  },

  async callback(ctx, { code }) {
    const tok = await tokenRequest(ctx, { code, grant_type: "authorization_code", redirect_uri: ctx.redirectUri });
    const user = await userInfo(ctx, tok.access_token);
    return [accountFrom({ open_id: tok.open_id, ...user }, tok)];
  },

  async refresh(ctx, account) {
    const tok = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: String(account.credentials.refreshToken ?? "") });
    return {
      credentials: { accessToken: tok.access_token, ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}) },
      expiresAt: expiresAt(tok.expires_in),
      ...(tok.refresh_expires_in ? { refreshExpiresAt: expiresAt(tok.refresh_expires_in) } : {}),
    };
  },

  validate(post) {
    return tiktokValidate(NAME, post, 35);
  },

  async profile(ctx, account) {
    const user = await userInfo(ctx, account.credentials.accessToken as string);
    return { avatarUrl: user.avatar_url ?? null };
  },

  async publish(ctx, account, post) {
    const t = token(account);
    const inbox = post.settings.postMode === "inbox";
    const video = post.media.find((m) => m.kind === "video");
    const info = await creatorInfo(ctx, t);
    const username = info.creator_username ?? (account.meta.username as string) ?? account.username ?? null;

    if (video) {
      if (!inbox && info.max_video_post_duration_sec && video.duration && video.duration > info.max_video_post_duration_sec) {
        throw new ProviderError(`TikTok: this account can post videos up to ${info.max_video_post_duration_sec}s`, "invalid");
      }
      const { chunkSize, count } = chunkPlan(video.size);
      // Not a commit: the publish only happens once the file is uploaded (the last chunk, see putChunk). A lost init
      // leaves a publish id without bytes, which TikTok drops.
      const source_info = { source: "FILE_UPLOAD", video_size: video.size, chunk_size: chunkSize, total_chunk_count: count };
      const data = inbox
        ? await api<{ publish_id: string; upload_url: string }>(ctx, t, "/post/publish/inbox/video/init/", { source_info })
        : await api<{ publish_id: string; upload_url: string }>(ctx, t, "/post/publish/video/init/", {
            post_info: postInfo(post, info, true),
            source_info,
          });
      return uploadChunks(ctx, {
        phase: "upload",
        publishId: data.publish_id,
        username,
        uploadUrl: data.upload_url,
        video,
        chunkSize,
        count,
        next: 0,
      });
    }

    if (isVideoPost(post.media) || !post.media.length) throw new ProviderError("TikTok needs one video or photos", "invalid");
    const photos = post.media.filter((m) => m.kind === "image");
    const data = await api<{ publish_id: string }>(ctx, t, "/post/publish/content/init/", {
      post_info: inbox
        ? { ...(post.settings.title ? { title: String(post.settings.title).slice(0, 90) } : {}), ...(post.content ? { description: post.content } : {}) }
        : postInfo(post, info, false),
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: photos.map((p) => p.url) },
      post_mode: inbox ? "MEDIA_UPLOAD" : "DIRECT_POST",
      media_type: "PHOTO",
    }, true);
    return { status: "pending", state: { phase: "status", publishId: data.publish_id, username }, retryAfterSeconds: 10 };
  },

  async checkStatus(ctx, account, state) {
    const s = state as UploadState;
    if (s.phase === "upload") return uploadChunks(ctx, s);
    return fetchStatus(ctx, token(account), s);
  },

  async composerInfo(ctx, account) {
    const info = await creatorInfo(ctx, token(account));
    return {
      nickname: info.creator_nickname ?? null,
      username: info.creator_username ?? null,
      privacyLevelOptions: info.privacy_level_options ?? [],
      commentDisabled: !!info.comment_disabled,
      duetDisabled: !!info.duet_disabled,
      stitchDisabled: !!info.stitch_disabled,
      maxVideoPostDurationSec: info.max_video_post_duration_sec ?? null,
    };
  },

  async options(ctx, account, key) {
    if (key !== "privacy_level") return [];
    const info = await creatorInfo(ctx, token(account));
    return privacyOptions(info.privacy_level_options ?? []);
  },
  /**
   * One Display API /video/query/ call for the batch. Items without a public post id (only a publish id, see
   * `tiktokPostId`) are not sent and get null; ids TikTok does not return (deleted, private, photo posts) → null.
   */
  async postMetrics(ctx, account, items) {
    if (!analyticsOn(ctx)) throw analyticsOff();
    const out: PostMetricsResult = {};
    const byId = new Map<string, string[]>();
    for (const item of items.slice(0, METRICS_BATCH)) {
      const id = tiktokPostId(item);
      if (!id) {
        out[item.externalId] = null;
        continue;
      }
      byId.set(id, [...(byId.get(id) ?? []), item.externalId]);
    }
    if (!byId.size) return out;
    const data = await readApi(ctx, token(account), "/video/query/", "id,view_count,like_count,comment_count,share_count", {
      filters: { video_ids: [...byId.keys()] },
    });
    const found = new Map<string, any>((data.videos ?? []).map((v: any) => [String(v.id), v]));
    for (const [id, externalIds] of byId) {
      const v = found.get(id);
      const m = v
        ? compactMetrics({ views: metricNum(v.view_count), likes: metricNum(v.like_count), comments: metricNum(v.comment_count), shares: metricNum(v.share_count) })
        : null;
      for (const e of externalIds) out[e] = m;
    }
    return out;
  },

  /** /user/info/ stats: followers, following, videos, and the total likes received (extra.total_likes). */
  async accountMetrics(ctx, account) {
    if (!analyticsOn(ctx)) throw analyticsOff();
    const data = await readApi(ctx, token(account), "/user/info/", "follower_count,following_count,likes_count,video_count");
    const u = data.user ?? {};
    return compactMetrics({
      followers: metricNum(u.follower_count),
      following: metricNum(u.following_count),
      posts: metricNum(u.video_count),
      extra: { total_likes: metricNum(u.likes_count) } as Record<string, number>,
    });
  },
};
