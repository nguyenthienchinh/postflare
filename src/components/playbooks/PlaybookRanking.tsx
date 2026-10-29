import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowDownRight, ArrowUpRight, ChevronRight, CircleHelp, Gauge, Info, Minus } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app";
import { cn, fullNumber, money, percent, plural } from "../../lib/format";
import { CONFIDENCE_LABEL, liftText } from "../../lib/playbooks";
import type { PlaybookConfidence, PlaybookStatsRow, PlaybookStatsSort } from "../../lib/types";
import { useFetch } from "../../lib/useFetch";
import { Num } from "../analytics/bits";
import { Select } from "../ui/Form";
import { Badge, Card, EmptyState, Skeleton } from "../ui/Misc";

const DAYS = [30, 90, 180, 365];
const SORTS: Array<{ value: PlaybookStatsSort; label: string }> = [
  { value: "lift", label: "Rank by engagement lift" },
  { value: "downloads", label: "Rank by installs" },
  { value: "proceeds", label: "Rank by revenue" },
  { value: "downloadsPerPost", label: "Rank by installs per post" },
  { value: "proceedsPerPost", label: "Rank by revenue per post" },
];

/** Confidence as a badge: icon + label (never color alone). */
export function ConfidenceBadge({ value, className }: { value: PlaybookConfidence; className?: string }) {
  const tone = value === "ok" ? "green" : value === "low" ? "amber" : "zinc";
  const Icon = value === "ok" ? Gauge : value === "low" ? CircleHelp : Minus;
  return (
    <Badge tone={tone} className={className} title={value === "ok" ? "20 posts or more" : value === "low" ? "5 to 19 posts" : "Fewer than 5 posts"}>
      <Icon className="size-3" aria-hidden />
      {CONFIDENCE_LABEL[value]}
    </Badge>
  );
}

/**
 * Lift as a diverging bar around the account baseline (0): right = above the account's usual, left = below. Polarity
 * uses the two delta tokens, always with an arrow and the signed value; rows with too few posts are drawn in the muted
 * mark color (emphasis on what can be trusted).
 */
export function LiftBar({ row, max }: { row: PlaybookStatsRow; max: number }) {
  const lift = row.lift;
  const muted = row.confidence === "insufficient";
  const width = lift === null || max <= 0 ? 0 : Math.max(Math.min(Math.abs(lift) / max, 1) * 50, lift === 0 ? 0 : 1.5);
  const color = muted ? "var(--viz-muted-mark)" : lift !== null && lift >= 0 ? "var(--viz-delta-up)" : "var(--viz-delta-down)";
  const Icon = lift === null || Math.round(lift * 100) === 0 ? Minus : lift > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="flex items-center gap-2.5" title={lift === null ? "No account baseline yet" : `${liftText(lift)} vs the account's usual (median of ${plural(row.liftPosts, "post")})`}>
      <div className="relative h-2 w-28 shrink-0" aria-hidden>
        <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--viz-axis)]" />
        {lift !== null && (
          <div
            className={cn("absolute inset-y-0", lift >= 0 ? "left-1/2 rounded-r-[4px]" : "right-1/2 rounded-l-[4px]")}
            style={{ width: `${width}%`, backgroundColor: color }}
          />
        )}
      </div>
      <span className={cn("inline-flex w-16 items-center gap-0.5 text-sm font-semibold tabular-nums", muted ? "text-zinc-400 dark:text-zinc-500" : "text-zinc-900 dark:text-zinc-100")}>
        <Icon className="size-3.5" aria-hidden style={muted || lift === null ? undefined : { color }} />
        {liftText(lift)}
      </span>
    </div>
  );
}

function Cells({ row, max, label, sub, campaigns, currency }: { row: PlaybookStatsRow; max: number; label: React.ReactNode; sub?: boolean; campaigns?: boolean; currency?: string | null }) {
  const none = <span className="text-zinc-400">–</span>;
  return (
    <>
      <td className={cn("py-2.5 pr-3", sub ? "pl-10" : "pl-5")}>{label}</td>
      <td className="px-3 py-2.5">
        <LiftBar row={row} max={max} />
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{row.medianEngagementRate === null ? <span className="text-zinc-400">–</span> : percent(row.medianEngagementRate, 2)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        <Num value={row.medianViews} />
      </td>
      {campaigns && (
        <>
          <td className="px-3 py-2.5 text-right tabular-nums" title={row.campaignPosts ? `${plural(row.campaignPosts, "tracked post")} · ${fullNumber(row.clicks)} clicks` : "No tracked App Store links"}>
            {row.campaignPosts ? fullNumber(row.downloads) : none}
          </td>
          <td className="px-3 py-2.5 text-right tabular-nums" title={row.proceedsPerPost !== null ? `${money(row.proceedsPerPost, currency)} per tracked post` : undefined}>
            {row.campaignPosts ? money(row.proceeds, currency) : none}
          </td>
        </>
      )}
      <td className="px-3 py-2.5 text-right tabular-nums">{row.posts}</td>
      <td className="hidden px-3 py-2.5 text-right tabular-nums md:table-cell">{row.accounts}</td>
      <td className="py-2.5 pl-3 pr-5">
        <ConfidenceBadge value={row.confidence} />
      </td>
    </>
  );
}

/**
 * The playbook ranking: lift vs each account's baseline, median engagement rate and views, posts and confidence,
 * with A/B variants and versions. Used on the Playbooks page and in Analytics (`compact`: top rows only).
 */
export function PlaybookRanking({ compact = false, initialDays = 90, accountId }: { compact?: boolean; initialDays?: number; accountId?: string }) {
  const { providers, accounts } = useApp();
  const [days, setDays] = useState(initialDays);
  const [platform, setPlatform] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sort, setSort] = useState<PlaybookStatsSort>("lift");
  const stats = useFetch(`playbook-stats:${days}:${platform}:${accountId ?? ""}:${sort}`, () => api.playbooks.stats({ days, platform: platform || undefined, accountId, sort }), ["posts", "analytics", "playbooks"]);
  const s = stats.data;
  // Installs / revenue columns once some ranked post has a tracked App Store link.
  const campaigns = !!s && [s.baseline, ...s.playbooks].some((r) => r.campaignPosts > 0);
  const cellProps = { campaigns, currency: s?.currency ?? null };
  const connected = useMemo(() => new Set(accounts.map((a) => a.provider)), [accounts]);
  const rows = s ? (compact ? s.playbooks.slice(0, 5) : s.playbooks) : [];
  const max = useMemo(() => {
    if (!s) return 1;
    const all = [s.baseline, ...s.playbooks, ...s.playbooks.flatMap((p) => [...p.variants, ...p.versions])];
    return Math.max(0.25, ...all.map((r) => Math.abs(r.lift ?? 0)));
  }, [s]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Playbook ranking</h2>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">Engagement of posts written with each playbook, compared with the same account's usual.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(campaigns || sort !== "lift") && (
            <Select value={sort} onChange={(e) => setSort(e.target.value as PlaybookStatsSort)} className="w-52" aria-label="Rank by">
              {SORTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-40" aria-label="Platform">
            <option value="">All platforms</option>
            {providers
              .filter((p) => connected.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-36" aria-label="Period">
            {DAYS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </Select>
        </div>
      </div>

      {!s ? (
        <div className="space-y-3 p-5">
          {Array.from({ length: compact ? 3 : 6 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : !s.playbooks.length ? (
        <EmptyState
          icon={<Gauge />}
          title="No posts written with a playbook yet"
          description={
            s.postsAnalyzed
              ? `${plural(s.postsAnalyzed, "published post")} with metrics, none attributed to a playbook. Pick a playbook in the composer, or ask your agent to pass playbookId.`
              : "Once posts written with a playbook are published and their metrics collected, they are ranked here."
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="py-2.5 pl-5 pr-3 font-medium">Playbook</th>
                <th className="px-3 py-2.5 font-medium">Lift vs account usual</th>
                <th className="px-3 py-2.5 text-right font-medium">Eng. rate</th>
                <th className="px-3 py-2.5 text-right font-medium">Views</th>
                {campaigns && (
                  <>
                    <th className="px-3 py-2.5 text-right font-medium">Installs</th>
                    <th className="px-3 py-2.5 text-right font-medium">Proceeds</th>
                  </>
                )}
                <th className="px-3 py-2.5 text-right font-medium">Posts</th>
                <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Accounts</th>
                <th className="py-2.5 pl-3 pr-5 font-medium">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((p) => {
                const key = p.playbookId!;
                const subs = [...p.variants.map((v) => ({ row: v, label: `Variant ${v.variant ?? "(none)"}` })), ...(p.versions.length > 1 ? p.versions.map((v) => ({ row: v, label: `Version ${v.version}` })) : [])];
                const expanded = !!open[key];
                return (
                  <Fragment key={key}>
                    <tr className="hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30">
                      <Cells
                        {...cellProps}
                        row={p}
                        max={max}
                        label={
                          <div className="flex items-center gap-1.5">
                            {subs.length > 0 && !compact ? (
                              <button
                                type="button"
                                onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
                                className="-ml-1 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                                aria-expanded={expanded}
                                aria-label={expanded ? "Hide variants" : "Show variants"}
                              >
                                <ChevronRight className={cn("size-4 transition", expanded && "rotate-90")} />
                              </button>
                            ) : (
                              !compact && <span className="w-4" />
                            )}
                            <Link to={`/playbooks/${encodeURIComponent(key)}`} className="truncate font-medium text-zinc-900 hover:text-brand-600 dark:text-zinc-100 dark:hover:text-brand-400">
                              {p.name}
                            </Link>
                            {!p.builtin && <Badge tone="violet">Custom</Badge>}
                            {p.variants.length > 0 && <span className="text-xs text-zinc-400">A/B</span>}
                          </div>
                        }
                      />
                    </tr>
                    {expanded &&
                      subs.map((sub) => (
                        <tr key={sub.label} className="bg-zinc-50/50 dark:bg-zinc-900/40">
                          <Cells {...cellProps} row={sub.row} max={max} sub label={<span className="text-zinc-600 dark:text-zinc-400">{sub.label}</span>} />
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
              <tr className="bg-zinc-50/70 dark:bg-zinc-900/50">
                <Cells {...cellProps} row={s.baseline} max={max} label={<span className="text-zinc-600 dark:text-zinc-400">No playbook (baseline)</span>} />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {s && s.playbooks.length > 0 && (
        <div className="flex items-start gap-2 border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <p>
            Correlation, not causation: topics, timing and media differ between posts. Lift = median over the playbook's posts of (engagement rate ÷ the same
            account's median for posts without a playbook) − 1. {plural(s.postsAnalyzed, "post")} with metrics in the last {s.days} days
            {s.capped ? " (the most recent ones)" : ""}.
            {campaigns && " Installs and proceeds: Apple App Analytics for the posts' tracked links (via Revflare), 2–3 days delay, small numbers withheld."}
            {compact && s.playbooks.length > rows.length && (
              <>
                {" "}
                <Link to="/playbooks?tab=ranking" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                  See all {s.playbooks.length} playbooks
                </Link>
              </>
            )}
          </p>
        </div>
      )}
    </Card>
  );
}
