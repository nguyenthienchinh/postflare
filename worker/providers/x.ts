import { MetricsUnavailableError, ProviderError } from "./errors";
import { clientFields, expiresAt, oauthToken, request, requestJson, requireApp, sleep } from "./http";
import { counted, MAX_FETCHES, type CountedContext } from "./budget";
import { mediaPart, streamBody, streamingMultipart, type MultipartPart } from "./multipart";
import type { AccountRecord, MediaItem, MetricValues, PostMetricsResult, Provider, ProviderContext, PublishPost, PublishResult } from "./types";

const API = "https://api.x.com/2";
const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];
/** APPEND segment size: X documents at most 5MB per segment. */
const CHUNK = 4 * 1024 * 1024;
/** reply() polls processing at least this many times within its budget. */
const REPLY_MIN_POLLS = 3;
const REPLY_MAX_VIDEO_MB = ((MAX_FETCHES - 3 - 1 - REPLY_MIN_POLLS) * CHUNK) / (1024 * 1024);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** GET /2/tweets accepts at most 100 ids. */
const METRICS_BATCH = 100;
const STANDARD_LIMIT = 280;
const PREMIUM_LIMIT = 25_000;

export { URL_RE, xWeightedLength } from "../../shared/xText";
import { xWeightedLength } from "../../shared/xText";

const limitFor = (settings: Record<string, any>) => (settings.premium ? PREMIUM_LIMIT : STANDARD_LIMIT);

// ---------- helpers ----------

const token = (account: AccountRecord) => account.credentials.accessToken as string;
const tweetUrl = (account: AccountRecord, id: string) => `https://x.com/${account.username || "i/web"}/status/${id}`;
const isGif = (m: MediaItem) => m.mime === "image/gif";

interface ProcessingInfo {
  state: "pending" | "in_progress" | "succeeded" | "failed";
  check_after_secs?: number;
  error?: { message?: string };
}

async function simpleUpload(ctx: ProviderContext, account: AccountRecord, item: MediaItem): Promise<string> {
  const ok = ["image/jpeg", "image/png", "image/webp"].includes(item.mime) && item.size <= MAX_IMAGE_BYTES;
  // Supported images are streamed from R2; others are re-encoded (a small in-memory Blob).
  const file: MultipartPart = ok
    ? mediaPart(ctx, "media", item)
    : await (async () => {
        const blob = await ctx.media.image(item, { maxWidth: 4096, maxHeight: 4096, format: "image/jpeg", quality: 85 });
        return { name: "media", filename: item.filename, type: "image/jpeg", size: blob.size, open: () => blob.stream() };
      })();
  const mp = streamingMultipart([
    file,
    { name: "media_category", value: "tweet_image" },
    { name: "media_type", value: ok ? item.mime : "image/jpeg" },
  ]);
  const res = await requestJson<{ data: { id: string } }>(ctx, `${API}/media/upload`, {
    token: token(account),
    ...streamBody(mp.body, mp.contentType),
  });
  return res.data.id;
}

const segments = (item: MediaItem) => Math.max(1, Math.ceil(item.size / CHUNK));

/** One APPEND: the segment is streamed from R2 into the multipart body (no copy into memory). */
async function append(ctx: ProviderContext, account: AccountRecord, id: string, item: MediaItem, index: number) {
  const offset = index * CHUNK;
  const length = Math.min(CHUNK, item.size - offset);
  const mp = streamingMultipart([
    { name: "segment_index", value: String(index) },
    { name: "media", filename: "chunk", type: "application/octet-stream", size: length, open: () => ctx.media.stream(item, { offset, length }) },
  ]);
  await request(ctx, `${API}/media/upload/${id}/append`, { token: token(account), ...streamBody(mp.body, mp.contentType) });
}

async function finalize(ctx: ProviderContext, account: AccountRecord, id: string): Promise<ProcessingInfo | undefined> {
  const fin = await requestJson<{ data: { id: string; processing_info?: ProcessingInfo } }>(ctx, `${API}/media/upload/${id}/finalize`, {
    method: "POST",
    token: token(account),
  });
  const processing = fin.data?.processing_info;
  if (processing?.state === "failed") throw processingError(processing);
  return processing && processing.state !== "succeeded" ? processing : undefined;
}

function processingError(p: ProcessingInfo) {
  return new ProviderError(`X could not process the media${p.error?.message ? `: ${p.error.message}` : ""}`, "invalid");
}

async function mediaStatus(ctx: ProviderContext, account: AccountRecord, id: string): Promise<ProcessingInfo | undefined> {
  const res = await requestJson<{ data: { processing_info?: ProcessingInfo } }>(ctx, `${API}/media/upload`, {
    token: token(account),
    query: { command: "STATUS", media_id: id },
  });
  return res.data?.processing_info;
}

async function setAltText(ctx: ProviderContext, account: AccountRecord, id: string, alt: string) {
  await request(ctx, `${API}/media/metadata`, {
    method: "POST",
    token: token(account),
    json: { id, metadata: { alt_text: { text: alt.slice(0, 1000) } } },
  });
}

/** Upload progress; serializable so a big video continues in the next checkStatus (never re-INITs a finished item). */
interface Progress {
  media: MediaItem[];
  /** Next media item to upload. */
  index: number;
  ids: string[];
  /** Ids X is still processing, with the longest suggested wait. */
  processing: string[];
  after: number;
  /** Chunked upload of `media[index]` in progress: its media id and next segment. */
  upload?: { id: string; next: number };
}

const newProgress = (media: MediaItem[]): Progress => ({ media, index: 0, ids: [], processing: [], after: 5 });

/** Fetches needed to upload `item` from scratch. */
function uploadCost(item: MediaItem): number {
  if (item.kind === "image" && !isGif(item)) return item.alt ? 2 : 1;
  return 1 + segments(item) + 1 + (item.alt && isGif(item) ? 1 : 0);
}

/**
 * Uploads as much as the call's subrequest budget allows, keeping `reserve` fetches for what follows.
 * Returns true when every item is uploaded. Mutates `p`.
 */
async function uploadAll(ctx: CountedContext, account: AccountRecord, p: Progress, reserve: number): Promise<boolean> {
  const room = (n: number) => ctx.left() - reserve >= n;
  while (p.index < p.media.length) {
    const item = p.media[p.index];
    if (item.kind === "image" && !isGif(item)) {
      if (!room(uploadCost(item))) return false;
      const id = await simpleUpload(ctx, account, item);
      if (item.alt) await setAltText(ctx, account, id, item.alt);
      p.ids.push(id);
      p.index++;
      continue;
    }
    if (!p.upload) {
      if (!room(2)) return false;
      const init = await requestJson<{ data: { id: string } }>(ctx, `${API}/media/upload/initialize`, {
        method: "POST",
        token: token(account),
        json: { media_type: item.mime, total_bytes: item.size, media_category: isGif(item) ? "tweet_gif" : "tweet_video" },
      });
      p.upload = { id: init.data.id, next: 0 };
    }
    const up = p.upload;
    while (up.next < segments(item)) {
      if (!room(1)) return false;
      await append(ctx, account, up.id, item, up.next);
      up.next++;
    }
    if (!room(item.alt && isGif(item) ? 2 : 1)) return false;
    const processing = await finalize(ctx, account, up.id);
    if (item.alt && isGif(item)) await setAltText(ctx, account, up.id, item.alt);
    if (processing) {
      p.processing.push(up.id);
      p.after = Math.max(p.after, processing.check_after_secs ?? 5);
    }
    p.ids.push(up.id);
    p.upload = undefined;
    p.index++;
  }
  return true;
}

/** Publish-side upload step: continue the upload, then wait for processing or tweet. */
async function advanceUpload(ctx: CountedContext, account: AccountRecord, p: Progress, post: PublishPost): Promise<PublishResult> {
  let done: boolean;
  try {
    done = await uploadAll(ctx, account, p, 1);
  } catch (err) {
    // Keep the progress made in this call: the next checkStatus continues from it.
    if (!(err instanceof ProviderError && err.retryable) || (!p.upload && !p.ids.length)) throw err;
    ctx.log("warn", `X upload interrupted, will resume: ${err.message}`);
    return { status: "pending", state: { phase: "upload", progress: p, post }, retryAfterSeconds: 30 };
  }
  if (!done) {
    ctx.log("info", `X: uploading media, ${p.upload ? `segment ${p.upload.next}/${segments(p.media[p.index])}` : `item ${p.index + 1}/${p.media.length}`}`);
    return { status: "pending", state: { phase: "upload", progress: p, post }, retryAfterSeconds: 5 };
  }
  const body = tweetBody(post, p.ids);
  if (p.processing.length) return { status: "pending", state: { body, processing: p.processing }, retryAfterSeconds: p.after };
  return finish(ctx, account, body);
}

async function createTweet(ctx: ProviderContext, account: AccountRecord, body: Record<string, unknown>) {
  const res = await requestJson<{ data: { id: string; text: string } }>(ctx, `${API}/tweets`, {
    method: "POST",
    token: token(account),
    json: body,
    commit: true,
  });
  return res.data.id;
}

/** Post id from a post URL (x.com / twitter.com /status/<id>) or a bare numeric id. */
const replyTarget = (v: unknown) => String(v ?? "").trim().match(/^(?:https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/\w+\/status(?:es)?\/)?(\d{5,})(?:[/?#].*)?$/)?.[1];

function tweetBody(post: PublishPost, mediaIds: string[]): Record<string, unknown> {
  const s = post.settings;
  const body: Record<string, unknown> = { text: post.content };
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  if (s.poll && !mediaIds.length) {
    const options = (Array.isArray(s.pollOptions) ? s.pollOptions : []).map((o: unknown) => String(o).trim()).filter(Boolean);
    body.poll = { options, duration_minutes: Number(s.pollDuration) || 1440 };
  }
  if (s.replySettings && s.replySettings !== "everyone") body.reply_settings = s.replySettings;
  const community = String(s.community ?? "").match(/(\d{5,})\/?$/)?.[1];
  if (community) {
    body.community_id = community;
    if (s.shareWithFollowers) body.share_with_followers = true;
  }
  if (s.madeWithAi) body.made_with_ai = true;
  if (s.paidPartnership) body.paid_partnership = true;
  const replyTo = replyTarget(s.replyTo);
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
  return body;
}

async function finish(
  ctx: ProviderContext,
  account: AccountRecord,
  body: Record<string, unknown>,
): Promise<PublishResult> {
  const id = await createTweet(ctx, account, body);
  return { status: "published", externalId: id, url: tweetUrl(account, id) };
}

// ---------- analytics ----------

/**
 * GET for analytics. X bills reads by API tier / usage credits:
 * - 403 client-forbidden / client-not-enrolled: the app's access level cannot read posts → not_supported.
 * - 402 (credits depleted) and 429 (rate limit / monthly usage cap): rate_limit, the collector backs off.
 */
async function xRead<T = any>(ctx: ProviderContext, account: AccountRecord, path: string, query: Record<string, string>): Promise<T> {
  try {
    return await requestJson<T>(ctx, `${API}${path}`, {
      token: token(account),
      query,
      classify: (status) => (status === 402 || status === 429 ? "rate_limit" : undefined),
    });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 403) {
      const b = err.body as any;
      const text = `${b?.type ?? ""} ${b?.reason ?? ""} ${b?.title ?? ""}`;
      if (/client-forbidden|client-not-enrolled|Client Forbidden/i.test(text))
        throw new MetricsUnavailableError(
          "not_supported",
          `X analytics need an API access level that can read posts (${b?.detail ?? b?.reason ?? "client not enrolled"}): upgrade the app's X API plan or add usage credits`,
        );
    }
    if (err instanceof ProviderError && err.status === 402)
      throw new ProviderError(`X API usage credits are depleted; analytics resume when credits are added (${err.message})`, "rate_limit", 402, err.body);
    throw err;
  }
}

const metricNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function tweetMetrics(pm: Record<string, unknown> | undefined): MetricValues {
  const out: MetricValues = {};
  const set = (k: keyof MetricValues, v: unknown) => {
    const n = metricNum(v);
    if (n !== undefined) (out as any)[k] = n;
  };
  set("impressions", pm?.impression_count);
  set("likes", pm?.like_count);
  set("replies", pm?.reply_count);
  set("reposts", pm?.retweet_count);
  set("quotes", pm?.quote_count);
  set("saves", pm?.bookmark_count);
  return out;
}

function accountFromUser(u: any, tok: Awaited<ReturnType<typeof oauthToken>>, previousRefresh?: string) {
  return {
    externalId: u.id,
    name: u.name || u.username,
    username: u.username,
    avatarUrl: u.profile_image_url ?? null,
    profileUrl: `https://x.com/${u.username}`,
    credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token ?? previousRefresh },
    expiresAt: expiresAt(tok.expires_in),
    meta: { verifiedType: u.verified_type ?? null },
  };
}

export const x: Provider = {
  status: "verified",
  statusNote: "Publishing verified (OAuth 2.0); posting needs X API write access/credits",
  id: "x",
  name: "X (Twitter)",
  color: "000000",
  icon: "x",
  category: "social",
  auth: "oauth2",
  appFields: clientFields("OAuth 2.0 Client ID", "OAuth 2.0 Client Secret"),
  docsUrl: "https://developer.x.com/en/portal/dashboard",
  setupNotes: [
    "1. Create a project and app in the [X developer portal](https://developer.x.com/en/portal/dashboard).",
    "2. Under **User authentication settings**, enable **OAuth 2.0**, app type **Web App, Automated App or Bot** (confidential client), permissions **Read and write**.",
    "3. Add the callback URL `{{redirectUri}}` and your website URL.",
    "4. Copy the **OAuth 2.0 Client ID and Client Secret** (not the API key/secret) here.",
    "Scopes requested: `tweet.read tweet.write users.read offline.access media.write`. Posting needs a paid API tier that allows writes.",
    "Analytics read public post metrics (`GET /2/tweets`, 100 posts per request) and follower counts with the same scopes; reads are billed by your X API plan / usage credits.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: [
    {
      key: "replySettings",
      label: "Who can reply",
      type: "select",
      default: "everyone",
      options: [
        { value: "everyone", label: "Everyone" },
        { value: "following", label: "Accounts you follow" },
        { value: "mentionedUsers", label: "Only accounts you mention" },
        { value: "subscribers", label: "Your subscribers" },
        { value: "verified", label: "Verified accounts" },
      ],
    },
    { key: "poll", label: "Add a poll", type: "checkbox", default: false, help: "Polls cannot be combined with media." },
    { key: "pollOptions", label: "Poll options", type: "tags", showIf: { key: "poll", equals: true }, help: "2 to 4 options, 25 characters each." },
    {
      key: "pollDuration",
      label: "Poll duration",
      type: "select",
      default: "1440",
      showIf: { key: "poll", equals: true },
      options: [
        { value: "5", label: "5 minutes" },
        { value: "60", label: "1 hour" },
        { value: "360", label: "6 hours" },
        { value: "1440", label: "1 day" },
        { value: "4320", label: "3 days" },
        { value: "10080", label: "7 days" },
      ],
    },
    {
      key: "community",
      label: "Community",
      type: "text",
      placeholder: "https://x.com/i/communities/1493446837214187523",
      help: "Optional community URL or id to post into.",
    },
    { key: "shareWithFollowers", label: "Also share community post with followers", type: "checkbox", default: false },
    {
      key: "replyTo",
      label: "Reply to post",
      type: "text",
      placeholder: "https://x.com/someone/status/2111442603388314109",
      help: "Optional: publish as a reply to this post (URL or id). X only accepts API replies when the post's author mentions or quotes this account.",
    },
    { key: "madeWithAi", label: "Made with AI", type: "checkbox", default: false },
    { key: "paidPartnership", label: "Paid partnership", type: "checkbox", default: false },
    {
      key: "premium",
      label: "X Premium (long posts)",
      type: "checkbox",
      default: false,
      help: "Allows posts up to 25,000 characters (requires X Premium on this account).",
    },
  ],
  capabilities: {
    // Real limit (280 weighted, or 25,000 with Premium) is enforced in validate().
    maxLength: PREMIUM_LIMIT,
    text: "optional",
    media: { images: 4, videos: 1, mixed: false, required: false },
    thread: true,
    threadLabel: "Thread replies",
  },

  metrics: {
    post: ["impressions", "likes", "replies", "reposts", "quotes", "saves"],
    account: ["followers", "following", "posts"],
    batch: METRICS_BATCH,
    scopes: ["tweet.read", "users.read"],
  },

  authorize(ctx, { state, codeChallenge }) {
    const app = requireApp(ctx, "X", "clientId", "clientSecret");
    const u = new URL("https://x.com/i/oauth2/authorize");
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: app.clientId,
      redirect_uri: ctx.redirectUri,
      scope: SCOPES.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  },

  async callback(ctx, { code, codeVerifier }) {
    const app = requireApp(ctx, "X", "clientId", "clientSecret");
    const tok = await oauthToken(
      ctx,
      `${API}/oauth2/token`,
      { grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri, code_verifier: codeVerifier, client_id: app.clientId },
      { basicAuth: { id: app.clientId, secret: app.clientSecret } },
    );
    const me = await requestJson<{ data: any }>(ctx, `${API}/users/me`, {
      token: tok.access_token,
      query: { "user.fields": "profile_image_url,username,name,verified_type" },
    });
    return [accountFromUser(me.data, tok)];
  },

  async refresh(ctx, account) {
    const app = requireApp(ctx, "X", "clientId", "clientSecret");
    if (!account.credentials.refreshToken) throw new ProviderError("No refresh token: reconnect the X account", "auth");
    // Refresh tokens rotate: the old one stops working once used.
    const tok = await oauthToken(
      ctx,
      `${API}/oauth2/token`,
      { grant_type: "refresh_token", refresh_token: account.credentials.refreshToken, client_id: app.clientId },
      { basicAuth: { id: app.clientId, secret: app.clientSecret } },
    );
    return {
      credentials: { ...account.credentials, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? account.credentials.refreshToken },
      expiresAt: expiresAt(tok.expires_in),
    };
  },

  validate(post) {
    const errors: string[] = [];
    const limit = limitFor(post.settings);
    const len = xWeightedLength(post.content);
    if (len > limit) errors.push(`X: ${len}/${limit} characters (URLs count as 23, emoji and CJK as 2)`);
    const gifs = post.media.filter(isGif).length;
    const videos = post.media.filter((m) => m.kind === "video").length;
    if ((gifs || videos) && post.media.length > 1) errors.push("X: a video or GIF must be the only media in a post");
    if (post.settings.poll) {
      const options = (Array.isArray(post.settings.pollOptions) ? post.settings.pollOptions : []).filter((o: unknown) => String(o).trim());
      if (post.media.length) errors.push("X: polls cannot include media");
      if (options.length < 2 || options.length > 4) errors.push("X: a poll needs 2 to 4 options");
      if (options.some((o: unknown) => String(o).length > 25)) errors.push("X: poll options are limited to 25 characters");
    }
    if (post.settings.community && !/(\d{5,})\/?$/.test(String(post.settings.community)))
      errors.push("X: community must be a community URL or numeric id");
    if (post.settings.replyTo && !replyTarget(post.settings.replyTo)) errors.push("X: reply to must be a post URL or numeric id");
    return errors;
  },

  async publish(ctx, account, post) {
    // Settings and text only: media lives in the progress.
    const stored: PublishPost = { id: post.id, content: post.content, media: [], settings: post.settings };
    return advanceUpload(counted(ctx), account, newProgress(post.media), stored);
  },

  async checkStatus(ctx, account, state) {
    if (state.phase === "upload") return advanceUpload(counted(ctx), account, state.progress as Progress, state.post as PublishPost);
    const pending: string[] = [];
    let after = 5;
    for (const id of state.processing as string[]) {
      const info = await mediaStatus(ctx, account, id);
      if (!info || info.state === "succeeded") continue;
      if (info.state === "failed") throw processingError(info);
      pending.push(id);
      after = Math.max(after, info.check_after_secs ?? 5);
    }
    if (pending.length) return { status: "pending", state: { ...state, processing: pending }, retryAfterSeconds: after };
    return finish(ctx, account, state.body as Record<string, unknown>);
  },

  async reply(ctx, account, target, post) {
    const len = xWeightedLength(post.content);
    const limit = limitFor(post.settings);
    if (len > limit) throw new ProviderError(`X reply is ${len}/${limit} characters`, "invalid");
    // reply() cannot return pending, so the whole upload must fit in one call's subrequest budget
    // (keeping the tweet and a few status polls): about 130MB of video.
    const c = counted(ctx);
    const cost = post.media.reduce((n, m) => n + uploadCost(m), 0);
    if (cost + 1 + REPLY_MIN_POLLS > c.left())
      throw new ProviderError(`X reply media is too large to upload in one step (max ~${REPLY_MAX_VIDEO_MB}MB of video)`, "invalid");
    const p = newProgress(post.media);
    if (!(await uploadAll(c, account, p, 1))) throw new ProviderError("X reply media did not fit in one step", "invalid");
    // Wait for processing, bounded by time and by the subrequest budget (one fetch kept for the tweet).
    const deadline = Date.now() + 5 * 60 * 1000;
    for (const id of p.processing) {
      for (;;) {
        if (c.left() <= 1 || Date.now() > deadline) throw new ProviderError("X is still processing the reply media", "transient");
        const info = await mediaStatus(c, account, id);
        if (!info || info.state === "succeeded") break;
        if (info.state === "failed") throw processingError(info);
        await sleep((info.check_after_secs ?? 5) * 1000);
      }
    }
    const body: Record<string, unknown> = { text: post.content, reply: { in_reply_to_tweet_id: target.parentId } };
    if (p.ids.length) body.media = { media_ids: p.ids };
    const id = await createTweet(c, account, body);
    return { externalId: id, url: tweetUrl(account, id) };
  },
  /** One GET /2/tweets for the batch (public_metrics). Posts X does not return (deleted, protected, not found) → null. */
  async postMetrics(ctx, account, items) {
    const ids = [...new Set(items.map((i) => i.externalId))].slice(0, METRICS_BATCH);
    if (!ids.length) return {};
    const res = await xRead<{ data?: Array<{ id: string; public_metrics?: Record<string, unknown> }> }>(ctx, account, "/tweets", {
      ids: ids.join(","),
      "tweet.fields": "public_metrics",
    });
    const found = new Map((res?.data ?? []).map((t) => [String(t.id), t]));
    const out: PostMetricsResult = {};
    for (const id of ids) {
      const t = found.get(id);
      out[id] = t ? tweetMetrics(t.public_metrics) : null;
    }
    return out;
  },

  /** public_metrics of the connected user. */
  async accountMetrics(ctx, account) {
    const res = await xRead<{ data?: { public_metrics?: Record<string, unknown> } }>(ctx, account, "/users/me", { "user.fields": "public_metrics" });
    const pm = res?.data?.public_metrics ?? {};
    const out: MetricValues = {};
    if (metricNum(pm.followers_count) !== undefined) out.followers = pm.followers_count as number;
    if (metricNum(pm.following_count) !== undefined) out.following = pm.following_count as number;
    if (metricNum(pm.tweet_count) !== undefined) out.posts = pm.tweet_count as number;
    if (metricNum(pm.listed_count) !== undefined) out.extra = { listed: pm.listed_count as number };
    return out;
  },
};
