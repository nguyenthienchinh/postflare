import type { FieldOption } from "../../shared/types";
import { fetchesLeft } from "./budget";
import { missingScope, ProviderError } from "./errors";
import { clientFields, expiresAt, oauthToken, requestJson, requireApp, type RequestOptions } from "./http";
import { postFormStreaming } from "./s3-form-upload";
import type { AccountRecord, MediaItem, MetricValues, MetricsItem, PostMetricsResult, Provider, ProviderContext, PublishResult } from "./types";

const SCOPES = ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"];
/** Pin and account analytics need both read scopes (already part of SCOPES). */
const METRICS_SCOPES = ["pins:read", "user_accounts:read"];
/** Pin analytics has no batch endpoint: one request per pin, so keep the batch small. */
const METRICS_BATCH = 10;
/** Pin analytics only go back 90 days (start_date within the last 90 days). */
const ANALYTICS_DAYS = 90;
const DAY = 86_400_000;
const PIN_METRICS = ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK", "TOTAL_COMMENTS", "TOTAL_REACTIONS"];

/** Trial-access apps can only write to the sandbox API. */
const apiBase = (ctx: ProviderContext) =>
  ctx.app.sandbox === "true" || ctx.app.sandbox === "1" ? "https://api-sandbox.pinterest.com/v5" : "https://api.pinterest.com/v5";

const pin = <T = any>(ctx: ProviderContext, account: AccountRecord, path: string, opts: RequestOptions = {}) =>
  requestJson<T>(ctx, `${apiBase(ctx)}${path}`, { ...opts, token: account.credentials.accessToken as string });

const basic = (ctx: ProviderContext) => {
  const app = requireApp(ctx, "Pinterest", "clientId", "clientSecret");
  return { id: app.clientId, secret: app.clientSecret };
};

interface PinDraft {
  board_id: string;
  board_section_id?: string;
  title?: string;
  description?: string;
  link?: string;
  alt_text?: string;
  dominant_color?: string;
  media_source: Record<string, unknown>;
}

async function createPin(ctx: ProviderContext, account: AccountRecord, draft: PinDraft): Promise<PublishResult> {
  const res = await pin<{ id: string }>(ctx, account, "/pins", { method: "POST", json: draft, commit: true });
  return { status: "published", externalId: res.id, url: `https://www.pinterest.com/pin/${res.id}/` };
}

/** Register a video, then stream it to the presigned S3 form Pinterest returns. */
async function uploadVideo(ctx: ProviderContext, account: AccountRecord, item: MediaItem): Promise<string> {
  const reg = await pin<{ media_id: string; upload_url: string; upload_parameters: Record<string, string> }>(ctx, account, "/media", {
    method: "POST",
    json: { media_type: "video" },
  });
  await postFormStreaming(ctx, reg.upload_url, Object.entries(reg.upload_parameters ?? {}), {
    field: "file",
    filename: item.filename,
    type: item.mime,
    size: item.size,
    stream: await ctx.media.stream(item),
  });
  return reg.media_id;
}

async function listAll<T>(ctx: ProviderContext, account: AccountRecord, path: string): Promise<T[]> {
  const items: T[] = [];
  let bookmark: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await pin<{ items: T[]; bookmark?: string | null }>(ctx, account, path, { query: { page_size: 250, bookmark } });
    items.push(...(res.items ?? []));
    if (!res.bookmark) break;
    bookmark = res.bookmark;
  }
  return items;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
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

/** A 403 that names a scope = the token predates the analytics scopes: analytics-only reconnect signal. */
function scopeError(err: unknown) {
  return err instanceof ProviderError && err.status === 403 && /scope/i.test(`${err.message} ${JSON.stringify(err.body ?? "")}`);
}

/**
 * Totals of one pin since it was published (clamped to the 90 days the API allows): summary_metrics of the range,
 * else the sum of its daily metrics. null when the pin is gone (404) or has no analytics (other 403s).
 */
async function pinMetrics(ctx: ProviderContext, account: AccountRecord, item: MetricsItem): Promise<MetricValues | null> {
  const now = Date.now();
  const start = Math.min(now, Math.max(item.publishedAt || now, now - (ANALYTICS_DAYS - 1) * DAY));
  let res: Record<string, { summary_metrics?: Record<string, number>; daily_metrics?: Array<{ data_status?: string; metrics?: Record<string, number> }> }>;
  try {
    res = await pin(ctx, account, `/pins/${encodeURIComponent(item.externalId)}/analytics`, {
      query: { start_date: day(start), end_date: day(now), metric_types: PIN_METRICS.join(",") },
    });
  } catch (err) {
    if (scopeError(err)) throw missingScope("Pinterest", METRICS_SCOPES);
    if (err instanceof ProviderError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
  const data = res?.all ?? res?.ALL ?? Object.values(res ?? {})[0];
  if (!data) return null;
  let t = data.summary_metrics;
  if (!t) {
    t = {};
    for (const d of data.daily_metrics ?? []) {
      if (d.data_status && d.data_status !== "READY") continue;
      for (const [k, v] of Object.entries(d.metrics ?? {})) if (typeof v === "number") t[k] = (t[k] ?? 0) + v;
    }
  }
  const pinClicks = num(t.PIN_CLICK);
  const outbound = num(t.OUTBOUND_CLICK);
  return compact({
    impressions: num(t.IMPRESSION),
    saves: num(t.SAVE),
    clicks: pinClicks === undefined && outbound === undefined ? undefined : (pinClicks ?? 0) + (outbound ?? 0),
    likes: num(t.TOTAL_REACTIONS),
    comments: num(t.TOTAL_COMMENTS),
    extra: { outbound_clicks: outbound, pin_clicks: pinClicks } as Record<string, number>,
  });
}

export const pinterest: Provider = {
  id: "pinterest",
  name: "Pinterest",
  color: "BD081C",
  icon: "pinterest",
  category: "social",
  auth: "oauth2",
  appFields: [
    ...clientFields("App ID", "App secret key"),
    {
      key: "sandbox",
      label: "Use sandbox API",
      type: "checkbox",
      default: false,
      help: "Apps with Trial access can only create pins in the sandbox (api-sandbox.pinterest.com).",
    },
  ],
  docsUrl: "https://developers.pinterest.com/apps/",
  setupNotes: [
    "1. Create an app at [Pinterest Developers](https://developers.pinterest.com/apps/) (requires a Pinterest business account).",
    "2. Add the redirect URI `{{redirectUri}}`.",
    `3. Request access to the scopes \`${SCOPES.join(",")}\` (Trial access works with the sandbox API; Standard access for real pins).`,
    "4. Copy the App ID and App secret key here.",
    "Analytics (pin impressions, saves, clicks; followers) use `pins:read` and `user_accounts:read`. Pin analytics cover the last 90 days.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: [
    { key: "board", label: "Board", type: "select", required: true, dynamicOptions: true },
    { key: "boardSection", label: "Board section", type: "select", dynamicOptions: true, help: "Optional; depends on the board." },
    { key: "title", label: "Title", type: "text", maxLength: 100 },
    { key: "link", label: "Destination link", type: "url", placeholder: "https://..." },
    { key: "altText", label: "Alt text", type: "textarea", maxLength: 500, help: "Defaults to the alt text of the first image." },
    { key: "dominantColor", label: "Dominant color", type: "text", placeholder: "#6E7874" },
  ],
  capabilities: {
    maxLength: 500,
    text: "optional",
    // A video pin may include one image, used as its cover.
    media: { images: 5, videos: 1, mixed: true, required: true },
    thread: false,
  },

  metrics: {
    post: ["impressions", "saves", "clicks", "likes", "comments"],
    account: ["followers", "following", "posts"],
    batch: METRICS_BATCH,
    scopes: METRICS_SCOPES,
  },

  authorize(ctx, { state }) {
    const app = requireApp(ctx, "Pinterest", "clientId", "clientSecret");
    const u = new URL("https://www.pinterest.com/oauth/");
    u.search = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: ctx.redirectUri,
      response_type: "code",
      scope: SCOPES.join(","),
      state,
    }).toString();
    return u.toString();
  },

  async callback(ctx, { code }) {
    const tok = await oauthToken(
      ctx,
      `${apiBase(ctx)}/oauth/token`,
      { grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri, continuous_refresh: "true" },
      { basicAuth: basic(ctx) },
    );
    const me = await requestJson<{ id?: string; username: string; profile_image?: string; business_name?: string }>(
      ctx,
      `${apiBase(ctx)}/user_account`,
      { token: tok.access_token },
    );
    return [
      {
        externalId: me.id || me.username,
        name: me.business_name || me.username,
        username: me.username,
        avatarUrl: me.profile_image ?? null,
        profileUrl: `https://www.pinterest.com/${me.username}/`,
        credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
        expiresAt: expiresAt(tok.expires_in),
        refreshExpiresAt: expiresAt(tok.refresh_token_expires_in),
      },
    ];
  },

  async refresh(ctx, account) {
    if (!account.credentials.refreshToken) throw new ProviderError("No refresh token: reconnect the Pinterest account", "auth");
    const tok = await oauthToken(
      ctx,
      `${apiBase(ctx)}/oauth/token`,
      { grant_type: "refresh_token", refresh_token: account.credentials.refreshToken },
      { basicAuth: basic(ctx) },
    );
    return {
      credentials: { ...account.credentials, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? account.credentials.refreshToken },
      expiresAt: expiresAt(tok.expires_in),
      // Continuous refresh issues a new refresh token (and expiry) on every refresh.
      ...(tok.refresh_token_expires_in ? { refreshExpiresAt: expiresAt(tok.refresh_token_expires_in) } : {}),
    };
  },

  async options(ctx, account, key, settings): Promise<FieldOption[]> {
    if (key === "board") {
      const boards = await listAll<{ id: string; name: string; privacy?: string }>(ctx, account, "/boards");
      return boards.map((b) => ({ value: b.id, label: b.privacy === "SECRET" ? `${b.name} (secret)` : b.name }));
    }
    if (key === "boardSection" && settings.board) {
      const sections = await listAll<{ id: string; name: string }>(ctx, account, `/boards/${encodeURIComponent(String(settings.board))}/sections`);
      return sections.map((s) => ({ value: s.id, label: s.name }));
    }
    return [];
  },

  validate(post) {
    const errors: string[] = [];
    const videos = post.media.filter((m) => m.kind === "video");
    const images = post.media.filter((m) => m.kind === "image");
    if (videos.length && images.length > 1) errors.push("Pinterest: a video pin can only include one image (its cover)");
    if (!videos.length && images.length > 1) {
      const sized = images.filter((i) => i.width && i.height);
      if (sized.length === images.length && sized.some((i) => i.width !== sized[0].width || i.height !== sized[0].height))
        errors.push("Pinterest: carousel images must all have the same dimensions");
    }
    if (!post.settings.board) errors.push('Pinterest: "Board" is required');
    if (post.settings.dominantColor && !/^#?[0-9a-f]{6}$/i.test(String(post.settings.dominantColor)))
      errors.push("Pinterest: dominant color must be a hex color like #6E7874");
    return errors;
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    if (!s.board) throw new ProviderError("Pinterest: choose a board", "invalid");
    const video = post.media.find((m) => m.kind === "video");
    const images = post.media.filter((m) => m.kind === "image");
    const color = s.dominantColor ? `#${String(s.dominantColor).replace(/^#/, "")}` : undefined;
    const draft: PinDraft = {
      board_id: String(s.board),
      board_section_id: s.boardSection ? String(s.boardSection) : undefined,
      title: s.title || undefined,
      description: post.content || undefined,
      link: s.link || undefined,
      alt_text: (s.altText || images[0]?.alt || undefined)?.slice(0, 500),
      dominant_color: color,
      media_source: {},
    };

    if (video) {
      const mediaId = await uploadVideo(ctx, account, video);
      draft.media_source = images[0]
        ? { source_type: "video_id", media_id: mediaId, cover_image_url: images[0].url }
        : { source_type: "video_id", media_id: mediaId, cover_image_key_frame_time: 0 };
      return { status: "pending", state: { mediaId, draft }, retryAfterSeconds: 15 };
    }
    draft.media_source =
      images.length === 1
        ? { source_type: "image_url", url: images[0].url }
        : { source_type: "multiple_image_urls", items: images.map((i) => ({ url: i.url })) };
    return createPin(ctx, account, draft);
  },

  async checkStatus(ctx, account, state) {
    const media = await pin<{ status: string }>(ctx, account, `/media/${encodeURIComponent(String(state.mediaId))}`);
    if (media.status === "failed") throw new ProviderError("Pinterest could not process the video", "invalid");
    if (media.status !== "succeeded") return { status: "pending", state, retryAfterSeconds: 15 };
    return createPin(ctx, account, state.draft as PinDraft);
  },

  /** One analytics request per pin (no batch endpoint), within the call's fetch budget; the rest stay due. */
  async postMetrics(ctx, account, items) {
    const todo = items.slice(0, Math.max(0, Math.min(METRICS_BATCH, fetchesLeft(ctx))));
    const results = await Promise.all(todo.map((item) => pinMetrics(ctx, account, item)));
    const out: PostMetricsResult = {};
    todo.forEach((item, i) => (out[item.externalId] = results[i]));
    return out;
  },

  /** Followers, following and pin count of the connected account (+ monthly views). */
  async accountMetrics(ctx, account) {
    let me: Record<string, unknown>;
    try {
      me = await pin(ctx, account, "/user_account");
    } catch (err) {
      if (scopeError(err)) throw missingScope("Pinterest", "user_accounts:read");
      throw err;
    }
    return compact({
      followers: num(me.follower_count),
      following: num(me.following_count),
      posts: num(me.pin_count),
      extra: { monthly_views: num(me.monthly_views) } as Record<string, number>,
    });
  },
};
