import { useState } from "react";
import { AlertTriangle, Hourglass, RefreshCw } from "lucide-react";
import { ApiError, api } from "../../lib/api";
import { useApp } from "../../lib/app";
import { exposureKey, formatWatchMetric, METRIC_LABELS, POST_METRIC_KEYS, trafficSourceLabel, WATCH_METRIC_KEYS } from "../../lib/analytics";
import { compactNumber, fullNumber, percent } from "../../lib/format";
import { useSession } from "../../lib/session";
import { formatDateTime, relativeTime } from "../../lib/time";
import { engagements, exposure } from "@shared/types";
import type { MetricDetails, MetricKey, MetricValues, PostWithLogs } from "../../lib/types";
import { invalidate, useFetch } from "../../lib/useFetch";
import { Button } from "../ui/Button";
import { Skeleton, Tabs } from "../ui/Misc";
import { useToast } from "../ui/Toast";
import { InlineBar, LineChart, SERIES_1, SERIES_2, useNow } from "./charts";

const COOLDOWN = 60_000;
const HOUR = 36e5;

/** "1h", "3d" after publishing. */
function age(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 6e4))}m`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / (24 * HOUR))}d`;
}

/** "Performance" section of the post drawer (published posts). */
export function PostPerformance({ post }: { post: PostWithLogs }) {
  const { accountMap, providerMap, tz } = useApp();
  const { can } = useSession();
  const toast = useToast();
  const now = useNow();
  const data = useFetch(`post-metrics:${post.id}`, () => api.analytics.postMetrics(post.id), ["analytics"]);
  const [busy, setBusy] = useState(false);
  const [series, setSeries] = useState<"exposure" | "engagements">("exposure");
  const account = accountMap.get(post.accountId);
  const provider = account ? providerMap.get(account.provider) : undefined;

  if (provider && !provider.analytics.post) {
    return (
      <Shell>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{provider.name} does not provide post analytics.</p>
      </Shell>
    );
  }

  const d = data.data;
  const m = d?.metrics ?? null;
  // Keys the platform reports (from ProviderInfo), else the ones present in the data.
  const supported = new Set<MetricKey>(provider?.analytics.metrics ?? (Object.keys(m ?? {}) as MetricKey[]));
  const keys = POST_METRIC_KEYS.filter((k) => supported.has(k) && (m?.[k] !== undefined || !m));
  const watchKeys = WATCH_METRIC_KEYS.filter((k) => m?.[k] !== undefined);
  const ek = exposureKey(m) ?? (["views", "impressions", "reach"] as const).find((k) => supported.has(k)) ?? null;
  const rate = m && exposure(m) ? engagements(m) / exposure(m)! : null;
  const cooldownLeft = d?.metricsAt ? d.metricsAt + COOLDOWN - now : 0;

  const refresh = async () => {
    const before = d?.metricsAt ?? null;
    setBusy(true);
    try {
      const res = await api.analytics.refresh({ postId: post.id });
      const after = res.post?.metricsAt ?? null;
      if (before && after === before && Date.now() - before < COOLDOWN) {
        toast.info("Already up to date", "These numbers were fetched less than a minute ago. You can refresh again shortly.");
      } else {
        toast.success("Metrics updated");
      }
      invalidate("analytics");
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 409 ? "Only published posts have metrics." : undefined;
      toast.error(msg ? "Cannot refresh" : err, msg);
      invalidate("analytics");
    } finally {
      setBusy(false);
    }
  };

  const valueOf = (v: MetricValues) => (series === "exposure" && ek ? (v[ek] ?? 0) : engagements(v));
  const points =
    d && d.publishedAt
      ? [
          { x: 0, y: 0, label: `Published ${formatDateTime(d.publishedAt, tz)}` },
          ...d.snapshots.map((sn) => ({
            x: sn.capturedAt - d.publishedAt!,
            y: valueOf(sn.metrics),
            label: `${formatDateTime(sn.capturedAt, tz)} · ${age(sn.capturedAt - d.publishedAt!)} after publishing`,
          })),
        ]
      : [];
  const lastX = points.length ? points[points.length - 1].x : 0;

  return (
    <Shell
      action={
        can("posts.write") && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />}
            disabled={busy || !d}
            onClick={refresh}
            title={cooldownLeft > 0 ? "Fetched less than a minute ago" : "Fetch the latest numbers from the platform"}
          >
            Refresh now
          </Button>
        )
      }
    >
      {account?.metricsStatus.status === "reconnect_required" && (
        <p className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          Reconnect {account.name} on the Accounts page to enable analytics.
        </p>
      )}
      {!d ? (
        data.error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{data.error.message}</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        )
      ) : !m ? (
        <div className="flex items-start gap-3 rounded-lg bg-zinc-50 px-3.5 py-3 text-sm text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-zinc-800">
          <Hourglass className="mt-0.5 size-4 shrink-0 text-zinc-400" />
          <p>
            No metrics yet. The first numbers arrive about an hour after publishing
            {d.metricsNextAt ? ` (next check ${relativeTime(d.metricsNextAt, now)})` : ""}.
          </p>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {keys.map((k) => (
              <Metric key={k} label={METRIC_LABELS[k]} value={m[k] ?? null} />
            ))}
            <Metric label="Engagements" value={engagements(m)} />
            {rate !== null && (
              <div className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                <dt className="truncate text-xs text-zinc-500 dark:text-zinc-400">Eng. rate</dt>
                <dd className="text-base font-semibold">{percent(rate)}</dd>
              </div>
            )}
          </dl>
          {watchKeys.length > 0 && (
            <dl className="mt-2 grid grid-cols-3 gap-2">
              {watchKeys.map((k) => (
                <div key={k} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                  <dt className="truncate text-xs text-zinc-500 dark:text-zinc-400">{METRIC_LABELS[k]}</dt>
                  <dd className="text-base font-semibold tabular-nums">{formatWatchMetric(k, m[k]!)}</dd>
                </div>
              ))}
            </dl>
          )}
          {points.length > 1 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Over time</p>
                {ek && (
                  <Tabs
                    tabs={[
                      { value: "exposure" as const, label: METRIC_LABELS[ek] },
                      { value: "engagements" as const, label: "Engagements" },
                    ]}
                    value={series}
                    onChange={setSeries}
                    className="[&_button]:px-2 [&_button]:py-0.5 [&_button]:text-xs"
                  />
                )}
              </div>
              <LineChart
                points={points}
                xDomain={[0, Math.max(lastX, HOUR)]}
                xTicks={[
                  { x: 0, label: "Published" },
                  { x: Math.max(lastX, HOUR), label: `${age(lastX)} later` },
                ]}
                height={96}
                fromZero
                showDots
                color={series === "exposure" ? SERIES_1 : SERIES_2}
                label={`${series === "exposure" && ek ? METRIC_LABELS[ek] : "Engagements"} over time: ${points
                  .slice(1)
                  .map((p) => `${fullNumber(p.y)} at ${age(p.x)}`)
                  .join(", ")}`}
                valueLabel={series === "exposure" && ek ? METRIC_LABELS[ek].toLowerCase() : "engagements"}
              />
            </div>
          )}
          {d.details && <Details details={d.details} at={d.detailsAt ?? null} />}
        </>
      )}
      {d && (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          {d.metricsAt ? <span title={formatDateTime(d.metricsAt, tz, { second: "2-digit" })}>Last updated {relativeTime(Math.min(d.metricsAt, now), now)}</span> : "Not collected yet"}
          {" · "}
          {d.metricsNextAt ? <span title={formatDateTime(d.metricsNextAt, tz)}>next update {relativeTime(d.metricsNextAt, now)}</span> : "collection finished"}
        </p>
      )}
    </Shell>
  );
}

/** YouTube Analytics extras: audience retention curve and views per traffic source. */
function Details({ details, at }: { details: MetricDetails; at: number | null }) {
  const { tz } = useApp();
  const retention = details.retention ?? [];
  const sources = (details.trafficSources ?? []).slice(0, 6);
  const total = (details.trafficSources ?? []).reduce((n, s) => n + s.views, 0);
  const when = at ? ` · as of ${formatDateTime(at, tz)}` : "";
  return (
    <>
      {retention.length > 1 && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400" title="Share of viewers still watching at each moment (above 100% when parts are rewatched).">
            Audience retention{when}
          </p>
          <LineChart
            points={retention.map(([x, y]) => ({ x, y: y * 100, label: `${Math.round(x * 100)}% into the video` }))}
            xDomain={[0, 1]}
            xTicks={[
              { x: 0, label: "Start" },
              { x: 0.5, label: "Middle" },
              { x: 1, label: "End" },
            ]}
            height={96}
            fromZero
            formatValue={(v) => `${Math.round(v)}%`}
            valueLabel="still watching"
            label={`Audience retention: ${[0.25, 0.5, 0.75, 1]
              .map((x) => {
                const p = retention.reduce((best, q) => (Math.abs(q[0] - x) < Math.abs(best[0] - x) ? q : best));
                return `${Math.round(p[1] * 100)}% at ${Math.round(x * 100)}%`;
              })
              .join(", ")}`}
          />
        </div>
      )}
      {sources.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">Traffic sources (views){when}</p>
          <ol className="space-y-1.5">
            {sources.map((s) => (
              <li key={s.source} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-xs" title={s.source}>
                <span className="truncate text-zinc-700 dark:text-zinc-300">{trafficSourceLabel(s.source)}</span>
                <InlineBar value={s.views} max={sources[0].views} />
                <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
                  {compactNumber(s.views)} · {total ? percent(s.views / total, 0) : "–"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

function Shell({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex min-h-8 items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Performance</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
      <dt className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="text-base font-semibold" title={value === null ? undefined : fullNumber(value)}>
        {value === null ? "–" : compactNumber(value)}
      </dd>
    </div>
  );
}
