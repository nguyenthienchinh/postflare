/**
 * Polar (polar.sh): merchant of record, so VAT / sales tax and invoices are Polar's job. Organization access token +
 * webhook secret. API: https://polar.sh/docs/api-reference (checked 2026-10).
 * - Checkout: POST /v1/checkouts/ { products: [product id], success_url, return_url, customer_email, metadata } → `url`.
 *   `metadata` is copied to the subscription, which is how webhooks find the workspace.
 * - Portal: POST /v1/customer-sessions/ { customer_id, return_url } → `customer_portal_url`.
 * - Webhooks: Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature "v1,<base64>"), HMAC-SHA256
 *   of "<id>.<timestamp>.<body>". Secrets created since 2026-09-08 are Standard Webhooks secrets (key = base64 after
 *   "whsec_"); older ones use the UTF-8 bytes of the whole "whsec_..." string as key. Both keys are tried.
 */
import type { BillingStatus } from "../../../shared/types";
import { fromBase64, hmacKey, hmacVerify, providerJson, toMs, WEBHOOK_TOLERANCE_MS } from "../http";
import { WebhookSignatureError, type BillingEvent, type BillingProvider, type ProviderConfig } from "../types";

const api = (cfg: ProviderConfig) => (cfg.sandbox ? "https://sandbox-api.polar.sh" : "https://api.polar.sh");
const headers = (cfg: ProviderConfig) => ({ authorization: `Bearer ${cfg.values.accessToken}`, "content-type": "application/json", accept: "application/json" });

/** Candidate HMAC keys of a webhook secret: Standard Webhooks (base64 after whsec_) and Polar's older scheme (whole string). */
export async function polarKeys(secret: string): Promise<CryptoKey[]> {
  const keys: CryptoKey[] = [];
  const b64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const decoded = fromBase64(b64);
  if (decoded.length) keys.push(await hmacKey(decoded));
  keys.push(await hmacKey(secret));
  return keys;
}

/** Verifies Standard Webhooks headers. Throws WebhookSignatureError. */
export async function verifyStandardWebhook(secret: string, h: Headers, raw: string, now: number): Promise<{ id: string; timestamp: number }> {
  const id = h.get("webhook-id") ?? "";
  const ts = h.get("webhook-timestamp") ?? "";
  const sigs = (h.get("webhook-signature") ?? "").split(" ").filter(Boolean);
  if (!id || !/^\d+$/.test(ts) || !sigs.length) throw new WebhookSignatureError("Missing webhook-id, webhook-timestamp or webhook-signature");
  const at = Number(ts) * 1000;
  if (Math.abs(now - at) > WEBHOOK_TOLERANCE_MS) throw new WebhookSignatureError("Webhook timestamp outside the 5 minute tolerance");
  const message = `${id}.${ts}.${raw}`;
  for (const key of await polarKeys(secret)) {
    for (const s of sigs) {
      const [version, value] = s.split(",", 2);
      if (version === "v1" && value && (await hmacVerify(key, fromBase64(value), message))) return { id, timestamp: at };
    }
  }
  throw new WebhookSignatureError("Invalid webhook signature");
}

/** Polar subscription → our status (undefined = not a state we act on, e.g. incomplete checkouts). */
export function polarStatus(sub: any, eventType: string, now: number): Exclude<BillingStatus, "none" | "trialing"> | undefined {
  if (eventType === "subscription.revoked") return "expired";
  switch (sub?.status) {
    case "active":
    case "trialing":
      return sub.cancel_at_period_end ? "canceled" : "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled": {
      const end = toMs(sub.ends_at) ?? toMs(sub.current_period_end);
      return !sub.ended_at && end && end > now ? "canceled" : "expired";
    }
    default:
      return undefined;
  }
}

export const polar: BillingProvider = {
  id: "polar",
  name: "Polar",
  recommended: true,
  description: "Merchant of record: handles VAT/sales tax and invoices, no Stripe account needed.",
  hasSandbox: true,
  dashboardUrl: "https://polar.sh/dashboard",
  fields: [
    { key: "accessToken", label: "Organization access token", secret: true, help: "Settings → Developers → New token (scopes: checkouts:write, customer_sessions:write, organizations:read)." },
    { key: "webhookSecret", label: "Webhook secret", secret: true, help: "Settings → Webhooks → Add endpoint (format: Raw), then copy its secret (whsec_...)." },
  ],
  events: ["subscription.created", "subscription.updated", "subscription.active", "subscription.canceled", "subscription.uncanceled", "subscription.revoked", "subscription.past_due"],

  async verify(cfg) {
    try {
      const res = await providerJson("Polar", `${api(cfg)}/v1/organizations/?limit=1`, { headers: headers(cfg) });
      const org = res?.items?.[0];
      return { ok: true, account: org ? `${org.name} (${org.slug})${cfg.sandbox ? " · sandbox" : ""}` : undefined };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async createCheckout(cfg, input) {
    const body = {
      products: [input.productRef],
      success_url: input.successUrl,
      return_url: input.cancelUrl,
      ...(input.customerId ? { customer_id: input.customerId } : { customer_email: input.email }),
      metadata: { workspace_id: input.workspaceId, plan_id: input.planId, interval: input.interval },
    };
    const res = await providerJson("Polar", `${api(cfg)}/v1/checkouts/`, { method: "POST", headers: headers(cfg), body: JSON.stringify(body) });
    if (typeof res?.url !== "string") throw new Error("Polar did not return a checkout URL");
    return { url: res.url };
  },

  async portalUrl(cfg, input) {
    if (!input.customerId) throw new Error("This workspace has no Polar customer yet");
    const res = await providerJson("Polar", `${api(cfg)}/v1/customer-sessions/`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({ customer_id: input.customerId, return_url: input.returnUrl }),
    });
    if (typeof res?.customer_portal_url !== "string") throw new Error("Polar did not return a customer portal URL");
    return res.customer_portal_url;
  },

  async parseWebhook(cfg, h, raw, now) {
    const { id, timestamp } = await verifyStandardWebhook(cfg.values.webhookSecret ?? "", h, raw, now);
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new WebhookSignatureError("Body is not JSON");
    }
    const type = String(payload?.type ?? "");
    if (!type.startsWith("subscription.")) return null;
    const sub = payload.data ?? {};
    const status = polarStatus(sub, type, now);
    if (!status) return null;
    const meta = sub.metadata ?? {};
    const external = typeof sub.customer?.external_id === "string" && sub.customer.external_id.startsWith("ws_") ? sub.customer.external_id : null;
    const interval = sub.recurring_interval === "year" ? "year" : sub.recurring_interval === "month" ? "month" : undefined;
    const event: BillingEvent = {
      id,
      type: status === "expired" ? "subscription.deleted" : "subscription.updated",
      workspaceId: typeof meta.workspace_id === "string" ? meta.workspace_id : external,
      customerId: sub.customer_id ?? sub.customer?.id,
      subscriptionId: sub.id,
      status,
      productRef: sub.product_id ?? sub.product?.id,
      interval,
      currentPeriodEnd: status === "canceled" ? (toMs(sub.ends_at) ?? toMs(sub.current_period_end)) : toMs(sub.current_period_end),
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      occurredAt: toMs(sub.modified_at) ?? toMs(payload.timestamp) ?? timestamp,
    };
    return event;
  },
};
