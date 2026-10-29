import { useState } from "react";
import { Link, useLocation } from "react-router";
import { AlertTriangle, ArrowRight, Clock, CreditCard, Lock, X } from "lucide-react";
import { useApp } from "../../lib/app";
import { BILLING_TAB, daysUntil, inDays, useBillingOn } from "../../lib/billing";
import { cn } from "../../lib/format";
import { useSession } from "../../lib/session";
import { formatDate } from "../../lib/time";
import type { BillingDTO } from "../../lib/types";

type Kind = "trial" | "trial-over" | "locked" | "past-due";

/** Which banner a workspace needs (null: none). Trials only warn in their last 3 days. */
function bannerKind(b: BillingDTO, now: number): Kind | null {
  if (b.exempt || b.state === "unlimited") return null;
  if (b.state === "locked") return "locked";
  if (b.status === "past_due") return "past-due";
  if (b.state === "trial" && b.trialEndsAt && b.trialEndsAt - now <= 3 * 86_400_000) return "trial";
  // Trial over, now on the free plan.
  if (b.state === "free" && b.status === "trialing" && b.trialEndsAt && b.trialEndsAt <= now) return "trial-over";
  return null;
}

const dismissKey = (ws: string, kind: Kind) => `postflare:billing-banner:${ws}:${kind}`;

function isDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * Hosted mode: trial ending soon, trial over, locked (no active plan) or past due, above every page and linking to
 * Workspace settings → Billing. Dismissible per browser session; nothing while billing is off or the workspace is exempt.
 */
export function BillingBanner() {
  const b = useBillingOn();
  const { workspace, can } = useSession();
  const { tz } = useApp();
  const location = useLocation();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const now = Date.now();
  if (!b || !workspace) return null;
  const kind = bannerKind(b, now);
  if (!kind) return null;
  const key = dismissKey(workspace.id, kind);
  if (dismissed.includes(key) || isDismissed(key)) return null;
  // Already on the Billing tab: it says the same, in more detail.
  if (location.pathname === "/workspace" && new URLSearchParams(location.search).get("tab") === "billing") return null;

  const manage = can("billing.manage");
  const planName = b.plan?.name ?? "the plan";
  const tone = kind === "locked" ? "red" : kind === "trial-over" ? "zinc" : "amber";
  const Icon = kind === "locked" ? Lock : kind === "past-due" ? CreditCard : kind === "trial" ? Clock : AlertTriangle;
  const text =
    kind === "trial" ? (
      <>
        <strong className="font-semibold">Your trial ends {inDays(daysUntil(b.trialEndsAt!, now))}.</strong>{" "}
        {manage ? `Choose a plan to keep ${planName}'s limits.` : "Ask the workspace owner to choose a plan."}
      </>
    ) : kind === "trial-over" ? (
      <>
        <strong className="font-semibold">Your trial has ended.</strong> This workspace is on the {planName} plan now.
        {manage ? " Upgrade any time." : " Ask the workspace owner to upgrade."}
      </>
    ) : kind === "locked" ? (
      <>
        <strong className="font-semibold">This workspace has no active plan.</strong> Everything stays readable, but nothing new can be created, scheduled or published.
        {manage ? " Choose a plan to continue." : " Ask the workspace owner to choose a plan."}
      </>
    ) : (
      <>
        <strong className="font-semibold">Your last payment failed.</strong>{" "}
        {b.graceEndsAt ? `${manage ? "Update your payment method" : "The workspace owner needs to update the payment method"} before ${formatDate(b.graceEndsAt, tz)} to keep ${planName}.` : `${manage ? "Update your payment method" : "Ask the workspace owner to update the payment method"} to keep ${planName}.`}
      </>
    );
  const tones = {
    red: "bg-red-50 text-red-900 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900",
    amber: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
    zinc: "bg-white text-zinc-700 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800",
  };
  const iconTone = { red: "text-red-500", amber: "text-amber-500", zinc: "text-brand-500" };

  return (
    <div role="status" className={cn("mb-6 flex items-center gap-3 rounded-xl px-4 py-3 text-sm ring-1", tones[tone])}>
      <Icon className={cn("size-5 shrink-0", iconTone[tone])} />
      <p className="min-w-0 flex-1">{text}</p>
      <Link to={BILLING_TAB} className="hidden shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold hover:bg-black/5 sm:inline-flex dark:hover:bg-white/10">
        {manage ? (kind === "past-due" ? "Billing" : "Choose a plan") : "View plan"} <ArrowRight className="size-4" />
      </Link>
      <button
        onClick={() => {
          try {
            sessionStorage.setItem(key, "1");
          } catch {
            /* storage disabled: hidden until the next reload */
          }
          setDismissed((d) => [...d, key]);
        }}
        className="-mr-1 shrink-0 rounded p-1 opacity-60 transition hover:opacity-100"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
