import type { FieldDef, ProviderCapabilities } from "../../shared/types";
import { ProviderError } from "./errors";
import { expiresAt, oauthToken, request, requireApp, type RequestOptions } from "./http";
import { counted, type CountedContext } from "./budget";
import { mediaBody } from "./multipart";
import type { AccountRecord, CredentialsUpdate, MediaItem, ProviderContext, PublishPost, PublishResult } from "./types";

/** Versioned REST API (YYYYMM). LinkedIn supports each version for about a year; bump periodically. */
export const LINKEDIN_VERSION = "202607";
const REST = "https://api.linkedin.com/rest";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const VIDEO_PART_FALLBACK = 4 * 1024 * 1024;

export const LINKEDIN_COLOR = "0A66C2";
export const LINKEDIN_DOCS = "https://www.linkedin.com/developers/apps";

export const linkedinCapabilities: ProviderCapabilities = {
  maxLength: 3000,
  text: "optional",
  media: { images: 20, videos: 1, mixed: false, required: false },
  thread: true,
  threadLabel: "Comments",
};

export const linkedinSettings = (personal: boolean): FieldDef[] => [
  ...(personal
    ? [
        {
          key: "visibility",
          label: "Visibility",
          type: "select" as const,
          default: "PUBLIC",
          options: [
            { value: "PUBLIC", label: "Anyone" },
            { value: "CONNECTIONS", label: "Connections only" },
          ],
        },
      ]
    : []),
  { key: "mediaTitle", label: "Video title", type: "text", maxLength: 200, help: "Optional title shown on video posts." },
  { key: "disableReshare", label: "Disable resharing", type: "checkbox", default: false },
];

export function liValidate(post: PublishPost): string[] {
  const errors: string[] = [];
  if (post.media.some((m) => m.kind === "video") && post.media.length > 1) errors.push("LinkedIn: a video must be the only media");
  if (!post.content.trim() && !post.media.length) errors.push("LinkedIn: text or media is required");
  return errors;
}

const tokenOf = (account: AccountRecord) => account.credentials.accessToken as string;

function li(ctx: ProviderContext, url: string, tok: string, opts: RequestOptions = {}) {
  return request(ctx, url, {
    ...opts,
    token: tok,
    headers: { "LinkedIn-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0", ...(opts.headers as any) },
    // Expired/revoked tokens come back as 401, but also as 403 "REVOKED_ACCESS_TOKEN"/"EXPIRED_ACCESS_TOKEN".
    classify: (status, body) => {
      const code = `${body?.code ?? ""} ${body?.message ?? ""}`;
      if (status === 401 || [65600, 65601, 65602].includes(body?.serviceErrorCode) || /(EXPIRED|REVOKED|INVALID)_ACCESS_TOKEN/.test(code)) return "auth";
      return undefined;
    },
  });
}

export async function liJson<T = any>(ctx: ProviderContext, url: string, tok: string, opts: RequestOptions = {}): Promise<T> {
  const res = await li(ctx, url, tok, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function liAuthorizeUrl(ctx: ProviderContext, state: string, scopes: string[]): string {
  const app = requireApp(ctx, "LinkedIn", "clientId", "clientSecret");
  const u = new URL("https://www.linkedin.com/oauth/v2/authorization");
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: ctx.redirectUri,
    state,
    scope: scopes.join(" "),
  }).toString();
  return u.toString();
}

export async function liExchangeCode(ctx: ProviderContext, code: string) {
  const app = requireApp(ctx, "LinkedIn", "clientId", "clientSecret");
  const tok = await oauthToken(ctx, TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    redirect_uri: ctx.redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  return {
    credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
    expiresAt: expiresAt(tok.expires_in),
    // Programmatic refresh tokens live 365 days and are not extended by refreshing.
    refreshExpiresAt: tok.refresh_token ? expiresAt(tok.refresh_token_expires_in) : null,
  };
}

/** Programmatic refresh tokens are only issued to some apps; without one the token lives 60 days. */
export async function liRefresh(ctx: ProviderContext, account: AccountRecord): Promise<CredentialsUpdate> {
  const refreshToken = account.credentials.refreshToken;
  if (!refreshToken) {
    if (account.expiresAt && account.expiresAt < Date.now()) {
      throw new ProviderError("LinkedIn access token expired (no refresh token issued): reconnect the account", "auth");
    }
    return { credentials: account.credentials, expiresAt: account.expiresAt };
  }
  const app = requireApp(ctx, "LinkedIn", "clientId", "clientSecret");
  const tok = await oauthToken(ctx, TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  return {
    credentials: { ...account.credentials, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? refreshToken },
    expiresAt: expiresAt(tok.expires_in),
    ...(tok.refresh_token_expires_in ? { refreshExpiresAt: expiresAt(tok.refresh_token_expires_in) } : {}),
  };
}

// ---------- text ----------

/**
 * Posts API commentary uses LinkedIn's "little text" format: reserved characters must be escaped.
 * Hashtags become hashtag templates and `@[Name](urn:li:...)` mentions are kept as-is.
 */
export function littleText(text: string): string {
  const mention = /@\[[^\]]+\]\(urn:li:(?:person|organization):[^)]+\)/g;
  const escape = (s: string) => s.replace(/[\\|{}@[\]()<>*_~#]/g, (c) => `\\${c}`);
  const plain = (s: string) => {
    let r = "";
    let i = 0;
    for (const h of s.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
      r += escape(s.slice(i, h.index)) + `{hashtag|\\#|${h[1]}}`;
      i = h.index! + h[0].length;
    }
    return r + escape(s.slice(i));
  };
  let out = "";
  let last = 0;
  for (const m of text.matchAll(mention)) {
    out += plain(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + plain(text.slice(last));
}

// ---------- media ----------

async function uploadImage(ctx: ProviderContext, tok: string, owner: string, item: MediaItem): Promise<string> {
  const init = await liJson<{ value: { uploadUrl: string; image: string } }>(ctx, `${REST}/images?action=initializeUpload`, tok, {
    method: "POST",
    json: { initializeUploadRequest: { owner } },
  });
  // Supported formats are streamed from R2 as is; others are re-encoded (a small in-memory Blob).
  const supported = ["image/jpeg", "image/png", "image/gif"].includes(item.mime);
  const body = supported ? await mediaBody(ctx, item) : await ctx.media.image(item, { maxWidth: 6000, maxHeight: 6000, format: "image/jpeg" });
  await request(ctx, init.value.uploadUrl, {
    method: "PUT",
    token: tok,
    body,
    headers: { "content-type": supported ? item.mime : "image/jpeg" },
    duplex: "half",
  } as RequestOptions);
  return init.value.image;
}

interface UploadPart {
  uploadUrl: string;
  firstByte: number;
  lastByte: number;
}

/** A multi-part video upload in progress: the parts still to send and the ETags of the sent ones. */
interface VideoUpload {
  video: string;
  uploadToken: string;
  parts: UploadPart[];
  etags: string[];
}

async function initVideo(ctx: ProviderContext, tok: string, owner: string, item: MediaItem): Promise<VideoUpload> {
  const init = await liJson<{ value: { video: string; uploadToken?: string; uploadInstructions: UploadPart[] } }>(
    ctx,
    `${REST}/videos?action=initializeUpload`,
    tok,
    {
      method: "POST",
      json: { initializeUploadRequest: { owner, fileSizeBytes: item.size, uploadCaptions: false, uploadThumbnail: false } },
    },
  );
  const { video, uploadToken, uploadInstructions } = init.value;
  return { video, uploadToken: uploadToken ?? "", parts: uploadInstructions, etags: [] };
}

/** One PUT of the byte range LinkedIn dictated, streamed from R2 (no copy through memory). */
async function putPart(ctx: ProviderContext, item: MediaItem, part: UploadPart): Promise<string> {
  const last = part.lastByte ?? Math.min(part.firstByte + VIDEO_PART_FALLBACK, item.size) - 1;
  const res = await request(ctx, part.uploadUrl, {
    method: "PUT",
    body: await ctx.media.rangeStream(item, part.firstByte, last - part.firstByte + 1),
    headers: { "content-type": "application/octet-stream" },
    duplex: "half",
  } as RequestOptions);
  const etag = res.headers.get("etag");
  if (!etag) throw new ProviderError("LinkedIn video upload did not return an ETag", "transient");
  return etag;
}

function videoStatus(ctx: ProviderContext, tok: string, urn: string) {
  return liJson<{ status?: string; processingFailureReason?: string }>(ctx, `${REST}/videos/${encodeURIComponent(urn)}`, tok);
}

// ---------- posts ----------

interface PostDraft {
  author: string;
  text: string;
  media: Array<{ urn: string; alt: string | null }>;
  video: boolean;
  visibility: string;
  title: string | null;
  disableReshare: boolean;
}

async function createPost(ctx: ProviderContext, tok: string, d: PostDraft): Promise<PublishResult> {
  const body: Record<string, unknown> = {
    author: d.author,
    commentary: littleText(d.text),
    visibility: d.visibility,
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: d.disableReshare,
  };
  if (d.media.length === 1) {
    const m = d.media[0];
    body.content = {
      media: { id: m.urn, ...(d.video ? (d.title ? { title: d.title } : {}) : m.alt ? { altText: m.alt.slice(0, 4086) } : {}) },
    };
  } else if (d.media.length > 1) {
    body.content = { multiImage: { images: d.media.map((m) => ({ id: m.urn, ...(m.alt ? { altText: m.alt.slice(0, 4086) } : {}) })) } };
  }
  const res = await li(ctx, `${REST}/posts`, tok, { method: "POST", json: body, commit: true });
  const urn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (!urn) throw new ProviderError("LinkedIn did not return the post id", "transient");
  return { status: "published", externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
}

/** Upload progress of a publish; serializable so big videos continue in the next checkStatus. */
interface UploadState {
  [key: string]: unknown;
  phase: "upload";
  draft: PostDraft;
  items: MediaItem[];
  /** Next item to upload. */
  index: number;
  /** Multi-part upload of `items[index]` in progress. Never re-initialized once started. */
  upload?: VideoUpload;
}

/**
 * Upload as much as one call's subrequest budget allows (LinkedIn dictates ~4MB parts: a 2GB video is ~500 PUTs,
 * spread over many calls), then create the post (images) or hand over to processing polls (video).
 */
async function advanceUpload(ctx: CountedContext, tok: string, st: UploadState): Promise<PublishResult> {
  // One fetch is kept for creating the post.
  const room = (n: number) => ctx.left() - 1 >= n;
  const pending = (retryAfterSeconds: number): PublishResult => ({ status: "pending", state: st, retryAfterSeconds });
  const author = st.draft.author;
  try {
    while (st.index < st.items.length) {
      const item = st.items[st.index];
      if (item.kind !== "video") {
        if (!room(2)) return pending(5);
        st.draft.media.push({ urn: await uploadImage(ctx, tok, author, item), alt: item.alt });
        st.index++;
        continue;
      }
      if (!st.upload) {
        if (!room(2)) return pending(5);
        st.upload = await initVideo(ctx, tok, author, item);
      }
      const up = st.upload;
      while (up.parts.length) {
        if (!room(1)) {
          ctx.log("info", `LinkedIn: ${up.etags.length}/${up.etags.length + up.parts.length} video parts uploaded`);
          return pending(5);
        }
        up.etags.push(await putPart(ctx, item, up.parts[0]));
        up.parts.shift();
      }
      if (!room(1)) return pending(5);
      await li(ctx, `${REST}/videos?action=finalizeUpload`, tok, {
        method: "POST",
        json: { finalizeUploadRequest: { video: up.video, uploadToken: up.uploadToken, uploadedPartIds: up.etags } },
      });
      st.draft.media.push({ urn: up.video, alt: item.alt });
      st.upload = undefined;
      st.index++;
    }
  } catch (err) {
    // Keep the progress of this call (sent parts, uploaded images); the next checkStatus continues from it.
    const progress = st.index > 0 || !!st.upload;
    if (!(err instanceof ProviderError && err.retryable) || !progress) throw err;
    ctx.log("warn", `LinkedIn upload interrupted, will resume: ${err.message}`);
    return pending(30);
  }
  if (st.draft.video) return { status: "pending", state: { draft: st.draft }, retryAfterSeconds: 15 };
  return createPost(ctx, tok, st.draft);
}

/** Publish as `author` (urn:li:person:x or urn:li:organization:x). Videos go pending until LinkedIn has processed them. */
export async function liPublish(ctx: ProviderContext, account: AccountRecord, author: string, post: PublishPost): Promise<PublishResult> {
  const s = post.settings;
  const draft: PostDraft = {
    author,
    text: post.content,
    media: [],
    video: post.media.some((m) => m.kind === "video"),
    visibility: author.startsWith("urn:li:person:") && s.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
    title: s.mediaTitle ? String(s.mediaTitle) : null,
    disableReshare: !!s.disableReshare,
  };
  return advanceUpload(counted(ctx), tokenOf(account), { phase: "upload", draft, items: post.media, index: 0 });
}

export async function liCheckStatus(ctx: ProviderContext, account: AccountRecord, state: Record<string, unknown>): Promise<PublishResult> {
  const tok = tokenOf(account);
  if (state.phase === "upload") return advanceUpload(counted(ctx), tok, state as UploadState);
  const draft = state.draft as PostDraft;
  for (const m of draft.media) {
    const v = await videoStatus(ctx, tok, m.urn);
    if (v.status === "PROCESSING_FAILED") {
      throw new ProviderError(`LinkedIn could not process the video${v.processingFailureReason ? `: ${v.processingFailureReason}` : ""}`, "invalid");
    }
    if (v.status !== "AVAILABLE") return { status: "pending", state, retryAfterSeconds: 15 };
  }
  return createPost(ctx, tok, draft);
}

/** Comments go on the root post (LinkedIn has no reply chains for posts). */
export async function liComment(ctx: ProviderContext, account: AccountRecord, actor: string, rootId: string, post: PublishPost) {
  if (post.media.length) ctx.log("warn", "LinkedIn comments are text-only; media was skipped");
  const res = await li(ctx, `${REST}/socialActions/${encodeURIComponent(rootId)}/comments`, tokenOf(account), {
    method: "POST",
    json: { actor, object: rootId, message: { text: post.content } },
    commit: true,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  const id = body.$URN ?? res.headers.get("x-restli-id") ?? body.id;
  return { externalId: String(id), url: `https://www.linkedin.com/feed/update/${rootId}/`, urlIsPost: true };
}

export function liSetupNotes(products: string, scopes: string[]): string {
  return [
    "1. Create an app at [LinkedIn Developers](https://www.linkedin.com/developers/apps) (it must be linked to a LinkedIn Page).",
    `2. Under **Products**, add ${products}.`,
    "3. Under **Auth**, add the redirect URL `{{redirectUri}}`.",
    `4. Copy the Client ID and Client Secret here. Scopes requested: \`${scopes.join(" ")}\`.`,
    "Access tokens last 60 days. If LinkedIn grants your app refresh tokens they are used automatically; otherwise reconnect when prompted.",
  ].join("\n");
}
