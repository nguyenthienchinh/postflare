/**
 * Instance billing settings (table `settings`) and provider credentials. `billing_on` is derived: it is recomputed by
 * every admin change (enabled switch, providers, plans) and read inside the workspace query of every request
 * (entitlements.ts BILLING_COLUMNS), so a request with billing off costs no extra D1 query.
 */
import type { BillingProviderId } from "../../shared/types";
import { decryptJson, encryptJson } from "../lib/crypto";
import { getSetting, setSetting } from "../lib/settings";
import { now } from "../lib/util";
import { BILLING_PROVIDERS, getBillingProvider, isBillingProviderId } from "./providers";
import type { BillingProvider, ProviderConfig } from "./types";

export const SETTING = {
  /** The admin switch ("1" = on). */
  enabled: "billing_enabled",
  /** Derived: "1" while billing is in effect (see `recomputeBillingOn`). */
  on: "billing_on",
  /** Provider of new checkouts. */
  provider: "billing_provider",
  trialDays: "billing_trial_days",
  graceDays: "billing_past_due_grace_days",
  /** First time billing went on (workspaces created before it are made exempt then). */
  activatedAt: "billing_activated_at",
  /** How people get an account: off (absent) | apply | open (worker/lib/signup.ts). */
  signup: "signup_mode",
} as const;

export const providerConfigKey = (id: BillingProviderId) => `billing_provider:${id}`;

export const DEFAULT_TRIAL_DAYS = 7;
export const DEFAULT_GRACE_DAYS = 7;

export function parseDays(v: string | null | undefined, fallback: number): number {
  const n = v === null || v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export async function loadProviderConfig(env: Env, id: BillingProviderId): Promise<ProviderConfig | null> {
  const blob = await getSetting(env.DB, providerConfigKey(id));
  if (!blob) return null;
  try {
    return await decryptJson<ProviderConfig>(env, blob);
  } catch {
    return null;
  }
}

export async function saveProviderConfig(env: Env, id: BillingProviderId, cfg: ProviderConfig): Promise<void> {
  await setSetting(env.DB, providerConfigKey(id), await encryptJson(env, cfg));
}

/** Every required (non-optional) field has a value. */
export const isConfigured = (p: BillingProvider, cfg: ProviderConfig | null) => !!cfg && p.fields.every((f) => f.optional || !!cfg.values[f.key]?.trim());

/** Everything Admin → Billing shows, from one batch: settings plus provider configs (decrypted). */
export async function loadBillingSettings(env: Env) {
  const db = env.DB;
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'billing_%' OR key = ?").bind(SETTING.signup).all<{ key: string; value: string }>();
  const s = new Map(results.map((r) => [r.key, r.value]));
  const configs = new Map<BillingProviderId, ProviderConfig | null>();
  for (const p of BILLING_PROVIDERS) {
    const blob = s.get(providerConfigKey(p.id));
    configs.set(p.id, blob ? await decryptJson<ProviderConfig>(env, blob).catch(() => null) : null);
  }
  const provider = s.get(SETTING.provider);
  return {
    enabled: s.get(SETTING.enabled) === "1",
    on: s.get(SETTING.on) === "1",
    activeProvider: isBillingProviderId(provider) ? provider : null,
    trialDays: parseDays(s.get(SETTING.trialDays), DEFAULT_TRIAL_DAYS),
    graceDays: parseDays(s.get(SETTING.graceDays), DEFAULT_GRACE_DAYS),
    signupEnabled: s.get(SETTING.signup) === "open",
    activatedAt: s.has(SETTING.activatedAt) ? Number(s.get(SETTING.activatedAt)) : null,
    configs,
  };
}

export type BillingSettings = Awaited<ReturnType<typeof loadBillingSettings>>;

/** Why billing cannot be in effect (empty = it can). */
export async function billingProblems(env: Env, s: BillingSettings): Promise<string[]> {
  const problems: string[] = [];
  const provider = getBillingProvider(s.activeProvider);
  if (!provider) problems.push("Choose the payment provider for new sales.");
  else if (!isConfigured(provider, s.configs.get(provider.id) ?? null)) problems.push(`Enter the ${provider.name} credentials.`);
  const paid = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM plans WHERE active = 1 AND is_free = 0 AND (price_month IS NOT NULL OR price_year IS NOT NULL)",
  ).first<{ n: number }>();
  if (!paid?.n) problems.push("Create at least one active paid plan (with a monthly or yearly price).");
  return problems;
}

/**
 * Recomputes the derived `billing_on` setting after an admin change. The first time billing goes on, every workspace
 * that exists without a plan becomes exempt (the operator's own workspaces, docs/hosted-spec.md "Exempt workspace").
 */
export async function recomputeBillingOn(env: Env): Promise<boolean> {
  const s = await loadBillingSettings(env);
  const on = s.enabled && !(await billingProblems(env, s)).length;
  const db = env.DB;
  if (on && !s.on) {
    const t = now();
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").bind(SETTING.on),
      ...(s.activatedAt === null
        ? [
            db.prepare("UPDATE workspaces SET billing_exempt = 1 WHERE plan_id IS NULL AND billing_status = 'none' AND created_at <= ?").bind(t),
            db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(SETTING.activatedAt, String(t)),
          ]
        : []),
    ]);
  } else if (!on && s.on) {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(SETTING.on).run();
  }
  return on;
}

/** Billing in effect (one settings read; request handlers read it from the workspace row instead). */
export const billingOn = async (db: D1Database) => (await getSetting(db, SETTING.on)) === "1";

/** Public sign-up (/signup) is on: signup_mode open. */
export const signupEnabled = async (db: D1Database) => (await getSetting(db, SETTING.signup)) === "open";
