// Analytics collection: metric snapshots of published posts and daily account metrics.
//
// Schedule: a post is collected about 1h, 24h, 3d, 7d and 30d after publishing, then every 7 days until 90 days
// (`posts.metrics_next_at`, NULL = nothing planned). Accounts once per UTC day (`accounts.metrics_next_at`).
// The cron picks due work with indexed queries, groups posts by account (one `postMetrics` call per `metrics.batch`
// posts) and stops when the tick's fetch budget is used: the rest stays due for the next tick.
//
// Failures never touch the publishing status of an account (no markReconnect, except the existing token-refresh
// path in freshAccount): they set `accounts.metrics_status` (reconnect_required / not_supported / error). While an
// account is blocked (reconnect_required / not_supported) its posts are skipped until `accounts.metrics_next_at`
// (a weekly re-check) or a reconnect. Demo workspaces never call providers: lib/demo-metrics.ts makes the numbers up.

import type { AccountMetricsStatusDTO, AnalyticsPostDTO, MetricValues, MetricsStatus } from "../../shared/types";
import { ENGAGEMENT_KEYS, engagements, exposure } from "../../shared/types";
import { MAX_FETCHES, counted } from "../providers/budget";
import { MetricsUnavailableError, ProviderError } from "../providers/errors";
import { getProvider, providers } from "../providers/registry";
import type { Provider, ProviderContext } from "../providers/types";
import { freshAccount, providerContext, type AccountRow } from "./accounts";
import { CAMPAIGN_RESULT_COLUMNS, campaignResults, type CampaignResultCols } from "./campaigns";
import { demoAccountMetrics, demoPostMetrics } from "./demo-metrics";
import { metricsEventStatement, metricsEventsStatement, utcDay, type MetricsEvent } from "./usage";
import { errorMessage, now, parseJson } from "./util";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Collection points, relative to the publish time. */
export const CHECKPOINTS = [HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY, 37 * DAY, 44 * DAY, 51 * DAY, 58 * DAY, 65 * DAY, 72 * DAY, 79 * DAY, 86 * DAY, 90 * DAY];
/** Posts older than this are not collected any more. */
export const MAX_AGE = 90 * DAY;
/**
 * Fetches one cron tick may spend on analytics. The Free plan allows 50 subrequests per invocation and the same tick
 * also refreshes expiring tokens, so analytics keep some headroom.
 */
export const TICK_FETCH_BUDGET = 35;
/** A post gives up after this many consecutive failures (manual refresh resets it). */
export const MAX_POST_FAILS = 6;
/** Due posts / accounts looked at per tick. */
const POSTS_PER_TICK = 200;
const ACCOUNTS_PER_TICK = 10;
/**
 * Limits for the scheduled run (its own cron trigger). Small enough that one invocation stays under D1's 50 queries on
 * the Free plan even if every statement inside a batch counts: ~10 posts x 3 + 3 accounts x 2 + a few lookups.
 * 10 posts every 15 minutes is ~960 collections a day, enough for ~70 published posts a day.
 */
export const CRON_METRICS_LIMITS = { posts: 10, accounts: 3 } as const;
/** The hourly tick that also syncs Revflare campaign numbers (index.ts metricsJobs): 3 posts fewer (9 statements). */
export const CRON_METRICS_LIMITS_CAMPAIGN_TICK = { posts: 7, accounts: 3 } as const;
/** Blocked accounts (reconnect_required / not_supported) are re-checked this often. */
const BLOCKED_RECHECK = 7 * DAY;
/** Snapshots closer than this to the previous one replace it (manual refreshes do not pile up). */
const SNAPSHOT_MERGE = 30 * 60 * 1000;

/** The next collection time after `after`, or null when the post is done (older than 90 days). */
export function nextCheckpoint(publishedAt: number, after: number): number | null {
  for (const c of CHECKPOINTS) if (publishedAt + c > after) return publishedAt + c;
  return null;
}

/** Backoff after `fails` consecutive failures: 1h, 2h, 4h... capped at 24h. */
export const backoff = (fails: number) => Math.min(HOUR * 2 ** Math.max(0, fails - 1), DAY);

export { utcDay };

/** Start of the next UTC day plus a stable per-account offset (spreads daily account collections over 4 hours). */
export function nextAccountRun(accountId: string, t: number): number {
  let h = 0;
  for (let i = 0; i < accountId.length; i++) h = (h * 31 + accountId.charCodeAt(i)) | 0;
  return Math.floor(t / DAY) * DAY + DAY + (Math.abs(h) % (4 * 60)) * 60 * 1000;
}

// ---------------------------------------------------------------------------------------------------------------
// SQL helpers (engagements computed by D1, not in the 10ms CPU budget)

const jx = (col: string, k: string) => `json_extract(${col}, '$.${k}')`;
/** Engagements of a metrics JSON column (same keys as `engagements()`). */
export const engagementSql = (col = "p.metrics") => `(${ENGAGEMENT_KEYS.map((k) => `COALESCE(${jx(col, k)}, 0)`).join(" + ")})`;
/** Views, else impressions, else reach (same as `exposure()`). */
export const exposureSql = (col = "p.metrics") => `COALESCE(${jx(col, "views")}, ${jx(col, "impressions")}, ${jx(col, "reach")})`;

// ---------------------------------------------------------------------------------------------------------------
// DTOs

type AccountMetricsCols = Pick<AccountRow, "provider"> & {
  metrics?: string | null;
  metrics_status?: string | null;
  metrics_message?: string | null;
  metrics_checked_at?: number | null;
};

/** Whether a provider collects anything. */
export const hasAnalytics = (p: Provider | undefined) =>
  !!p && !!((p.postMetrics && p.metrics?.post.length) || (p.accountMetrics && p.metrics?.account.length));

export function metricsStatusDto(row: AccountMetricsCols): AccountMetricsStatusDTO {
  const provider = getProvider(row.provider);
  const supported = hasAnalytics(provider);
  return {
    // Unset status with stored metrics: collected before and not re-checked since a reconnect, not "pending".
    status: !supported ? "not_supported" : ((row.metrics_status as MetricsStatus | null) ?? (row.metrics ? "ok" : "pending")),
    message: !supported ? `${provider?.name ?? row.provider} offers no analytics` : (row.metrics_message ?? null),
    checkedAt: row.metrics_checked_at ?? null,
    metrics: parseJson<MetricValues | null>(row.metrics, null),
  };
}

export interface AnalyticsPostRow extends CampaignResultCols {
  id: string;
  group_id: string;
  account_id: string;
  content: string;
  media: string;
  external_id: string | null;
  external_url: string | null;
  published_at: number;
  metrics: string | null;
  metrics_at: number | null;
  metrics_next_at: number | null;
  provider: string;
  account_name: string;
  account_username: string | null;
}

/** SELECT list for AnalyticsPostRow (posts p JOIN accounts a), with the tracked link results. */
export const ANALYTICS_POST_COLUMNS = `p.id, p.group_id, p.account_id, p.content, p.media, p.external_id, p.external_url, p.published_at, p.metrics, p.metrics_at, p.metrics_next_at, a.provider, a.name AS account_name, a.username AS account_username,
  ${CAMPAIGN_RESULT_COLUMNS()}`;

export function analyticsPostDto(r: AnalyticsPostRow): AnalyticsPostDTO {
  const metrics = parseJson<MetricValues | null>(r.metrics, null);
  const exp = exposure(metrics);
  const eng = engagements(metrics);
  return {
    id: r.id,
    groupId: r.group_id,
    accountId: r.account_id,
    provider: r.provider,
    accountName: r.account_name,
    accountUsername: r.account_username,
    excerpt: Array.from(r.content).slice(0, 280).join(""),
    media: parseJson<string[]>(r.media, []),
    externalId: r.external_id,
    externalUrl: r.external_url,
    publishedAt: r.published_at,
    metrics,
    metricsAt: r.metrics_at,
    metricsNextAt: r.metrics_next_at,
    engagements: eng,
    engagementRate: metrics && exp ? eng / exp : null,
    campaign: campaignResults(r),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Collection

/** Fetches left for this tick / request. */
export interface Budget {
  left: number;
}

interface DuePost {
  id: string;
  workspace_id: string;
  account_id: string;
  external_id: string;
  external_data: string | null;
  published_at: number;
  metrics_fails: number;
  content: string;
  provider: string;
  is_demo: number;
  /** Demo metrics only (lib/demo-metrics.ts makes playbook posts perform differently). */
  playbook_id: string | null;
}

const DUE_POST_COLUMNS =
  "p.id, p.workspace_id, p.account_id, p.external_id, p.external_data, p.published_at, p.metrics_fails, p.content, a.provider, COALESCE(w.is_demo, 0) AS is_demo, p.playbook_id";

/**
 * `posts.metrics` keeps the numbers only: structured `details` (retention curves, traffic sources) stay in the
 * `post_metrics` snapshot, so list endpoints that return many posts stay small.
 */
export function withoutDetails(values: MetricValues): MetricValues {
  if (!values.details) return values;
  const { details: _details, ...rest } = values;
  return rest;
}

/** Statements that store one post's metrics and plan its next collection. */
function savePostStatements(db: D1Database, post: Pick<DuePost, "id" | "workspace_id" | "published_at">, values: MetricValues, t: number) {
  return [
    db.prepare("DELETE FROM post_metrics WHERE post_id = ? AND captured_at > ?").bind(post.id, t - SNAPSHOT_MERGE),
    db
      .prepare("INSERT INTO post_metrics (post_id, workspace_id, captured_at, metrics) VALUES (?, ?, ?, ?)")
      .bind(post.id, post.workspace_id, t, JSON.stringify(values)),
    db
      .prepare("UPDATE posts SET metrics = ?, metrics_at = ?, metrics_next_at = ?, metrics_fails = 0 WHERE id = ?")
      .bind(JSON.stringify(withoutDetails(values)), t, nextCheckpoint(post.published_at, t), post.id),
  ];
}

/** A failed collection: back off, give up after MAX_POST_FAILS. */
function failPostStatement(db: D1Database, post: Pick<DuePost, "id" | "metrics_fails">, t: number) {
  const fails = post.metrics_fails + 1;
  return db
    .prepare("UPDATE posts SET metrics_fails = ?, metrics_next_at = ? WHERE id = ?")
    .bind(fails, fails >= MAX_POST_FAILS ? null : t + backoff(fails), post.id);
}

function accountStatusStatement(db: D1Database, accountId: string, status: MetricsStatus, message: string | null, nextAt?: number | null) {
  return db
    .prepare(
      `UPDATE accounts SET metrics_status = ?, metrics_message = ?, metrics_checked_at = ?${nextAt !== undefined ? ", metrics_next_at = ?" : ""} WHERE id = ?`,
    )
    .bind(status, message?.slice(0, 500) ?? null, now(), ...(nextAt !== undefined ? [nextAt] : []), accountId);
}

async function setAccountStatus(env: Env, accountId: string, status: MetricsStatus, message: string | null, nextAt?: number | null) {
  await accountStatusStatement(env.DB, accountId, status, message, nextAt).run();
}

/** Contexts per provider for one tick (app config is read once). */
type CtxCache = Map<string, Promise<ProviderContext>>;
const ctxFor = (env: Env, cache: CtxCache, provider: Provider) => {
  let p = cache.get(provider.id);
  if (!p) cache.set(provider.id, (p = providerContext(env, provider)));
  return p;
};

/** Outcome of one account's post collection. */
interface CollectResult {
  collected: number;
  failed: number;
}

/**
 * Collect metrics for posts of ONE account (real or demo). Uses at most `budget.left` fetches; posts not reached stay
 * due. Returns how many posts were collected.
 */
async function collectAccountPosts(
  env: Env,
  account: AccountRow & { is_demo?: number },
  posts: DuePost[],
  budget: Budget,
  cache: CtxCache,
  /** Collects the usage events (written later in one statement); without it they join each chunk's batch. */
  events?: MetricsEvent[],
): Promise<CollectResult> {
  /** usage_events row of one collector chunk: into `events`, or a statement for the chunk's batch. */
  const chunkEvent = (outcome: "ok" | "failed", quantity: number, fetches: number, t: number, message?: string): D1PreparedStatement[] => {
    const e: MetricsEvent = { workspaceId: account.workspace_id, accountId: account.id, provider: account.provider, outcome, quantity, fetches, message, t };
    if (events) {
      events.push(e);
      return [];
    }
    return [metricsEventStatement(env.DB, e)];
  };
  const db = env.DB;
  const t = now();
  const provider = getProvider(account.provider);
  const out: CollectResult = { collected: 0, failed: 0 };
  if (!provider?.postMetrics || !provider.metrics?.post.length) {
    // Nothing to collect for this platform: stop planning these posts.
    await db.batch(posts.map((p) => db.prepare("UPDATE posts SET metrics_next_at = NULL WHERE id = ?").bind(p.id)));
    return out;
  }
  if (posts.some((p) => p.is_demo) || account.is_demo) {
    await db.batch(posts.flatMap((p) => savePostStatements(db, p, demoPostMetrics(provider, p, t), t)));
    out.collected = posts.length;
    return out;
  }
  const batch = Math.max(1, provider.metrics.batch ?? 1);
  const base = await ctxFor(env, cache, provider);
  let record: Awaited<ReturnType<typeof freshAccount>> | null = null;
  for (let i = 0; i < posts.length && budget.left > 0; i += batch) {
    const chunk = posts.slice(i, i + batch);
    const ctx = counted(base, Math.min(budget.left, MAX_FETCHES));
    let result: Record<string, MetricValues | null>;
    try {
      // The existing refresh path: a refresh that fails for good marks the account for reconnect (publishing too).
      record ??= await freshAccount(env, provider, ctx, account);
    } catch (err) {
      budget.left -= ctx.used;
      await setAccountStatus(env, account.id, "error", `Token refresh failed: ${errorMessage(err)}`);
      await db.batch([...chunk.map((p) => failPostStatement(db, p, t)), ...chunkEvent("failed", chunk.length, ctx.used, t, `Token refresh failed: ${errorMessage(err)}`)]);
      out.failed += chunk.length;
      return out;
    }
    try {
      result = await provider.postMetrics(
        ctx,
        record,
        chunk.map((p) => ({ externalId: p.external_id, data: parseJson(p.external_data, undefined), publishedAt: p.published_at })),
      );
    } catch (err) {
      budget.left -= ctx.used;
      if (await handleBlocking(env, account.id, err)) return out;
      // Rate limits, outages, invalid requests: back off this chunk.
      await setAccountStatus(env, account.id, "error", errorMessage(err));
      await db.batch([...chunk.map((p) => failPostStatement(db, p, t)), ...chunkEvent("failed", chunk.length, ctx.used, t, errorMessage(err))]);
      out.failed += chunk.length;
      if (err instanceof ProviderError && err.kind === "rate_limit") return out;
      continue;
    }
    budget.left -= ctx.used;
    const statements: D1PreparedStatement[] = [];
    let chunkCollected = 0;
    for (const p of chunk) {
      if (!(p.external_id in result)) continue; // not fetched (budget): stays due
      const values = result[p.external_id];
      if (values) {
        statements.push(...savePostStatements(db, p, values, t));
        out.collected++;
        chunkCollected++;
      } else {
        statements.push(failPostStatement(db, p, t));
        out.failed++;
      }
    }
    // Same batch: the account's analytics status is ok again once something was collected.
    if (out.collected) statements.push(accountStatusStatement(db, account.id, "ok", null));
    // Usage: one event per chunk (posts collected, fetches spent).
    if (statements.length || ctx.used) statements.push(...chunkEvent(chunkCollected ? "ok" : "failed", chunkCollected || chunk.length, ctx.used, t));
    if (statements.length) await db.batch(statements);
  }
  return out;
}

/**
 * Missing permission / unsupported account / revoked analytics access: block analytics for the account (re-checked
 * weekly or on reconnect), never its publishing. Returns false for other errors.
 */
async function handleBlocking(env: Env, accountId: string, err: unknown): Promise<boolean> {
  if (err instanceof MetricsUnavailableError) {
    await setAccountStatus(env, accountId, err.reason, err.message, now() + BLOCKED_RECHECK);
    return true;
  }
  if (err instanceof ProviderError && err.kind === "auth") {
    // The token works for publishing (it was just refreshed or is still valid) but not for analytics.
    await setAccountStatus(env, accountId, "reconnect_required", `Analytics access was refused: ${err.message}. Reconnect the account.`, now() + BLOCKED_RECHECK);
    return true;
  }
  return false;
}

/** Collect account metrics (followers...) of one account and store today's row. */
async function collectAccount(env: Env, account: AccountRow & { is_demo?: number }, budget: Budget, cache: CtxCache): Promise<boolean> {
  const db = env.DB;
  const provider = getProvider(account.provider);
  const t = now();
  if (!provider?.accountMetrics || !provider.metrics?.account.length) {
    await db.prepare("UPDATE accounts SET metrics_next_at = ? WHERE id = ?").bind(nextAccountRun(account.id, t), account.id).run();
    return false;
  }
  let values: MetricValues;
  if (account.is_demo) {
    values = demoAccountMetrics(provider, account.external_id, t);
  } else {
    const ctx = counted(await ctxFor(env, cache, provider), Math.min(budget.left, MAX_FETCHES));
    try {
      const record = await freshAccount(env, provider, ctx, account);
      values = await provider.accountMetrics(ctx, record);
    } catch (err) {
      budget.left -= ctx.used;
      if (await handleBlocking(env, account.id, err)) return false;
      const fails = ((account as { metrics_fails?: number }).metrics_fails ?? 0) + 1;
      await db
        .prepare("UPDATE accounts SET metrics_status = 'error', metrics_message = ?, metrics_checked_at = ?, metrics_fails = ?, metrics_next_at = ? WHERE id = ?")
        .bind(errorMessage(err).slice(0, 500), t, fails, t + backoff(fails), account.id)
        .run();
      return false;
    }
    budget.left -= ctx.used;
  }
  await saveAccountMetrics(db, account, values, t);
  return true;
}

export async function saveAccountMetrics(db: D1Database, account: Pick<AccountRow, "id" | "workspace_id">, values: MetricValues, t: number) {
  const json = JSON.stringify(values);
  await db.batch([
    db
      .prepare(
        `INSERT INTO account_metrics (account_id, workspace_id, day, captured_at, metrics) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, day) DO UPDATE SET captured_at = excluded.captured_at, metrics = excluded.metrics`,
      )
      .bind(account.id, account.workspace_id, utcDay(t), t, json),
    db
      .prepare(
        "UPDATE accounts SET metrics = ?, metrics_status = 'ok', metrics_message = NULL, metrics_checked_at = ?, metrics_fails = 0, metrics_next_at = ? WHERE id = ?",
      )
      .bind(json, t, nextAccountRun(account.id, t), account.id),
  ]);
}

/** Accounts whose analytics are blocked are skipped until their re-check time. */
const ACCOUNT_COLLECTABLE = (t: string) =>
  `a.status = 'active' AND (a.metrics_status IS NULL OR a.metrics_status NOT IN ('reconnect_required', 'not_supported') OR COALESCE(a.metrics_next_at, 0) <= ${t})`;

/** Providers that report account metrics. */
const accountProviders = () => providers.filter((p) => p.accountMetrics && p.metrics?.account.length).map((p) => p.id);

/**
 * Cron: collect due account and post metrics within `budget` fetches. Demo workspaces get generated numbers.
 * Returns counts for logging/tests.
 */
export async function collectMetrics(
  env: Env,
  opts: {
    budget?: number;
    workspaceId?: string;
    posts?: number;
    accounts?: number;
    /** Sink for the usage events (the caller writes them); without it they are written at the end, one statement. */
    events?: MetricsEvent[];
  } = {},
) {
  const db = env.DB;
  const t = now();
  const budget: Budget = { left: opts.budget ?? TICK_FETCH_BUDGET };
  const cache: CtxCache = new Map();
  const ws = opts.workspaceId ? "AND a.workspace_id = ?" : "";
  const wsBind = opts.workspaceId ? [opts.workspaceId] : [];
  const stats = { accounts: 0, posts: 0, failed: 0, budgetLeft: 0 };
  const events: MetricsEvent[] = opts.events ?? [];

  // 1. Account metrics, once a day. At most half the budget so posts always progress.
  const withAccountMetrics = accountProviders();
  const { results: accounts } = await db
    .prepare(
      `SELECT a.*, COALESCE(w.is_demo, 0) AS is_demo FROM accounts a LEFT JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.provider IN (${withAccountMetrics.map(() => "?").join(",") || "NULL"}) AND COALESCE(a.metrics_next_at, 0) <= ? AND a.status = 'active' ${ws}
       ORDER BY COALESCE(a.metrics_next_at, 0) LIMIT ${opts.accounts ?? ACCOUNTS_PER_TICK}`,
    )
    .bind(...withAccountMetrics, t, ...wsBind)
    .all<AccountRow & { is_demo: number }>();
  const accountBudget: Budget = { left: Math.floor(budget.left / 2) };
  for (const a of accounts) {
    if (!a.is_demo && accountBudget.left < 3) continue; // demo accounts cost no fetches
    const before = accountBudget.left;
    if (await collectAccount(env, a, accountBudget, cache)) stats.accounts++;
    budget.left -= before - accountBudget.left;
  }

  // 2. Due posts, grouped by account.
  const { results: due } = await db
    .prepare(
      `SELECT ${DUE_POST_COLUMNS} FROM posts p JOIN accounts a ON a.id = p.account_id LEFT JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.metrics_next_at IS NOT NULL AND p.metrics_next_at <= ? AND p.status = 'published' AND p.external_id IS NOT NULL
         AND p.published_at >= ? AND ${ACCOUNT_COLLECTABLE("?")} ${ws}
       ORDER BY p.metrics_next_at LIMIT ${opts.posts ?? POSTS_PER_TICK}`,
    )
    // Posts past the collection window are skipped here; the daily `expireMetricsSchedules` stops planning them.
    .bind(t, t - MAX_AGE - DAY, t, ...wsBind)
    .all<DuePost>();
  const byAccount = new Map<string, DuePost[]>();
  for (const p of due) {
    const list = byAccount.get(p.account_id);
    if (list) list.push(p);
    else byAccount.set(p.account_id, [p]);
  }
  // The accounts of all due posts in one query (D1 allows 50 queries per invocation on the Free plan).
  const ids = [...byAccount.keys()];
  const { results: dueAccounts } = ids.length
    ? await db.prepare(`SELECT * FROM accounts WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<AccountRow>()
    : { results: [] as AccountRow[] };
  const accountsById = new Map(dueAccounts.map((a) => [a.id, a]));
  for (const [accountId, posts] of byAccount) {
    const demo = posts[0].is_demo === 1;
    if (!demo && budget.left <= 0) continue;
    const account = accountsById.get(accountId);
    if (!account) continue;
    const r = await collectAccountPosts(env, { ...account, is_demo: posts[0].is_demo }, posts, budget, cache, events);
    stats.posts += r.collected;
    stats.failed += r.failed;
  }
  stats.budgetLeft = budget.left;
  if (!opts.events && events.length) await metricsEventsStatement(db, events).run();
  return stats;
}

/**
 * Daily cron: stop planning posts that are past the collection window (e.g. their account was disabled for months).
 * It reads every planned post, so it runs once a day instead of on every tick.
 */
export async function expireMetricsSchedules(env: Env): Promise<number> {
  const res = await env.DB.prepare("UPDATE posts SET metrics_next_at = NULL WHERE metrics_next_at IS NOT NULL AND published_at < ?")
    .bind(now() - MAX_AGE - DAY)
    .run();
  return res.meta.changes ?? 0;
}

/** Manual refresh of one post (POST /api/analytics/refresh). Resets its failure count. */
export async function refreshPostMetrics(env: Env, postId: string, budget: Budget = { left: 10 }): Promise<{ ok: boolean; error?: string }> {
  const db = env.DB;
  const post = await db
    .prepare(`SELECT ${DUE_POST_COLUMNS} FROM posts p JOIN accounts a ON a.id = p.account_id LEFT JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ?`)
    .bind(postId)
    .first<DuePost>();
  if (!post?.external_id || !post.published_at) return { ok: false, error: "Only published posts have metrics" };
  const account = await db.prepare("SELECT * FROM accounts WHERE id = ?").bind(post.account_id).first<AccountRow>();
  if (!account) return { ok: false, error: "Account not found" };
  const provider = getProvider(account.provider);
  if (!provider?.postMetrics) return { ok: false, error: `${provider?.name ?? account.provider} offers no post analytics` };
  if (!post.is_demo && account.status !== "active") return { ok: false, error: `${account.name} is ${account.status === "disabled" ? "disabled" : "disconnected: reconnect it"}` };
  const r = await collectAccountPosts(env, { ...account, is_demo: post.is_demo }, [{ ...post, metrics_fails: 0 }], budget, new Map());
  if (r.collected) return { ok: true };
  const row = await db.prepare("SELECT metrics_status, metrics_message FROM accounts WHERE id = ?").bind(account.id).first<{ metrics_status: string; metrics_message: string | null }>();
  return { ok: false, error: row?.metrics_message ?? "No metrics available for this post" };
}

/** Manual refresh of an account: its account metrics and its most recent posts (within the budget). */
export async function refreshAccountMetrics(env: Env, accountId: string, budget: Budget = { left: 20 }): Promise<number> {
  const db = env.DB;
  const account = await db
    .prepare("SELECT a.*, COALESCE(w.is_demo, 0) AS is_demo FROM accounts a LEFT JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = ?")
    .bind(accountId)
    .first<AccountRow & { is_demo: number }>();
  if (!account || (!account.is_demo && account.status !== "active")) return 0;
  const cache: CtxCache = new Map();
  const provider = getProvider(account.provider);
  if (provider?.accountMetrics) await collectAccount(env, account, budget, cache);
  const blocked = await db.prepare("SELECT metrics_status FROM accounts WHERE id = ?").bind(accountId).first<{ metrics_status: string | null }>();
  if (!provider?.postMetrics || blocked?.metrics_status === "reconnect_required" || blocked?.metrics_status === "not_supported") return 0;
  const { results } = await db
    .prepare(
      `SELECT ${DUE_POST_COLUMNS} FROM posts p JOIN accounts a ON a.id = p.account_id LEFT JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.account_id = ? AND p.status = 'published' AND p.external_id IS NOT NULL AND p.published_at > ?
       ORDER BY p.published_at DESC LIMIT ?`,
    )
    .bind(accountId, now() - MAX_AGE, Math.max(1, provider.metrics?.batch ?? 1) * 2)
    .all<DuePost>();
  if (!results.length) return 0;
  return (await collectAccountPosts(env, account, results.map((p) => ({ ...p, metrics_fails: 0 })), budget, cache)).collected;
}

/** Reset analytics state after a reconnect (the new token may carry the analytics permissions). */
export function resetAccountMetricsStatement(db: D1Database, accountId: string) {
  return db
    .prepare("UPDATE accounts SET metrics_status = NULL, metrics_message = NULL, metrics_next_at = NULL, metrics_fails = 0 WHERE id = ?")
    .bind(accountId);
}

export { engagements, exposure };
