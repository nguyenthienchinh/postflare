// Admin → Overview (GET /api/admin/overview): instance-wide counts, publishing health and Free plan quota estimates.
// Every figure comes from ONE db.batch of bounded aggregate queries (12 statements, one round trip).
//
// Sources: posts / accounts / users / workspaces / media for state; usage_events (lib/usage.ts) for attempts,
// failures, workflow steps, Images transformations and the D1 write estimate. Demo workspaces are excluded from the
// totals and reported apart. Days are UTC (usage_events.day).
//
// Cost: the posts aggregate scans the posts table once (no index covers every status/time column); fine for an admin
// page opened now and then. Everything else is indexed or small.

import type { AdminCronDTO, AdminOverviewDTO, AdminProviderStatsDTO, AdminQuotaDTO, AdminWorkspaceRowDTO, QuotaLevel } from "../../shared/types";
import { demoEnabled } from "./demo";
import { EXPERIMENTAL_SETTING, MEDIA_RETENTION_SETTING, parseMediaRetention } from "./settings";
import { UPDATE_SETTING, updateStatus, type StoredUpdate } from "./updates";
import { USAGE_RETENTION_DAYS, cronLastRunKey, utcDay } from "./usage";
import { now, parseJson } from "./util";

const DAY = 24 * 60 * 60 * 1000;
export const MAX_OVERVIEW_DAYS = 90;
const MAX_WORKSPACES = 500;

/** Workers Free plan limits the quota panel compares against. */
export const FREE_PLAN = {
  workflowStepsPerDay: 3000,
  d1RowsWrittenPerDay: 100_000,
  r2StorageBytes: 10 * 1024 ** 3,
  imagesTransformationsPerMonth: 5000,
} as const;

/**
 * Typical D1 rows written per unit of work (row + its index entries), counted from the code
 * (see the cost report: posts insert 6, log 3, usage event 4...). Used for the "D1 rows written today" estimate.
 */
export const D1_WRITES = {
  postCreated: 10, // posts row + 4 indexes + workflow_id + creation log (3)
  publish: 13, // claim 2 + mark 4 + log 3 + usage event 4
  reply: 7, // log/error update 3 + usage event 4
  metricsPost: 5, // post_metrics row + 2 indexes, posts row + metrics_due index
  metricsEvent: 4,
  mediaUpload: 7, // media row + 2 indexes + usage event 4
  mediaDelete: 7,
} as const;

/** Workflow steps of a simple publish (load, claim, sandbox check, publish, mark published, load thread). */
const DEFAULT_STEPS_PER_POST = 6;

export const CRONS: Array<{ name: AdminCronDTO["name"]; schedule: string; everyMs: number }> = [
  { name: "frequent", schedule: "every 15 min (:00)", everyMs: 15 * 60 * 1000 },
  { name: "metrics", schedule: "every 15 min (:05)", everyMs: 15 * 60 * 1000 },
  { name: "daily", schedule: "daily 03:10 UTC", everyMs: DAY },
];

export function quotaLevel(used: number, limit: number): QuotaLevel {
  const r = limit > 0 ? used / limit : 0;
  return r >= 0.9 ? "critical" : r >= 0.7 ? "warning" : "ok";
}

const startOfUtcDay = (t: number) => Math.floor(t / DAY) * DAY;

/** Billed workspaces (not exempt, not the demo) and those of them paid until now (?1 = now). */
const BILLED = "(w.billing_exempt = 0 AND w.is_demo = 0)";
const PAYING = `(${BILLED} AND (w.billing_status IN ('active', 'past_due') OR (w.billing_status = 'canceled' AND w.current_period_end > ?1)))`;

interface WorkspaceRow {
  id: string;
  name: string;
  is_demo: number;
  created_at: number;
  members: number;
  accounts: number;
  api_keys: number;
  storage_bytes: number;
}
interface PostAgg {
  workspace_id: string | null;
  published_all: number;
  published_range: number;
  published_today: number;
  published_week: number;
  scheduled: number;
  scheduled_today: number;
  scheduled_24h: number;
  failed: number;
  needs_check: number;
  drafts: number;
  publishing: number;
  created_today: number;
  last_activity: number | null;
}

export async function adminOverview(env: Env, requestedDays: number): Promise<AdminOverviewDTO> {
  const db = env.DB;
  const t = now();
  const days = Math.min(Math.max(Math.floor(requestedDays) || 30, 1), MAX_OVERVIEW_DAYS);
  const today = startOfUtcDay(t);
  const from = today - (days - 1) * DAY;
  const week = today - 6 * DAY;
  const todayDay = utcDay(t);
  const fromDay = utcDay(from);
  const monthDay = `${todayDay.slice(0, 7)}-01`;
  const minDay = monthDay < fromDay ? monthDay : fromDay;
  const DEMO_WS = "(SELECT id FROM workspaces WHERE is_demo = 1)";

  const [wsRes, postRes, userRes, accRes, keyRes, seriesRes, provPostRes, usageRes, errRes, todayRes, setRes, sinceRes] = await db.batch<any>([
    // 0. Workspaces with their members, accounts, API keys and stored bytes.
    db
      .prepare(
        `SELECT w.id, w.name, w.is_demo, w.created_at,
           (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
           (SELECT COUNT(*) FROM accounts a WHERE a.workspace_id = w.id) AS accounts,
           (SELECT COUNT(*) FROM api_keys k WHERE k.workspace_id = w.id) AS api_keys,
           (SELECT COALESCE(SUM(size), 0) FROM media x WHERE x.workspace_id = w.id) AS storage_bytes
         FROM workspaces w ORDER BY w.created_at LIMIT ${MAX_WORKSPACES}`,
      ),
    // 1. Post counts per workspace (one scan of posts).
    db
      .prepare(
        `SELECT workspace_id,
           SUM(status = 'published') AS published_all,
           SUM(status = 'published' AND published_at >= ?1) AS published_range,
           SUM(status = 'published' AND published_at >= ?2) AS published_today,
           SUM(status = 'published' AND published_at >= ?3) AS published_week,
           SUM(status = 'scheduled') AS scheduled,
           SUM(status = 'scheduled' AND scheduled_at < ?4) AS scheduled_today,
           SUM(status = 'scheduled' AND scheduled_at < ?5) AS scheduled_24h,
           SUM(status = 'failed') AS failed,
           SUM(status = 'needs_check') AS needs_check,
           SUM(status = 'draft') AS drafts,
           SUM(status = 'publishing') AS publishing,
           SUM(created_at >= ?2) AS created_today,
           MAX(updated_at) AS last_activity
         FROM posts GROUP BY workspace_id`,
      )
      .bind(from, today, week, today + DAY, t + DAY),
    // 2. Users.
    db.prepare("SELECT status, is_demo, COUNT(*) AS n FROM users GROUP BY status, is_demo"),
    // 3. Accounts by provider and status (demo apart).
    db.prepare(
      `SELECT a.provider, a.status, COALESCE(w.is_demo, 0) AS demo, COUNT(*) AS n
       FROM accounts a LEFT JOIN workspaces w ON w.id = a.workspace_id GROUP BY a.provider, a.status, demo`,
    ),
    // 4. API keys (all, incl. keys of users without a workspace any more).
    db.prepare("SELECT COUNT(*) AS n FROM api_keys"),
    // 5. Published per day in the range (non-demo).
    db
      .prepare(
        `SELECT strftime('%Y-%m-%d', published_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM posts
         WHERE status = 'published' AND published_at >= ? AND (workspace_id IS NULL OR workspace_id NOT IN ${DEMO_WS}) GROUP BY day`,
      )
      .bind(from),
    // 6. Posts by provider: published in the range, failed / needs_check opened in the range (non-demo).
    db
      .prepare(
        `SELECT a.provider, SUM(p.status = 'published' AND p.published_at >= ?1) AS published,
           SUM(p.status IN ('failed', 'needs_check') AND p.updated_at >= ?1) AS failed
         FROM posts p JOIN accounts a ON a.id = p.account_id
         WHERE (p.workspace_id IS NULL OR p.workspace_id NOT IN ${DEMO_WS}) AND (p.status IN ('failed', 'needs_check') OR (p.status = 'published' AND p.published_at >= ?1))
         GROUP BY a.provider`,
      )
      .bind(from),
    // 7. Publish attempts in the range per day, provider and outcome (usage_events, non-demo).
    db
      .prepare(
        `SELECT day, provider, outcome, COUNT(*) AS n, SUM(has_url) AS urls FROM usage_events
         WHERE day >= ? AND kind = 'publish' AND is_demo = 0 GROUP BY day, provider, outcome`,
      )
      .bind(fromDay),
    // 8. Last errors (publish and follow-ups).
    db.prepare(
      `SELECT e.provider, e.workspace_id, w.name AS workspace_name, e.post_id, e.kind, e.outcome, e.message, e.created_at FROM usage_events e
       LEFT JOIN workspaces w ON w.id = e.workspace_id
       WHERE e.outcome IN ('failed', 'needs_check') AND e.kind IN ('publish', 'reply') AND e.is_demo = 0 ORDER BY e.id DESC LIMIT 5`,
    ),
    // 9. Usage this month / today per kind (quota estimates).
    db
      .prepare(
        `SELECT kind, day = ? AS is_today, COUNT(*) AS n, SUM(quantity) AS quantity, SUM(COALESCE(workflow_steps, 0)) AS steps,
           SUM(CASE WHEN workflow_steps IS NOT NULL THEN 1 ELSE 0 END) AS with_steps, SUM(images_tx) AS images, SUM(media_bytes) AS bytes
         FROM usage_events WHERE day >= ? GROUP BY kind, is_today`,
      )
      .bind(todayDay, minDay),
    // 10. Settings shown in the System card.
    db
      .prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)")
      .bind(UPDATE_SETTING, MEDIA_RETENTION_SETTING, EXPERIMENTAL_SETTING, ...CRONS.map((c) => cronLastRunKey(c.name))),
    // 11. First metered day, and hosted mode: subscriptions of billed workspaces and the MRR estimate (docs/hosted-spec.md).
    db
      .prepare(
        `SELECT (SELECT MIN(day) FROM usage_events) AS day, (SELECT value FROM settings WHERE key = 'billing_on') AS billing_on,
           SUM(w.billing_exempt = 1 AND w.is_demo = 0) AS exempt,
           SUM(${PAYING} AND w.billing_provider != 'manual') AS paying,
           SUM(${PAYING} AND w.billing_provider = 'manual') AS manual,
           SUM(${BILLED} AND w.billing_status = 'trialing' AND w.trial_ends_at > ?1) AS trialing,
           SUM(${BILLED} AND w.billing_status = 'past_due') AS past_due,
           SUM(CASE WHEN ${PAYING} AND w.billing_provider != 'manual'
             THEN CASE WHEN w.billing_interval = 'year' THEN COALESCE(p.price_year, 0) / 12.0 ELSE COALESCE(p.price_month, 0) END ELSE 0 END) AS mrr,
           (SELECT currency FROM plans GROUP BY currency ORDER BY COUNT(*) DESC LIMIT 1) AS currency
         FROM workspaces w LEFT JOIN plans p ON p.id = w.plan_id`,
      )
      .bind(t),
  ]);

  const workspaces = wsRes.results as WorkspaceRow[];
  const bill = sinceRes.results[0] as
    | { billing_on: string | null; exempt: number | null; paying: number | null; manual: number | null; trialing: number | null; past_due: number | null; mrr: number | null; currency: string | null }
    | undefined;
  const postAgg = new Map((postRes.results as PostAgg[]).map((r) => [r.workspace_id, r]));
  const demoIds = new Set(workspaces.filter((w) => w.is_demo).map((w) => w.id));
  const real = (postRes.results as PostAgg[]).filter((r) => !r.workspace_id || !demoIds.has(r.workspace_id));
  const demo = (postRes.results as PostAgg[]).filter((r) => r.workspace_id && demoIds.has(r.workspace_id));
  const sum = (rows: PostAgg[], k: keyof PostAgg) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);

  // Users / accounts.
  const users = { active: 0, disabled: 0, demo: 0, pending: 0 };
  for (const r of userRes.results as Array<{ status: string; is_demo: number; n: number }>) {
    if (r.is_demo) users.demo += r.n;
    else if (r.status === "disabled") users.disabled += r.n;
    else if (r.status === "pending") users.pending += r.n;
    else users.active += r.n;
  }
  const byProviderAcc = new Map<string, { provider: string; active: number; reconnect: number; disabled: number }>();
  const accStatus = { active: 0, reconnect: 0, disabled: 0 };
  for (const r of accRes.results as Array<{ provider: string; status: string; demo: number; n: number }>) {
    if (r.demo) continue;
    const k = r.status === "reconnect" || r.status === "disabled" ? r.status : "active";
    accStatus[k] += r.n;
    const e = byProviderAcc.get(r.provider) ?? { provider: r.provider, active: 0, reconnect: 0, disabled: 0 };
    e[k] += r.n;
    byProviderAcc.set(r.provider, e);
  }

  // Daily series and provider stats.
  const publishedByDay = new Map((seriesRes.results as Array<{ day: string; n: number }>).map((r) => [r.day, r.n]));
  const failedByDay = new Map<string, number>();
  const attempts = new Map<string, { published: number; failed: number; needsCheck: number; urls: number }>();
  for (const r of usageRes.results as Array<{ day: string; provider: string | null; outcome: string; n: number; urls: number }>) {
    const provider = r.provider ?? "unknown";
    const a = attempts.get(provider) ?? { published: 0, failed: 0, needsCheck: 0, urls: 0 };
    if (r.outcome === "published") a.published += r.n;
    else if (r.outcome === "needs_check") a.needsCheck += r.n;
    else if (r.outcome === "failed") a.failed += r.n;
    a.urls += r.urls ?? 0;
    attempts.set(provider, a);
    if (r.outcome === "failed" || r.outcome === "needs_check") failedByDay.set(r.day, (failedByDay.get(r.day) ?? 0) + r.n);
  }
  const daily: AdminOverviewDTO["posts"]["daily"] = [];
  for (let d = from; d <= today; d += DAY) {
    const day = utcDay(d);
    daily.push({ day, published: publishedByDay.get(day) ?? 0, failed: failedByDay.get(day) ?? 0 });
  }
  const providerPosts = new Map((provPostRes.results as Array<{ provider: string; published: number; failed: number }>).map((r) => [r.provider, r]));
  const providerIds = new Set([...providerPosts.keys(), ...attempts.keys()]);
  const byProvider: AdminProviderStatsDTO[] = [...providerIds]
    .map((provider) => {
      const p = providerPosts.get(provider);
      const a = attempts.get(provider) ?? { published: 0, failed: 0, needsCheck: 0, urls: 0 };
      const total = a.published + a.failed + a.needsCheck;
      return {
        provider,
        published: p?.published ?? 0,
        failed: p?.failed ?? 0,
        attempts: { published: a.published, failed: a.failed, needsCheck: a.needsCheck },
        successRate: total ? a.published / total : null,
        withUrl: a.urls,
      };
    })
    .filter((p) => p.published || p.failed || p.attempts.published + p.attempts.failed + p.attempts.needsCheck)
    .sort((a, b) => b.published + b.failed - (a.published + a.failed) || a.provider.localeCompare(b.provider));

  // Workspace table.
  const workspaceRows: AdminWorkspaceRowDTO[] = workspaces.map((w) => {
    const p = postAgg.get(w.id);
    return {
      id: w.id,
      name: w.name,
      isDemo: !!w.is_demo,
      members: w.members,
      accounts: w.accounts,
      apiKeys: w.api_keys,
      published: p?.published_range ?? 0,
      publishedAllTime: p?.published_all ?? 0,
      scheduled: p?.scheduled ?? 0,
      failed: p?.failed ?? 0,
      needsCheck: p?.needs_check ?? 0,
      storageBytes: w.storage_bytes,
      createdAt: w.created_at,
      lastActivity: p?.last_activity ?? null,
    };
  });

  // Usage → quotas.
  type KindAgg = { n: number; quantity: number; steps: number; withSteps: number; images: number; bytes: number };
  const todayKinds = new Map<string, KindAgg>();
  let imagesMonth = 0;
  for (const r of todayRes.results as Array<{ kind: string; is_today: number; n: number; quantity: number; steps: number; with_steps: number; images: number; bytes: number }>) {
    imagesMonth += r.images ?? 0;
    if (r.is_today) todayKinds.set(r.kind, { n: r.n, quantity: r.quantity ?? 0, steps: r.steps ?? 0, withSteps: r.with_steps ?? 0, images: r.images ?? 0, bytes: r.bytes ?? 0 });
  }
  const k = (kind: string): KindAgg => todayKinds.get(kind) ?? { n: 0, quantity: 0, steps: 0, withSteps: 0, images: 0, bytes: 0 };
  const publishToday = k("publish");
  const stepsPerPost = publishToday.withSteps ? publishToday.steps / publishToday.withSteps : DEFAULT_STEPS_PER_POST;
  // Steps of instances that finished today, plus a typical count for those still running and still scheduled today.
  const stepsUsed = Math.round(publishToday.steps + k("reply").steps + (publishToday.n - publishToday.withSteps) * DEFAULT_STEPS_PER_POST);
  const inFlight = sum(real, "publishing");
  const stepsProjected = Math.round(stepsUsed + (inFlight + sum(real, "scheduled_today")) * stepsPerPost);
  const createdToday = sum(real, "created_today") + sum(demo, "created_today");
  const metrics = k("metrics_refresh");
  const writesUsed =
    createdToday * D1_WRITES.postCreated +
    publishToday.n * D1_WRITES.publish +
    k("reply").n * D1_WRITES.reply +
    metrics.quantity * D1_WRITES.metricsPost +
    metrics.n * D1_WRITES.metricsEvent +
    k("media_upload").n * D1_WRITES.mediaUpload +
    k("media_delete").quantity * D1_WRITES.mediaDelete;
  const storage = workspaces.reduce((n, w) => n + (w.storage_bytes || 0), 0);
  const quota = (q: Omit<AdminQuotaDTO, "level">): AdminQuotaDTO => ({ ...q, level: quotaLevel(Math.max(q.used, q.projected ?? 0), q.limit) });
  const quotas: AdminQuotaDTO[] = [
    quota({
      key: "workflow_steps",
      label: "Workflows steps today",
      used: stepsUsed,
      projected: stepsProjected,
      limit: FREE_PLAN.workflowStepsPerDay,
      unit: "count",
      period: "day",
      estimate: true,
      note: `Measured per finished publish (~${stepsPerPost.toFixed(1)} steps per post today); the projection adds posts still publishing or scheduled today. Status polls of videos add steps.`,
    }),
    quota({
      key: "d1_rows_written",
      label: "D1 rows written today",
      used: writesUsed,
      projected: null,
      limit: FREE_PLAN.d1RowsWrittenPerDay,
      unit: "count",
      period: "day",
      estimate: true,
      note: "Typical rows per post created, publish, metrics snapshot and media file. Sessions, settings and edits are not counted.",
    }),
    quota({
      key: "r2_storage",
      label: "R2 storage",
      used: storage,
      projected: null,
      limit: FREE_PLAN.r2StorageBytes,
      unit: "bytes",
      period: "total",
      estimate: false,
      note: "Sum of media sizes, all workspaces (demo included). Unfinished uploads count at their announced size.",
    }),
    quota({
      key: "images_transformations",
      label: "Images transformations this month",
      used: imagesMonth,
      projected: null,
      limit: FREE_PLAN.imagesTransformationsPerMonth,
      unit: "count",
      period: "month",
      estimate: false,
      note: "Counted in publish steps (e.g. Bluesky re-encoding large images). Unique transformations may be fewer.",
    }),
  ];

  // System.
  const settings = new Map((setRes.results as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  const crons: AdminCronDTO[] = CRONS.map((c) => {
    const v = parseJson<{ at?: number; ms?: number } | null>(settings.get(cronLastRunKey(c.name)), null);
    const at = typeof v?.at === "number" ? v.at : null;
    return { name: c.name, schedule: c.schedule, lastRunAt: at, durationMs: typeof v?.ms === "number" ? v.ms : null, stale: at === null || t - at > 2 * c.everyMs };
  });

  const topWorkspaces = workspaceRows
    .filter((w) => !w.isDemo && w.published > 0)
    .sort((a, b) => b.published - a.published)
    .slice(0, 5)
    .map((w) => ({ id: w.id, name: w.name, published: w.published }));

  return {
    generatedAt: t,
    range: { days, from, to: t },
    counts: {
      workspaces: workspaces.length - demoIds.size,
      demoWorkspaces: demoIds.size,
      users,
      apiKeys: (keyRes.results[0] as { n: number } | undefined)?.n ?? 0,
      accounts: {
        total: accStatus.active + accStatus.reconnect + accStatus.disabled,
        byStatus: accStatus,
        byProvider: [...byProviderAcc.values()].sort((a, b) => b.active + b.reconnect + b.disabled - (a.active + a.reconnect + a.disabled)),
      },
    },
    posts: {
      publishedAllTime: sum(real, "published_all"),
      publishedToday: sum(real, "published_today"),
      published7d: sum(real, "published_week"),
      publishedRange: sum(real, "published_range"),
      scheduledToday: sum(real, "scheduled_today"),
      scheduledNext24h: sum(real, "scheduled_24h"),
      failed: sum(real, "failed"),
      needsCheck: sum(real, "needs_check"),
      drafts: sum(real, "drafts"),
      publishing: inFlight,
      daily,
      byProvider,
      topWorkspaces,
    },
    demo: { enabled: demoEnabled(env), publishedRange: sum(demo, "published_range"), publishedToday: sum(demo, "published_today"), scheduled: sum(demo, "scheduled") },
    health: {
      lastErrors: (errRes.results as Array<any>).map((r) => ({
        provider: r.provider,
        workspaceId: r.workspace_id,
        workspaceName: r.workspace_name,
        postId: r.post_id,
        kind: r.kind,
        outcome: r.outcome,
        message: r.message,
        at: r.created_at,
      })),
    },
    quotas,
    system: {
      update: updateStatus(env, parseJson<StoredUpdate | null>(settings.get(UPDATE_SETTING), null)),
      crons,
      demoMode: demoEnabled(env),
      mediaRetentionDays: parseMediaRetention(settings.get(MEDIA_RETENTION_SETTING)),
      experimentalIntegrations: settings.get(EXPERIMENTAL_SETTING) === "true",
      usageRetentionDays: USAGE_RETENTION_DAYS,
      meteringSince: (sinceRes.results[0] as { day: string | null } | undefined)?.day ?? null,
    },
    workspaces: workspaceRows,
    billing: {
      enabled: bill?.billing_on === "1",
      paying: bill?.paying ?? 0,
      trialing: bill?.trialing ?? 0,
      pastDue: bill?.past_due ?? 0,
      manual: bill?.manual ?? 0,
      exempt: bill?.exempt ?? 0,
      mrrCents: Math.round(bill?.mrr ?? 0),
      currency: bill?.currency ?? "USD",
    },
  };
}
