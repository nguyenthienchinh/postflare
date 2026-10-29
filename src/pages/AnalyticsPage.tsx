import { PlaybookRanking } from "../components/playbooks/PlaybookRanking";
import { CampaignAnalytics } from "../components/campaigns/CampaignAnalytics";
import { campaignSummary } from "../components/campaigns/bits";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { AlertTriangle, BarChart3, ExternalLink, FileText, Hourglass, ImageIcon, Info, PenSquare, Table2, Users, Zap } from "lucide-react";
import { ConnectDialog } from "../components/accounts/ConnectDialog";
import { Delta, Num } from "../components/analytics/bits";
import { DailyChart, InlineBar, LineChart } from "../components/analytics/charts";
import { MediaThumb } from "../components/posts/MediaThumb";
import { usePostDrawer } from "../components/posts/PostDrawer";
import { AccountAvatar, ProviderLogo } from "../components/ProviderLogo";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Form";
import { Card, CardHeader, EmptyState, PageHeader, Skeleton, Tabs } from "../components/ui/Misc";
import { api, type AnalyticsSort } from "../lib/api";
import { useApp } from "../lib/app";
import {
  change,
  dayCount,
  exposureKey,
  formatDayKey,
  METRIC_LABELS,
  RANGE_PRESETS,
  resolveRange,
  totalsExposure,
  todayKey,
  type RangePreset,
} from "../lib/analytics";
import { cn, compactNumber, fullNumber, percent, signedCompact, truncate } from "../lib/format";
import { useMediaLookup } from "../lib/mediaCache";
import { useSession } from "../lib/session";
import { formatDateTime } from "../lib/time";
import type { AccountDTO, AnalyticsBreakdown, AnalyticsPostDTO, AnalyticsSummaryDTO, AnalyticsTotals, FollowerSeries, Provider } from "../lib/types";
import { useFetch } from "../lib/useFetch";
import { useComposer } from "./composer/ComposerProvider";

const PAGE = 20;
const SORT_TABS: Array<{ value: AnalyticsSort; label: string }> = [
  { value: "views", label: "Most viewed" },
  { value: "engagements", label: "Most engagements" },
  { value: "engagementRate", label: "Best rate" },
  { value: "publishedAt", label: "Newest" },
];
/** Extra sorts once the period has posts with tracked App Store links. */
const CAMPAIGN_SORT_TABS: Array<{ value: AnalyticsSort; label: string }> = [
  { value: "downloads", label: "Most installs" },
  { value: "proceeds", label: "Most revenue" },
  { value: "clicks", label: "Most clicks" },
];

const hasAnalytics = (p: Provider | undefined) => !!p && (p.analytics.post || p.analytics.account);

export function AnalyticsPage() {
  const { accounts, providerMap, tz, loading } = useApp();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [reconnect, setReconnect] = useState<string | null>(null);

  // Filters live in the URL: ?range=7d|30d|90d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&account=&platform=&sort=
  const preset = ((RANGE_PRESETS as readonly string[]).includes(params.get("range") ?? "") || params.get("range") === "custom" ? params.get("range") : "30d") as RangePreset;
  const range = resolveRange(preset, tz, { from: params.get("from"), to: params.get("to") });
  const accountId = params.get("account") ?? "";
  const provider = params.get("platform") ?? "";
  const sort = ([...SORT_TABS, ...CAMPAIGN_SORT_TABS].some((s) => s.value === params.get("sort")) ? params.get("sort") : "views") as AnalyticsSort;
  const setParam = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v);
        else next.delete(k);
        return next;
      },
      { replace: true },
    );

  const query = { from: range.from, to: range.to, tz, accountId: accountId || undefined, provider: provider || undefined };
  const queryKey = JSON.stringify(query);
  const summary = useFetch(`analytics:${queryKey}`, () => api.analytics.summary(query), ["posts", "analytics"]);
  const overview = useFetch("overview", api.overview, ["posts"]);
  const s = summary.data;

  const analyticsAccounts = accounts.filter((a) => hasAnalytics(providerMap.get(a.provider)));
  const canSeeAccounts = can("accounts.read");
  const noAccounts = canSeeAccounts && !loading.accounts && accounts.length === 0;
  const noAnalyticsAccounts = canSeeAccounts && !loading.accounts && accounts.length > 0 && analyticsAccounts.length === 0;
  const neverPublished = overview.data && !overview.data.counts.published;

  // Filter options: connected accounts (or the ones the summary knows when the role cannot list accounts).
  const accountOptions = canSeeAccounts
    ? accounts.map((a) => ({ id: a.id, name: a.name, provider: a.provider }))
    : (s?.byAccount ?? []).map((a) => ({ id: a.key, name: a.name, provider: a.provider }));
  const providerOptions = [...new Set(accountOptions.map((a) => a.provider))].map((id) => ({ id, name: providerMap.get(id)?.name ?? id })).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader title="Analytics" description="How your published posts perform, and how your audience grows." />

      <Filters
        preset={preset}
        range={range}
        tz={tz}
        accountId={accountId}
        provider={provider}
        accounts={accountOptions.filter((a) => !provider || a.provider === provider)}
        providers={providerOptions}
        onPreset={(v) => (v === "custom" ? setParam({ range: "custom", from: range.fromDay, to: range.toDay }) : setParam({ range: v === "30d" ? null : v, from: null, to: null }))}
        onCustom={(from, to) => setParam({ range: "custom", from, to })}
        onAccount={(v) => setParam({ account: v || null })}
        onProvider={(v) => setParam({ platform: v || null, account: v && accountOptions.find((a) => a.id === accountId)?.provider !== v ? null : accountId || null })}
      />

      {canSeeAccounts && !noAnalyticsAccounts && <AccountNotices accounts={accounts} providerMap={providerMap} onReconnect={can("accounts.manage") ? setReconnect : undefined} />}

      {noAccounts ? (
        <Card>
          <EmptyState
            icon={<Users />}
            title="No accounts connected"
            description="Connect a profile, page or channel and publish to it: its numbers show up here."
            action={
              can("accounts.manage") && (
                <Link to="/accounts" className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700">
                  Connect an account
                </Link>
              )
            }
          />
        </Card>
      ) : noAnalyticsAccounts ? (
        <Card>
          <EmptyState
            icon={<BarChart3 />}
            title="None of your accounts provide analytics"
            description={`${[...new Set(accounts.map((a) => providerMap.get(a.provider)?.name ?? a.provider))].join(", ")} ${accounts.length === 1 ? "has" : "have"} no analytics API. Connect Instagram, YouTube, TikTok, X, Threads, Bluesky, LinkedIn Pages and more to see views, engagements and followers.`}
            action={
              can("accounts.manage") && (
                <Link to="/accounts" className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700">
                  Connect an account
                </Link>
              )
            }
          />
        </Card>
      ) : summary.error && !s ? (
        <Card>
          <EmptyState icon={<AlertTriangle />} title="Could not load analytics" description={summary.error.message} action={<Button onClick={() => void summary.refetch()}>Try again</Button>} />
        </Card>
      ) : !s ? (
        <LoadingSkeleton />
      ) : (
        <div className={cn("space-y-6 transition-opacity", summary.loading && "opacity-60")} aria-busy={summary.loading}>
          {neverPublished ? (
            <NeverPublished />
          ) : (
            <>
              {s.totals.posts > 0 && s.totals.postsWithMetrics === 0 && (
                <div className="flex items-start gap-3 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900">
                  <Hourglass className="mt-0.5 size-4 shrink-0" />
                  <p>
                    <strong className="font-semibold">Data is still being collected.</strong> The first metrics arrive about an hour after publishing, then
                    after 24 hours, 3, 7 and 30 days.
                  </p>
                </div>
              )}
              <KpiRow s={s} days={range.days} />
              <Card className="min-w-0">
                <ChartCard s={s} />
              </Card>
            </>
          )}
          {s.followers.length > 0 && <Followers series={s.followers} fromDay={range.fromDay} toDay={range.toDay} providerMap={providerMap} accounts={accounts} />}
          {!neverPublished && (
            <>
              <div className="grid min-w-0 gap-6 2xl:grid-cols-2">
                <Breakdown title="By platform" rows={s.byProvider} kind="provider" providerMap={providerMap} accounts={accounts} />
                <Breakdown title="By account" rows={s.byAccount} kind="account" providerMap={providerMap} accounts={accounts} />
              </div>
              {s.totals.campaignPosts > 0 && <CampaignAnalytics s={s} providerMap={providerMap} accounts={accounts} accountId={accountId || undefined} />}
              <TopPosts
                query={query}
                queryKey={queryKey}
                sort={sort}
                campaigns={s.totals.campaignPosts > 0}
                onSort={(v) => setParam({ sort: v === "views" ? null : v })}
              />
              <PlaybookRanking compact accountId={accountId || undefined} />
            </>
          )}
        </div>
      )}
      <ConnectDialog open={!!reconnect} onClose={() => setReconnect(null)} initialProvider={reconnect} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Filters

function Filters({
  preset,
  range,
  tz,
  accountId,
  provider,
  accounts,
  providers,
  onPreset,
  onCustom,
  onAccount,
  onProvider,
}: {
  preset: RangePreset;
  range: ReturnType<typeof resolveRange>;
  tz: string;
  accountId: string;
  provider: string;
  accounts: Array<{ id: string; name: string; provider: string }>;
  providers: Array<{ id: string; name: string }>;
  onPreset: (v: RangePreset) => void;
  onCustom: (from: string, to: string) => void;
  onAccount: (v: string) => void;
  onProvider: (v: string) => void;
}) {
  const today = todayKey(tz);
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <Tabs
        tabs={[...RANGE_PRESETS.map((p) => ({ value: p as RangePreset, label: p.replace("d", " days") })), { value: "custom" as RangePreset, label: "Custom" }]}
        value={preset}
        onChange={onPreset}
        className="max-w-full overflow-x-auto [&_button]:shrink-0 [&_button]:whitespace-nowrap"
      />
      {preset === "custom" && (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="From"
            value={range.fromDay}
            max={range.toDay}
            onChange={(e) => e.target.value && onCustom(e.target.value, range.toDay)}
            className="w-[9.5rem]"
          />
          <span className="text-zinc-400">–</span>
          <Input type="date" aria-label="To" value={range.toDay} min={range.fromDay} max={today} onChange={(e) => e.target.value && onCustom(range.fromDay, e.target.value)} className="w-[9.5rem]" />
        </div>
      )}
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
        <Select aria-label="Platform" value={provider} onChange={(e) => onProvider(e.target.value)} className="min-w-0 flex-1 sm:w-44 sm:flex-none">
          <option value="">All platforms</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Account" value={accountId} onChange={(e) => onAccount(e.target.value)} className="min-w-0 flex-1 sm:w-52 sm:flex-none">
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>
      <p className="w-full text-xs text-zinc-500 dark:text-zinc-400 sm:ml-auto sm:w-auto">
        {formatDayKey(range.fromDay, { month: "short", day: "numeric", year: range.fromDay.slice(0, 4) !== range.toDay.slice(0, 4) ? "numeric" : undefined })} –{" "}
        {formatDayKey(range.toDay, { month: "short", day: "numeric", year: "numeric" })}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Account notices

function AccountNotices({ accounts, providerMap, onReconnect }: { accounts: AccountDTO[]; providerMap: Map<string, Provider>; onReconnect?: (provider: string) => void }) {
  const reconnect = accounts.filter((a) => a.metricsStatus.status === "reconnect_required" && a.status !== "disabled");
  const errors = accounts.filter((a) => a.metricsStatus.status === "error" && a.status !== "disabled");
  const unsupported = [...new Set(accounts.filter((a) => a.metricsStatus.status === "not_supported").map((a) => providerMap.get(a.provider)?.name ?? a.provider))];
  if (!reconnect.length && !errors.length && !unsupported.length) return null;
  return (
    <div className="mb-6 space-y-2">
      {reconnect.length > 0 && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p>
                <strong className="font-semibold">Reconnect to enable analytics.</strong> These accounts publish fine, but their access predates the analytics
                permissions.
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {reconnect.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded-lg bg-white/70 py-1 pl-1.5 pr-1 ring-1 ring-amber-200 dark:bg-zinc-900/60 dark:ring-amber-900">
                    <AccountAvatar account={a} provider={providerMap.get(a.provider)} size="xs" showProvider={false} />
                    <span className="text-xs font-medium">{a.name}</span>
                    <span className="text-xs text-amber-700 dark:text-amber-400">{providerMap.get(a.provider)?.name}</span>
                    {onReconnect ? (
                      <Button size="sm" variant="primary" className="!h-6 !px-2" icon={<Zap className="size-3" />} onClick={() => onReconnect(a.provider)}>
                        Reconnect
                      </Button>
                    ) : (
                      <span className="pr-1 text-xs text-amber-700 dark:text-amber-400">ask an admin</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {errors.map((a) => (
        <div key={a.id} className="flex items-start gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 break-words">
            <strong className="font-semibold">{a.name}</strong> ({providerMap.get(a.provider)?.name ?? a.provider}): analytics could not be collected.{" "}
            {a.metricsStatus.message ?? "It will be retried automatically."}
          </p>
        </div>
      ))}
      {unsupported.length > 0 && (
        <p className="flex items-start gap-2 px-1 text-xs text-zinc-500 dark:text-zinc-400">
          <Info className="mt-px size-3.5 shrink-0" />
          {unsupported.join(", ")} {unsupported.length === 1 ? "does" : "do"} not provide analytics; posts there are counted but have no numbers.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// KPI row

function KpiRow({ s, days }: { s: AnalyticsSummaryDTO; days: number }) {
  const t = s.totals;
  const p = s.previous;
  const exp = totalsExposure(t);
  const prevExp = p[exp.key];
  const vsFor = (prev: number | null) => (prev ? `vs previous ${days} days` : "No data for the previous period");
  const vs = vsFor(p.posts);
  const pctText = (c: number | null) => (c === null ? null : `${Math.abs(c * 100).toFixed(Math.abs(c) < 0.1 ? 1 : 0)}%`);
  const tiles: Array<{ label: string; value: ReactNode; full?: string; delta?: ReactNode; caption?: ReactNode }> = [
    {
      label: "Posts published",
      value: compactNumber(t.posts),
      full: fullNumber(t.posts),
      delta: <PctDelta current={t.posts} previous={p.posts} text={pctText} />,
      caption: t.posts ? `${fullNumber(t.postsWithMetrics)} with metrics` : vs,
    },
    {
      label: METRIC_LABELS[exp.key],
      value: compactNumber(exp.value),
      full: fullNumber(exp.value),
      delta: <PctDelta current={exp.value} previous={prevExp} text={pctText} />,
      caption: exp.key === "views" && t.impressions > 0 ? `+ ${compactNumber(t.impressions)} impressions` : vsFor(prevExp),
    },
    {
      label: "Engagements",
      value: compactNumber(t.engagements),
      full: fullNumber(t.engagements),
      delta: <PctDelta current={t.engagements} previous={p.engagements} text={pctText} />,
      caption: vsFor(p.engagements),
    },
    {
      label: "Engagement rate",
      value: t.engagementRate === null ? "–" : percent(t.engagementRate),
      delta:
        t.engagementRate !== null && p.engagementRate !== null ? (
          <Delta
            value={Math.round((t.engagementRate - p.engagementRate) * 1000)}
            text={`${Math.abs((t.engagementRate - p.engagementRate) * 100).toFixed(1)} pts`}
            title={`Previous period: ${percent(p.engagementRate)}`}
          />
        ) : null,
      caption: t.engagementRate === null ? "No views reported" : vsFor(p.engagementRate),
    },
    {
      label: "Followers",
      value: t.followers === null ? "–" : compactNumber(t.followers),
      full: t.followers === null ? undefined : fullNumber(t.followers),
      delta:
        t.followersChange !== null ? (
          <Delta value={t.followersChange} text={signedCompact(t.followersChange).replace(/^[+−]/, "")} title={`${t.followersChange >= 0 ? "+" : ""}${fullNumber(t.followersChange)} in this period`} />
        ) : null,
      caption: t.followers === null ? "Not collected yet" : `in the last ${days} days`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((tile, i) => (
        <Card key={tile.label} className={cn("min-w-0 p-4", i === tiles.length - 1 && "col-span-2 md:col-span-1")}>
          <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">{tile.label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50" title={tile.full}>
            {tile.value}
          </p>
          <div className="mt-1 flex min-h-5 flex-wrap items-center gap-x-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            {tile.delta}
            <span className="truncate">{tile.caption}</span>
          </div>
        </Card>
      ))}
    </div>
  );
}

function PctDelta({ current, previous, text }: { current: number; previous: number; text: (c: number | null) => string | null }) {
  const c = change(current, previous);
  if (c === null) return null;
  return <Delta value={Math.round(c * 1000)} text={text(c)} title={`Previous period: ${fullNumber(previous)}`} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Daily chart

function ChartCard({ s }: { s: AnalyticsSummaryDTO }) {
  const [table, setTable] = useState(false);
  const exp = totalsExposure(s.totals);
  const label = METRIC_LABELS[exp.key];
  return (
    <>
      <CardHeader
        title="Performance by publish day"
        description={`${label} and engagements of the posts published each day (their latest numbers).`}
        action={
          <Button size="sm" variant="ghost" icon={table ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />} onClick={() => setTable((v) => !v)} aria-pressed={table}>
            {table ? "Chart" : "Table"}
          </Button>
        }
      />
      <div className="p-4 sm:p-5">
        {table ? (
          <div className="scrollbar-thin max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-left text-xs text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="py-2 pr-4 font-medium">Day</th>
                  <th className="py-2 pr-4 text-right font-medium">Posts</th>
                  <th className="py-2 pr-4 text-right font-medium">{label}</th>
                  <th className="py-2 pr-4 text-right font-medium">Engagements</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
                {[...s.daily].reverse().map((d) => (
                  <tr key={d.day}>
                    <td className="py-1.5 pr-4">{formatDayKey(d.day, { weekday: "short", month: "short", day: "numeric" })}</td>
                    <td className="py-1.5 pr-4 text-right">{fullNumber(d.posts)}</td>
                    <td className="py-1.5 pr-4 text-right">{fullNumber(d.views)}</td>
                    <td className="py-1.5 pr-4 text-right">{fullNumber(d.engagements)}</td>
                    <td className="py-1.5 text-right">{d.views ? percent(d.engagements / d.views) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <DailyChart daily={s.daily} exposureLabel={label} />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Followers: small multiples, one per account (same hue; the title carries identity)

function Followers({
  series,
  fromDay,
  toDay,
  providerMap,
  accounts,
}: {
  series: FollowerSeries[];
  fromDay: string;
  toDay: string;
  providerMap: Map<string, Provider>;
  accounts: AccountDTO[];
}) {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const sorted = [...series].sort((a, b) => (b.points[b.points.length - 1]?.followers ?? 0) - (a.points[a.points.length - 1]?.followers ?? 0));
  const total = dayCount(fromDay, toDay);
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Followers</h2>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">Daily follower count of each account (subscribers on YouTube and Reddit).</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
        {sorted.map((f) => {
          const first = f.points[0];
          const last = f.points[f.points.length - 1];
          const diff = last.followers - first.followers;
          const prov = providerMap.get(f.provider);
          const points = f.points.map((p) => ({ x: dayCount(fromDay, p.day) - 1, y: p.followers, label: formatDayKey(p.day, { weekday: "short", month: "short", day: "numeric" }) }));
          return (
            <Card key={f.accountId} className="min-w-0 p-4">
              <div className="flex items-start gap-3">
                <AccountAvatar account={accountMap.get(f.accountId) ?? { name: f.name, avatarUrl: null }} provider={prov} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.name}</p>
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{prov?.name ?? f.provider}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold leading-tight" title={fullNumber(last.followers)}>
                    {compactNumber(last.followers)}
                  </p>
                  {f.points.length > 1 && (
                    <Delta value={diff} text={compactNumber(Math.abs(diff))} title={`${diff >= 0 ? "+" : ""}${fullNumber(diff)} since ${formatDayKey(first.day)}`} />
                  )}
                </div>
              </div>
              <div className="mt-3">
                <LineChart
                  points={points}
                  xDomain={[0, Math.max(1, total - 1)]}
                  xTicks={[
                    { x: 0, label: formatDayKey(fromDay) },
                    { x: total - 1, label: formatDayKey(toDay) },
                  ]}
                  height={84}
                  label={`${f.name} followers: ${fullNumber(first.followers)} on ${formatDayKey(first.day)}, ${fullNumber(last.followers)} on ${formatDayKey(last.day)}`}
                  valueLabel="followers"
                />
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Breakdowns

function Breakdown({
  title,
  rows,
  kind,
  providerMap,
  accounts,
}: {
  title: string;
  rows: AnalyticsBreakdown[];
  kind: "provider" | "account";
  providerMap: Map<string, Provider>;
  accounts: AccountDTO[];
}) {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const exp = (r: AnalyticsTotals) => totalsExposure(r);
  const max = Math.max(0, ...rows.map((r) => exp(r).value));
  return (
    <Card className="min-w-0">
      <CardHeader title={title} />
      {!rows.length ? (
        <p className="px-5 py-8 text-center text-sm text-zinc-500">No posts published in this period.</p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[38rem] text-sm">
            <thead className="text-left text-xs text-zinc-500 dark:text-zinc-400">
              <tr className="border-b border-zinc-100 dark:border-zinc-800">
                <th className="w-[30%] py-2 pl-5 pr-3 font-medium">{kind === "provider" ? "Platform" : "Account"}</th>
                <th className="px-3 py-2 text-right font-medium">Posts</th>
                <th className="w-[26%] px-3 py-2 font-medium">Views</th>
                <th className="px-3 py-2 text-right font-medium">Engagements</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="py-2 pl-3 pr-5 text-right font-medium">Followers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
              {rows.map((r) => {
                const prov = providerMap.get(r.provider);
                const e = exp(r);
                return (
                  <tr key={r.key}>
                    <td className="max-w-56 py-2.5 pl-5 pr-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        {kind === "provider" ? (
                          <ProviderLogo provider={prov} size="sm" />
                        ) : (
                          <AccountAvatar account={accountMap.get(r.key) ?? { name: r.name, avatarUrl: null }} provider={prov} size="xs" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{r.name}</span>
                          {kind === "account" && <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{prov?.name ?? r.provider}</span>}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">{fullNumber(r.posts)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-right" title={`${fullNumber(e.value)} ${e.key}`}>
                          {r.postsWithMetrics && e.value ? compactNumber(e.value) : "–"}
                          {e.key !== "views" && e.value > 0 && <span className="ml-0.5 text-[10px] text-zinc-400">{e.key === "impressions" ? "imp" : "reach"}</span>}
                        </span>
                        <InlineBar value={e.value} max={max} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Num value={r.postsWithMetrics ? r.engagements : null} />
                    </td>
                    <td className="px-3 py-2.5 text-right">{r.engagementRate === null ? <span className="text-zinc-400">–</span> : percent(r.engagementRate)}</td>
                    <td className="whitespace-nowrap py-2.5 pl-3 pr-5 text-right">
                      <Num value={r.followers} />
                      {r.followersChange ? (
                        <span className="ml-1.5 inline-block">
                          <Delta value={r.followersChange} text={compactNumber(Math.abs(r.followersChange))} />
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Top posts

function TopPosts({
  query,
  queryKey,
  sort,
  onSort,
  campaigns,
}: {
  query: Parameters<typeof api.analytics.posts>[0];
  queryKey: string;
  sort: AnalyticsSort;
  onSort: (s: AnalyticsSort) => void;
  campaigns?: boolean;
}) {
  const { tz, providerMap, accountMap } = useApp();
  const { can } = useSession();
  const { openPost } = usePostDrawer();
  const [extra, setExtra] = useState<AnalyticsPostDTO[]>([]);
  const [more, setMore] = useState<"idle" | "loading" | "done">("idle");
  const first = useFetch(`analytics-posts:${queryKey}:${sort}`, () => api.analytics.posts({ ...query, sort, limit: PAGE, offset: 0 }), ["posts", "analytics"]);
  useEffect(() => {
    setExtra([]);
    setMore("idle");
  }, [first.data]);
  const posts = useMemo(() => [...(first.data ?? []), ...extra], [first.data, extra]);
  const hasMore = more !== "done" && (first.data?.length ?? 0) === PAGE && (extra.length === 0 || extra.length % PAGE === 0);
  const media = useMediaLookup(can("media.read") ? posts.flatMap((p) => p.media.slice(0, 1)) : []);

  const loadMore = async () => {
    setMore("loading");
    try {
      const page = await api.analytics.posts({ ...query, sort, limit: PAGE, offset: posts.length });
      setExtra((e) => [...e, ...page]);
      setMore(page.length < PAGE ? "done" : "idle");
    } catch {
      setMore("idle");
    }
  };

  return (
    <Card className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Top posts</h2>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">Published in this period. Click a post for details.</p>
        </div>
        <Tabs tabs={campaigns ? [...SORT_TABS, ...CAMPAIGN_SORT_TABS] : SORT_TABS} value={sort} onChange={onSort} className="max-w-full overflow-x-auto [&_button]:shrink-0 [&_button]:whitespace-nowrap" />
      </div>
      {!first.data ? (
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !posts.length ? (
        <EmptyState icon={<FileText />} title="No posts published in this period" description="Pick a longer range, or another account or platform." />
      ) : (
        <div className={cn("transition-opacity", first.loading && "opacity-60")}>
          <table className="w-full text-sm max-md:block">
            <thead className="hidden text-left text-xs text-zinc-500 md:table-header-group dark:text-zinc-400">
              <tr className="border-b border-zinc-100 dark:border-zinc-800">
                <th className="py-2 pl-5 pr-3 font-medium">Post</th>
                <th className="px-3 py-2 font-medium">Published</th>
                <th className="px-3 py-2 text-right font-medium">Views</th>
                <th className="px-3 py-2 text-right font-medium">Engagements</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="py-2 pl-3 pr-5">
                  <span className="sr-only">Link</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 max-md:block dark:divide-zinc-800">
              {posts.map((p) => {
                const prov = providerMap.get(p.provider);
                const ek = exposureKey(p.metrics);
                const views = ek ? p.metrics![ek]! : null;
                const m = p.media[0] ? media(p.media[0]) : undefined;
                return (
                  <tr
                    key={p.id}
                    onClick={() => openPost(p.id)}
                    className="group cursor-pointer align-middle transition hover:bg-zinc-50 max-md:flex max-md:items-center max-md:gap-2 max-md:px-4 max-md:py-3 dark:hover:bg-zinc-800/40"
                  >
                    <td className="py-3 pl-5 pr-3 max-md:block max-md:min-w-0 max-md:flex-1 max-md:p-0">
                      <div className="flex min-w-0 items-center gap-3">
                        {p.media[0] ? (
                          <MediaThumb media={m} className="size-11 shrink-0 rounded-lg" />
                        ) : (
                          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
                            {p.media.length ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openPost(p.id);
                            }}
                            className="block max-w-full truncate text-left font-medium text-zinc-900 group-hover:text-brand-700 focus:outline-none focus-visible:underline md:max-w-md dark:text-zinc-100 dark:group-hover:text-brand-300"
                          >
                            {p.excerpt ? truncate(p.excerpt.replace(/\s+/g, " "), 110) : <span className="italic text-zinc-400">Media post</span>}
                          </button>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            <ProviderLogo provider={prov} size="xs" />
                            <span className="truncate">{accountMap.get(p.accountId)?.name ?? p.accountName}</span>
                            <span className="shrink-0 md:hidden">· {formatDateTime(p.publishedAt, tz, { hour: undefined, minute: undefined })}</span>
                          </div>
                          {p.campaign && (
                            <p className="mt-0.5 truncate text-xs tabular-nums text-brand-700 dark:text-brand-300" title="Tracked App Store link (installs and proceeds: Apple App Analytics, 2-3 days delay)">
                              App Store: {campaignSummary(p.campaign)}
                            </p>
                          )}
                          <p className="mt-0.5 truncate text-xs tabular-nums text-zinc-500 md:hidden dark:text-zinc-400">
                            {p.metrics ? (
                              <>
                                {views !== null && ek && (
                                  <>
                                    <strong className="font-semibold text-zinc-800 dark:text-zinc-200">{compactNumber(views)}</strong> {METRIC_LABELS[ek].toLowerCase()} ·{" "}
                                  </>
                                )}
                                <strong className="font-semibold text-zinc-800 dark:text-zinc-200">{compactNumber(p.engagements)}</strong> eng.
                                {p.engagementRate !== null && (
                                  <>
                                    {" "}
                                    · <strong className="font-semibold text-zinc-800 dark:text-zinc-200">{percent(p.engagementRate)}</strong>
                                  </>
                                )}
                              </>
                            ) : (
                              "Metrics pending"
                            )}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-zinc-500 max-md:hidden dark:text-zinc-400">{formatDateTime(p.publishedAt, tz)}</td>
                    <td className="px-3 py-3 text-right tabular-nums max-md:hidden">
                      <MetricCell value={views} label={ek ? METRIC_LABELS[ek].toLowerCase() : "views"} pending={!p.metrics} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums max-md:hidden">
                      <MetricCell value={p.metrics ? p.engagements : null} label="engagements" pending={!p.metrics} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums max-md:hidden">
                      {p.engagementRate === null ? <span className="text-zinc-400">–</span> : percent(p.engagementRate)}
                    </td>
                    <td className="py-3 pl-3 pr-5 text-right max-md:block max-md:shrink-0 max-md:p-0">
                      {p.externalUrl && (
                        <a
                          href={p.externalUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex size-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                          aria-label={`Open on ${prov?.name ?? "the platform"}`}
                          title={`Open on ${prov?.name ?? "the platform"}`}
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hasMore && (
            <div className="border-t border-zinc-100 p-3 text-center dark:border-zinc-800">
              <Button variant="ghost" loading={more === "loading"} onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function MetricCell({ value, label, pending }: { value: number | null; label: string; pending: boolean }) {
  if (pending)
    return (
      <span className="text-xs text-zinc-400" title="First metrics arrive about an hour after publishing">
        pending
      </span>
    );
  return (
    <>
      <Num value={value} title={`${value === null ? "–" : fullNumber(value)} ${label}`} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Empty / loading

function NeverPublished() {
  const composer = useComposer();
  const canWrite = useSession().can("posts.write");
  return (
    <Card>
      <EmptyState
        icon={<BarChart3 />}
        title="No published posts yet"
        description="Views, engagements and top posts appear here once you publish. The first metrics arrive about an hour after publishing."
        action={
          canWrite && (
            <Button variant="primary" icon={<PenSquare className="size-4" />} onClick={() => composer.open({})}>
              Create a post
            </Button>
          )
        }
      />
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-7 w-16" />
            <Skeleton className="mt-2 h-3 w-28" />
          </Card>
        ))}
      </div>
      <Card className="p-5">
        <Skeleton className="h-72 w-full" />
      </Card>
    </div>
  );
}

