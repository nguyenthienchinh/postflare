/**
 * Postflare's side of worker/billing/ (docs/hosted-spec.md "Host hooks"): the limit keys, their labels and counters.
 * Everything else in worker/billing/ is product-neutral; a port to Adsflare or Revflare rewrites this file, the
 * `PlanLimitKey` / `PlanLimits` / `BillingUsageDTO` types in shared/types.ts and the call sites of `enforce()`.
 *
 * Counters are one indexed COUNT/SUM each and only run when billing is on and the workspace is not exempt.
 *
 * Monthly posts are counted by the UTC calendar month a post is published or scheduled in (`postsSql`), never by
 * creation time, and published posts are read from `usage_events` (which survive deleting the post): deleting a
 * published post never gives the quota back, deleting or cancelling a scheduled one does. Drafts and failed posts are
 * free.
 */
import type { BillingUsageDTO, PlanLimitInfo, PlanLimitKey } from "../../shared/types";

/** The product's name in emails and provider checkouts. */
export const PRODUCT_NAME = "Postflare";

/** Where 402 answers and checkout returns send the user (the web app's Workspace settings → Billing tab). */
export const BILLING_PATH = "/workspace?tab=billing";

export const LIMITS: ReadonlyArray<PlanLimitInfo & { noun: string }> = [
  { key: "accounts", label: "Connected accounts", kind: "count", description: "Social accounts connected in the workspace (disabled ones don't count).", noun: "connected accounts" },
  { key: "posts_per_month", label: "Posts per month", kind: "count", description: "Posts published or scheduled in a UTC calendar month (one per account; drafts and failed posts are free, deleting a published post does not give it back).", noun: "posts this month" },
  { key: "x_posts_per_month", label: "X posts per month", kind: "count", description: "The same, posts to X only (the X API charges per post).", noun: "X posts this month" },
  { key: "members", label: "Members", kind: "count", description: "Workspace members plus pending invitations.", noun: "members (including pending invitations)" },
  { key: "storage_mb", label: "Media storage (MB)", kind: "count", description: "Size of the media library.", noun: "MB of media storage" },
  { key: "api", label: "API and MCP", kind: "boolean", description: "API keys, the CLI and MCP (AI agents).", noun: "API access" },
];

export const LIMIT_KEYS = LIMITS.map((l) => l.key);
export const limitInfo = (key: PlanLimitKey) => LIMITS.find((l) => l.key === key)!;

/** Start of the UTC calendar month of `t` (ms). */
export function monthStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Start of the UTC calendar month after the one of `t` (ms). */
export function nextMonthStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * The period a usage of `key` at time `at` falls in (start ms): the UTC month for the monthly keys, 0 (one period)
 * for the others. `enforce` checks adds of different periods separately.
 */
export const periodOf = (key: PlanLimitKey, at: number) => (key === "posts_per_month" || key === "x_posts_per_month" ? monthStart(at) : 0);

/** YYYY-MM-DD (UTC), the format of `usage_events.day`. */
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Posts that hold a slot in the month they are scheduled in: still to publish (scheduled, publishing) or maybe
 * published (needs_check; the stuck-publishing sweep sets it without a usage event).
 */
const PENDING = "'scheduled', 'publishing', 'needs_check'";

/**
 * SQL counting the posts of month [?2, ?3) (ms) of workspace ?1, ?4 / ?5 being the same month as days (YYYY-MM-DD):
 * every post card with a publish outcome (published or needs_check) in that month, from `usage_events` (rows survive
 * deleting the post; replies are `kind = 'reply'` and never count), plus the posts still to publish (scheduled,
 * publishing, needs_check) scheduled in that month. UNION dedupes by post id, so a post that is both (re-published
 * after a needs_check) or published twice in the month counts once. The usage_events part reads the partial covering
 * index `usage_events_ws_published` (migrations/0014), the posts part `posts_workspace` (workspace_id, scheduled_at).
 */
const postsSql = (xOnly: boolean) => `SELECT COUNT(*) FROM (
    SELECT post_id FROM usage_events
      WHERE workspace_id = ?1 AND day >= ?4 AND day < ?5 AND kind = 'publish' AND outcome IN ('published', 'needs_check')${xOnly ? " AND provider = 'x'" : ""}
    UNION
    SELECT id FROM posts
      WHERE workspace_id = ?1 AND scheduled_at >= ?2 AND scheduled_at < ?3 AND status IN (${PENDING})${
        xOnly ? " AND account_id IN (SELECT id FROM accounts WHERE workspace_id = ?1 AND provider = 'x')" : ""
      }
  )`;

/** Binds of `postsSql` for the month of `t`. */
const monthBinds = (workspaceId: string, t: number) => {
  const from = monthStart(t);
  const to = nextMonthStart(t);
  return [workspaceId, from, to, utcDay(from), utcDay(to)];
};

const MB = 1024 * 1024;

/**
 * Usage of one limit key in a workspace (one query; `api` has no counter): now, or for the monthly keys in the UTC
 * month of `t`. storage_mb is reported in bytes here (limits compare bytes against max * 1 MiB), the DTO rounds to MB.
 */
export async function countUsage(db: D1Database, workspaceId: string, key: PlanLimitKey, t: number): Promise<number> {
  const one = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ n: number | null }>())?.n ?? 0;
  switch (key) {
    case "accounts":
      return one("SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = ? AND status != 'disabled'", workspaceId);
    case "posts_per_month":
    case "x_posts_per_month":
      return one(`SELECT (${postsSql(key === "x_posts_per_month")}) AS n`, ...monthBinds(workspaceId, t));
    case "members":
      return one(
        `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ?1)
           + (SELECT COUNT(*) FROM invitations WHERE workspace_id = ?1 AND accepted_at IS NULL AND expires_at > ?2) AS n`,
        workspaceId,
        t,
      );
    case "storage_mb":
      return one("SELECT COALESCE(SUM(size), 0) AS n FROM media WHERE workspace_id = ?", workspaceId);
    case "api":
      return 0;
  }
}

/** Amount of `adding` in the limit's unit (bytes for storage). */
export const limitMax = (key: PlanLimitKey, max: number) => (key === "storage_mb" ? max * MB : max);

/** Usage meters of GET /api/billing (monthly posts: the current UTC month, same count as the limit): one query. */
export async function usageSummary(db: D1Database, workspaceId: string, t: number): Promise<BillingUsageDTO> {
  const r = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM accounts WHERE workspace_id = ?1 AND status != 'disabled') AS accounts,
           (${postsSql(false)}) AS posts,
           (${postsSql(true)}) AS x_posts,
           (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ?1)
             + (SELECT COUNT(*) FROM invitations WHERE workspace_id = ?1 AND accepted_at IS NULL AND expires_at > ?6) AS members,
           (SELECT COALESCE(SUM(size), 0) FROM media WHERE workspace_id = ?1) AS bytes`,
      )
      .bind(...monthBinds(workspaceId, t), t)
      .first<{ accounts: number; posts: number; x_posts: number; members: number; bytes: number }>();
  return {
    accounts: r?.accounts ?? 0,
    postsThisMonth: r?.posts ?? 0,
    xPostsThisMonth: r?.x_posts ?? 0,
    members: r?.members ?? 0,
    storageMb: Math.round(((r?.bytes ?? 0) / MB) * 10) / 10,
  };
}

/** Starting plans for "Create suggested plans" (never seeded automatically). Prices in cents. */
export const SUGGESTED_PLANS = [
  {
    name: "Free",
    description: "Try Postflare with a few accounts.",
    features: ["3 connected accounts", "30 posts per month", "500 MB media storage"],
    limits: { accounts: 3, posts_per_month: 30, x_posts_per_month: 0, members: 1, storage_mb: 500, api: false },
    priceMonth: null,
    priceYear: null,
    isFree: true,
    position: 0,
  },
  {
    name: "Creator",
    description: "For creators and solo founders.",
    features: ["10 connected accounts", "300 posts per month", "50 X posts per month", "3 members", "5 GB media storage"],
    limits: { accounts: 10, posts_per_month: 300, x_posts_per_month: 50, members: 3, storage_mb: 5 * 1024, api: false },
    priceMonth: 1900,
    priceYear: 19000,
    isTrialDefault: true,
    highlight: true,
    position: 1,
  },
  {
    name: "Team",
    description: "For teams and agencies, with the API and MCP.",
    features: ["30 connected accounts", "1,500 posts per month", "300 X posts per month", "10 members", "20 GB media storage", "API, CLI and MCP"],
    limits: { accounts: 30, posts_per_month: 1500, x_posts_per_month: 300, members: 10, storage_mb: 20 * 1024, api: true },
    priceMonth: 4900,
    priceYear: 49000,
    position: 2,
  },
] as const;
