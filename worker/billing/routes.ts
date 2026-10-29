/**
 * Billing API (docs/hosted-spec.md "API", docs/api.md "Hosted mode"):
 * - workspace: GET /api/billing, POST /api/billing/checkout, POST /api/billing/portal
 * - public: GET /api/billing/plans, POST /api/billing/webhooks/:provider (no session, no same-origin check)
 * - instance admin: /api/admin/billing..., /api/admin/workspaces/:id/billing, /api/admin/signup
 * Each request stays within ≤10 D1 queries and at most one provider fetch.
 */
import { Hono, type Context } from "hono";
import type {
  AdminBillingDTO,
  AdminBillingInput,
  AdminSignupDTO,
  AdminWorkspaceBillingDTO,
  AdminWorkspaceBillingInput,
  BillingDTO,
  BillingInterval,
  BillingProviderId,
  BillingProviderInput,
  BillingSource,
  BillingStatus,
  CheckoutInput,
  PlanInput,
  PublicPlanDTO,
  PublicPlansDTO,
} from "../../shared/types";
import { requireInstancePermission, requirePermission, wsId, type AppEnv } from "../lib/auth";
import { emailConfigured } from "../lib/email";
import { isSignupMode, signupMode } from "../lib/signup";
import { allowedProvidersInput, baseUrl, parseAllowedProviders } from "../lib/settings";
import { providers } from "../providers/registry";
import { newId, now } from "../lib/util";
import {
  SETTING,
  billingProblems,
  isConfigured,
  loadBillingSettings,
  loadProviderConfig,
  providerConfigKey,
  recomputeBillingOn,
  saveProviderConfig,
} from "./config";
import { BILLING_COLUMNS, entitlements, snapshotFromRow, type BillingColumnsRow } from "./entitlements";
import { BILLING_PATH, LIMITS, SUGGESTED_PLANS, usageSummary } from "./host";
import { activePlans, adminPlan, checkoutIntervals, parsePlanInput, parseProviderPrices, publicPlan, type PlanRow } from "./plans";
import { BILLING_PROVIDERS, getBillingProvider, isBillingProviderId } from "./providers";
import { ProviderApiError } from "./types";
import { handleWebhook } from "./webhooks";

type Ctx = Context<AppEnv>;

const STATUSES: BillingStatus[] = ["none", "trialing", "active", "past_due", "canceled", "expired"];

interface WorkspaceBillingRow {
  id: string;
  name: string;
  is_demo: number;
  created_at: number;
  plan_id: string | null;
  plan_name: string | null;
  billing_status: BillingStatus;
  trial_ends_at: number | null;
  current_period_end: number | null;
  billing_provider: BillingSource | null;
  billing_customer_id: string | null;
  billing_subscription_id: string | null;
  billing_interval: BillingInterval | null;
  billing_exempt: number;
  billing_updated_at: number | null;
  allowed_providers: string | null;
}

const WS_BILLING_SQL = `SELECT w.id, w.name, w.is_demo, w.created_at, w.plan_id, p.name AS plan_name, w.billing_status, w.trial_ends_at, w.current_period_end,
  w.billing_provider, w.billing_customer_id, w.billing_subscription_id, w.billing_interval, w.billing_exempt, w.billing_updated_at, w.allowed_providers, ${BILLING_COLUMNS}
  FROM workspaces w LEFT JOIN plans p ON p.id = w.plan_id`;

const workspaceBilling = (db: D1Database, id: string) => db.prepare(`${WS_BILLING_SQL} WHERE w.id = ?`).bind(id).first<WorkspaceBillingRow & BillingColumnsRow>();

/** A provider subscription that still runs (change plans in the portal, not through a second checkout). */
function hasLiveSubscription(r: WorkspaceBillingRow, t: number): boolean {
  if (!r.billing_subscription_id || !isBillingProviderId(r.billing_provider)) return false;
  return r.billing_status === "active" || r.billing_status === "past_due" || (r.billing_status === "canceled" && (r.current_period_end ?? 0) > t);
}

const activeProviderId = async (db: D1Database): Promise<BillingProviderId | null> => {
  const v = (await db.prepare("SELECT value FROM settings WHERE key = ?").bind(SETTING.provider).first<{ value: string }>())?.value;
  return isBillingProviderId(v) ? v : null;
};

// ---------------------------------------------------------------------------------------------------------------
// Workspace

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.get("/billing", requirePermission("posts.read"), async (c) => {
  const db = c.env.DB;
  const t = now();
  const [row, provider, { results: rows }] = await Promise.all([
    workspaceBilling(db, wsId(c)),
    activeProviderId(db),
    // Active plans for the pricing cards, plus the workspace's own plan even when archived.
    db.prepare("SELECT * FROM plans WHERE active = 1 OR id = (SELECT plan_id FROM workspaces WHERE id = ?) ORDER BY position, created_at").bind(wsId(c)).all<PlanRow>(),
  ]);
  if (!row) return c.json({ error: "Workspace not found" }, 404);
  const snap = snapshotFromRow(row);
  const ent = entitlements(snap, t);
  const effective = ent.plan ? rows.find((p) => p.id === ent.plan!.id) : undefined;
  const fallback = (p: NonNullable<typeof ent.plan>): PublicPlanDTO => ({
    id: p.id,
    name: p.name,
    description: "",
    features: [],
    limits: p.limits,
    priceMonth: null,
    priceYear: null,
    currency: rows[0]?.currency ?? "USD",
    isFree: false,
    isTrialDefault: false,
    highlight: false,
    position: 0,
    checkoutIntervals: [],
  });
  const body: BillingDTO = {
    enabled: snap.on,
    exempt: snap.exempt || snap.demo,
    state: ent.state,
    plan: effective ? publicPlan(effective, provider) : ent.plan ? fallback(ent.plan) : null,
    subscribedPlanId: row.plan_id,
    status: row.billing_status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodEnd: row.current_period_end,
    graceEndsAt: ent.graceEndsAt,
    interval: row.billing_interval,
    provider: row.billing_provider,
    hasSubscription: hasLiveSubscription(row, t),
    usage: snap.on ? await usageSummary(db, row.id, t) : null,
    limits: ent.limits,
    plans: snap.on ? rows.filter((p) => p.active).map((p) => publicPlan(p, provider)) : [],
    canManage: !!c.var.workspace?.permissions.includes("billing.manage"),
  };
  return c.json(body);
});

billingRoutes.post("/billing/checkout", requirePermission("billing.manage"), async (c) => {
  const body = await c.req.json<Partial<CheckoutInput>>().catch(() => ({}) as Partial<CheckoutInput>);
  if (typeof body.planId !== "string" || !body.planId) return c.json({ error: "planId is required" }, 400);
  if (body.interval !== "month" && body.interval !== "year") return c.json({ error: "interval must be month or year" }, 400);
  const db = c.env.DB;
  const t = now();
  const [row, providerId, plan] = await Promise.all([
    workspaceBilling(db, wsId(c)),
    activeProviderId(db),
    db.prepare("SELECT * FROM plans WHERE id = ?").bind(body.planId).first<PlanRow>(),
  ]);
  if (!row) return c.json({ error: "Workspace not found" }, 404);
  const snap = snapshotFromRow(row);
  if (!snap.on) return c.json({ error: "Billing is not enabled on this instance" }, 409);
  if (snap.exempt || snap.demo) return c.json({ error: "This workspace is not billed (comped by an instance admin)" }, 409);
  if (hasLiveSubscription(row, t)) {
    return c.json({ error: "This workspace already has a subscription: change or cancel it in the billing portal (Manage billing)" }, 409);
  }
  if (!plan || !plan.active) return c.json({ error: "Plan not found" }, 404);
  if (plan.is_free) return c.json({ error: "The free plan needs no checkout" }, 400);
  const provider = getBillingProvider(providerId);
  const cfg = provider ? await loadProviderConfig(c.env, provider.id) : null;
  if (!provider || !isConfigured(provider, cfg)) return c.json({ error: "No payment provider is configured for new sales" }, 409);
  const price = body.interval === "month" ? plan.price_month : plan.price_year;
  const ref = checkoutIntervals(plan, provider.id).includes(body.interval) ? (parseProviderPrices(plan.provider_prices)[provider.id]?.[body.interval] ?? null) : null;
  if (price === null || !ref) return c.json({ error: `${plan.name} cannot be bought ${body.interval === "month" ? "monthly" : "yearly"} right now` }, 400);
  const base = (await baseUrl(c.env, c.req.url)) + BILLING_PATH;
  try {
    const out = await provider.createCheckout(cfg!, {
      workspaceId: row.id,
      planId: plan.id,
      interval: body.interval,
      productRef: ref,
      email: c.var.user.email,
      successUrl: `${base}&checkout=success`,
      cancelUrl: `${base}&checkout=canceled`,
      customerId: row.billing_provider === provider.id ? row.billing_customer_id : null,
    });
    return c.json(out);
  } catch (err) {
    return c.json({ error: (err as Error).message }, err instanceof ProviderApiError ? 502 : 500);
  }
});

billingRoutes.post("/billing/portal", requirePermission("billing.manage"), async (c) => {
  const row = await workspaceBilling(c.env.DB, wsId(c));
  if (!row) return c.json({ error: "Workspace not found" }, 404);
  const provider = getBillingProvider(row.billing_provider);
  if (!provider || (!row.billing_customer_id && !row.billing_subscription_id)) return c.json({ error: "This workspace has no subscription with a payment provider" }, 409);
  const cfg = await loadProviderConfig(c.env, provider.id);
  if (!isConfigured(provider, cfg)) return c.json({ error: `${provider.name} is no longer configured on this instance: ask an instance admin` }, 409);
  try {
    const url = await provider.portalUrl(cfg!, {
      workspaceId: row.id,
      customerId: row.billing_customer_id,
      subscriptionId: row.billing_subscription_id,
      returnUrl: (await baseUrl(c.env, c.req.url)) + BILLING_PATH,
    });
    return c.json({ url });
  } catch (err) {
    return c.json({ error: (err as Error).message }, err instanceof ProviderApiError ? 502 : 409);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Public

export const billingPublicRoutes = new Hono<AppEnv>();

billingPublicRoutes.get("/plans", async (c) => {
  const db = c.env.DB;
  const [on, provider] = await Promise.all([db.prepare("SELECT 1 AS x FROM settings WHERE key = ? AND value = '1'").bind(SETTING.on).first(), activeProviderId(db)]);
  const plans = on ? await activePlans(db) : [];
  const body: PublicPlansDTO = { enabled: !!on, currency: plans[0]?.currency ?? "USD", plans: plans.map((p) => publicPlan(p, provider)) };
  c.header("cache-control", "no-store");
  return c.json(body);
});

billingPublicRoutes.post("/webhooks/:provider", async (c) => {
  const res = await handleWebhook(c.env, c.req.param("provider"), c.req.raw.headers, await c.req.text());
  return c.json(res.body, res.status);
});

// ---------------------------------------------------------------------------------------------------------------
// Instance admin

export const billingAdminRoutes = new Hono<AppEnv>();
const manageSettings = requireInstancePermission("instance.settings.manage");
const manageUsers = requireInstancePermission("instance.users.manage");

async function adminState(c: Ctx): Promise<AdminBillingDTO> {
  const s = await loadBillingSettings(c.env);
  const base = await baseUrl(c.env, c.req.url);
  return {
    enabled: s.enabled,
    active: s.on,
    problems: await billingProblems(c.env, s),
    activeProvider: s.activeProvider,
    providers: BILLING_PROVIDERS.map((p) => {
      const cfg = s.configs.get(p.id) ?? null;
      return {
        id: p.id,
        name: p.name,
        recommended: p.recommended,
        description: p.description,
        configured: isConfigured(p, cfg),
        sandbox: p.hasSandbox ? !!cfg?.sandbox : null,
        webhookUrl: `${base}/api/billing/webhooks/${p.id}`,
        events: p.events,
        dashboardUrl: p.dashboardUrl,
        fields: p.fields.map((f) => {
          const v = cfg?.values[f.key];
          return { key: f.key, label: f.label, secret: f.secret, ...(f.help ? { help: f.help } : {}), set: !!v, value: !f.secret && v ? v : null };
        }),
      };
    }),
    trialDays: s.trialDays,
    pastDueGraceDays: s.graceDays,
    signupEnabled: s.signupEnabled,
    emailConfigured: emailConfigured(c.env),
    limits: LIMITS.map(({ noun: _n, ...l }) => l),
  };
}

const setOrDelete = (db: D1Database, key: string, value: string | null) =>
  value === null
    ? db.prepare("DELETE FROM settings WHERE key = ?").bind(key)
    : db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);

billingAdminRoutes.get("/admin/billing", manageSettings, async (c) => c.json(await adminState(c)));

billingAdminRoutes.patch("/admin/billing", manageSettings, async (c) => {
  const body = await c.req.json<AdminBillingInput>().catch(() => ({}) as AdminBillingInput);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  if (body.activeProvider !== undefined) {
    if (body.activeProvider !== null && !isBillingProviderId(body.activeProvider)) return c.json({ error: "Unknown provider" }, 400);
    stmts.push(setOrDelete(db, SETTING.provider, body.activeProvider));
  }
  for (const [key, setting, max] of [["trialDays", SETTING.trialDays, 365], ["pastDueGraceDays", SETTING.graceDays, 90]] as const) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < 0 || n > max) return c.json({ error: `${key} must be a whole number of days between 0 and ${max}` }, 400);
    stmts.push(setOrDelete(db, setting, String(n)));
  }
  if (body.signupEnabled !== undefined) {
    if (typeof body.signupEnabled !== "boolean") return c.json({ error: "signupEnabled must be true or false" }, 400);
    // Older clients: on = open, off only turns off open sign-up (not "Request access").
    stmts.push(body.signupEnabled ? setOrDelete(db, SETTING.signup, "open") : db.prepare("DELETE FROM settings WHERE key = ? AND value = 'open'").bind(SETTING.signup));
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    if (body.enabled) {
      // Checked against the settings as they will be after this request.
      const s = await loadBillingSettings(c.env);
      if (body.activeProvider !== undefined) s.activeProvider = body.activeProvider;
      const problems = await billingProblems(c.env, s);
      if (problems.length) return c.json({ error: `Billing can't be turned on yet: ${problems.join(" ")}`, problems }, 400);
    }
    stmts.push(setOrDelete(db, SETTING.enabled, body.enabled ? "1" : null));
  }
  if (stmts.length) await db.batch(stmts);
  await recomputeBillingOn(c.env);
  return c.json(await adminState(c));
});

billingAdminRoutes.put("/admin/billing/providers/:id", manageSettings, async (c) => {
  const provider = getBillingProvider(c.req.param("id"));
  if (!provider) return c.json({ error: "Unknown provider" }, 404);
  const body = await c.req.json<Partial<BillingProviderInput>>().catch(() => ({}) as Partial<BillingProviderInput>);
  if (!body.values || typeof body.values !== "object") return c.json({ error: "values must be an object of the provider's fields" }, 400);
  const old = await loadProviderConfig(c.env, provider.id);
  const values: Record<string, string> = { ...(old?.values ?? {}) };
  for (const [k, v] of Object.entries(body.values)) {
    const field = provider.fields.find((f) => f.key === k);
    if (!field) return c.json({ error: `Unknown field ${k} (fields: ${provider.fields.map((f) => f.key).join(", ")})` }, 400);
    if (typeof v !== "string") return c.json({ error: `${field.label} must be a string` }, 400);
    const val = v.trim();
    // An empty secret keeps the stored one (the UI never sees it); an empty plain field clears it.
    if (!val && field.secret) continue;
    if (val.length > 500) return c.json({ error: `${field.label} is too long` }, 400);
    if (val) values[k] = val;
    else delete values[k];
  }
  if (body.sandbox !== undefined && typeof body.sandbox !== "boolean") return c.json({ error: "sandbox must be true or false" }, 400);
  await saveProviderConfig(c.env, provider.id, { values, ...(provider.hasSandbox ? { sandbox: body.sandbox ?? old?.sandbox ?? false } : {}) });
  await recomputeBillingOn(c.env);
  return c.json(await adminState(c));
});

billingAdminRoutes.delete("/admin/billing/providers/:id", manageSettings, async (c) => {
  const provider = getBillingProvider(c.req.param("id"));
  if (!provider) return c.json({ error: "Unknown provider" }, 404);
  const s = await loadBillingSettings(c.env);
  if (s.enabled && s.activeProvider === provider.id) {
    return c.json({ error: `${provider.name} sells new subscriptions: choose another provider or turn billing off first` }, 409);
  }
  await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(providerConfigKey(provider.id)).run();
  await recomputeBillingOn(c.env);
  return c.json(await adminState(c));
});

billingAdminRoutes.post("/admin/billing/providers/:id/test", manageSettings, async (c) => {
  const provider = getBillingProvider(c.req.param("id"));
  if (!provider) return c.json({ error: "Unknown provider" }, 404);
  const cfg = await loadProviderConfig(c.env, provider.id);
  if (!isConfigured(provider, cfg)) return c.json({ ok: false, error: `Enter the ${provider.name} credentials first` });
  return c.json(await provider.verify(cfg!));
});

// Plans

const PLAN_LIST = `SELECT p.*, (SELECT COUNT(*) FROM workspaces w WHERE w.plan_id = p.id) AS workspaces FROM plans p`;

async function loadAdminPlan(db: D1Database, id: string) {
  const row = await db.prepare(`${PLAN_LIST} WHERE p.id = ?`).bind(id).first<PlanRow & { workspaces: number }>();
  return row ? adminPlan(row) : null;
}

/** Statements clearing is_free / is_trial_default on the other plans when this one takes it. */
function exclusiveFlags(db: D1Database, id: string, values: Record<string, unknown>) {
  return (["is_free", "is_trial_default"] as const).filter((k) => values[k] === 1).map((k) => db.prepare(`UPDATE plans SET ${k} = 0 WHERE id != ?`).bind(id));
}

billingAdminRoutes.get("/admin/billing/plans", manageSettings, async (c) => {
  const { results } = await c.env.DB.prepare(`${PLAN_LIST} ORDER BY p.active DESC, p.position, p.created_at`).all<PlanRow & { workspaces: number }>();
  return c.json(results.map(adminPlan));
});

async function insertPlan(db: D1Database, values: Record<string, string | number | null>) {
  const id = newId("pln_");
  const t = now();
  const cols = { ...values, id, created_at: t, updated_at: t };
  await db.batch([
    db.prepare(`INSERT INTO plans (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).bind(...Object.values(cols)),
    ...exclusiveFlags(db, id, values),
  ]);
  return id;
}

billingAdminRoutes.post("/admin/billing/plans", manageSettings, async (c) => {
  const input = parsePlanInput(await c.req.json<Partial<PlanInput>>().catch(() => ({})), false);
  if ("error" in input) return c.json(input, 400);
  const id = await insertPlan(c.env.DB, input as Record<string, string | number | null>);
  await recomputeBillingOn(c.env);
  return c.json(await loadAdminPlan(c.env.DB, id), 201);
});

/** "Create suggested plans": Free, Creator, Team (docs/hosted-spec.md), without provider ids. */
billingAdminRoutes.post("/admin/billing/plans/suggested", manageSettings, async (c) => {
  const ids: string[] = [];
  for (const p of SUGGESTED_PLANS) {
    const input = parsePlanInput(JSON.parse(JSON.stringify(p)) as PlanInput, false);
    if ("error" in input) return c.json(input, 500);
    ids.push(await insertPlan(c.env.DB, input as Record<string, string | number | null>));
  }
  await recomputeBillingOn(c.env);
  const { results } = await c.env.DB.prepare(`${PLAN_LIST} WHERE p.id IN (${ids.map(() => "?").join(",")}) ORDER BY p.position`).bind(...ids).all<PlanRow & { workspaces: number }>();
  return c.json(results.map(adminPlan), 201);
});

billingAdminRoutes.patch("/admin/billing/plans/:id", manageSettings, async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  if (!(await db.prepare("SELECT 1 AS x FROM plans WHERE id = ?").bind(id).first())) return c.json({ error: "Plan not found" }, 404);
  const input = parsePlanInput(await c.req.json<Partial<PlanInput>>().catch(() => ({})), true);
  if ("error" in input) return c.json(input, 400);
  const keys = Object.keys(input);
  if (keys.length) {
    await db.batch([
      db.prepare(`UPDATE plans SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...Object.values(input), now(), id),
      ...exclusiveFlags(db, id, input),
    ]);
  }
  await recomputeBillingOn(c.env);
  return c.json(await loadAdminPlan(db, id));
});

/** Deletes a plan without workspaces; one that still has workspaces is archived instead (`archived: true`). */
billingAdminRoutes.delete("/admin/billing/plans/:id", manageSettings, async (c) => {
  const plan = await loadAdminPlan(c.env.DB, c.req.param("id"));
  if (!plan) return c.json({ error: "Plan not found" }, 404);
  if (plan.workspaces) {
    await c.env.DB.prepare("UPDATE plans SET active = 0, is_trial_default = 0, updated_at = ? WHERE id = ?").bind(now(), plan.id).run();
  } else {
    await c.env.DB.prepare("DELETE FROM plans WHERE id = ? AND NOT EXISTS (SELECT 1 FROM workspaces WHERE plan_id = ?)").bind(plan.id, plan.id).run();
  }
  await recomputeBillingOn(c.env);
  return c.json({ ok: true, ...(plan.workspaces ? { archived: true } : {}) });
});

// Workspaces (support: comp a workspace, assign a plan by hand)

function adminWorkspaceDto(r: WorkspaceBillingRow & BillingColumnsRow, t = now()): AdminWorkspaceBillingDTO {
  return {
    workspaceId: r.id,
    workspaceName: r.name,
    demo: !!r.is_demo,
    exempt: !!r.billing_exempt,
    state: entitlements(snapshotFromRow(r), t).state,
    planId: r.plan_id,
    planName: r.plan_name,
    status: r.billing_status,
    trialEndsAt: r.trial_ends_at,
    currentPeriodEnd: r.current_period_end,
    interval: r.billing_interval,
    provider: r.billing_provider,
    customerId: r.billing_customer_id,
    subscriptionId: r.billing_subscription_id,
    updatedAt: r.billing_updated_at,
    createdAt: r.created_at,
    allowedProviders: parseAllowedProviders(r.allowed_providers),
  };
}

/** GET /api/admin/billing/workspaces?status=active,trialing: every workspace's billing (newest first, max 500). */
billingAdminRoutes.get("/admin/billing/workspaces", manageUsers, async (c) => {
  const status = (c.req.query("status") ?? "").split(",").filter((s): s is BillingStatus => STATUSES.includes(s as BillingStatus));
  const { results } = await c.env.DB.prepare(
    `${WS_BILLING_SQL} ${status.length ? `WHERE w.billing_status IN (${status.map(() => "?").join(",")})` : ""} ORDER BY w.created_at DESC LIMIT 500`,
  )
    .bind(...status)
    .all<WorkspaceBillingRow & BillingColumnsRow>();
  const t = now();
  return c.json(results.map((r) => adminWorkspaceDto(r, t)));
});

billingAdminRoutes.get("/admin/workspaces/:id/billing", manageUsers, async (c) => {
  const row = await workspaceBilling(c.env.DB, c.req.param("id"));
  return row ? c.json(adminWorkspaceDto(row)) : c.json({ error: "Workspace not found" }, 404);
});

billingAdminRoutes.patch("/admin/workspaces/:id/billing", manageUsers, async (c) => {
  const db = c.env.DB;
  const row = await workspaceBilling(db, c.req.param("id"));
  if (!row) return c.json({ error: "Workspace not found" }, 404);
  const body = await c.req.json<AdminWorkspaceBillingInput>().catch(() => ({}) as AdminWorkspaceBillingInput);
  const t = now();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.exempt !== undefined) {
    if (typeof body.exempt !== "boolean") return c.json({ error: "exempt must be true or false" }, 400);
    sets.push("billing_exempt = ?") && binds.push(body.exempt ? 1 : 0);
  }
  if (body.status !== undefined && !STATUSES.includes(body.status)) return c.json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
  for (const k of ["trialEndsAt", "currentPeriodEnd"] as const) {
    if (body[k] !== undefined && body[k] !== null && !(Number.isFinite(body[k]) && body[k]! > 0)) return c.json({ error: `${k} must be a ms timestamp or null` }, 400);
  }
  let status = body.status;
  if (body.planId !== undefined) {
    if (body.planId !== null && !(await db.prepare("SELECT 1 AS x FROM plans WHERE id = ?").bind(body.planId).first())) return c.json({ error: "Plan not found" }, 404);
    sets.push("plan_id = ?") && binds.push(body.planId);
    status ??= body.planId === null ? "none" : body.trialEndsAt ? "trialing" : "active";
  } else if (body.trialEndsAt && !status) status = "trialing";
  if (status !== undefined) {
    sets.push("billing_status = ?", "billing_past_due_since = ?") && binds.push(status, status === "past_due" ? t : null);
    // Hand-assigned: provider "manual" (webhooks of a provider subscription that still runs take over again).
    if (status !== "none") sets.push("billing_provider = 'manual'");
  }
  if (body.trialEndsAt !== undefined) sets.push("trial_ends_at = ?") && binds.push(body.trialEndsAt);
  if (body.currentPeriodEnd !== undefined) sets.push("current_period_end = ?") && binds.push(body.currentPeriodEnd);
  let allowed: string | null | undefined;
  if (body.allowedProviders !== undefined) {
    const list = allowedProvidersInput(body.allowedProviders, providers.map((p) => p.id));
    if (list === undefined) return c.json({ error: "allowedProviders must be null or an array of platform ids" }, 400);
    allowed = list && JSON.stringify(list);
  }
  if (!sets.length && allowed === undefined) return c.json({ error: "Nothing to change (exempt, planId, status, trialEndsAt, currentPeriodEnd or allowedProviders)" }, 400);
  // Platforms are not billing: changing only them leaves billing_updated_at alone.
  if (sets.length) await db.prepare(`UPDATE workspaces SET ${sets.join(", ")}, billing_updated_at = ? WHERE id = ?`).bind(...binds, t, row.id).run();
  if (allowed !== undefined) await db.prepare("UPDATE workspaces SET allowed_providers = ? WHERE id = ?").bind(allowed, row.id).run();
  return c.json(adminWorkspaceDto((await workspaceBilling(db, row.id))!));
});

// Sign-up mode (the Admin → Settings "Sign-up" card): off | apply | open

async function signupState(env: Env): Promise<AdminSignupDTO> {
  const mode = await signupMode(env.DB);
  return { mode, enabled: mode === "open", emailConfigured: emailConfigured(env) };
}

billingAdminRoutes.get("/admin/signup", manageSettings, async (c) => c.json(await signupState(c.env)));

billingAdminRoutes.patch("/admin/signup", manageSettings, async (c) => {
  const body = await c.req.json<{ mode?: unknown; enabled?: unknown }>().catch(() => ({}) as { mode?: unknown; enabled?: unknown });
  // `{ enabled }` from older clients: true = open, false = off.
  const mode = body.mode !== undefined ? body.mode : typeof body.enabled === "boolean" ? (body.enabled ? "open" : "off") : undefined;
  if (!isSignupMode(mode)) return c.json({ error: "mode must be off, apply or open" }, 400);
  await setOrDelete(c.env.DB, SETTING.signup, mode === "off" ? null : mode).run();
  return c.json(await signupState(c.env));
});
