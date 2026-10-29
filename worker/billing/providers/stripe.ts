/**
 * Stripe: secret key (or a restricted key) + webhook signing secret. API: https://docs.stripe.com/api (checked 2026-10).
 * - Checkout Session: POST /v1/checkout/sessions (form-encoded) mode=subscription, line_items[0][price], success_url,
 *   cancel_url, client_reference_id, metadata[workspace_id], subscription_data[metadata][workspace_id] → `url`.
 * - Portal: POST /v1/billing_portal/sessions { customer, return_url } → `url` (the portal must be activated once in
 *   the dashboard: Settings → Billing → Customer portal).
 * - Webhooks: `Stripe-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (several v1 entries while a secret
 *   is rolled), 5 minute tolerance. Since API version 2025-03-31 `current_period_end` lives on the subscription items,
 *   older versions have it on the subscription: both are read.
 * Taxes: enable Stripe Tax yourself (Stripe is not a merchant of record).
 */
import type { BillingStatus } from "../../../shared/types";
import { formBody, fromHex, hmacKey, hmacVerify, providerJson, toMs, WEBHOOK_TOLERANCE_MS } from "../http";
import { WebhookSignatureError, type BillingProvider, type ProviderConfig } from "../types";

const API = "https://api.stripe.com";
const headers = (cfg: ProviderConfig, form = false) => ({
  authorization: `Bearer ${cfg.values.secretKey}`,
  ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
});

/** Verifies a Stripe-Signature header. Throws WebhookSignatureError; returns the signed timestamp (ms). */
export async function verifyStripeSignature(secret: string, header: string, raw: string, now: number): Promise<number> {
  const parts = header.split(",").map((p) => p.trim().split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1] ?? "";
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!/^\d+$/.test(t) || !sigs.length) throw new WebhookSignatureError("Missing or malformed Stripe-Signature header");
  if (Math.abs(now - Number(t) * 1000) > WEBHOOK_TOLERANCE_MS) throw new WebhookSignatureError("Webhook timestamp outside the 5 minute tolerance");
  const key = await hmacKey(secret);
  for (const s of sigs) if (await hmacVerify(key, fromHex(s), `${t}.${raw}`)) return Number(t) * 1000;
  throw new WebhookSignatureError("Invalid webhook signature");
}

export function stripeStatus(sub: any, eventType: string): Exclude<BillingStatus, "none" | "trialing"> | undefined {
  if (eventType === "customer.subscription.deleted") return "expired";
  switch (sub?.status) {
    case "active":
    case "trialing":
      return sub.cancel_at_period_end || sub.cancel_at ? "canceled" : "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "paused":
      return "expired";
    default:
      return undefined; // incomplete, incomplete_expired: the first payment has not gone through
  }
}

const idOf = (v: unknown): string | undefined => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).id === "string" ? (v as any).id : undefined);

export const stripe: BillingProvider = {
  id: "stripe",
  name: "Stripe",
  recommended: false,
  description: "Your own Stripe account. You are the merchant: enable Stripe Tax for VAT / sales tax.",
  hasSandbox: false,
  dashboardUrl: "https://dashboard.stripe.com",
  fields: [
    { key: "secretKey", label: "Secret key", secret: true, help: "Developers → API keys (sk_live_... or sk_test_...; a restricted key needs Checkout Sessions, Customer portal and Account read)." },
    { key: "webhookSecret", label: "Webhook signing secret", secret: true, help: "Developers → Webhooks → Add endpoint, then reveal its signing secret (whsec_...)." },
  ],
  events: ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"],

  async verify(cfg) {
    try {
      const acc = await providerJson("Stripe", `${API}/v1/account`, { headers: headers(cfg) });
      const name = acc?.settings?.dashboard?.display_name ?? acc?.business_profile?.name ?? acc?.id;
      const mode = String(cfg.values.secretKey ?? "").includes("_test_") ? " · test mode" : "";
      return { ok: true, account: name ? `${name}${mode}` : undefined };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async createCheckout(cfg, input) {
    const body = formBody({
      mode: "subscription",
      "line_items[0][price]": input.productRef,
      "line_items[0][quantity]": 1,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.workspaceId,
      "metadata[workspace_id]": input.workspaceId,
      "subscription_data[metadata][workspace_id]": input.workspaceId,
      "subscription_data[metadata][plan_id]": input.planId,
      ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
    });
    const res = await providerJson("Stripe", `${API}/v1/checkout/sessions`, { method: "POST", headers: headers(cfg, true), body });
    if (typeof res?.url !== "string") throw new Error("Stripe did not return a checkout URL");
    return { url: res.url };
  },

  async portalUrl(cfg, input) {
    if (!input.customerId) throw new Error("This workspace has no Stripe customer yet");
    const res = await providerJson("Stripe", `${API}/v1/billing_portal/sessions`, {
      method: "POST",
      headers: headers(cfg, true),
      body: formBody({ customer: input.customerId, return_url: input.returnUrl }),
    });
    if (typeof res?.url !== "string") throw new Error("Stripe did not return a portal URL");
    return res.url;
  },

  async parseWebhook(cfg, h, raw, now) {
    const signedAt = await verifyStripeSignature(cfg.values.webhookSecret ?? "", h.get("stripe-signature") ?? "", raw, now);
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new WebhookSignatureError("Body is not JSON");
    }
    const obj = event?.data?.object ?? {};
    const occurredAt = toMs(event.created, "seconds") ?? signedAt;
    if (event.type === "checkout.session.completed") {
      if (obj.mode !== "subscription") return null;
      return {
        id: String(event.id),
        type: "checkout.completed",
        workspaceId: obj.client_reference_id ?? obj.metadata?.workspace_id ?? null,
        customerId: idOf(obj.customer),
        subscriptionId: idOf(obj.subscription),
        occurredAt,
      };
    }
    if (!["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) return null;
    const status = stripeStatus(obj, event.type);
    if (!status) return null;
    const item = obj.items?.data?.[0] ?? {};
    const interval = item.price?.recurring?.interval;
    const periodEnd = toMs(obj.current_period_end ?? item.current_period_end, "seconds");
    const cancelAt = toMs(obj.cancel_at, "seconds");
    return {
      id: String(event.id),
      type: status === "expired" ? "subscription.deleted" : "subscription.updated",
      workspaceId: obj.metadata?.workspace_id ?? null,
      customerId: idOf(obj.customer),
      subscriptionId: obj.id,
      status,
      productRef: item.price?.id ?? item.plan?.id,
      interval: interval === "year" ? "year" : interval === "month" ? "month" : undefined,
      currentPeriodEnd: status === "canceled" && cancelAt ? Math.min(cancelAt, periodEnd ?? cancelAt) : periodEnd,
      cancelAtPeriodEnd: !!obj.cancel_at_period_end || !!cancelAt,
      occurredAt,
    };
  },
};
