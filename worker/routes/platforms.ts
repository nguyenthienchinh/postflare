import { Hono } from "hono";
import { requireInstancePermission, type AppEnv } from "../lib/auth";
import { encryptJson } from "../lib/crypto";
import { getAppConfig } from "../lib/accounts";
import { META_PROVIDERS, dataDeletionUri } from "../lib/meta-deletion";
import { baseUrl, experimentalEnabled, providerAllowed } from "../lib/settings";
import { now } from "../lib/util";
import { getProvider, providerInfo, providers, redirectUriFor } from "../providers/registry";

export const platformRoutes = new Hono<AppEnv>();

/**
 * All providers with whether their developer app is configured and whether new accounts can be connected (`enabled`:
 * false for experimental providers while experimental integrations are off). Disabled ones stay listed so already
 * connected accounts keep their metadata.
 */
platformRoutes.get("/providers", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT provider FROM platform_apps").all<{ provider: string }>();
  const configured = new Set(results.map((r) => r.provider));
  const base = await baseUrl(c.env, c.req.url);
  const experimental = await experimentalEnabled(c.env.DB);
  const allowed = c.var.workspace?.allowedProviders ?? null;
  return c.json(
    providers.map((p) => ({
      ...providerInfo(p),
      configured: !p.appFields.some((f) => f.required) || configured.has(p.id),
      redirectUri: redirectUriFor(base, p),
      // Meta apps also ask for a data deletion callback URL.
      ...((META_PROVIDERS as readonly string[]).includes(p.id) && { dataDeletionUri: dataDeletionUri(base) }),
      enabled: p.status !== "experimental" || experimental,
      // The current workspace may connect it and post to it (workspaces.allowed_providers).
      allowed: providerAllowed(allowed, p.id),
    })),
  );
});

const manage = requireInstancePermission("instance.platforms.manage");

platformRoutes.get("/platforms/:id", manage, async (c) => {
  const provider = getProvider(c.req.param("id"));
  if (!provider) return c.json({ error: "Unknown provider" }, 404);
  const config = await getAppConfig(c.env, provider.id);
  const values: Record<string, string> = {};
  for (const f of provider.appFields) {
    const v = config[f.key];
    if (v) values[f.key] = f.type === "password" ? "••••••••" + v.slice(-4) : v;
  }
  return c.json({ values, redirectUri: redirectUriFor(await baseUrl(c.env, c.req.url), provider) });
});

platformRoutes.put("/platforms/:id", manage, async (c) => {
  const provider = getProvider(c.req.param("id"));
  if (!provider) return c.json({ error: "Unknown provider" }, 404);
  const { values } = await c.req.json<{ values: Record<string, string> }>();
  const current = await getAppConfig(c.env, provider.id);
  const next: Record<string, string> = {};
  for (const f of provider.appFields) {
    const v = (values?.[f.key] ?? "").trim();
    // Masked secrets come back unchanged from the form: keep the stored value.
    next[f.key] = v.startsWith("••••") ? current[f.key] ?? "" : v;
    if (f.required && !next[f.key]) return c.json({ error: `${f.label} is required` }, 400);
  }
  await c.env.DB.prepare(
    "INSERT INTO platform_apps (provider, config_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET config_enc = excluded.config_enc, updated_at = excluded.updated_at",
  )
    .bind(provider.id, await encryptJson(c.env, next), now())
    .run();
  return c.json({ ok: true });
});

platformRoutes.delete("/platforms/:id", manage, async (c) => {
  await c.env.DB.prepare("DELETE FROM platform_apps WHERE provider = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
