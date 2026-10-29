import { Link } from "react-router";
import { ArrowRight, Trophy } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app";
import { change, exposureKey, METRIC_LABELS, resolveRange, totalsExposure } from "../../lib/analytics";
import { compactNumber, fullNumber, percent, truncate } from "../../lib/format";
import { useFetch } from "../../lib/useFetch";
import { usePostDrawer } from "../posts/PostDrawer";
import { ProviderLogo } from "../ProviderLogo";
import { Card, CardHeader, Skeleton } from "../ui/Misc";
import { Delta } from "./bits";

/** Dashboard: views, engagements and the top post of the last 7 days. */
export function AnalyticsTile() {
  const { tz, providerMap } = useApp();
  const { openPost } = usePostDrawer();
  const range = resolveRange("7d", tz);
  const q = { from: range.from, to: range.to, tz };
  const key = `${range.fromDay}:${tz}`;
  const summary = useFetch(`dash-analytics:${key}`, () => api.analytics.summary(q), ["posts", "analytics"]);
  const top = useFetch(`dash-top:${key}`, () => api.analytics.posts({ ...q, sort: "views", limit: 1 }), ["posts", "analytics"]);
  const s = summary.data;
  const t = top.data?.[0];
  const exp = s ? totalsExposure(s.totals) : null;

  const stat = (label: string, value: number, previous: number) => {
    const c = change(value, previous);
    return (
      <div className="min-w-0">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold tracking-tight" title={fullNumber(value)}>
          {compactNumber(value)}
        </p>
        <div className="mt-0.5 flex min-h-4 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          {c !== null ? (
            <>
              <Delta value={Math.round(c * 1000)} text={`${Math.abs(c * 100).toFixed(0)}%`} title={`Previous 7 days: ${fullNumber(previous)}`} />
              <span>vs previous 7 days</span>
            </>
          ) : (
            <span>last 7 days</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card className="mt-6 min-w-0">
      <CardHeader
        title="Last 7 days"
        description="Performance of the posts you published"
        action={
          <Link to="/analytics?range=7d" className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
            Analytics <ArrowRight className="size-3.5" />
          </Link>
        }
      />
      {!s || !exp ? (
        <div className="grid gap-6 p-5 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : (
        <div className="grid gap-5 p-5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr]">
          {stat(METRIC_LABELS[exp.key], exp.value, s.previous[exp.key])}
          {stat("Engagements", s.totals.engagements, s.previous.engagements)}
          <div className="min-w-0 sm:col-span-2 lg:col-span-1">
            <p className="flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              <Trophy className="size-3.5" /> Top post
            </p>
            {t && t.metrics ? (
              <button
                type="button"
                onClick={() => openPost(t.id)}
                className="-mx-2 mt-1 flex w-[calc(100%+1rem)] min-w-0 items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                <ProviderLogo provider={providerMap.get(t.provider)} size="sm" className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.excerpt ? truncate(t.excerpt.replace(/\s+/g, " "), 90) : "Media post"}</span>
                  <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {(() => {
                      const k = exposureKey(t.metrics);
                      return [
                        k ? `${compactNumber(t.metrics[k] ?? 0)} ${METRIC_LABELS[k].toLowerCase()}` : null,
                        `${compactNumber(t.engagements)} engagements`,
                        t.engagementRate !== null ? `${percent(t.engagementRate)} rate` : null,
                        t.accountName,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                    })()}
                  </span>
                </span>
              </button>
            ) : (
              <p className="mt-1.5 text-sm text-zinc-400">{s.totals.posts ? "Metrics arrive about an hour after publishing." : "Nothing published this week."}</p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
