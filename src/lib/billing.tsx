// Hosted mode in the web app (docs/hosted-spec.md "UI"): the current workspace's plan (GET /api/billing), shared by the
// layout banner, the plan-limit dialog and Workspace settings → Billing. Everything here renders nothing while billing
// is off, so a self-hosted instance looks unchanged.

import { createContext, useContext, type ReactNode } from "react";
import { api } from "./api";
import { money } from "./format";
import { useSession } from "./session";
import type { BillingDTO, BillingInterval, BillingState, BillingStatus, BillingUsageDTO, PlanLimitKey, PlanLimits } from "./types";
import { useFetch, type FetchState } from "./useFetch";

/** Workspace settings → Billing (also where 402 answers and checkout returns point). */
export const BILLING_TAB = "/workspace?tab=billing";

const Ctx = createContext<FetchState<BillingDTO> | null>(null);

/** Loads GET /api/billing once per workspace (keyed by the workspace in App.tsx); refetch with invalidate("billing"). */
export function BillingProvider({ children }: { children: ReactNode }) {
  const { can, workspace } = useSession();
  const state = useFetch(workspace && can("posts.read") ? "billing" : null, api.billing.get, ["billing"]);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useBilling(): FetchState<BillingDTO> {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBilling outside BillingProvider");
  return ctx;
}

/** The billing state when billing is on for the instance, else undefined (hide every billing UI). */
export function useBillingOn(): BillingDTO | undefined {
  const { data } = useBilling();
  return data?.enabled ? data : undefined;
}

/** "$19", "$19.50" (integer cents). */
export function formatPrice(cents: number, currency: string): string {
  return money(cents / 100, currency).replace(/\.00$/, "");
}

export const INTERVAL_LABEL: Record<BillingInterval, string> = { month: "month", year: "year" };

export const BILLING_STATUS_META: Record<BillingStatus, { label: string; tone: "zinc" | "green" | "red" | "amber" | "blue" | "brand" }> = {
  none: { label: "No subscription", tone: "zinc" },
  trialing: { label: "Trial", tone: "blue" },
  active: { label: "Active", tone: "green" },
  past_due: { label: "Past due", tone: "amber" },
  canceled: { label: "Canceled", tone: "amber" },
  expired: { label: "Expired", tone: "red" },
};

export const BILLING_STATE_META: Record<BillingState, { label: string; tone: "zinc" | "green" | "red" | "amber" | "blue" | "brand" }> = {
  unlimited: { label: "Unlimited", tone: "zinc" },
  plan: { label: "On a plan", tone: "green" },
  trial: { label: "Trial", tone: "blue" },
  free: { label: "Free plan", tone: "zinc" },
  locked: { label: "Locked", tone: "red" },
};

export const PROVIDER_NAME: Record<string, string> = { polar: "Polar", stripe: "Stripe", lemonsqueezy: "Lemon Squeezy", manual: "an instance admin" };

/** Usage meters of the Billing tab, in display order (labels match the admin catalog, worker/billing/host.ts). */
export const LIMIT_ROWS: Array<{ key: PlanLimitKey; label: string; used: (u: BillingUsageDTO) => number; unit?: "MB" }> = [
  { key: "accounts", label: "Connected accounts", used: (u) => u.accounts },
  { key: "posts_per_month", label: "Posts this month", used: (u) => u.postsThisMonth },
  { key: "x_posts_per_month", label: "X posts this month", used: (u) => u.xPostsThisMonth },
  { key: "members", label: "Members and invitations", used: (u) => u.members },
  { key: "storage_mb", label: "Media storage", used: (u) => u.storageMb, unit: "MB" },
  { key: "api", label: "API, CLI and MCP", used: () => 0 },
];

export const LIMIT_LABEL: Record<PlanLimitKey | "locked", string> = {
  accounts: "connected accounts",
  posts_per_month: "posts this month",
  x_posts_per_month: "X posts this month",
  members: "members",
  storage_mb: "MB of media storage",
  api: "API access",
  locked: "active plan",
};

/** "500 MB", "5 GB" */
export function formatMb(mb: number): string {
  return mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${Math.round(mb * 10) / 10} MB`;
}

/** A plan's limit as text: "10", "5 GB", "Unlimited", "Included" / "Not included". */
export function limitText(limits: PlanLimits | null | undefined, key: PlanLimitKey): string {
  const v = limits?.[key];
  if (key === "api") return v === false ? "Not included" : "Included";
  if (v === null || v === undefined) return "Unlimited";
  return key === "storage_mb" ? formatMb(v as number) : (v as number).toLocaleString("en-US");
}

/** Whole days from now until `t` (ceil; 0 = today or past). */
export function daysUntil(t: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

export const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
