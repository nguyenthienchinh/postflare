import { sha256 } from "@noble/hashes/sha2.js";
import { ProviderError } from "./errors";
import { requestJson, sleep, type RequestOptions } from "./http";
import { mediaBody } from "./multipart";
import type {
  AccountRecord,
  ConnectedAccount,
  CredentialsUpdate,
  MediaItem,
  MetricValues,
  PostMetricsResult,
  Provider,
  ProviderContext,
  PublishPost,
} from "./types";

const DEFAULT_SERVICE = "https://bsky.social";
const VIDEO_SERVICE = "https://video.bsky.app";
const MAX_GRAPHEMES = 300;
/** Bluesky rejects image blobs over 1,000,000 bytes. */
const MAX_IMAGE_BYTES = 976_000;
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/**
 * Subrequest budget (Free plan, see budget.ts): mention lookups and video job polls are one fetch each.
 * Worst case reply: 10 lookups + service auth + upload + 20 polls + create/get record = 34.
 */
const MAX_MENTION_LOOKUPS = 10;
const PUBLISH_POLLS = 7;
const REPLY_POLLS = 20;
/** app.bsky.feed.getPosts accepts at most 25 uris per request. */
const METRICS_BATCH = 25;

type StrongRef = { uri: string; cid: string };
type Facet = { index: { byteStart: number; byteEnd: number }; features: Array<Record<string, string>> };

// XRPC errors come back as 400 { error: "ExpiredToken" | "InvalidToken" | "AuthMissing" ... }.
const classify = (status: number, body: any) => {
  const e = body?.error;
  if (status === 401 || e === "ExpiredToken" || e === "InvalidToken" || e === "AuthMissing" || e === "AccountTakedown")
    return "auth" as const;
  if (e === "RateLimitExceeded") return "rate_limit" as const;
  return undefined;
};

/** Expiry (ms) from a JWT's exp claim. */
export function jwtExpiry(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function pdsFromDidDoc(didDoc: any): string | null {
  const svc = didDoc?.service?.find?.((s: any) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer");
  return typeof svc?.serviceEndpoint === "string" ? svc.serviceEndpoint.replace(/\/$/, "") : null;
}

function normalizeService(url: string | undefined): string {
  const raw = (url || DEFAULT_SERVICE).trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

async function createSession(ctx: ProviderContext, service: string, identifier: string, password: string) {
  return requestJson(ctx, `${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    json: { identifier, password },
    classify: (status, body) =>
      status === 401 || body?.error === "AuthenticationRequired" || body?.error === "AuthFactorTokenRequired"
        ? "auth"
        : classify(status, body),
  });
}

function sessionCredentials(session: any, account?: AccountRecord) {
  return {
    accessJwt: session.accessJwt as string,
    refreshJwt: session.refreshJwt as string,
    // Kept (encrypted) so an expired refresh token can be replaced by a fresh login.
    identifier: (account?.credentials.identifier as string) ?? undefined,
    password: (account?.credentials.password as string) ?? undefined,
  };
}

// ---------- rich text ----------

const utf8 = new TextEncoder();
const byteLen = (s: string) => utf8.encode(s).length;

export function graphemeLength(text: string): number {
  const Seg = (Intl as any).Segmenter;
  if (!Seg) return Array.from(text).length;
  let n = 0;
  for (const _ of new Seg(undefined, { granularity: "grapheme" }).segment(text)) n++;
  return n;
}

/** Trailing punctuation that is almost never part of a URL / tag. */
function trimTrailing(s: string, isUrl: boolean): string {
  let out = s.replace(/[.,;:!?'"]+$/, "");
  if (isUrl && out.endsWith(")") && !out.includes("(")) out = out.slice(0, -1);
  return out;
}

/** Detect links, @mentions and #hashtags with UTF-8 byte offsets. Mentions are returned with the handle to resolve. */
export function detectFacets(text: string): Array<
  | { type: "link"; start: number; end: number; uri: string }
  | { type: "mention"; start: number; end: number; handle: string }
  | { type: "tag"; start: number; end: number; tag: string }
> {
  const out: ReturnType<typeof detectFacets> = [];
  const at = (charIndex: number) => byteLen(text.slice(0, charIndex));

  for (const m of text.matchAll(/(^|[\s(])(https?:\/\/[^\s]+)/gi)) {
    const uri = trimTrailing(m[2], true);
    const start = m.index! + m[1].length;
    out.push({ type: "link", start: at(start), end: at(start + uri.length), uri });
  }
  for (const m of text.matchAll(/(^|[\s(])@(([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)/g)) {
    const handle = trimTrailing(m[2], false);
    const start = m.index! + m[1].length;
    out.push({ type: "mention", start: at(start), end: at(start + 1 + handle.length), handle: handle.toLowerCase() });
  }
  for (const m of text.matchAll(/(^|\s)[#＃]([^\s­⁠ ​‌‍⃢]+)/gu)) {
    let tag = m[2].replace(/\p{P}+$/u, "");
    if (!tag || /^\d+$/.test(tag) || tag.startsWith("️")) continue;
    tag = Array.from(tag).slice(0, 64).join("");
    const start = m.index! + m[1].length;
    out.push({ type: "tag", start: at(start), end: at(start + 1) + byteLen(tag), tag });
  }
  return out.sort((a, b) => a.start - b.start);
}

async function buildFacets(ctx: ProviderContext, pds: string, token: string, text: string): Promise<Facet[]> {
  const facets: Facet[] = [];
  let lookups = 0;
  for (const f of detectFacets(text)) {
    const index = { byteStart: f.start, byteEnd: f.end };
    if (f.type === "link") facets.push({ index, features: [{ $type: "app.bsky.richtext.facet#link", uri: f.uri }] });
    else if (f.type === "tag") facets.push({ index, features: [{ $type: "app.bsky.richtext.facet#tag", tag: f.tag }] });
    else if (lookups++ < MAX_MENTION_LOOKUPS) {
      // Unresolvable handles stay plain text (so do mentions past the lookup cap: one fetch each).
      const did = await requestJson<{ did: string }>(ctx, `${pds}/xrpc/com.atproto.identity.resolveHandle`, {
        token,
        query: { handle: f.handle },
      })
        .then((r) => r?.did)
        .catch(() => null);
      if (did) facets.push({ index, features: [{ $type: "app.bsky.richtext.facet#mention", did }] });
    }
  }
  return facets;
}

// ---------- record keys ----------

const S32 = "234567abcdefghijklmnopqrstuvwxyz";
/** Timestamp identifier used as record key, so a create can be retried and detected as already existing. */
export function makeTid(nowMs = Date.now()): string {
  return encodeTid(nowMs, Math.floor(Math.random() * 1000), Math.floor(Math.random() * 1024));
}

/**
 * Deterministic TID (record key) of a post: the same post always gets the same rkey, across automatic and user
 * retries, so a repeated createRecord cannot create a second post (createRecord is therefore not a `commit: true`
 * request, see docs/provider-brief.md "Commit semantics"). Timestamp = the post's creation time (fallback: scheduled
 * time) plus sub-millisecond bits, clock id = 10 bits, both from a hash of the post id (replies have their own ids,
 * `${postId}-r${n}`, so root and replies differ).
 */
export function postTid(post: Pick<PublishPost, "id" | "createdAt" | "scheduledAt">): string {
  const h = sha256(new TextEncoder().encode(post.id));
  const micros = ((h[0] << 8) | h[1]) % 1000;
  const clock = ((h[2] << 8) | h[3]) & 1023;
  return encodeTid(post.createdAt ?? post.scheduledAt ?? Date.now(), micros, clock);
}

/** 64-bit TID: 0 | 53 bits of microseconds since the epoch | 10 bits clock id, in base32-sortable (13 chars). */
function encodeTid(ms: number, micros: number, clock: number): string {
  let v = ((BigInt(Math.floor(ms)) * 1000n + BigInt(micros)) << 10n) | BigInt(clock);
  let s = "";
  for (let i = 0; i < 13; i++) {
    s = S32[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
}

// ---------- media ----------

async function uploadBlob(ctx: ProviderContext, pds: string, token: string, body: Blob | ReadableStream, mime: string) {
  const res = await requestJson<{ blob: unknown }>(ctx, `${pds}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    token,
    headers: { "content-type": mime },
    body,
    // Required by Node/undici for stream bodies; ignored by Workers.
    duplex: "half",
    classify,
  } as RequestOptions);
  return res.blob;
}

/** Images within Bluesky's limits are streamed from R2 as is; others are re-encoded (small in-memory Blobs). */
async function imageForBluesky(ctx: ProviderContext, item: MediaItem): Promise<Blob | ReadableStream> {
  if (item.size <= MAX_IMAGE_BYTES && IMAGE_MIMES.includes(item.mime)) return mediaBody(ctx, item);
  for (const [maxWidth, quality] of [
    [2000, 85],
    [1600, 75],
    [1200, 65],
  ]) {
    const blob = await ctx.media.image(item, { maxWidth, maxHeight: maxWidth, format: "image/jpeg", quality });
    if (blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new ProviderError(`Image ${item.filename} could not be reduced below 1MB for Bluesky`, "invalid");
}

async function imagesEmbed(ctx: ProviderContext, pds: string, token: string, items: MediaItem[]) {
  const images = [];
  for (const item of items) {
    const body = await imageForBluesky(ctx, item);
    const image = await uploadBlob(ctx, pds, token, body, body instanceof Blob ? body.type || "image/jpeg" : item.mime);
    images.push({
      image,
      alt: item.alt ?? "",
      ...(item.width && item.height ? { aspectRatio: { width: item.width, height: item.height } } : {}),
    });
  }
  return { $type: "app.bsky.embed.images", images };
}

/** Uploads a video to the Bluesky video service; returns the processing job id. */
async function startVideoUpload(ctx: ProviderContext, account: AccountRecord, item: MediaItem): Promise<string> {
  const { pds, token, did } = session(account);
  const service = await requestJson<{ token: string }>(ctx, `${pds}/xrpc/com.atproto.server.getServiceAuth`, {
    token,
    query: { aud: `did:web:${new URL(pds).host}`, lxm: "com.atproto.repo.uploadBlob", exp: Math.floor(Date.now() / 1000) + 1800 },
    classify,
  });
  const name = item.filename.replace(/[^\w.-]/g, "_") || "video.mp4";
  try {
    const res = await requestJson<any>(ctx, `${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`, {
      method: "POST",
      token: service.token,
      query: { did, name },
      headers: { "content-type": item.mime || "video/mp4" },
      body: await mediaBody(ctx, item),
      duplex: "half",
      classify,
    } as any);
    const jobId = res?.jobId ?? res?.jobStatus?.jobId;
    if (!jobId) throw new ProviderError("Bluesky video service returned no job id", "transient");
    return jobId;
  } catch (err) {
    // Re-uploading the same file answers 409 with the existing job.
    const body = (err as ProviderError).body as any;
    const jobId = body?.jobId ?? body?.jobStatus?.jobId;
    if (err instanceof ProviderError && jobId) return jobId;
    throw err;
  }
}

async function videoJob(ctx: ProviderContext, jobId: string) {
  const res = await requestJson<{ jobStatus: { state: string; blob?: unknown; error?: string; message?: string } }>(
    ctx,
    `${VIDEO_SERVICE}/xrpc/app.bsky.video.getJobStatus`,
    { query: { jobId }, classify },
  );
  const job = res.jobStatus;
  if (job.state === "JOB_STATE_FAILED") throw new ProviderError(`Bluesky could not process the video: ${job.error ?? job.message ?? "unknown error"}`, "invalid");
  return job.state === "JOB_STATE_COMPLETED" && job.blob ? job.blob : null;
}

/** Polls the job up to `polls` times, 3s apart (each poll is one subrequest). */
async function waitForVideo(ctx: ProviderContext, jobId: string, polls: number) {
  for (let i = 1; ; i++) {
    const blob = await videoJob(ctx, jobId);
    if (blob || i >= polls) return blob;
    await sleep(3000);
  }
}

function videoEmbed(blob: unknown, item: { alt: string | null; width: number | null; height: number | null }) {
  return {
    $type: "app.bsky.embed.video",
    video: blob,
    ...(item.alt ? { alt: item.alt } : {}),
    ...(item.width && item.height ? { aspectRatio: { width: item.width, height: item.height } } : {}),
  };
}

// ---------- link cards ----------

function metaContent(html: string, prop: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
    "i",
  );
  const m = html.match(re);
  const v = m?.[1] ?? m?.[2];
  return v ? decodeEntities(v).trim() : undefined;
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** The stream's bytes as a Blob, or null (and the stream cancelled) when it is longer than `max`. */
async function readAtMost(stream: ReadableStream<Uint8Array>, max: number): Promise<Blob | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(chunks);
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

/** Best-effort external embed (title/description/thumbnail) from the page's og: tags. */
async function linkCard(ctx: ProviderContext, pds: string, token: string, uri: string) {
  try {
    const res = await ctx.fetch(uri, { headers: { "user-agent": "Mozilla/5.0 (compatible; postflare/1.0)", accept: "text/html" }, redirect: "follow" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return { $type: "app.bsky.embed.external", external: { uri, title: uri, description: "" } };
    const html = (await res.text()).slice(0, 500_000);
    const title = metaContent(html, "og:title") ?? metaContent(html, "twitter:title") ?? decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "");
    const description = metaContent(html, "og:description") ?? metaContent(html, "description") ?? "";
    const external: Record<string, unknown> = { uri, title: title || uri, description };
    const img = metaContent(html, "og:image") ?? metaContent(html, "twitter:image");
    if (img) {
      const imgUrl = new URL(img, uri).toString();
      const ir = await ctx.fetch(imgUrl).catch(() => null);
      const type = ir?.headers.get("content-type") ?? "";
      if (ir?.ok && ir.body && type.startsWith("image/")) {
        const size = Number(ir.headers.get("content-length") ?? NaN);
        // Known size: streamed straight through. Unknown: read at most 1MB (small) to check the limit.
        const body = size > 0 ? (size <= MAX_IMAGE_BYTES ? ir.body : null) : await readAtMost(ir.body, MAX_IMAGE_BYTES);
        if (body) external.thumb = await uploadBlob(ctx, pds, token, body, type.split(";")[0]);
        else await ir.body.cancel().catch(() => {});
      } else await ir?.body?.cancel().catch(() => {});
    }
    return { $type: "app.bsky.embed.external", external };
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "auth") throw err;
    ctx.log("warn", `Bluesky link card for ${uri} failed: ${(err as Error).message}`);
    return { $type: "app.bsky.embed.external", external: { uri, title: uri, description: "" } };
  }
}

// ---------- posting ----------

function session(account: AccountRecord) {
  const pds = (account.meta.pds as string) || (account.meta.service as string) || DEFAULT_SERVICE;
  const token = account.credentials.accessJwt as string;
  if (!token) throw new ProviderError("Bluesky session missing, reconnect the account", "auth");
  return { pds, token, did: account.externalId };
}

function postUrl(account: AccountRecord, uri: string) {
  const rkey = uri.split("/").pop();
  return `https://bsky.app/profile/${account.username || account.externalId}/post/${rkey}`;
}

async function baseRecord(ctx: ProviderContext, account: AccountRecord, post: PublishPost) {
  const { pds, token } = session(account);
  const text = post.content ?? "";
  const record: Record<string, any> = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString() };
  const facets = await buildFacets(ctx, pds, token, text);
  if (facets.length) record.facets = facets;
  const langs = String(post.settings.lang ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  if (langs.length) record.langs = langs.slice(0, 3);
  if (post.settings.label && post.settings.label !== "none")
    record.labels = { $type: "com.atproto.label.defs#selfLabels", values: [{ val: post.settings.label }] };
  return record;
}

/**
 * Create the record under its deterministic rkey (`postTid`). A retry whose first attempt went through finds the
 * record existing: the reference PDS then fails the create with a 500 InternalServerError (the MST throws "There is
 * already a value at key"; the message is not exposed), other PDSs with a 400 naming the existing record. So after
 * any failed create other than auth / rate limit, getRecord on the same rkey decides: found = this post, success.
 */
async function createRecord(ctx: ProviderContext, account: AccountRecord, record: Record<string, unknown>, rkey: string) {
  const { pds, token, did } = session(account);
  try {
    const r = await requestJson<StrongRef>(ctx, `${pds}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      token,
      json: { repo: did, collection: "app.bsky.feed.post", rkey, record },
      classify,
    });
    return { uri: r.uri, cid: r.cid };
  } catch (err) {
    if (!(err instanceof ProviderError) || err.kind === "auth" || err.kind === "rate_limit") throw err;
    const existing = await getRecord(ctx, pds, token, did, rkey);
    if (existing) {
      ctx.log("warn", `Bluesky: record ${rkey} already exists (an earlier attempt created it); using it`);
      return existing;
    }
    throw err;
  }
}

/** The post record at `rkey`, or null when there is none (400 RecordNotFound / 404). */
async function getRecord(ctx: ProviderContext, pds: string, token: string, did: string, rkey: string): Promise<StrongRef | null> {
  try {
    const r = await requestJson<StrongRef>(ctx, `${pds}/xrpc/com.atproto.repo.getRecord`, {
      token,
      query: { repo: did, collection: "app.bsky.feed.post", rkey },
      classify,
    });
    return r?.uri && r?.cid ? { uri: r.uri, cid: r.cid } : null;
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 404 || (err.status === 400 && (err.body as any)?.error === "RecordNotFound"))) return null;
    throw err;
  }
}

async function attachEmbed(ctx: ProviderContext, account: AccountRecord, post: PublishPost, record: Record<string, any>) {
  const { pds, token } = session(account);
  const images = post.media.filter((m) => m.kind === "image");
  if (images.length) record.embed = await imagesEmbed(ctx, pds, token, images.slice(0, 4));
  else if (!post.media.length && post.settings.linkCard !== false) {
    const link = detectFacets(record.text).find((f) => f.type === "link");
    if (link && link.type === "link") record.embed = await linkCard(ctx, pds, token, link.uri);
  }
}

function published(account: AccountRecord, ref: StrongRef) {
  return { status: "published" as const, externalId: ref.uri, url: postUrl(account, ref.uri), data: { uri: ref.uri, cid: ref.cid } };
}

// ---------- metrics ----------

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Drop keys the platform did not report. */
function compact(m: MetricValues): MetricValues {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as MetricValues;
}

/** at-uri of a published post: publish stores it as externalId (and data.uri). */
const postUri = (item: { externalId: string; data?: Record<string, unknown> }) =>
  typeof item.data?.uri === "string" && item.data.uri.startsWith("at://") ? item.data.uri : item.externalId;

export const bluesky: Provider = {
  id: "bluesky",
  name: "Bluesky",
  color: "1185FE",
  icon: "bluesky",
  category: "social",
  auth: "credentials",
  appFields: [],
  docsUrl: "https://bsky.app/settings/app-passwords",
  setupNotes:
    "No developer app needed. Create an **App Password** in Bluesky → Settings → Privacy and security → App passwords, then connect with your handle and that password.",
  credentialFields: [
    { key: "identifier", label: "Handle or email", type: "text", required: true, placeholder: "you.bsky.social" },
    { key: "password", label: "App password", type: "password", required: true, placeholder: "xxxx-xxxx-xxxx-xxxx" },
    {
      key: "service",
      label: "PDS / service URL",
      type: "url",
      default: DEFAULT_SERVICE,
      placeholder: DEFAULT_SERVICE,
      help: "Only change this for a self-hosted PDS.",
    },
  ],
  settingsFields: [
    { key: "lang", label: "Language(s)", type: "text", placeholder: "en", help: "Comma-separated BCP-47 codes, e.g. en or en,de." },
    {
      key: "label",
      label: "Content warning",
      type: "select",
      default: "none",
      options: [
        { value: "none", label: "None" },
        { value: "sexual", label: "Suggestive" },
        { value: "nudity", label: "Nudity" },
        { value: "porn", label: "Adult (porn)" },
        { value: "graphic-media", label: "Graphic media" },
      ],
    },
    { key: "linkCard", label: "Show a link card for the first link", type: "checkbox", default: true },
  ],
  capabilities: {
    maxLength: MAX_GRAPHEMES,
    text: "optional",
    media: { images: 4, videos: 1, mixed: false, required: false },
    thread: true,
    threadLabel: "Thread replies",
  },

  metrics: {
    post: ["likes", "reposts", "replies", "quotes", "saves"],
    account: ["followers", "following", "posts"],
    batch: METRICS_BATCH,
  },

  validate(post) {
    const errors: string[] = [];
    if (graphemeLength(post.content ?? "") > MAX_GRAPHEMES) errors.push(`Bluesky posts are limited to ${MAX_GRAPHEMES} characters`);
    const v = post.media.filter((m) => m.kind === "video");
    if (v.some((m) => m.size > 100 * 1024 * 1024)) errors.push("Bluesky videos must be under 100MB");
    if (v.some((m) => (m.duration ?? 0) > 180)) errors.push("Bluesky videos can be at most 3 minutes long");
    return errors;
  },

  async connect(ctx, values): Promise<ConnectedAccount[]> {
    const service = normalizeService(values.service);
    const identifier = values.identifier.trim().replace(/^@/, "");
    const s = await createSession(ctx, service, identifier, values.password.trim());
    const pds = pdsFromDidDoc(s.didDoc) ?? service;
    const profile = await requestJson<any>(ctx, `${pds}/xrpc/app.bsky.actor.getProfile`, {
      token: s.accessJwt,
      query: { actor: s.did },
    }).catch(() => null);
    return [
      {
        externalId: s.did,
        name: profile?.displayName || s.handle,
        username: s.handle,
        avatarUrl: profile?.avatar ?? null,
        profileUrl: `https://bsky.app/profile/${s.handle}`,
        credentials: { accessJwt: s.accessJwt, refreshJwt: s.refreshJwt, identifier, password: values.password.trim() },
        expiresAt: jwtExpiry(s.accessJwt),
        refreshExpiresAt: jwtExpiry(s.refreshJwt),
        meta: { pds, service },
      },
    ];
  },

  async refresh(ctx, account): Promise<CredentialsUpdate> {
    const pds = (account.meta.pds as string) || DEFAULT_SERVICE;
    try {
      const s = await requestJson<any>(ctx, `${pds}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        token: account.credentials.refreshJwt as string,
        classify,
      });
      return {
        credentials: sessionCredentials(s, account),
        expiresAt: jwtExpiry(s.accessJwt),
        refreshExpiresAt: jwtExpiry(s.refreshJwt),
        meta: { ...account.meta, pds: pdsFromDidDoc(s.didDoc) ?? pds },
      };
    } catch (err) {
      const { identifier, password } = account.credentials as { identifier?: string; password?: string };
      if (!(err instanceof ProviderError && err.kind === "auth") || !identifier || !password) throw err;
      const service = (account.meta.service as string) || pds;
      const s = await createSession(ctx, service, identifier, password);
      return {
        credentials: sessionCredentials(s, account),
        expiresAt: jwtExpiry(s.accessJwt),
        refreshExpiresAt: jwtExpiry(s.refreshJwt),
        meta: { ...account.meta, pds: pdsFromDidDoc(s.didDoc) ?? pds },
      };
    }
  },

  async publish(ctx, account, post) {
    const record = await baseRecord(ctx, account, post);
    const rkey = postTid(post);
    const video = post.media.find((m) => m.kind === "video");
    if (video) {
      const jobId = await startVideoUpload(ctx, account, video);
      const blob = await waitForVideo(ctx, jobId, PUBLISH_POLLS);
      if (!blob) {
        const v = { alt: video.alt, width: video.width, height: video.height };
        return { status: "pending", state: { jobId, record, rkey, video: v }, retryAfterSeconds: 10 };
      }
      record.embed = videoEmbed(blob, video);
    } else {
      await attachEmbed(ctx, account, post, record);
    }
    return published(account, await createRecord(ctx, account, record, rkey));
  },

  async checkStatus(ctx, account, state) {
    const blob = await videoJob(ctx, state.jobId as string);
    if (!blob) return { status: "pending", state, retryAfterSeconds: 10 };
    const record = { ...(state.record as Record<string, unknown>), embed: videoEmbed(blob, state.video as any) };
    return published(account, await createRecord(ctx, account, record, state.rkey as string));
  },

  async reply(ctx, account, target, post) {
    const ref = (d: Record<string, unknown> | undefined, id: string): StrongRef => {
      if (!d?.cid) throw new ProviderError("Missing Bluesky cid of the parent post", "invalid");
      return { uri: (d.uri as string) ?? id, cid: d.cid as string };
    };
    const record = await baseRecord(ctx, account, post);
    record.reply = { root: ref(target.rootData, target.rootId), parent: ref(target.parentData, target.parentId) };
    const video = post.media.find((m) => m.kind === "video");
    if (video) {
      // reply() cannot return pending: wait longer, and let the step retry (409 reuses the job) if still processing.
      const jobId = await startVideoUpload(ctx, account, video);
      const blob = await waitForVideo(ctx, jobId, REPLY_POLLS);
      if (!blob) throw new ProviderError("Bluesky is still processing the reply video", "transient");
      record.embed = videoEmbed(blob, video);
    } else {
      await attachEmbed(ctx, account, post, record);
    }
    const r = published(account, await createRecord(ctx, account, record, postTid(post)));
    return { externalId: r.externalId, url: r.url, data: r.data };
  },

  /**
   * One app.bsky.feed.getPosts request (through the PDS, which proxies to the AppView) for the batch. Bluesky reports
   * no views/impressions. Posts missing from the response (deleted, taken down) → null.
   */
  async postMetrics(ctx, account, items) {
    const { pds, token } = session(account);
    const uris = new Map<string, string>();
    for (const item of items.slice(0, METRICS_BATCH)) uris.set(postUri(item), item.externalId);
    if (!uris.size) return {};
    const q = new URLSearchParams();
    for (const uri of uris.keys()) q.append("uris", uri);
    const res = await requestJson<{ posts?: any[] }>(ctx, `${pds}/xrpc/app.bsky.feed.getPosts?${q}`, { token, classify });
    const found = new Map((res?.posts ?? []).map((p) => [String(p.uri), p]));
    const out: PostMetricsResult = {};
    for (const [uri, externalId] of uris) {
      const p = found.get(uri);
      out[externalId] = p
        ? compact({
            likes: num(p.likeCount),
            reposts: num(p.repostCount),
            replies: num(p.replyCount),
            quotes: num(p.quoteCount),
            saves: num(p.bookmarkCount),
          })
        : null;
    }
    return out;
  },

  /** Followers, follows and post count from the profile. */
  async accountMetrics(ctx, account) {
    const { pds, token, did } = session(account);
    const p = await requestJson<any>(ctx, `${pds}/xrpc/app.bsky.actor.getProfile`, { token, query: { actor: did }, classify });
    return compact({ followers: num(p?.followersCount), following: num(p?.followsCount), posts: num(p?.postsCount) });
  },
};
