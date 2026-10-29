// iOS app installs of the signed-in user (docs/ios-api.md): pairing codes (QR on the web Profile page), the device list
// with revoke, and the calling device's push registration and notification preferences. User-scoped, not workspace-
// scoped: a device follows its user into every workspace.

import { Hono, type Context } from "hono";
import type { DeviceDTO, PairingCodeDTO, PairingStatusDTO } from "../../shared/types";
import { forbidDemoUser, type AppEnv } from "../lib/auth";
import { apnsConfigured, cleanPrefs, parsePrefs, PUSH_KEYS, pushAlert } from "../lib/push";
import { baseUrl } from "../lib/settings";
import { normalizeName } from "../lib/users";
import { newId, now, sha256Hex } from "../lib/util";

type Ctx = Context<AppEnv>;

export const deviceRoutes = new Hono<AppEnv>();

const PAIRING_TTL_MS = 5 * 60_000;
/** No 0/O, 1/I: easy to type from the screen. 10 characters = 50 bits. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface DeviceRow {
  id: string;
  name: string | null;
  apns_token: string | null;
  environment: "production" | "sandbox";
  prefs: string;
  created_at: number;
  last_push_at: number | null;
  last_used_at: number | null;
}

const DEVICE_COLUMNS = "d.id, d.name, d.apns_token, d.environment, d.prefs, d.created_at, d.last_push_at, s.last_used_at";

const toDevice = (d: DeviceRow, currentId?: string): DeviceDTO => ({
  id: d.id,
  name: d.name,
  push: !!d.apns_token,
  environment: d.environment,
  prefs: parsePrefs(d.prefs),
  createdAt: d.created_at,
  lastSeenAt: d.last_used_at,
  lastPushAt: d.last_push_at,
  ...(currentId === d.id ? { current: true as const } : {}),
});

/** Signed-in devices of the user (rows whose device token was revoked or expired are left out). */
function deviceQuery(c: Ctx, extra = "") {
  return c.env.DB.prepare(
    `SELECT ${DEVICE_COLUMNS} FROM devices d JOIN sessions s ON s.id = d.session_id AND s.kind = 'device' AND s.expires_at > ?
     WHERE d.user_id = ? ${extra}`,
  );
}

async function currentDevice(c: Ctx): Promise<DeviceRow | null> {
  if (!c.var.deviceId) return null;
  return deviceQuery(c, "AND d.id = ?").bind(now(), c.var.user.id, c.var.deviceId).first<DeviceRow>();
}

const appOnly = (c: Ctx) => c.json({ error: "Only the Postflare iOS app can do this (with its device token)" }, 403);

/** POST /api/pairing-codes (web session): a single-use code for the app, as QR payload and as text. 5 minutes. */
deviceRoutes.post("/pairing-codes", forbidDemoUser, async (c) => {
  if (c.var.auth !== "session") return c.json({ error: "Pairing codes are created in the web app" }, 403);
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const id = newId("pc_");
  const t = now();
  const expiresAt = t + PAIRING_TTL_MS;
  await c.env.DB.prepare("INSERT INTO pairing_codes (id, code_hash, user_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(code), c.var.user.id, c.var.workspace?.id ?? null, t, expiresAt)
    .run();
  const server = await baseUrl(c.env, c.req.url);
  const out: PairingCodeDTO = { id, code, url: `postflare://pair?s=${encodeURIComponent(server)}&c=${code}`, expiresAt };
  return c.json(out, 201);
});

/** GET /api/pairing-codes/:id: polled by the web page until the app used the code. */
deviceRoutes.get("/pairing-codes/:id", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT p.expires_at, p.used_at, d.name AS device_name FROM pairing_codes p LEFT JOIN devices d ON d.id = p.device_id
     WHERE p.id = ? AND p.user_id = ?`,
  )
    .bind(c.req.param("id"), c.var.user.id)
    .first<{ expires_at: number; used_at: number | null; device_name: string | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  const out: PairingStatusDTO = row.used_at
    ? { status: "used", deviceName: row.device_name, expiresAt: row.expires_at }
    : { status: row.expires_at > now() ? "pending" : "expired", deviceName: null, expiresAt: row.expires_at };
  return c.json(out);
});

/** GET /api/devices: the user's signed-in app installs (newest first); `current` marks the calling device. */
deviceRoutes.get("/devices", async (c) => {
  const { results } = await deviceQuery(c, "ORDER BY d.created_at DESC").bind(now(), c.var.user.id).all<DeviceRow>();
  return c.json({ items: results.map((d) => toDevice(d, c.var.deviceId)), push: apnsConfigured(c.env) });
});

/**
 * PUT /api/devices/me (the app, device token): registers or updates the push token of this install, its name,
 * environment and preferences. `apnsToken: null` turns push off. A token registered by another install (the phone
 * was signed in again, or switched accounts) moves here.
 */
deviceRoutes.put("/devices/me", async (c) => {
  if (c.var.auth !== "device" || !c.var.deviceId) return appOnly(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const current = await currentDevice(c);
  if (!current) return c.json({ error: "Device not found" }, 404);
  let token: string | null | undefined;
  if (body.apnsToken === null) token = null;
  else if (body.apnsToken !== undefined) {
    if (typeof body.apnsToken !== "string" || !/^[0-9a-f]{32,200}$/i.test(body.apnsToken)) return c.json({ error: "apnsToken must be the hex device token" }, 400);
    token = body.apnsToken.toLowerCase();
  }
  if (body.environment !== undefined && body.environment !== "production" && body.environment !== "sandbox") {
    return c.json({ error: "environment must be production or sandbox" }, 400);
  }
  const environment = (body.environment as DeviceRow["environment"] | undefined) ?? current.environment;
  const name = body.name === undefined ? current.name : (normalizeName(body.name) ?? current.name);
  const prefs = cleanPrefs(body.prefs, parsePrefs(current.prefs));
  const t = now();
  const db = c.env.DB;
  await db.batch([
    ...(token ? [db.prepare("UPDATE devices SET apns_token = NULL, updated_at = ? WHERE apns_token = ? AND id != ?").bind(t, token, current.id)] : []),
    db
      .prepare(`UPDATE devices SET ${token === undefined ? "" : "apns_token = ?, "}environment = ?, name = ?, prefs = ?, updated_at = ? WHERE id = ?`)
      .bind(...(token === undefined ? [] : [token]), environment, name, JSON.stringify(prefs), t, current.id),
    db.prepare("UPDATE sessions SET name = ? WHERE id = ?").bind(name, c.var.sessionId!),
  ]);
  return c.json(toDevice((await currentDevice(c))!, c.var.deviceId));
});

/** PATCH /api/devices/me/prefs (the app): notification preferences of this install; unknown fields are ignored. */
deviceRoutes.patch("/devices/me/prefs", async (c) => {
  if (c.var.auth !== "device" || !c.var.deviceId) return appOnly(c);
  const body = await c.req.json<unknown>().catch(() => ({}));
  const current = await currentDevice(c);
  if (!current) return c.json({ error: "Device not found" }, 404);
  const src = body && typeof body === "object" && "prefs" in body ? (body as { prefs: unknown }).prefs : body;
  const prefs = cleanPrefs(src, parsePrefs(current.prefs));
  await c.env.DB.prepare("UPDATE devices SET prefs = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(prefs), now(), current.id).run();
  return c.json(toDevice({ ...current, prefs: JSON.stringify(prefs) }, c.var.deviceId));
});

/** POST /api/devices/:id/test ("me" = the calling device): a test notification. */
deviceRoutes.post("/devices/:id/test", async (c) => {
  const id = c.req.param("id") === "me" ? c.var.deviceId : c.req.param("id");
  const d = id ? await deviceQuery(c, "AND d.id = ?").bind(now(), c.var.user.id, id).first<DeviceRow>() : null;
  if (!d) return c.json({ error: "Device not found" }, 404);
  if (!apnsConfigured(c.env)) return c.json({ error: "Push is not configured on this server (APNS_* settings)" }, 400);
  if (!d.apns_token) return c.json({ error: "This device has not turned on notifications" }, 400);
  const r = await pushAlert(c.env, c.env.DB, [{ id: d.id, apns_token: d.apns_token, environment: d.environment }], {
    titleKey: PUSH_KEYS.testTitle,
    titleArgs: [],
    bodyKey: PUSH_KEYS.testBody,
    bodyArgs: [],
    title: "Postflare",
    body: "Notifications work.",
    threadId: "test",
    data: { type: "test" },
  });
  return r.sent ? c.json({ ok: true }) : c.json({ error: r.removed ? "Apple says this device token is no longer valid" : "Apple did not accept the push" }, 502);
});

/** DELETE /api/devices/:id: signs the install out (its device token stops working at once) and ends its push. */
deviceRoutes.delete("/devices/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id") === "me" ? c.var.deviceId : c.req.param("id");
  const d = id ? await db.prepare("SELECT session_id FROM devices WHERE id = ? AND user_id = ?").bind(id, c.var.user.id).first<{ session_id: string }>() : null;
  if (!d) return c.json({ error: "Device not found" }, 404);
  await db.batch([db.prepare("DELETE FROM devices WHERE id = ?").bind(id), db.prepare("DELETE FROM sessions WHERE id = ? AND kind = 'device'").bind(d.session_id)]);
  return c.json({ ok: true });
});
