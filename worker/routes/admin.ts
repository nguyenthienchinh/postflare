import { Hono } from "hono";
import type { AdminEmailDTO, AdminLegalDTO, AdminTurnstileDTO, AdminTurnstileInput, TurnstileTestDTO } from "../../shared/types";
import { adminOverview } from "../lib/admin-overview";
import { requireInstancePermission, type AppEnv } from "../lib/auth";
import { LEGAL_SETTING, legalFromRows, parseLegalInput } from "../lib/legal";
import { MAGIC_LINK_SETTING, emailConfigured, sendEmail, testEmail } from "../lib/email";
import { baseUrl, getSetting, setSetting } from "../lib/settings";
import { saveTurnstileConfig, testTurnstileSecret, turnstileConfig, validTurnstileKey } from "../lib/turnstile";

/** Instance administration pages that are not about users, plus the email (sign-in links) settings. */
export const adminRoutes = new Hono<AppEnv>();

/** GET /api/admin/overview?days=30 (1-90): one D1 batch of aggregate queries. */
adminRoutes.get("/admin/overview", requireInstancePermission("instance.overview.view"), async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await adminOverview(c.env, Number(c.req.query("days") ?? 30)));
});

// ---------- Sign-in links by email (Cloudflare Email Sending): off until an instance admin turns them on ----------

const manageSettings = requireInstancePermission("instance.settings.manage");
const NOT_CONFIGURED =
  "Email is not set up: add the send_email binding EMAIL and the EMAIL_FROM var in wrangler.local.jsonc, then deploy. Sending to any address needs Cloudflare Workers Paid ($5/month) and a domain onboarded to Cloudflare Email Sending (on the Free plan emails only reach your account's verified addresses).";

async function emailState(env: Env): Promise<AdminEmailDTO> {
  return { configured: emailConfigured(env), from: env.EMAIL_FROM?.trim() || null, enabled: (await getSetting(env.DB, MAGIC_LINK_SETTING)) === "1" };
}

adminRoutes.get("/admin/email", manageSettings, async (c) => c.json(await emailState(c.env)));

/** PATCH /api/admin/email {enabled}: turning it off also ends every outstanding link (deleted; verify answers 404 while off). */
adminRoutes.patch("/admin/email", manageSettings, async (c) => {
  const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({}) as { enabled?: unknown });
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
  if (body.enabled && !emailConfigured(c.env)) return c.json({ error: NOT_CONFIGURED }, 400);
  if (body.enabled) await setSetting(c.env.DB, MAGIC_LINK_SETTING, "1");
  else {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(MAGIC_LINK_SETTING),
      c.env.DB.prepare("DELETE FROM magic_links WHERE purpose = 'login'"),
    ]);
  }
  return c.json(await emailState(c.env));
});

/** POST /api/admin/email/test: a test email to the signed-in admin's own address, sent before answering (errors → 502). */
adminRoutes.post("/admin/email/test", manageSettings, async (c) => {
  if (!emailConfigured(c.env)) return c.json({ error: NOT_CONFIGURED }, 400);
  const to = c.var.user.email;
  try {
    await sendEmail(c.env, testEmail(to, new URL(await baseUrl(c.env, c.req.url)).host));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return c.json({ error: `Sending failed${e?.code ? ` (${e.code})` : ""}: ${e?.message ?? String(err)}` }, 502);
  }
  return c.json({ ok: true, to });
});

// ---------- Bot protection (Cloudflare Turnstile): off until both keys are set here or in the env ----------

async function turnstileState(env: Env): Promise<AdminTurnstileDTO> {
  const cfg = await turnstileConfig(env);
  return { configured: !!cfg.siteKey && cfg.secretSet, siteKey: cfg.siteKey, siteKeyFromEnv: cfg.siteKeyFromEnv, secretSet: cfg.secretSet, secretFromEnv: cfg.secretFromEnv };
}

adminRoutes.get("/admin/turnstile", manageSettings, async (c) => c.json(await turnstileState(c.env)));

/** PUT /api/admin/turnstile {siteKey, secretKey?}: an empty secret keeps the stored one. Keys set by the env cannot be changed here. */
adminRoutes.put("/admin/turnstile", manageSettings, async (c) => {
  const body = await c.req.json<AdminTurnstileInput>().catch(() => ({}) as AdminTurnstileInput);
  const siteKey = typeof body.siteKey === "string" ? body.siteKey.trim() : "";
  const secretKey = typeof body.secretKey === "string" ? body.secretKey.trim() : "";
  const cfg = await turnstileConfig(c.env);
  if (!cfg.siteKeyFromEnv && !validTurnstileKey(siteKey)) return c.json({ error: "Enter the widget's site key (from Cloudflare dashboard → Turnstile)" }, 400);
  if (!cfg.secretFromEnv && secretKey && !validTurnstileKey(secretKey)) return c.json({ error: "That does not look like a Turnstile secret key" }, 400);
  if (!cfg.secretFromEnv && !secretKey && !cfg.secretSet) return c.json({ error: "Enter the widget's secret key" }, 400);
  await saveTurnstileConfig(c.env, { ...(cfg.siteKeyFromEnv ? {} : { siteKey }), ...(cfg.secretFromEnv || !secretKey ? {} : { secretKey }) });
  return c.json(await turnstileState(c.env));
});

/** DELETE /api/admin/turnstile: removes the stored keys (the bot check stays on while the env sets both). */
adminRoutes.delete("/admin/turnstile", manageSettings, async (c) => {
  await saveTurnstileConfig(c.env, { siteKey: null, secretKey: null });
  return c.json(await turnstileState(c.env));
});

/** POST /api/admin/turnstile/test {secretKey?}: checks the given secret (before saving) or the effective one. */
adminRoutes.post("/admin/turnstile/test", manageSettings, async (c) => {
  const body = await c.req.json<{ secretKey?: unknown }>().catch(() => ({}) as { secretKey?: unknown });
  const cfg = await turnstileConfig(c.env, { secret: true });
  const given = typeof body.secretKey === "string" && !cfg.secretFromEnv ? body.secretKey.trim() : "";
  const secret = given || cfg.secretKey;
  if (!secret) return c.json({ error: cfg.secretSet ? "The stored secret key cannot be decrypted (SECRET_KEY changed?): enter it again" : "Enter the secret key first" }, 400);
  const out: TurnstileTestDTO = await testTurnstileSecret(secret);
  return c.json(out);
});

// ---------- Legal & contact: the operator shown on /privacy/, /terms/ and /data-deletion/ (worker/lib/legal.ts) ----------

async function legalState(db: D1Database): Promise<AdminLegalDTO> {
  const keys = Object.values(LEGAL_SETTING);
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(", ")})`).bind(...keys).all<{ key: string; value: string }>();
  return legalFromRows(new Map(results.map((r) => [r.key, r.value])));
}

adminRoutes.get("/admin/legal", manageSettings, async (c) => c.json(await legalState(c.env.DB)));

/** PUT /api/admin/legal {operatorName?, contactEmail?, postalAddress?, country?, effectiveDate?}: "" or null clears a value. */
adminRoutes.put("/admin/legal", manageSettings, async (c) => {
  const parsed = parseLegalInput(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const db = c.env.DB;
  const statements = (Object.entries(parsed.values) as [keyof AdminLegalDTO, string | null][]).map(([key, value]) =>
    value === null
      ? db.prepare("DELETE FROM settings WHERE key = ?").bind(LEGAL_SETTING[key])
      : db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(LEGAL_SETTING[key], value),
  );
  if (statements.length) await db.batch(statements);
  return c.json(await legalState(db));
});
