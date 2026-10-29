// API shapes used by the CLI (subset of the repo's shared/types.ts, copied so the package builds on its own).

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "textarea" | "password" | "number" | "select" | "checkbox" | "url" | "tags" | "datetime";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: FieldOption[];
  dynamicOptions?: boolean;
  default?: string | number | boolean | string[];
  maxLength?: number;
  showIf?: { key: string; equals: string | boolean | number };
}

export interface ProviderCapabilities {
  maxLength: number;
  text: "required" | "optional" | "none";
  media: { images: number; videos: number; mixed: boolean; required: boolean };
  thread: boolean;
  threadLabel?: string;
  /** What the media is used for when not obvious (YouTube: the image becomes the custom thumbnail). */
  mediaNote?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  category: string;
  auth: "oauth2" | "credentials";
  settingsFields: FieldDef[];
  capabilities: ProviderCapabilities;
  composerNotice?: string;
  docsUrl?: string;
  configured?: boolean;
  /** Server >= the platform-status release; older servers omit it. */
  status?: "verified" | "beta" | "experimental";
  statusNote?: string;
  /** false: an experimental platform that is turned off on the instance (new connections refused). */
  enabled?: boolean;
  analytics?: { post: boolean; account: boolean; metrics: string[] };
}

export type MetricValues = Partial<Record<string, number>> & { extra?: Record<string, number> };

/** Structured post analytics (YouTube): retention [elapsed share 0.01..1, audienceWatchRatio], views per traffic source. */
export interface MetricDetails {
  retention?: Array<[number, number]>;
  trafficSources?: Array<{ source: string; views: number }>;
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
  /** Last reconnect, null if never (absent on older servers). */
  reconnectedAt?: number | null;
  metricsStatus?: { status: string; message: string | null; checkedAt: number | null; metrics: MetricValues | null };
  /** Account group id, null when ungrouped (absent on servers without groups). */
  groupId?: string | null;
}

/** GET /api/account-groups */
export interface AccountGroupDTO {
  id: string;
  name: string;
  color: string;
  position: number;
  accountCount: number;
  createdAt: number;
  updatedAt: number;
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

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "needs_check";

export interface ThreadItem {
  content: string;
  media: string[];
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
  /** Playbook attribution (built-in id or custom pbk_ id), its version and A/B variant. */
  playbookId?: string | null;
  playbookVersion?: number | null;
  variant?: string | null;
  /** App Store app the post is about (workspace app id, GET /api/apps), null when none. Older servers omit it. */
  appId?: string | null;
  /** Per-post override of the workspace's "auto-insert tracked links" setting; null = workspace default. */
  autoLink?: boolean | null;
  /** Tracked link of the post (GET /api/posts/:id only; null without an app or on non-clickable platforms). */
  campaign?: CampaignLinkDTO | null;
  logs?: Array<{ id: number; level: string; message: string; createdAt: number }>;
}

/** Body of POST /api/posts/:id/resolve (only for `needs_check` posts). */
export interface ResolvePostInput {
  /** true: it is live, mark it published (optionally with its URL). false: it is not live, publish it again now. */
  published: boolean;
  /** Link to the live post (published: true only). */
  url?: string | null;
}

export interface CreatePostsInput {
  scheduledAt: number | "now" | null;
  posts: Array<{ accountId: string; content: string; media: string[]; settings: Record<string, unknown>; thread: ThreadItem[] }>;
  playbookId?: string | null;
  playbookVersion?: number | null;
  variant?: string | null;
  /** App Store app: workspace app id (app_...), App Store id or app name; null removes it (PATCH). */
  appId?: string | null;
  /** Override the workspace's auto-insert setting (null/absent = workspace default). */
  autoLink?: boolean | null;
}

export interface AnalyticsTotals {
  posts: number;
  postsWithMetrics: number;
  views: number;
  impressions: number;
  reach: number;
  engagements: number;
  likes: number;
  comments: number;
  shares: number;
  engagementRate: number | null;
  followers: number | null;
  followersChange: number | null;
  /** Posts with a tracked App Store link, their clicks, App Store downloads and proceeds (older servers omit them). */
  campaignPosts?: number;
  clicks?: number;
  downloads?: number;
  redownloads?: number;
  proceeds?: number;
}

export interface AnalyticsBreakdown extends AnalyticsTotals {
  key: string;
  provider: string;
  accountId?: string;
  name: string;
  username?: string | null;
}

export interface AnalyticsSummaryDTO {
  from: number;
  to: number;
  tz: string;
  totals: AnalyticsTotals;
  previous: AnalyticsTotals;
  byProvider: AnalyticsBreakdown[];
  byAccount: AnalyticsBreakdown[];
  daily: Array<{ day: string; posts: number; views: number; engagements: number }>;
  followers: Array<{ accountId: string; provider: string; name: string; points: Array<{ day: string; followers: number }> }>;
  /** Currency of `proceeds`, null before the first Revflare sync. */
  currency?: string | null;
}

export interface AnalyticsPostDTO {
  id: string;
  groupId: string;
  accountId: string;
  provider: string;
  accountName: string;
  accountUsername: string | null;
  excerpt: string;
  media: string[];
  externalId: string | null;
  externalUrl: string | null;
  publishedAt: number;
  metrics: MetricValues | null;
  metricsAt: number | null;
  metricsNextAt: number | null;
  engagements: number;
  engagementRate: number | null;
  /** Tracked link results (null when the post has no tracked link). */
  campaign?: CampaignResultsDTO | null;
}

export interface PostMetricsDTO {
  postId: string;
  publishedAt: number | null;
  metrics: MetricValues | null;
  metricsAt: number | null;
  metricsNextAt: number | null;
  snapshots: Array<{ capturedAt: number; metrics: MetricValues }>;
  /** Servers with YouTube Analytics support; older servers omit them. */
  details?: MetricDetails | null;
  detailsAt?: number | null;
  /** Tracked link results (null when the post has no tracked link). */
  campaign?: CampaignResultsDTO | null;
}

export interface MeDTO {
  user: { id: string; name: string; email: string; role: { id: string; name: string }; demo?: true };
  instancePermissions: string[];
  workspaces: Array<{ id: string; name: string; role: { id: string; name: string }; permissions: string[]; viaAdmin?: true; demo?: true }>;
  currentWorkspaceId: string | null;
}

/** views, else impressions, else reach (what engagement rate is measured against). */
export const exposure = (m: MetricValues | null | undefined): number | null => (m ? m.views ?? m.impressions ?? m.reach ?? null : null);

/** GET /api/version (public). Servers without it answer 404: their version is unknown. */
export interface VersionDTO {
  version: string;
  commit: string;
  apiVersion: number;
}

// Playbooks (GET /api/playbooks, /api/playbooks/:id, /api/playbooks/stats)

export interface PlaybookSummaryDTO {
  id: string;
  slug: string;
  version: number;
  name: string;
  summary: string;
  goal: string;
  platforms: string[];
  formats: string[];
  tags: string[];
  inputs: string[];
  builtin: boolean;
  basedOn: string | null;
  archived: boolean;
  updatedAt: number | null;
  score?: number;
}

export interface PlaybookDTO extends PlaybookSummaryDTO {
  latestVersion: number;
  versions: number[];
  body: string;
  markdown: string;
  checklist: string[];
  prompt: string;
}

export interface PlaybookStatsRow {
  playbookId: string | null;
  name: string;
  builtin: boolean;
  version?: number | null;
  variant?: string | null;
  posts: number;
  accounts: number;
  medianEngagementRate: number | null;
  meanEngagementRate: number | null;
  medianViews: number | null;
  lift: number | null;
  liftPosts: number;
  confidence: "insufficient" | "low" | "ok";
  /** Posts with a tracked App Store link, their clicks, downloads and proceeds (older servers omit them). */
  campaignPosts?: number;
  clicks?: number;
  downloads?: number;
  proceeds?: number;
  downloadsPerPost?: number | null;
  proceedsPerPost?: number | null;
}

/** GET /api/playbooks/stats?sort= */
export type PlaybookStatsSort = "lift" | "downloads" | "proceeds" | "downloadsPerPost" | "proceedsPerPost";

export interface PlaybookStatsDTO {
  from: number;
  to: number;
  days: number;
  platform: string | null;
  accountId: string | null;
  postsAnalyzed: number;
  capped: boolean;
  baseline: PlaybookStatsRow;
  playbooks: Array<PlaybookStatsRow & { versions: PlaybookStatsRow[]; variants: PlaybookStatsRow[] }>;
  method: string;
  sort?: PlaybookStatsSort;
  /** Currency of `proceeds`, null before the first Revflare sync. */
  currency?: string | null;
}

// App Store campaign links (GET /api/apps, /api/campaigns/*)

export interface AppDTO {
  id: string;
  appStoreId: string;
  name: string;
  iconUrl: string | null;
  /** Imported from Revflare (its app id there). */
  revflareAppId: string | null;
  createdAt: number;
}

export interface CampaignSettingsDTO {
  providerToken: string | null;
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
  linkBase: string;
}

/** Results of a tracked link: Postflare clicks and Apple's numbers for its campaign token. */
export interface CampaignResultsDTO {
  clicks: number;
  /** First-time downloads (Apple App Analytics). Null until Revflare reported the token. */
  downloads: number | null;
  redownloads: number | null;
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
  trackedUrl: string;
  appStoreUrl: string;
  ct: string;
  postId: string | null;
  accountId: string | null;
  provider: string;
  appId: string;
  appStoreId: string;
  createdAt: number;
}

export const CAMPAIGN_DATA_NOTE =
  "App Store numbers come from Apple App Analytics (via Revflare): they lag 2-3 days, Apple withholds small numbers (fewer than 5 users) for privacy, and proceeds are Apple's estimate.";

/** Platforms whose captions are not clickable: they use the account's bio link (shared/campaigns.ts). */
export const BIO_LINK_PLATFORMS = new Set(["instagram", "instagram_standalone", "tiktok", "tiktok_business"]);

/** 402 answer of hosted instances when the workspace's plan does not allow an action (shared/types.ts PlanLimitErrorDTO). */
export interface PlanLimitErrorDTO {
  error: string;
  code: "plan_limit";
  limit: "accounts" | "posts_per_month" | "x_posts_per_month" | "members" | "storage_mb" | "api" | "locked";
  used: number | null;
  max: number | boolean | null;
  upgradeUrl: string;
}
