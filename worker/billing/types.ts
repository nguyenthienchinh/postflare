import type { BillingInterval, BillingProviderId, BillingStatus } from "../../shared/types";

/** Stored credentials of a provider (settings `billing_provider:<id>`, encrypted with encryptJson). */
export interface ProviderConfig {
  values: Record<string, string>;
  /** Polar sandbox API. */
  sandbox?: boolean;
}

export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  /** Optional fields may stay empty. */
  optional?: boolean;
  help?: string;
}

export interface CheckoutRequest {
  workspaceId: string;
  planId: string;
  interval: BillingInterval;
  /** Product (Polar), price (Stripe) or variant (Lemon Squeezy) id from the plan's provider_prices. */
  productRef: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
  /** The workspace's customer id at this provider, when it already has one. */
  customerId?: string | null;
}

export interface PortalRequest {
  workspaceId: string;
  customerId: string | null;
  subscriptionId: string | null;
  returnUrl: string;
}

/** A provider webhook event mapped to what the workspace row needs. */
export interface BillingEvent {
  /** Unique per provider (dedupe key in billing_events). */
  id: string;
  type: "subscription.updated" | "subscription.deleted" | "checkout.completed";
  /** From the checkout metadata / custom data; null when the provider did not echo it (then matched by ids). */
  workspaceId: string | null;
  customerId?: string;
  subscriptionId?: string;
  /** Undefined: leave the status as it is (checkout.completed). */
  status?: Exclude<BillingStatus, "none" | "trialing">;
  productRef?: string;
  interval?: BillingInterval;
  /** ms epoch: end of the paid period (canceled: when access ends). */
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  /** ms epoch of the change at the provider: older events than the last applied one are ignored. */
  occurredAt?: number;
}

/** The webhook signature is missing, wrong or too old (answer 400). */
export class WebhookSignatureError extends Error {}

/** A provider API call failed (answer 502 with the message). */
export class ProviderApiError extends Error {}

export interface BillingProvider {
  id: BillingProviderId;
  name: string;
  recommended: boolean;
  description: string;
  /** Credential fields shown in Admin → Billing (secrets never returned to the UI). */
  fields: ProviderField[];
  /** Polar has a separate sandbox API; the others use test keys / test mode. */
  hasSandbox: boolean;
  /** Webhook events to subscribe to (shown next to the webhook URL). */
  events: string[];
  dashboardUrl: string;
  /** Checks the credentials with one cheap API call ("Test connection"). */
  verify(cfg: ProviderConfig): Promise<{ ok: true; account?: string } | { ok: false; error: string }>;
  createCheckout(cfg: ProviderConfig, input: CheckoutRequest): Promise<{ url: string }>;
  portalUrl(cfg: ProviderConfig, input: PortalRequest): Promise<string>;
  /** Verifies the signature on the raw body and maps the event (null = ignored event type), or throws WebhookSignatureError. */
  parseWebhook(cfg: ProviderConfig, headers: Headers, rawBody: string, now: number): Promise<BillingEvent | null>;
}
