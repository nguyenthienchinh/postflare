// Types shared by the worker and the web app.

export type FieldType =
  | "text"
  | "textarea"
  | "password"
  | "number"
  | "select"
  | "checkbox"
  | "url"
  | "tags"
  | "datetime";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** Static choices for `select`. */
  options?: FieldOption[];
  /** Choices are loaded per account from `GET /api/accounts/:id/options/:key`. */
  dynamicOptions?: boolean;
  default?: string | number | boolean | string[];
  maxLength?: number;
  /** Only show (and validate) the field when another field has a given value. */
  showIf?: { key: string; equals: string | boolean | number };
}

export type ProviderCategory = "social" | "video" | "community" | "blog" | "messaging" | "newsletter";

export interface ProviderCapabilities {
  /** Max characters of the main post text. */
  maxLength: number;
  text: "required" | "optional" | "none";
  media: {
    /** Max images per post (0 = images not supported). */
    images: number;
    /** Max videos per post (0 = videos not supported). */
    videos: number;
    /** Images and videos can be combined in one post. */
    mixed: boolean;
    /** At least one media item is required (Instagram, TikTok, YouTube, Pinterest...). */
    required: boolean;
  };
  /** Follow-up items are supported (reply chain or comments). */
  thread: boolean;
  /** UI label for follow-ups, e.g. "Thread replies" or "First comment". */
  threadLabel?: string;
  /**
   * What the media is used for when it is not obvious (shown under the composer's media picker, in list_platforms and
   * `postflare platforms <id>`), e.g. YouTube: the image next to the video becomes the custom thumbnail.
   */
  mediaNote?: string;
}

/**
 * How far a provider is proven (README "Platform status"):
 * - verified: publishing confirmed against the live API with a real account.
 * - beta: built against the official API and covered by mocked tests, not yet confirmed with a live account.
 * - experimental: relies on an unofficial API; hidden until an instance admin enables experimental integrations.
 */
export type ProviderStatus = "verified" | "beta" | "experimental";

export interface ProviderInfo {
  id: string;
  name: string;
  /** Brand hex color without '#'. */
  color: string;
  /** simple-icons slug used for the logo, if any. */
  icon?: string;
  category: ProviderCategory;
  auth: "oauth2" | "credentials";
  /** Developer-app fields (client id / secret...) configured once per platform. Empty when none needed. */
  appFields: FieldDef[];
  /** Fields asked when connecting an account with `credentials` auth. */
  credentialFields: FieldDef[];
  /** Per-post settings. */
  settingsFields: FieldDef[];
  capabilities: ProviderCapabilities;
  /** Where to create the developer app. */
  docsUrl?: string;
  /** Markdown shown in the composer next to this platform's settings (legal notices, platform requirements). */
  composerNotice?: string;
  /** Markdown setup steps shown on the Platforms page. `{{redirectUri}}` and `{{baseUrl}}` are substituted. */
  setupNotes?: string;
  /** Which analytics the platform provides (both false when none). */
  analytics: ProviderAnalytics;
  status: ProviderStatus;
  /** Short qualifier of `status` (shown in tooltips and the README table). */
  statusNote?: string;
  /**
   * OAuth providers whose login can be forced to ask for another account (`GET /connect/:provider/url?switchAccount=1`).
   * `label` is the link text, `note` warns about side effects (e.g. it signs the user out of the platform's website).
   */
  switchAccount?: { label: string; note: string };
}

/**
 * `needs_check`: the request that creates the post failed in a way that does not tell whether the platform accepted
 * it (network error, timeout, 5xx after sending). It is never retried automatically; the user checks the profile and
 * resolves it (POST /api/posts/:id/resolve: mark as published, or retry anyway).
 */
export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "needs_check";

export interface ThreadItem {
  content: string;
  media: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Analytics (worker/lib/metrics.ts, worker/routes/analytics.ts)

/** Normalized metric keys. Platforms fill the ones they offer; everything else goes into `extra`. */
export type MetricKey =
  | "impressions"
  | "reach"
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "saves"
  | "clicks"
  | "replies"
  | "reposts"
  | "quotes"
  | "followers"
  | "following"
  | "posts"
  /** Minutes watched in total (YouTube Analytics estimatedMinutesWatched). */
  | "watchTimeMinutes"
  /** Average length of a view in seconds (YouTube Analytics averageViewDuration). Not additive across posts. */
  | "avgViewDurationSeconds"
  /** Average share of the video watched per view, in percent 0-100 (YouTube Analytics averageViewPercentage). Not additive. */
  | "avgViewPercentage";

/**
 * Structured analytics of a post that are not single numbers (YouTube Analytics). Stored with the snapshot in
 * `post_metrics` only (never in `posts.metrics`, which list endpoints return for many posts); PostMetricsDTO.details
 * carries the latest one.
 */
export interface MetricDetails {
  /**
   * Audience retention curve: [elapsed share of the video 0.01..1, audienceWatchRatio] (~100 points). The ratio is the
   * share of views still watching at that moment and can exceed 1 when parts are rewatched.
   */
  retention?: Array<[number, number]>;
  /** Views per traffic source (YouTube insightTrafficSourceType, e.g. YT_SEARCH, SHORTS, EXT_URL), most views first. */
  trafficSources?: Array<{ source: string; views: number }>;
}

/** Metric values of a post or an account at one point in time. Missing key = the platform does not report it. */
export type MetricValues = Partial<Record<MetricKey, number>> & {
  /** Platform-specific numbers (e.g. Reddit upvote_ratio, YouTube favorites, Instagram profile_visits). */
  extra?: Record<string, number>;
  /** Structured data (retention curve, traffic sources); post snapshots only, see MetricDetails. */
  details?: MetricDetails;
};

/** The keys that count as engagements (interactions with a post). */
export const ENGAGEMENT_KEYS = ["likes", "comments", "shares", "saves", "replies", "reposts", "quotes", "clicks"] as const satisfies readonly MetricKey[];

/** likes + comments + shares + saves + replies + reposts + quotes + clicks (missing keys count as 0). */
export function engagements(m: MetricValues | null | undefined): number {
  if (!m) return 0;
  let n = 0;
  for (const k of ENGAGEMENT_KEYS) n += typeof m[k] === "number" ? m[k]! : 0;
  return n;
}

/**
 * What engagement rate is measured against: views, else impressions, else reach (null when the platform reports none
 * of them, e.g. Bluesky: such posts are left out of engagement rates).
 */
export function exposure(m: MetricValues | null | undefined): number | null {
  if (!m) return null;
  return m.views ?? m.impressions ?? m.reach ?? null;
}

/** ProviderInfo.analytics */
export interface ProviderAnalytics {
  /** Per-post metrics are collected. */
  post: boolean;
  /** Account metrics (followers...) are collected daily. */
  account: boolean;
  /** Keys the platform reports (post and account). */
  metrics: MetricKey[];
}

/**
 * Analytics collection state of an account (AccountDTO.metricsStatus). Independent of the publishing `status`: an
 * account can publish fine while analytics need a reconnect (the token predates the analytics permissions).
 * - pending: not collected yet. ok: last collection worked.
 * - reconnect_required: the token lacks the analytics permissions; reconnect the account to grant them.
 * - not_supported: the platform (or this account type) offers no analytics. error: the last collection failed.
 */
export type MetricsStatus = "pending" | "ok" | "reconnect_required" | "not_supported" | "error";

export interface AccountMetricsStatusDTO {
  status: MetricsStatus;
  message: string | null;
  /** Last collection attempt (ms). */
  checkedAt: number | null;
  /** Latest account metrics (followers...), null when none collected. */
  metrics: MetricValues | null;
}

export interface AccountDTO {
  id: string;
  provider: string;
  externalId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  status: "active" | "disabled" | "reconnect";
  statusMessage: string | null;
  expiresAt: number | null;
  createdAt: number;
  /** When the account was last connected again (OAuth reconnect / re-entered credentials), null if never. */
  reconnectedAt: number | null;
  /** Analytics collection state. */
  metricsStatus: AccountMetricsStatusDTO;
  /** Account group (GET /api/account-groups) the account belongs to, null when ungrouped. */
  groupId: string | null;
}

/** GET /api/account-groups: a workspace's "brand / project" folder for accounts (an account is in at most one). */
export interface AccountGroupDTO {
  id: string;
  name: string;
  /** Palette key (shared/accountGroups.ts ACCOUNT_GROUP_COLORS). */
  color: string;
  /** Display order, 0 first. */
  position: number;
  /** Accounts in the group. */
  accountCount: number;
  createdAt: number;
  updatedAt: number;
}

/** POST /api/account-groups; PATCH takes any subset (`position` moves the group to that index). */
export interface AccountGroupInput {
  name?: string;
  color?: string;
  position?: number;
}

export interface MediaDTO {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: "image" | "video";
  width: number | null;
  height: number | null;
  duration: number | null;
  alt: string | null;
  url: string;
  /** Small WebP thumbnail (images, max 480 px) or null: show `url` instead. */
  thumbUrl: string | null;
  createdAt: number;
}

export interface PostDTO {
  id: string;
  groupId: string;
  accountId: string;
  status: PostStatus;
  scheduledAt: number | null;
  content: string;
  media: string[];
  settings: Record<string, unknown>;
  thread: ThreadItem[];
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  /** Playbook the post was written with (built-in id or custom pbk_ id), its version and A/B variant label. */
  playbookId: string | null;
  playbookVersion: number | null;
  variant: string | null;
  /** App Store app the post is about (workspace app id, GET /api/apps), null when none. */
  appId: string | null;
  /** Per-post override of the workspace's "auto-insert tracked links" setting; null = workspace default. */
  autoLink: boolean | null;
  /** Tracked link of the post (GET /api/posts/:id only; null without an app or on non-clickable platforms). */
  campaign?: CampaignLinkDTO | null;
}

/** Body of POST /api/posts/:id/resolve (only for `needs_check` posts). */
export interface ResolvePostInput {
  /** true: it is live, mark it published (optionally with its URL). false: it is not live, publish it again now. */
  published: boolean;
  /** Link to the live post (published: true only). */
  url?: string | null;
}

/** GET /api/media/usage: bytes of stored media (ready and in-progress uploads). */
export interface MediaUsageDTO {
  workspace: { bytes: number; count: number };
  /** Whole instance, all workspaces: instance admins only. */
  instance: { bytes: number; count: number } | null;
  /** R2 Free plan storage (10 GB), for reference. */
  freeTierBytes: number;
  /** Instance setting: media older than this is removed when no longer needed; 0 = keep forever. */
  retentionDays: number;
}

export interface PostLogDTO {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: number;
}

/** Body of POST /api/posts. One entry per target account; all share a group id. */
export interface CreatePostsInput {
  /** "now" publishes immediately, a ms timestamp or ISO date schedules, null saves drafts. */
  scheduledAt: number | string | null;
  posts: Array<{
    accountId: string;
    content: string;
    media?: string[];
    settings?: Record<string, unknown>;
    thread?: ThreadItem[];
  }>;
  /** Playbook the posts were written with (attribution for the playbook ranking). Built-in id, custom id or slug. */
  playbookId?: string | null;
  /** Version used (default: the latest). */
  playbookVersion?: number | null;
  /** A/B label, e.g. "A" or "short-hook" (at most 32 characters). */
  variant?: string | null;
  /**
   * App Store app the posts are about: workspace app id (app_...), App Store id or app name (GET /api/apps). Posts on
   * clickable platforms get a tracked link (/a/<code>) with a campaign token; null removes it (PATCH).
   */
  appId?: string | null;
  /** Override the workspace's auto-insert setting for these posts (null/absent = workspace default). */
  autoLink?: boolean | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Users, workspaces and roles (docs/workspaces-spec.md)

export type InstancePermission =
  | "instance.platforms.manage"
  | "instance.users.manage"
  | "instance.settings.manage"
  | "instance.workspaces.create"
  | "instance.overview.view"
  | "instance.support.manage";

export type WorkspacePermission =
  | "workspace.manage"
  | "workspace.delete"
  | "members.manage"
  | "accounts.read"
  | "accounts.manage"
  | "posts.read"
  | "posts.write"
  | "media.read"
  | "media.write"
  | "playbooks.manage"
  | "apikeys.manage"
  | "billing.manage";

export type PermissionKey = InstancePermission | WorkspacePermission;

export type RoleScope = "instance" | "workspace";

/** GET /api/permissions: the permission catalog. */
export interface PermissionInfo {
  key: PermissionKey;
  scope: RoleScope;
  /** Short UI label, e.g. "Write posts". */
  label: string;
  description: string;
}

export interface RoleRef {
  id: string;
  name: string;
}

/** GET /api/roles */
export interface RoleDTO {
  id: string;
  scope: RoleScope;
  name: string;
  description: string | null;
  permissions: PermissionKey[];
  /** Built-in roles cannot be edited or deleted. */
  builtin: boolean;
  createdAt: number;
  /** Users (instance roles) or memberships (workspace roles) using this role. */
  assigned: number;
}

/** Body of POST /api/roles (PATCH takes the same fields minus `scope`, all optional). */
export interface RoleInput {
  scope: RoleScope;
  name: string;
  description?: string | null;
  permissions: PermissionKey[];
}

/** `pending`: signed up, email not verified yet (cannot sign in; deleted after 7 days, see docs/hosted-spec.md). */
export type UserStatus = "active" | "disabled" | "pending";

/** A workspace as seen by the current user (GET /api/me `workspaces`). */
export interface MeWorkspace {
  id: string;
  name: string;
  /** The user's membership role. Instance admins who are not members get Owner with `viaAdmin: true`. */
  role: RoleRef;
  /** Effective workspace permissions (all of them for instance admins). */
  permissions: WorkspacePermission[];
  /** Listed only because the user is an instance admin (not a member). */
  viaAdmin?: true;
  /** Sandboxed live-demo workspace: publishing is simulated, no accounts can be connected, no media uploaded. */
  demo?: true;
}

/** GET /api/me */
export interface MeDTO {
  /** `demo`: the shared live-demo visitor (read-only profile, no API keys, demo workspace only). */
  user: { id: string; name: string; email: string; role: RoleRef; demo?: true };
  instancePermissions: InstancePermission[];
  workspaces: MeWorkspace[];
  /** Workspace used for scoped requests without an `X-Workspace-Id` header; null when the user has none. */
  currentWorkspaceId: string | null;
}

/** GET /api/workspaces, POST /api/workspaces, PATCH /api/workspaces/:id */
export interface WorkspaceDTO extends MeWorkspace {
  createdAt: number;
  memberCount: number;
}

/** GET /api/workspaces/:id/members */
export interface MemberDTO {
  userId: string;
  name: string;
  email: string;
  status: UserStatus;
  role: RoleRef;
  joinedAt: number;
  lastLoginAt: number | null;
}

/** GET /api/users (instance admins) */
export interface UserDTO {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  role: RoleRef;
  workspaces: Array<{ id: string; name: string; role: RoleRef }>;
  createdAt: number;
  lastLoginAt: number | null;
}

/** Body of POST /api/invitations */
export interface CreateInvitationInput {
  /** Optional: when set, only this email can accept. */
  email?: string | null;
  /** Instance role of a new user (forced to Member for non-admins). */
  instanceRoleId: string;
  /** Existing workspace to join, or null/omitted to create a new workspace for the invitee (admins only). */
  workspaceId?: string | null;
  /** Required with `workspaceId`. */
  workspaceRoleId?: string | null;
  /** Name of the workspace created on acceptance when `workspaceId` is null. */
  newWorkspaceName?: string | null;
}

/** Response of POST /api/invitations. The url (with its token) is only returned here. */
export interface CreatedInvitationDTO {
  id: string;
  url: string;
  expiresAt: number;
}

/** GET /api/invitations (pending only) */
export interface InvitationDTO {
  id: string;
  email: string | null;
  instanceRole: RoleRef;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceRole: RoleRef | null;
  newWorkspaceName: string | null;
  invitedBy: { id: string; name: string } | null;
  createdAt: number;
  expiresAt: number;
}

/** GET /api/invitations/lookup/:token (public) */
export interface InvitationLookupDTO {
  email: string | null;
  /** Existing workspace the invitee joins (null when a new workspace is created). */
  workspaceName: string | null;
  workspaceRole: RoleRef | null;
  /** Workspace created for the invitee (null when joining an existing one). */
  newWorkspaceName: string | null;
  /** Name of the inviter. */
  invitedBy: string;
  expired: boolean;
  accepted: boolean;
}

/** Body of POST /api/invitations/accept (name/email/password ignored when a signed-in user accepts). */
export interface AcceptInvitationInput {
  token: string;
  name?: string;
  email?: string;
  password?: string;
}

/** GET /api/auth/status */
export interface AuthStatusDTO {
  setup: boolean;
  authenticated: boolean;
  /** Present (true) when the instance runs the public live demo (DEMO_MODE). */
  demo?: true;
  /** Present (true) before setup when the deployment has a SETUP_TOKEN secret: the setup form must send it. */
  setupToken?: true;
  /** Present (true) when sign-in links by email are on (EMAIL binding + EMAIL_FROM, turned on by an instance admin). */
  magicLink?: true;
  /** Present (true) when public sign-up is on (signup_mode open): show "Create an account". */
  signup?: true;
  /** How new people get an account: `apply` = "Request access" (/apply), `open` = "Create an account" (/signup). */
  signupMode?: SignupMode;
  /**
   * Present when Cloudflare Turnstile is configured: the widget's site key. Sign-up and sign-in links then need a
   * `turnstileToken`, and sign-in too once the login answers `captchaRequired: true` (after 3 recent failures).
   */
  turnstileSiteKey?: string;
  /**
   * Present (true) when "Sign in with the iPhone app" is offered (docs/app-login-spec.md): the iOS app exists for this
   * instance (APP_STORE_URL) or at least one device is signed in.
   */
  appLogin?: true;
  /** Present (true) when "Send a request to my iPhone" works too: APNs configured and a device with push on. */
  pushLogin?: true;
  /** App Store page of the iOS app (APP_STORE_URL var): "Get the app". */
  appStoreUrl?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// iOS app (docs/ios-api.md)

/** POST /api/auth/device and POST /api/auth/pair: the device token (Authorization: Bearer pfd_...) and the user. */
export interface DeviceTokenDTO {
  token: string;
  /** devices.id of this install (GET /api/devices, `current`). */
  deviceId: string;
  user: { id: string; name: string; email: string; role: RoleRef };
  instancePermissions: InstancePermission[];
  /** Same list as GET /api/me `workspaces`; send `X-Workspace-Id` to act in one. */
  workspaces: MeWorkspace[];
  /** Workspace used when a request has no X-Workspace-Id (the pairing code's workspace, else the first one). */
  currentWorkspaceId: string | null;
  /** Public URL of the instance (use it as the API base). */
  server: string;
}

/** Notification preferences of one device. */
export interface DevicePrefsDTO {
  /** A post was published (default on). */
  published: boolean;
  /** A post failed or needs a check (default on). */
  failed: boolean;
  /** Instance admins (instance.users.manage): a new access request arrived (default on). */
  accessRequests: boolean;
  /** Users who answer support chats (instance.support.manage): a customer wrote (default on). */
  support: boolean;
  /** Only these workspaces; null = all the user's workspaces. */
  workspaces: string[] | null;
}

/** GET /api/devices `items`, PUT /api/devices/me, PATCH /api/devices/me/prefs. */
export interface DeviceDTO {
  id: string;
  name: string | null;
  /** An APNs token is registered (notifications on). */
  push: boolean;
  environment: "production" | "sandbox";
  prefs: DevicePrefsDTO;
  createdAt: number;
  /** Last request made with the device token (updated at most every 10 minutes). */
  lastSeenAt: number | null;
  lastPushAt: number | null;
  /** The device making the request. */
  current?: true;
}

/** POST /api/pairing-codes: `url` is the QR payload (postflare://pair?s=<server>&c=<code>). */
export interface PairingCodeDTO {
  id: string;
  /** 10 characters (A-Z without I/O, 2-9), shown as XXXXX-XXXXX; the app accepts it with or without the dash. */
  code: string;
  url: string;
  expiresAt: number;
}

/** GET /api/pairing-codes/:id */
export interface PairingStatusDTO {
  status: "pending" | "used" | "expired";
  /** Name of the device that used the code. */
  deviceName: string | null;
  expiresAt: number;
}

/** POST /api/auth/app-login: `qr` for kind qr, `number` for kind push. Keep `secret` in the page only. */
export interface AppLoginStartDTO {
  id: string;
  secret: string;
  qr?: string;
  number?: number;
  expiresAt: number;
}

/** GET /api/auth/app-login/:id (X-Login-Secret). `signed_in`: this response set the session cookie. */
export interface AppLoginPollDTO {
  status: "pending" | "approved" | "denied" | "consumed" | "expired" | "signed_in";
  expiresAt: number;
}

/** POST /api/auth/app-login/:id/inspect (the app): what the approval sheet shows. */
export interface AppLoginInspectDTO {
  kind: "qr" | "push";
  ip: string | null;
  city: string | null;
  country: string | null;
  browser: string;
  os: string;
  /** Public URL of the instance: the app refuses requests for another server than its own. */
  server: string;
  createdAt: number;
  expiresAt: number;
  /** Push only: the number shown on the web page and two others, shuffled. */
  numbers?: number[];
}

/** Post counts by status in a period (GET /api/overview `periods`). */
export type PeriodCounts = Partial<Record<PostStatus, number>>;

/** GET /api/overview: the dashboard (web) and the app's home screen. */
export interface OverviewDTO {
  /** Posts by status, all time. */
  counts: Partial<Record<PostStatus, number>>;
  /**
   * By status, of posts whose time (published_at for published ones, else scheduled time or creation) falls in the
   * period. Periods start at `todayStart` / `weekStart` (query parameters, ms; default: UTC midnight and UTC Monday).
   */
  periods: { today: PeriodCounts; week: PeriodCounts; todayStart: number; weekStart: number };
  /** Being published, then scheduled, soonest first (10). */
  upcoming: PostDTO[];
  /** Latest results: published, failed, needs_check (10). */
  recent: PostDTO[];
  /** Latest failed and needs_check posts (5): what needs attention. */
  failures: PostDTO[];
  accounts: { total: number; reconnect: number };
}

/** GET / PUT / DELETE /api/admin/turnstile: bot protection (Cloudflare Turnstile). The secret is never returned. */
export interface AdminTurnstileDTO {
  /** Both keys are present: the bot check is on. */
  configured: boolean;
  siteKey: string | null;
  /** The TURNSTILE_SITE_KEY var is set (wins over the stored key; read-only in the UI). */
  siteKeyFromEnv: boolean;
  secretSet: boolean;
  /** The TURNSTILE_SECRET_KEY secret is set (wins over the stored one; read-only in the UI). */
  secretFromEnv: boolean;
}

/** Body of PUT /api/admin/turnstile: omitted or empty `secretKey` keeps the stored secret. */
/**
 * GET / PUT /api/admin/legal: who runs the instance, shown on /privacy/, /terms/ and /data-deletion/ (worker/lib/legal.ts).
 * null = not set (the pages keep the generic wording). PUT takes the same shape; "" or null clears a value.
 */
export interface AdminLegalDTO {
  /** A person or a company, e.g. "Jane Doe" or "Acme Ltd". */
  operatorName: string | null;
  contactEmail: string | null;
  /** Optional, may span several lines. */
  postalAddress: string | null;
  /** Optional; also names the governing law in the Terms. */
  country: string | null;
  /** YYYY-MM-DD shown as "Last updated" (default: the date of the current wording). */
  effectiveDate: string | null;
}

export interface AdminTurnstileInput {
  siteKey?: string;
  secretKey?: string;
}

/** POST /api/admin/turnstile/test: siteverify with a dummy token. `testing`: a Turnstile test secret (always passes). */
export type TurnstileTestDTO = { ok: true; testing?: true } | { ok: false; error: string };

/** GET / PATCH /api/admin/email: sign-in links by email (Cloudflare Email Sending). */
export interface AdminEmailDTO {
  /** The EMAIL send_email binding and the EMAIL_FROM var are both set. */
  configured: boolean;
  /** EMAIL_FROM, null when unset. */
  from: string | null;
  /** The instance admin toggle (setting magic_link_enabled, off by default). */
  enabled: boolean;
}

/** Body of POST /api/auth/setup */
export interface SetupInput {
  name: string;
  email: string;
  password: string;
  workspaceName?: string;
  /** Required when the deployment sets the SETUP_TOKEN secret. */
  setupToken?: string;
}

/** GET /api/keys: own keys in the current workspace (all keys of the workspace for instance admins). */
export interface ApiKeyDTO {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  userId: string | null;
  userName: string | null;
}

/** Response of POST /api/keys (the token is only shown once). */
export interface CreatedApiKeyDTO {
  id: string;
  token: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Analytics API

/** Totals over a range of published posts. Engagement rate = engagements / exposure of the posts that report one. */
export interface AnalyticsTotals {
  /** Posts published in the range. */
  posts: number;
  /** Posts that have metrics. */
  postsWithMetrics: number;
  views: number;
  impressions: number;
  reach: number;
  engagements: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  /** Minutes watched (YouTube, Instagram reels), summed over the posts. */
  watchTimeMinutes: number;
  /** engagements / exposure (views, else impressions, else reach) over posts reporting an exposure; null if none. */
  engagementRate: number | null;
  /** Sum of the latest follower counts of the accounts (at the end of the range). */
  followers: number | null;
  /** Followers at the end minus followers at the start of the range (accounts with both values). */
  followersChange: number | null;
  /** Posts with a tracked App Store link. */
  campaignPosts: number;
  /** Clicks on their tracked links (bots filtered roughly). */
  clicks: number;
  /** App Store first-time downloads attributed to their campaign tokens (Apple App Analytics via Revflare). */
  downloads: number;
  redownloads: number;
  /** Apple's proceeds estimate for those downloads, in `currency` of the summary. */
  proceeds: number;
}

export interface AnalyticsBreakdown extends AnalyticsTotals {
  /** Provider id (provider breakdown) or account id (account breakdown). */
  key: string;
  provider: string;
  /** Account breakdown only. */
  accountId?: string;
  name: string;
  username?: string | null;
}

/**
 * One day of the daily series (day = YYYY-MM-DD in `tz`). The latest metrics of each post count for the day it was
 * published on (not the days the views happened: platforms only report lifetime totals per post).
 */
export interface AnalyticsDay {
  day: string;
  /** Posts published that day. */
  posts: number;
  /** Exposure of those posts: views, else impressions, else reach (per post). */
  views: number;
  engagements: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

export interface FollowerSeries {
  accountId: string;
  provider: string;
  name: string;
  /** One point per collected UTC day. */
  points: Array<{ day: string; followers: number }>;
}

/** GET /api/analytics/summary */
export interface AnalyticsSummaryDTO {
  from: number;
  to: number;
  tz: string;
  totals: AnalyticsTotals;
  /** The same totals for the period of equal length right before `from`. */
  previous: AnalyticsTotals;
  byProvider: AnalyticsBreakdown[];
  byAccount: AnalyticsBreakdown[];
  daily: AnalyticsDay[];
  followers: FollowerSeries[];
  /** Currency of `proceeds` (the Revflare workspace currency), null before the first sync. */
  currency: string | null;
}

/** GET /api/analytics/posts item */
export interface AnalyticsPostDTO {
  id: string;
  groupId: string;
  accountId: string;
  provider: string;
  accountName: string;
  accountUsername: string | null;
  /** First 280 characters of the content. */
  excerpt: string;
  /** Media ids (thumbnails: /api/media/:id). */
  media: string[];
  externalId: string | null;
  externalUrl: string | null;
  publishedAt: number;
  /** Latest metrics, null when none collected yet. */
  metrics: MetricValues | null;
  metricsAt: number | null;
  /** Next scheduled collection, null when collection stopped (older than 90 days, or too many failures). */
  metricsNextAt: number | null;
  engagements: number;
  engagementRate: number | null;
  /** Tracked link results (null when the post has no tracked link). */
  campaign: CampaignResultsDTO | null;
}

/** GET /api/posts/:id/metrics */
export interface PostMetricsDTO {
  postId: string;
  publishedAt: number | null;
  metrics: MetricValues | null;
  metricsAt: number | null;
  metricsNextAt: number | null;
  /** Snapshots, oldest first (without `details`: the latest details are in `details`). */
  snapshots: Array<{ capturedAt: number; metrics: MetricValues }>;
  /** Structured analytics of the latest snapshot that has them (YouTube retention curve, traffic sources), else null. */
  details?: MetricDetails | null;
  /** When `details` were captured. */
  detailsAt?: number | null;
  /** Tracked link results (null when the post has no tracked link). */
  campaign?: CampaignResultsDTO | null;
}

/** Body of POST /api/analytics/refresh: exactly one of them. */
export interface AnalyticsRefreshInput {
  postId?: string;
  accountId?: string;
}

/** Response of POST /api/analytics/refresh */
export interface AnalyticsRefreshDTO {
  /** postId refresh: the post with its updated metrics. */
  post?: AnalyticsPostDTO;
  /** accountId refresh: the account's analytics state, and how many of its posts were refreshed. */
  account?: { id: string; metricsStatus: AccountMetricsStatusDTO; postsRefreshed: number };
}

/** GET /api/version (public). `apiVersion` changes only on breaking REST API changes. */
export interface VersionDTO {
  version: string;
  commit: string;
  apiVersion: number;
}

/** GET /api/updates (instance admins): the running version and the newest server release on GitHub. */
export interface UpdateStatusDTO {
  current: string;
  commit: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Release notes of `latest`. */
  url: string | null;
  publishedAt: number | null;
  checkedAt: number | null;
  /** Last check failed (rate limit, network...); `latest` is then the last known value. */
  error: string | null;
  /** False with UPDATE_CHECK="false". */
  enabled: boolean;
  /** GitHub repository checked (owner/name, UPDATE_REPO). */
  repo: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Admin → Overview (GET /api/admin/overview?days=30, permission instance.overview.view). Days are UTC.

export type QuotaLevel = "ok" | "warning" | "critical";

export interface AdminQuotaDTO {
  key: "workflow_steps" | "d1_rows_written" | "r2_storage" | "images_transformations";
  label: string;
  /** Measured or estimated usage (see `estimate`). */
  used: number;
  /** Projection to the end of the period (e.g. steps incl. posts still scheduled today), when meaningful. */
  projected: number | null;
  limit: number;
  unit: "count" | "bytes";
  /** "day" (UTC), "month" (UTC calendar month) or "total" (storage). */
  period: "day" | "month" | "total";
  /** True when the figure is derived from counts × typical costs rather than measured. */
  estimate: boolean;
  /** ok < 70 % ≤ warning < 90 % ≤ critical (of the larger of used / projected). */
  level: QuotaLevel;
  note: string;
}

export interface AdminProviderStatsDTO {
  provider: string;
  /** Posts published in the range (posts table). */
  published: number;
  /** Posts currently failed or needing a check (posts table, opened in the range). */
  failed: number;
  /** Publish attempts in the range (usage_events): outcomes. */
  attempts: { published: number; failed: number; needsCheck: number };
  /** published / all attempts (usage_events), null without attempts. */
  successRate: number | null;
  /** Attempts whose text had a URL (X bills these ~13x). */
  withUrl: number;
}

export interface AdminWorkspaceRowDTO {
  id: string;
  name: string;
  isDemo: boolean;
  members: number;
  accounts: number;
  apiKeys: number;
  /** Published in the range. */
  published: number;
  publishedAllTime: number;
  scheduled: number;
  failed: number;
  needsCheck: number;
  storageBytes: number;
  createdAt: number;
  /** Latest post change (null without posts). */
  lastActivity: number | null;
}

export interface AdminCronDTO {
  name: "frequent" | "metrics" | "daily";
  schedule: string;
  lastRunAt: number | null;
  durationMs: number | null;
  /** No run for more than twice the interval. */
  stale: boolean;
}

export interface AdminOverviewDTO {
  generatedAt: number;
  range: { days: number; from: number; to: number };
  counts: {
    /** Excluding demo workspaces. */
    workspaces: number;
    demoWorkspaces: number;
    users: { active: number; disabled: number; demo: number; pending: number };
    apiKeys: number;
    accounts: { total: number; byStatus: { active: number; reconnect: number; disabled: number }; byProvider: Array<{ provider: string; active: number; reconnect: number; disabled: number }> };
  };
  /** Non-demo workspaces. */
  posts: {
    publishedAllTime: number;
    publishedToday: number;
    published7d: number;
    publishedRange: number;
    /** Still scheduled for today (UTC), overdue ones included. */
    scheduledToday: number;
    scheduledNext24h: number;
    failed: number;
    needsCheck: number;
    drafts: number;
    publishing: number;
    /** One entry per day of the range: published (posts) and failed attempts (usage_events: failed + needs_check). */
    daily: Array<{ day: string; published: number; failed: number }>;
    byProvider: AdminProviderStatsDTO[];
    topWorkspaces: Array<{ id: string; name: string; published: number }>;
  };
  /** The demo workspace(s), apart from the totals above. */
  demo: { enabled: boolean; publishedRange: number; publishedToday: number; scheduled: number };
  health: {
    lastErrors: Array<{ provider: string | null; workspaceId: string | null; workspaceName: string | null; postId: string | null; kind: string; outcome: string; message: string | null; at: number }>;
  };
  quotas: AdminQuotaDTO[];
  system: {
    update: UpdateStatusDTO;
    crons: AdminCronDTO[];
    demoMode: boolean;
    mediaRetentionDays: number;
    experimentalIntegrations: boolean;
    /** Usage metering keeps this many days. */
    usageRetentionDays: number;
    /** First day with usage_events (metering started), null when empty. */
    meteringSince: string | null;
  };
  workspaces: AdminWorkspaceRowDTO[];
  /** Hosted mode (docs/hosted-spec.md): subscription numbers of non-demo, non-exempt workspaces. */
  billing: AdminOverviewBillingDTO;
}

export interface AdminOverviewBillingDTO {
  /** Billing is on (enabled, provider configured, a paid plan exists). */
  enabled: boolean;
  /** Paid through a provider: active, past_due, or canceled before the end of the paid period. */
  paying: number;
  trialing: number;
  pastDue: number;
  /** Plan assigned by an instance admin (provider "manual"), not counted in MRR. */
  manual: number;
  exempt: number;
  /** Monthly recurring revenue estimate in cents: monthly prices + yearly prices / 12 of paying workspaces. */
  mrrCents: number;
  /** Currency of the MRR estimate (the most used plan currency; plans in other currencies are summed as is). */
  currency: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Playbooks (worker/lib/playbooks.ts, shared/playbooks.ts)

export type PlaybookGoal = "engagement" | "reach" | "clicks" | "followers" | "conversions";
export type PlaybookFormat = "text" | "thread" | "image" | "carousel" | "video";

/** A playbook in lists and searches (no body). */
export interface PlaybookSummaryDTO {
  /** Built-in: its kebab id (e.g. "launch-announcement"). Custom: pbk_... */
  id: string;
  /** Kebab-case handle (built-ins: the id). */
  slug: string;
  /** Latest version. */
  version: number;
  name: string;
  summary: string;
  goal: PlaybookGoal;
  /** Provider ids and groups (short-video, microblog, professional, visual, all). */
  platforms: string[];
  formats: PlaybookFormat[];
  tags: string[];
  /** What the writer must know (or ask) before writing. */
  inputs: string[];
  builtin: boolean;
  /** Custom playbooks duplicated from a built-in: "<id>@<version>". */
  basedOn: string | null;
  archived: boolean;
  updatedAt: number | null;
  /** Search relevance (GET /api/playbooks?q=). */
  score?: number;
}

/** GET /api/playbooks/:id */
export interface PlaybookDTO extends PlaybookSummaryDTO {
  /** The version returned (latest unless ?version=). */
  version: number;
  latestVersion: number;
  /** Every version that can be fetched with ?version= (built-ins: only the bundled one). */
  versions: number[];
  /** Markdown body (When to use, Structure, Platform notes, Hooks, Examples, Avoid, Checklist). */
  body: string;
  /** The playbook as a Markdown file with frontmatter (duplicate, export, `pf playbooks show`). */
  markdown: string;
  /** Items of the Checklist section. */
  checklist: string[];
  /** Ready-to-use prompt for an AI agent: the playbook, this workspace's target accounts and limits, attribution. */
  prompt: string;
}

/** Body of POST /api/playbooks and PATCH /api/playbooks/:id (PATCH: every field optional). Or `markdown` with frontmatter. */
export interface PlaybookInput {
  slug?: string;
  name?: string;
  summary?: string;
  goal?: PlaybookGoal;
  platforms?: string[];
  formats?: PlaybookFormat[];
  tags?: string[];
  inputs?: string[];
  body?: string;
  /** A whole playbook file (frontmatter + body); its fields are used when the others are absent. */
  markdown?: string;
}

/** insufficient: < 5 posts, low: 5–19, ok: ≥ 20. */
export type PlaybookConfidence = "insufficient" | "low" | "ok";

/** One row of the playbook ranking (a playbook, one of its versions or variants, or the no-playbook baseline). */
export interface PlaybookStatsRow {
  /** null: posts without a playbook. */
  playbookId: string | null;
  name: string;
  builtin: boolean;
  /** Version rows only. */
  version?: number | null;
  /** Variant rows only (null = posts of the playbook without a variant label). */
  variant?: string | null;
  /** Published posts with metrics in the range. */
  posts: number;
  accounts: number;
  /** Median / mean engagement rate (engagements ÷ views, else impressions, else reach) of posts that report an exposure. */
  medianEngagementRate: number | null;
  meanEngagementRate: number | null;
  /** Median exposure (views, else impressions, else reach). */
  medianViews: number | null;
  /**
   * Median of (post metric ÷ the same account's baseline median) − 1: 0.25 = 25 % above the account's usual.
   * Metric: engagement rate (engagements for accounts whose platform reports no exposure).
   */
  lift: number | null;
  /** Posts that have a lift value (account baseline available). */
  liftPosts: number;
  confidence: PlaybookConfidence;
  /** Posts with a tracked App Store link, their clicks, downloads and proceeds (Apple App Analytics via Revflare). */
  campaignPosts: number;
  clicks: number;
  downloads: number;
  proceeds: number;
  /** downloads / proceeds ÷ campaignPosts (null without tracked posts). */
  downloadsPerPost: number | null;
  proceedsPerPost: number | null;
}

/** GET /api/playbooks/stats?sort= */
export type PlaybookStatsSort = "lift" | "downloads" | "proceeds" | "downloadsPerPost" | "proceedsPerPost";

/** GET /api/playbooks/stats */
export interface PlaybookStatsDTO {
  from: number;
  to: number;
  days: number;
  platform: string | null;
  accountId: string | null;
  /** Published posts with metrics that were analyzed. */
  postsAnalyzed: number;
  /** True when the range had more posts than the cap (the most recent ones were analyzed). */
  capped: boolean;
  /** Posts without a playbook. */
  baseline: PlaybookStatsRow;
  /** Best first (rows with enough posts before insufficient ones, then by lift). */
  playbooks: Array<PlaybookStatsRow & { versions: PlaybookStatsRow[]; variants: PlaybookStatsRow[] }>;
  /** How the numbers are computed (shown as a disclaimer: correlation, not causation). */
  method: string;
  /** How `playbooks` is sorted. */
  sort: PlaybookStatsSort;
  /** Currency of `proceeds`, null before the first Revflare sync. */
  currency: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// App Store campaign links (worker/lib/campaigns.ts, worker/lib/revflare.ts, shared/campaigns.ts)

/** GET /api/apps item: an App Store app of the workspace. */
export interface AppDTO {
  id: string;
  appStoreId: string;
  name: string;
  iconUrl: string | null;
  /** Imported from Revflare (its app id there). */
  revflareAppId: string | null;
  createdAt: number;
}

/** Body of POST /api/apps: an App Store id (name and icon are looked up on the App Store when not given). */
export interface AppInput {
  appStoreId: string;
  name?: string;
  iconUrl?: string | null;
}

/** GET /api/campaigns/settings (workspace). The Revflare API key is never returned: only whether it is set. */
export interface CampaignSettingsDTO {
  /** Apple provider token (pt=), null when not set. */
  providerToken: string | null;
  /** Replace App Store URLs / append the tracked link by default. */
  autoLink: boolean;
  revflare: {
    url: string | null;
    keyConfigured: boolean;
    status: "ok" | "error" | null;
    message: string | null;
    syncedAt: number | null;
    nextSyncAt: number | null;
    currency: string | null;
  };
  /** Base of tracked links, e.g. https://postflare.example.com/a/ */
  linkBase: string;
}

/** Body of PUT /api/campaigns/settings (every field optional; revflareKey: "" or null removes the connection). */
export interface CampaignSettingsInput {
  providerToken?: string | null;
  autoLink?: boolean;
  revflareUrl?: string | null;
  revflareKey?: string | null;
}

/** POST /api/campaigns/test */
export interface RevflareTestDTO {
  ok: boolean;
  error?: string;
  /** Apps in the Revflare workspace (those with an App Store id). */
  apps?: number;
  currency?: string;
}

/** Results of a tracked link: Postflare clicks and Apple's numbers for its campaign token. */
export interface CampaignResultsDTO {
  clicks: number;
  /** First-time downloads (Apple App Analytics). Null until Revflare reported the token. */
  downloads: number | null;
  redownloads: number | null;
  /** App Store purchases (units). */
  purchases: number | null;
  proceeds: number | null;
  sales: number | null;
  currency: string | null;
  /** Latest report day with this token (YYYY-MM-DD). */
  asOf: string | null;
}

/** A tracked link (GET /api/campaigns/links, PostDTO.campaign). */
export interface CampaignLinkDTO extends CampaignResultsDTO {
  code: string;
  kind: "post" | "bio";
  /** https://<host>/a/<code> */
  trackedUrl: string;
  /** The App Store campaign link it redirects to. */
  appStoreUrl: string;
  ct: string;
  postId: string | null;
  accountId: string | null;
  provider: string;
  appId: string;
  appStoreId: string;
  createdAt: number;
}

/** POST /api/campaigns/sync */
export interface CampaignSyncDTO {
  ok: boolean;
  error?: string;
  /** Campaign tokens stored (pf-... only). */
  campaigns?: number;
  currency?: string;
  asOf?: string | null;
}

/**
 * Shown next to App Store numbers: Apple leaves out small counts (fewer than 5 users) in the Detailed reports
 * campaign data comes from and adds a little noise; each day is complete after 2-3 days.
 */
export const CAMPAIGN_DATA_NOTE =
  "App Store numbers come from Apple App Analytics (via Revflare): they lag 2-3 days, Apple withholds small numbers (fewer than 5 users) for privacy, and proceeds are Apple's estimate.";

// ---------------------------------------------------------------------------------------------------------------
// Hosted mode: sign-up, plans, subscriptions and billing (docs/hosted-spec.md, worker/billing/). Off by default.

export type BillingProviderId = "polar" | "stripe" | "lemonsqueezy";
/** `manual`: plan assigned by an instance admin (Admin → Workspaces), no provider subscription. */
export type BillingSource = BillingProviderId | "manual";
export type BillingInterval = "month" | "year";
/** canceled = paid until `currentPeriodEnd`, then the free plan / locked. expired = ended. */
export type BillingStatus = "none" | "trialing" | "active" | "past_due" | "canceled" | "expired";
/**
 * Effective state of a workspace: unlimited (billing off or exempt), plan (paid or manual), trial, free (the plan marked
 * free), locked (read-only: nothing new can be created, scheduled or published).
 */
export type BillingState = "unlimited" | "plan" | "trial" | "free" | "locked";

/** Limit keys of Postflare plans (`plans.limits`; absent or null = unlimited). */
export type PlanLimitKey = "accounts" | "posts_per_month" | "x_posts_per_month" | "members" | "storage_mb" | "api";
export type PlanLimits = Partial<Record<Exclude<PlanLimitKey, "api">, number | null>> & { api?: boolean | null };

/** Catalog entry of a limit key (GET /api/admin/billing `limits`, for the plan editor). */
export interface PlanLimitInfo {
  key: PlanLimitKey;
  label: string;
  /** "count" limits are whole numbers (0 allowed), "boolean" ones on/off. */
  kind: "count" | "boolean";
  description: string;
}

/** Product / price / variant ids of a plan per provider and interval (pasted from the provider's dashboard). */
export type ProviderPrices = Partial<Record<BillingProviderId, Partial<Record<BillingInterval, string>>>>;

/** A plan as shown on pricing tables (GET /api/billing/plans, GET /api/billing `plans`). */
export interface PublicPlanDTO {
  id: string;
  name: string;
  description: string;
  /** Display strings ("10 accounts", "Priority support"). */
  features: string[];
  limits: PlanLimits;
  /** Integer cents; null = interval not offered. */
  priceMonth: number | null;
  priceYear: number | null;
  currency: string;
  isFree: boolean;
  isTrialDefault: boolean;
  /** "Most popular" badge. */
  highlight: boolean;
  position: number;
  /** Intervals that can be bought right now (price set and a product id for the active provider). */
  checkoutIntervals: BillingInterval[];
}

/** A plan in Admin → Billing (GET/POST/PATCH /api/admin/billing/plans). */
export interface AdminPlanDTO extends Omit<PublicPlanDTO, "checkoutIntervals"> {
  providerPrices: ProviderPrices;
  /** Archived plans (false) keep their subscribers but are not sold. */
  active: boolean;
  /** Workspaces on this plan (any status). */
  workspaces: number;
  createdAt: number;
  updatedAt: number;
}

/** Body of POST /api/admin/billing/plans (all fields) and PATCH /api/admin/billing/plans/:id (any subset). */
export interface PlanInput {
  name: string;
  description?: string;
  features?: string[];
  limits?: PlanLimits;
  priceMonth?: number | null;
  priceYear?: number | null;
  currency?: string;
  providerPrices?: ProviderPrices;
  /** At most one plan is free and one is the trial default: setting it clears the others. */
  isFree?: boolean;
  isTrialDefault?: boolean;
  highlight?: boolean;
  position?: number;
  active?: boolean;
}

/** GET /api/billing/plans (public): the pricing table. `plans` is empty while billing is off. */
export interface PublicPlansDTO {
  enabled: boolean;
  /** Currency of the first plan (USD when there is none). */
  currency: string;
  plans: PublicPlanDTO[];
}

/** Usage of a workspace next to its limits (GET /api/billing `usage`). */
export interface BillingUsageDTO {
  accounts: number;
  /** Posts published or scheduled in the current UTC month (the `posts_per_month` count). */
  postsThisMonth: number;
  xPostsThisMonth: number;
  /** Members + pending invitations. */
  members: number;
  storageMb: number;
}

/** GET /api/billing: the current workspace's plan, status, usage and the plans it can buy. */
export interface BillingDTO {
  /** Billing is on for the instance. When false everything else is informational and the UI hides billing. */
  enabled: boolean;
  /** Comped workspace (or the demo): never limited. */
  exempt: boolean;
  state: BillingState;
  /** Effective plan (the trial plan while trialing, the free plan when it applies), null when unlimited or locked. */
  plan: PublicPlanDTO | null;
  /** Plan stored on the workspace (subscription / trial / manual), even when it no longer applies. */
  subscribedPlanId: string | null;
  status: BillingStatus;
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  /** End of the past-due grace period (past_due only). */
  graceEndsAt: number | null;
  interval: BillingInterval | null;
  provider: BillingSource | null;
  /** A provider subscription exists: change plans in the portal ("Manage billing"), not through checkout. */
  hasSubscription: boolean;
  /** Null while billing is off. */
  usage: BillingUsageDTO | null;
  /** Effective limits; null = unlimited. Locked workspaces get null too (check `state`). */
  limits: PlanLimits | null;
  plans: PublicPlanDTO[];
  /** The user has billing.manage (upgrade, portal). */
  canManage: boolean;
}

/** Body of POST /api/billing/checkout → `{ url }` (redirect the browser there). */
export interface CheckoutInput {
  planId: string;
  interval: BillingInterval;
}

/** 402 answer of an action blocked by the plan (locked workspace or limit reached). */
export interface PlanLimitErrorDTO {
  error: string;
  code: "plan_limit";
  /** The limit key, or "locked" when the workspace has no active plan. */
  limit: PlanLimitKey | "locked";
  used: number | null;
  max: number | boolean | null;
  /** Billing tab of the workspace settings. */
  upgradeUrl: string;
}

/** A credential field of a provider card in Admin → Billing. */
export interface BillingProviderFieldDTO {
  key: string;
  label: string;
  secret: boolean;
  help?: string;
  /** A value is stored (secrets are never returned). */
  set: boolean;
  /** Current value of non-secret fields (null for secrets and unset fields). */
  value: string | null;
}

export interface AdminBillingProviderDTO {
  id: BillingProviderId;
  name: string;
  /** Polar: merchant of record, handles VAT/sales tax, no Stripe account needed. */
  recommended: boolean;
  description: string;
  /** Every required field is set. */
  configured: boolean;
  /** Polar sandbox (sandbox-api.polar.sh); null for providers without a separate sandbox API. */
  sandbox: boolean | null;
  /** Paste into the provider's webhook settings. */
  webhookUrl: string;
  /** Webhook events to subscribe to. */
  events: string[];
  fields: BillingProviderFieldDTO[];
  /** The provider's dashboard page where products/prices and webhooks are created. */
  dashboardUrl: string;
}

/** GET / PATCH /api/admin/billing (instance.settings.manage). */
export interface AdminBillingDTO {
  /** The admin switch (setting billing_enabled). */
  enabled: boolean;
  /** Billing is in effect: enabled AND the active provider is configured AND an active paid plan exists. */
  active: boolean;
  /** Why billing cannot be (or is not) in effect; empty when active. */
  problems: string[];
  /** Provider used for new checkouts (null = none chosen). */
  activeProvider: BillingProviderId | null;
  providers: AdminBillingProviderDTO[];
  trialDays: number;
  pastDueGraceDays: number;
  signupEnabled: boolean;
  /** EMAIL binding + EMAIL_FROM: sign-ups are verified by email (otherwise immediate). */
  emailConfigured: boolean;
  limits: PlanLimitInfo[];
}

/** Body of PATCH /api/admin/billing (any subset). Enabling is refused (400) until a provider and a paid plan exist. */
export interface AdminBillingInput {
  enabled?: boolean;
  activeProvider?: BillingProviderId | null;
  trialDays?: number;
  pastDueGraceDays?: number;
  signupEnabled?: boolean;
}

/** Body of PUT /api/admin/billing/providers/:id. Omitted or empty secret fields keep their stored value. */
export interface BillingProviderInput {
  values: Record<string, string>;
  /** Polar only. */
  sandbox?: boolean;
}

/** POST /api/admin/billing/providers/:id/test */
export type BillingProviderTestDTO = { ok: true; account?: string } | { ok: false; error: string };

/** Billing of one workspace for instance admins (GET/PATCH /api/admin/workspaces/:id/billing, GET /api/admin/billing/workspaces). */
export interface AdminWorkspaceBillingDTO {
  workspaceId: string;
  workspaceName: string;
  demo: boolean;
  exempt: boolean;
  state: BillingState;
  planId: string | null;
  planName: string | null;
  status: BillingStatus;
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  interval: BillingInterval | null;
  provider: BillingSource | null;
  customerId: string | null;
  subscriptionId: string | null;
  updatedAt: number | null;
  createdAt: number;
  /** Platforms the workspace may connect and post to; null = every platform. */
  allowedProviders: string[] | null;
}

/** Body of PATCH /api/admin/workspaces/:id/billing (instance.users.manage). A plan set here is provider "manual". */
export interface AdminWorkspaceBillingInput {
  exempt?: boolean;
  /** null removes the plan (status none). */
  planId?: string | null;
  status?: BillingStatus;
  trialEndsAt?: number | null;
  currentPeriodEnd?: number | null;
  /** Platforms the workspace may use (provider ids); null = every platform. */
  allowedProviders?: string[] | null;
}

/**
 * How people get an account (instance setting signup_mode): `off` = by invitation only (default), `apply` = they
 * request access on /apply and an instance admin approves each request (docs/hosted-spec.md "Access requests"),
 * `open` = public sign-up on /signup.
 */
export type SignupMode = "off" | "apply" | "open";

/** GET / PATCH /api/admin/signup (instance.settings.manage): the "Sign-up" card. PATCH takes `{ mode }` (or the older `{ enabled }`). */
export interface AdminSignupDTO {
  mode: SignupMode;
  /** mode === "open" (kept for older clients). */
  enabled: boolean;
  /** Without email, sign-up is immediate (no verification): hosted instances should configure email first. */
  emailConfigured: boolean;
}

/** Body of POST /api/auth/signup */
export interface SignupInput {
  name: string;
  email: string;
  password: string;
  workspaceName?: string;
  /** Cloudflare Turnstile token, required when the status has `turnstileSiteKey`. */
  turnstileToken?: string;
}

/**
 * POST /api/auth/signup → `{ ok: true, verify: true }` (a confirmation link was emailed; the same answer whether or not
 * the email already has an account) or `{ ok: true, verify: false, workspaceId }` (no email configured: signed in).
 */
export type SignupDTO = { ok: true; verify: true } | { ok: true; verify: false; workspaceId: string };

// ---------------------------------------------------------------------------------------------------------------
// Access requests ("Request access" on /apply, signup_mode apply; docs/hosted-spec.md "Access requests")

export const ACCESS_REQUEST_ROLES = ["creator", "agency", "startup", "brand", "other"] as const;
/** Creator · Agency · Startup / app developer · Brand / marketing team · Other */
export type AccessRequestRole = (typeof ACCESS_REQUEST_ROLES)[number];
export const ACCESS_REQUEST_PLATFORMS = ["x", "instagram", "tiktok", "youtube", "linkedin", "facebook", "threads", "bluesky", "pinterest", "other"] as const;
export type AccessRequestPlatform = (typeof ACCESS_REQUEST_PLATFORMS)[number];
/** Posts per month: 1-30, 31-100, 101-300, 301-1000, more than 1000. */
export const ACCESS_REQUEST_VOLUMES = ["1-30", "31-100", "101-300", "301-1000", "1000+"] as const;
export type AccessRequestVolume = (typeof ACCESS_REQUEST_VOLUMES)[number];
export type AccessRequestStatus = "pending" | "approved" | "rejected" | "withdrawn";

/** Body of POST /api/access-requests (public). Answers `{ ok: true }` whether or not the email applied before or has an account. */
export interface AccessRequestInput {
  name: string;
  email: string;
  company?: string;
  /** Website or main social profile (http/https URL). */
  url: string;
  role: AccessRequestRole;
  platforms: AccessRequestPlatform[];
  /** Social accounts they plan to connect (0-1000). */
  accounts?: number;
  volume?: AccessRequestVolume;
  /** 20-1000 characters. */
  useCase: string;
  /** How they heard about Postflare (optional, ≤ 200 characters). */
  referral?: string;
  /** Agreed to the Terms and the Privacy Policy (required). */
  consent: true;
  /** Cloudflare Turnstile token (action "apply"), required when the status has `turnstileSiteKey`. */
  turnstileToken?: string;
}

/** GET /api/access-requests[/:id] (instance.users.manage). */
export interface AccessRequestDTO {
  id: string;
  name: string;
  email: string;
  company: string | null;
  url: string;
  role: AccessRequestRole;
  platforms: AccessRequestPlatform[];
  accounts: number | null;
  volume: AccessRequestVolume | null;
  useCase: string;
  referral: string | null;
  status: AccessRequestStatus;
  ip: string | null;
  /** Two-letter country of the request (Cloudflare), or null. */
  country: string | null;
  userAgent: string | null;
  createdAt: number;
  updatedAt: number;
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: number | null;
  reviewNote: string | null;
  invitationId: string | null;
  /** The invitation was accepted (the applicant has signed up). */
  invitationAccepted: boolean;
  /** An account with this email exists on the instance. */
  existingUser: boolean;
}

/** GET /api/access-requests?status=pending|approved|rejected|withdrawn|all&q=&limit=&before= */
export interface AccessRequestListDTO {
  items: AccessRequestDTO[];
  /** Per status, over every request (ignores q). */
  counts: Record<AccessRequestStatus, number>;
  /** Pass as `before` for the next page (null = no more). */
  nextBefore: number | null;
}

/** Body of PATCH /api/access-requests/:id. Approving an approved request whose invitation is unused makes a new link (the old one stops working). */
export interface AccessRequestReviewInput {
  status: "approved" | "rejected";
  /** Shown to admins; on reject it is included in the email to the applicant. ≤ 1000 characters. */
  note?: string;
  /** Email the applicant (default true; only when email is configured). */
  notify?: boolean;
}

/** PATCH /api/access-requests/:id */
export interface AccessRequestReviewDTO {
  request: AccessRequestDTO;
  /** Approved: the invitation link (email-bound, new workspace, Member role). Absent when the email already has an account. */
  invitation?: CreatedInvitationDTO;
  /** Approved, but the email already has an account: only marked approved. */
  existingUser?: true;
  /** An email went to the applicant. */
  emailed: boolean;
}

// ---------- Support chat (docs/support-spec.md) ----------

export type SupportStatus = "open" | "pending" | "closed";
export type SupportAuthor = "customer" | "staff" | "note";

export interface SupportMessageDTO {
  id: string;
  author: SupportAuthor;
  /** Staff: the user's name ("Ferdi"); customer: their name or null. */
  authorName: string | null;
  body: string;
  createdAt: number;
}

/** A conversation as the customer (widget) sees it. */
export interface SupportConversationDTO {
  id: string;
  number: number;
  status: SupportStatus;
  subject: string | null;
  name: string | null;
  email: string | null;
  /** Staff replies the customer has not seen. */
  unread: number;
  lastMessageAt: number;
  lastMessagePreview: string | null;
  lastAuthor: "customer" | "staff" | null;
  createdAt: number;
}

/** A conversation as staff see it (inbox list and detail). */
export interface SupportTicketDTO extends SupportConversationDTO {
  /** Customer messages no staff member has opened yet. */
  staffUnread: number;
  source: "widget" | "app";
  pageUrl: string | null;
  userAgent: string | null;
  country: string | null;
  ip: string | null;
  user: { id: string; name: string; email: string } | null;
  workspace: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  customerSeenAt: number | null;
  closedAt: number | null;
  updatedAt: number;
}

export interface SupportThreadDTO<C = SupportConversationDTO> {
  conversation: C;
  messages: SupportMessageDTO[];
}

/** GET /api/admin/support/conversations */
export interface SupportTicketListDTO {
  items: SupportTicketDTO[];
  counts: { open: number; pending: number; closed: number; unread: number };
  /** Pass as `before` for the next page (last_message_at of the last item), null at the end. */
  nextBefore: number | null;
}

/** GET /api/support/widget */
export interface SupportWidgetDTO {
  enabled: boolean;
  teamName: string;
  greeting: string;
  /** The signed-in user answers chats (the widget hides itself). */
  staff: boolean;
  /** Signed in on this origin: the widget does not ask for an email. */
  signedIn: boolean;
}

/** GET|PATCH /api/admin/support/settings */
export interface SupportSettingsDTO {
  enabled: boolean;
  teamName: string;
  greeting: string;
  /** Email notifications to customers are possible (EMAIL binding + EMAIL_FROM). */
  emailConfigured: boolean;
  /** `<script>` tag to embed the widget on another website. */
  snippet: string;
}
