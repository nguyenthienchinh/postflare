/**
 * Lemon Squeezy: merchant of record. API key + store id + webhook signing secret. API: https://docs.lemonsqueezy.com/api
 * (checked 2026-10).
 * - Checkout: POST /v1/checkouts (JSON:API, application/vnd.api+json) with checkout_data.email, checkout_data.custom
 *   (echoed as `meta.custom_data` in webhooks), product_options.redirect_url and the store / variant relationships →
 *   `data.attributes.url`. There is no cancel URL.
 * - Portal: `urls.customer_portal` of the subscription (GET /v1/subscriptions/:id): a pre-signed link valid 24 hours,
 *   so it is fetched fresh every time.
 * - Webhooks: `X-Signature` = hex HMAC-SHA256 of the raw body (no timestamp, no event id: the SHA-256 of the body is the
 *   dedupe key, the subscription's `updated_at` orders events). `subscription_payment_*` events carry an invoice, not a
 *   subscription: they are ignored, the `subscription_updated` that follows has the new status.
 */
import type { BillingStatus } from "../../../shared/types";
import { sha256Hex } from "../../lib/util";
import { fromHex, hmacKey, hmacVerify, providerJson, toMs } from "../http";
import { WebhookSignatureError, type BillingProvider, type ProviderConfig } from "../types";

const API = "https://api.lemonsqueezy.com";
const headers = (cfg: ProviderConfig) => ({
  authorization: `Bearer ${cfg.values.apiKey}`,
  accept: "application/vnd.api+json",
  "content-type": "application/vnd.api+json",
});

const SUBSCRIPTION_EVENTS = [
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
];

export function lemonStatus(attrs: any): Exclude<BillingStatus, "none" | "trialing"> | undefined {
  switch (attrs?.status) {
    case "active":
    case "on_trial":
      return attrs.cancelled ? "canceled" : "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "cancelled":
      return "canceled";
    case "expired":
    case "paused":
      return "expired";
    default:
      return undefined;
  }
}

export const lemonsqueezy: BillingProvider = {
  id: "lemonsqueezy",
  name: "Lemon Squeezy",
  recommended: false,
  description: "Merchant of record (owned by Stripe): handles VAT/sales tax.",
  hasSandbox: false,
  dashboardUrl: "https://app.lemonsqueezy.com",
  fields: [
    { key: "apiKey", label: "API key", secret: true, help: "Settings → API → New API key (test mode keys work with test mode stores)." },
    { key: "storeId", label: "Store id", secret: false, help: "Settings → Stores: the number after # (e.g. 12345)." },
    { key: "webhookSecret", label: "Webhook signing secret", secret: true, help: "Settings → Webhooks → +: the signing secret you typed there (6-40 characters)." },
  ],
  events: SUBSCRIPTION_EVENTS,

  async verify(cfg) {
    try {
      const res = await providerJson("Lemon Squeezy", `${API}/v1/stores/${encodeURIComponent(cfg.values.storeId ?? "")}`, { headers: headers(cfg) });
      const a = res?.data?.attributes;
      return { ok: true, account: a?.name ? `${a.name}${a.domain ? ` (${a.domain})` : ""}` : undefined };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async createCheckout(cfg, input) {
    const body = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: { email: input.email, custom: { workspace_id: input.workspaceId, plan_id: input.planId, interval: input.interval } },
          product_options: { redirect_url: input.successUrl },
        },
        relationships: {
          store: { data: { type: "stores", id: String(cfg.values.storeId) } },
          variant: { data: { type: "variants", id: String(input.productRef) } },
        },
      },
    };
    const res = await providerJson("Lemon Squeezy", `${API}/v1/checkouts`, { method: "POST", headers: headers(cfg), body: JSON.stringify(body) });
    const url = res?.data?.attributes?.url;
    if (typeof url !== "string") throw new Error("Lemon Squeezy did not return a checkout URL");
    return { url };
  },

  async portalUrl(cfg, input) {
    if (!input.subscriptionId) throw new Error("This workspace has no Lemon Squeezy subscription yet");
    const res = await providerJson("Lemon Squeezy", `${API}/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, { headers: headers(cfg) });
    const url = res?.data?.attributes?.urls?.customer_portal;
    if (typeof url !== "string") throw new Error("Lemon Squeezy did not return a customer portal URL");
    return url;
  },

  async parseWebhook(cfg, h, raw) {
    const key = await hmacKey(cfg.values.webhookSecret ?? "");
    if (!(await hmacVerify(key, fromHex(h.get("x-signature") ?? ""), raw))) throw new WebhookSignatureError("Invalid webhook signature");
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new WebhookSignatureError("Body is not JSON");
    }
    const name = String(payload?.meta?.event_name ?? h.get("x-event-name") ?? "");
    if (!SUBSCRIPTION_EVENTS.includes(name) || payload?.data?.type !== "subscriptions") return null;
    const attrs = payload.data.attributes ?? {};
    const status = name === "subscription_expired" ? "expired" : lemonStatus(attrs);
    if (!status) return null;
    const custom = payload.meta?.custom_data ?? {};
    return {
      id: await sha256Hex(raw),
      type: status === "expired" ? "subscription.deleted" : "subscription.updated",
      workspaceId: typeof custom.workspace_id === "string" ? custom.workspace_id : null,
      customerId: attrs.customer_id !== undefined && attrs.customer_id !== null ? String(attrs.customer_id) : undefined,
      subscriptionId: String(payload.data.id),
      status,
      productRef: attrs.variant_id !== undefined && attrs.variant_id !== null ? String(attrs.variant_id) : undefined,
      currentPeriodEnd: status === "canceled" ? (toMs(attrs.ends_at) ?? toMs(attrs.renews_at)) : toMs(attrs.renews_at),
      cancelAtPeriodEnd: !!attrs.cancelled,
      occurredAt: toMs(attrs.updated_at),
    };
  },
};
