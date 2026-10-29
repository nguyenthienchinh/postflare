// Playbooks: reusable, versioned recipes that help AI agents (and humans) write posts. Postflare runs no LLM: it
// stores the recipes, hands them to the user's agent (REST, MCP, CLI) and measures how the posts written with them
// perform (posts.playbook_id / playbook_version / variant → GET /api/playbooks/stats).
//
// Built-ins are the Markdown files in playbooks/ (bundled at build time, read-only, validated by test/playbooks.test.ts).
// Custom playbooks live in D1 (migrations/0008): `playbooks` holds the head (latest version) and `playbook_versions`
// every version ever saved; versions are immutable, an edit inserts a new one.

import type {
  PlaybookConfidence,
  PlaybookDTO,
  PlaybookFormat,
  PlaybookGoal,
  PlaybookInput,
  PlaybookStatsDTO,
  PlaybookStatsRow,
  PlaybookStatsSort,
  PlaybookSummaryDTO,
} from "../../shared/types";
import { PLATFORM_GROUPS, PLAYBOOK_FORMATS, PLAYBOOK_GOALS, SLUG_RE, checklistOf, matchesPlatform, parsePlaybook, serializePlaybook } from "../../shared/playbooks";
import { getProvider } from "../providers/registry";
import { campaignResults } from "./campaigns";
import { parseJson } from "./util";

const files = import.meta.glob("../../playbooks/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export interface Playbook {
  id: string;
  slug: string;
  version: number;
  latestVersion: number;
  name: string;
  summary: string;
  goal: PlaybookGoal;
  platforms: string[];
  formats: PlaybookFormat[];
  tags: string[];
  inputs: string[];
  body: string;
  builtin: boolean;
  basedOn: string | null;
  archived: boolean;
  updatedAt: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Built-ins

let builtins: { list: Playbook[]; byId: Map<string, Playbook>; errors: Array<{ file: string; errors: string[] }>; text: Map<string, string> } | null = null;

/** Parsed once per isolate. Invalid files are left out (and reported by `builtinErrors`, which a test checks). */
function loadBuiltins() {
  if (builtins) return builtins;
  const list: Playbook[] = [];
  const errors: Array<{ file: string; errors: string[] }> = [];
  for (const [path, md] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.split("/").pop()!;
    const { meta, body, errors: e } = parsePlaybook(md, true);
    if (meta.id && file !== `${meta.id}.md`) e.push(`file name must be ${meta.id}.md`);
    if (list.some((p) => p.id === meta.id)) e.push(`duplicate id ${meta.id}`);
    if (e.length) {
      errors.push({ file, errors: e });
      continue;
    }
    list.push({ ...meta, slug: meta.id, latestVersion: meta.version, body, builtin: true, basedOn: null, archived: false, updatedAt: null });
  }
  builtins = { list, byId: new Map(list.map((p) => [p.id, p])), errors, text: new Map(list.map((p) => [p.id, searchText(p)])) };
  return builtins;
}

export const builtinPlaybooks = (): Playbook[] => loadBuiltins().list;
export const builtinErrors = () => loadBuiltins().errors;
export const getBuiltin = (id: string): Playbook | undefined => loadBuiltins().byId.get(id);

// ---------------------------------------------------------------------------------------------------------------
// Custom playbooks (D1)

export interface PlaybookRow {
  id: string;
  workspace_id: string;
  slug: string;
  version: number;
  name: string;
  summary: string;
  goal: string;
  platforms: string;
  formats: string;
  tags: string;
  inputs: string;
  body: string;
  based_on: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
}

export function rowToPlaybook(r: PlaybookRow, latest = r.version): Playbook {
  return {
    id: r.id,
    slug: r.slug,
    version: r.version,
    latestVersion: latest,
    name: r.name,
    summary: r.summary,
    goal: r.goal as PlaybookGoal,
    platforms: parseJson<string[]>(r.platforms, []),
    formats: parseJson<PlaybookFormat[]>(r.formats, []),
    tags: parseJson<string[]>(r.tags, []),
    inputs: parseJson<string[]>(r.inputs, []),
    body: r.body,
    builtin: false,
    basedOn: r.based_on,
    archived: !!r.archived,
    updatedAt: r.updated_at,
  };
}

/** Non-archived custom playbooks of a workspace (one query). */
export async function listCustom(db: D1Database, workspaceId: string, includeArchived = false): Promise<Playbook[]> {
  const { results } = await db
    .prepare(`SELECT * FROM playbooks WHERE workspace_id = ?${includeArchived ? "" : " AND archived = 0"} ORDER BY name LIMIT 500`)
    .bind(workspaceId)
    .all<PlaybookRow>();
  return results.map((r) => rowToPlaybook(r));
}

/**
 * A playbook by built-in id, custom id or custom slug (custom ones only in `workspaceId`; others → null), at
 * `version` (default: latest). Built-ins have only their bundled version. At most one query.
 */
export async function findPlaybook(db: D1Database, workspaceId: string, ref: string, version?: number | null): Promise<Playbook | null> {
  const builtin = getBuiltin(ref);
  if (builtin) return version == null || version === builtin.version ? builtin : null;
  const row = await db
    .prepare(
      `SELECT h.id, h.workspace_id, h.slug, v.version, v.name, v.summary, v.goal, v.platforms, v.formats, v.tags, v.inputs, v.body, h.based_on,
         v.created_by, h.created_at, h.updated_at, h.archived, h.version AS latest
       FROM playbooks h JOIN playbook_versions v ON v.playbook_id = h.id AND v.version = COALESCE(?, h.version)
       WHERE h.workspace_id = ? AND (h.id = ? OR h.slug = ?)`,
    )
    .bind(version ?? null, workspaceId, ref, ref)
    .first<PlaybookRow & { latest: number }>();
  return row ? rowToPlaybook(row, row.latest) : null;
}

/**
 * Checks a playbook reference for post attribution: the playbook exists (built-in, or custom in this workspace and
 * not archived) and the version too (built-ins: 1..bundled version). Returns the canonical id and version.
 */
export async function resolveAttribution(
  db: D1Database,
  workspaceId: string,
  ref: string,
  version: number | null | undefined,
): Promise<{ id: string; version: number } | { error: string }> {
  if (version != null && (!Number.isInteger(version) || version < 1)) return { error: "playbookVersion must be a positive integer" };
  const builtin = getBuiltin(ref);
  if (builtin) {
    if (version != null && version > builtin.version) return { error: `Playbook ${ref} has no version ${version}` };
    return { id: builtin.id, version: version ?? builtin.version };
  }
  const row = await db
    .prepare(
      `SELECT h.id, h.version, h.archived, (SELECT 1 FROM playbook_versions v WHERE v.playbook_id = h.id AND v.version = ?) AS has_version
       FROM playbooks h WHERE h.workspace_id = ? AND (h.id = ? OR h.slug = ?)`,
    )
    .bind(version ?? null, workspaceId, ref, ref)
    .first<{ id: string; version: number; archived: number; has_version: number | null }>();
  if (!row) return { error: `Playbook ${ref} not found` };
  if (row.archived) return { error: `Playbook ${ref} is archived` };
  if (version != null && !row.has_version) return { error: `Playbook ${ref} has no version ${version}` };
  return { id: row.id, version: version ?? row.version };
}

/** A/B label: trimmed, at most 32 characters, null when empty. */
export function normalizeVariant(v: unknown): string | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return { error: "variant must be a string" };
  const s = v.trim();
  if (!s) return null;
  if (s.length > 32) return { error: "variant is longer than 32 characters" };
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Input validation (POST / PATCH)

export interface PlaybookFields {
  slug: string;
  name: string;
  summary: string;
  goal: PlaybookGoal;
  platforms: string[];
  formats: PlaybookFormat[];
  tags: string[];
  inputs: string[];
  body: string;
}

const MAX_BODY = 50_000;

/** Cleans a list: strings only, trimmed, no commas (they separate frontmatter list items), unique, capped. */
function cleanList(v: unknown, max: number, lower = false): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    let s = x.replace(/,/g, ";").replace(/[\r\n[\]]/g, " ").trim().slice(0, 120);
    if (lower) s = s.toLowerCase();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "playbook";

/**
 * Merges an input (fields and/or a `markdown` file) over `base` (the current version for PATCH) and validates it.
 */
export function validatePlaybookInput(input: PlaybookInput, base?: PlaybookFields): { fields: PlaybookFields } | { errors: string[] } {
  const errors: string[] = [];
  let fromFile: Partial<PlaybookFields> = {};
  if (typeof input.markdown === "string" && input.markdown.trim()) {
    const parsed = parsePlaybook(input.markdown, false);
    const m = parsed.meta;
    fromFile = {
      ...(m.id ? { slug: m.id } : {}),
      ...(m.name ? { name: m.name } : {}),
      summary: m.summary,
      ...(m.goal ? { goal: m.goal } : {}),
      platforms: m.platforms,
      formats: m.formats,
      tags: m.tags,
      inputs: m.inputs,
      body: parsed.body,
    };
  }
  const pick = <K extends keyof PlaybookFields>(k: K, v: PlaybookFields[K] | null | undefined): PlaybookFields[K] | undefined =>
    v !== undefined && v !== null ? v : (fromFile[k] ?? base?.[k]);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const name = pick("name", str(input.name)) ?? "";
  const fields: PlaybookFields = {
    name,
    slug: pick("slug", str(input.slug)) ?? slugify(name),
    summary: pick("summary", str(input.summary)) ?? "",
    goal: pick("goal", str(input.goal) as PlaybookGoal | undefined) ?? ("engagement" as PlaybookGoal),
    platforms: pick("platforms", cleanList(input.platforms, 30)) ?? [],
    formats: pick("formats", cleanList(input.formats, 5, true) as PlaybookFormat[] | null) ?? [],
    tags: pick("tags", cleanList(input.tags, 20, true)) ?? [],
    inputs: pick("inputs", cleanList(input.inputs, 20)) ?? [],
    body: (typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim() : undefined) ?? fromFile.body ?? base?.body ?? "",
  };
  if (!fields.name) errors.push("name is required");
  if (fields.name.length > 80) errors.push("name is longer than 80 characters");
  if (/[\r\n]/.test(fields.name) || /[\r\n]/.test(fields.summary)) errors.push("name and summary must be one line");
  if (fields.summary.length > 300) errors.push("summary is longer than 300 characters");
  if (!SLUG_RE.test(fields.slug) || fields.slug.length > 60) errors.push("slug must be kebab-case (a-z, 0-9 and dashes), at most 60 characters");
  if (getBuiltin(fields.slug)) errors.push(`slug "${fields.slug}" is the id of a built-in playbook`);
  if (!PLAYBOOK_GOALS.includes(fields.goal)) errors.push(`goal must be one of ${PLAYBOOK_GOALS.join(", ")}`);
  for (const f of fields.formats) if (!PLAYBOOK_FORMATS.includes(f)) errors.push(`unknown format "${f}" (${PLAYBOOK_FORMATS.join(", ")})`);
  for (const p of fields.platforms) if (!PLATFORM_GROUPS[p] && !getProvider(p)) errors.push(`unknown platform "${p}"`);
  if (!fields.body) errors.push("body is required");
  if (fields.body.length > MAX_BODY) errors.push(`body is longer than ${MAX_BODY} characters`);
  return errors.length ? { errors } : { fields };
}

// ---------------------------------------------------------------------------------------------------------------
// Search

export interface PlaybookFilters {
  q?: string;
  platform?: string;
  goal?: string;
  format?: string;
  tag?: string;
}

function searchText(p: Playbook) {
  return `${p.body}\n${p.inputs.join(" ")}`.toLowerCase();
}

const tokenize = (q: string) => [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))].slice(0, 8);

/**
 * Filters and ranks playbooks. Score per query token: name (6, +2 at a word start), id/slug (4), tag (5 exact, 3
 * partial), summary (3), goal/platforms/formats (2), body (1). Every token must match somewhere. Cheap: a few
 * `includes` per playbook (built-in texts are lower-cased once per isolate).
 */
export function searchPlaybooks(list: Playbook[], f: PlaybookFilters): Array<Playbook & { score: number }> {
  const tokens = tokenize(f.q ?? "");
  const cached = loadBuiltins().text;
  const out: Array<Playbook & { score: number }> = [];
  for (const p of list) {
    if (f.goal && p.goal !== f.goal) continue;
    if (f.format && !p.formats.includes(f.format as PlaybookFormat)) continue;
    if (f.platform && !matchesPlatform(p.platforms, f.platform)) continue;
    if (f.tag && !p.tags.includes(f.tag.toLowerCase())) continue;
    let score = 0;
    if (tokens.length) {
      const name = p.name.toLowerCase();
      const summary = p.summary.toLowerCase();
      const meta = `${p.goal} ${p.platforms.join(" ")} ${p.formats.join(" ")}`.toLowerCase();
      const body = (p.builtin && cached.get(p.id)) || searchText(p);
      let all = true;
      for (const t of tokens) {
        let s = 0;
        if (name.includes(t)) s += new RegExp(`(^|[^a-z0-9])${t}`).test(name) ? 8 : 6;
        if (p.slug.includes(t)) s += 4;
        if (p.tags.includes(t)) s += 5;
        else if (p.tags.some((x) => x.includes(t))) s += 3;
        if (summary.includes(t)) s += 3;
        if (meta.includes(t)) s += 2;
        if (body.includes(t)) s += 1;
        if (!s) all = false;
        score += s;
      }
      if (!all) continue;
    }
    out.push({ ...p, score });
  }
  return out.sort((a, b) => b.score - a.score || Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------------------------
// DTOs and the agent prompt

export function summaryDto(p: Playbook, score?: number): PlaybookSummaryDTO {
  return {
    id: p.id,
    slug: p.slug,
    version: p.latestVersion,
    name: p.name,
    summary: p.summary,
    goal: p.goal,
    platforms: p.platforms,
    formats: p.formats,
    tags: p.tags,
    inputs: p.inputs,
    builtin: p.builtin,
    basedOn: p.basedOn,
    archived: p.archived,
    updatedAt: p.updatedAt,
    ...(score !== undefined ? { score } : {}),
  };
}

export function playbookMarkdown(p: Pick<Playbook, "slug" | "version" | "name" | "summary" | "goal" | "platforms" | "formats" | "tags" | "inputs" | "body">): string {
  return serializePlaybook({ id: p.slug, version: p.version, name: p.name, summary: p.summary, goal: p.goal, platforms: p.platforms, formats: p.formats, tags: p.tags, inputs: p.inputs }, p.body);
}

export interface PromptAccount {
  id: string;
  provider: string;
  name: string;
  username: string | null;
}

const groupLabel = (p: string) => PLATFORM_GROUPS[p]?.label ?? getProvider(p)?.name ?? p;

/** One line of limits for an account's platform (from the provider's capabilities). */
function limitsLine(a: PromptAccount): string | null {
  const provider = getProvider(a.provider);
  if (!provider) return null;
  const c = provider.capabilities;
  const media = [
    c.media.images ? `up to ${c.media.images} image${c.media.images > 1 ? "s" : ""}` : "no images",
    c.media.videos ? `up to ${c.media.videos} video${c.media.videos > 1 ? "s" : ""}` : "no video",
    c.media.required ? "media required" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const text = c.text === "none" ? "no text" : `text ${c.text}, max ${c.maxLength.toLocaleString("en-US")} characters${a.provider === "x" ? " (280 without X Premium; a URL counts as 23)" : ""}`;
  const follow = c.thread ? `follow-ups: ${c.threadLabel ?? "thread replies"} (use them for links where the playbook says so)` : "no follow-ups";
  const handle = a.username ? ` (@${a.username.replace(/^@/, "")})` : "";
  return `- ${a.name}${handle} — ${provider.name}, account id \`${a.id}\`: ${text}; ${media}; ${follow}.`;
}

/**
 * The ready-to-use prompt for an AI agent: the playbook itself, the target accounts of this workspace with their
 * platform limits, and how to attribute the post. Plain text (Markdown), no LLM involved.
 */
export function agentPrompt(p: Playbook, accounts: PromptAccount[] | null): string {
  const lines: string[] = [];
  lines.push(`You are writing social media posts with the Postflare playbook "${p.name}" (playbookId: ${p.id}, version ${p.version}). Follow it closely: its structure, platform notes, hooks and checklist.`);
  lines.push("");
  lines.push(`Goal: ${p.goal}. Platforms: ${p.platforms.map(groupLabel).join(", ") || "any"}. Formats: ${p.formats.join(", ") || "any"}.`);
  if (p.summary) lines.push(`In one line: ${p.summary}`);
  if (p.inputs.length) {
    lines.push("");
    lines.push("Before writing, make sure you know the following (ask the user for anything missing; never invent facts, numbers, quotes or reviews):");
    for (const i of p.inputs) lines.push(`- ${i}`);
  }
  lines.push("");
  lines.push("<playbook>");
  lines.push(p.body.trim());
  lines.push("</playbook>");
  if (accounts) {
    const relevant = accounts.filter((a) => matchesPlatform(p.platforms, a.provider));
    lines.push("");
    lines.push("## Target accounts in this workspace");
    if (!accounts.length) lines.push("No accounts are connected yet: write the posts, then ask the user to connect an account in Postflare.");
    else if (!relevant.length) lines.push("None of the connected accounts is on this playbook's platforms. Adapt the playbook carefully or pick another one (search_playbooks).");
    for (const a of relevant.length ? relevant : []) {
      const l = limitsLine(a);
      if (l) lines.push(l);
    }
    if (relevant.length) lines.push("Write a version per platform (never paste one caption everywhere): respect each limit above. Platform-specific settings: list_platforms / `pf platforms`.");
  }
  lines.push("");
  lines.push("## When you create the post");
  lines.push(
    `Attribute it to this playbook so Postflare can measure what works: pass playbookId "${p.id}" and playbookVersion ${p.version} ` +
      `(MCP create_post: playbookId/playbookVersion; CLI: \`pf post --playbook ${p.id}@${p.version}\`; REST: playbookId/playbookVersion in POST /api/posts). ` +
      `When you write two versions to compare, create them as separate posts with variant "A" and "B".`,
  );
  lines.push("Before scheduling, run the playbook's checklist and show the user the final text.");
  return lines.join("\n");
}

export function playbookDto(p: Playbook, accounts: PromptAccount[] | null): PlaybookDTO {
  return {
    ...summaryDto(p),
    version: p.version,
    latestVersion: p.latestVersion,
    versions: p.builtin ? [p.version] : Array.from({ length: p.latestVersion }, (_, i) => i + 1),
    body: p.body,
    markdown: playbookMarkdown(p),
    checklist: checklistOf(p.body),
    prompt: agentPrompt(p, accounts),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Stats (GET /api/playbooks/stats): pure computation over one query's rows.

export interface StatsPostRow {
  account_id: string;
  playbook_id: string | null;
  playbook_version: number | null;
  variant: string | null;
  /** Engagements (computed by D1). */
  eng: number;
  /** Exposure: views, else impressions, else reach (null when the platform reports none). */
  exp: number | null;
  /** Tracked App Store link results (lib/campaigns.ts CAMPAIGN_RESULT_COLUMNS), absent without a link. */
  campaign_clicks?: number | null;
  campaign_stats?: string | null;
}

/** Posts analyzed at most (the most recent ones in the range). */
export const STATS_MAX_POSTS = 2000;
/** An account needs this many posts without a playbook to use them as its baseline (else: all its posts). */
export const MIN_BASELINE_POSTS = 3;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function confidence(posts: number): PlaybookConfidence {
  return posts < 5 ? "insufficient" : posts < 20 ? "low" : "ok";
}

export const STATS_METHOD =
  "For every published post with metrics in the range, its engagement rate (engagements ÷ views, else impressions, else reach; " +
  "engagements for platforms reporting no exposure) is divided by the median of the same account's posts written without a playbook " +
  `(all of the account's posts when it has fewer than ${MIN_BASELINE_POSTS} such posts). Lift = median of these ratios − 1. ` +
  "Confidence: insufficient < 5 posts, low 5–19, ok ≥ 20. Installs and revenue: App Store downloads and proceeds of the posts' tracked links " +
  "(Apple App Analytics via Revflare; small numbers are withheld, 2–3 days delay), per tracked post. This is a correlation: topics, timing and media differ between posts.";

export const STATS_SORTS: PlaybookStatsSort[] = ["lift", "downloads", "proceeds", "downloadsPerPost", "proceedsPerPost"];

/**
 * Per-post lift against the account's baseline, then per-group aggregates. O(n log n) over at most STATS_MAX_POSTS
 * rows: one pass to group by account, one sort per account for its median, one per group for the aggregates.
 */
export function computePlaybookStats(
  rows: StatsPostRow[],
  info: (id: string) => { name: string; builtin: boolean },
  sort: PlaybookStatsSort = "lift",
): Pick<PlaybookStatsDTO, "baseline" | "playbooks" | "postsAnalyzed" | "currency"> {
  // Tracked link results per post (parsed once).
  const campaign = new Map<StatsPostRow, NonNullable<ReturnType<typeof campaignResults>>>();
  let currency: string | null = null;
  for (const r of rows) {
    const c = campaignResults(r);
    if (!c) continue;
    campaign.set(r, c);
    if (c.currency) currency ??= c.currency;
  }
  // 1. Account baselines.
  const byAccount = new Map<string, StatsPostRow[]>();
  for (const r of rows) {
    const list = byAccount.get(r.account_id);
    if (list) list.push(r);
    else byAccount.set(r.account_id, [r]);
  }
  const lift = new Map<StatsPostRow, number>();
  for (const posts of byAccount.values()) {
    // Engagement rate when most of the account's posts report an exposure, else raw engagements.
    const useRate = posts.filter((p) => p.exp && p.exp > 0).length * 2 >= posts.length;
    const value = (p: StatsPostRow) => (useRate ? (p.exp && p.exp > 0 ? p.eng / p.exp : null) : p.eng);
    const without = posts.filter((p) => !p.playbook_id).map(value).filter((v): v is number => v !== null);
    const pool = without.length >= MIN_BASELINE_POSTS ? without : posts.map(value).filter((v): v is number => v !== null);
    const base = median(pool);
    if (!base || base <= 0) continue;
    for (const p of posts) {
      const v = value(p);
      if (v !== null) lift.set(p, v / base);
    }
  }

  // 2. Aggregates.
  const aggregate = (posts: StatsPostRow[], key: Pick<PlaybookStatsRow, "playbookId" | "name" | "builtin"> & { version?: number | null; variant?: string | null }): PlaybookStatsRow => {
    const rates: number[] = [];
    const views: number[] = [];
    const lifts: number[] = [];
    const accounts = new Set<string>();
    let campaignPosts = 0;
    let clicks = 0;
    let downloads = 0;
    let proceeds = 0;
    for (const p of posts) {
      accounts.add(p.account_id);
      const c = campaign.get(p);
      if (c) {
        campaignPosts++;
        clicks += c.clicks;
        downloads += c.downloads ?? 0;
        proceeds += c.proceeds ?? 0;
      }
      if (p.exp && p.exp > 0) {
        rates.push(p.eng / p.exp);
        views.push(p.exp);
      }
      const l = lift.get(p);
      if (l !== undefined) lifts.push(l);
    }
    const m = median(lifts);
    return {
      ...key,
      posts: posts.length,
      accounts: accounts.size,
      medianEngagementRate: median(rates),
      meanEngagementRate: mean(rates),
      medianViews: median(views),
      lift: m === null ? null : m - 1,
      liftPosts: lifts.length,
      confidence: confidence(posts.length),
      campaignPosts,
      clicks,
      downloads,
      proceeds: Math.round(proceeds * 100) / 100,
      downloadsPerPost: campaignPosts ? downloads / campaignPosts : null,
      proceedsPerPost: campaignPosts ? Math.round((proceeds / campaignPosts) * 100) / 100 : null,
    };
  };

  const groups = new Map<string, StatsPostRow[]>();
  const none: StatsPostRow[] = [];
  for (const r of rows) {
    if (!r.playbook_id) none.push(r);
    else {
      const list = groups.get(r.playbook_id);
      if (list) list.push(r);
      else groups.set(r.playbook_id, [r]);
    }
  }
  const rank: Record<PlaybookConfidence, number> = { ok: 0, low: 0, insufficient: 1 };
  const playbooks = [...groups].map(([id, posts]) => {
    const { name, builtin } = info(id);
    const sub = <K extends "playbook_version" | "variant">(k: K) => {
      const m = new Map<StatsPostRow[K], StatsPostRow[]>();
      for (const p of posts) {
        const list = m.get(p[k]);
        if (list) list.push(p);
        else m.set(p[k], [p]);
      }
      return m;
    };
    const versions = [...sub("playbook_version")]
      .map(([v, ps]) => aggregate(ps, { playbookId: id, name, builtin, version: v }))
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    const variantMap = sub("variant");
    // Variants only when at least one post has a label.
    const variants = [...variantMap.keys()].some((v) => v !== null)
      ? [...variantMap].map(([v, ps]) => aggregate(ps, { playbookId: id, name, builtin, variant: v })).sort((a, b) => String(a.variant ?? "~").localeCompare(String(b.variant ?? "~")))
      : [];
    return { ...aggregate(posts, { playbookId: id, name, builtin }), versions, variants };
  });
  const byLift = (a: PlaybookStatsRow, b: PlaybookStatsRow) => rank[a.confidence] - rank[b.confidence] || (b.lift ?? -Infinity) - (a.lift ?? -Infinity) || b.posts - a.posts;
  const key = sort === "lift" ? null : sort;
  // Installs / revenue: playbooks with tracked posts first, then by the value (lift breaks ties).
  playbooks.sort(key ? (a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity) || byLift(a, b) : byLift);
  return { postsAnalyzed: rows.length, baseline: aggregate(none, { playbookId: null, name: "No playbook", builtin: false }), playbooks, currency };
}
