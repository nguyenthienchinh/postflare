import { list, str, type Parsed } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { parseSpan, parseTime } from "../dates.js";
import { UsageError } from "../errors.js";
import { c, fmtDate, fmtDelta, fmtNum, fmtPct, fmtStatus, println, printJson, table, truncate } from "../format.js";
import { resolveAccounts } from "../resolve.js";
import { exposure, type AnalyticsBreakdown, type AnalyticsPostDTO, type AnalyticsSummaryDTO } from "../types.js";
import { campaignNote, fmtMoney } from "./apps.js";

const RANGE_OPTIONS = {
  range: { type: "string", arg: "<span>", description: "Last 7d, 30d (default), 90d, 12h..." },
  from: { type: "string", arg: "<when>", description: "Start: \"2026-09-01\", \"14d\" (ago), ISO..." },
  to: { type: "string", arg: "<when>", description: "End (default now)" },
  account: { type: "string", short: "a", arg: "<selector>", description: "One account (id, @username, platform...)" },
  platform: { type: "string", arg: "<id>", description: "One platform, e.g. tiktok" },
} as const;

const SORTS = ["views", "engagements", "engagementRate", "publishedAt", "clicks", "installs", "downloads", "proceeds"];
/** CLI sort → server sort (installs is an alias of downloads, first-time App Store downloads). */
const SERVER_SORT: Record<string, string> = { installs: "downloads" };

/** Query of the analytics endpoints from the range/filter flags. */
async function rangeQuery(ctx: Ctx, values: Parsed["values"]) {
  const opt = { now: ctx.now, relativePast: true, defaultClock: [0, 0] as [number, number] };
  const now = ctx.now.getTime();
  const range = str(values.range);
  if (range && (str(values.from) || str(values.to))) throw new UsageError("Use either --range or --from/--to");
  const to = str(values.to) ? parseTime(str(values.to)!, opt) : now;
  const from = range ? to - parseSpan(range) : str(values.from) ? parseTime(str(values.from)!, opt) : to - 30 * 86_400_000;
  let accountId: string | undefined;
  if (str(values.account)) accountId = resolveAccounts(list(values.account), await ctx.accounts())[0].id;
  return {
    from,
    to,
    accountId,
    provider: str(values.platform),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

const views = (t: { views: number; impressions: number; reach: number }) => t.views || t.impressions || t.reach;

function kpis(s: AnalyticsSummaryDTO): string {
  const t = s.totals;
  const p = s.previous;
  const items: Array<[string, string, string]> = [["Posts", fmtNum(t.posts), fmtDelta(t.posts, p.posts)]];
  if (t.views || p.views) items.push(["Views", fmtNum(t.views), fmtDelta(t.views, p.views)]);
  if (t.impressions || p.impressions) items.push(["Impressions", fmtNum(t.impressions), fmtDelta(t.impressions, p.impressions)]);
  if (t.reach || p.reach) items.push(["Reach", fmtNum(t.reach), fmtDelta(t.reach, p.reach)]);
  items.push(["Engagements", fmtNum(t.engagements), fmtDelta(t.engagements, p.engagements)]);
  const rateDelta =
    t.engagementRate !== null && p.engagementRate !== null ? `${t.engagementRate >= p.engagementRate ? "+" : ""}${+((t.engagementRate - p.engagementRate) * 100).toFixed(2)} pts` : "";
  items.push(["Eng. rate", fmtPct(t.engagementRate), rateDelta ? (t.engagementRate! >= p.engagementRate! ? c.green(rateDelta) : c.red(rateDelta)) : ""]);
  if (t.followers !== null) items.push(["Followers", fmtNum(t.followers), t.followersChange !== null ? fmtDelta(t.followers, t.followers - t.followersChange) : ""]);
  if (t.campaignPosts) {
    items.push(["Clicks", fmtNum(t.clicks), fmtDelta(t.clicks, p.clicks)]);
    items.push(["Installs", fmtNum(t.downloads), fmtDelta(t.downloads, p.downloads)]);
    items.push(["Proceeds", fmtMoney(t.proceeds, s.currency), fmtDelta(t.proceeds, p.proceeds)]);
    items.push(["Proceeds/post", fmtMoney((t.proceeds ?? 0) / t.campaignPosts, s.currency), c.gray(`${fmtNum(t.campaignPosts)} posts with tracked links`)]);
  }
  return items.map(([k, v, d]) => `  ${k.padEnd(13)} ${c.bold(v.padStart(9))}  ${d}`).join("\n");
}

const hasCampaign = (rows: Array<{ campaignPosts?: number }>) => rows.some((r) => (r.campaignPosts ?? 0) > 0);

function breakdownTable(rows: AnalyticsBreakdown[], first: string, label: (r: AnalyticsBreakdown) => string, currency?: string | null) {
  const camp = hasCampaign(rows);
  return table(
    [
      { header: first, flex: true },
      { header: "POSTS", align: "right" },
      { header: "VIEWS", align: "right" },
      { header: "ENGAGEMENTS", align: "right" },
      { header: "RATE", align: "right" },
      { header: "FOLLOWERS", align: "right" },
      { header: "CHANGE", align: "right" },
      ...(camp ? [{ header: "CLICKS", align: "right" as const }, { header: "INSTALLS", align: "right" as const }, { header: "PROCEEDS", align: "right" as const }] : []),
    ],
    rows.map((r) => [
      label(r),
      fmtNum(r.posts),
      fmtNum(views(r)),
      fmtNum(r.engagements),
      fmtPct(r.engagementRate),
      fmtNum(r.followers),
      r.followersChange === null ? "" : `${r.followersChange >= 0 ? "+" : ""}${fmtNum(r.followersChange)}`,
      ...(camp ? (r.campaignPosts ? [fmtNum(r.clicks), fmtNum(r.downloads), fmtMoney(r.proceeds, currency)] : ["", "", ""]) : []),
    ]),
  );
}

function topTable(rows: AnalyticsPostDTO[]) {
  const camp = rows.some((p) => p.campaign);
  return table(
    [
      { header: "ID" },
      { header: "PUBLISHED" },
      { header: "ACCOUNT" },
      { header: "VIEWS", align: "right" },
      { header: "ENG", align: "right" },
      { header: "RATE", align: "right" },
      ...(camp ? [{ header: "CLICKS", align: "right" as const }, { header: "INSTALLS", align: "right" as const }, { header: "PROCEEDS", align: "right" as const }] : []),
      { header: "TEXT", flex: true },
      { header: "URL", flex: true },
    ],
    rows.map((p) => [
      p.id,
      fmtDate(p.publishedAt),
      `${p.provider} ${p.accountUsername ? `@${p.accountUsername.replace(/^@/, "")}` : p.accountName}`,
      p.metrics ? fmtNum(exposure(p.metrics)) : c.gray("n/a"),
      p.metrics ? fmtNum(p.engagements) : "",
      fmtPct(p.engagementRate),
      ...(camp ? (p.campaign ? [fmtNum(p.campaign.clicks), fmtNum(p.campaign.downloads), fmtMoney(p.campaign.proceeds, p.campaign.currency)] : ["", "", ""]) : []),
      truncate(p.excerpt, 50),
      p.externalUrl ?? "",
    ]),
  );
}

export const analytics: Command = {
  name: "analytics",
  summary: "Performance of the posts published in a range: KPIs vs the previous period, per platform/account, top posts.",
  description:
    "A post's metrics count for the day it was published. Engagements = likes + comments + shares + saves + replies +\n" +
    "reposts + quotes + clicks; rate = engagements / views (else impressions, else reach). Metrics are collected ~1h,\n" +
    "24h, 3d, 7d and 30d after publishing, then weekly up to 90 days. Posts with tracked App Store links (post --app) add\n" +
    "clicks, installs (first-time App Store downloads) and proceeds; Apple's numbers lag 2-3 days. Subcommands: top, refresh.",
  options: { ...RANGE_OPTIONS, top: { type: "string", arg: "<n>", description: "Top posts to show (default 5, 0 = none)" } },
  max: 0,
  examples: ["postflare analytics", "postflare analytics --range 7d --platform instagram_standalone", "postflare analytics --from 2026-09-01 --to 2026-10-01 --json"],
  async run(ctx, { values }) {
    const q = await rangeQuery(ctx, values);
    const topN = str(values.top) === undefined ? 5 : Math.min(Math.max(Number(str(values.top)) || 0, 0), 50);
    const [summary, top] = await Promise.all([
      ctx.api.get<AnalyticsSummaryDTO>("/analytics/summary", q),
      topN ? ctx.api.get<AnalyticsPostDTO[]>("/analytics/posts", { ...q, sort: "views", limit: topN }) : Promise.resolve([]),
    ]);
    if (ctx.json) return printJson({ summary, top });
    const days = Math.round((summary.to - summary.from) / 86_400_000);
    println(`${c.bold("Analytics")}  ${fmtDate(summary.from)} → ${fmtDate(summary.to)}  ${c.gray(`(${days}d, vs the previous ${days}d; tz ${summary.tz})`)}`);
    println(kpis(summary));
    if (summary.byProvider.length) {
      println("");
      println(breakdownTable(summary.byProvider, "PLATFORM", (r) => r.name, summary.currency));
    }
    if (summary.byAccount.length > 1) {
      println("");
      println(breakdownTable(summary.byAccount, "ACCOUNT", (r) => `${r.provider} ${r.username ? `@${r.username.replace(/^@/, "")}` : r.name}`, summary.currency));
    }
    if (top.length) {
      println(`\n${c.bold("Top posts")} ${c.gray("by views")}`);
      println(topTable(top));
    }
    if (summary.totals.campaignPosts || top.some((p) => p.campaign)) println(`\n${campaignNote()}`);
    if (!summary.totals.posts) println(c.gray("\nNo posts were published in this range."));
    else if (!summary.totals.postsWithMetrics) println(c.gray("\nNo metrics collected yet for these posts (first collection ~1h after publishing)."));
  },
};

export const analyticsTop: Command = {
  name: "analytics top",
  summary: "Published posts with their latest metrics, best first.",
  options: {
    ...RANGE_OPTIONS,
    sort: { type: "string", arg: "<by>", description: "views (default), engagements, engagementRate, publishedAt, clicks, installs, proceeds" },
    limit: { type: "string", arg: "<n>", description: "How many (default 10, max 200)" },
  },
  max: 0,
  examples: ["postflare analytics top --range 90d --sort engagementRate --limit 20", "postflare analytics top --sort installs --range 30d", "postflare analytics top --platform tiktok --json"],
  async run(ctx, { values }) {
    const sort = str(values.sort) ?? "views";
    if (!SORTS.includes(sort)) throw new UsageError(`--sort must be one of ${SORTS.join(", ")}`);
    const q = await rangeQuery(ctx, values);
    const rows = await ctx.api.get<AnalyticsPostDTO[]>("/analytics/posts", { ...q, sort: SERVER_SORT[sort] ?? sort, limit: Math.min(Number(str(values.limit)) || 10, 200) });
    if (ctx.json) return printJson(rows);
    if (!rows.length) return println("No published posts in this range.");
    println(topTable(rows));
    if (rows.some((p) => p.campaign)) println(campaignNote());
  },
};

export const analyticsRefresh: Command = {
  name: "analytics refresh",
  summary: "Collect metrics now for one published post or one account (followers + its due posts).",
  options: {
    post: { type: "string", arg: "<id>", description: "A published post" },
    account: { type: "string", short: "a", arg: "<selector>", description: "An account" },
  },
  max: 0,
  examples: ["postflare analytics refresh --post pst_abc", "postflare analytics refresh --account tiktok"],
  async run(ctx, { values }) {
    const postId = str(values.post);
    const sel = str(values.account);
    if (!!postId === !!sel) throw new UsageError("Give either --post <id> or --account <selector>", "analytics refresh");
    const body = postId ? { postId } : { accountId: resolveAccounts([sel!], await ctx.accounts())[0].id };
    const res = await ctx.api.post<{ post?: AnalyticsPostDTO; account?: { id: string; metricsStatus: { status: string; message: string | null; metrics: Record<string, unknown> | null }; postsRefreshed: number } }>(
      "/analytics/refresh",
      body,
    );
    if (ctx.json) return printJson(res);
    if (res.post) {
      println(`${c.green("✓")} Refreshed ${res.post.id}`);
      println(topTable([res.post]));
    } else if (res.account) {
      const ms = res.account.metricsStatus;
      println(`${c.green("✓")} ${res.account.id}: analytics ${fmtStatus(ms.status)}, ${res.account.postsRefreshed} posts refreshed`);
      if (ms.message) println(c.yellow(`  ${ms.message}`));
      if (ms.metrics) println("  " + Object.entries(ms.metrics).filter(([k]) => k !== "extra").map(([k, v]) => `${k} ${fmtNum(v as number)}`).join("  "));
    }
  },
};
