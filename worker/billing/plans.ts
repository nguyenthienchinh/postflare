// Plans (table `plans`): rows, DTOs, input validation, the product id → plan mapping of webhooks.

import type { AdminPlanDTO, BillingInterval, BillingProviderId, PlanInput, PlanLimits, ProviderPrices, PublicPlanDTO } from "../../shared/types";
import { parseJson } from "../lib/util";
import { LIMITS } from "./host";
import { BILLING_PROVIDERS } from "./providers";

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  features: string;
  limits: string;
  price_month: number | null;
  price_year: number | null;
  currency: string;
  provider_prices: string;
  is_free: number;
  is_trial_default: number;
  highlight: number;
  position: number;
  active: number;
  created_at: number;
  updated_at: number;
}

export const parseLimits = (json: string | null | undefined): PlanLimits => parseJson<PlanLimits>(json, {});
export const parseProviderPrices = (json: string | null | undefined): ProviderPrices => parseJson<ProviderPrices>(json, {});

/** Intervals of a plan that can be bought through `provider` (price and product id set). */
export function checkoutIntervals(row: PlanRow, provider: BillingProviderId | null): BillingInterval[] {
  if (row.is_free || !row.active || !provider) return [];
  const refs = parseProviderPrices(row.provider_prices)[provider] ?? {};
  return (["month", "year"] as const).filter((i) => (i === "month" ? row.price_month : row.price_year) !== null && !!refs[i]);
}

export function publicPlan(row: PlanRow, provider: BillingProviderId | null): PublicPlanDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    features: parseJson<string[]>(row.features, []),
    limits: parseLimits(row.limits),
    priceMonth: row.price_month,
    priceYear: row.price_year,
    currency: row.currency,
    isFree: !!row.is_free,
    isTrialDefault: !!row.is_trial_default,
    highlight: !!row.highlight,
    position: row.position,
    checkoutIntervals: checkoutIntervals(row, provider),
  };
}

export function adminPlan(row: PlanRow & { workspaces?: number }): AdminPlanDTO {
  const { checkoutIntervals: _c, ...p } = publicPlan(row, null);
  return { ...p, providerPrices: parseProviderPrices(row.provider_prices), active: !!row.active, workspaces: row.workspaces ?? 0, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function activePlans(db: D1Database): Promise<PlanRow[]> {
  const { results } = await db.prepare("SELECT * FROM plans WHERE active = 1 ORDER BY position, created_at").all<PlanRow>();
  return results;
}

/** The plan and interval a provider product/price/variant id belongs to (archived plans included: they keep subscribers). */
export function planForProduct(plans: PlanRow[], provider: BillingProviderId, ref: string | undefined): { planId: string; interval: BillingInterval } | null {
  if (!ref) return null;
  for (const p of plans) {
    const refs = parseProviderPrices(p.provider_prices)[provider] ?? {};
    for (const interval of ["month", "year"] as const) if (refs[interval] === ref) return { planId: p.id, interval };
  }
  return null;
}

const cents = (v: unknown, what: string): number | null | { error: string } => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100_000_000 ? n : { error: `${what} must be a whole number of cents (or null)` };
};

/** Validated column values of a plan body (`partial` for PATCH). */
export function parsePlanInput(body: Partial<PlanInput>, partial: boolean): { error: string } | Partial<Record<keyof PlanRow, string | number | null>> {
  const out: Partial<Record<keyof PlanRow, string | number | null>> = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) return { error: "Name is required" };
    out.name = name;
  }
  if (body.description !== undefined) out.description = String(body.description ?? "").slice(0, 500);
  if (body.features !== undefined) {
    if (!Array.isArray(body.features) || body.features.some((f) => typeof f !== "string")) return { error: "features must be an array of strings" };
    out.features = JSON.stringify(body.features.map((f) => f.trim().slice(0, 120)).filter(Boolean).slice(0, 20));
  }
  if (body.limits !== undefined) {
    if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits)) return { error: "limits must be an object" };
    const limits: Record<string, number | boolean | null> = {};
    for (const [k, v] of Object.entries(body.limits)) {
      const info = LIMITS.find((l) => l.key === k);
      if (!info) return { error: `Unknown limit ${k} (known: ${LIMITS.map((l) => l.key).join(", ")})` };
      if (v === null || v === undefined) continue; // unlimited
      if (info.kind === "boolean") {
        if (typeof v !== "boolean") return { error: `${k} must be true, false or null` };
        limits[k] = v;
      } else {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return { error: `${k} must be a whole number (0 or more) or null for unlimited` };
        limits[k] = v;
      }
    }
    out.limits = JSON.stringify(limits);
  }
  for (const [key, col, what] of [["priceMonth", "price_month", "priceMonth"], ["priceYear", "price_year", "priceYear"]] as const) {
    if (body[key] === undefined) continue;
    const v = cents(body[key], what);
    if (v !== null && typeof v === "object") return v;
    out[col] = v;
  }
  if (body.currency !== undefined) {
    const cur = String(body.currency ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) return { error: "currency must be an ISO 4217 code like USD" };
    out.currency = cur;
  }
  if (body.providerPrices !== undefined) {
    const pp = body.providerPrices;
    if (!pp || typeof pp !== "object" || Array.isArray(pp)) return { error: "providerPrices must be an object" };
    const clean: ProviderPrices = {};
    for (const [provider, refs] of Object.entries(pp)) {
      if (!BILLING_PROVIDERS.some((p) => p.id === provider)) return { error: `Unknown provider ${provider} in providerPrices` };
      if (!refs || typeof refs !== "object") return { error: `providerPrices.${provider} must be an object { month?, year? }` };
      const r: Partial<Record<BillingInterval, string>> = {};
      for (const [interval, ref] of Object.entries(refs as Record<string, unknown>)) {
        if (interval !== "month" && interval !== "year") return { error: `providerPrices.${provider}: interval must be month or year` };
        if (ref === null || ref === undefined || ref === "") continue;
        if (typeof ref !== "string" || !/^[\w.:-]{1,120}$/.test(ref.trim())) return { error: `providerPrices.${provider}.${interval} must be a product/price id` };
        r[interval] = ref.trim();
      }
      if (Object.keys(r).length) clean[provider as BillingProviderId] = r;
    }
    out.provider_prices = JSON.stringify(clean);
  }
  for (const [key, col] of [["isFree", "is_free"], ["isTrialDefault", "is_trial_default"], ["highlight", "highlight"], ["active", "active"]] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return { error: `${key} must be true or false` };
    out[col] = body[key] ? 1 : 0;
  }
  if (body.position !== undefined) {
    const n = Number(body.position);
    if (!Number.isInteger(n)) return { error: "position must be a whole number" };
    out.position = n;
  }
  return out;
}
