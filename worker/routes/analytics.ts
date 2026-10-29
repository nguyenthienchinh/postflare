// Analytics API (workspace-scoped). Numbers come from the snapshots collected by lib/metrics.ts.
//
// Attribution: a post's latest metrics count for the day (and the range) it was PUBLISHED in, not for the days the
// views happened. Platforms report lifetime totals per post and we only sample them a few times, so per-day deltas
// would be lumpy and incomplete; publish-day attribution answers "how did the posts I published then perform".

import { Hono, type Context } from "hono";
import type {
  AnalyticsBreakdown,
  AnalyticsDay,
  AnalyticsRefreshDTO,
  AnalyticsRefreshInput,
  AnalyticsSummaryDTO,
  AnalyticsTotals,
  FollowerSeries,
  PostMetricsDTO,
} from "../../shared/types";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { findAccount } from "../lib/accounts";
import { simulateDueDemoPosts } from "../lib/demo";
import {
  ANALYTICS_POST_COLUMNS,
  analyticsPostDto,
  collectMetrics,
  engagementSql,
  exposureSql,
  hasAnalytics,
  metricsStatusDto,
  refreshAccountMetrics,
  refreshPostMetrics,
  utcDay,
  withoutDetails,
  type AnalyticsPostRow,
} from "../lib/metrics";
import { findPost } from "../lib/posts";
import { CAMPAIGN_RESULT_COLUMNS, campaignResults, type CampaignResultCols } from "../lib/campaigns";
import { getSetting } from "../lib/settings";
import { now, parseJson } from "../lib/util";
import { getProvider } from "../providers/registry";
import type { MetricValues } from "../../shared/types";

export const analyticsRoutes = new Hono<AppEnv>();

const DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE = 366 * DAY;
/** A manual refresh of the same post/account within this window returns the stored values. */
const REFRESH_COOLDOWN = 60 * 1000;

type Ctx = Context<AppEnv>;

/** ms timestamp or ISO date → ms (undefined when absent or invalid). */
function parseTime(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

/** from/to of the request: default the last 30 days, at most 366 days. */
function range(c: Ctx): { from: number; to: number } | { error: string } {
  const to = parseTime(c.req.query("to")) ?? now();
  const from = parseTime(c.req.query("from")) ?? to - 30 * DAY;
  if (c.req.query("from") && parseTime(c.req.query("from")) === undefined) return { error: "Invalid from" };
  if (c.req.query("to") && parseTime(c.req.query("to")) === undefined) return { error: "Invalid to" };
  if (from >= to) return { error: "from must be before to" };
  if (to - from > MAX_RANGE) return { error: "The range can be at most 366 days" };
  return { from, to };
}

/** Optional accountId / provider filters as SQL (on `p` posts / `a` accounts). */
function filters(c: Ctx, accountCol = "a.id") {
  const where: string[] = [];
  const binds: unknown[] = [];
  const accountId = c.req.query("accountId");
  const provider = c.req.query("provider");
  if (accountId) where.push(`${accountCol} = ?`) && binds.push(accountId);
  if (provider) where.push("a.provider = ?") && binds.push(provider);
  return { sql: where.map((w) => ` AND ${w}`).join(""), binds };
}

/** Demo workspace: publish due demo posts and generate due demo metrics (never calls a provider). */
async function demoCatchUp(c: Ctx) {
  if (!c.var.workspace?.demo) return;
  await simulateDueDemoPosts(c.env, wsId(c));
  await collectMetrics(c.env, { workspaceId: wsId(c), budget: 0 });
}

// ---------------------------------------------------------------------------------------------------------------
// Days in a timezone

function validTz(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Local midnights (ms) of every day overlapping [from, to) in `tz`, with their YYYY-MM-DD labels. */
export function localDays(from: number, to: number, tz: string): Array<{ start: number; day: string }> {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const parts = (t: number) => {
    const o: Record<string, number> = {};
    for (const p of fmt.formatToParts(t)) if (p.type !== "literal") o[p.type] = Number(p.value);
    return o;
  };
  const offset = (t: number) => {
    const p = parts(t);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  const first = parts(from);
  // Without a DST change in the range one offset is enough (saves CPU on long ranges).
  const fixed = offset(from) === offset(to) ? offset(from) : null;
  const out: Array<{ start: number; day: string }> = [];
  for (let i = 0; i < 400; i++) {
    const guess = Date.UTC(first.year, first.month - 1, first.day + i);
    const start = guess - (fixed ?? offset(guess));
    if (start >= to) break;
    out.push({ start, day: new Date(guess).toISOString().slice(0, 10) });
  }
  return out;
}

/** Index of the day containing t (days sorted by start). */
function dayIndex(days: Array<{ start: number }>, t: number): number {
  let lo = 0;
  let hi = days.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (days[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------------------------
// Summary

interface PostAgg extends CampaignResultCols {
  t: number;
  account_id: string;
  provider: string;
  m: number;
  views: number;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  watchTimeMinutes: number;
  eng: number;
  exp: number | null;
}

/** Running totals; `rateEng` / `rateExp` only over posts reporting an exposure. */
class Acc {
  posts = 0;
  postsWithMetrics = 0;
  views = 0;
  impressions = 0;
  reach = 0;
  engagements = 0;
  likes = 0;
  comments = 0;
  shares = 0;
  saves = 0;
  watchTimeMinutes = 0;
  rateEng = 0;
  rateExp = 0;
  followers: number | null = null;
  followersChange: number | null = null;
  campaignPosts = 0;
  clicks = 0;
  downloads = 0;
  redownloads = 0;
  proceeds = 0;

  add(r: PostAgg, campaign?: ReturnType<typeof campaignResults>) {
    this.posts++;
    if (campaign) {
      this.campaignPosts++;
      this.clicks += campaign.clicks;
      this.downloads += campaign.downloads ?? 0;
      this.redownloads += campaign.redownloads ?? 0;
      this.proceeds += campaign.proceeds ?? 0;
    }
    if (!r.m) return;
    this.postsWithMetrics++;
    this.views += r.views;
    this.impressions += r.impressions;
    this.reach += r.reach;
    this.engagements += r.eng;
    this.likes += r.likes;
    this.comments += r.comments;
    this.shares += r.shares;
    this.saves += r.saves;
    this.watchTimeMinutes += r.watchTimeMinutes;
    if (r.exp) {
      this.rateEng += r.eng;
      this.rateExp += r.exp;
    }
  }

  addFollowers(end: number | null, start: number | null) {
    if (end === null) return;
    this.followers = (this.followers ?? 0) + end;
    if (start !== null) this.followersChange = (this.followersChange ?? 0) + end - start;
  }

  totals(): AnalyticsTotals {
    return {
      posts: this.posts,
      postsWithMetrics: this.postsWithMetrics,
      views: this.views,
      impressions: this.impressions,
      reach: this.reach,
      engagements: this.engagements,
      likes: this.likes,
      comments: this.comments,
      shares: this.shares,
      saves: this.saves,
      watchTimeMinutes: Math.round(this.watchTimeMinutes),
      engagementRate: this.rateExp > 0 ? this.rateEng / this.rateExp : null,
      followers: this.followers,
      followersChange: this.followersChange,
      campaignPosts: this.campaignPosts,
      clicks: this.clicks,
      downloads: this.downloads,
      redownloads: this.redownloads,
      proceeds: Math.round(this.proceeds * 100) / 100,
    };
  }
}

const num = (k: string) => `COALESCE(json_extract(p.metrics, '$.${k}'), 0) AS ${k}`;

analyticsRoutes.get("/analytics/summary", requirePermission("posts.read"), async (c) => {
  const r = range(c);
  if ("error" in r) return c.json({ error: r.error }, 400);
  const { from, to } = r;
  const ws = wsId(c);
  const tz = validTz(c.req.query("tz")) ?? validTz(await getSetting(c.env.DB, "timezone")) ?? "UTC";
  await demoCatchUp(c);
  const span = to - from;
  const prevFrom = from - span;
  const f = filters(c);

  const { results: rows } = await c.env.DB.prepare(
    `SELECT p.published_at AS t, p.account_id, a.provider, p.metrics IS NOT NULL AS m, ${num("views")}, ${num("impressions")}, ${num("reach")},
       ${num("likes")}, ${num("comments")}, ${num("shares")}, ${num("saves")}, ${num("watchTimeMinutes")}, ${engagementSql()} AS eng, ${exposureSql()} AS exp, ${CAMPAIGN_RESULT_COLUMNS()}
     FROM posts p JOIN accounts a ON a.id = p.account_id
     WHERE p.workspace_id = ? AND p.status = 'published' AND p.published_at >= ? AND p.published_at < ?${f.sql}`,
  )
    .bind(ws, prevFrom, to, ...f.binds)
    .all<PostAgg>();

  const { results: accounts } = await c.env.DB.prepare(
    `SELECT a.id, a.provider, a.name, a.username FROM accounts a WHERE a.workspace_id = ?${f.sql} ORDER BY a.provider, a.name`,
  )
    .bind(ws, ...f.binds)
    .all<{ id: string; provider: string; name: string; username: string | null }>();

  // Follower history: from a week before the previous period (to know the starting value) to the end.
  const { results: fol } = await c.env.DB.prepare(
    `SELECT m.account_id, m.day, json_extract(m.metrics, '$.followers') AS followers FROM account_metrics m JOIN accounts a ON a.id = m.account_id
     WHERE m.workspace_id = ? AND a.workspace_id = ? AND m.day >= ? AND m.day <= ? AND json_extract(m.metrics, '$.followers') IS NOT NULL${f.sql}
     ORDER BY m.account_id, m.day`,
  )
    .bind(ws, ws, utcDay(prevFrom - 7 * DAY), utcDay(to - 1), ...f.binds)
    .all<{ account_id: string; day: string; followers: number }>();

  const days = localDays(from, to, tz);
  const daily: AnalyticsDay[] = days.map((d) => ({ day: d.day, posts: 0, views: 0, engagements: 0, likes: 0, comments: 0, shares: 0 }));
  const current = new Acc();
  const previous = new Acc();
  const byProvider = new Map<string, Acc>();
  const byAccount = new Map<string, Acc>();
  let currency: string | null = null;
  for (const row of rows) {
    const campaign = campaignResults(row);
    if (campaign?.currency) currency ??= campaign.currency;
    if (row.t < from) {
      previous.add(row, campaign);
      continue;
    }
    current.add(row, campaign);
    let p = byProvider.get(row.provider);
    if (!p) byProvider.set(row.provider, (p = new Acc()));
    p.add(row, campaign);
    let a = byAccount.get(row.account_id);
    if (!a) byAccount.set(row.account_id, (a = new Acc()));
    a.add(row, campaign);
    const d = daily[dayIndex(days, row.t)];
    d.posts++;
    if (row.m) {
      d.views += row.exp ?? 0;
      d.engagements += row.eng;
      d.likes! += row.likes;
      d.comments! += row.comments;
      d.shares! += row.shares;
    }
  }

  // Followers per account: value at a day = the latest row on or before it.
  const byAccountRows = new Map<string, Array<{ day: string; followers: number }>>();
  for (const r of fol) {
    const list = byAccountRows.get(r.account_id);
    if (list) list.push(r);
    else byAccountRows.set(r.account_id, [r]);
  }
  const at = (list: Array<{ day: string; followers: number }>, day: string, firstFrom?: string): number | null => {
    let v: number | null = null;
    for (const r of list) {
      if (r.day <= day) v = r.followers;
      else break;
    }
    // Account added during the period: count its growth since its first value.
    if (v === null && firstFrom) v = list.find((r) => r.day >= firstFrom)?.followers ?? null;
    return v;
  };
  const fromDay = utcDay(from);
  const endDay = utcDay(to - 1);
  const prevDay = utcDay(prevFrom);
  const followers: FollowerSeries[] = [];
  const accountInfo = new Map(accounts.map((a) => [a.id, a]));
  for (const [id, list] of byAccountRows) {
    const info = accountInfo.get(id);
    if (!info) continue;
    const end = at(list, endDay);
    const start = at(list, fromDay, fromDay);
    current.addFollowers(end, start);
    previous.addFollowers(at(list, fromDay), at(list, prevDay, prevDay));
    let p = byProvider.get(info.provider);
    if (!p) byProvider.set(info.provider, (p = new Acc()));
    p.addFollowers(end, start);
    let a = byAccount.get(id);
    if (!a) byAccount.set(id, (a = new Acc()));
    a.addFollowers(end, start);
    const points = list.filter((r) => r.day >= fromDay && r.day <= endDay).map((r) => ({ day: r.day, followers: r.followers }));
    if (points.length) followers.push({ accountId: id, provider: info.provider, name: info.name, points });
  }

  const providerRows: AnalyticsBreakdown[] = [...byProvider].map(([id, acc]) => ({
    key: id,
    provider: id,
    name: getProvider(id)?.name ?? id,
    ...acc.totals(),
  }));
  const accountRows: AnalyticsBreakdown[] = [];
  for (const a of accounts) {
    const acc = byAccount.get(a.id);
    // Accounts without posts in the range and without analytics stay out of the breakdown.
    if (!acc && !hasAnalytics(getProvider(a.provider))) continue;
    accountRows.push({ key: a.id, accountId: a.id, provider: a.provider, name: a.name, username: a.username, ...(acc ?? new Acc()).totals() });
  }
  const byViews = (x: AnalyticsBreakdown, y: AnalyticsBreakdown) => y.views + y.impressions - (x.views + x.impressions) || y.posts - x.posts;
  const body: AnalyticsSummaryDTO = {
    from,
    to,
    tz,
    totals: current.totals(),
    previous: previous.totals(),
    byProvider: providerRows.sort(byViews),
    byAccount: accountRows.sort(byViews),
    daily,
    followers,
    currency,
  };
  return c.json(body);
});

// ---------------------------------------------------------------------------------------------------------------
// Posts

const SORTS: Record<string, string> = {
  views: `${exposureSql()} DESC NULLS LAST`,
  engagements: `${engagementSql()} DESC`,
  engagementRate: `(${engagementSql()} * 1.0 / NULLIF(${exposureSql()}, 0)) DESC NULLS LAST`,
  publishedAt: "p.published_at DESC",
  // Tracked App Store links (aliases of ANALYTICS_POST_COLUMNS).
  clicks: "campaign_clicks DESC NULLS LAST",
  downloads: "json_extract(campaign_stats, '$.downloads') DESC NULLS LAST",
  proceeds: "json_extract(campaign_stats, '$.proceeds') DESC NULLS LAST",
};
SORTS.installs = SORTS.downloads;

analyticsRoutes.get("/analytics/posts", requirePermission("posts.read"), async (c) => {
  const r = range(c);
  if ("error" in r) return c.json({ error: r.error }, 400);
  const sort = c.req.query("sort") ?? "publishedAt";
  if (!SORTS[sort]) return c.json({ error: `sort must be one of ${Object.keys(SORTS).join(", ")}` }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  await demoCatchUp(c);
  const f = filters(c);
  const { results } = await c.env.DB.prepare(
    `SELECT ${ANALYTICS_POST_COLUMNS} FROM posts p JOIN accounts a ON a.id = p.account_id
     WHERE p.workspace_id = ? AND p.status = 'published' AND p.published_at >= ? AND p.published_at < ?${f.sql}
     ORDER BY ${SORTS[sort]}, p.published_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(wsId(c), r.from, r.to, ...f.binds, limit, offset)
    .all<AnalyticsPostRow>();
  return c.json(results.map(analyticsPostDto));
});

analyticsRoutes.get("/posts/:id/metrics", requirePermission("posts.read"), async (c) => {
  await demoCatchUp(c);
  const row = await findPost(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  const { results } = await c.env.DB.prepare("SELECT captured_at, metrics FROM post_metrics WHERE post_id = ? AND workspace_id = ? ORDER BY captured_at")
    .bind(row.id, wsId(c))
    .all<{ captured_at: number; metrics: string }>();
  const snapshots = results.map((s) => ({ capturedAt: s.captured_at, metrics: parseJson<MetricValues>(s.metrics, {}) }));
  // Structured details (YouTube retention / traffic sources) of the latest snapshot that has them, once.
  const withDetails = snapshots.findLast((s) => s.metrics.details);
  const camp = await c.env.DB.prepare(`SELECT ${CAMPAIGN_RESULT_COLUMNS()} FROM posts p WHERE p.id = ? AND p.workspace_id = ?`).bind(row.id, wsId(c)).first<CampaignResultCols>();
  const body: PostMetricsDTO = {
    postId: row.id,
    publishedAt: row.published_at,
    metrics: parseJson<MetricValues | null>(row.metrics, null),
    metricsAt: row.metrics_at ?? null,
    metricsNextAt: row.metrics_next_at ?? null,
    snapshots: snapshots.map((s) => ({ capturedAt: s.capturedAt, metrics: withoutDetails(s.metrics) })),
    details: withDetails?.metrics.details ?? null,
    detailsAt: withDetails?.capturedAt ?? null,
    campaign: camp ? campaignResults(camp) : null,
  };
  return c.json(body);
});

// ---------------------------------------------------------------------------------------------------------------
// Manual refresh

async function postDto(env: Env, ws: string, id: string) {
  const row = await env.DB.prepare(`SELECT ${ANALYTICS_POST_COLUMNS} FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.id = ? AND p.workspace_id = ?`)
    .bind(id, ws)
    .first<AnalyticsPostRow>();
  return row ? analyticsPostDto(row) : null;
}

analyticsRoutes.post("/analytics/refresh", requirePermission("posts.write"), async (c) => {
  const body = await c.req.json<AnalyticsRefreshInput>().catch(() => ({}) as AnalyticsRefreshInput);
  const ws = wsId(c);
  if (!!body.postId === !!body.accountId) return c.json({ error: "Send either postId or accountId" }, 400);

  if (body.postId) {
    const row = await findPost(c.env, ws, body.postId);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "published" || !row.external_id || !row.published_at) return c.json({ error: "Only published posts have metrics" }, 409);
    if (!row.metrics_at || now() - row.metrics_at > REFRESH_COOLDOWN) {
      const res = await refreshPostMetrics(c.env, row.id);
      if (!res.ok) return c.json({ error: res.error ?? "Could not collect metrics", post: await postDto(c.env, ws, row.id) }, 502);
    }
    const out: AnalyticsRefreshDTO = { post: (await postDto(c.env, ws, row.id))! };
    return c.json(out);
  }

  const account = await findAccount(c.env, ws, body.accountId!);
  if (!account) return c.json({ error: "Not found" }, 404);
  let postsRefreshed = 0;
  if (!account.metrics_checked_at || now() - account.metrics_checked_at > REFRESH_COOLDOWN) {
    postsRefreshed = await refreshAccountMetrics(c.env, account.id);
  }
  const fresh = (await findAccount(c.env, ws, account.id))!;
  const out: AnalyticsRefreshDTO = { account: { id: fresh.id, metricsStatus: metricsStatusDto(fresh), postsRefreshed } };
  return c.json(out);
});
