import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { formatPrice } from "../../lib/billing";
import { cn } from "../../lib/format";
import type { BillingInterval, PublicPlanDTO } from "../../lib/types";
import { Badge, Tabs } from "../ui/Misc";

/** Month / year switch, shown only when some plan has a yearly price. */
export function IntervalSwitch({ plans, value, onChange }: { plans: PublicPlanDTO[]; value: BillingInterval; onChange: (v: BillingInterval) => void }) {
  if (!plans.some((p) => p.priceYear !== null)) return null;
  const saving = bestYearlySaving(plans);
  return (
    <Tabs
      tabs={[
        { value: "month" as const, label: "Monthly" },
        { value: "year" as const, label: saving ? <>Yearly <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">−{saving}%</span></> : "Yearly" },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** Largest discount of a yearly price over 12 monthly ones, in whole percent (0 when none). */
function bestYearlySaving(plans: PublicPlanDTO[]): number {
  let best = 0;
  for (const p of plans) if (p.priceMonth && p.priceYear !== null) best = Math.max(best, Math.round((1 - p.priceYear / (p.priceMonth * 12)) * 100));
  return best;
}

/** Price block of a plan for an interval: "$19 /month", "$190 /year · $15.83/month", "Free". */
export function PlanPrice({ plan, interval, size = "lg" }: { plan: PublicPlanDTO; interval: BillingInterval; size?: "sm" | "lg" }) {
  const cents = interval === "year" ? (plan.priceYear ?? plan.priceMonth) : (plan.priceMonth ?? plan.priceYear);
  const shown: BillingInterval = interval === "year" ? (plan.priceYear !== null ? "year" : "month") : plan.priceMonth !== null ? "month" : "year";
  const big = size === "lg" ? "text-3xl" : "text-sm";
  if (plan.isFree || cents === null || cents === 0) return <p className={cn(big, "font-semibold tracking-tight")}>Free</p>;
  return (
    <div>
      <p className="flex items-baseline gap-1">
        <span className={cn(big, "font-semibold tracking-tight")}>{formatPrice(cents, plan.currency)}</span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">/{shown}</span>
      </p>
      {shown === "year" && size === "lg" && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{formatPrice(Math.round(cents / 12), plan.currency)} a month, billed yearly</p>}
    </div>
  );
}

/** Pricing cards (Workspace settings → Billing, sign-up page). `action` renders each card's button area. */
export function PricingCards({
  plans,
  interval,
  currentPlanId,
  action,
  compact,
}: {
  plans: PublicPlanDTO[];
  interval: BillingInterval;
  currentPlanId?: string | null;
  action?: (plan: PublicPlanDTO) => ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("grid gap-4", compact ? "grid-cols-1" : plans.length >= 3 ? "md:grid-cols-2 xl:grid-cols-3" : "md:grid-cols-2")}>
      {plans.map((p) => {
        const current = p.id === currentPlanId;
        return (
          <div
            key={p.id}
            className={cn(
              "relative flex flex-col rounded-xl bg-white p-5 ring-1 dark:bg-zinc-900",
              p.highlight ? "ring-2 ring-brand-500 dark:ring-brand-500" : "ring-zinc-200 dark:ring-zinc-800",
              compact && "p-4",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{p.name}</h3>
              {p.highlight && <Badge tone="brand">Most popular</Badge>}
              {current && <Badge tone="green">Current plan</Badge>}
              {compact && (
                <span className="ml-auto">
                  <PlanPrice plan={p} interval={interval} size="sm" />
                </span>
              )}
            </div>
            {p.description && !compact && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{p.description}</p>}
            {!compact && (
              <div className="mt-4">
                <PlanPrice plan={p} interval={interval} />
              </div>
            )}
            {p.features.length > 0 && (
              <ul className={cn("space-y-1.5 text-sm text-zinc-600 dark:text-zinc-300", compact ? "mt-2" : "mt-4 flex-1")}>
                {(compact ? p.features.slice(0, 3) : p.features).map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-brand-500" aria-hidden />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            )}
            {action && <div className="mt-5">{action(p)}</div>}
          </div>
        );
      })}
    </div>
  );
}
