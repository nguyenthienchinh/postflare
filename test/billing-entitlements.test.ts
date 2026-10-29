import { describe, expect, it } from "vitest";
import { entitlements, type BillingSnapshot } from "../worker/billing/entitlements";
import { lemonStatus } from "../worker/billing/providers/lemonsqueezy";
import { polarStatus } from "../worker/billing/providers/polar";
import { stripeStatus } from "../worker/billing/providers/stripe";
import { monthStart } from "../worker/billing/host";

// Effective plan (docs/hosted-spec.md "Effective plan") with fake timestamps, and the provider status mappings.

const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 17, 12);
const pro = { id: "pln_pro", name: "Pro", limits: { accounts: 10 } };
const free = { id: "pln_free", name: "Free", limits: { accounts: 1 } };
const snap = (over: Partial<BillingSnapshot> = {}): BillingSnapshot => ({
  on: true,
  exempt: false,
  demo: false,
  status: "none",
  planId: null,
  trialEndsAt: null,
  periodEnd: null,
  pastDueSince: null,
  graceDays: 7,
  plan: null,
  free: null,
  ...over,
});

describe("entitlements", () => {
  it("billing off, exempt and demo workspaces are unlimited", () => {
    for (const s of [snap({ on: false }), snap({ exempt: true }), snap({ demo: true }), null]) {
      expect(entitlements(s, T)).toEqual({ billing: false, state: "unlimited", plan: null, limits: null, graceEndsAt: null });
    }
  });

  it("trial until trial_ends_at, then the free plan, else locked", () => {
    const s = snap({ status: "trialing", planId: pro.id, plan: pro, trialEndsAt: T + DAY });
    expect(entitlements(s, T)).toMatchObject({ state: "trial", plan: pro, limits: pro.limits });
    expect(entitlements(s, T + DAY)).toMatchObject({ state: "locked", plan: null, limits: null });
    expect(entitlements({ ...s, free }, T + 2 * DAY)).toMatchObject({ state: "free", plan: free, limits: free.limits });
  });

  it("active; past_due within the grace; canceled until the period end; expired", () => {
    expect(entitlements(snap({ status: "active", plan: pro }), T).state).toBe("plan");
    const pastDue = snap({ status: "past_due", plan: pro, pastDueSince: T - 6 * DAY });
    expect(entitlements(pastDue, T)).toMatchObject({ state: "plan", graceEndsAt: T + DAY });
    expect(entitlements(pastDue, T + DAY).state).toBe("locked");
    expect(entitlements({ ...pastDue, graceDays: 0 }, T).state).toBe("locked");
    const canceled = snap({ status: "canceled", plan: pro, periodEnd: T + DAY });
    expect(entitlements(canceled, T).state).toBe("plan");
    expect(entitlements({ ...canceled, free }, T + DAY).state).toBe("free");
    expect(entitlements(snap({ status: "expired", plan: pro, free }), T).state).toBe("free");
  });

  it("a paying workspace whose plan is gone stays unlimited (admin misconfiguration)", () => {
    expect(entitlements(snap({ status: "active", planId: "pln_deleted" }), T)).toMatchObject({ state: "plan", limits: {} });
  });

  it("counts months in UTC", () => {
    expect(monthStart(Date.UTC(2026, 0, 31, 23, 59))).toBe(Date.UTC(2026, 0, 1));
  });
});

describe("provider status mapping", () => {
  it("Polar", () => {
    expect(polarStatus({ status: "active" }, "subscription.updated", T)).toBe("active");
    expect(polarStatus({ status: "trialing" }, "subscription.updated", T)).toBe("active");
    expect(polarStatus({ status: "active", cancel_at_period_end: true }, "subscription.canceled", T)).toBe("canceled");
    expect(polarStatus({ status: "past_due" }, "subscription.past_due", T)).toBe("past_due");
    expect(polarStatus({ status: "canceled", current_period_end: new Date(T + DAY).toISOString(), ended_at: null }, "subscription.canceled", T)).toBe("canceled");
    expect(polarStatus({ status: "canceled", ended_at: new Date(T).toISOString() }, "subscription.updated", T)).toBe("expired");
    expect(polarStatus({ status: "active" }, "subscription.revoked", T)).toBe("expired");
    expect(polarStatus({ status: "incomplete" }, "subscription.created", T)).toBeUndefined();
  });

  it("Stripe", () => {
    expect(stripeStatus({ status: "active" }, "customer.subscription.updated")).toBe("active");
    expect(stripeStatus({ status: "active", cancel_at: 123 }, "customer.subscription.updated")).toBe("canceled");
    expect(stripeStatus({ status: "unpaid" }, "customer.subscription.updated")).toBe("past_due");
    expect(stripeStatus({ status: "paused" }, "customer.subscription.updated")).toBe("expired");
    expect(stripeStatus({ status: "active" }, "customer.subscription.deleted")).toBe("expired");
    expect(stripeStatus({ status: "incomplete" }, "customer.subscription.created")).toBeUndefined();
  });

  it("Lemon Squeezy", () => {
    expect(lemonStatus({ status: "on_trial" })).toBe("active");
    expect(lemonStatus({ status: "active", cancelled: true })).toBe("canceled");
    expect(lemonStatus({ status: "cancelled" })).toBe("canceled");
    expect(lemonStatus({ status: "unpaid" })).toBe("past_due");
    expect(lemonStatus({ status: "expired" })).toBe("expired");
    expect(lemonStatus({ status: "weird" })).toBeUndefined();
  });
});
