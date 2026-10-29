/**
 * Effective plan of a workspace and the limit checks (docs/hosted-spec.md "Effective plan"). The billing state is read
 * inside the query that already loads the workspace (`BILLING_COLUMNS`, used by lib/auth.ts): with billing off, a
 * request costs no extra D1 query and `enforce` returns at once. Counters run only when billing is on and the workspace
 * is not exempt (one indexed COUNT each, worker/billing/host.ts).
 */
import type { BillingState, BillingStatus, PlanLimitErrorDTO, PlanLimitKey, PlanLimits } from "../../shared/types";
import { now, parseJson } from "../lib/util";
import { DEFAULT_GRACE_DAYS, DEFAULT_TRIAL_DAYS, SETTING, parseDays } from "./config";
import { BILLING_PATH, countUsage, limitInfo, limitMax, periodOf } from "./host";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Columns to add to a query that selects a workspace as `w` (one row): its subscription, the instance settings and its
 * plan / the free plan as JSON. Scalar subqueries on primary keys: no extra round trip.
 */
export const BILLING_COLUMNS = `w.billing_exempt AS b_exempt, w.billing_status AS b_status, w.plan_id AS b_plan_id, w.trial_ends_at AS b_trial_ends_at,
  w.current_period_end AS b_period_end, w.billing_past_due_since AS b_past_due_since,
  (SELECT value FROM settings WHERE key = '${SETTING.on}') AS b_on, (SELECT value FROM settings WHERE key = '${SETTING.graceDays}') AS b_grace,
  (SELECT json_object('id', id, 'name', name, 'limits', json(limits)) FROM plans WHERE id = w.plan_id) AS b_plan,
  (SELECT json_object('id', id, 'name', name, 'limits', json(limits)) FROM plans WHERE is_free = 1 AND active = 1 ORDER BY position LIMIT 1) AS b_free`;

export interface BillingColumnsRow {
  is_demo: number;
  b_exempt: number | null;
  b_status: BillingStatus | null;
  b_plan_id: string | null;
  b_trial_ends_at: number | null;
  b_period_end: number | null;
  b_past_due_since: number | null;
  b_on: string | null;
  b_grace: string | null;
  b_plan: string | null;
  b_free: string | null;
}

export interface PlanRef {
  id: string;
  name: string;
  limits: PlanLimits;
}

/** The billing columns of one workspace, as read with the workspace. */
export interface BillingSnapshot {
  on: boolean;
  exempt: boolean;
  demo: boolean;
  status: BillingStatus;
  planId: string | null;
  trialEndsAt: number | null;
  periodEnd: number | null;
  pastDueSince: number | null;
  graceDays: number;
  plan: PlanRef | null;
  free: PlanRef | null;
}

export function snapshotFromRow(r: BillingColumnsRow): BillingSnapshot {
  return {
    on: r.b_on === "1",
    exempt: !!r.b_exempt,
    demo: !!r.is_demo,
    status: r.b_status ?? "none",
    planId: r.b_plan_id,
    trialEndsAt: r.b_trial_ends_at,
    periodEnd: r.b_period_end,
    pastDueSince: r.b_past_due_since,
    graceDays: parseDays(r.b_grace, DEFAULT_GRACE_DAYS),
    plan: parseJson<PlanRef | null>(r.b_plan, null),
    free: parseJson<PlanRef | null>(r.b_free, null),
  };
}

export async function loadSnapshot(db: D1Database, workspaceId: string): Promise<BillingSnapshot | null> {
  const row = await db.prepare(`SELECT w.is_demo, ${BILLING_COLUMNS} FROM workspaces w WHERE w.id = ?`).bind(workspaceId).first<BillingColumnsRow>();
  return row ? snapshotFromRow(row) : null;
}

export interface Entitlements {
  /** Limits apply (billing on, not exempt, not the demo). */
  billing: boolean;
  state: BillingState;
  /** Effective plan (null when unlimited or locked; a paid workspace whose plan was deleted gets an unlimited plan). */
  plan: PlanRef | null;
  /** null = unlimited (also when locked: check `state`). */
  limits: PlanLimits | null;
  graceEndsAt: number | null;
}

const UNLIMITED: Entitlements = { billing: false, state: "unlimited", plan: null, limits: null, graceEndsAt: null };

/** The effective plan at time `t` (trial expiry and grace are evaluated lazily from the timestamps). */
export function entitlements(s: BillingSnapshot | null | undefined, t = now()): Entitlements {
  if (!s || !s.on || s.exempt || s.demo) return UNLIMITED;
  const graceEndsAt = s.status === "past_due" ? (s.pastDueSince ?? t) + s.graceDays * DAY : null;
  const paid =
    s.status === "active" || (s.status === "past_due" && graceEndsAt! > t) || (s.status === "canceled" && s.periodEnd !== null && s.periodEnd > t);
  if (paid) {
    // Paying but the plan is gone or unmapped (admin misconfiguration): never punish the customer for it.
    const plan = s.plan ?? { id: s.planId ?? "", name: "Paid plan", limits: {} };
    return { billing: true, state: "plan", plan, limits: plan.limits, graceEndsAt };
  }
  if (s.status === "trialing" && s.trialEndsAt !== null && s.trialEndsAt > t && s.plan) {
    return { billing: true, state: "trial", plan: s.plan, limits: s.plan.limits, graceEndsAt: null };
  }
  if (s.free) return { billing: true, state: "free", plan: s.free, limits: s.free.limits, graceEndsAt: null };
  return { billing: true, state: "locked", plan: null, limits: null, graceEndsAt: null };
}

/** An action the plan does not allow: answered with HTTP 402 (worker/index.ts onError). */
export class PlanLimitError extends Error {
  constructor(readonly body: PlanLimitErrorDTO) {
    super(body.error);
    this.name = "PlanLimitError";
  }
}

export const upgradeUrl = (requestUrl: string) => `${new URL(requestUrl).origin}${BILLING_PATH}`;

export const LOCKED_MESSAGE =
  "This workspace has no active plan: it is read-only until someone with billing access picks a plan in Workspace settings → Billing.";

const fmt = (n: number) => n.toLocaleString("en-US");

/** `n` new units used at time `at` (for the monthly keys: the publish or scheduled time, which picks the month). */
export interface TimedAdd {
  at: number;
  n: number;
}

/**
 * Per limit key: how many new items (now; bytes for storage_mb; anything for the boolean `api`), or a list of timed
 * adds, each checked against the period (month) it falls in.
 */
export type LimitAdds = Partial<Record<PlanLimitKey, number | TimedAdd[]>>;

const MONTH_NAME = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Throws PlanLimitError when the workspace is locked or adding `adds` would exceed the plan. No query unless billing
 * applies; then one COUNT per key that has a limit (and per period of its timed adds).
 */
export async function enforceWorkspace(
  db: D1Database,
  workspaceId: string,
  snapshot: BillingSnapshot | null | undefined,
  adds: LimitAdds,
  requestUrl: string,
  t = now(),
): Promise<void> {
  const ent = entitlements(snapshot, t);
  if (!ent.billing) return;
  const url = upgradeUrl(requestUrl);
  if (ent.state === "locked") throw new PlanLimitError({ error: LOCKED_MESSAGE, code: "plan_limit", limit: "locked", used: null, max: null, upgradeUrl: url });
  const limits = ent.limits ?? {};
  const planName = ent.plan?.name ?? "Your plan";
  for (const [key, value] of Object.entries(adds) as Array<[PlanLimitKey, number | TimedAdd[]]>) {
    if (key === "api") {
      if (limits.api === false) {
        throw new PlanLimitError({
          error: `${planName} doesn't include API access (API keys, the CLI and MCP). Upgrade the plan in Workspace settings → Billing.`,
          code: "plan_limit",
          limit: "api",
          used: null,
          max: false,
          upgradeUrl: url,
        });
      }
      continue;
    }
    const max = limits[key];
    if (max === null || max === undefined) continue;
    // Group the adds by period: a batch scheduled across months is checked against each month.
    const periods = new Map<number, TimedAdd>();
    for (const a of Array.isArray(value) ? value : [{ at: t, n: value }]) {
      if (!(a.n >= 0) || !Number.isFinite(a.at)) continue;
      const p = periodOf(key, a.at);
      const cur = periods.get(p);
      periods.set(p, { at: cur?.at ?? a.at, n: (cur?.n ?? 0) + a.n });
    }
    for (const [period, { at, n: adding }] of [...periods].sort((a, b) => a[0] - b[0])) {
      const used = await countUsage(db, workspaceId, key, at);
      if (used + adding <= limitMax(key, max)) continue;
      const info = limitInfo(key);
      const shown = key === "storage_mb" ? Math.round((used / (1024 * 1024)) * 10) / 10 : used;
      // Another month than the current one: "allows 30 posts in November 2026".
      const noun = period && periodOf(key, t) !== period ? info.noun.replace("this month", `in ${MONTH_NAME.format(period)}`) : info.noun;
      throw new PlanLimitError({
        error: `Plan limit reached: ${planName} allows ${fmt(max)} ${noun} (used: ${fmt(shown)}). Upgrade the plan in Workspace settings → Billing.`,
        code: "plan_limit",
        limit: key,
        used: shown,
        max,
        upgradeUrl: url,
      });
    }
  }
}

/** The parts of a Hono context `enforce` reads (structural, so any route's context fits). */
interface Ctx {
  env: Env;
  req: { url: string };
  var: { workspace: { id: string; billing?: BillingSnapshot } | null };
}

/** `enforceWorkspace` for the request's workspace (behind requirePermission). */
export function enforce(c: Ctx, adds: LimitAdds = {}): Promise<void> {
  const ws = c.var.workspace;
  if (!ws) return Promise.resolve();
  return enforceWorkspace(c.env.DB, ws.id, ws.billing, adds, c.req.url);
}

/** Locked workspaces cannot schedule, publish or create anything (no query when billing is off). */
export const assertNotLocked = (c: Ctx) => enforce(c, {});

/**
 * Statements that start the local trial of a new workspace (append them to the batch that creates it). They change
 * nothing unless billing is on, a trial default plan exists, trial days > 0 and `userId` never had a trial. Without a
 * trial the workspace starts on the free plan (or locked): that needs no write, `entitlements` derives it.
 */
export function trialStatements(db: D1Database, workspaceId: string, userId: string, t = now()): D1PreparedStatement[] {
  const days = `COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = '${SETTING.trialDays}'), ${DEFAULT_TRIAL_DAYS})`;
  return [
    db
      .prepare(
        `UPDATE workspaces SET billing_status = 'trialing', billing_updated_at = ?1, trial_ends_at = ?1 + ${days} * ${DAY},
           plan_id = (SELECT id FROM plans WHERE is_trial_default = 1 AND active = 1 ORDER BY position LIMIT 1)
         WHERE id = ?2 AND billing_exempt = 0 AND is_demo = 0 AND billing_status = 'none' AND ${days} > 0
           AND EXISTS (SELECT 1 FROM settings WHERE key = '${SETTING.on}' AND value = '1')
           AND EXISTS (SELECT 1 FROM plans WHERE is_trial_default = 1 AND active = 1)
           AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?3 AND trial_used_at IS NOT NULL)`,
      )
      .bind(t, workspaceId, userId),
    db
      .prepare(
        `UPDATE users SET trial_used_at = ?1 WHERE id = ?3 AND trial_used_at IS NULL
           AND EXISTS (SELECT 1 FROM workspaces WHERE id = ?2 AND billing_status = 'trialing' AND billing_updated_at = ?1)`,
      )
      .bind(t, workspaceId, userId),
  ];
}
