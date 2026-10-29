// Optional Revflare connection of a workspace (https://github.com/FerdiKT/revflare): App Store apps and Apple App
// Analytics per campaign token (downloads, redownloads, purchases, proceeds), read with a workspace API key (rf_...,
// any role that can read: viewer is enough).
//
// Endpoints used (Revflare REST API v1, docs/api.md there):
//   GET /api/v1/apps                                   -> { items: App[], currency }
//   GET /api/v1/acquisition/campaigns                  -> { currency, items: AcquisitionCampaign[] } (all time, per app)
//   GET /api/v1/acquisition?by=app,campaign&range=all  -> { currency, rows: AcquisitionRow[], lastDay, ... } (adds sales)
//
// Sync cadence: the metrics cron (worker/index.ts) syncs at most CRON_SYNC_WORKSPACES due workspaces on its hourly
// tick (2 fetches and 1 batch of 3 statements each), every SYNC_INTERVAL per workspace (Apple's reports are daily
// and complete after 2-3 days). Demo workspaces are never synced (lib/demo-seed.ts seeds their numbers).

import type { CampaignSyncDTO, RevflareTestDTO } from "../../shared/types";
import { isAppStoreId } from "../../shared/campaigns";
import { ProviderError } from "../providers/errors";
import { request } from "../providers/http";
import { decryptJson } from "./crypto";
import { errorMessage, newId, now } from "./util";

const HOUR = 60 * 60 * 1000;
/** Revflare calls never hang a request or a cron tick. */
export const REVFLARE_TIMEOUT_MS = 10_000;
/** A workspace is synced this often (Apple's App Analytics reports are daily). */
export const SYNC_INTERVAL = 6 * HOUR;
/** Workspaces synced per hourly metrics tick (2 fetches each). */
export const CRON_SYNC_WORKSPACES = 2;
/** Campaign tokens stored per workspace at most (one statement: a JSON array bound to json_each). */
const MAX_CAMPAIGNS = 3000;

export interface RevflareConn {
  url: string;
  key: string;
}

// ---------------------------------------------------------------------------------------------------------------
// URL validation (an outbound fetch target configured by workspace admins)

function privateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|lan|home\.arpa|intranet|corp)$/i;

/** True for loopback / private / link-local / internal-looking hosts. */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (h.includes(":")) {
    // IPv6 literal: loopback, unspecified, unique local (fc00::/7), link-local (fe80::/10), IPv4-mapped.
    return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:") || h.startsWith("64:ff9b:");
  }
  if (privateIpv4(h)) return true;
  if (!h.includes(".")) return true; // single-label names resolve inside networks
  return LOCAL_NAMES.test(h);
}

/**
 * The Revflare base URL to store (origin, plus a path prefix when Revflare runs under one; a trailing /api/v1 is
 * removed). https only and no internal hosts, except http(s)://localhost when Postflare itself runs on localhost (dev).
 */
export function normalizeRevflareUrl(input: unknown, opts: { allowLocal?: boolean } = {}): { url: string } | { error: string } {
  if (typeof input !== "string" || !input.trim()) return { error: "Revflare URL is required" };
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { error: "Invalid Revflare URL" };
  }
  if (u.username || u.password) return { error: "The Revflare URL cannot contain credentials" };
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (opts.allowLocal && local) {
    if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Invalid Revflare URL" };
  } else {
    if (u.protocol !== "https:") return { error: "The Revflare URL must use https://" };
    if (isInternalHost(u.hostname)) return { error: "The Revflare URL must be a public host (no localhost, private IPs or internal names)" };
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api(\/v1)?$/, "");
  return { url: `${u.origin}${path}` };
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP

/** GET <base>/api/v1<path> with the API key; 10 s timeout; redirects are not followed (no hop to internal hosts). */
export async function revflareGet<T>(conn: RevflareConn, path: string, query?: Record<string, string>): Promise<T> {
  const url = new URL(`${conn.url}/api/v1${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await request({ fetch: (input, init) => fetch(input, init) }, url.toString(), {
      token: conn.key,
      redirect: "manual",
      signal: AbortSignal.timeout(REVFLARE_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "postflare" },
    });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 401) throw new Error("Revflare rejected the API key (401): check it, and that its user can still read the workspace");
    if (err instanceof ProviderError && err.status === 403) throw new Error("The Revflare API key cannot read this data (403)");
    if (err instanceof ProviderError && err.status && err.status >= 300 && err.status < 400) throw new Error(`Revflare answered with a redirect (${err.status}): use the final URL`);
    if (err instanceof ProviderError && err.status === 404) throw new Error(`Not found on Revflare (404): check the URL (${conn.url})`);
    throw new Error(`Revflare: ${errorMessage(err).replace(/^Network error calling /, "network error calling ")}`);
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("Revflare returned an unexpected response (is the URL a Revflare instance?)");
  return data as T;
}

/** The connection stored on a workspace row (decrypts the key). Null when not configured. */
export async function workspaceConn(env: Env, row: { revflare_url: string | null; revflare_key_enc: string | null }): Promise<RevflareConn | null> {
  if (!row.revflare_url || !row.revflare_key_enc) return null;
  const { key } = await decryptJson<{ key: string }>(env, row.revflare_key_enc);
  return { url: row.revflare_url, key };
}

// ---------------------------------------------------------------------------------------------------------------
// Shapes (Revflare shared/types.ts: App, AcquisitionCampaign, Acquisition)

export interface RevflareApp {
  id: string;
  name: string;
  appleAppId: string | null;
  iconUrl: string | null;
  archived?: boolean;
}

interface RevflareCampaign {
  campaign: string;
  appId: string;
  appleAppId: string | null;
  firstSeen: string;
  lastSeen: string;
  downloads: number;
  redownloads: number;
  purchases: number;
  proceeds: number;
}

interface RevflareAcquisition {
  currency: string;
  rows: Array<{ appId?: string; campaign?: string; sales?: number }>;
  lastDay: string | null;
}

export async function testConnection(conn: RevflareConn): Promise<RevflareTestDTO> {
  try {
    const r = await revflareGet<{ items?: RevflareApp[]; currency?: string }>(conn, "/apps");
    if (!Array.isArray(r.items)) return { ok: false, error: "Revflare returned an unexpected response (is the URL a Revflare instance?)" };
    return { ok: true, apps: r.items.filter((a) => isAppStoreId(a.appleAppId ?? "")).length, currency: r.currency };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Apps of the Revflare workspace that have an App Store id. */
export async function revflareApps(conn: RevflareConn): Promise<RevflareApp[]> {
  const r = await revflareGet<{ items?: RevflareApp[] }>(conn, "/apps");
  return (r.items ?? []).filter((a) => isAppStoreId(a.appleAppId ?? "") && !a.archived);
}

/** Upserts Revflare apps into workspace_apps (one batch). Returns how many were imported. */
export async function importApps(db: D1Database, workspaceId: string, apps: RevflareApp[]): Promise<number> {
  if (!apps.length) return 0;
  const t = now();
  await db.batch(
    apps.slice(0, 100).map((a) =>
      db
        .prepare(
          `INSERT INTO workspace_apps (id, workspace_id, app_store_id, name, icon_url, revflare_app_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, app_store_id) DO UPDATE SET name = excluded.name, icon_url = COALESCE(excluded.icon_url, workspace_apps.icon_url), revflare_app_id = excluded.revflare_app_id`,
        )
        .bind(newId("app_"), workspaceId, a.appleAppId, String(a.name ?? a.appleAppId).slice(0, 200), safeIcon(a.iconUrl), a.id, t),
    ),
  );
  return Math.min(apps.length, 100);
}

/** Only https icon URLs are stored (shown as <img>). */
export const safeIcon = (v: unknown) => (typeof v === "string" && /^https:\/\/\S+$/.test(v) && v.length < 1000 ? v : null);

// ---------------------------------------------------------------------------------------------------------------
// Campaign sync

export interface CampaignStat {
  appStoreId: string;
  ct: string;
  downloads: number;
  redownloads: number;
  purchases: number;
  proceeds: number;
  sales: number;
  firstDay: string | null;
  lastDay: string | null;
}

/** Fetches Revflare's campaign numbers (2 requests) and keeps Postflare's tokens (pf-...). */
export async function fetchCampaignStats(conn: RevflareConn): Promise<{ currency: string; asOf: string | null; stats: CampaignStat[] }> {
  const camp = await revflareGet<{ currency?: string; items?: RevflareCampaign[] }>(conn, "/acquisition/campaigns");
  if (!Array.isArray(camp.items)) throw new Error("Revflare returned an unexpected response for /acquisition/campaigns");
  // Sales per app + campaign (optional: older Revflare versions or a failure only lose the sales column).
  let acq: RevflareAcquisition | null = null;
  try {
    acq = await revflareGet<RevflareAcquisition>(conn, "/acquisition", { by: "app,campaign", range: "all" });
  } catch {
    acq = null;
  }
  const appleId = new Map<string, string>();
  for (const c of camp.items) if (c.appleAppId) appleId.set(c.appId, c.appleAppId);
  const sales = new Map<string, number>();
  for (const r of acq?.rows ?? []) {
    const a = r.appId ? appleId.get(r.appId) : undefined;
    if (a && r.campaign?.startsWith("pf-")) sales.set(`${a}|${r.campaign}`, (sales.get(`${a}|${r.campaign}`) ?? 0) + (Number(r.sales) || 0));
  }
  const byKey = new Map<string, CampaignStat>();
  for (const c of camp.items) {
    if (!c.appleAppId || !isAppStoreId(c.appleAppId) || typeof c.campaign !== "string" || !c.campaign.startsWith("pf-") || c.campaign.length > 64) continue;
    const key = `${c.appleAppId}|${c.campaign}`;
    const prev = byKey.get(key);
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    byKey.set(key, {
      appStoreId: c.appleAppId,
      ct: c.campaign,
      downloads: (prev?.downloads ?? 0) + n(c.downloads),
      redownloads: (prev?.redownloads ?? 0) + n(c.redownloads),
      purchases: (prev?.purchases ?? 0) + n(c.purchases),
      proceeds: Math.round(((prev?.proceeds ?? 0) + n(c.proceeds)) * 100) / 100,
      sales: Math.round((sales.get(key) ?? 0) * 100) / 100,
      firstDay: prev?.firstDay && prev.firstDay < c.firstSeen ? prev.firstDay : (c.firstSeen ?? null),
      lastDay: prev?.lastDay && prev.lastDay > c.lastSeen ? prev.lastDay : (c.lastSeen ?? null),
    });
  }
  const stats = [...byKey.values()].slice(0, MAX_CAMPAIGNS);
  return { currency: String(camp.currency ?? acq?.currency ?? "USD").slice(0, 3).toUpperCase(), asOf: acq?.lastDay ?? null, stats };
}

/** Replaces a workspace's campaign stats and records the sync: 3 statements, for one batch. */
export function saveStatsStatements(db: D1Database, workspaceId: string, currency: string, stats: CampaignStat[], t = now()): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM campaign_stats WHERE workspace_id = ?").bind(workspaceId),
    db
      .prepare(
        `INSERT OR REPLACE INTO campaign_stats (workspace_id, app_store_id, ct, downloads, redownloads, purchases, proceeds, sales, currency, first_day, last_day, synced_at)
         SELECT ?, json_extract(j.value, '$.appStoreId'), json_extract(j.value, '$.ct'), json_extract(j.value, '$.downloads'), json_extract(j.value, '$.redownloads'),
           json_extract(j.value, '$.purchases'), json_extract(j.value, '$.proceeds'), json_extract(j.value, '$.sales'), ?, json_extract(j.value, '$.firstDay'),
           json_extract(j.value, '$.lastDay'), ? FROM json_each(?) j`,
      )
      .bind(workspaceId, currency, t, JSON.stringify(stats)),
    db
      .prepare(
        "UPDATE workspaces SET revflare_status = 'ok', revflare_message = NULL, revflare_synced_at = ?, revflare_next_at = ?, revflare_fails = 0, revflare_currency = ? WHERE id = ?",
      )
      .bind(t, t + SYNC_INTERVAL, currency, workspaceId),
  ];
}

const backoff = (fails: number) => Math.min(HOUR * 2 ** Math.max(0, fails - 1), 24 * HOUR);

function failStatement(db: D1Database, workspaceId: string, fails: number, message: string, t = now()) {
  return db
    .prepare("UPDATE workspaces SET revflare_status = 'error', revflare_message = ?, revflare_fails = ?, revflare_next_at = ? WHERE id = ?")
    .bind(message.slice(0, 500), fails, t + backoff(fails), workspaceId);
}

interface SyncRow {
  id: string;
  revflare_url: string | null;
  revflare_key_enc: string | null;
  revflare_fails: number;
}

/** Sync one workspace (fetch + one batch). */
export async function syncWorkspace(env: Env, row: SyncRow): Promise<CampaignSyncDTO> {
  const db = env.DB;
  try {
    const conn = await workspaceConn(env, row);
    if (!conn) return { ok: false, error: "Revflare is not connected" };
    const r = await fetchCampaignStats(conn);
    await db.batch(saveStatsStatements(db, row.id, r.currency, r.stats));
    return { ok: true, campaigns: r.stats.length, currency: r.currency, asOf: r.asOf };
  } catch (err) {
    const message = errorMessage(err);
    await failStatement(db, row.id, (row.revflare_fails ?? 0) + 1, message).run();
    return { ok: false, error: message };
  }
}

/** Metrics cron (hourly tick): sync up to `limit` due workspaces. 1 query + per workspace 2 fetches and 1 batch. */
export async function campaignSyncCron(env: Env, limit = CRON_SYNC_WORKSPACES): Promise<{ synced: number; fetches: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id, revflare_url, revflare_key_enc, revflare_fails FROM workspaces
     WHERE revflare_key_enc IS NOT NULL AND revflare_url IS NOT NULL AND is_demo = 0 AND COALESCE(revflare_next_at, 0) <= ?
     ORDER BY COALESCE(revflare_next_at, 0) LIMIT ?`,
  )
    .bind(now(), limit)
    .all<SyncRow>();
  let synced = 0;
  for (const row of results) if ((await syncWorkspace(env, row)).ok) synced++;
  return { synced, fetches: results.length * 2 };
}
