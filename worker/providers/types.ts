import type { FieldOption, MetricDetails, MetricKey, MetricValues, ProviderInfo } from "../../shared/types";

export type { MetricDetails, MetricKey, MetricValues };

/** Opaque, encrypted-at-rest secrets of a connected account. */
export interface Credentials {
  accessToken?: string;
  refreshToken?: string;
  [key: string]: unknown;
}

export interface ConnectedAccount {
  /** Stable id of the account/page/channel on the platform. */
  externalId: string;
  name: string;
  username?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  credentials: Credentials;
  /** Access token expiry, ms epoch. null/undefined = does not expire or unknown. */
  expiresAt?: number | null;
  /**
   * Expiry of the credential `refresh` uses (refresh token, or the long-lived token itself for Instagram/Threads),
   * ms epoch, when the platform says. The cron refreshes the account within 7 days of it so it never lapses.
   */
  refreshExpiresAt?: number | null;
  /** Non-secret data the provider needs later (page id, instance url, owner urn...). */
  meta?: Record<string, unknown>;
}

export interface AccountRecord {
  id: string;
  provider: string;
  externalId: string;
  name: string;
  username: string | null;
  credentials: Credentials;
  expiresAt: number | null;
  meta: Record<string, unknown>;
}

export interface CredentialsUpdate {
  credentials: Credentials;
  expiresAt?: number | null;
  /** See ConnectedAccount.refreshExpiresAt. undefined = unchanged. */
  refreshExpiresAt?: number | null;
  meta?: Record<string, unknown>;
}

export interface MediaItem {
  id: string;
  kind: "image" | "video";
  mime: string;
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Seconds, videos only (when known). */
  duration: number | null;
  alt: string | null;
  /** Public, unauthenticated URL the platform can fetch the file from (supports Range requests). */
  url: string;
  /** Storage key (internal: lets `ctx.media` read the file without a D1 lookup per chunk). */
  r2Key?: string;
}

export interface PublishPost {
  /** Our post id; useful as an idempotency key. */
  id: string;
  /** When the post was scheduled (ms epoch). Stable across automatic retries of one publish; a user Retry changes it. */
  scheduledAt?: number;
  /** When the post was created (ms epoch). Never changes, even across user retries. */
  createdAt?: number;
  content: string;
  media: MediaItem[];
  settings: Record<string, any>;
}

export interface ReplyTarget {
  /** Platform id of the root post. */
  rootId: string;
  /** Platform id of the previous item in the chain (root for the first reply). */
  parentId: string;
  /** Extra data a provider returned for the previous item (e.g. Bluesky cid). */
  parentData?: Record<string, unknown>;
  rootData?: Record<string, unknown>;
}

export type PublishResult =
  | { status: "published"; externalId: string; url?: string | null; data?: Record<string, unknown> }
  /** Platform still processing (video transcoding, IG container...). The workflow calls `checkStatus` later. */
  | { status: "pending"; state: Record<string, unknown>; retryAfterSeconds?: number };

export interface MediaAccess {
  /**
   * Whole object (or a byte range) as R2's own stream. Use this for file parts of `streamingMultipart`: Workers cannot
   * pipe one fixed-length stream into another, so a `rangeStream` there stalls the upload.
   */
  stream(item: MediaItem, range?: { offset: number; length: number }): Promise<ReadableStream>;
  /** Whole object in memory. Avoid for big videos: Workers have 128MB of memory. */
  bytes(item: MediaItem): Promise<ArrayBuffer>;
  /**
   * A byte range [offset, offset+length) as a fixed-length stream. Pass it straight as a fetch body: the runtime
   * pipes R2 to the platform natively, so it costs almost no CPU or memory. Prefer this for chunked uploads.
   */
  rangeStream(item: MediaItem, offset: number, length: number): Promise<ReadableStream>;
  /** A byte range copied into memory. Costs CPU on the Free plan's 10ms budget — prefer `rangeStream`. */
  range(item: MediaItem, offset: number, length: number): Promise<ArrayBuffer>;
  blob(item: MediaItem): Promise<Blob>;
  /**
   * Resize / re-encode an image with Cloudflare Images (e.g. Bluesky's 1MB limit, platforms that reject PNG/WebP).
   * Keeps aspect ratio; `maxWidth`/`maxHeight` bound the result.
   */
  image(
    item: MediaItem,
    opts: { maxWidth?: number; maxHeight?: number; format?: "image/jpeg" | "image/png" | "image/webp"; quality?: number },
  ): Promise<Blob>;
}

/**
 * Tracks the commit request of one publish / checkStatus / reply call (docs/provider-brief.md "Commit semantics").
 * Set by http.ts (`request(..., { commit: true })`, `commitCall`); read by the workflow to decide whether a failure
 * may be retried or must go to `needs_check`.
 */
export interface CommitState {
  /** A commit request was started: from here on, a failure may have created the post. */
  sent: boolean;
  /** A commit request succeeded: the post exists on the platform. */
  accepted: boolean;
}

export interface ProviderContext {
  env: Env;
  /** Use this instead of the global fetch so tests can intercept requests. */
  fetch: typeof fetch;
  /** Values of `appFields` entered on the Platforms page (client id/secret...). Empty object when none. */
  app: Record<string, string>;
  /** OAuth callback URL for this provider: `${baseUrl}/oauth/${providerId}/callback`. */
  redirectUri: string;
  baseUrl: string;
  media: MediaAccess;
  log(level: "info" | "warn" | "error", message: string): void;
  /** Present in publishing workflow steps. Mutated in place by http.ts; never replace the object. */
  commit?: CommitState;
}

/** A published post whose metrics are requested (`postMetrics`). */
export interface MetricsItem {
  /** Platform id returned by publish. */
  externalId: string;
  /** Extra data publish returned (e.g. Bluesky uri/cid), when any. */
  data?: Record<string, unknown>;
  /** ms epoch */
  publishedAt: number;
}

/**
 * Result of `postMetrics`, keyed by externalId:
 * - MetricValues: collected.
 * - null: the platform has no metrics for that post (deleted, private, wrong type...). The post backs off.
 * - key absent: not fetched in this call (the fetch budget ran out). It stays due and is retried soon, unpenalised.
 */
export type PostMetricsResult = Record<string, MetricValues | null>;

/** Static analytics description of a provider (shown to the UI via ProviderInfo.analytics). */
export interface ProviderMetrics {
  /** Keys `postMetrics` fills (empty when not implemented). */
  post: MetricKey[];
  /** Keys `accountMetrics` fills. */
  account: MetricKey[];
  /** Max items per `postMetrics` call (the API's batch size; 1 = one request per post). Default 1. */
  batch?: number;
  /** OAuth scopes / permissions analytics need (documentation; also part of the requested scopes). */
  scopes?: string[];
}

export interface Provider extends Omit<ProviderInfo, "auth" | "analytics" | "status"> {
  auth: ProviderInfo["auth"];
  /** Defaults to "beta" (see ProviderStatus). */
  status?: ProviderInfo["status"];
  /**
   * Published posts keep linking to our media URLs (`/m/` or the MEDIA_PUBLIC_URL domain; images in markdown/HTML, embeds, URLs in the payload)
   * instead of the platform storing its own copy. Media of such posts is never removed by the retention sweep
   * (lib/media-lifecycle.ts).
   */
  hotlinksMedia?: boolean;
  /** The platform only accepts redirect URLs ending in "/" (TikTok for Business). */
  redirectTrailingSlash?: boolean;
  /**
   * Build the authorization URL (oauth2). `codeChallenge` is S256 PKCE of `codeVerifier`. `switchAccount`: the user
   * chose "use a different account" (only for providers with `switchAccount`, see ProviderInfo).
   */
  authorize?(ctx: ProviderContext, p: { state: string; codeVerifier: string; codeChallenge: string; switchAccount?: boolean }): Promise<string> | string;
  /** Exchange the callback for one or more accounts (e.g. every Facebook page the user manages). */
  callback?(
    ctx: ProviderContext,
    p: { code: string; codeVerifier: string; params: URLSearchParams },
  ): Promise<ConnectedAccount[]>;
  /** Connect with `credentialFields` values (credentials auth). */
  connect?(ctx: ProviderContext, values: Record<string, string>): Promise<ConnectedAccount[]>;
  /** Refresh credentials. Called before publishing when `expiresAt` is near, and periodically by cron. */
  refresh?(ctx: ProviderContext, account: AccountRecord): Promise<CredentialsUpdate>;
  publish(ctx: ProviderContext, account: AccountRecord, post: PublishPost): Promise<PublishResult>;
  /** Poll a pending publish. Must be safe to call repeatedly; must not re-publish. */
  checkStatus?(ctx: ProviderContext, account: AccountRecord, state: Record<string, unknown>): Promise<PublishResult>;
  /** Publish one follow-up (thread reply or comment). Only when capabilities.thread. */
  reply?(
    ctx: ProviderContext,
    account: AccountRecord,
    target: ReplyTarget,
    post: PublishPost,
  ): Promise<{
    externalId: string;
    /** Public link of the reply itself; else (with `urlIsPost`) of the post it comments on. */
    url?: string | null;
    /** `url` is the commented post's: the platform has no public link to one comment (Instagram, LinkedIn...). */
    urlIsPost?: boolean;
    data?: Record<string, unknown>;
  }>;
  /**
   * The account's current profile picture (one or two fetches). Implement it when the platform hands out signed,
   * expiring picture URLs (Meta, TikTok): lib/avatars.ts re-reads it about weekly and copies the image to R2.
   */
  profile?(ctx: ProviderContext, account: AccountRecord): Promise<{ avatarUrl: string | null }>;
  /** Choices for a `dynamicOptions` field (boards, subreddits, channels, playlists...). */
  options?(ctx: ProviderContext, account: AccountRecord, key: string, settings: Record<string, unknown>): Promise<FieldOption[]>;
  /**
   * What the composer must know about the account right before posting (TikTok: creator_info, read each time the
   * settings render, as TikTok's content sharing guidelines require).
   */
  composerInfo?(ctx: ProviderContext, account: AccountRecord): Promise<Record<string, unknown>>;
  /** Extra validation beyond capabilities. Return error messages. */
  validate?(post: PublishPost): string[];

  // ---- Analytics (docs/provider-brief.md "Metrics"). Never called for demo workspaces.

  /** What `postMetrics` / `accountMetrics` report. Required when either is implemented. */
  metrics?: ProviderMetrics;
  /**
   * Metrics of published posts (at most `metrics.batch` items). Batch requests where the API allows it; stay within
   * `fetchesLeft(ctx)` (worker/providers/budget.ts) and leave items out of the result when it runs out.
   * Throw `MetricsUnavailableError` when the token lacks the analytics permission ("reconnect_required") or the
   * account type has no analytics ("not_supported"): unlike ProviderError("auth") it never stops publishing.
   */
  postMetrics?(ctx: ProviderContext, account: AccountRecord, items: MetricsItem[]): Promise<PostMetricsResult>;
  /** Account metrics (followers, following, posts...). Same error rules as `postMetrics`. */
  accountMetrics?(ctx: ProviderContext, account: AccountRecord): Promise<MetricValues>;
}
