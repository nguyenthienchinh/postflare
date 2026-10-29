import { list, str, type Parsed } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { UsageError } from "../errors.js";
import { c, fmtNum, fmtPct, println, printJson, table, truncate } from "../format.js";
import { resolveAccounts } from "../resolve.js";
import type { PlaybookDTO, PlaybookStatsDTO, PlaybookStatsRow, PlaybookStatsSort, PlaybookSummaryDTO } from "../types.js";
import { campaignNote, fmtMoney } from "./apps.js";

const FILTERS = {
  platform: { type: "string", arg: "<id|group>", description: "Platform id (x, tiktok...) or group (short-video, microblog, professional, visual)" },
  goal: { type: "string", arg: "<goal>", description: "engagement, reach, clicks, followers or conversions" },
  format: { type: "string", arg: "<format>", description: "text, thread, image, carousel or video" },
} as const;

/** `id@version` → { id, version }. */
export function parsePlaybookRef(ref: string): { id: string; version?: number } {
  const m = /^([^@\s]+)(?:@(\d+))?$/.exec(ref.trim());
  if (!m) throw new UsageError(`--playbook ${ref}: use <id> or <id>@<version>`);
  return { id: m[1], ...(m[2] ? { version: Number(m[2]) } : {}) };
}

async function search(ctx: Ctx, values: Parsed["values"], q?: string) {
  const rows = await ctx.api.get<PlaybookSummaryDTO[]>("/playbooks", { q, platform: str(values.platform), goal: str(values.goal), format: str(values.format) });
  if (ctx.json) return printJson(rows);
  if (!rows.length) return println(q ? `No playbook matches "${q}".` : "No playbooks.");
  println(
    table(
      [{ header: "ID" }, { header: "GOAL" }, { header: "PLATFORMS", max: 34 }, { header: "NAME", flex: true }, { header: "SUMMARY", flex: true }],
      rows.map((p) => [p.builtin ? p.id : `${p.id} ${c.gray(`(${p.slug})`)}`, p.goal, p.platforms.join(","), p.builtin ? p.name : `${p.name} [custom v${p.version}]`, p.summary]),
    ),
  );
  println(c.gray("Show one: postflare playbooks show <id> --prompt"));
}

export const playbooks: Command = {
  name: "playbooks",
  args: "[query...]",
  summary: "List playbooks: reusable recipes for writing posts (built-in and this workspace's). Subcommands: search, show, stats.",
  description:
    "Before writing a post, find a playbook for the goal and platform, follow it (postflare playbooks show <id> --prompt)\n" +
    "and attribute the post to it (postflare post --playbook <id>@<version>), so `playbooks stats` can rank what works.",
  options: FILTERS,
  examples: ["postflare playbooks", "postflare playbooks --platform tiktok --goal reach", "postflare playbooks --format carousel --json"],
  run: (ctx, { values, positionals }) => search(ctx, values, positionals.join(" ") || undefined),
};

export const playbooksSearch: Command = {
  name: "playbooks search",
  args: "<query...>",
  summary: "Search playbooks by words (name, tags, summary, body), best match first.",
  options: FILTERS,
  min: 1,
  examples: ["postflare playbooks search game clip", "postflare playbooks search launch --platform x"],
  run: (ctx, { values, positionals }) => search(ctx, values, positionals.join(" ")),
};

export const playbooksShow: Command = {
  name: "playbooks show",
  args: "<id>",
  summary: "Show a playbook (Markdown), or with --prompt the ready-to-use agent prompt for this workspace.",
  options: {
    prompt: { type: "boolean", description: "Print the agent prompt (playbook + target accounts and limits + attribution)" },
    version: { type: "string", arg: "<n>", description: "A specific version (custom playbooks keep every version)" },
    account: { type: "string", short: "a", arg: "<selector>", description: "Target account for the prompt (default: all matching)" },
  },
  min: 1,
  max: 1,
  examples: ["postflare playbooks show launch-announcement", "postflare playbooks show game-clip-hook --prompt -a tiktok", "postflare playbooks show weekly-devlog@2"],
  async run(ctx, { values, positionals }) {
    const ref = parsePlaybookRef(positionals[0]);
    const version = str(values.version) ? Number(str(values.version)) : ref.version;
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new UsageError("--version must be a positive integer");
    const accountId = str(values.account) ? resolveAccounts(list(values.account), await ctx.accounts())[0].id : undefined;
    const p = await ctx.api.get<PlaybookDTO>(`/playbooks/${encodeURIComponent(ref.id)}`, { version, accountId });
    if (ctx.json) return printJson(p);
    if (values.prompt) return println(p.prompt);
    println(c.gray(`# ${p.id} v${p.version}${p.latestVersion !== p.version ? ` (latest v${p.latestVersion})` : ""}${p.builtin ? " · built-in" : " · custom"}${p.basedOn ? ` · based on ${p.basedOn}` : ""}`));
    println(p.markdown);
  },
};

const lift = (r: PlaybookStatsRow) => {
  if (r.lift === null) return c.gray("n/a");
  const pct = `${r.lift >= 0 ? "+" : ""}${Math.round(r.lift * 100)}%`;
  return r.confidence === "insufficient" ? c.gray(pct) : r.lift >= 0 ? c.green(`↑ ${pct}`) : c.red(`↓ ${pct}`);
};
const conf = (r: PlaybookStatsRow) => (r.confidence === "ok" ? c.green("ok") : r.confidence === "low" ? c.yellow("low") : c.gray("insufficient"));

/** --sort values → server values (installs = first-time App Store downloads, proceeds = Apple's revenue estimate). */
const STATS_SORTS: Record<string, PlaybookStatsSort> = {
  lift: "lift",
  installs: "downloads",
  proceeds: "proceeds",
  "installs-per-post": "downloadsPerPost",
  "proceeds-per-post": "proceedsPerPost",
  // Aliases (server names and "revenue").
  downloads: "downloads",
  revenue: "proceeds",
  downloadsPerPost: "downloadsPerPost",
  proceedsPerPost: "proceedsPerPost",
};

export const playbooksStats: Command = {
  name: "playbooks stats",
  summary: "Rank playbooks by performance: lift vs each account's usual, engagement rate, posts, confidence (A/B variants too).",
  description:
    "Lift = median over the playbook's posts of (post engagement rate ÷ the same account's median for posts without a playbook) − 1.\n" +
    "Confidence: insufficient < 5 posts, low 5–19, ok ≥ 20. Correlational: topics, timing and media differ between posts.\n" +
    "Posts with tracked App Store links (post --app) add INSTALLS and PROCEEDS: --sort installs|proceeds ranks by them.",
  options: {
    days: { type: "string", arg: "<n>", description: "Look-back window in days (default 90, max 366)" },
    platform: { type: "string", arg: "<id>", description: "One platform, e.g. tiktok" },
    account: { type: "string", short: "a", arg: "<selector>", description: "One account" },
    sort: { type: "string", arg: "<by>", description: "lift (default), installs, proceeds, installs-per-post, proceeds-per-post" },
  },
  max: 0,
  examples: ["postflare playbooks stats", "postflare playbooks stats --platform tiktok --days 30", "postflare playbooks stats --sort installs-per-post", "postflare playbooks stats -a @tempoapp --json"],
  async run(ctx, { values }) {
    const accountId = str(values.account) ? resolveAccounts(list(values.account), await ctx.accounts())[0].id : undefined;
    const rawSort = str(values.sort);
    const sort = rawSort === undefined ? undefined : STATS_SORTS[rawSort];
    if (rawSort !== undefined && !sort) throw new UsageError("--sort must be one of lift, installs, proceeds, installs-per-post, proceeds-per-post", "playbooks stats");
    const s = await ctx.api.get<PlaybookStatsDTO>("/playbooks/stats", { days: str(values.days), platform: str(values.platform), accountId, sort: sort === "lift" ? undefined : sort });
    if (ctx.json) return printJson(s);
    if (!s.postsAnalyzed) return println(`No published posts with metrics in the last ${s.days} days.`);
    const all = [s.baseline, ...s.playbooks.flatMap((p) => [p, ...p.variants, ...p.versions])];
    const camp = all.some((r) => (r.campaignPosts ?? 0) > 0);
    const perPost = sort === "downloadsPerPost" || sort === "proceedsPerPost";
    const money = (r: PlaybookStatsRow) => (r.campaignPosts ? fmtMoney(perPost ? r.proceedsPerPost : r.proceeds, s.currency) : "");
    const installs = (r: PlaybookStatsRow) => (r.campaignPosts ? (perPost ? (r.downloadsPerPost === null || r.downloadsPerPost === undefined ? "-" : String(+r.downloadsPerPost.toFixed(1))) : fmtNum(r.downloads)) : "");
    const cells = (r: PlaybookStatsRow, id: string, name: string) => [
      id,
      name,
      lift(r),
      fmtPct(r.medianEngagementRate),
      fmtNum(r.medianViews),
      String(r.posts),
      ...(camp ? [installs(r), money(r)] : []),
      conf(r),
    ];
    const rows: Array<Array<string>> = [];
    for (const p of s.playbooks) {
      rows.push(cells(p, p.playbookId ?? "", truncate(p.name, 40)));
      for (const v of p.variants) rows.push(cells(v, "", c.gray(`  variant ${v.variant ?? "(none)"}`)));
      if (p.versions.length > 1) for (const v of p.versions) rows.push(cells(v, "", c.gray(`  v${v.version}`)));
    }
    rows.push(cells(s.baseline, c.gray("—"), c.gray("No playbook (baseline)")));
    println(
      table(
        [
          { header: "ID" },
          { header: "PLAYBOOK" },
          { header: "LIFT", align: "right" },
          { header: "ENG. RATE", align: "right" },
          { header: "VIEWS", align: "right" },
          { header: "POSTS", align: "right" },
          ...(camp ? [{ header: perPost ? "INSTALLS/POST" : "INSTALLS", align: "right" as const }, { header: perPost ? "PROCEEDS/POST" : "PROCEEDS", align: "right" as const }] : []),
          { header: "CONFIDENCE" },
        ],
        rows,
      ),
    );
    println(c.gray(`${s.postsAnalyzed} posts in the last ${s.days} days${s.capped ? " (most recent only)" : ""}. Correlation, not causation: compare playbooks with enough posts.`));
    if (camp) println(campaignNote());
  },
};
