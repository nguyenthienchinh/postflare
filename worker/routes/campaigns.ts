// App Store campaign links: workspace settings (provider token, Revflare connection), apps, tracked links and the
// public redirect GET /a/<code>. Everything is workspace-scoped; settings and apps need workspace.manage, reading
// needs posts.read, bio links posts.write.

import { Hono } from "hono";
import type { AppInput, CampaignSettingsDTO, CampaignSettingsInput, RevflareTestDTO } from "../../shared/types";
import { LINK_CODE_RE, isAppStoreId, isProviderToken } from "../../shared/campaigns";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { findAccount } from "../lib/accounts";
import { appDto, clickStatement, ensureBioLink, findApp, isBot, listLinks, type AppRow } from "../lib/campaigns";
import { encryptJson } from "../lib/crypto";
import { importApps, normalizeRevflareUrl, revflareApps, safeIcon, syncWorkspace, testConnection, workspaceConn } from "../lib/revflare";
import { baseUrl } from "../lib/settings";
import { errorMessage, newId, now } from "../lib/util";

// ---------------------------------------------------------------------------------------------------------------
// Public: GET /a/<code>

export const campaignRedirect = new Hono<AppEnv>();

const notFoundPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link not found</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#3f3f46}main{text-align:center;padding:2rem}h1{font-size:1.25rem}</style></head>
<body><main><h1>Link not found</h1><p>This link does not exist or was removed.</p></main></body></html>`;

/**
 * One indexed read, then a 302 to the App Store campaign link. Counted clicks (not HEAD, not crawlers / link
 * previews / HTTP libraries) add one upsert after the response. Nothing else about the link or its workspace leaks.
 */
campaignRedirect.get("/:code", async (c) => {
  const code = c.req.param("code");
  const row = LINK_CODE_RE.test(code) ? await c.env.DB.prepare("SELECT url FROM campaign_links WHERE code = ?").bind(code).first<{ url: string }>() : null;
  if (!row) {
    c.header("cache-control", "no-store");
    return c.html(notFoundPage, 404);
  }
  if (!isBot(c.req.method, c.req.header("user-agent"))) {
    const write = clickStatement(c.env.DB, code)
      .run()
      .catch((err) => console.error("click not counted", err));
    try {
      c.executionCtx.waitUntil(write);
    } catch {
      await write; // no execution context (tests calling app.fetch directly)
    }
  }
  c.header("cache-control", "private, no-store");
  c.header("referrer-policy", "no-referrer");
  c.header("x-robots-tag", "noindex");
  return c.redirect(row.url, 302);
});

// ---------------------------------------------------------------------------------------------------------------
// Settings

export const campaignRoutes = new Hono<AppEnv>();

interface SettingsRow {
  apple_provider_token: string | null;
  campaign_autolink: number;
  revflare_url: string | null;
  revflare_key_enc: string | null;
  revflare_status: "ok" | "error" | null;
  revflare_message: string | null;
  revflare_synced_at: number | null;
  revflare_next_at: number | null;
  revflare_fails: number;
  revflare_currency: string | null;
  is_demo: number;
}

const SETTINGS_COLUMNS =
  "apple_provider_token, campaign_autolink, revflare_url, revflare_key_enc, revflare_status, revflare_message, revflare_synced_at, revflare_next_at, revflare_fails, revflare_currency, is_demo";

const settingsRow = (db: D1Database, ws: string) => db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM workspaces WHERE id = ?`).bind(ws).first<SettingsRow>();

function settingsDto(r: SettingsRow, base: string): CampaignSettingsDTO {
  return {
    providerToken: r.apple_provider_token,
    autoLink: !!r.campaign_autolink,
    revflare: {
      url: r.revflare_url,
      keyConfigured: !!r.revflare_key_enc,
      status: r.revflare_status,
      message: r.revflare_message,
      syncedAt: r.revflare_synced_at,
      nextSyncAt: r.revflare_key_enc ? r.revflare_next_at : null,
      currency: r.revflare_currency,
    },
    linkBase: `${base}/a/`,
  };
}

/** Postflare itself runs on localhost (dev): a local Revflare may be used. */
const devHost = (url: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

campaignRoutes.get("/campaigns/settings", requirePermission("posts.read"), async (c) => {
  const row = await settingsRow(c.env.DB, wsId(c));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(settingsDto(row, await baseUrl(c.env, c.req.url)));
});

campaignRoutes.put("/campaigns/settings", requirePermission("workspace.manage"), async (c) => {
  const ws = wsId(c);
  const body = await c.req.json<CampaignSettingsInput>().catch(() => ({}) as CampaignSettingsInput);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.providerToken !== undefined) {
    const pt = typeof body.providerToken === "string" ? body.providerToken.trim() : null;
    if (pt && !isProviderToken(pt)) return c.json({ error: "The provider token is the pt= value of an App Store Connect campaign link (digits)" }, 400);
    sets.push("apple_provider_token = ?") && binds.push(pt || null);
  }
  if (body.autoLink !== undefined) sets.push("campaign_autolink = ?") && binds.push(body.autoLink === true ? 1 : 0);
  const removing = body.revflareKey === null || body.revflareKey === "" || body.revflareUrl === null || body.revflareUrl === "";
  if (removing) {
    sets.push("revflare_url = NULL, revflare_key_enc = NULL, revflare_status = NULL, revflare_message = NULL, revflare_next_at = NULL, revflare_fails = 0");
  } else if (body.revflareUrl !== undefined || body.revflareKey !== undefined) {
    if (c.var.workspace?.demo) return c.json({ error: "Revflare cannot be connected in the demo workspace" }, 403);
    const current = await settingsRow(c.env.DB, ws);
    if (body.revflareUrl !== undefined) {
      const u = normalizeRevflareUrl(body.revflareUrl, { allowLocal: devHost(c.req.url) });
      if ("error" in u) return c.json({ error: u.error }, 400);
      sets.push("revflare_url = ?") && binds.push(u.url);
    } else if (!current?.revflare_url) return c.json({ error: "Revflare URL is required" }, 400);
    if (body.revflareKey !== undefined) {
      const key = String(body.revflareKey).trim();
      if (!/^rf_[\w-]{10,200}$/.test(key)) return c.json({ error: "The Revflare API key starts with rf_ (Revflare → Settings → API keys)" }, 400);
      sets.push("revflare_key_enc = ?") && binds.push(await encryptJson(c.env, { key }));
    } else if (!current?.revflare_key_enc) return c.json({ error: "Revflare API key is required" }, 400);
    // New connection details: sync on the next hourly metrics tick.
    sets.push("revflare_status = NULL, revflare_message = NULL, revflare_next_at = NULL, revflare_fails = 0");
  }
  if (sets.length) await c.env.DB.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, ws).run();
  const row = (await settingsRow(c.env.DB, ws))!;
  return c.json(settingsDto(row, await baseUrl(c.env, c.req.url)));
});

/** Test the stored connection, or the URL/key in the body before saving them. */
campaignRoutes.post("/campaigns/test", requirePermission("workspace.manage"), async (c) => {
  if (c.var.workspace?.demo) return c.json({ ok: false, error: "Revflare cannot be connected in the demo workspace" } satisfies RevflareTestDTO);
  const body = await c.req.json<CampaignSettingsInput>().catch(() => ({}) as CampaignSettingsInput);
  const row = await settingsRow(c.env.DB, wsId(c));
  let url = row?.revflare_url ?? null;
  if (body.revflareUrl) {
    const u = normalizeRevflareUrl(body.revflareUrl, { allowLocal: devHost(c.req.url) });
    if ("error" in u) return c.json({ ok: false, error: u.error } satisfies RevflareTestDTO);
    url = u.url;
  }
  let key: string | null = typeof body.revflareKey === "string" && body.revflareKey.trim() ? body.revflareKey.trim() : null;
  if (!key && row?.revflare_key_enc) key = (await workspaceConn(c.env, { revflare_url: url, revflare_key_enc: row.revflare_key_enc }))?.key ?? null;
  if (!url || !key) return c.json({ ok: false, error: "Enter the Revflare URL and an API key first" } satisfies RevflareTestDTO);
  return c.json(await testConnection({ url, key }));
});

campaignRoutes.post("/campaigns/sync", requirePermission("workspace.manage"), async (c) => {
  if (c.var.workspace?.demo) return c.json({ error: "The demo workspace has sample numbers and never calls Revflare" }, 409);
  const row = await c.env.DB.prepare("SELECT id, revflare_url, revflare_key_enc, revflare_fails FROM workspaces WHERE id = ?").bind(wsId(c)).first<{
    id: string;
    revflare_url: string | null;
    revflare_key_enc: string | null;
    revflare_fails: number;
  }>();
  if (!row?.revflare_key_enc || !row.revflare_url) return c.json({ error: "Connect Revflare first" }, 409);
  const r = await syncWorkspace(c.env, row);
  return c.json(r, r.ok ? 200 : 502);
});

// ---------------------------------------------------------------------------------------------------------------
// Apps

campaignRoutes.get("/apps", requirePermission("posts.read"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM workspace_apps WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").bind(wsId(c)).all<AppRow>();
  return c.json(results.map(appDto));
});

/** Public iTunes lookup of an app's name and icon (5 s timeout). Null when unknown or unreachable. */
async function itunesLookup(appStoreId: string): Promise<{ name: string; iconUrl: string | null } | null> {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${appStoreId}`, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<{ trackName?: string; artworkUrl512?: string; artworkUrl100?: string }> };
    const r = data.results?.[0];
    if (!r?.trackName) return null;
    return { name: r.trackName, iconUrl: safeIcon(r.artworkUrl512 ?? r.artworkUrl100) };
  } catch {
    return null;
  }
}

campaignRoutes.post("/apps", requirePermission("workspace.manage"), async (c) => {
  const ws = wsId(c);
  const body = await c.req.json<AppInput>().catch(() => ({}) as AppInput);
  const id = String(body.appStoreId ?? "").trim().replace(/^id/i, "");
  if (!isAppStoreId(id)) return c.json({ error: "appStoreId must be the numeric App Store id (the id<number> in apps.apple.com links)" }, 400);
  let name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  let icon = safeIcon(body.iconUrl);
  if (!name) {
    const found = c.var.workspace?.demo ? null : await itunesLookup(id);
    if (!found) return c.json({ error: `App ${id} was not found on the App Store: give its name` }, 400);
    name = found.name;
    icon ??= found.iconUrl;
  }
  await c.env.DB.prepare(
    `INSERT INTO workspace_apps (id, workspace_id, app_store_id, name, icon_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, app_store_id) DO UPDATE SET name = excluded.name, icon_url = COALESCE(excluded.icon_url, workspace_apps.icon_url)`,
  )
    .bind(newId("app_"), ws, id, name, icon, now())
    .run();
  const row = (await c.env.DB.prepare("SELECT * FROM workspace_apps WHERE workspace_id = ? AND app_store_id = ?").bind(ws, id).first<AppRow>())!;
  return c.json(appDto(row), 201);
});

campaignRoutes.post("/apps/import", requirePermission("workspace.manage"), async (c) => {
  if (c.var.workspace?.demo) return c.json({ error: "The demo workspace never calls Revflare" }, 409);
  const ws = wsId(c);
  const row = await settingsRow(c.env.DB, ws);
  const conn = row ? await workspaceConn(c.env, row) : null;
  if (!conn) return c.json({ error: "Connect Revflare first" }, 409);
  try {
    const imported = await importApps(c.env.DB, ws, await revflareApps(conn));
    const { results } = await c.env.DB.prepare("SELECT * FROM workspace_apps WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").bind(ws).all<AppRow>();
    return c.json({ imported, apps: results.map(appDto) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 502);
  }
});

/** Removes the app from the list; posts lose the tag, existing tracked links keep redirecting. */
campaignRoutes.delete("/apps/:id", requirePermission("workspace.manage"), async (c) => {
  const ws = wsId(c);
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM workspace_apps WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), ws),
    c.env.DB.prepare("UPDATE posts SET app_id = NULL WHERE workspace_id = ? AND app_id = ?").bind(ws, c.req.param("id")),
  ]);
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------------------------
// Links

campaignRoutes.get("/campaigns/links", requirePermission("posts.read"), async (c) => {
  const { postId, accountId, appId, kind, limit } = c.req.query();
  if (kind && kind !== "post" && kind !== "bio") return c.json({ error: "kind must be post or bio" }, 400);
  const links = await listLinks(c.env.DB, wsId(c), await baseUrl(c.env, c.req.url), {
    postId,
    accountId,
    appId,
    kind: kind as "post" | "bio" | undefined,
    limit: Number(limit) || undefined,
  });
  return c.json(links);
});

/** The bio link of an account for an app (created on first use): /a/<code> with ct pf-<platform>-bio. */
campaignRoutes.post("/campaigns/bio-links", requirePermission("posts.write"), async (c) => {
  const ws = wsId(c);
  const body = await c.req.json<{ accountId?: string; appId?: string }>().catch(() => ({}) as { accountId?: string; appId?: string });
  if (!body.accountId || !body.appId) return c.json({ error: "accountId and appId are required" }, 400);
  const [account, app, row] = await Promise.all([
    findAccount(c.env, ws, String(body.accountId)),
    findApp(c.env.DB, ws, String(body.appId)),
    settingsRow(c.env.DB, ws),
  ]);
  if (!account || !app) return c.json({ error: "Not found" }, 404);
  if (!row?.apple_provider_token) return c.json({ error: "Set the Apple provider token in Workspace settings → App Store campaigns first" }, 409);
  const code = await ensureBioLink(c.env.DB, ws, { id: account.id, provider: account.provider }, { id: app.id, appStoreId: app.app_store_id }, row.apple_provider_token);
  const [link] = await listLinks(c.env.DB, ws, await baseUrl(c.env, c.req.url), { accountId: account.id, appId: app.id, kind: "bio", limit: 1 });
  return c.json(link ?? { code }, 201);
});
