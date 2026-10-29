import { fetchesLeft } from "./budget";
import { MetricsUnavailableError, missingScope, ProviderError } from "./errors";
import { googleAppFields, googleAuthorizeUrl, googleClassify, googleDocsUrl, googleExchangeCode, googleReasons, googleRefresh } from "./google-shared";
import { request, requestJson } from "./http";
import { mediaBody } from "./multipart";
import type { FieldOption } from "../../shared/types";
import type { MediaItem, MetricDetails, MetricsItem, MetricValues, PostMetricsResult, Provider, ProviderContext, PublishPost, PublishResult } from "./types";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";
const NAME = "YouTube";
const DAY = 24 * 60 * 60 * 1000;

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  // commentThreads.insert (first comment)
  "https://www.googleapis.com/auth/youtube.force-ssl",
  // videos.list / channels.list statistics (analytics); also required by YouTube Analytics reports.query
  "https://www.googleapis.com/auth/youtube.readonly",
  // YouTube Analytics API: watch time, retention, traffic sources
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

/** videos.list accepts at most 50 ids per request. */
const METRICS_BATCH = 50;
const READONLY_SCOPE = "youtube.readonly";
const ANALYTICS_SCOPE = "yt-analytics.readonly";
/** YouTube Analytics data lags 1-3 days: only snapshots this long after publishing ask for it. */
const ANALYTICS_AFTER = DAY;
/**
 * Retention curve + traffic sources (one request per video for the curve) only for snapshots in this age window:
 * the 7d and 30d checkpoints (and manual refreshes in between). Later snapshots keep the earlier details visible
 * (PostMetricsDTO.details is the latest snapshot that has them).
 */
const DETAILS_FROM = 7 * DAY;
const DETAILS_UNTIL = 37 * DAY;
/** At most this many retention requests per postMetrics call (the cron collects ≤ 10 posts per tick anyway). */
const MAX_RETENTION = 10;
/** Captions are kept in the post settings and the workflow state (≤ 1 MiB per step): ~3 hours of SRT. */
export const MAX_CAPTIONS = 200_000;
/** Pages of playlists.list (50 each) searched for a playlist with the new playlist's title. */
const PLAYLIST_PAGES = 3;
/** Google reasons of a token that lacks the analytics scope (403). */
const SCOPE_REASONS = ["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"];

/**
 * Resumable upload chunks must be multiples of 256 KiB (except the last one; Google recommends multiples of 8 MiB).
 * Each chunk is one PUT streamed straight from R2 (no copy through JS). 32 MiB keeps a failed or slow PUT cheap to
 * redo and well inside the request timeout; a 2GB video is 64 PUTs, i.e. 3 calls of STEP_PUTS.
 */
const CHUNK = 32 * 1024 * 1024;
/** Per call (workflow step): at most this many PUTs / this much time, then continue in checkStatus. */
const STEP_PUTS = 24;
const STEP_MS = 2 * 60 * 1000;

interface UploadState {
  [key: string]: unknown;
  uploadUrl: string;
  video: MediaItem;
  thumbnail: MediaItem | null;
  playlistId: string | null;
  /** Playlist to find by title or create (absent in states of older releases). */
  newPlaylist?: { title: string; privacy: string } | null;
  /** Caption track to insert after the upload (SRT / WebVTT text). */
  captions?: { text: string; language: string; name: string } | null;
}

/** Common BCP-47 codes for the language selects (YouTube accepts any BCP-47 tag through the API). */
const LANGUAGES: Array<[string, string]> = [
  ["en", "English"],
  ["en-US", "English (United States)"],
  ["en-GB", "English (United Kingdom)"],
  ["tr", "Turkish"],
  ["de", "German"],
  ["es", "Spanish"],
  ["es-419", "Spanish (Latin America)"],
  ["fr", "French"],
  ["pt", "Portuguese"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["sv", "Swedish"],
  ["uk", "Ukrainian"],
  ["ru", "Russian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["vi", "Vietnamese"],
  ["th", "Thai"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh-Hans", "Chinese (Simplified)"],
  ["zh-Hant", "Chinese (Traditional)"],
];
const languageOptions = (empty: string): FieldOption[] => [{ value: "", label: empty }, ...LANGUAGES.map(([value, label]) => ({ value, label: `${label} (${value})` }))];
const BCP47 = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

export const THUMBNAIL_NOTE =
  "Add an image next to the video to use it as the custom thumbnail (JPEG/PNG, 16:9 e.g. 1280×720, ≤2 MB; larger or other formats are re-encoded to JPEG). Custom thumbnails need a verified channel.";

const reasonMessages: Record<string, string> = {
  invalidTitle: "The title is invalid or too long (max 100 characters).",
  invalidDescription: "The description is invalid: it may contain < or >, or be longer than 5000 characters.",
  invalidTags: "The tags are invalid: at most 500 characters in total.",
  invalidCategoryId: "The selected video category is invalid.",
  invalidPublishAt: "The scheduled publishing time is invalid (it must be in the future and the video private).",
  uploadLimitExceeded: "The channel reached its daily YouTube upload limit, try again tomorrow.",
  quotaExceeded: "The YouTube API daily quota of this Google Cloud project is exhausted, try again tomorrow.",
  youtubeSignupRequired: "This Google account has no YouTube channel yet: create one first.",
  forbidden: "YouTube refused the request (forbidden: e.g. custom thumbnails need a verified channel, comments need a public video with comments on).",
};

const classify = googleClassify;

/** Wrap a request so known YouTube reasons produce a readable message. */
async function yt<T = any>(ctx: ProviderContext, url: string, opts: Parameters<typeof requestJson>[2] = {}): Promise<T> {
  try {
    return await requestJson<T>(ctx, url, { classify, ...opts });
  } catch (err) {
    throw readable(err);
  }
}

function readable(err: unknown): unknown {
  if (!(err instanceof ProviderError)) return err;
  const reason = googleReasons(err.body).find((r) => reasonMessages[r]);
  if (reason) return new ProviderError(`YouTube: ${reasonMessages[reason]}`, err.kind, err.status, err.body);
  return err;
}

/**
 * GET for analytics. A token without the read scope (accounts connected before analytics) is a
 * reconnect_required signal for analytics only, never ProviderError("auth") (which would stop publishing).
 */
async function ytRead<T = any>(ctx: ProviderContext, token: string, path: string, query: Record<string, string | number | boolean>): Promise<T> {
  try {
    return await requestJson<T>(ctx, `${API}${path}`, { token, query, classify });
  } catch (err) {
    if (err instanceof ProviderError && err.status !== 401 && googleReasons(err.body).some((r) => SCOPE_REASONS.includes(r)))
      throw missingScope(NAME, READONLY_SCOPE);
    throw readable(err);
  }
}

/** YouTube statistics are decimal strings ("123"); missing/invalid → undefined (not reported). */
function count(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Drop undefined keys (and an empty `extra`): only reported numbers are set. */
function compact(m: MetricValues): MetricValues {
  const out: MetricValues = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "extra") {
      const extra = Object.fromEntries(Object.entries(v as Record<string, number | undefined>).filter(([, x]) => x !== undefined)) as Record<string, number>;
      if (Object.keys(extra).length) out.extra = extra;
    } else if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}

const bool = (v: unknown, dflt: boolean) => (v === undefined || v === null || v === "" ? dflt : v === true || v === "true" || v === "yes" || v === 1);

function toIso(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function tagsOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list.map((t) => String(typeof t === "object" && t ? ((t as any).label ?? (t as any).value) : t).trim()).filter(Boolean);
}

/**
 * `localizations` setting: one translation per line, `lang | title | description` (description optional, `\n` for
 * a line break). Lines starting with # are ignored.
 */
export function parseLocalizations(v: unknown): { items: Array<{ lang: string; title: string; description: string }>; errors: string[] } {
  const items: Array<{ lang: string; title: string; description: string }> = [];
  const errors: string[] = [];
  if (typeof v !== "string") return { items, errors };
  const seen = new Set<string>();
  v.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const [lang = "", title = "", ...rest] = line.split("|").map((x) => x.trim());
    const description = rest.join(" | ").replace(/\\n/g, "\n");
    const at = `YouTube translations line ${i + 1}`;
    if (!BCP47.test(lang)) return void errors.push(`${at}: "${lang}" is not a language code (e.g. de, pt-BR)`);
    if (!title) return void errors.push(`${at}: a title is required ("lang | title | description")`);
    if (seen.has(lang.toLowerCase())) return void errors.push(`${at}: ${lang} appears twice`);
    if (Array.from(title).length > 100) errors.push(`${at}: the title is longer than 100 characters`);
    if (Array.from(description).length > 5000) errors.push(`${at}: the description is longer than 5000 characters`);
    if (/[<>]/.test(title + description)) errors.push(`${at}: titles and descriptions cannot contain < or >`);
    seen.add(lang.toLowerCase());
    items.push({ lang, title, description });
  });
  return { items, errors };
}

/** "srt" / "vtt" when the text looks like SubRip or WebVTT, else null. */
export function captionFormat(text: string): "srt" | "vtt" | null {
  const t = text.replace(/^\uFEFF/, "").trimStart();
  if (/^WEBVTT(\s|$)/.test(t)) return "vtt";
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(t)) return "srt";
  return null;
}

/** Caption track of a post (language: captionsLanguage, else the audio language, else the video language). */
function captionsOf(s: Record<string, any>): UploadState["captions"] {
  const text = typeof s.captions === "string" ? s.captions.replace(/^\uFEFF/, "") : "";
  if (!text.trim()) return null;
  const language = String(s.captionsLanguage || s.audioLanguage || s.language || "");
  return { text, language, name: String(s.captionsName ?? "").trim() || "Subtitles" };
}

function newPlaylistOf(s: Record<string, any>, status: { privacyStatus: string; publishAt?: string }): UploadState["newPlaylist"] {
  const title = String(s.newPlaylist ?? "").trim();
  if (!title) return null;
  const chosen = ["public", "unlisted", "private"].includes(s.newPlaylistPrivacy) ? s.newPlaylistPrivacy : null;
  // "Same as the video": a scheduled video ends up public.
  return { title, privacy: chosen ?? (status.publishAt ? "public" : status.privacyStatus) };
}

/** Metadata of the videos.insert call. */
export function videoResource(post: PublishPost) {
  const s = post.settings;
  let title = String(s.title ?? "").trim();
  if (bool(s.shorts, false) && !/#shorts/i.test(title) && !/#shorts/i.test(post.content)) {
    title = title.length + 8 <= 100 ? `${title} #Shorts` : title;
  }
  const publishAt = toIso(s.publishAt);
  const privacy = publishAt ? "private" : ["public", "unlisted", "private"].includes(s.privacy) ? s.privacy : "private";
  const tags = tagsOf(s.tags);
  const localizations = parseLocalizations(s.localizations).items;
  return {
    snippet: {
      title,
      description: post.content,
      ...(tags.length ? { tags } : {}),
      categoryId: String(s.category || "22"),
      // `language` alone sets both (the behavior before `audioLanguage` existed).
      ...(s.language ? { defaultLanguage: String(s.language) } : {}),
      ...(s.audioLanguage || s.language ? { defaultAudioLanguage: String(s.audioLanguage || s.language) } : {}),
    },
    ...(localizations.length ? { localizations: Object.fromEntries(localizations.map((l) => [l.lang, { title: l.title, ...(l.description ? { description: l.description } : {}) }])) } : {}),
    status: {
      privacyStatus: privacy,
      ...(publishAt ? { publishAt } : {}),
      selfDeclaredMadeForKids: bool(s.madeForKids, false),
      embeddable: bool(s.embeddable, true),
      license: s.license === "creativeCommon" ? "creativeCommon" : "youtube",
      containsSyntheticMedia: bool(s.syntheticMedia, false),
    },
  };
}

/**
 * Send one PUT to the resumable session. Returns the next offset, or the created video.
 *
 * Not a `commit: true` request: one resumable session creates at most one video, so a PUT whose answer was lost is
 * retried safely: the next call probes the same session, which answers 308 (bytes still missing) or 200/201 with
 * the video it already created. Only a new session (a new `publish`) could duplicate the video, and checkStatus
 * never opens one. (docs/provider-brief.md "Commit semantics")
 */
async function putSession(
  ctx: ProviderContext,
  token: string,
  uploadUrl: string,
  headers: Record<string, string>,
  body: ReadableStream | null,
): Promise<{ offset: number } | { videoId: string }> {
  let res: Response;
  try {
    res = await ctx.fetch(uploadUrl, {
      method: "PUT",
      // 308 "Resume Incomplete" must not be treated as a redirect.
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
      // Required by Node/undici for stream bodies; ignored by Workers.
      ...(body ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (err) {
    throw new ProviderError(`Network error uploading to YouTube: ${(err as Error).message}`, "transient");
  }
  if (res.status === 308) {
    const range = res.headers.get("range");
    const m = range?.match(/bytes=\d+-(\d+)/);
    return { offset: m ? Number(m[1]) + 1 : 0 };
  }
  if (res.status === 200 || res.status === 201) {
    // The session created the video: from here on a failure must never lead to a new upload.
    if (ctx.commit) ctx.commit.sent = ctx.commit.accepted = true;
    const video = await res.json<{ id: string }>();
    return { videoId: video.id };
  }
  const text = await res.text().catch(() => "");
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (res.status === 404 || res.status === 410)
    throw new ProviderError("YouTube upload session expired before the video was uploaded; publish the post again", "invalid", res.status, parsed);
  const kind = classify(res.status, parsed) ?? (res.status >= 500 ? "transient" : "invalid");
  throw readable(new ProviderError(`YouTube upload failed (${res.status}): ${parsed?.error?.message ?? text.slice(0, 300)}`, kind, res.status, parsed));
}

/** Ask the session how many bytes it has (`Content-Range: bytes * /total`). */
function probe(ctx: ProviderContext, token: string, state: UploadState) {
  return putSession(ctx, token, state.uploadUrl, { "content-range": `bytes */${state.video.size}` }, null);
}

/**
 * Upload chunks from `offset` until done or the step budget is used.
 * Returns the video id when YouTube created the video, otherwise the next offset.
 */
async function uploadChunks(
  ctx: ProviderContext,
  token: string,
  state: UploadState,
  offset: number,
): Promise<{ offset: number } | { videoId: string }> {
  const total = state.video.size;
  const started = Date.now();
  let puts = 0;
  while (offset < total) {
    if (puts >= STEP_PUTS || Date.now() - started > STEP_MS) return { offset };
    const length = Math.min(CHUNK, total - offset);
    const r = await putSession(
      ctx,
      token,
      state.uploadUrl,
      {
        "content-type": state.video.mime || "video/mp4",
        "content-range": `bytes ${offset}-${offset + length - 1}/${total}`,
      },
      await ctx.media.rangeStream(state.video, offset, length),
    );
    if ("videoId" in r) return r;
    puts++;
    // Always trust the server's offset: it may have kept fewer bytes than we sent.
    offset = r.offset;
  }
  // Every byte acknowledged without a final 200: ask the session for the result.
  return probe(ctx, token, state);
}

/** captions.insert: a multipart/related upload (JSON metadata + the caption text; small, so built in memory). */
async function insertCaptions(ctx: ProviderContext, token: string, videoId: string, c: NonNullable<UploadState["captions"]>) {
  const boundary = `pf${crypto.randomUUID().replace(/-/g, "")}`;
  const meta = JSON.stringify({ snippet: { videoId, language: c.language, name: c.name, isDraft: false } });
  const body =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n${c.text}\r\n--${boundary}--\r\n`;
  await yt(ctx, `${UPLOAD_API}/captions`, {
    method: "POST",
    token,
    query: { uploadType: "multipart", part: "snippet" },
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

/** The playlist titled `title` (first PLAYLIST_PAGES pages of the channel's playlists), else a new one. */
async function findOrCreatePlaylist(ctx: ProviderContext, token: string, p: NonNullable<UploadState["newPlaylist"]>): Promise<string> {
  const want = p.title.trim().toLowerCase();
  let pageToken: string | undefined;
  for (let page = 0; page < PLAYLIST_PAGES; page++) {
    const res: { items?: any[]; nextPageToken?: string } = await yt(ctx, `${API}/playlists`, {
      token,
      query: { part: "snippet", mine: true, maxResults: 50, pageToken },
    });
    const hit = (res.items ?? []).find((x) => String(x.snippet?.title ?? "").trim().toLowerCase() === want);
    if (hit) return String(hit.id);
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  const created = await yt<{ id: string }>(ctx, `${API}/playlists`, {
    method: "POST",
    token,
    query: { part: "snippet,status" },
    json: { snippet: { title: p.title.trim() }, status: { privacyStatus: p.privacy } },
  });
  ctx.log("info", `YouTube: created the playlist "${p.title.trim()}" (${p.privacy})`);
  return created.id;
}

/**
 * Thumbnail, captions and playlists after the upload. Failures only warn: the video is already live.
 * At most 8 requests (thumbnail, captions, 3 playlist pages + insert, 2 playlist items): fits next to the upload PUTs.
 */
async function finish(ctx: ProviderContext, token: string, state: UploadState, videoId: string): Promise<PublishResult> {
  if (state.thumbnail) {
    try {
      const t = state.thumbnail;
      // Small JPEG/PNG: streamed from R2 as is; anything else is re-encoded (a small in-memory Blob).
      const raw = t.size <= 2_000_000 && (t.mime === "image/jpeg" || t.mime === "image/png");
      const body = raw ? await mediaBody(ctx, t) : await ctx.media.image(t, { maxWidth: 1280, maxHeight: 1280, format: "image/jpeg", quality: 85 });
      await yt(ctx, `${UPLOAD_API}/thumbnails/set`, {
        method: "POST",
        token,
        query: { videoId, uploadType: "media" },
        headers: { "content-type": raw ? t.mime : "image/jpeg" },
        body,
        duplex: "half",
      } as Parameters<typeof yt>[2]);
    } catch (err) {
      ctx.log("warn", `YouTube: video uploaded but the custom thumbnail failed (custom thumbnails need a verified channel): ${(err as Error).message}`);
    }
  }
  if (state.captions) {
    try {
      await insertCaptions(ctx, token, videoId, state.captions);
    } catch (err) {
      ctx.log("warn", `YouTube: video uploaded but the captions (${state.captions.language}) failed: ${(err as Error).message}`);
    }
  }
  const playlists = state.playlistId ? [state.playlistId] : [];
  if (state.newPlaylist) {
    try {
      const id = await findOrCreatePlaylist(ctx, token, state.newPlaylist);
      if (!playlists.includes(id)) playlists.push(id);
    } catch (err) {
      ctx.log("warn", `YouTube: video uploaded but creating the playlist "${state.newPlaylist.title}" failed: ${(err as Error).message}`);
    }
  }
  for (const playlistId of playlists) {
    try {
      await yt(ctx, `${API}/playlistItems`, {
        method: "POST",
        token,
        query: { part: "snippet" },
        json: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
      });
    } catch (err) {
      ctx.log("warn", `YouTube: video uploaded but adding it to the playlist failed: ${(err as Error).message}`);
    }
  }
  return { status: "published", externalId: videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

/** Upload as far as the budget allows; transient failures become "pending" so checkStatus resumes the same session. */
async function advance(ctx: ProviderContext, token: string, state: UploadState, offset: number | null): Promise<PublishResult> {
  try {
    const r = offset === null ? await probe(ctx, token, state) : { offset };
    const done = "videoId" in r ? r : await uploadChunks(ctx, token, state, r.offset);
    if ("videoId" in done) return finish(ctx, token, state, done.videoId);
    ctx.log("info", `YouTube: uploaded ${Math.round((done.offset / state.video.size) * 100)}% of ${state.video.filename}`);
    return { status: "pending", state, retryAfterSeconds: 5 };
  } catch (err) {
    if (err instanceof ProviderError && err.retryable) {
      ctx.log("warn", `YouTube upload interrupted, will resume: ${err.message}`);
      return { status: "pending", state, retryAfterSeconds: 30 };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// YouTube Analytics API (reports.query). Missing data (the 1-3 day lag, tiny videos) leaves keys out; failures other
// than a missing scope only warn: the Data API numbers are still stored.

interface Report {
  columnHeaders?: Array<{ name: string }>;
  rows?: unknown[][];
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** reports.query. A token without yt-analytics.readonly → reconnect_required (analytics only, never publishing). */
async function analyticsReport(ctx: ProviderContext, token: string, account: { meta: Record<string, unknown> }, query: Record<string, string | number>): Promise<Report> {
  const channel = account.meta.channelId ? `channel==${account.meta.channelId}` : "channel==MINE";
  try {
    return await requestJson<Report>(ctx, ANALYTICS_API, { token, query: { ids: channel, ...query }, classify });
  } catch (err) {
    if (err instanceof ProviderError && err.status !== 401 && googleReasons(err.body).some((r) => SCOPE_REASONS.includes(r)))
      throw missingScope(NAME, ANALYTICS_SCOPE);
    throw readable(err);
  }
}

/** Rows as objects keyed by column name. */
function rowsOf(r: Report): Array<Record<string, unknown>> {
  const names = (r.columnHeaders ?? []).map((h) => h.name);
  return (r.rows ?? []).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

const round = (v: unknown, digits: number) => {
  const n = count(v);
  return n === undefined ? undefined : Math.round(n * 10 ** digits) / 10 ** digits;
};

/** Filter + dimensions for a set of videos: `video` is only a dimension when several ids are filtered. */
function videoQuery(ids: string[], dims: string[] = []): Record<string, string> {
  const dimensions = ids.length > 1 ? ["video", ...dims] : dims;
  return { filters: `video==${ids.join(",")}`, ...(dimensions.length ? { dimensions: dimensions.join(",") } : {}) };
}

async function addAnalytics(ctx: ProviderContext, token: string, account: { meta: Record<string, unknown> }, items: MetricsItem[], out: PostMetricsResult) {
  const t = Date.now();
  const due = items.filter((i) => t - i.publishedAt >= ANALYTICS_AFTER);
  if (!due.length || fetchesLeft(ctx) < 1) return;
  // Analytics dates are in the channel's time zone (Pacific): start a day early.
  const range = (list: MetricsItem[]) => ({ startDate: ymd(Math.min(...list.map((i) => i.publishedAt)) - DAY), endDate: ymd(t) });
  const videoOf = (row: Record<string, unknown>, ids: string[]) => String(row.video ?? (ids.length === 1 ? ids[0] : ""));
  const merge = (id: string, m: MetricValues) => {
    const cur = out[id];
    if (!cur) return;
    const { extra, details, ...rest } = m;
    Object.assign(cur, compact(rest));
    if (extra) {
      const e = compact({ extra }).extra;
      if (e) cur.extra = { ...cur.extra, ...e };
    }
    if (details) cur.details = { ...cur.details, ...details };
  };
  try {
    const ids = due.map((i) => i.externalId);
    const basic = await analyticsReport(ctx, token, account, {
      ...range(due),
      metrics: "estimatedMinutesWatched,averageViewDuration,averageViewPercentage,shares,subscribersGained",
      ...videoQuery(ids),
      ...(ids.length > 1 ? { sort: "-estimatedMinutesWatched", maxResults: ids.length } : {}),
    });
    for (const row of rowsOf(basic)) {
      merge(videoOf(row, ids), {
        watchTimeMinutes: round(row.estimatedMinutesWatched, 0),
        avgViewDurationSeconds: round(row.averageViewDuration, 1),
        avgViewPercentage: round(row.averageViewPercentage, 2),
        shares: count(row.shares),
        extra: { subscribers_gained: count(row.subscribersGained) } as Record<string, number>,
      });
    }

    const detailed = due.filter((i) => t - i.publishedAt >= DETAILS_FROM && t - i.publishedAt < DETAILS_UNTIL);
    if (!detailed.length || fetchesLeft(ctx) < 1) return;
    const dIds = detailed.map((i) => i.externalId);
    const traffic = await analyticsReport(ctx, token, account, { ...range(detailed), metrics: "views", ...videoQuery(dIds, ["insightTrafficSourceType"]) });
    const sources = new Map<string, Array<{ source: string; views: number }>>();
    for (const row of rowsOf(traffic)) {
      const id = videoOf(row, dIds);
      const views = count(row.views);
      if (!views || !row.insightTrafficSourceType) continue;
      const list = sources.get(id) ?? [];
      list.push({ source: String(row.insightTrafficSourceType), views });
      sources.set(id, list);
    }
    for (const [id, list] of sources) merge(id, { details: { trafficSources: list.sort((a, b) => b.views - a.views) } });

    for (const item of detailed.slice(0, MAX_RETENTION)) {
      if (fetchesLeft(ctx) < 1) break;
      const r = await analyticsReport(ctx, token, account, {
        ...range([item]),
        metrics: "audienceWatchRatio",
        dimensions: "elapsedVideoTimeRatio",
        filters: `video==${item.externalId}`,
        sort: "elapsedVideoTimeRatio",
      });
      const retention: MetricDetails["retention"] = [];
      for (const row of rowsOf(r)) {
        const x = count(row.elapsedVideoTimeRatio);
        const y = round(row.audienceWatchRatio, 4);
        if (x !== undefined && y !== undefined) retention.push([x, y]);
      }
      if (retention.length) merge(item.externalId, { details: { retention } });
    }
  } catch (err) {
    // Channels connected before yt-analytics.readonly existed: keep collecting views/likes/comments, and say how to get
    // watch time (reconnecting grants the scope). Never hold back the Data API numbers for it.
    if (err instanceof MetricsUnavailableError) {
      ctx.log("warn", `YouTube watch time and retention need the ${ANALYTICS_SCOPE} scope: reconnect the channel to grant it`);
      return;
    }
    // API not enabled in the Cloud project, quota, outage...: keep the Data API numbers.
    ctx.log("warn", `YouTube Analytics unavailable, storing views/likes/comments only: ${(err as Error).message}`);
  }
}

export const youtube: Provider = {
  id: "youtube",
  name: NAME,
  color: "FF0000",
  icon: "youtube",
  category: "video",
  auth: "oauth2",
  docsUrl: googleDocsUrl,
  setupNotes: [
    "1. In the [Google Cloud console](https://console.cloud.google.com/) create a project and enable **YouTube Data API v3** and **YouTube Analytics API** (APIs & Services → Library).",
    "2. Configure the **OAuth consent screen** (External) and add your Google account as a test user. Under **Data access → Add or remove scopes → Manually add scopes**, paste the full scope URLs (one per line): " +
      SCOPES.map((s) => `\`${s}\``).join(", ") +
      " (upload, manage, comments and captions, statistics, and YouTube Analytics).",
    "3. Create an **OAuth client ID** of type *Web application* with the authorized redirect URI `{{redirectUri}}`.",
    "4. Paste the client ID and secret here, then connect a channel (pick the brand channel on Google's account chooser).",
    "",
    "Notes: videos uploaded by an **unverified API project** (created after July 2020 and not audited) are locked to **private** by YouTube until the project passes the [API audit](https://support.google.com/youtube/contact/yt_api_form). " +
      "While the consent screen is in *Testing*, refresh tokens expire after 7 days: publish the app to *Production* to stay connected. " +
      "An image attached next to the video becomes its custom thumbnail (needs a verified channel). " +
      "Quota (default 10,000 units/day): an upload uses 1 call of the separate 100 uploads/day bucket; thumbnail 50, captions 400, new playlist 50, adding to a playlist 50, first comment 50 units; statistics 1 unit per 50 videos. " +
      "Watch time, retention and traffic sources come from the YouTube Analytics API (data lags 1-3 days). Channels connected before analytics (or before watch time / retention) must be **reconnected** to grant `youtube.readonly` and `yt-analytics.readonly`.",
  ].join("\n"),
  appFields: googleAppFields,
  credentialFields: [],
  settingsFields: [
    { key: "title", label: "Title", type: "text", required: true, maxLength: 100 },
    {
      key: "privacy",
      label: "Privacy",
      type: "select",
      default: "private",
      options: [
        { value: "public", label: "Public" },
        { value: "unlisted", label: "Unlisted" },
        { value: "private", label: "Private" },
      ],
    },
    {
      key: "publishAt",
      label: "Go public at (optional)",
      type: "datetime",
      help: "Uploads now as private and lets YouTube make it public at this time.",
    },
    { key: "category", label: "Category", type: "select", dynamicOptions: true, default: "22" },
    { key: "playlist", label: "Add to playlist", type: "select", dynamicOptions: true, default: "" },
    {
      key: "newPlaylist",
      label: "New playlist",
      type: "text",
      maxLength: 150,
      help: "Title of a playlist to add the video to: reused when the channel already has one with this title, otherwise created. Works together with \"Add to playlist\".",
    },
    {
      key: "newPlaylistPrivacy",
      label: "New playlist privacy",
      type: "select",
      default: "",
      options: [
        { value: "", label: "Same as the video" },
        { value: "public", label: "Public" },
        { value: "unlisted", label: "Unlisted" },
        { value: "private", label: "Private" },
      ],
      help: "Only used when the playlist is created. \"Same as the video\" is public for videos scheduled with \"Go public at\".",
    },
    { key: "tags", label: "Tags", type: "tags", help: "At most 500 characters in total." },
    {
      key: "language",
      label: "Video language",
      type: "select",
      default: "",
      options: languageOptions("Not set"),
      help: "Language of the title and description (defaultLanguage). Also the audio language when that is not set.",
    },
    {
      key: "audioLanguage",
      label: "Audio language",
      type: "select",
      default: "",
      options: languageOptions("Same as the video language"),
      help: "Language spoken in the video (defaultAudioLanguage).",
    },
    {
      key: "captions",
      label: "Captions (SRT or WebVTT)",
      type: "textarea",
      maxLength: MAX_CAPTIONS,
      placeholder: "1\n00:00:00,000 --> 00:00:02,500\nHello!",
      help: "Paste a SubRip (.srt) or WebVTT (.vtt) file: it is added as a caption track after the upload (400 quota units).",
    },
    {
      key: "captionsLanguage",
      label: "Captions language",
      type: "select",
      default: "",
      options: languageOptions("Same as the audio language"),
      help: "Defaults to the audio language, else the video language.",
    },
    { key: "captionsName", label: "Captions track name", type: "text", maxLength: 150, help: "Shown to viewers next to the language (default \"Subtitles\")." },
    {
      key: "localizations",
      label: "Translations",
      type: "textarea",
      placeholder: "de | Mein Video | Beschreibung auf Deutsch\nes | Mi video | Descripción",
      help: "Translated title and description, one language per line: `lang | title | description` (description optional, \\n for a line break). Needs the video language.",
    },
    { key: "madeForKids", label: "Made for kids", type: "checkbox", default: false },
    { key: "notifySubscribers", label: "Notify subscribers", type: "checkbox", default: true },
    { key: "shorts", label: "Short", type: "checkbox", default: false, help: "Adds #Shorts to the title. Vertical videos up to 3 minutes become Shorts automatically." },
    { key: "syntheticMedia", label: "Contains altered or synthetic content", type: "checkbox", default: false },
    { key: "embeddable", label: "Allow embedding", type: "checkbox", default: true },
    {
      key: "license",
      label: "License",
      type: "select",
      default: "youtube",
      options: [
        { value: "youtube", label: "Standard YouTube License" },
        { value: "creativeCommon", label: "Creative Commons - Attribution" },
      ],
    },
  ],
  capabilities: {
    maxLength: 5000,
    text: "optional",
    // The optional image is used as the custom thumbnail.
    media: { images: 1, videos: 1, mixed: true, required: true },
    thread: true,
    threadLabel: "First comment",
    mediaNote: THUMBNAIL_NOTE,
  },

  metrics: {
    post: ["views", "likes", "comments", "shares", "watchTimeMinutes", "avgViewDurationSeconds", "avgViewPercentage"],
    account: ["followers", "posts"],
    batch: METRICS_BATCH,
    scopes: ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"],
  },

  authorize(ctx, p) {
    return googleAuthorizeUrl(ctx, NAME, SCOPES, p);
  },

  async callback(ctx, { code, codeVerifier }) {
    const tok = await googleExchangeCode(ctx, NAME, code, codeVerifier);
    const token = tok.credentials.accessToken;
    const res = await yt<{ items?: any[] }>(ctx, `${API}/channels`, { token, query: { part: "snippet", mine: true, maxResults: 50 } });
    const channels = res.items ?? [];
    if (!channels.length) throw new ProviderError("This Google account has no YouTube channel", "invalid");
    return channels.map((c) => ({
      externalId: c.id,
      name: c.snippet?.title ?? "YouTube channel",
      username: c.snippet?.customUrl ?? null,
      avatarUrl: c.snippet?.thumbnails?.default?.url ?? null,
      profileUrl: c.snippet?.customUrl ? `https://www.youtube.com/${c.snippet.customUrl}` : `https://www.youtube.com/channel/${c.id}`,
      credentials: tok.credentials,
      expiresAt: tok.expiresAt,
      refreshExpiresAt: tok.refreshExpiresAt,
      meta: { channelId: c.id, country: c.snippet?.country ?? null },
    }));
  },

  refresh(ctx, account) {
    return googleRefresh(ctx, NAME, account);
  },

  validate(post) {
    const errors: string[] = [];
    if (post.media.filter((m) => m.kind === "video").length !== 1) errors.push("YouTube: attach exactly one video");
    if (/[<>]/.test(post.content)) errors.push("YouTube: the description cannot contain < or >");
    if (tagsOf(post.settings.tags).join(",").length > 500) errors.push("YouTube: tags are limited to 500 characters in total");
    const s = post.settings;
    for (const k of ["language", "audioLanguage", "captionsLanguage"])
      if (s[k] && !BCP47.test(String(s[k]))) errors.push(`YouTube: "${s[k]}" is not a language code (e.g. en, pt-BR)`);
    const loc = parseLocalizations(s.localizations);
    errors.push(...loc.errors);
    if (loc.items.length && !s.language) errors.push("YouTube: translations need the video language (the language of the main title and description)");
    const captions = captionsOf(s);
    if (captions) {
      if (Array.from(captions.text).length > MAX_CAPTIONS) errors.push(`YouTube: captions are limited to ${MAX_CAPTIONS.toLocaleString("en-US")} characters`);
      if (!captionFormat(captions.text)) errors.push("YouTube: the captions must be SubRip (.srt: starts with 1 and a 00:00:00,000 --> 00:00:01,000 line) or WebVTT (starts with WEBVTT)");
      if (!captions.language) errors.push("YouTube: set the captions language (or the audio / video language)");
    }
    return errors;
  },

  async publish(ctx, account, post) {
    const video = post.media.find((m) => m.kind === "video");
    if (!video) throw new ProviderError("YouTube needs a video", "invalid");
    if (!String(post.settings.title ?? "").trim()) throw new ProviderError("YouTube: a title is required", "invalid");
    const token = String(account.credentials.accessToken);
    const resource = videoResource(post);
    const res = await request(ctx, `${UPLOAD_API}/videos`, {
      method: "POST",
      token,
      query: {
        uploadType: "resumable",
        part: resource.localizations ? "snippet,status,localizations" : "snippet,status",
        notifySubscribers: bool(post.settings.notifySubscribers, true),
      },
      headers: { "x-upload-content-type": video.mime || "video/mp4", "x-upload-content-length": String(video.size) },
      json: resource,
      classify,
    }).catch((err) => {
      throw readable(err);
    });
    const uploadUrl = res.headers.get("location");
    if (!uploadUrl) throw new ProviderError("YouTube did not return an upload session", "transient");
    const state: UploadState = {
      uploadUrl,
      video,
      thumbnail: post.media.find((m) => m.kind === "image") ?? null,
      playlistId: post.settings.playlist ? String(post.settings.playlist) : null,
      newPlaylist: newPlaylistOf(post.settings, resource.status),
      captions: captionsOf(post.settings),
    };
    return advance(ctx, token, state, 0);
  },

  async checkStatus(ctx, account, state) {
    // Never starts a new upload: resumes the stored session from the offset YouTube reports.
    return advance(ctx, String(account.credentials.accessToken), state as UploadState, null);
  },

  async reply(ctx, account, target, post) {
    if (!post.content.trim()) throw new ProviderError("YouTube comments must contain text", "invalid");
    if (post.media.length) ctx.log("warn", "YouTube comments cannot contain media; attachments were ignored");
    const res = await yt<{ id: string }>(ctx, `${API}/commentThreads`, {
      method: "POST",
      token: String(account.credentials.accessToken),
      query: { part: "snippet" },
      json: { snippet: { videoId: target.rootId, topLevelComment: { snippet: { textOriginal: post.content } } } },
      commit: true,
    });
    return { externalId: res.id, url: `https://www.youtube.com/watch?v=${target.rootId}&lc=${res.id}` };
  },

  async options(ctx, account, key) {
    const token = String(account.credentials.accessToken);
    if (key === "category") {
      const res = await yt<{ items?: any[] }>(ctx, `${API}/videoCategories`, {
        token,
        query: { part: "snippet", regionCode: (account.meta.country as string) || "US" },
      });
      return (res.items ?? []).filter((c) => c.snippet?.assignable).map((c) => ({ value: String(c.id), label: c.snippet.title }));
    }
    if (key === "playlist") {
      const out = [{ value: "", label: "None" }];
      let pageToken: string | undefined;
      do {
        const res: { items?: any[]; nextPageToken?: string } = await yt(ctx, `${API}/playlists`, {
          token,
          query: { part: "snippet", mine: true, maxResults: 50, pageToken },
        });
        for (const p of res.items ?? []) out.push({ value: p.id, label: p.snippet?.title ?? p.id });
        pageToken = res.nextPageToken;
      } while (pageToken && out.length < 500);
      return out;
    }
    return [];
  },
  /**
   * One videos.list call for the whole batch (views, likes, comments); videos missing from it (deleted, private,
   * unknown) → null. Snapshots ≥ 24h after publishing add YouTube Analytics numbers: one report for the batch (watch
   * time, average view duration / percentage, shares, subscribers gained) and, in the 7d-37d window, one traffic
   * source report for the batch plus one retention request per video (≤ MAX_RETENTION). Worst case 3 + 10 fetches.
   */
  async postMetrics(ctx, account, items) {
    const ids = [...new Set(items.map((i) => i.externalId))].slice(0, METRICS_BATCH);
    if (!ids.length) return {};
    const token = String(account.credentials.accessToken);
    const res = await ytRead<{ items?: any[] }>(ctx, token, "/videos", {
      part: "statistics",
      id: ids.join(","),
      maxResults: METRICS_BATCH,
    });
    const found = new Map((res?.items ?? []).map((v) => [String(v.id), v.statistics ?? {}]));
    const out: PostMetricsResult = {};
    for (const id of ids) {
      const st = found.get(id);
      out[id] = st
        ? compact({
            views: count(st.viewCount),
            likes: count(st.likeCount),
            comments: count(st.commentCount),
            extra: { favorites: count(st.favoriteCount) } as Record<string, number>,
          })
        : null;
    }
    const live = items.filter((i) => found.has(i.externalId));
    await addAnalytics(ctx, token, account, live, out);
    return out;
  },

  /** channels.list statistics of the connected channel. Hidden subscriber counts are left out. */
  async accountMetrics(ctx, account) {
    const channelId = String(account.meta.channelId ?? account.externalId);
    const res = await ytRead<{ items?: any[] }>(ctx, String(account.credentials.accessToken), "/channels", { part: "statistics", id: channelId });
    const st = res?.items?.[0]?.statistics;
    if (!st) throw new ProviderError(`YouTube channel ${channelId} was not found`, "invalid");
    return compact({
      followers: st.hiddenSubscriberCount ? undefined : count(st.subscriberCount),
      posts: count(st.videoCount),
      extra: { channel_views: count(st.viewCount) } as Record<string, number>,
    });
  },
};
