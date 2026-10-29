// Admin → Overview: the whole instance at a glance (GET /api/admin/overview). Follows the dataviz method like the
// Analytics page: KPI tiles, one panel-column chart with a table view, success-rate bars in a single series color,
// quota meters whose fill carries severity (status palette, always with an icon + label), recessive grid.

import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  Clock,
  Info,
  OctagonAlert,
  RefreshCw,
  Table2,
} from "lucide-react";
import { InlineBar, PanelColumns, SERIES_1, useNow } from "../../components/analytics/charts";
import { Num } from "../../components/analytics/bits";
import { ProviderLogo } from "../../components/ProviderLogo";
import { Button } from "../../components/ui/Button";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton, Tabs } from "../../components/ui/Misc";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app";
import { formatDayKey } from "../../lib/analytics";
import { cn, compactNumber, formatBytes, fullNumber, money, percent, plural, truncate } from "../../lib/format";
import { useSession } from "../../lib/session";
import { formatDateTime, relativeTime } from "../../lib/time";
import type { AdminOverviewDTO, AdminQuotaDTO, AdminWorkspaceRowDTO, QuotaLevel } from "../../lib/types";
import { useFetch } from "../../lib/useFetch";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;
type RangeValue = (typeof RANGES)[number]["value"];

const FAILED_COLOR = "var(--viz-status-critical)";

export function OverviewPage() {
  const [params, setParams] = useSearchParams();
  const days = (RANGES.some((r) => r.value === params.get("days")) ? params.get("days") : "30") as RangeValue;
  const overview = useFetch(`admin-overview:${days}`, () => api.admin.overview(Number(days)), ["posts", "accounts", "media"]);
  const o = overview.data;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Everything on this instance: publishing, platform health, Free plan quotas and workspaces. Days are UTC."
        actions={
          <>
            <Tabs tabs={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={days} onChange={(v) => setParams(v === "30" ? {} : { days: v }, { replace: true })} />
            <Button variant="ghost" size="sm" icon={<RefreshCw className={cn("size-3.5", overview.loading && "animate-spin")} />} onClick={() => overview.refetch()} aria-label="Refresh">
              Refresh
            </Button>
          </>
        }
      />
      {overview.error && !o ? (
        <Card>
          <EmptyState icon={<AlertTriangle />} title="Could not load the overview" description={overview.error.message} action={<Button onClick={() => overview.refetch()}>Try again</Button>} />
        </Card>
      ) : !o ? (
        <LoadingState />
      ) : (
        <Overview o={o} />
      )}
    </>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[6.25rem] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-80 rounded-xl lg:col-span-2" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  );
}

function Overview({ o }: { o: AdminOverviewDTO }) {
  const metered = o.system.meteringSince;
  const fromDay = o.posts.daily[0]?.day;
  return (
    <div className="space-y-4 sm:space-y-6">
      {(!metered || (fromDay && metered > fromDay)) && (
        <p className="flex items-start gap-2 rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900/60 dark:text-zinc-400 dark:ring-zinc-800">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>
            Publish attempts, failures and quota estimates come from usage metering,{" "}
            {metered ? `recorded since ${formatDayKey(metered, { month: "short", day: "numeric", year: "numeric" })}` : "which has not recorded anything yet"}. Published counts cover
            all history.
          </span>
        </p>
      )}
      <KpiRow o={o} />
      {o.billing.enabled && <BillingRow o={o} />}
      {/* Two independent columns (main / side) so cards keep their natural height. */}
      <div className="grid min-w-0 items-start gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 sm:space-y-6 lg:col-span-2">
          <Card className="min-w-0">
            <ActivityCard o={o} />
          </Card>
          <Card className="min-w-0">
            <ProviderHealth o={o} />
          </Card>
          <Card className="min-w-0">
            <LastErrors o={o} />
          </Card>
        </div>
        <div className="min-w-0 space-y-4 sm:space-y-6">
          <Card className="min-w-0">
            <QuotaCard quotas={o.quotas} />
          </Card>
          <Card className="min-w-0">
            <SystemCard o={o} />
          </Card>
          <Card className="min-w-0">
            <AccountsCard o={o} />
          </Card>
        </div>
      </div>
      <Card className="min-w-0 overflow-hidden">
        <WorkspaceTable rows={o.workspaces} days={o.range.days} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// KPI tiles

function KpiRow({ o }: { o: AdminOverviewDTO }) {
  const p = o.posts;
  const attention = p.failed + p.needsCheck;
  const tiles: Array<{ label: string; value: number; caption: ReactNode; status?: ReactNode }> = [
    { label: "Published today", value: p.publishedToday, caption: `${fullNumber(p.scheduledToday)} still scheduled today` },
    { label: "Last 7 days", value: p.published7d, caption: `${fullNumber(Math.round(p.published7d / 7))} a day on average` },
    o.range.days === 7
      ? { label: "All time", value: p.publishedAllTime, caption: "posts published" }
      : { label: `Last ${o.range.days} days`, value: p.publishedRange, caption: `${compactNumber(p.publishedAllTime)} published all time` },
    { label: "Next 24 hours", value: p.scheduledNext24h, caption: `${plural(p.drafts, "draft")} · ${fullNumber(p.publishing)} publishing now` },
    {
      label: "Needs attention",
      value: attention,
      caption: `${fullNumber(p.failed)} failed · ${fullNumber(p.needsCheck)} to check`,
      status: attention ? <AlertTriangle className="size-4 text-amber-500" aria-label="Needs attention" /> : <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-500" aria-label="All clear" />,
    },
    {
      label: "Workspaces",
      value: o.counts.workspaces,
      caption: `${plural(o.counts.users.active, "user")}${o.counts.users.pending ? ` (+${fullNumber(o.counts.users.pending)} pending)` : ""} · ${plural(o.counts.accounts.total, "account")}`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <Card key={t.label} className="min-w-0 p-4">
          <p className="flex items-center justify-between gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <span className="truncate">{t.label}</span>
            {t.status}
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50" title={fullNumber(t.value)}>
            {compactNumber(t.value)}
          </p>
          <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400" title={typeof t.caption === "string" ? t.caption : undefined}>
            {t.caption}
          </p>
        </Card>
      ))}
    </div>
  );
}

/** Hosted mode (billing on): subscriptions of non-demo, non-exempt workspaces and the MRR estimate. */
function BillingRow({ o }: { o: AdminOverviewDTO }) {
  const b = o.billing;
  const tiles: Array<{ label: string; value: ReactNode; title: string; caption: string; status?: ReactNode }> = [
    { label: "Paying", value: compactNumber(b.paying), title: fullNumber(b.paying), caption: `${fullNumber(b.manual)} assigned by hand · ${fullNumber(b.exempt)} exempt` },
    { label: "Trialing", value: compactNumber(b.trialing), title: fullNumber(b.trialing), caption: "free trials running" },
    {
      label: "Past due",
      value: compactNumber(b.pastDue),
      title: fullNumber(b.pastDue),
      caption: b.pastDue ? "failed payment, in the grace period" : "no failed payments",
      status: b.pastDue ? <AlertTriangle className="size-4 text-amber-500" aria-label="Needs attention" /> : undefined,
    },
    { label: "MRR", value: money(b.mrrCents / 100, b.currency, { compact: true }).replace(/\.00$/, ""), title: money(b.mrrCents / 100, b.currency), caption: "estimate: monthly + yearly ÷ 12" },
  ];
  return (
    <div>
      <p className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        Billing
        <Link to="/admin/billing" className="font-medium normal-case tracking-normal text-brand-600 hover:underline dark:text-brand-400">
          Manage
        </Link>
      </p>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="min-w-0 p-4">
            <p className="flex items-center justify-between gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="truncate">{t.label}</span>
              {t.status}
            </p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50" title={t.title}>
              {t.value}
            </p>
            <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400" title={t.caption}>
              {t.caption}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Daily activity

function ActivityCard({ o }: { o: AdminOverviewDTO }) {
  const [table, setTable] = useState(false);
  const failedTotal = o.posts.daily.reduce((n, d) => n + d.failed, 0);
  return (
    <>
      <CardHeader
        title="Publishing per day"
        description={`Posts published and failed attempts (failed or needing a check), all workspaces except the demo.${failedTotal ? "" : " No failures in this period."}`}
        action={
          <Button size="sm" variant="ghost" icon={table ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />} onClick={() => setTable((v) => !v)} aria-pressed={table}>
            {table ? "Chart" : "Table"}
          </Button>
        }
      />
      <div className="p-4 sm:p-5">
        {table ? (
          <div className="scrollbar-thin max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-left text-xs text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="py-2 pr-4 font-medium">Day</th>
                  <th className="py-2 pr-4 text-right font-medium">Published</th>
                  <th className="py-2 text-right font-medium">Failed attempts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
                {[...o.posts.daily].reverse().map((d) => (
                  <tr key={d.day}>
                    <td className="py-1.5 pr-4">{formatDayKey(d.day, { weekday: "short", month: "short", day: "numeric" })}</td>
                    <td className="py-1.5 pr-4 text-right">{fullNumber(d.published)}</td>
                    <td className="py-1.5 text-right">{fullNumber(d.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <PanelColumns
            label="Publishing per day"
            rows={o.posts.daily}
            panels={[
              { key: "published", label: "Published", color: SERIES_1, height: 140, unit: ["post published", "posts published"] },
              { key: "failed", label: "Failed attempts", color: FAILED_COLOR, height: 44, unit: ["failed attempt", "failed attempts"] },
            ]}
          />
        )}
        {o.posts.topWorkspaces.length > 0 && (
          <div className="mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Top workspaces</p>
            <ul className="space-y-2">
              {o.posts.topWorkspaces.map((w) => (
                <li key={w.id} className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-3 text-sm">
                  <span className="truncate" title={w.name}>
                    {w.name}
                  </span>
                  <InlineBar value={w.published} max={o.posts.topWorkspaces[0].published} />
                  <span className="text-right tabular-nums text-zinc-600 dark:text-zinc-300">{compactNumber(w.published)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Quotas

const LEVEL: Record<QuotaLevel, { color: string; label: string; icon: typeof CheckCircle2; text: string }> = {
  ok: { color: SERIES_1, label: "OK", icon: CheckCircle2, text: "text-zinc-500 dark:text-zinc-400" },
  warning: { color: "var(--viz-status-warning)", label: "Over 70%", icon: AlertTriangle, text: "text-amber-700 dark:text-amber-400" },
  critical: { color: "var(--viz-status-critical)", label: "Over 90%", icon: OctagonAlert, text: "text-red-700 dark:text-red-400" },
};

const fmtQuota = (q: AdminQuotaDTO, v: number) => (q.unit === "bytes" ? formatBytes(v) : compactNumber(v));

function QuotaCard({ quotas }: { quotas: AdminQuotaDTO[] }) {
  return (
    <>
      <CardHeader title="Free plan quotas" description="Estimates from metered usage. Worker requests cannot be measured from inside the Worker." />
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {quotas.map((q) => (
          <QuotaMeter key={q.key} q={q} />
        ))}
      </ul>
    </>
  );
}

function QuotaMeter({ q }: { q: AdminQuotaDTO }) {
  const lv = LEVEL[q.level];
  const pct = (v: number) => Math.min(100, (v / q.limit) * 100);
  const used = pct(q.used);
  const projected = q.projected !== null && q.projected > q.used ? pct(q.projected) : null;
  const Icon = lv.icon;
  return (
    <li className="px-5 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {q.label}
          {q.estimate && <span className="ml-1.5 text-xs font-normal text-zinc-400">est.</span>}
        </p>
        <p className="shrink-0 text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">{fmtQuota(q, q.used)}</span>
          <span className="text-zinc-400"> / {fmtQuota(q, q.limit)}</span>
        </p>
      </div>
      <div
        className="relative mt-2 h-2 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: `color-mix(in srgb, ${lv.color} 16%, transparent)` }}
        role="meter"
        aria-label={q.label}
        aria-valuemin={0}
        aria-valuemax={q.limit}
        aria-valuenow={q.used}
        aria-valuetext={`${fmtQuota(q, q.used)} of ${fmtQuota(q, q.limit)} (${Math.round(used)}%)`}
      >
        {projected !== null && (
          <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${projected}%`, backgroundColor: `color-mix(in srgb, ${lv.color} 38%, transparent)` }} />
        )}
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(q.used > 0 ? 1.5 : 0, used)}%`, backgroundColor: lv.color }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-xs">
        <span className={cn("inline-flex items-center gap-1 font-medium", lv.text)}>
          <Icon className="size-3.5" aria-hidden />
          {q.level === "ok" ? `${used < 1 && q.used > 0 ? "<1" : Math.round(used)}% used` : `${lv.label} · ${Math.round(used)}% used`}
        </span>
        {projected !== null && <span className="tabular-nums text-zinc-500 dark:text-zinc-400">→ {fmtQuota(q, q.projected!)} by end of day</span>}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">{q.note}</p>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Platform health

function ProviderHealth({ o }: { o: AdminOverviewDTO }) {
  const { providerMap } = useApp();
  const rows = o.posts.byProvider;
  const maxPublished = Math.max(1, ...rows.map((r) => r.published));
  return (
    <>
      <CardHeader title="Platform health" description={`Last ${o.range.days} days. Success rate = published attempts out of all publish attempts (metered).`} />
      {rows.length === 0 ? (
        <EmptyState title="Nothing published yet" description="Platforms appear here once posts are published or attempted." className="py-10" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-zinc-100 text-xs text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="px-5 py-2.5 font-medium">Platform</th>
                <th className="w-40 px-3 py-2.5 font-medium">Published</th>
                <th className="px-3 py-2.5 text-right font-medium">Open failures</th>
                <th className="w-48 px-5 py-2.5 font-medium">Success rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => {
                const provider = providerMap.get(r.provider);
                const attempts = r.attempts.published + r.attempts.failed + r.attempts.needsCheck;
                const rate = r.successRate;
                return (
                  <tr key={r.provider}>
                    <td className="px-5 py-2.5">
                      <span className="flex items-center gap-2.5">
                        <ProviderLogo provider={provider} size="sm" />
                        <span className="truncate font-medium">{provider?.name ?? r.provider}</span>
                        {r.withUrl > 0 && r.provider === "x" && (
                          <Badge tone="amber" title="X bills posts with links about 13x more">
                            {fullNumber(r.withUrl)} with links
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2">
                        <span className="w-10 shrink-0 text-right tabular-nums">{compactNumber(r.published)}</span>
                        <InlineBar value={r.published} max={maxPublished} />
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.failed ? (
                        <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
                          <AlertTriangle className="size-3.5" aria-hidden />
                          {fullNumber(r.failed)}
                        </span>
                      ) : (
                        <span className="text-zinc-400">0</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5">
                      {rate === null ? (
                        <span className="text-xs text-zinc-400">No metered attempts</span>
                      ) : (
                        <span className="flex items-center gap-2" title={`${fullNumber(r.attempts.published)} published, ${fullNumber(r.attempts.failed)} failed, ${fullNumber(r.attempts.needsCheck)} to check`}>
                          <span className={cn("w-12 shrink-0 text-right tabular-nums", rate < 0.9 && "font-semibold text-red-700 dark:text-red-400")}>{percent(rate, rate === 1 ? 0 : 1)}</span>
                          <SuccessBar rate={rate} />
                          <span className="w-8 shrink-0 text-right text-xs tabular-nums text-zinc-400">{compactNumber(attempts)}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Success share in series 1; the remainder (failures) as a status segment after a 2px surface gap. */
function SuccessBar({ rate }: { rate: number }) {
  return (
    <span className="flex h-1.5 w-full min-w-16 gap-0.5 overflow-hidden rounded-full" aria-hidden>
      {rate > 0 && <span className="h-full rounded-l-full" style={{ width: `${rate * 100}%`, backgroundColor: SERIES_1 }} />}
      {rate < 1 && <span className="h-full flex-1 rounded-r-full" style={{ backgroundColor: FAILED_COLOR }} />}
    </span>
  );
}

function LastErrors({ o }: { o: AdminOverviewDTO }) {
  const { providerMap, tz } = useApp();
  const now = useNow();
  const errors = o.health.lastErrors;
  return (
    <>
      <CardHeader title="Latest errors" description="The last failed or unconfirmed publishes and follow-ups, all workspaces." />
      {errors.length === 0 ? (
        <EmptyState icon={<CheckCircle2 />} title="No errors recorded" description="Failures will show up here with their platform and message." className="py-10" />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {errors.map((e, i) => {
            const provider = e.provider ? providerMap.get(e.provider) : undefined;
            return (
              <li key={i} className="flex items-start gap-3 px-5 py-3">
                <ProviderLogo provider={provider} size="sm" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium">{provider?.name ?? e.provider ?? "Unknown"}</span>
                    <Badge tone={e.outcome === "needs_check" ? "amber" : "red"}>
                      {e.outcome === "needs_check" ? "Needs check" : "Failed"}
                      {e.kind === "reply" ? " · follow-up" : ""}
                    </Badge>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">{e.workspaceName ?? "Deleted workspace"}</span>
                  </p>
                  <p className="mt-0.5 break-words text-sm text-zinc-600 dark:text-zinc-300" title={e.message ?? undefined}>
                    {e.message ? truncate(e.message, 220) : "No message"}
                  </p>
                </div>
                <time className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400" dateTime={new Date(e.at).toISOString()} title={formatDateTime(e.at, tz)}>
                  {relativeTime(e.at, now)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// System and accounts

function SystemCard({ o }: { o: AdminOverviewDTO }) {
  const s = o.system;
  const { tz } = useApp();
  const now = useNow();
  const u = s.update;
  const row = (label: string, value: ReactNode, title?: string) => (
    <div key={label} className="flex items-start justify-between gap-4 px-5 py-2.5 text-sm" title={title}>
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-zinc-800 dark:text-zinc-100">{value}</dd>
    </div>
  );
  const CRON_LABEL = { frequent: "Publishing safety net", metrics: "Analytics", daily: "Daily cleanup" } as const;
  return (
    <>
      <CardHeader title="System" />
      <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {row(
          "Version",
          <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
            <span className="tabular-nums">{u.current}</span>
            {u.commit && <span className="font-mono text-xs font-normal text-zinc-400">{u.commit.slice(0, 7)}</span>}
            {u.updateAvailable ? (
              <a href={u.url ?? undefined} target="_blank" rel="noreferrer">
                <Badge tone="brand">{u.latest} available</Badge>
              </a>
            ) : u.enabled ? (
              <Badge tone="green">Up to date</Badge>
            ) : (
              <Badge>Checks off</Badge>
            )}
          </span>,
          u.checkedAt ? `Last update check ${formatDateTime(u.checkedAt, tz)}${u.error ? ` (${u.error})` : ""}` : undefined,
        )}
        {s.crons.map((c) =>
          row(
            CRON_LABEL[c.name],
            c.lastRunAt ? (
              <span className={cn("inline-flex items-center gap-1", c.stale && "text-amber-700 dark:text-amber-400")}>
                {c.stale ? <AlertTriangle className="size-3.5" aria-label="Late" /> : <Clock className="size-3.5 text-zinc-400" aria-hidden />}
                {relativeTime(c.lastRunAt, now)}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 font-normal text-zinc-400">Not run yet</span>
            ),
            `${c.schedule} (UTC)${c.lastRunAt ? ` · last run ${formatDateTime(c.lastRunAt, tz)}${c.durationMs !== null ? `, ${c.durationMs} ms` : ""}` : ""}`,
          ),
        )}
        {row("Demo mode", s.demoMode ? <Badge tone="violet">On</Badge> : <span className="font-normal text-zinc-500">Off</span>)}
        {row("Media retention", s.mediaRetentionDays ? `${s.mediaRetentionDays} days` : "Keep forever")}
        {row("Experimental integrations", s.experimentalIntegrations ? <Badge tone="amber">On</Badge> : <span className="font-normal text-zinc-500">Off</span>)}
        {row("API keys", fullNumber(o.counts.apiKeys))}
        {row("Usage metering", s.meteringSince ? `since ${formatDayKey(s.meteringSince, { month: "short", day: "numeric", year: "numeric" })}` : "No events yet", `Kept ${s.usageRetentionDays} days`)}
      </dl>
    </>
  );
}

function AccountsCard({ o }: { o: AdminOverviewDTO }) {
  const { providerMap } = useApp();
  const a = o.counts.accounts;
  const users = o.counts.users;
  return (
    <>
      <CardHeader title="Accounts and users" description={`${fullNumber(a.total)} connected accounts, demo excluded.`} />
      <div className="grid grid-cols-3 divide-x divide-zinc-100 border-b border-zinc-100 text-center dark:divide-zinc-800 dark:border-zinc-800">
        {(
          [
            ["Active", a.byStatus.active, null],
            ["Reconnect", a.byStatus.reconnect, a.byStatus.reconnect ? <AlertTriangle key="i" className="size-3.5 text-amber-500" aria-hidden /> : null],
            ["Disabled", a.byStatus.disabled, null],
          ] as const
        ).map(([label, n, icon]) => (
          <div key={label} className="px-2 py-3">
            <p className="flex items-center justify-center gap-1 text-lg font-semibold">
              {icon}
              <Num value={n} />
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
          </div>
        ))}
      </div>
      {a.byProvider.length > 0 && (
        <ul className="scrollbar-thin max-h-52 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
          {a.byProvider.map((p) => (
            <li key={p.provider} className="flex items-center gap-2.5 px-5 py-2 text-sm">
              <ProviderLogo provider={providerMap.get(p.provider)} size="sm" />
              <span className="min-w-0 flex-1 truncate">{providerMap.get(p.provider)?.name ?? p.provider}</span>
              {p.reconnect > 0 && <Badge tone="amber">{p.reconnect} to reconnect</Badge>}
              {p.disabled > 0 && <Badge>{p.disabled} disabled</Badge>}
              <span className="w-8 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{p.active + p.reconnect + p.disabled}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        {fullNumber(users.active)} active {users.active === 1 ? "user" : "users"}
        {users.disabled ? ` · ${fullNumber(users.disabled)} disabled` : ""}
        {users.pending ? ` · ${fullNumber(users.pending)} pending email confirmation` : ""}
        {o.counts.demoWorkspaces ? ` · demo: ${fullNumber(o.demo.publishedRange)} simulated posts in ${o.range.days} days` : ""}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Workspaces

type SortKey = "name" | "members" | "accounts" | "published" | "scheduled" | "failed" | "storageBytes" | "createdAt" | "lastActivity";

function WorkspaceTable({ rows, days }: { rows: AdminWorkspaceRowDTO[]; days: number }) {
  const { tz } = useApp();
  const { workspaces, switchWorkspace, workspace } = useSession();
  const navigate = useNavigate();
  const now = useNow();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "published", dir: -1 });
  const sorted = useMemo(() => {
    const val = (r: AdminWorkspaceRowDTO): number | string => (sort.key === "failed" ? r.failed + r.needsCheck : sort.key === "name" ? r.name.toLowerCase() : (r[sort.key] ?? -1));
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || a.name.localeCompare(b.name);
    });
  }, [rows, sort]);
  const maxPublished = Math.max(1, ...rows.map((r) => r.published));
  const canOpen = (id: string) => workspaces.some((w) => w.id === id);

  const th = (key: SortKey, label: string, align: "left" | "right" = "right") => {
    const active = sort.key === key;
    return (
      <th className={cn("px-3 py-2.5 font-medium", align === "right" && "text-right")} aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => setSort(active ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 })}
          className={cn("inline-flex items-center gap-1 hover:text-zinc-800 dark:hover:text-zinc-200", active && "text-zinc-800 dark:text-zinc-100")}
        >
          {label}
          {active && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
        </button>
      </th>
    );
  };

  return (
    <>
      <CardHeader title="Workspaces" description={`${rows.length} ${rows.length === 1 ? "workspace" : "workspaces"}. Published = last ${days} days.`} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead className="border-b border-zinc-100 text-xs text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="py-2.5 pl-5 pr-3 font-medium" aria-sort={sort.key === "name" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                <button type="button" onClick={() => setSort({ key: "name", dir: sort.key === "name" ? (sort.dir === 1 ? -1 : 1) : 1 })} className="inline-flex items-center gap-1 hover:text-zinc-800 dark:hover:text-zinc-200">
                  Workspace
                  {sort.key === "name" && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                </button>
              </th>
              {th("members", "Members")}
              {th("accounts", "Accounts")}
              {th("published", "Published")}
              {th("scheduled", "Scheduled")}
              {th("failed", "Failed / check")}
              {th("storageBytes", "Storage")}
              {th("createdAt", "Created")}
              {th("lastActivity", "Last activity")}
              <th className="py-2.5 pl-3 pr-5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {sorted.map((r) => (
              <tr key={r.id} className={cn(r.isDemo && "bg-zinc-50/60 dark:bg-zinc-900/40")}>
                <td className="max-w-64 py-2.5 pl-5 pr-3">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium" title={r.name}>
                      {r.name}
                    </span>
                    {r.isDemo && <Badge tone="violet">Demo</Badge>}
                    {workspace?.id === r.id && <Badge tone="brand">Current</Badge>}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fullNumber(r.members)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fullNumber(r.accounts)}</td>
                <td className="px-3 py-2.5">
                  <span className="flex items-center justify-end gap-2">
                    <span className="w-16">
                      <InlineBar value={r.published} max={maxPublished} />
                    </span>
                    <span className="w-10 text-right tabular-nums">{compactNumber(r.published)}</span>
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fullNumber(r.scheduled)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {r.failed + r.needsCheck ? (
                    <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400" title={`${r.failed} failed, ${r.needsCheck} need a check`}>
                      <AlertTriangle className="size-3.5" aria-hidden />
                      {fullNumber(r.failed)} / {fullNumber(r.needsCheck)}
                    </span>
                  ) : (
                    <span className="text-zinc-400">0</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.storageBytes ? formatBytes(r.storageBytes) : <span className="text-zinc-400">–</span>}</td>
                <td className="px-3 py-2.5 text-right text-zinc-600 dark:text-zinc-300" title={formatDateTime(r.createdAt, tz)}>
                  {new Intl.DateTimeFormat(undefined, { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(new Date(r.createdAt))}
                </td>
                <td className="px-3 py-2.5 text-right text-zinc-600 dark:text-zinc-300" title={r.lastActivity ? formatDateTime(r.lastActivity, tz) : undefined}>
                  {r.lastActivity ? relativeTime(r.lastActivity, now) : <span className="text-zinc-400">–</span>}
                </td>
                <td className="py-2.5 pl-3 pr-5 text-right">
                  {canOpen(r.id) && workspace?.id !== r.id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<ArrowRightLeft className="size-3.5" />}
                      onClick={() => {
                        switchWorkspace(r.id);
                        navigate("/");
                      }}
                      title={`Switch to ${r.name}`}
                    >
                      Open
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
