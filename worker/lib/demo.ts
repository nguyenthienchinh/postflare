// Public live demo (opt-in with DEMO_MODE=true). Visitors sign in without a password as the shared demo user, into a
// pre-filled demo workspace that is sandboxed: nothing ever reaches a real platform.
//
// - Identity: user `usr_demo` (users.is_demo = 1, no instance permissions, capped workspace permissions, only reaches
//   demo workspaces; enforced in lib/auth.ts) in workspace `ws_demo` (workspaces.is_demo = 1) with the "Demo" role.
// - Seeding: on first demo login, and again by the cron once a day (everything in ws_demo is replaced).
// - Publishing: demo posts never get a Workflow. "Post now" / retry flips the post to publishing and a waitUntil
//   marks it published a few seconds later; scheduled demo posts are published by `simulateDueDemoPosts` (cron, and
//   lazily when the demo workspace is viewed). The publish workflow also refuses to call a provider for a demo
//   workspace (defence in depth).

import type { FieldOption } from "../../shared/types";
import { getProvider } from "../providers/registry";
import { encryptJson } from "./crypto";
import { DEMO_ACCOUNTS, DEMO_ACCOUNT_GROUPS, DEMO_APPS, demoAccountGroup, DEMO_MEDIA, DEMO_PROVIDER_TOKEN, SIMULATED_LOG, fakeExternalId, fakePostUrl, seedCampaigns, seedPosts } from "./demo-seed";
import { appStoreCampaignUrl, bioCampaignToken, isClickable, newLinkCode, postCampaignToken } from "../../shared/campaigns";
import { demoAccountMetrics, demoPostMetrics, demoSnapshotTimes } from "./demo-metrics";
import { CHECKPOINTS, nextAccountRun, nextCheckpoint, utcDay, withoutDetails } from "./metrics";
import { demoPublishEventsStatement } from "./usage";
import { DEMO_ROLE, DEMO_WORKSPACE_PERMISSIONS } from "./permissions";
import { getSetting, setSetting } from "./settings";
import { newId, now, parseJson, randomToken } from "./util";
import type { MetricValues, ThreadItem } from "../../shared/types";
import type { SeedPost } from "./demo-seed";

export const DEMO_USER_ID = "usr_demo";
export const DEMO_WORKSPACE_ID = "ws_demo";
export const DEMO_EMAIL = "demo@postflare.local";
export const DEMO_WORKSPACE_NAME = "Acme Studio (demo)";
export const DEMO_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Posts visitors may create in the demo workspace per 24 hours (all visitors together). */
export const DEMO_POSTS_PER_DAY = 200;
/** Demo logins per IP per hour. */
export const DEMO_LOGINS_PER_HOUR = 20;
/** "Post now" in the demo: publishing → published after this delay. */
export const DEMO_PUBLISH_DELAY_MS = 2500;
const RESET_EVERY_MS = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Bump when the images in public/demo/ change: they are copied to R2 again on the next reset. */
const ASSETS_VERSION = "1";

export const demoEnabled = (env: Pick<Env, "DEMO_MODE">) => env.DEMO_MODE === "true";

/** Workspace id → is it a demo workspace (sandboxed). */
export async function isDemoWorkspace(db: D1Database, workspaceId: string | null | undefined): Promise<boolean> {
  if (!workspaceId) return false;
  const row = await db.prepare("SELECT is_demo FROM workspaces WHERE id = ?").bind(workspaceId).first<{ is_demo: number }>();
  return !!row?.is_demo;
}

/** True when a post (or its account) belongs to a demo workspace. */
export async function isDemoPost(db: D1Database, postId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM posts p LEFT JOIN accounts a ON a.id = p.account_id JOIN workspaces w ON w.id = p.workspace_id OR w.id = a.workspace_id
       WHERE p.id = ? AND w.is_demo = 1) AS demo`,
    )
    .bind(postId)
    .first<{ demo: number }>();
  return !!row?.demo;
}

// ---------------------------------------------------------------------------------------------------------------
// Login throttle

type Window = { n: number; until: number };

/** Counts a demo login for this IP; false when it is over the hourly limit. */
export async function takeDemoLogin(env: Env, ip: string): Promise<boolean> {
  const key = `demo_login:${ip}`;
  const w = parseJson<Window>(await getSetting(env.DB, key), { n: 0, until: 0 });
  const t = now();
  const open = w.until > t;
  if (open && w.n >= DEMO_LOGINS_PER_HOUR) return false;
  await setSetting(env.DB, key, JSON.stringify({ n: (open ? w.n : 0) + 1, until: open ? w.until : t + HOUR }));
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Seeding and the daily reset

/** Seeds the demo (identity and content) unless it already is. */
export async function ensureDemo(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT (SELECT value FROM settings WHERE key = 'demo_reset_at') AS reset_at,
       EXISTS (SELECT 1 FROM users WHERE id = ? AND is_demo = 1 AND status = 'active') AS user_ok,
       EXISTS (SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ? AND w.is_demo = 1) AS member_ok`,
  )
    .bind(DEMO_USER_ID, DEMO_WORKSPACE_ID, DEMO_USER_ID)
    .first<{ reset_at: string | null; user_ok: number; member_ok: number }>();
  if (row?.reset_at && row.user_ok && row.member_ok) return;
  await resetDemo(env);
}

/** Cron: reset the demo workspace once a day (only once it has been seeded by a first visitor). */
export async function maybeResetDemo(env: Env): Promise<boolean> {
  if (!demoEnabled(env)) return false;
  const last = Number(await getSetting(env.DB, "demo_reset_at"));
  if (!last || now() - last < RESET_EVERY_MS) return false;
  await resetDemo(env);
  return true;
}

/** Cron: the daily reset, then publish due demo posts. */
export async function demoCron(env: Env): Promise<void> {
  if (!demoEnabled(env)) return;
  await maybeResetDemo(env);
  await simulateDueDemoPosts(env);
}

function identityStatements(db: D1Database, t: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO roles (id, scope, name, description, permissions, builtin, created_at) VALUES (?, 'instance', 'Demo visitor', 'Live demo visitors. No instance permissions.', '[]', 1, ?)
         ON CONFLICT(id) DO UPDATE SET scope = 'instance', permissions = '[]', builtin = 1`,
      )
      .bind(DEMO_ROLE.instance, t),
    db
      .prepare(
        `INSERT INTO roles (id, scope, name, description, permissions, builtin, created_at) VALUES (?, 'workspace', 'Demo', 'Live demo visitors: read everything, write posts. No uploads, no account changes.', ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET scope = 'workspace', permissions = excluded.permissions, builtin = 1`,
      )
      .bind(DEMO_ROLE.workspace, JSON.stringify(DEMO_WORKSPACE_PERMISSIONS), t),
    db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, role_id, status, is_demo, created_at, updated_at) VALUES (?, ?, 'Demo visitor', ?, ?, 'active', 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = 'Demo visitor', role_id = excluded.role_id, status = 'active', is_demo = 1`,
      )
      // Not a PBKDF2 hash: no password ever matches it.
      .bind(DEMO_USER_ID, DEMO_EMAIL, `demo$disabled$${randomToken(16)}`, DEMO_ROLE.instance, t, t),
    db
      .prepare(
        `INSERT INTO workspaces (id, name, created_by, created_at, updated_at, is_demo) VALUES (?, ?, NULL, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_demo = 1, updated_at = excluded.updated_at`,
      )
      .bind(DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME, t, t),
    db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role_id = excluded.role_id`,
      )
      .bind(DEMO_WORKSPACE_ID, DEMO_USER_ID, DEMO_ROLE.workspace, t),
    // The demo user belongs to the demo workspace only.
    db.prepare("DELETE FROM workspace_members WHERE user_id = ? AND workspace_id != ?").bind(DEMO_USER_ID, DEMO_WORKSPACE_ID),
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(DEMO_USER_ID),
  ];
}

/** Copy the demo images from the static assets into R2 (once per ASSETS_VERSION). Failures are logged, not fatal. */
async function copyAssets(env: Env): Promise<void> {
  if (!env.ASSETS || (await getSetting(env.DB, "demo_assets")) === ASSETS_VERSION) return;
  const results = await Promise.allSettled(
    Object.values(DEMO_MEDIA).map(async (m) => {
      // The host is ignored by the assets binding ("localhost" also passes Vite's host check in local dev).
      const res = await env.ASSETS.fetch(new Request(`http://localhost/demo/${m.file}`));
      // A missing file falls back to the SPA's index.html: check the type.
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error(`demo asset ${m.file}: ${res.status}`);
      await env.MEDIA.put(`demo/${m.file}`, await res.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
    }),
  );
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) console.error("demo: copying images failed", failed.map((f) => String(f.reason)));
  else await setSetting(env.DB, "demo_assets", ASSETS_VERSION);
}

/**
 * Replace everything in the demo workspace with fresh seed content (times relative to now) and re-assert the demo
 * identity. Guarded by a lock so concurrent resets (cron + first visitor) do not seed twice.
 */
export async function resetDemo(env: Env): Promise<void> {
  const db = env.DB;
  const t = now();
  // The identity is idempotent: always make sure it exists (a concurrent reset may hold the lock).
  await db.batch(identityStatements(db, t));
  const lock = await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('demo_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < ?",
    )
    .bind(String(t), t - 60_000)
    .run();
  if (!lock.meta.changes) return;
  try {
    await copyAssets(env);
    const tz = (await getSetting(db, "timezone")) || "UTC";
    const credentials = await encryptJson(env, { accessToken: "demo-not-a-real-token", note: "Postflare live demo: publishing is simulated" });
    const { posts, logs } = seedPosts(t, tz, newId);
    const accounts = Object.values(DEMO_ACCOUNTS).map((a, i) => ({ ...a, created_at: t - (30 - i) * 24 * HOUR, group_id: demoAccountGroup(a.id) }));
    const media = Object.values(DEMO_MEDIA).map((m) => ({ ...m, r2_key: `demo/${m.file}`, created_at: t - m.age * 24 * HOUR }));
    const ws = DEMO_WORKSPACE_ID;
    const j = (k: string) => `json_extract(value, '$.${k}')`;
    const metrics = seedMetrics(posts, t);
    const campaigns = seedCampaigns(posts, t, {
      token: postCampaignToken,
      bioToken: (p) => bioCampaignToken(p),
      url: (app, ct) => appStoreCampaignUrl(app, DEMO_PROVIDER_TOKEN, ct),
      code: () => newLinkCode(),
      clickable: isClickable,
    });
    await db.batch([
      db.prepare("DELETE FROM campaign_clicks WHERE code IN (SELECT code FROM campaign_links WHERE workspace_id = ?)").bind(ws),
      db.prepare("DELETE FROM campaign_links WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM campaign_stats WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM workspace_apps WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM post_logs WHERE post_id IN (SELECT id FROM posts WHERE workspace_id = ?)").bind(ws),
      db.prepare("DELETE FROM post_metrics WHERE workspace_id = ? OR post_id IN (SELECT id FROM posts WHERE workspace_id = ?)").bind(ws, ws),
      db.prepare("DELETE FROM account_metrics WHERE workspace_id = ? OR account_id IN (SELECT id FROM accounts WHERE workspace_id = ?)").bind(ws, ws),
      db.prepare("DELETE FROM posts WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM accounts WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM account_groups WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM media WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM upload_links WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM api_keys WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM oauth_states WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM invitations WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM playbook_versions WHERE workspace_id = ?").bind(ws),
      db.prepare("DELETE FROM playbooks WHERE workspace_id = ?").bind(ws),
      // One statement per table: rows come in as a JSON array (D1 caps bound parameters per query at 100).
      db
        .prepare(
          `INSERT OR REPLACE INTO accounts (id, provider, external_id, name, username, avatar_url, profile_url, credentials_enc, expires_at, meta, status, status_message, created_at, updated_at, workspace_id, created_by, group_id)
           SELECT ${j("id")}, ${j("provider")}, ${j("externalId")}, ${j("name")}, ${j("username")}, NULL, ${j("profileUrl")}, ?, NULL, '{"demo":true}', 'active', NULL, ${j("created_at")}, ${j("created_at")}, ?, NULL, ${j("group_id")}
           FROM json_each(?)`,
        )
        .bind(credentials, ws, JSON.stringify(accounts)),
      db
        .prepare(
          `INSERT OR REPLACE INTO account_groups (id, workspace_id, name, color, position, created_at, updated_at)
           SELECT ${j("id")}, ?, ${j("name")}, ${j("color")}, key, ?, ? FROM json_each(?)`,
        )
        .bind(ws, t - 30 * 24 * HOUR, t - 30 * 24 * HOUR, JSON.stringify(DEMO_ACCOUNT_GROUPS.map(({ id, name, color }) => ({ id, name, color })))),
      db
        .prepare(
          `INSERT OR REPLACE INTO media (id, r2_key, filename, mime, size, kind, width, height, duration, alt, status, upload_id, created_at, workspace_id, created_by)
           SELECT ${j("id")}, ${j("r2_key")}, ${j("file")}, 'image/jpeg', ${j("size")}, 'image', ${j("width")}, ${j("height")}, NULL, ${j("alt")}, 'ready', NULL, ${j("created_at")}, ?, NULL
           FROM json_each(?)`,
        )
        .bind(ws, JSON.stringify(media)),
      db
        .prepare(
          `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, settings, thread, external_id, external_url, error, attempts, revision, created_at, updated_at, published_at, workspace_id, created_by, playbook_id, playbook_version, variant)
           SELECT ${j("id")}, ${j("group_id")}, ${j("account_id")}, ${j("status")}, ${j("scheduled_at")}, ${j("content")}, ${j("media")}, ${j("settings")}, ${j("thread")},
             ${j("external_id")}, ${j("external_url")}, ${j("error")}, ${j("attempts")}, 0, ${j("created_at")}, ${j("updated_at")}, ${j("published_at")}, ?, NULL,
             ${j("playbook_id")}, ${j("playbook_version")}, ${j("variant")}
           FROM json_each(?)`,
        )
        .bind(ws, JSON.stringify(posts)),
      db
        .prepare(
          `INSERT INTO post_logs (post_id, level, message, created_at)
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)`,
        )
        .bind(JSON.stringify(logs)),
      // Analytics: snapshots at every checkpoint so far, 30 days of follower history (lib/demo-metrics.ts).
      db
        .prepare(
          `INSERT INTO post_metrics (post_id, workspace_id, captured_at, metrics)
           SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)`,
        )
        .bind(ws, JSON.stringify(metrics.snapshots)),
      db
        .prepare(
          `UPDATE posts SET metrics = json_extract(m.value, '$[1]'), metrics_at = ?, metrics_next_at = json_extract(m.value, '$[2]')
           FROM (SELECT value FROM json_each(?)) AS m WHERE posts.id = json_extract(m.value, '$[0]')`,
        )
        .bind(t, JSON.stringify(metrics.latest)),
      db
        .prepare(
          `INSERT INTO account_metrics (account_id, workspace_id, day, captured_at, metrics)
           SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)`,
        )
        .bind(ws, JSON.stringify(metrics.days)),
      db
        .prepare(
          `UPDATE accounts SET metrics = json_extract(m.value, '$[1]'), metrics_status = 'ok', metrics_message = NULL, metrics_checked_at = ?,
             metrics_next_at = json_extract(m.value, '$[2]'), metrics_fails = 0
           FROM (SELECT value FROM json_each(?)) AS m WHERE accounts.id = json_extract(m.value, '$[0]')`,
        )
        .bind(t, JSON.stringify(metrics.accounts)),
      // App Store campaigns: sample apps, tracked links, clicks and App Analytics numbers (never from Revflare).
      db
        .prepare(
          `UPDATE workspaces SET apple_provider_token = ?, campaign_autolink = 1, revflare_url = NULL, revflare_key_enc = NULL, revflare_status = 'ok',
             revflare_message = 'Sample numbers (demo): the demo never calls Revflare', revflare_synced_at = ?, revflare_next_at = NULL, revflare_currency = 'USD' WHERE id = ?`,
        )
        .bind(DEMO_PROVIDER_TOKEN, t, ws),
      db
        .prepare(
          `INSERT OR REPLACE INTO workspace_apps (id, workspace_id, app_store_id, name, icon_url, revflare_app_id, created_at)
           SELECT ${j("id")}, ?, ${j("appStoreId")}, ${j("name")}, NULL, NULL, ? FROM json_each(?)`,
        )
        .bind(ws, t - 30 * 24 * HOUR, JSON.stringify(Object.values(DEMO_APPS))),
      db
        .prepare(`UPDATE posts SET app_id = json_extract(m.value, '$[1]') FROM (SELECT value FROM json_each(?)) AS m WHERE posts.id = json_extract(m.value, '$[0]')`)
        .bind(JSON.stringify(campaigns.postApps)),
      db
        .prepare(
          `INSERT INTO campaign_links (code, workspace_id, kind, post_id, account_id, provider, app_id, app_store_id, ct, url, created_at)
           SELECT ${j("code")}, ?, ${j("kind")}, ${j("post_id")}, ${j("account_id")}, ${j("provider")}, ${j("app_id")}, ${j("app_store_id")}, ${j("ct")}, ${j("url")}, ${j("created_at")} FROM json_each(?)`,
        )
        .bind(ws, JSON.stringify(campaigns.links)),
      db
        .prepare(`INSERT INTO campaign_clicks (code, day, clicks) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)`)
        .bind(JSON.stringify(campaigns.clicks)),
      db
        .prepare(
          `INSERT INTO campaign_stats (workspace_id, app_store_id, ct, downloads, redownloads, purchases, proceeds, sales, currency, first_day, last_day, synced_at)
           SELECT ?, ${j("app_store_id")}, ${j("ct")}, ${j("downloads")}, ${j("redownloads")}, ${j("purchases")}, ${j("proceeds")}, ${j("sales")}, 'USD', ${j("first_day")}, ${j("last_day")}, ? FROM json_each(?)`,
        )
        .bind(ws, t, JSON.stringify(campaigns.stats)),
      db.prepare("INSERT INTO settings (key, value) VALUES ('demo_reset_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(t)),
    ]);
  } finally {
    await db.prepare("DELETE FROM settings WHERE key = 'demo_lock'").run();
  }
}

const DEMO_HISTORY_DAYS = 30;

/** Seed analytics of the demo: rows for the json_each inserts in resetDemo. */
function seedMetrics(posts: SeedPost[], t: number) {
  const accountById = new Map(Object.values(DEMO_ACCOUNTS).map((a) => [a.id, a]));
  const snapshots: Array<[string, number, string]> = [];
  const latest: Array<[string, string, number | null]> = [];
  for (const p of posts) {
    const provider = getProvider(accountById.get(p.account_id)?.provider ?? "");
    if (p.status !== "published" || !p.published_at || !provider?.postMetrics) continue;
    let last: MetricValues = {};
    for (const at of demoSnapshotTimes(CHECKPOINTS, p.published_at, t)) {
      last = demoPostMetrics(provider, { content: p.content, published_at: p.published_at, playbook_id: p.playbook_id }, at);
      snapshots.push([p.id, at, JSON.stringify(last)]);
    }
    latest.push([p.id, JSON.stringify(withoutDetails(last)), nextCheckpoint(p.published_at, t)]);
  }
  const days: Array<[string, string, number, string]> = [];
  const accounts: Array<[string, string, number]> = [];
  for (const a of Object.values(DEMO_ACCOUNTS)) {
    const provider = getProvider(a.provider);
    if (!provider?.accountMetrics) continue;
    let today: MetricValues = {};
    for (let d = DEMO_HISTORY_DAYS; d >= 0; d--) {
      const at = t - d * 24 * HOUR;
      today = demoAccountMetrics(provider, a.externalId, at);
      days.push([a.id, utcDay(at), at, JSON.stringify(today)]);
    }
    accounts.push([a.id, JSON.stringify(today), nextAccountRun(a.id, t)]);
  }
  return { snapshots, latest, days, accounts };
}

// ---------------------------------------------------------------------------------------------------------------
// Simulated publishing

/** How many more posts visitors may create in the demo workspace today. */
export async function demoPostsLeft(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND created_by = ? AND created_at > ?")
    .bind(workspaceId, DEMO_USER_ID, now() - RESET_EVERY_MS)
    .first<{ n: number }>();
  return DEMO_POSTS_PER_DAY - (row?.n ?? 0);
}

/**
 * "Publish" demo posts (scheduled or publishing ones of demo workspaces only): a fake platform id and URL, and logs
 * like a real publish. Never calls a provider. Returns how many were published.
 */
export async function publishDemoPosts(env: Env, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.thread, p.content, a.provider FROM posts p JOIN accounts a ON a.id = p.account_id JOIN workspaces w ON w.id = p.workspace_id
       WHERE w.is_demo = 1 AND p.status IN ('scheduled', 'publishing') AND p.id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(...ids)
    .all<{ id: string; thread: string; content: string; provider: string }>();
  if (!results.length) return 0;
  const t = now();
  const statements: D1PreparedStatement[] = [];
  const pairs: Array<[string, string]> = [];
  for (const r of results) {
    const external = fakeExternalId();
    pairs.push([r.id, external]);
    const url = fakePostUrl(r.provider, external);
    const name = getProvider(r.provider)?.name ?? r.provider;
    const logs: Array<[string, string, number]> = [
      ["info", SIMULATED_LOG(name), t],
      ["info", `Published: ${url}`, t + 1],
    ];
    parseJson<ThreadItem[]>(r.thread, [])
      .filter((x) => x.content.trim() || x.media.length)
      .forEach((_, i) => logs.push(["info", `Follow-up ${i + 1} published: ${url}/r${i + 1}`, t + 2 + i]));
    statements.push(
      db
        .prepare(
          `UPDATE posts SET status = 'published', external_id = ?, external_url = ?, error = NULL, published_at = ?, updated_at = ?,
             attempts = CASE WHEN status = 'scheduled' THEN attempts + 1 ELSE attempts END, metrics_next_at = ?, metrics_fails = 0
           WHERE id = ? AND status IN ('scheduled', 'publishing')`,
        )
        .bind(external, url, t, t, nextCheckpoint(t, t), r.id),
      // Only if this run won the update above (the random external id is ours).
      db
        .prepare(
          `INSERT INTO post_logs (post_id, level, message, created_at)
           SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)
           WHERE EXISTS (SELECT 1 FROM posts WHERE id = ? AND external_id = ?)`,
        )
        .bind(r.id, JSON.stringify(logs), r.id, external),
    );
  }
  // Usage events (flagged demo, excluded from instance totals): one statement for all, after the updates above.
  statements.push(demoPublishEventsStatement(db, pairs, Object.fromEntries(results.map((r) => [r.id, r.content])), t));
  const res = await db.batch(statements);
  return res.filter((_, i) => i % 2 === 0 && i < statements.length - 1 && res[i].meta.changes > 0).length;
}

/**
 * "Post now" in a demo workspace: the posts go to publishing right away and are published a few seconds later in the
 * background (waitUntil). If that is cut short, `simulateDueDemoPosts` finishes them.
 */
export async function queueDemoPublish(env: Env, waitUntil: (p: Promise<unknown>) => void, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const t = now();
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare("UPDATE posts SET status = 'publishing', error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(t, id),
    ),
  );
  waitUntil(
    new Promise((r) => setTimeout(r, DEMO_PUBLISH_DELAY_MS))
      .then(() => publishDemoPosts(env, ids))
      .catch((err) => console.error("demo publish failed", err)),
  );
}

/** Publish due scheduled demo posts (and finish publishing ones whose background job was cut short). */
export async function simulateDueDemoPosts(env: Env, workspaceId?: string): Promise<number> {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT p.id FROM posts p JOIN workspaces w ON w.id = p.workspace_id
     WHERE w.is_demo = 1 ${workspaceId ? "AND p.workspace_id = ?" : ""}
       AND ((p.status = 'scheduled' AND p.scheduled_at <= ?) OR (p.status = 'publishing' AND p.updated_at < ?))
     LIMIT 50`,
  )
    .bind(...(workspaceId ? [workspaceId] : []), t, t - 30_000)
    .all<{ id: string }>();
  return publishDemoPosts(
    env,
    results.map((r) => r.id),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Dynamic options

const DEMO_OPTIONS: Record<string, FieldOption[]> = {
  board: [
    { value: "demo-board-1", label: "Pocket Plants" },
    { value: "demo-board-2", label: "Tempo: focus & productivity" },
    { value: "demo-board-3", label: "App design inspiration" },
  ],
  boardSection: [
    { value: "", label: "None" },
    { value: "demo-section-1", label: "Launch graphics" },
    { value: "demo-section-2", label: "Screenshots" },
  ],
  playlist: [
    { value: "", label: "None" },
    { value: "demo-playlist-1", label: "Devlogs" },
    { value: "demo-playlist-2", label: "App tours" },
  ],
  category: [
    { value: "22", label: "People & Blogs" },
    { value: "27", label: "Education" },
    { value: "28", label: "Science & Technology" },
    { value: "24", label: "Entertainment" },
  ],
};

/** Fake choices for a `dynamicOptions` field in a demo workspace (the field's static options when it has some). */
export function demoOptions(providerId: string, key: string): FieldOption[] {
  const field = getProvider(providerId)?.settingsFields.find((f) => f.key === key);
  if (!field) return [];
  if (field.options?.length) return field.options;
  if (DEMO_OPTIONS[key]) return DEMO_OPTIONS[key];
  const label = field.label.toLowerCase();
  return [1, 2, 3].map((n) => ({ value: `demo-${key}-${n}`, label: `Demo ${label} ${n}` }));
}
