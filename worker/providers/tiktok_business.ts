import type { ProviderErrorKind } from "./errors";
import { missingScope, ProviderError } from "./errors";
import { checkedCommit, expiresAt, request, requireApp } from "./http";
import {
  allowInteraction,
  bool,
  commercialDisclosed,
  commonSettings,
  compactMetrics,
  privacyOptions,
  quoteBigIds,
  statusResult,
  firstBigId,
  isTiktokScopeError,
  metricNum,
  tiktokAppFields,
  tiktokAuthorizeUrl,
  tiktokError,
  tiktokNotice,
  tiktokPostId,
  tiktokReason,
  tiktokValidate,
} from "./tiktok-shared";
import type { AccountRecord, PostMetricsResult, Provider, ProviderContext, PublishPost } from "./types";

/**
 * TikTok API for Business (business accounts): Business API v1.3 with the `Access-Token` header.
 * Media is pulled from its URL (no file upload variant), so the media domain must be verified.
 */
const NAME = "TikTok Business";
const API = "https://business-api.tiktok.com/open_api/v1.3";
const SCOPES = ["user.info.basic", "user.info.username", "user.info.stats", "video.list", "video.upload", "video.publish"];
/** Analytics: /business/video/list/ (video.list) and /business/get/ followers_count (user.info.stats). */
const METRICS_SCOPES = ["video.list", "user.info.stats"];
/** /business/video/list/ filters at most 20 video ids per request. */
const METRICS_BATCH = 20;

/** Business API errors arrive as HTTP 200 with a non-zero `code`. */
function envelopeKind(body: any): ProviderErrorKind {
  const r = tiktokReason(JSON.stringify(body ?? {}));
  if (r) return r.kind;
  const code = Number(body?.code);
  const msg = String(body?.message ?? "");
  if ([40102, 40104, 40105].includes(code) || /access token/i.test(msg)) return "auth";
  if (code === 40100 || /too many requests/i.test(msg)) return "rate_limit";
  if (code >= 50000) return "transient";
  return "invalid";
}

/** `commit`: this call creates the post (docs/provider-brief.md "Commit semantics"). */
async function call<T = any>(
  ctx: ProviderContext,
  path: string,
  opts: { token?: string; query?: Record<string, string | undefined>; json?: unknown; commit?: boolean } = {},
): Promise<T> {
  const send = async () => {
    const res = await request(ctx, `${API}${path}`, {
      method: opts.json === undefined ? "GET" : "POST",
      headers: opts.token ? { "access-token": opts.token } : {},
      query: opts.query,
      json: opts.json,
      classify: (_s, body) => tiktokReason(JSON.stringify(body ?? ""))?.kind,
      commit: opts.commit,
    });
    const raw = await res.text();
    return { raw, body: JSON.parse(raw || "{}") };
  };
  // A 200 envelope error is a refusal (nothing created), except a server error code on a commit: ambiguous.
  const { raw, body } = await checkedCommit(ctx, send, ({ body }) => {
    if (body?.code === 0) return;
    const r = tiktokReason(JSON.stringify(body));
    let kind = envelopeKind(body);
    if (opts.commit && kind === "transient") kind = "ambiguous";
    throw new ProviderError(`${NAME}: ${r?.message ?? body?.message ?? "request failed"}`, kind, 200, body);
  });
  return { ...body.data, __raw: raw } as T;
}

async function tokenRequest(ctx: ProviderContext, path: string, params: Record<string, string>) {
  const { clientKey, clientSecret } = requireApp(ctx, NAME, "clientKey", "clientSecret");
  try {
    return await call<{
      access_token: string;
      refresh_token?: string;
      open_id: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      refresh_expires_in?: number;
      scope?: string;
    }>(ctx, path, {
      json: { client_id: clientKey, client_secret: clientSecret, ...params },
    });
  } catch (err) {
    // Any failure of a token request (expired code / refresh token) means reconnecting.
    if (err instanceof ProviderError && err.kind === "invalid") throw new ProviderError(err.message, "auth", err.status, err.body);
    throw err;
  }
}

function profile(ctx: ProviderContext, token: string, businessId: string) {
  return call<{ username?: string; display_name?: string; profile_image?: string }>(ctx, "/business/get/", {
    token,
    query: { business_id: businessId, fields: JSON.stringify(["username", "display_name", "profile_image"]) },
  });
}

const token = (a: AccountRecord) => String(a.credentials.accessToken);

/** `call` for analytics: a missing permission means "reconnect for analytics", never ProviderError("auth"). */
async function readCall<T = any>(ctx: ProviderContext, path: string, opts: { token: string; query: Record<string, string> }): Promise<T> {
  try {
    return await call<T>(ctx, path, opts);
  } catch (err) {
    if (err instanceof ProviderError && (isTiktokScopeError(err.body) || /\bscope\b/i.test(String((err.body as any)?.message ?? ""))))
      throw missingScope(NAME, METRICS_SCOPES);
    throw err;
  }
}

/** "id|name" values of the location select. */
function location(v: unknown) {
  if (!v) return {};
  const s = String(v);
  const i = s.indexOf("|");
  return i < 0 ? { location_id: s } : { location_id: s.slice(0, i), location_name: s.slice(i + 1) };
}

export function videoBody(businessId: string, post: PublishPost) {
  const s = post.settings;
  const draft = s.postMode === "inbox";
  const video = post.media.find((m) => m.kind === "video")!;
  return {
    business_id: businessId,
    video_url: video.url,
    ...(s.coverTimestampMs !== undefined && s.coverTimestampMs !== "" ? { thumbnail_offset: Number(s.coverTimestampMs) } : {}),
    post_info: {
      ...(post.content ? { caption: post.content } : {}),
      is_brand_organic: commercialDisclosed(s) && bool(s.brandOrganic),
      is_branded_content: commercialDisclosed(s) && bool(s.brandContent),
      ...(draft
        ? { upload_to_draft: true }
        : {
            disable_comment: !allowInteraction(s, "Comment"),
            disable_duet: !allowInteraction(s, "Duet"),
            disable_stitch: !allowInteraction(s, "Stitch"),
            is_ai_generated: bool(s.aiGenerated),
            ...location(s.location),
            // The API defaults both volumes to 0 (muted); the TikTok app uses 50.
            ...(s.music
              ? {
                  music_sound_info: {
                    music_sound_id: String(s.music),
                    music_sound_volume: Number(s.musicVolume ?? 50),
                    video_original_sound_volume: Number(s.videoVolume ?? 50),
                  },
                }
              : {}),
          }),
    },
  };
}

export function photoBody(businessId: string, post: PublishPost) {
  const s = post.settings;
  const draft = s.postMode === "inbox";
  return {
    business_id: businessId,
    photo_images: post.media.filter((m) => m.kind === "image").map((m) => m.url),
    photo_cover_index: 0,
    post_info: {
      ...(s.title ? { title: String(s.title).slice(0, 90) } : {}),
      ...(post.content ? { caption: post.content } : {}),
      is_brand_organic: commercialDisclosed(s) && bool(s.brandOrganic),
      is_branded_content: commercialDisclosed(s) && bool(s.brandContent),
      ...(draft
        ? { is_draft: true }
        : {
            privacy_level: String(s.privacy_level),
            disable_comment: !allowInteraction(s, "Comment"),
            auto_add_music: !s.music && bool(s.autoAddMusic),
            ...location(s.location),
            ...(s.music ? { music_sound_info: { music_sound_id: String(s.music) } } : {}),
          }),
    },
  };
}

export const tiktokBusiness: Provider = {
  redirectTrailingSlash: true,
  id: "tiktok_business",
  name: NAME,
  color: "000000",
  icon: "tiktok",
  category: "video",
  auth: "oauth2",
  docsUrl: "https://business-api.tiktok.com/portal/apps",
  setupNotes: [
    "For **TikTok business accounts** via the TikTok API for Business. Personal/creator accounts: use the *TikTok* platform instead.",
    "",
    "1. Create a developer app on the [TikTok API for Business portal](https://business-api.tiktok.com/portal/apps) with the *TikTok Accounts* (organic) product.",
    "2. Request the scopes `user.info.basic`, `user.info.username`, `user.info.stats`, `video.list`, `video.upload` and `video.publish`.",
    "3. Set the redirect URL to `{{redirectUri}}`.",
    "4. TikTok pulls every video and photo from this server's media URLs: add the domain of `{{baseUrl}}` as a verified **URL property** of the app (with a custom media domain, `MEDIA_PUBLIC_URL`, that domain instead, or both).",
    "5. Paste the app ID (client key) and secret here.",
    "",
    "Analytics use `video.list` (video views, likes, comments, shares, reach) and `user.info.stats` (followers). Post metrics need the public post id, which TikTok returns only after moderation; drafts have none.",
    "",
    "Music and location tags are only applied to direct posts. Video posts use the account's default privacy (the API has no privacy field for videos).",
  ].join("\n"),
  appFields: tiktokAppFields.map((f) => (f.key === "clientKey" ? { ...f, label: "App ID (client key)" } : f)),
  credentialFields: [],
  composerNotice: tiktokNotice,
  settingsFields: [
    ...commonSettings({ draftLabel: "Save as draft in the TikTok app" }),
    {
      key: "privacy_level",
      label: "Who can view (photos)",
      type: "select",
      required: true,
      placeholder: "Choose who can view",
      showIf: { key: "postMode", equals: "direct" },
      options: privacyOptions(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]),
    },
    { key: "music", label: "Music (commercial library)", type: "select", dynamicOptions: true, default: "", showIf: { key: "postMode", equals: "direct" } },
    { key: "musicVolume", label: "Music volume (video, 0-100)", type: "number", default: 50, showIf: { key: "postMode", equals: "direct" } },
    { key: "videoVolume", label: "Original sound volume (video, 0-100)", type: "number", default: 50, showIf: { key: "postMode", equals: "direct" } },
    { key: "locationQuery", label: "Search location", type: "text", showIf: { key: "postMode", equals: "direct" } },
    {
      key: "location",
      label: "Location",
      type: "select",
      dynamicOptions: true,
      default: "",
      help: "Type a search above, then pick a location.",
      showIf: { key: "postMode", equals: "direct" },
    },
    { key: "coverTimestampMs", label: "Cover frame (ms into the video)", type: "number" },
  ],
  capabilities: {
    maxLength: 2200,
    text: "optional",
    media: { images: 35, videos: 1, mixed: false, required: true },
    thread: false,
  },

  metrics: {
    post: ["views", "likes", "comments", "shares", "reach"],
    account: ["followers"],
    batch: METRICS_BATCH,
    scopes: METRICS_SCOPES,
  },

  authorize(ctx, { state }) {
    return tiktokAuthorizeUrl(ctx, NAME, SCOPES, state, { disable_auto_auth: "1" });
  },

  async callback(ctx, { code }) {
    const tok = await tokenRequest(ctx, "/tt_user/oauth2/token/", {
      grant_type: "authorization_code",
      auth_code: code,
      redirect_uri: ctx.redirectUri,
    });
    const p = await profile(ctx, tok.access_token, tok.open_id);
    return [
      {
        // open_id doubles as the business_id of every call: keep it verbatim.
        externalId: tok.open_id,
        name: p.display_name || p.username || "TikTok",
        username: p.username ?? null,
        avatarUrl: p.profile_image ?? null,
        profileUrl: p.username ? `https://www.tiktok.com/@${p.username}` : null,
        credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
        expiresAt: expiresAt(tok.expires_in ?? 86400),
        refreshExpiresAt: expiresAt(tok.refresh_token_expires_in ?? tok.refresh_expires_in),
        meta: { businessId: tok.open_id, username: p.username ?? null },
      },
    ];
  },

  async refresh(ctx, account) {
    const tok = await tokenRequest(ctx, "/tt_user/oauth2/refresh_token/", {
      grant_type: "refresh_token",
      refresh_token: String(account.credentials.refreshToken ?? ""),
    });
    return {
      credentials: { accessToken: tok.access_token, ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}) },
      expiresAt: expiresAt(tok.expires_in ?? 86400),
      ...(tok.refresh_token_expires_in || tok.refresh_expires_in
        ? { refreshExpiresAt: expiresAt(tok.refresh_token_expires_in ?? tok.refresh_expires_in) }
        : {}),
    };
  },

  validate(post) {
    return tiktokValidate(NAME, post, 35);
  },

  async publish(ctx, account, post) {
    if (!post.media.length) throw new ProviderError(`${NAME} needs one video or photos`, "invalid");
    const video = post.media.some((m) => m.kind === "video");
    const data = await call<{ share_id?: string }>(ctx, video ? "/business/video/publish/" : "/business/photo/publish/", {
      token: token(account),
      json: video ? videoBody(account.externalId, post) : photoBody(account.externalId, post),
      // TikTok pulls the media and posts it: this is the commit.
      commit: true,
    });
    if (!data.share_id) throw tiktokError(NAME, "TikTok did not return a publish id", "invalid");
    return { status: "pending", state: { publishId: data.share_id }, retryAfterSeconds: 15 };
  },

  async checkStatus(ctx, account, state) {
    const publishId = String(state.publishId);
    const data = await call<{ status?: string; reason?: string; __raw: string }>(ctx, "/business/publish/status/", {
      token: token(account),
      query: { business_id: account.externalId, publish_id: publishId },
    });
    const username = (account.meta.username as string) ?? account.username;
    return statusResult(NAME, data.status, data.reason, publishId, firstBigId(data.__raw, "post_ids"), username, state);
  },

  async options(ctx, account, key, settings) {
    if (key === "music") {
      const data = await call<{ list?: any[] }>(ctx, "/discovery/cml/trending_list/", {
        token: token(account),
        query: { business_id: account.externalId },
      });
      const tracks = (data.list ?? [])
        .map((t) => ({
          value: String(t?.full_duration_song_clip?.song_clip_id ?? t?.trending_song_clip?.song_clip_id ?? ""),
          label: [t?.commercial_music_name, t?.artist].filter(Boolean).join(" - ") || "Track",
        }))
        .filter((t) => t.value);
      return [{ value: "", label: "None" }, ...tracks];
    }
    if (key === "location") {
      const q = String(settings.locationQuery ?? "").trim();
      if (!q) return [{ value: "", label: "None (type a search first)" }];
      const data = await call<{ locations?: any[] }>(ctx, "/business/publish/location/", {
        token: token(account),
        query: { business_id: account.externalId, search_query: q.slice(0, 100) },
      });
      return [
        { value: "", label: "None" },
        ...(data.locations ?? []).map((l) => ({
          value: `${l.location_id}|${l.location_name ?? ""}`,
          label: [l.location_name, l.location_address].filter(Boolean).join(", "),
        })),
      ];
    }
    return [];
  },
  /**
   * One /business/video/list/ call filtered by the batch's post ids. Items that only have a publish id (drafts, posts
   * stored before moderation finished) are not sent and get null; ids TikTok does not return → null.
   */
  async postMetrics(ctx, account, items) {
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
    const data = await readCall<{ videos?: any[]; __raw: string }>(ctx, "/business/video/list/", {
      token: token(account),
      query: {
        business_id: account.externalId,
        fields: JSON.stringify(["item_id", "video_views", "likes", "comments", "shares", "reach"]),
        filters: JSON.stringify({ video_ids: [...byId.keys()] }),
        max_count: String(METRICS_BATCH),
      },
    });
    // item_id is an int64: read the ids from the raw text so no digit is lost.
    const videos: any[] = JSON.parse(quoteBigIds(data.__raw, "item_id"))?.data?.videos ?? [];
    const found = new Map(videos.map((v) => [String(v.item_id), v]));
    for (const [id, externalIds] of byId) {
      const v = found.get(id);
      const m = v
        ? compactMetrics({
            views: metricNum(v.video_views),
            likes: metricNum(v.likes),
            comments: metricNum(v.comments),
            shares: metricNum(v.shares),
            reach: metricNum(v.reach),
          })
        : null;
      for (const e of externalIds) out[e] = m;
    }
    return out;
  },

  /** Lifetime follower count from /business/get/. */
  async accountMetrics(ctx, account) {
    const data = await readCall<{ followers_count?: number }>(ctx, "/business/get/", {
      token: token(account),
      query: { business_id: account.externalId, fields: JSON.stringify(["followers_count"]) },
    });
    return compactMetrics({ followers: metricNum(data.followers_count) });
  },
};
