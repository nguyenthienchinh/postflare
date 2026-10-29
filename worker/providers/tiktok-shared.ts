import type { FieldDef, FieldOption } from "../../shared/types";
import { ProviderError, type ProviderErrorKind } from "./errors";
import { requireApp } from "./http";
import type { MediaItem, MetricsItem, MetricValues, ProviderContext, PublishPost, PublishResult } from "./types";

/** Code shared by the TikTok (Content Posting API) and TikTok Business (Business API) providers. */

export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";

export function tiktokAuthorizeUrl(ctx: ProviderContext, name: string, scopes: string[], state: string, extra: Record<string, string> = {}) {
  const { clientKey } = requireApp(ctx, name, "clientKey", "clientSecret");
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_key: clientKey,
    scope: scopes.join(","),
    response_type: "code",
    redirect_uri: ctx.redirectUri,
    state,
    // Always show TikTok's authorization page (with "Switch account"), even when the user approved the app before:
    // the creator sees which account they connect and what Postflare asks for.
    disable_auto_auth: "1",
    ...extra,
  }).toString();
  return url.toString();
}

export const tiktokAppFields: FieldDef[] = [
  { key: "clientKey", label: "Client key", type: "text", required: true },
  { key: "clientSecret", label: "Client secret", type: "password", required: true },
];

export const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

export const privacyOptions = (levels: string[]): FieldOption[] => levels.map((v) => ({ value: v, label: PRIVACY_LABELS[v] ?? v }));

export const bool = (v: unknown, dflt = false) =>
  v === undefined || v === null || v === "" ? dflt : v === true || v === "true" || v === "yes" || v === 1;

/** Friendly messages for TikTok error codes / fail reasons. */
const REASONS: Array<[string, string, ProviderErrorKind]> = [
  ["access_token_invalid", "The TikTok access token is invalid or expired; reconnect the account", "auth"],
  ["Access token is incorrect", "The TikTok access token is invalid; reconnect the account", "auth"],
  ["Access token has expired", "The TikTok access token expired; reconnect the account", "auth"],
  ["auth_removed", "The app's access was removed in TikTok; reconnect the account", "auth"],
  ["scope_not_authorized", "A required TikTok permission was not granted; reconnect and approve every permission", "auth"],
  ["scope_permission_missed", "A required TikTok permission is missing; reconnect the account", "auth"],
  ["rate_limit_exceeded", "TikTok API rate limit exceeded", "rate_limit"],
  ["spam_risk_too_many_posts", "TikTok's daily post limit for this account is reached; try again tomorrow", "invalid"],
  ["spam_risk_too_many_pending_share", "TikTok allows 5 pending inbox drafts per 24 hours; publish or delete drafts in the TikTok app", "invalid"],
  ["spam_risk_user_banned_from_posting", "This TikTok account is banned from posting", "invalid"],
  ["spam_risk_text", "TikTok flagged the caption as spam", "invalid"],
  ["spam_risk", "TikTok flagged the post as spam", "invalid"],
  ["reached_active_user_cap", "The TikTok app reached its daily active user cap; try again tomorrow", "invalid"],
  [
    "unaudited_client_can_only_post_to_private_accounts",
    "Until the app passes TikTok's audit, the TikTok account itself must be private (TikTok app → Settings and privacy → Privacy → Private account) and posts must use \"Only me\"",
    "invalid",
  ],
  ["url_ownership_unverified", "TikTok cannot pull the media: the media domain is not a verified URL property of your TikTok app", "invalid"],
  ["privacy_level_option_mismatch", "The privacy level is not allowed for this account", "invalid"],
  ["file_format_check_failed", "TikTok rejected the file format", "invalid"],
  ["duration_check_failed", "The video duration is not accepted by TikTok", "invalid"],
  ["frame_rate_check_failed", "The video frame rate is not accepted by TikTok", "invalid"],
  ["picture_size_check_failed", "Media size not supported: photos up to 1080px on the shorter side, videos at least 360px", "invalid"],
  ["video_pull_failed", "TikTok could not download the video", "invalid"],
  ["photo_pull_failed", "TikTok could not download the photos", "invalid"],
  ["publish_cancelled", "TikTok cancelled the upload", "invalid"],
  ["app_version_check_failed", "The TikTok app on the phone must be updated to receive drafts", "invalid"],
  ["internal_error", "TikTok server error", "transient"],
];

export function tiktokReason(text: string): { message: string; kind: ProviderErrorKind } | undefined {
  const hit = REASONS.find(([code]) => text.includes(code));
  return hit ? { message: hit[1], kind: hit[2] } : undefined;
}

export function tiktokError(prefix: string, body: unknown, fallbackKind: ProviderErrorKind = "invalid", status?: number) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const r = tiktokReason(text);
  // A failed commit stays ambiguous unless TikTok names a definite refusal (a "server error" code is not one).
  const kind = r && !(fallbackKind === "ambiguous" && r.kind === "transient") ? r.kind : fallbackKind;
  return new ProviderError(`${prefix}: ${r?.message ?? text.slice(0, 300)}`, kind, status, body);
}

/** `classify` for http helpers: TikTok error codes override the status mapping. */
export function tiktokClassify(_status: number, body: any): ProviderErrorKind | undefined {
  return tiktokReason(JSON.stringify(body ?? ""))?.kind;
}

/** Raw int64 ids lose precision in JSON.parse: read the digits from the raw text. */
export function firstBigId(raw: string, field: string): string | undefined {
  return raw.match(new RegExp(`"${field}"\\s*:\\s*\\[\\s*"?(\\d+)`))?.[1];
}

// ---------- analytics ----------

/** Error codes of a token that lacks a permission (scope). For analytics these mean "reconnect", not "auth". */
export function isTiktokScopeError(body: unknown): boolean {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return /scope_not_authorized|scope_permission_missed/.test(text);
}

/**
 * The public TikTok post id of a published item, or null when we only know the publish id.
 * Publish stores the public id (`publicaly_available_post_id` / `post_ids`) when TikTok returns it, else the publish id
 * ("v_pub_file~...", "p_pub_url~..."): TikTok omits the public id for private (SELF_ONLY) posts, inbox drafts,
 * unaudited/sandbox apps and posts still in moderation. Those posts cannot be queried for metrics.
 */
export function tiktokPostId(item: MetricsItem): string | null {
  if (/^\d+$/.test(item.externalId)) return item.externalId;
  const d = item.data ?? {};
  for (const k of ["postId", "videoId", "itemId"]) {
    const v = d[k];
    if ((typeof v === "string" || typeof v === "number") && /^\d+$/.test(String(v))) return String(v);
  }
  return null;
}

/** Quote the int64 values of `field` in raw JSON so JSON.parse keeps every digit. */
export function quoteBigIds(raw: string, field: string): string {
  return raw.replace(new RegExp(`("${field}"\\s*:\\s*)(\\d+)`, "g"), '$1"$2"');
}

/** A finite number, else undefined (not reported). */
export const metricNum = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Drop undefined keys (and an empty `extra`) so only reported numbers are set. */
export function compactMetrics(m: MetricValues): MetricValues {
  const out: MetricValues = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "extra") {
      const extra = Object.fromEntries(Object.entries(v ?? {}).filter(([, x]) => x !== undefined)) as Record<string, number>;
      if (Object.keys(extra).length) out.extra = extra;
    } else if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}

export function tiktokPostUrl(username: string | null | undefined, publishId: string, postId: string | undefined): string | null {
  if (!username) return null;
  if (!postId) return `https://www.tiktok.com/@${username}`;
  // Photo publish ids start with "p_"; photo posts live under /photo/.
  return `https://www.tiktok.com/@${username}/${publishId.startsWith("p_") ? "photo" : "video"}/${postId}`;
}

/** Map a publish status (both APIs use the same values) to a PublishResult. */
export function statusResult(
  prefix: string,
  status: string | undefined,
  reason: string | undefined,
  publishId: string,
  postId: string | undefined,
  username: string | null | undefined,
  state: Record<string, unknown>,
): PublishResult {
  if (status === "PUBLISH_COMPLETE") {
    // The public id appears only after moderation and never for private posts: fall back to the publish id.
    return { status: "published", externalId: postId ?? publishId, url: tiktokPostUrl(username, publishId, postId), data: { publishId } };
  }
  if (status === "SEND_TO_USER_INBOX") {
    return { status: "published", externalId: publishId, url: "https://www.tiktok.com/messages", data: { publishId, inbox: true } };
  }
  if (status === "FAILED") throw tiktokError(prefix, reason || "publish failed", "invalid");
  return { status: "pending", state, retryAfterSeconds: 15 };
}

export function tiktokValidate(name: string, post: PublishPost, maxPhotos: number): string[] {
  const videos = post.media.filter((m) => m.kind === "video");
  const images = post.media.filter((m) => m.kind === "image");
  const errors: string[] = [];
  if (!post.media.length) errors.push(`${name}: attach one video or up to ${maxPhotos} photos`);
  if (videos.length > 1) errors.push(`${name}: only one video per post`);
  if (videos.length && images.length) errors.push(`${name}: a post is either one video or photos`);
  if (images.length > maxPhotos) errors.push(`${name}: at most ${maxPhotos} photos`);
  for (const img of images) {
    if (!["image/jpeg", "image/webp"].includes(img.mime)) errors.push(`${name}: photos must be JPEG or WebP (${img.filename})`);
    if (img.width && img.height && Math.min(img.width, img.height) > 1080)
      errors.push(`${name}: ${img.filename} is ${img.width}x${img.height}; photos may be at most 1080px on the shorter side`);
  }
  if (post.settings.commercialContent && !post.settings.brandOrganic && !post.settings.brandContent)
    errors.push(`${name}: You need to indicate if your content promotes yourself, a third party, or both.`);
  if (post.settings.commercialContent && post.settings.brandContent && post.settings.privacy_level === "SELF_ONLY")
    errors.push(`${name}: Branded content visibility cannot be set to private.`);
  return errors;
}

/** Interactions are opt-in (`allowX`); posts saved before that used `disableX`. */
export function allowInteraction(s: Record<string, unknown>, what: "Comment" | "Duet" | "Stitch"): boolean {
  if (s[`allow${what}`] !== undefined) return bool(s[`allow${what}`]);
  return s[`disable${what}`] === undefined ? false : !bool(s[`disable${what}`]);
}

/** Brand toggles only count when the commercial content disclosure is on (older posts had no switch). */
export function commercialDisclosed(s: Record<string, unknown>): boolean {
  return s.commercialContent === undefined ? bool(s.brandContent) || bool(s.brandOrganic) : bool(s.commercialContent);
}

/** Shown in the composer next to the TikTok settings (required by TikTok's content sharing guidelines). */
export const tiktokNotice = [
  "By posting, you agree to TikTok's [Music Usage Confirmation](https://www.tiktok.com/legal/page/global/music-usage-confirmation/en).",
  "With **Branded content** you also agree to TikTok's [Branded Content Policy](https://www.tiktok.com/legal/page/global/bc-policy/en).",
  "After publishing, it can take a few minutes for the post to appear on your profile.",
].join(" ");

export const isVideoPost = (media: MediaItem[]) => media.some((m) => m.kind === "video");

/** Settings common to both TikTok providers. */
export const commonSettings = (opts: { draftLabel: string }): FieldDef[] => [
  {
    key: "postMode",
    label: "Mode",
    type: "select",
    default: "direct",
    options: [
      { value: "direct", label: "Publish directly" },
      { value: "inbox", label: opts.draftLabel },
    ],
    help: "Drafts ignore every setting except the caption; finish them in the TikTok app.",
  },
  { key: "title", label: "Photo title", type: "text", maxLength: 90, help: "Photo posts only. The post text is the caption." },
  // TikTok's content sharing guidelines: interactions are opt-in (unchecked by default).
  { key: "allowComment", label: "Allow comments", type: "checkbox", default: false, showIf: { key: "postMode", equals: "direct" } },
  { key: "allowDuet", label: "Allow duets (video)", type: "checkbox", default: false, showIf: { key: "postMode", equals: "direct" } },
  { key: "allowStitch", label: "Allow stitches (video)", type: "checkbox", default: false, showIf: { key: "postMode", equals: "direct" } },
  { key: "aiGenerated", label: "AI-generated content (video)", type: "checkbox", default: false, showIf: { key: "postMode", equals: "direct" } },
  { key: "autoAddMusic", label: "Auto add music (photos)", type: "checkbox", default: false, showIf: { key: "postMode", equals: "direct" } },
  {
    key: "commercialContent",
    label: "Disclose commercial content",
    type: "checkbox",
    default: false,
    help: "Turn on if this post promotes yourself, a third party, or both.",
  },
  {
    key: "brandOrganic",
    label: "Your brand",
    type: "checkbox",
    default: false,
    help: "You are promoting yourself or your own business. The post will be labeled \"Promotional content\".",
    showIf: { key: "commercialContent", equals: true },
  },
  {
    key: "brandContent",
    label: "Branded content",
    type: "checkbox",
    default: false,
    help: "You are promoting another brand or a third party. The post will be labeled \"Paid partnership\" and cannot be private.",
    showIf: { key: "commercialContent", equals: true },
  },
];
