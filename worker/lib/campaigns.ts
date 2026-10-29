// App Store campaign links (see shared/campaigns.ts for the token and link rules).
//
// Where the rewrite happens: when a post is created or updated (POST /api/posts, PATCH /api/posts/:id), not at publish
// time. The user (or agent) sees the final text in the post, validation runs on exactly what will be published, and
// the publish workflow (worker/workflow.ts: commit / needs_check semantics, step names) is untouched: publishing a
// post with a tracked link costs no extra D1 query.
//
// Data: `campaign_links` (one row per post on a clickable platform, one per account + app for bio links),
// `campaign_clicks` (one counter per link and UTC day, one upsert per counted click on GET /a/<code>) and
// `campaign_stats` (Apple App Analytics per campaign token, synced from Revflare by worker/lib/revflare.ts).

import type { AppDTO, CampaignLinkDTO, CampaignResultsDTO, ThreadItem } from "../../shared/types";
import {
  BIO_LINK_PLATFORMS,
  HAS_URL_RE,
  appStoreCampaignUrl,
  bioCampaignToken,
  findAppStoreUrls,
  isClickable,
  newLinkCode,
  postCampaignToken,
} from "../../shared/campaigns";
import type { Provider } from "../providers/types";
import { URL_RE, xWeightedLength } from "../providers/x";
import { utcDay } from "./usage";
import { now, parseJson } from "./util";
import { textLength } from "./validate";

// ---------------------------------------------------------------------------------------------------------------
// Rows and DTOs

export interface AppRow {
  id: string;
  workspace_id: string;
  app_store_id: string;
  name: string;
  icon_url: string | null;
  revflare_app_id: string | null;
  created_at: number;
}

export function appDto(r: AppRow): AppDTO {
  return { id: r.id, appStoreId: r.app_store_id, name: r.name, iconUrl: r.icon_url, revflareAppId: r.revflare_app_id, createdAt: r.created_at };
}

export interface CampaignLinkRow {
  code: string;
  workspace_id: string;
  kind: "post" | "bio";
  post_id: string | null;
  account_id: string | null;
  provider: string;
  app_id: string;
  app_store_id: string;
  ct: string;
  url: string;
  created_at: number;
}

/**
 * Results of the tracked link of `p.id` (posts p) as two correlated subqueries: total clicks and Apple's numbers
 * (JSON). Kept inside the caller's query (the playbook ranking must stay one query; lists stay one query).
 */
export const CAMPAIGN_RESULT_COLUMNS = (post = "p.id") =>
  `(SELECT SUM(k.clicks) FROM campaign_links l JOIN campaign_clicks k ON k.code = l.code WHERE l.post_id = ${post}) AS campaign_clicks,
   (SELECT json_object('linked', 1, 'downloads', s.downloads, 'redownloads', s.redownloads, 'purchases', s.purchases, 'proceeds', s.proceeds, 'sales', s.sales, 'currency', s.currency, 'asOf', s.last_day)
      FROM campaign_links l LEFT JOIN campaign_stats s ON s.workspace_id = l.workspace_id AND s.app_store_id = l.app_store_id AND s.ct = l.ct
      WHERE l.post_id = ${post}) AS campaign_stats`;

export interface CampaignResultCols {
  campaign_clicks?: number | null;
  campaign_stats?: string | null;
}

interface StatsJson {
  linked?: number;
  downloads?: number | null;
  redownloads?: number | null;
  purchases?: number | null;
  proceeds?: number | null;
  sales?: number | null;
  currency?: string | null;
  asOf?: string | null;
}

/** CampaignResultsDTO from CAMPAIGN_RESULT_COLUMNS (null when the post has no tracked link). */
export function campaignResults(r: CampaignResultCols): CampaignResultsDTO | null {
  const s = parseJson<StatsJson | null>(r.campaign_stats, null);
  if (!s?.linked) return null;
  return {
    clicks: r.campaign_clicks ?? 0,
    downloads: s.downloads ?? null,
    redownloads: s.redownloads ?? null,
    purchases: s.purchases ?? null,
    proceeds: s.proceeds ?? null,
    sales: s.sales ?? null,
    currency: s.currency ?? null,
    asOf: s.asOf ?? null,
  };
}

/** SELECT list for CampaignLinkDTO (campaign_links l). */
export const LINK_COLUMNS = `l.*, (SELECT SUM(k.clicks) FROM campaign_clicks k WHERE k.code = l.code) AS clicks,
  s.downloads, s.redownloads, s.purchases, s.proceeds, s.sales, s.currency, s.last_day`;
export const LINK_FROM = "campaign_links l LEFT JOIN campaign_stats s ON s.workspace_id = l.workspace_id AND s.app_store_id = l.app_store_id AND s.ct = l.ct";

type LinkResultRow = CampaignLinkRow & {
  clicks: number | null;
  downloads: number | null;
  redownloads: number | null;
  purchases: number | null;
  proceeds: number | null;
  sales: number | null;
  currency: string | null;
  last_day: string | null;
};

export const trackedUrl = (base: string, code: string) => `${base.replace(/\/$/, "")}/a/${code}`;

export function linkDto(r: LinkResultRow, base: string): CampaignLinkDTO {
  return {
    code: r.code,
    kind: r.kind,
    trackedUrl: trackedUrl(base, r.code),
    appStoreUrl: r.url,
    ct: r.ct,
    postId: r.post_id,
    accountId: r.account_id,
    provider: r.provider,
    appId: r.app_id,
    appStoreId: r.app_store_id,
    createdAt: r.created_at,
    clicks: r.clicks ?? 0,
    downloads: r.downloads ?? null,
    redownloads: r.redownloads ?? null,
    purchases: r.purchases ?? null,
    proceeds: r.proceeds ?? null,
    sales: r.sales ?? null,
    currency: r.currency ?? null,
    asOf: r.last_day ?? null,
  };
}

/** Links of a workspace (optionally filtered), with their results. One query. */
export async function listLinks(
  db: D1Database,
  workspaceId: string,
  base: string,
  f: { postId?: string; accountId?: string; appId?: string; kind?: "post" | "bio"; limit?: number } = {},
): Promise<CampaignLinkDTO[]> {
  const where = ["l.workspace_id = ?"];
  const binds: unknown[] = [workspaceId];
  if (f.postId) where.push("l.post_id = ?") && binds.push(f.postId);
  if (f.accountId) where.push("l.account_id = ?") && binds.push(f.accountId);
  if (f.appId) where.push("l.app_id = ?") && binds.push(f.appId);
  if (f.kind) where.push("l.kind = ?") && binds.push(f.kind);
  const { results } = await db
    .prepare(`SELECT ${LINK_COLUMNS} FROM ${LINK_FROM} WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC LIMIT ?`)
    .bind(...binds, Math.min(Math.max(f.limit ?? 200, 1), 500))
    .all<LinkResultRow>();
  return results.map((r) => linkDto(r, base));
}

// ---------------------------------------------------------------------------------------------------------------
// Apps

/** An app of the workspace by id (app_...), App Store id or name (case-insensitive). */
export async function findApp(db: D1Database, workspaceId: string, ref: string): Promise<AppRow | null> {
  return db
    .prepare("SELECT * FROM workspace_apps WHERE workspace_id = ? AND (id = ? OR app_store_id = ? OR name = ? COLLATE NOCASE) ORDER BY id = ? DESC, app_store_id = ? DESC LIMIT 1")
    .bind(workspaceId, ref, ref, ref, ref, ref)
    .first<AppRow>();
}

/** Workspace campaign settings plus the app `ref` (when given): one query, used by post create/update. */
export async function campaignContext(db: D1Database, workspaceId: string, ref: string | null) {
  const row = await db
    .prepare(
      `SELECT w.apple_provider_token AS pt, w.campaign_autolink AS autolink, a.id AS app_id, a.app_store_id, a.name AS app_name
       FROM workspaces w LEFT JOIN workspace_apps a ON a.workspace_id = w.id AND (a.id = ? OR a.app_store_id = ? OR a.name = ? COLLATE NOCASE)
       WHERE w.id = ? ORDER BY a.id = ? DESC LIMIT 1`,
    )
    .bind(ref, ref, ref, workspaceId, ref)
    .first<{ pt: string | null; autolink: number; app_id: string | null; app_store_id: string | null; app_name: string | null }>();
  return {
    providerToken: row?.pt ?? null,
    autoLink: !!row?.autolink,
    app: row?.app_id ? { id: row.app_id, appStoreId: row.app_store_id!, name: row.app_name! } : null,
  };
}

export type CampaignContext = Awaited<ReturnType<typeof campaignContext>>;

// ---------------------------------------------------------------------------------------------------------------
// Auto-insert / replace

export interface RewriteInput {
  content: string;
  thread: ThreadItem[];
  settings: Record<string, unknown>;
}

export interface RewriteResult extends RewriteInput {
  changed: boolean;
  /** What was not done because of a length limit (logged on the post). */
  skipped: string[];
}

const xLimit = (settings: Record<string, unknown>) => (settings.premium ? 25_000 : 280);

/**
 * Whether `after` breaks a length rule that `before` did not: the generic character limit, X's weighted count
 * (URLs count as 23) and the provider's own validation (e.g. Bluesky graphemes) for the main text.
 */
export function lengthOk(provider: Provider, before: string, after: string, settings: Record<string, unknown>, main: boolean): boolean {
  if (provider.id === "x") return xWeightedLength(after) <= xLimit(settings) || xWeightedLength(after) <= xWeightedLength(before);
  const max = provider.capabilities.maxLength;
  if (max && textLength(after) > max && textLength(after) > textLength(before)) return false;
  if (main && provider.validate) {
    const errs = (content: string) => provider.validate!({ id: "", content, settings, media: [] }).length;
    if (errs(after) > errs(before)) return false;
  }
  return true;
}

const replaceAppUrls = (text: string, appStoreId: string, link: string) => {
  const found = findAppStoreUrls(text, appStoreId);
  if (!found.length) return text;
  let out = "";
  let last = 0;
  for (const f of found) {
    out += text.slice(last, f.index) + link;
    last = f.index + f.url.length;
  }
  return out + text.slice(last);
};

const isAppUrl = (v: unknown, appStoreId: string) => typeof v === "string" && findAppStoreUrls(v, appStoreId).length > 0 && findAppStoreUrls(v, appStoreId)[0].url === v.trim();
const hasUrl = (text: string) => HAS_URL_RE.test(text) || new RegExp(URL_RE.source, "i").test(text);

/** YouTube Shorts: links in the description and comments are not clickable (since Aug 2023), so nothing is inserted. */
export const isYouTubeShort = (provider: string, settings: Record<string, unknown> | undefined, content = "") =>
  provider === "youtube" && (settings?.shorts === true || settings?.shorts === "true" || /(^|\s)#shorts\b/i.test(content));

/**
 * Auto-insert on a clickable platform: replace plain App Store URLs of the app (without their own ct=) by the tracked
 * link in the text and follow-ups (first comment, thread replies), fill Pinterest's destination link / Reddit's link
 * URL, and append the tracked link when the post contains no link at all. A change that would break the platform's
 * length limit is skipped (reported in `skipped`). Non-clickable platforms (Instagram, TikTok...) are never changed.
 */
export function rewriteForCampaign(provider: Provider, input: RewriteInput, link: string, appStoreId: string): RewriteResult {
  const out: RewriteResult = { content: input.content, thread: input.thread, settings: input.settings, changed: false, skipped: [] };
  if (!isClickable(provider.id) || isYouTubeShort(provider.id, input.settings, input.content)) return out;
  const tooLong = (where: string) => out.skipped.push(`Tracked link not inserted in the ${where}: it would exceed ${provider.name}'s length limit`);

  // 1. Replace App Store URLs of the app.
  const content = replaceAppUrls(input.content, appStoreId, link);
  if (content !== input.content) {
    if (lengthOk(provider, input.content, content, input.settings, true)) out.content = content;
    else tooLong("text");
  }
  out.thread = input.thread.map((t, i) => {
    const c = replaceAppUrls(t.content, appStoreId, link);
    if (c === t.content) return t;
    if (lengthOk(provider, t.content, c, input.settings, false)) return { ...t, content: c };
    tooLong(`${provider.capabilities.threadLabel?.toLowerCase() ?? "follow-up"} ${i + 1}`);
    return t;
  });

  // 2. Link fields.
  let settings = input.settings;
  if (provider.id === "pinterest" && (!settings.link || isAppUrl(settings.link, appStoreId))) settings = { ...settings, link };
  if (provider.id === "reddit" && settings.kind === "link" && (!settings.url || isAppUrl(settings.url, appStoreId))) settings = { ...settings, url: link };
  out.settings = settings;

  // 3. Append when the post has no link at all (not where a link field carries it, not to text-less platforms).
  const linkField = provider.id === "pinterest" || (provider.id === "reddit" && settings.kind === "link");
  const anyLink = hasUrl(out.content) || out.thread.some((t) => hasUrl(t.content));
  if (!anyLink && !linkField && provider.capabilities.text !== "none") {
    const appended = out.content.trim() ? `${out.content.replace(/\s+$/, "")}\n\n${link}` : link;
    if (lengthOk(provider, out.content, appended, settings, true)) out.content = appended;
    else tooLong("text");
  }
  out.changed = out.content !== input.content || out.settings !== input.settings || out.thread.some((t, i) => t !== input.thread[i]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Link rows

/** Whether a post on this platform gets a tracked link (clickable platforms only; others use the bio link). */
export const wantsPostLink = (provider: string) => isClickable(provider);
export const usesBioLink = (provider: string) => BIO_LINK_PLATFORMS.has(provider);

/** A new post link (code random, ct from the post id). `attempt` > 0 after a unique-constraint collision. */
export function newPostLink(
  ws: string,
  post: { id: string; accountId: string; provider: string },
  app: { id: string; appStoreId: string },
  providerToken: string,
  attempt = 0,
): CampaignLinkRow {
  const ct = postCampaignToken(post.provider, post.id, attempt);
  return {
    code: newLinkCode(),
    workspace_id: ws,
    kind: "post",
    post_id: post.id,
    account_id: post.accountId,
    provider: post.provider,
    app_id: app.id,
    app_store_id: app.appStoreId,
    ct,
    url: appStoreCampaignUrl(app.appStoreId, providerToken, ct),
    created_at: now(),
  };
}

export function insertLinkStatement(db: D1Database, l: CampaignLinkRow): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO campaign_links (code, workspace_id, kind, post_id, account_id, provider, app_id, app_store_id, ct, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(l.code, l.workspace_id, l.kind, l.post_id, l.account_id, l.provider, l.app_id, l.app_store_id, l.ct, l.url, l.created_at);
}

/** A collision on a link code or campaign token (retry with new values). */
export const isLinkCollision = (err: unknown) => /UNIQUE constraint failed: campaign_links/i.test(String(err));

/**
 * The bio link of an account for an app (created on first use). ct pf-<platform>-bio, or -bio-2, -bio-3 when another
 * account of the same platform already uses it for this app.
 */
export async function ensureBioLink(
  db: D1Database,
  ws: string,
  account: { id: string; provider: string },
  app: { id: string; appStoreId: string },
  providerToken: string,
): Promise<string> {
  const existing = await db.prepare("SELECT code FROM campaign_links WHERE account_id = ? AND app_id = ? AND kind = 'bio'").bind(account.id, app.id).first<{ code: string }>();
  if (existing) return existing.code;
  const { results } = await db
    .prepare("SELECT ct FROM campaign_links WHERE workspace_id = ? AND app_store_id = ? AND ct LIKE ?")
    .bind(ws, app.appStoreId, `${bioCampaignToken(account.provider)}%`)
    .all<{ ct: string }>();
  const taken = new Set(results.map((r) => r.ct));
  let n = 1;
  while (taken.has(bioCampaignToken(account.provider, n))) n++;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ct = bioCampaignToken(account.provider, n + attempt);
    const row: CampaignLinkRow = {
      code: newLinkCode(),
      workspace_id: ws,
      kind: "bio",
      post_id: null,
      account_id: account.id,
      provider: account.provider,
      app_id: app.id,
      app_store_id: app.appStoreId,
      ct,
      url: appStoreCampaignUrl(app.appStoreId, providerToken, ct),
      created_at: now(),
    };
    try {
      await insertLinkStatement(db, row).run();
      return row.code;
    } catch (err) {
      if (!isLinkCollision(err)) throw err;
      // Created concurrently for this account? Use that one.
      const again = await db.prepare("SELECT code FROM campaign_links WHERE account_id = ? AND app_id = ? AND kind = 'bio'").bind(account.id, app.id).first<{ code: string }>();
      if (again) return again.code;
    }
  }
  throw new Error("Could not create a bio link, try again");
}

// ---------------------------------------------------------------------------------------------------------------
// GET /a/<code>: bot filtering and click counting

/** Crawlers, link-preview fetchers and HTTP libraries: their requests are redirected but not counted. */
const BOT_UA =
  /bot\b|bot\/|crawler|spider|crawl|slurp|preview|facebookexternalhit|facebookcatalog|meta-externalagent|twitterbot|slackbot|slack-imgproxy|linkedinbot|discordbot|telegrambot|whatsapp|skypeuripreview|embedly|redditbot|mastodon|bluesky|cardyb|googlebot|google-inspectiontool|adsbot|mediapartners|bingbot|bingpreview|yandex|baiduspider|duckduckbot|applebot|petalbot|ahrefs|semrush|mj12bot|dotbot|bytespider|gptbot|claudebot|ccbot|perplexity|headless|phantomjs|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|axios\/|node-fetch|undici|postmanruntime|insomnia|httpie|uptime|monitor|pingdom|statuscake|^$/i;

export function isBot(method: string, userAgent: string | null | undefined): boolean {
  if (method !== "GET") return true;
  return BOT_UA.test((userAgent ?? "").trim());
}

/** The one D1 write of a counted click. */
export function clickStatement(db: D1Database, code: string, t = now()): D1PreparedStatement {
  return db
    .prepare("INSERT INTO campaign_clicks (code, day, clicks) VALUES (?, ?, 1) ON CONFLICT(code, day) DO UPDATE SET clicks = clicks + 1")
    .bind(code, utcDay(t));
}
