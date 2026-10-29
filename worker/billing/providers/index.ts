import type { BillingProviderId } from "../../../shared/types";
import type { BillingProvider } from "../types";
import { lemonsqueezy } from "./lemonsqueezy";
import { polar } from "./polar";
import { stripe } from "./stripe";

/** Payment providers, in the order Admin → Billing shows them (Polar first: recommended). */
export const BILLING_PROVIDERS: BillingProvider[] = [polar, stripe, lemonsqueezy];

export const getBillingProvider = (id: string | null | undefined): BillingProvider | null => BILLING_PROVIDERS.find((p) => p.id === id) ?? null;

export const isBillingProviderId = (id: unknown): id is BillingProviderId => typeof id === "string" && !!getBillingProvider(id);
