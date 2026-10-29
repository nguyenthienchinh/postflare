import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { BadgeCheck, CheckCircle2, CreditCard, ExternalLink, Gauge, Info, Layers, Loader2 } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app";
import {
  BILLING_STATUS_META,
  LIMIT_ROWS,
  PROVIDER_NAME,
  daysUntil,
  formatMb,
  inDays,
  useBilling,
} from "../../lib/billing";
import { cn } from "../../lib/format";
import { formatDate } from "../../lib/time";
import type { BillingDTO, BillingInterval, PlanLimitKey, PublicPlanDTO } from "../../lib/types";
import { Button } from "../ui/Button";
import { Badge, Skeleton } from "../ui/Misc";
import { Notice, Section } from "../ui/Section";
import { useToast } from "../ui/Toast";
import { IntervalSwitch, PricingCards } from "./PricingCards";

/** How often and how many times GET /api/billing is polled after a checkout (the webhook may arrive after the redirect). */
const POLL_MS = 2500;
const POLL_TRIES = 8;

/**
 * Workspace settings → Billing (hosted mode): current plan and status, usage against the limits, pricing cards → checkout,
 * "Manage billing" → the provider's portal. Read-only for members without billing.manage.
 */
export function BillingTab() {
  const billing = useBilling();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [checkout, setCheckout] = useState<"success" | "pending" | "canceled" | "updated" | null>(null);
  const handled = useRef(false);
  const alive = useRef(true);
  const { refetch, setData } = billing;

  // Fresh numbers every time the tab opens (the shared state is loaded once per workspace).
  useEffect(() => {
    alive.current = true;
    void refetch();
    return () => {
      alive.current = false;
    };
  }, [refetch]);

  // Return from the provider's checkout: ?checkout=success|canceled. On success poll until the webhook changed the plan.
  useEffect(() => {
    if (handled.current) return;
    const ret = params.get("checkout");
    if (ret !== "success" && ret !== "canceled") return;
    handled.current = true;
    const next = new URLSearchParams(params);
    next.delete("checkout");
    setParams(next, { replace: true });
    setCheckout(ret);
    if (ret === "canceled") return;
    // Not cancelled by re-renders (removing ?checkout changes `params`), only by leaving the tab (`alive`).
    let tries = 0;
    const tick = async () => {
      if (!alive.current) return;
      try {
        const b = await api.billing.get();
        setData(() => b);
        // The webhook has arrived once the workspace has a running provider subscription.
        if (b.hasSubscription) {
          setCheckout("updated");
          toast.success(b.plan ? `You're on ${b.plan.name} now` : "Your plan is active");
          return;
        }
      } catch {
        /* keep polling */
      }
      if (++tries < POLL_TRIES) setTimeout(() => void tick(), POLL_MS);
      else setCheckout("pending");
    };
    void tick();
  }, [params, setParams, setData, toast]);

  const b = billing.data;
  if (!b) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {checkout === "success" && (
        <Notice className="flex items-center gap-2">
          <Loader2 className="size-4 shrink-0 animate-spin text-brand-500" />
          Payment received, your plan updates in a moment.
        </Notice>
      )}
      {checkout === "updated" && (
        <Notice className="flex items-center gap-2">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          Payment received: {b.plan ? `${b.plan.name} is active.` : "your plan is active."}
        </Notice>
      )}
      {checkout === "pending" && <Notice tone="amber">Your payment is still being processed. The plan changes as soon as the payment provider confirms it: reload this page in a minute.</Notice>}
      {checkout === "canceled" && <Notice>Checkout canceled: nothing was charged.</Notice>}
      <PlanSection b={b} />
      <UsageSection b={b} />
      {!b.exempt && b.plans.length > 0 && <PlansSection b={b} />}
    </div>
  );
}

function usePortal() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const { url } = await api.billing.portal();
      window.location.assign(url);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };
  return { open, busy };
}

function PlanSection({ b }: { b: BillingDTO }) {
  const { tz } = useApp();
  const portal = usePortal();
  const status = BILLING_STATUS_META[b.status];
  const now = Date.now();
  const title = b.exempt ? "No limits" : b.state === "locked" ? "No active plan" : (b.plan?.name ?? "No plan");

  const lines: React.ReactNode[] = [];
  if (b.exempt) lines.push("This workspace is not billed: an instance admin comped it, so no limits apply.");
  else {
    if (b.state === "trial" && b.trialEndsAt) {
      const d = daysUntil(b.trialEndsAt, now);
      lines.push(
        <>
          Free trial, ends <strong className="font-medium text-zinc-800 dark:text-zinc-200">{inDays(d)}</strong> ({formatDate(b.trialEndsAt, tz)}). No card needed until you choose a plan.
        </>,
      );
    }
    if (b.state === "free" && b.status === "trialing") lines.push("Your trial has ended: the free plan applies.");
    if (b.state === "free" && b.status !== "trialing") lines.push("The free plan: upgrade for higher limits.");
    if (b.state === "locked") lines.push("Everything stays readable, exportable and deletable, but nothing new can be created, scheduled or published until you choose a plan.");
    if (b.status === "past_due")
      lines.push(
        <span className="text-amber-700 dark:text-amber-300">
          The last payment failed.{" "}
          {b.graceEndsAt ? `The plan stays active until ${formatDate(b.graceEndsAt, tz)}: update the payment method before then.` : "Update the payment method to keep the plan."}
        </span>,
      );
    if (b.status === "canceled" && b.currentPeriodEnd) lines.push(`Canceled: the plan stays active until ${formatDate(b.currentPeriodEnd, tz)}.`);
    if (b.status === "active" && b.provider === "manual") lines.push("Assigned by an instance admin.");
    if (b.hasSubscription && b.provider && b.provider !== "manual")
      lines.push(
        `Billed ${b.interval === "year" ? "yearly" : "monthly"} through ${PROVIDER_NAME[b.provider] ?? b.provider}${b.status === "active" && b.currentPeriodEnd ? `, renews ${formatDate(b.currentPeriodEnd, tz)}` : ""}.`,
      );
  }

  return (
    <Section icon={<CreditCard />} title="Plan" description="The plan of this workspace. Every member shares its limits.">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold tracking-tight">{title}</span>
            {b.exempt ? (
              <Badge tone="green">
                <BadgeCheck className="size-3" /> Comped
              </Badge>
            ) : b.state === "locked" ? (
              <Badge tone="red">Locked</Badge>
            ) : (
              b.status !== "none" && (
                <Badge tone={b.state === "free" && b.status === "trialing" ? "zinc" : status.tone}>
                  {b.state === "free" && b.status === "trialing" ? "Trial ended" : status.label}
                </Badge>
              )
            )}
          </p>
          <div className="mt-1 space-y-1 text-sm text-zinc-500 dark:text-zinc-400">
            {lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        </div>
        {b.canManage && b.hasSubscription && (
          <Button icon={<ExternalLink className="size-4" />} loading={portal.busy} onClick={() => void portal.open()}>
            Manage billing
          </Button>
        )}
      </div>
      {!b.canManage && !b.exempt && (
        <p className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
          <Info className="size-4 shrink-0" /> Only the workspace owner can change the plan. Ask them to upgrade if you need more.
        </p>
      )}
    </Section>
  );
}

const meterTone = (pct: number) => (pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-brand-500");

function UsageSection({ b }: { b: BillingDTO }) {
  const u = b.usage;
  if (!u) return null;
  const unlimited = b.exempt || b.state === "unlimited";
  return (
    <Section icon={<Gauge />} title="Usage" description="What this workspace uses against its plan. Monthly posts count the current UTC month.">
      <ul className="grid max-w-3xl gap-x-8 gap-y-5 sm:grid-cols-2">
        {LIMIT_ROWS.map((row) => {
          const max = unlimited || b.state === "locked" ? null : b.limits?.[row.key];
          const used = row.used(u);
          return <UsageMeter key={row.key} label={row.label} k={row.key} used={used} max={max} unit={row.unit} locked={b.state === "locked"} unlimited={unlimited} />;
        })}
      </ul>
    </Section>
  );
}

function UsageMeter({
  label,
  k,
  used,
  max,
  unit,
  locked,
  unlimited,
}: {
  label: string;
  k: PlanLimitKey;
  used: number;
  max: number | boolean | null | undefined;
  unit?: "MB";
  locked: boolean;
  unlimited: boolean;
}) {
  const fmt = (n: number) => (unit === "MB" ? formatMb(n) : n.toLocaleString("en-US"));
  if (k === "api") {
    const allowed = !locked && max !== false;
    return (
      <li>
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium text-zinc-800 dark:text-zinc-100">{label}</span>
          <span className={allowed ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500"}>{allowed ? "Included" : "Not included"}</span>
        </div>
      </li>
    );
  }
  const limited = typeof max === "number";
  const pct = limited ? (max === 0 ? 100 : Math.min(100, (used / max) * 100)) : 0;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium text-zinc-800 dark:text-zinc-100">{label}</span>
        <span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-300">
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">{fmt(used)}</span>
          <span className="text-zinc-400"> / {limited ? fmt(max) : locked ? "locked" : unlimited ? "no limit" : "unlimited"}</span>
        </span>
      </div>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limited ? max : undefined}
        aria-valuenow={used}
        aria-valuetext={limited ? `${fmt(used)} of ${fmt(max)}` : `${fmt(used)}, unlimited`}
      >
        {locked ? null : limited ? (
          <div className={cn("h-full rounded-full", meterTone(pct))} style={{ width: `${Math.max(used > 0 ? 2 : 0, pct)}%` }} />
        ) : (
          <div className="h-full w-full rounded-full bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgba(113,113,122,0.15)_6px_12px)]" />
        )}
      </div>
    </li>
  );
}

function PlansSection({ b }: { b: BillingDTO }) {
  const toast = useToast();
  const portal = usePortal();
  const [interval, setPeriod] = useState<BillingInterval>(b.interval ?? "month");
  const [busy, setBusy] = useState<string | null>(null);
  const current = b.state === "plan" || b.state === "trial" || b.state === "free" ? (b.plan?.id ?? null) : null;

  async function buy(p: PublicPlanDTO) {
    setBusy(p.id);
    try {
      const { url } = await api.billing.checkout(p.id, p.checkoutIntervals.includes(interval) ? interval : p.checkoutIntervals[0]);
      window.location.assign(url);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  const action = (p: PublicPlanDTO) => {
    if (!b.canManage) return null;
    const isCurrent = p.id === current && b.state !== "trial";
    if (isCurrent) return <Button className="w-full" disabled>Current plan</Button>;
    if (p.isFree) return <p className="text-center text-xs text-zinc-500">{b.state === "free" ? "Your current plan" : "Applies without a subscription"}</p>;
    if (b.hasSubscription) {
      return (
        <Button className="w-full" icon={<ExternalLink className="size-4" />} loading={portal.busy} onClick={() => void portal.open()}>
          Change in billing portal
        </Button>
      );
    }
    if (!p.checkoutIntervals.length) return <Button className="w-full" disabled>Not available yet</Button>;
    const other = !p.checkoutIntervals.includes(interval);
    return (
      <Button variant={p.highlight ? "primary" : "secondary"} className="w-full" loading={busy === p.id} disabled={busy !== null && busy !== p.id} onClick={() => void buy(p)}>
        {b.state === "trial" && p.id === current ? `Keep ${p.name}` : `Choose ${p.name}`}
        {other ? ` (${p.checkoutIntervals[0] === "year" ? "yearly" : "monthly"})` : ""}
      </Button>
    );
  };

  return (
    <Section
      icon={<Layers />}
      title="Plans"
      description={
        b.hasSubscription
          ? "Change or cancel your subscription in the billing portal of the payment provider."
          : b.canManage
            ? "Pay securely with the payment provider; the plan changes as soon as the payment goes through."
            : "The plans this workspace can be on."
      }
    >
      <div className="space-y-4">
        <IntervalSwitch plans={b.plans} value={interval} onChange={setPeriod} />
        <PricingCards plans={b.plans} interval={interval} currentPlanId={current} action={action} />
      </div>
    </Section>
  );
}
