import { Hono } from "hono";
import type { ApiKeyDTO } from "../../shared/types";
import { enforce } from "../billing/entitlements";
import { createApiKey, forbidDemoUser, isInstanceAdmin, requireInstancePermission, requirePermission, wsId, type AppEnv } from "../lib/auth";
import {
  EXPERIMENTAL_SETTING,
  MEDIA_RETENTION_SETTING,
  WORKSPACE_PROVIDERS_SETTING,
  allowedProvidersInput,
  baseUrl,
  experimentalEnabled,
  getSetting,
  mediaRetentionDays,
  parseAllowedProviders,
  setSetting,
} from "../lib/settings";
import { providers } from "../providers/registry";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/settings", async (c) => {
  return c.json({
    publicUrl: await baseUrl(c.env, c.req.url),
    publicUrlLocked: !!c.env.PUBLIC_URL,
    timezone: (await getSetting(c.env.DB, "timezone")) ?? null,
    encryptionKeyFromSecret: !!c.env.SECRET_KEY,
    experimentalIntegrations: await experimentalEnabled(c.env.DB),
    mediaRetentionDays: await mediaRetentionDays(c.env.DB),
    workspaceProviders: parseAllowedProviders(await getSetting(c.env.DB, WORKSPACE_PROVIDERS_SETTING)),
  });
});

settingsRoutes.put("/settings", requireInstancePermission("instance.settings.manage"), async (c) => {
  const body = await c.req.json<{ publicUrl?: string; timezone?: string; experimentalIntegrations?: boolean; mediaRetentionDays?: number; workspaceProviders?: string[] | null }>();
  const workspaceProviders = body.workspaceProviders === undefined ? undefined : allowedProvidersInput(body.workspaceProviders, providers.map((p) => p.id));
  if (body.workspaceProviders !== undefined && workspaceProviders === undefined) return c.json({ error: "workspaceProviders must be null or an array of platform ids" }, 400);
  if (body.mediaRetentionDays !== undefined) {
    const days = Number(body.mediaRetentionDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) return c.json({ error: "Media retention must be a whole number of days between 0 and 3650" }, 400);
  }
  if (body.publicUrl !== undefined && !c.env.PUBLIC_URL) {
    let url: URL;
    try {
      url = new URL(body.publicUrl);
    } catch {
      return c.json({ error: "Invalid URL" }, 400);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return c.json({ error: "Invalid URL" }, 400);
    await setSetting(c.env.DB, "public_url", url.origin);
  }
  if (body.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: String(body.timezone) });
    } catch {
      return c.json({ error: "Unknown timezone" }, 400);
    }
    await setSetting(c.env.DB, "timezone", String(body.timezone));
  }
  if (body.mediaRetentionDays !== undefined) await setSetting(c.env.DB, MEDIA_RETENTION_SETTING, String(Number(body.mediaRetentionDays)));
  if (body.experimentalIntegrations !== undefined) {
    await setSetting(c.env.DB, EXPERIMENTAL_SETTING, body.experimentalIntegrations === true ? "true" : "false");
  }
  if (workspaceProviders === null) await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(WORKSPACE_PROVIDERS_SETTING).run();
  else if (workspaceProviders) await setSetting(c.env.DB, WORKSPACE_PROVIDERS_SETTING, JSON.stringify(workspaceProviders));
  return c.json({ ok: true });
});

/** API keys of the current workspace: your own (instance admins see every key of the workspace). */
settingsRoutes.get("/keys", requirePermission("apikeys.manage"), async (c) => {
  const all = isInstanceAdmin(c.var.instancePermissions);
  const { results } = await c.env.DB.prepare(
    `SELECT k.id, k.name, k.prefix, k.created_at AS createdAt, k.last_used_at AS lastUsedAt, k.user_id AS userId, u.name AS userName
     FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
     WHERE k.workspace_id = ? ${all ? "" : "AND k.user_id = ?"} ORDER BY k.created_at DESC`,
  )
    .bind(...(all ? [wsId(c)] : [wsId(c), c.var.user.id]))
    .all<ApiKeyDTO>();
  return c.json(results);
});

settingsRoutes.post("/keys", forbidDemoUser, requirePermission("apikeys.manage"), async (c) => {
  // A leaked key must not be able to mint new keys that outlive its revocation.
  if (c.var.auth !== "session") return c.json({ error: "Create API keys in the web app" }, 403);
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: "Name is required" }, 400);
  // Hosted mode: the plan must include API access.
  await enforce(c, { api: 1 });
  return c.json(await createApiKey(c.env, name.trim().slice(0, 100), c.var.user.id, wsId(c)), 201);
});

settingsRoutes.delete("/keys/:id", requirePermission("apikeys.manage"), async (c) => {
  const all = isInstanceAdmin(c.var.instancePermissions);
  const res = await c.env.DB.prepare(`DELETE FROM api_keys WHERE id = ? AND workspace_id = ? ${all ? "" : "AND user_id = ?"}`)
    .bind(...(all ? [c.req.param("id"), wsId(c)] : [c.req.param("id"), wsId(c), c.var.user.id]))
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
