// Admin → Billing (hosted mode, docs/hosted-spec.md "UI"): the switch, payment providers, trial and grace periods, plans
// and per-workspace overrides. Needs instance.settings.manage; the Workspaces section also instance.users.manage.

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  BadgeCheck,
  Building2,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Layers,
  Pencil,
  Plug,
  Plus,
  Power,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { providerDisplayName } from "@shared/providerNames";
import { PlatformAccessPicker, platformAccessLabel } from "../../components/accounts/PlatformAccessPicker";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog, Drawer } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select, Switch, Textarea } from "../../components/ui/Form";
import { Badge, Card, CardHeader, CopyButton, EmptyState, PageHeader, Skeleton } from "../../components/ui/Misc";
import { Notice, Section } from "../../components/ui/Section";
import { useToast } from "../../components/ui/Toast";
import { api, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app";
import { BILLING_STATE_META, BILLING_STATUS_META, PROVIDER_NAME, formatPrice, limitText } from "../../lib/billing";
import { cn } from "../../lib/format";
import { useSession } from "../../lib/session";
import { formatDate } from "../../lib/time";
import type {
  AdminBillingDTO,
  AdminBillingProviderDTO,
  AdminPlanDTO,
  AdminWorkspaceBillingDTO,
  BillingInterval,
  BillingProviderId,
  BillingStatus,
  PlanInput,
  PlanLimitInfo,
  PlanLimits,
  ProviderPrices,
} from "../../lib/types";
import { invalidate, useFetch } from "../../lib/useFetch";

export function BillingAdminPage() {
  const state = useFetch("admin-billing", api.admin.billing.get);
  const plans = useFetch("admin-billing-plans", api.admin.billing.plans);
  const { canInstance } = useSession();
  const s = state.data;
  // Every change can switch billing on or off: the current workspace's billing state (banner, tab) reloads too.
  const setState = (next: AdminBillingDTO) => {
    state.setData(() => next);
    invalidate("billing");
  };

  return (
    <>
      <PageHeader
        title="Billing"
        description="Sell plans to the workspaces of this instance (hosted mode). Off by default: while it is off, nothing is limited and nobody sees billing."
      />
      {state.error && !s ? (
        <Card>
          <EmptyState icon={<AlertTriangle />} title="Could not load billing" description={state.error.message} action={<Button onClick={() => state.refetch()}>Try again</Button>} />
        </Card>
      ) : !s ? (
        <div className="space-y-6">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : (
        <div className="space-y-6">
          <SwitchSection s={s} onChange={setState} />
          <ProvidersSection s={s} onChange={setState} />
          <PeriodsSection s={s} onChange={setState} />
          <PlansCard s={s} plans={plans.data} loading={plans.loading} refetch={() => Promise.all([plans.refetch(), state.refetch()]).then(() => invalidate("billing"))} />
          {canInstance("instance.users.manage") && <WorkspacesCard plans={plans.data ?? []} />}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The switch

function SwitchSection({ s, onChange }: { s: AdminBillingDTO; onChange: (s: AdminBillingDTO) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string[] | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setRefused(null);
    try {
      const res = await api.admin.billing.update({ enabled: next });
      onChange(res);
      toast.success(next ? (res.active ? "Billing is on: limits apply to new and non-exempt workspaces" : "Billing turned on") : "Billing turned off: no limits apply");
    } catch (err) {
      // 400 { error, problems }: shown below the switch rather than as a toast.
      setRefused(s.problems.length ? s.problems : [errorMessage(err)]);
    } finally {
      setBusy(false);
    }
  }

  const problems = refused ?? (s.enabled && !s.active ? s.problems : []);
  return (
    <Section icon={<Power />} title="Billing" description="When on, workspaces get a plan: a free trial when they are created, then a paid plan, the free plan or read-only.">
      <div className="max-w-2xl space-y-4 text-sm">
        <label className="flex items-start gap-3">
          <Switch id="billing-enabled" checked={s.enabled} disabled={busy} onChange={(v) => void toggle(v)} label="Sell plans" />
          <span>
            <span className="flex flex-wrap items-center gap-2 font-medium text-zinc-900 dark:text-zinc-100">
              Sell plans on this instance
              {s.active ? (
                <Badge tone="green" dot>
                  In effect
                </Badge>
              ) : s.enabled ? (
                <Badge tone="amber" dot>
                  Not in effect
                </Badge>
              ) : (
                <Badge dot>Off</Badge>
              )}
            </span>
            <span className="mt-0.5 block text-zinc-500">
              Workspaces that exist the first time billing goes on (yours) are comped and never limited. Turn it off any time: every limit is lifted at once.
            </span>
          </span>
        </label>
        {problems.length > 0 && (
          <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">{s.enabled ? "Billing is not in effect yet:" : "Billing can't be turned on yet:"}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {!s.enabled && !refused && s.problems.length > 0 && (
          <p className="text-zinc-500">
            Before turning it on: {s.problems.map((p) => p.replace(/\.$/, "").toLowerCase()).join("; ")}.
          </p>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Providers

function ProvidersSection({ s, onChange }: { s: AdminBillingDTO; onChange: (s: AdminBillingDTO) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function setActive(id: BillingProviderId) {
    setBusy(true);
    try {
      onChange(await api.admin.billing.update({ activeProvider: id }));
      toast.success(`${PROVIDER_NAME[id]} handles new sales`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      icon={<Plug />}
      title="Payment providers"
      description="Enter the credentials of one or more providers. New checkouts go through the one used for new sales; webhooks of every configured provider keep working, so earlier subscriptions continue."
    >
      <div className="space-y-4">
        {s.providers.map((p) => (
          <ProviderCard key={p.id} p={p} active={s.activeProvider === p.id} radioDisabled={busy} onActivate={() => void setActive(p.id)} onChange={onChange} />
        ))}
      </div>
    </Section>
  );
}

function ProviderCard({
  p,
  active,
  radioDisabled,
  onActivate,
  onChange,
}: {
  p: AdminBillingProviderDTO;
  active: boolean;
  radioDisabled: boolean;
  onActivate: () => void;
  onChange: (s: AdminBillingDTO) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const plainValues = () => Object.fromEntries(p.fields.map((f) => [f.key, f.secret ? "" : (f.value ?? "")]));
  const [values, setValues] = useState<Record<string, string>>(plainValues);
  const [sandbox, setSandbox] = useState(!!p.sandbox);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  // Re-sync after a save or removal (secrets are never returned: the inputs empty out).
  useEffect(() => {
    setValues(plainValues());
    setSandbox(!!p.sandbox);
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = p.fields.some((f) => (f.secret ? !!values[f.key]?.trim() : (values[f.key] ?? "") !== (f.value ?? ""))) || (p.sandbox !== null && sandbox !== !!p.sandbox);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    setTest(null);
    try {
      const res = await api.admin.billing.saveProvider(p.id, { values, ...(p.sandbox !== null ? { sandbox } : {}) });
      onChange(res);
      toast.success(`${p.name} saved`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy("test");
    setTest(null);
    try {
      const res = await api.admin.billing.testProvider(p.id);
      setTest(res.ok ? { ok: true, text: res.account ? `Connected to ${res.account}` : "Connection works" } : { ok: false, text: res.error });
    } catch (err) {
      setTest({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Remove the ${p.name} credentials?`,
      message: `Its webhooks stop being accepted: subscriptions bought through ${p.name} no longer update here.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy("remove");
    try {
      onChange(await api.admin.billing.removeProvider(p.id));
      setTest(null);
      toast.success(`${p.name} removed`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      onSubmit={save}
      className={cn("rounded-xl p-4 ring-1 sm:p-5", active ? "bg-brand-50/40 ring-brand-300 dark:bg-brand-950/20 dark:ring-brand-800" : "ring-zinc-200 dark:ring-zinc-800")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-semibold">{p.name}</span>
          {p.recommended && (
            <Badge tone="brand">
              <Sparkles className="size-3" /> Recommended
            </Badge>
          )}
          {p.configured ? (
            <Badge tone="green" dot>
              Configured
            </Badge>
          ) : (
            <Badge dot>Not configured</Badge>
          )}
        </p>
        <label className={cn("flex shrink-0 items-center gap-2 text-sm font-medium", !p.configured && !active && "opacity-60")}>
          <input
            type="radio"
            name="active-provider"
            className="size-4 accent-brand-600"
            checked={active}
            disabled={radioDisabled || (!p.configured && !active)}
            onChange={onActivate}
          />
          Use for new sales
        </label>
      </div>
      <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{p.description}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {p.fields.map((f) => (
          <Field
            key={f.key}
            label={
              <span className="flex items-center gap-2">
                {f.label}
                {f.secret && f.set && (
                  <Badge tone="green">
                    <CheckCircle2 className="size-3" /> Set
                  </Badge>
                )}
              </span>
            }
            help={f.help}
          >
            {(id) => (
              <Input
                id={id}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                className="font-mono placeholder:font-sans"
                value={values[f.key] ?? ""}
                placeholder={f.secret && f.set ? "Stored: leave empty to keep it" : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
          </Field>
        ))}
      </div>

      {p.sandbox !== null && (
        <label className="mt-4 flex items-start gap-3 text-sm">
          <Switch checked={sandbox} onChange={setSandbox} label="Sandbox" />
          <span>
            <span className="block font-medium text-zinc-900 dark:text-zinc-100">Sandbox</span>
            <span className="block text-zinc-500">Test payments against {p.name}&rsquo;s sandbox (separate account, tokens and products).</span>
          </span>
        </label>
      )}

      <div className="mt-4 space-y-3 rounded-lg bg-zinc-50 p-3 text-sm ring-1 ring-zinc-200 dark:bg-zinc-950/40 dark:ring-zinc-800">
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">Webhook URL</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-white px-2 py-1.5 font-mono text-xs ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">{p.webhookUrl}</code>
            <CopyButton text={p.webhookUrl} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">Events to subscribe to</p>
          <div className="flex flex-wrap gap-1.5">
            {p.events.map((e) => (
              <code key={e} className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800">
                {e}
              </code>
            ))}
          </div>
        </div>
        <a href={p.dashboardUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
          Open the {p.name} dashboard <ExternalLink className="size-3" />
        </a>
      </div>

      {test && (
        <p className={cn("mt-3 flex items-center gap-1.5 text-sm", test.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
          {test.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />}
          {test.text}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" loading={busy === "save"} disabled={!dirty || busy !== null}>
          Save
        </Button>
        <Button size="sm" variant="outline" loading={busy === "test"} disabled={!p.configured || busy !== null || dirty} onClick={() => void runTest()}>
          Test connection
        </Button>
        <span className="flex-1" />
        {p.configured && (
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} loading={busy === "remove"} disabled={busy !== null} onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Trial and grace

function PeriodsSection({ s, onChange }: { s: AdminBillingDTO; onChange: (s: AdminBillingDTO) => void }) {
  const toast = useToast();
  const [trial, setTrial] = useState(String(s.trialDays));
  const [grace, setGrace] = useState(String(s.pastDueGraceDays));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTrial(String(s.trialDays));
    setGrace(String(s.pastDueGraceDays));
  }, [s.trialDays, s.pastDueGraceDays]);
  const bad = (v: string, max: number) => !/^\d+$/.test(v.trim()) || Number(v) > max;
  const invalid = bad(trial, 365) || bad(grace, 90);
  const dirty = Number(trial) !== s.trialDays || Number(grace) !== s.pastDueGraceDays;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    try {
      onChange(await api.admin.billing.update({ trialDays: Number(trial), pastDueGraceDays: Number(grace) }));
      toast.success("Saved");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={<Clock />} title="Trial and grace period" description="New workspaces start a free trial of the trial plan, no card needed (one trial per user).">
      <form onSubmit={save} className="max-w-xl space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Trial (days)" error={bad(trial, 365) ? "0 to 365" : undefined} help="0 = no trial: new workspaces start on the free plan, or read-only without one.">
            {(id) => <Input id={id} type="number" min={0} max={365} value={trial} invalid={bad(trial, 365)} onChange={(e) => setTrial(e.target.value)} className="w-32" />}
          </Field>
          <Field label="Past-due grace (days)" error={bad(grace, 90) ? "0 to 90" : undefined} help="How long a workspace keeps its plan after a failed payment.">
            {(id) => <Input id={id} type="number" min={0} max={90} value={grace} invalid={bad(grace, 90)} onChange={(e) => setGrace(e.target.value)} className="w-32" />}
          </Field>
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={invalid || !dirty}>
          Save
        </Button>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Plans

const price = (cents: number | null, currency: string, per: string) => (cents === null ? null : `${formatPrice(cents, currency)}/${per}`);

function PlansCard({ s, plans, loading, refetch }: { s: AdminBillingDTO; plans: AdminPlanDTO[] | undefined; loading: boolean; refetch: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminPlanDTO | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function suggested() {
    setBusy("suggested");
    try {
      await api.admin.billing.suggestedPlans();
      await refetch();
      toast.success("Free, Creator and Team created", "Add the product ids from your payment provider to sell them.");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function remove(p: AdminPlanDTO) {
    const ok = await confirm({
      title: p.workspaces ? `Archive ${p.name}?` : `Delete ${p.name}?`,
      message: p.workspaces
        ? `${p.workspaces} ${p.workspaces === 1 ? "workspace is" : "workspaces are"} on this plan, so it is archived instead: they keep it, but nobody can buy it anymore.`
        : "Nobody is on this plan. It is deleted for good.",
      confirmLabel: p.workspaces ? "Archive" : "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(p.id);
    try {
      const res = await api.admin.billing.removePlan(p.id);
      await refetch();
      toast.success(res.archived ? `${p.name} archived` : `${p.name} deleted`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function restore(p: AdminPlanDTO) {
    setBusy(p.id);
    try {
      await api.admin.billing.updatePlan(p.id, { active: true });
      await refetch();
      toast.success(`${p.name} is for sale again`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  const configured = s.providers.filter((p) => p.configured);
  const missingRefs = (p: AdminPlanDTO) =>
    !p.isFree && p.active && s.activeProvider && (["month", "year"] as const).some((i) => (i === "month" ? p.priceMonth : p.priceYear) !== null && !p.providerPrices[s.activeProvider!]?.[i]);

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Layers className="size-4 text-zinc-400" /> Plans
            {plans && <span className="font-normal text-zinc-400">{plans.length}</span>}
          </span>
        }
        description="Limits and prices of each plan. Prices are what the pricing cards show; the provider charges the product you link."
        action={
          plans && plans.length > 0 && (
            <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              New plan
            </Button>
          )
        }
      />
      {!plans ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : plans.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="No plans yet"
          description="Start from the suggested Free, Creator ($19/month) and Team ($49/month) plans and adjust them, or create your own."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" icon={<Wand2 className="size-4" />} loading={busy === "suggested"} onClick={() => void suggested()}>
                Create suggested plans
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
                New plan
              </Button>
            </div>
          }
        />
      ) : (
        <div className={cn("overflow-x-auto", loading && "opacity-70")}>
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-zinc-100 text-xs text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="px-5 py-2.5 font-medium">Plan</th>
                <th className="px-3 py-2.5 font-medium">Price</th>
                <th className="px-3 py-2.5 font-medium">Limits</th>
                <th className="px-3 py-2.5 text-right font-medium">Workspaces</th>
                <th className="w-24 px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {plans.map((p) => (
                <tr key={p.id} className={cn(!p.active && "opacity-60")}>
                  <td className="px-5 py-3 align-top">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <button className="font-medium hover:underline" onClick={() => setEditing(p)}>
                        {p.name}
                      </button>
                      {p.isFree && <Badge>Free plan</Badge>}
                      {p.isTrialDefault && <Badge tone="blue">Trial</Badge>}
                      {p.highlight && <Badge tone="brand">Most popular</Badge>}
                      {!p.active && <Badge tone="amber">Archived</Badge>}
                    </p>
                    {p.description && <p className="mt-0.5 max-w-xs truncate text-xs text-zinc-500">{p.description}</p>}
                    {missingRefs(p) && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="size-3" /> No {PROVIDER_NAME[s.activeProvider!]} product id for every price: not for sale yet
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top tabular-nums">
                    {p.isFree || (p.priceMonth === null && p.priceYear === null) ? (
                      <span className="text-zinc-500">Free</span>
                    ) : (
                      <>
                        <p>{price(p.priceMonth, p.currency, "mo") ?? <span className="text-zinc-400">no monthly</span>}</p>
                        <p className="text-xs text-zinc-500">{price(p.priceYear, p.currency, "yr") ?? "no yearly"}</p>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top text-xs text-zinc-600 dark:text-zinc-300">
                    {s.limits.map((l) => limitSummary(p.limits, l)).join(" · ")}
                  </td>
                  <td className="px-3 py-3 text-right align-top tabular-nums">{p.workspaces}</td>
                  <td className="px-5 py-2.5 align-top">
                    <div className="flex justify-end gap-0.5">
                      <IconButton label={`Edit ${p.name}`} size="sm" onClick={() => setEditing(p)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      {p.active ? (
                        <IconButton label={p.workspaces ? `Archive ${p.name}` : `Delete ${p.name}`} size="sm" variant="danger" disabled={busy === p.id} onClick={() => void remove(p)}>
                          {p.workspaces ? <Archive className="size-4" /> : <Trash2 className="size-4" />}
                        </IconButton>
                      ) : (
                        <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => void restore(p)}>
                          Restore
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PlanEditor
        open={editing !== null}
        plan={editing === "new" ? null : editing}
        catalog={s.limits}
        providers={configured}
        nextPosition={(plans ?? []).reduce((n, p) => Math.max(n, p.position + 1), 0)}
        onClose={() => setEditing(null)}
        onSaved={() => void refetch()}
      />
    </Card>
  );
}

const SHORT: Record<string, [string, string]> = {
  accounts: ["account", "accounts"],
  posts_per_month: ["post/mo", "posts/mo"],
  x_posts_per_month: ["X post/mo", "X posts/mo"],
  members: ["member", "members"],
  storage_mb: ["storage", "storage"],
};

/** "10 accounts", "1 member", "Unlimited posts/mo", "5 GB storage", "API" / "No API". */
function limitSummary(limits: PlanLimits, l: PlanLimitInfo): string {
  if (l.kind === "boolean") return limits[l.key as "api"] === false ? "No API" : "API";
  const [one, many] = SHORT[l.key] ?? [l.key, l.key];
  return `${limitText(limits, l.key)} ${limits[l.key as keyof PlanLimits] === 1 ? one : many}`;
}

/** Editable copy of a plan: prices as decimal strings in major units, limits as strings ("" = unlimited). */
interface PlanForm {
  name: string;
  description: string;
  features: string;
  currency: string;
  priceMonth: string;
  priceYear: string;
  limits: Record<string, string>;
  api: boolean;
  refs: ProviderPrices;
  isFree: boolean;
  isTrialDefault: boolean;
  highlight: boolean;
  active: boolean;
  position: string;
}

const toMajor = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(cents % 100 ? 2 : 0));
const toCents = (v: string): number | null => (v.trim() === "" ? null : Math.round(Number(v.replace(",", ".")) * 100));

function formFromPlan(p: AdminPlanDTO | null, catalog: PlanLimitInfo[], position: number): PlanForm {
  const limits: Record<string, string> = {};
  for (const l of catalog) if (l.kind === "count") limits[l.key] = p?.limits[l.key as keyof PlanLimits] == null ? "" : String(p.limits[l.key as keyof PlanLimits]);
  return {
    name: p?.name ?? "",
    description: p?.description ?? "",
    features: (p?.features ?? []).join("\n"),
    currency: p?.currency ?? "USD",
    priceMonth: toMajor(p?.priceMonth ?? null),
    priceYear: toMajor(p?.priceYear ?? null),
    limits,
    api: p ? p.limits.api !== false : true,
    refs: JSON.parse(JSON.stringify(p?.providerPrices ?? {})) as ProviderPrices,
    isFree: p?.isFree ?? false,
    isTrialDefault: p?.isTrialDefault ?? false,
    highlight: p?.highlight ?? false,
    active: p?.active ?? true,
    position: String(p?.position ?? position),
  };
}

function PlanEditor({
  open,
  plan,
  catalog,
  providers,
  nextPosition,
  onClose,
  onSaved,
}: {
  open: boolean;
  plan: AdminPlanDTO | null;
  catalog: PlanLimitInfo[];
  providers: AdminBillingProviderDTO[];
  nextPosition: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState<PlanForm>(() => formFromPlan(plan, catalog, nextPosition));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setF(formFromPlan(plan, catalog, nextPosition));
    setError(null);
  }, [open, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof PlanForm>(k: K, v: PlanForm[K]) => setF((x) => ({ ...x, [k]: v }));

  const badPrice = (v: string) => v.trim() !== "" && !(Number.isFinite(Number(v.replace(",", "."))) && Number(v.replace(",", ".")) >= 0);
  const badCount = (v: string) => v.trim() !== "" && !/^\d+$/.test(v.trim());
  const invalid =
    !f.name.trim() ||
    badPrice(f.priceMonth) ||
    badPrice(f.priceYear) ||
    !/^[A-Za-z]{3}$/.test(f.currency.trim()) ||
    Object.values(f.limits).some(badCount) ||
    !/^-?\d+$/.test(f.position.trim());

  async function save(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    const limits: PlanLimits = {};
    for (const l of catalog) {
      if (l.kind === "boolean") (limits as Record<string, boolean | null>)[l.key] = f.api ? null : false;
      else (limits as Record<string, number | null>)[l.key] = f.limits[l.key]?.trim() ? Number(f.limits[l.key]) : null;
    }
    const input: PlanInput = {
      name: f.name.trim(),
      description: f.description.trim(),
      features: f.features.split("\n").map((x) => x.trim()).filter(Boolean),
      currency: f.currency.trim().toUpperCase(),
      priceMonth: f.isFree ? null : toCents(f.priceMonth),
      priceYear: f.isFree ? null : toCents(f.priceYear),
      limits,
      providerPrices: f.refs,
      isFree: f.isFree,
      isTrialDefault: f.isTrialDefault,
      highlight: f.highlight,
      active: f.active,
      position: Number(f.position),
    };
    setBusy(true);
    setError(null);
    try {
      if (plan) await api.admin.billing.updatePlan(plan.id, input);
      else await api.admin.billing.createPlan(input);
      toast.success(plan ? `${input.name} saved` : `${input.name} created`);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const setRef = (provider: BillingProviderId, interval: BillingInterval, v: string) =>
    setF((x) => ({ ...x, refs: { ...x.refs, [provider]: { ...(x.refs[provider] ?? {}), [interval]: v.trim() || undefined } } }));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={plan ? `Edit ${plan.name}` : "New plan"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="plan-editor" variant="primary" loading={busy} disabled={invalid}>
            {plan ? "Save plan" : "Create plan"}
          </Button>
        </>
      }
    >
      <form id="plan-editor" onSubmit={save} className="space-y-8 p-5">
        {error && <Notice tone="red">{error}</Notice>}
        <EditorGroup title="Plan">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <Field label="Name" required>
              {(id) => <Input id={id} data-autofocus value={f.name} maxLength={60} onChange={(e) => set("name", e.target.value)} placeholder="Creator" />}
            </Field>
            <Field label="Position" help="Order on pricing cards">
              {(id) => <Input id={id} type="number" value={f.position} onChange={(e) => set("position", e.target.value)} />}
            </Field>
          </div>
          <Field label="Description">
            {(id) => <Input id={id} value={f.description} maxLength={500} onChange={(e) => set("description", e.target.value)} placeholder="For creators and solo founders." />}
          </Field>
          <Field label="Features" help="One per line, shown with a check mark on the pricing cards (up to 20).">
            {(id) => <Textarea id={id} rows={5} value={f.features} onChange={(e) => set("features", e.target.value)} placeholder={"10 connected accounts\n300 posts per month"} />}
          </Field>
        </EditorGroup>

        <EditorGroup title="Price" description="Leave a price empty to not offer that interval.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Monthly" error={badPrice(f.priceMonth) ? "Enter an amount" : undefined}>
              {(id) => <Input id={id} inputMode="decimal" value={f.priceMonth} disabled={f.isFree} invalid={badPrice(f.priceMonth)} onChange={(e) => set("priceMonth", e.target.value)} placeholder="19" />}
            </Field>
            <Field label="Yearly" error={badPrice(f.priceYear) ? "Enter an amount" : undefined}>
              {(id) => <Input id={id} inputMode="decimal" value={f.priceYear} disabled={f.isFree} invalid={badPrice(f.priceYear)} onChange={(e) => set("priceYear", e.target.value)} placeholder="190" />}
            </Field>
            <Field label="Currency" help="ISO code">
              {(id) => <Input id={id} value={f.currency} maxLength={3} className="uppercase" onChange={(e) => set("currency", e.target.value)} />}
            </Field>
          </div>
        </EditorGroup>

        <EditorGroup title="Limits" description="Checked when something is created; existing data is never removed.">
          <div className="grid gap-4 sm:grid-cols-2">
            {catalog.map((l) =>
              l.kind === "boolean" ? (
                <div key={l.key} className="sm:col-span-2">
                  <label className="flex items-start gap-3 text-sm">
                    <Switch checked={f.api} onChange={(v) => set("api", v)} label={l.label} />
                    <span>
                      <span className="block font-medium text-zinc-900 dark:text-zinc-100">{l.label}</span>
                      <span className="block text-zinc-500">{l.description}</span>
                    </span>
                  </label>
                </div>
              ) : (
                <LimitField key={l.key} info={l} value={f.limits[l.key] ?? ""} invalid={badCount(f.limits[l.key] ?? "")} onChange={(v) => setF((x) => ({ ...x, limits: { ...x.limits, [l.key]: v } }))} />
              ),
            )}
          </div>
        </EditorGroup>

        {!f.isFree && (
          <EditorGroup
            title="Provider products"
            description="Create the products in each provider's dashboard and paste their ids: what the checkout charges. Prices above are only displayed."
          >
            {providers.length === 0 ? (
              <p className="text-sm text-zinc-500">Configure a payment provider first: its product ids go here.</p>
            ) : (
              <div className="space-y-4">
                {providers.map((p) => (
                  <div key={p.id}>
                    <p className="mb-2 text-sm font-medium">{p.name}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["month", "year"] as const).map((i) => (
                        <Field key={i} label={<span className="text-xs font-normal text-zinc-500">{i === "month" ? "Monthly" : "Yearly"} {REF_NOUN[p.id]}</span>}>
                          {(id) => (
                            <Input
                              id={id}
                              className="font-mono"
                              spellCheck={false}
                              value={f.refs[p.id]?.[i] ?? ""}
                              disabled={(i === "month" ? f.priceMonth : f.priceYear).trim() === ""}
                              placeholder={(i === "month" ? f.priceMonth : f.priceYear).trim() === "" ? "No price set" : REF_PLACEHOLDER[p.id]}
                              onChange={(e) => setRef(p.id, i, e.target.value)}
                            />
                          )}
                        </Field>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </EditorGroup>
        )}

        <EditorGroup title="Options">
          <div className="space-y-3 text-sm">
            <OptionCheck checked={f.isFree} onChange={(v) => set("isFree", v)} label="Free plan" help="Applies to workspaces without a subscription or trial (one plan at most). Without a free plan they are read-only." />
            <OptionCheck checked={f.isTrialDefault} onChange={(v) => set("isTrialDefault", v)} label="Trial plan" help="New workspaces try this plan for the trial period (one plan at most)." />
            <OptionCheck checked={f.highlight} onChange={(v) => set("highlight", v)} label="Most popular" help="Highlighted on the pricing cards." />
            <OptionCheck checked={f.active} onChange={(v) => set("active", v)} label="For sale" help="Archived plans keep their workspaces but are not sold." />
          </div>
        </EditorGroup>
      </form>
    </Drawer>
  );
}

const REF_NOUN: Record<BillingProviderId, string> = { polar: "product id", stripe: "price id", lemonsqueezy: "variant id" };
const REF_PLACEHOLDER: Record<BillingProviderId, string> = { polar: "Product id (UUID)", stripe: "price_…", lemonsqueezy: "e.g. 123456" };

function EditorGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <div>
        <legend className="text-sm font-semibold">{title}</legend>
        {description && <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {children}
    </fieldset>
  );
}

function LimitField({ info, value, invalid, onChange }: { info: PlanLimitInfo; value: string; invalid: boolean; onChange: (v: string) => void }) {
  const unlimited = value.trim() === "";
  const [last, setLast] = useState(value || "0");
  return (
    <Field label={info.label} help={info.description} error={invalid ? "A whole number" : undefined}>
      {(id) => (
        <div className="flex items-center gap-3">
          <Input
            id={id}
            type="number"
            min={0}
            className="w-28"
            value={unlimited ? "" : value}
            placeholder="∞"
            disabled={unlimited}
            invalid={invalid}
            onChange={(e) => {
              onChange(e.target.value);
              if (e.target.value) setLast(e.target.value);
            }}
          />
          <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
            <Checkbox checked={unlimited} onChange={(e) => onChange(e.target.checked ? "" : last)} />
            Unlimited
          </label>
        </div>
      )}
    </Field>
  );
}

function OptionCheck({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help: string }) {
  return (
    <label className="flex items-start gap-3">
      <Checkbox className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
        <span className="block text-zinc-500">{help}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Workspaces (instance.users.manage)

const FILTERS: Array<{ value: string; label: string; status: BillingStatus[] }> = [
  { value: "all", label: "All statuses", status: [] },
  { value: "active", label: "Active", status: ["active"] },
  { value: "trialing", label: "Trialing", status: ["trialing"] },
  { value: "past_due", label: "Past due", status: ["past_due"] },
  { value: "canceled", label: "Canceled", status: ["canceled"] },
  { value: "expired", label: "Expired", status: ["expired"] },
  { value: "none", label: "No subscription", status: ["none"] },
];

function WorkspacesCard({ plans }: { plans: AdminPlanDTO[] }) {
  const { tz, providerMap } = useApp();
  const providerName = (id: string) => providerDisplayName(id, providerMap);
  const [filter, setFilter] = useState("all");
  const status = FILTERS.find((f) => f.value === filter)!.status;
  const list = useFetch(`admin-billing-workspaces:${filter}`, () => api.admin.billing.workspaces(status), ["billing", "workspaces"]);
  const [editing, setEditing] = useState<AdminWorkspaceBillingDTO | null>(null);
  const rows = list.data;

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Building2 className="size-4 text-zinc-400" /> Workspaces
            {rows && <span className="font-normal text-zinc-400">{rows.length >= 500 ? "500+" : rows.length}</span>}
          </span>
        }
        description="Plan and subscription of every workspace, newest first. Comp a workspace or assign a plan by hand."
        action={
          <Select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-44">
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        }
      />
      {!rows ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No workspaces" description={filter === "all" ? "Nothing here yet." : "No workspace has this status."} className="py-10" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-zinc-100 text-xs text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="px-5 py-2.5 font-medium">Workspace</th>
                <th className="px-3 py-2.5 font-medium">State</th>
                <th className="px-3 py-2.5 font-medium">Plan</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Ends / renews</th>
                <th className="px-3 py-2.5 font-medium">Via</th>
                <th className="px-3 py-2.5 font-medium">Platforms</th>
                <th className="w-20 px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((w) => {
                const st = BILLING_STATE_META[w.state];
                const end = w.status === "trialing" ? w.trialEndsAt : w.currentPeriodEnd;
                return (
                  <tr key={w.workspaceId}>
                    <td className="px-5 py-2.5">
                      <p className="flex items-center gap-1.5 font-medium">
                        <span className="truncate">{w.workspaceName}</span>
                        {w.demo && <Badge tone="violet">Demo</Badge>}
                        {w.exempt && (
                          <Badge tone="green" title="Comped: never limited">
                            <BadgeCheck className="size-3" /> Exempt
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-zinc-500">created {formatDate(w.createdAt, tz)}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td className="px-3 py-2.5">{w.planName ?? <span className="text-zinc-400">None</span>}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={BILLING_STATUS_META[w.status].tone} dot>
                        {BILLING_STATUS_META[w.status].label}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-300">{end ? formatDate(end, tz) : <span className="text-zinc-400">—</span>}</td>
                    <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-300">
                      {w.provider ? (w.provider === "manual" ? "Manual" : PROVIDER_NAME[w.provider]) : <span className="text-zinc-400">—</span>}
                      {w.interval && <span className="text-xs text-zinc-400"> · {w.interval === "year" ? "yearly" : "monthly"}</span>}
                    </td>
                    <td className="max-w-48 truncate px-3 py-2.5 text-zinc-600 dark:text-zinc-300" title={platformAccessLabel(w.allowedProviders, providerName)}>
                      {w.allowedProviders === null ? <span className="text-zinc-400">All</span> : platformAccessLabel(w.allowedProviders, providerName)}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <Button size="sm" variant="ghost" icon={<CreditCard className="size-3.5" />} onClick={() => setEditing(w)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <WorkspaceBillingDialog
        workspace={editing}
        plans={plans}
        onClose={() => setEditing(null)}
        onSaved={(w) => {
          list.setData((l) => l?.map((x) => (x.workspaceId === w.workspaceId ? w : x)));
          void list.refetch();
        }}
      />
    </Card>
  );
}

const dateInput = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : "");
/** End of that UTC day (a trial "until Oct 20" lasts through Oct 20). */
const fromDateInput = (v: string) => (v ? Date.parse(`${v}T23:59:59Z`) : null);

function WorkspaceBillingDialog({
  workspace: w,
  plans,
  onClose,
  onSaved,
}: {
  workspace: AdminWorkspaceBillingDTO | null;
  plans: AdminPlanDTO[];
  onClose: () => void;
  onSaved: (w: AdminWorkspaceBillingDTO) => void;
}) {
  const toast = useToast();
  const [exempt, setExempt] = useState(false);
  const [planId, setPlanId] = useState("");
  const [status, setStatus] = useState<BillingStatus>("none");
  const [trialEnd, setTrialEnd] = useState("");
  const [platforms, setPlatforms] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!w) return;
    setPlatforms(w.allowedProviders);
    setExempt(w.exempt);
    setPlanId(w.planId ?? "");
    setStatus(w.status);
    setTrialEnd(dateInput(w.trialEndsAt));
  }, [w]);
  const planOptions = useMemo(() => plans.filter((p) => p.active || p.id === w?.planId), [plans, w?.planId]);
  if (!w) return null;
  const providerSub = !!w.subscriptionId && w.provider !== "manual";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!w) return;
    const body: Parameters<typeof api.admin.billing.setWorkspace>[1] = {};
    if (exempt !== w.exempt) body.exempt = exempt;
    if (planId !== (w.planId ?? "")) body.planId = planId || null;
    if (status !== w.status) body.status = status;
    if (trialEnd !== dateInput(w.trialEndsAt)) body.trialEndsAt = fromDateInput(trialEnd);
    const sorted = (v: string[] | null) => JSON.stringify(v === null ? null : [...v].sort());
    if (sorted(platforms) !== sorted(w.allowedProviders)) body.allowedProviders = platforms;
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      const res = await api.admin.billing.setWorkspace(w.workspaceId, body);
      onSaved(res);
      if (body.allowedProviders !== undefined) invalidate("providers");
      toast.success(`${w.workspaceName} updated`);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${w.workspaceName}`}
      description={w.demo ? "The demo workspace is never limited." : `Currently: ${BILLING_STATE_META[w.state].label.toLowerCase()}${w.planName ? `, ${w.planName}` : ""}.`}
    >
      <form onSubmit={save}>
        <div className="space-y-5 p-5">
          <label className="flex items-start gap-3 text-sm">
            <Switch checked={exempt} onChange={setExempt} label="Exempt" />
            <span>
              <span className="block font-medium text-zinc-900 dark:text-zinc-100">Comp this workspace</span>
              <span className="block text-zinc-500">Exempt workspaces are never limited and never billed.</span>
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan" help="A plan set here is assigned by hand (provider: manual).">
              {(id) => (
                <Select id={id} value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <option value="">No plan</option>
                  {planOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {!p.active ? " (archived)" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Status">
              {(id) => (
                <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as BillingStatus)}>
                  {(Object.keys(BILLING_STATUS_META) as BillingStatus[]).map((k) => (
                    <option key={k} value={k}>
                      {BILLING_STATUS_META[k].label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Trial ends" help="Last day of the trial (UTC). Setting it with a plan starts a trial of that plan.">
            {(id) => <Input id={id} type="date" value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} className="w-44" />}
          </Field>
          <Field label="Platforms" help="What this workspace may connect and post to. Already connected accounts of a removed platform stop publishing.">
            {() => <PlatformAccessPicker value={platforms} onChange={setPlatforms} disabled={busy} />}
          </Field>
          {providerSub && (
            <Notice tone="amber">
              This workspace has a {PROVIDER_NAME[w.provider!] ?? w.provider} subscription (<code className="font-mono text-xs">{w.subscriptionId}</code>). Its next
              webhook takes over again; cancel or change it in the provider&rsquo;s dashboard to make a manual change stick.
            </Notice>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
