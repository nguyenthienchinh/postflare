// Sign in on the web with the iOS app (docs/app-login-spec.md): the browser starts a "web login request" (QR code, or
// a push with number matching), the signed-in app approves it, the browser's poll then gets a normal session cookie.
// Mounted at /api/auth/app-login, before requireAuth: browser endpoints are public (poll secret), app endpoints check
// the device token themselves.

import { Hono, type Context } from "hono";
import type { AppLoginInspectDTO, AppLoginPollDTO, AppLoginStartDTO } from "../../shared/types";
import { createSession, deviceUser, throttleIp, type AppEnv } from "../lib/auth";
import { apnsConfigured, pushAlert, webLoginAlert, type PushDevice } from "../lib/push";
import { baseUrl } from "../lib/settings";
import { normalizeEmail } from "../lib/users";
import { newId, now, randomToken, sha256Hex } from "../lib/util";
import { appDevices, botCheck } from "./auth";

type Ctx = Context<AppEnv>;

export const appLoginRoutes = new Hono<AppEnv>();

export const WEB_LOGIN_TTL_MS = 3 * 60_000;
/** An approved request can still be picked up by the polling browser for this long after its expiry. */
const PICKUP_GRACE_MS = 60_000;
const START_WINDOW_MS = 10 * 60_000;
const MAX_STARTS_IP = 10;
const MAX_PUSH_EMAIL = 3;
const NOT_AVAILABLE = "Signing in with the iPhone app is not available on this instance";
const GONE = "This sign-in request has expired or was already used. Show a new code on the computer.";

interface WebLoginRow {
  id: string;
  secret_hash: string;
  nonce_hash: string;
  user_id: string | null;
  kind: "qr" | "push";
  number: number | null;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  ip: string | null;
  city: string | null;
  country: string | null;
  user_agent: string | null;
  created_at: number;
  expires_at: number;
}

/** "Chrome" / "macOS" from a User-Agent (shown in the app and in the push). */
export function describeAgent(ua: string | null | undefined): { browser: string; os: string } {
  const s = ua ?? "";
  const browser = /Edg(e|A|iOS)?\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(s)
        ? "Firefox"
        : /SamsungBrowser/.test(s)
          ? "Samsung Internet"
          : /Chrome\/|CriOS/.test(s)
            ? "Chrome"
            : /Safari\//.test(s)
              ? "Safari"
              : "Browser";
  const os = /iPad/.test(s)
    ? "iPadOS"
    : /iPhone|iPod/.test(s)
      ? "iOS"
      : /Android/.test(s)
        ? "Android"
        : /CrOS/.test(s)
          ? "ChromeOS"
          : /Macintosh|Mac OS X/.test(s)
            ? "macOS"
            : /Windows/.test(s)
              ? "Windows"
              : /Linux/.test(s)
                ? "Linux"
                : "Unknown OS";
  return { browser, os };
}

const location = (r: Pick<WebLoginRow, "city" | "country" | "ip">) => [r.city, r.country].filter(Boolean).join(", ") || r.ip || "Unknown location";

/**
 * Fixed-window counters in settings (`app_login:*`, cleaned by the daily job): every key +1 in one batch; returns the
 * new counts. Counts every request, like the sign-in link throttle.
 */
async function bumpCounters(db: D1Database, keys: string[]): Promise<number[]> {
  const t = now();
  const res = await db.batch<{ n: number }>(
    keys.map((key) =>
      db
        .prepare(
          `INSERT INTO settings (key, value) VALUES (?, json_object('n', 1, 'until', ?)) ON CONFLICT(key) DO UPDATE SET value =
             CASE WHEN json_extract(value, '$.until') > ? THEN json_set(value, '$.n', json_extract(value, '$.n') + 1) ELSE excluded.value END
           RETURNING json_extract(value, '$.n') AS n`,
        )
        .bind(key, t + START_WINDOW_MS, t),
    ),
  );
  return res.map((r) => Number(r.results[0]?.n ?? 0));
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const validId = (id: string | undefined) => !!id && /^wl_[\w-]{10,40}$/.test(id);

// ---------- Browser ----------

/** POST { kind: "qr" } or { kind: "push", email, turnstileToken? }: a new request, its poll secret, the QR or number. */
appLoginRoutes.post("/", async (c) => {
  const body = await c.req.json<{ kind?: unknown; email?: unknown; turnstileToken?: unknown }>().catch(() => ({}) as { kind?: unknown; email?: unknown; turnstileToken?: unknown });
  const kind = body.kind === "push" ? "push" : body.kind === "qr" || body.kind === undefined ? "qr" : null;
  if (!kind) return c.json({ error: "kind must be qr or push" }, 400);
  const db = c.env.DB;
  const devices = await appDevices(db);
  if (!c.env.APP_STORE_URL && !devices.any) return c.json({ error: NOT_AVAILABLE }, 404);
  if (kind === "push" && !apnsConfigured(c.env)) return c.json({ error: "Push sign-in requests are not configured on this instance" }, 404);
  const email = kind === "push" ? normalizeEmail(body.email) : null;
  if (kind === "push" && !email) return c.json({ error: "A valid email is required" }, 400);
  const ip = c.req.header("cf-connecting-ip") ?? null;
  const [ipN, emailN = 0] = await bumpCounters(db, [`app_login:${throttleIp(ip)}`, ...(email ? [`app_login:email:${email.toLowerCase()}`] : [])]);
  if (ipN > MAX_STARTS_IP || emailN > MAX_PUSH_EMAIL) return c.json({ error: "Too many sign-in requests. Try again in 10 minutes." }, 429);
  if (kind === "push") {
    const blocked = await botCheck(c, "app_login", body.turnstileToken);
    if (blocked) return blocked;
  }

  const id = newId("wl_");
  const secret = randomToken(32);
  const nonce = randomToken(16);
  const number = kind === "push" ? 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90) : null;
  const cf = (c.req.raw as Request & { cf?: { city?: string; country?: string } }).cf;
  const t = now();
  const expiresAt = t + WEB_LOGIN_TTL_MS;
  const ua = (c.req.header("user-agent") ?? "").slice(0, 300) || null;
  await db
    .prepare(
      `INSERT INTO web_logins (id, secret_hash, nonce_hash, user_id, kind, number, status, ip, city, country, user_agent, created_at, expires_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, await sha256Hex(secret), await sha256Hex(nonce), kind, number, ip, cf?.city ?? null, cf?.country ?? null, ua, t, expiresAt)
    .run();

  if (kind === "push") {
    // Same answer whether or not the email has an account or devices: the lookup and the pushes happen after it.
    const env = c.env;
    const agent = describeAgent(ua);
    const where = location({ city: cf?.city ?? null, country: cf?.country ?? null, ip });
    c.executionCtx.waitUntil(
      (async () => {
        const [, targets] = await db.batch<PushDevice>([
          db.prepare("UPDATE web_logins SET user_id = (SELECT id FROM users WHERE email = ? AND status = 'active' AND is_demo = 0) WHERE id = ?").bind(email, id),
          db
            .prepare(
              `SELECT d.id, d.apns_token, d.environment FROM users u JOIN devices d ON d.user_id = u.id AND d.apns_token IS NOT NULL
               JOIN sessions s ON s.id = d.session_id AND s.kind = 'device' AND s.expires_at > ?
               WHERE u.email = ? AND u.status = 'active' AND u.is_demo = 0 ORDER BY s.last_used_at DESC LIMIT 10`,
            )
            .bind(t, email),
        ]);
        if (targets.results.length) await pushAlert(env, db, targets.results, webLoginAlert(id, agent.browser, agent.os, where, expiresAt));
      })().catch((err) => console.error("web login push failed", err?.message ?? err)),
    );
    const out: AppLoginStartDTO = { id, secret, number: number!, expiresAt };
    return c.json(out);
  }
  const server = await baseUrl(c.env, c.req.url);
  const out: AppLoginStartDTO = { id, secret, qr: `postflare://web-login?s=${encodeURIComponent(server)}&r=${id}&k=${nonce}`, expiresAt };
  return c.json(out);
});

/** The request of the browser holding its secret (X-Login-Secret), or null (unknown id or wrong secret: 404). */
async function browserRequest(c: Ctx): Promise<{ row: WebLoginRow; secretHash: string } | null> {
  const id = c.req.param("id");
  const secret = c.req.header("x-login-secret") ?? "";
  if (!validId(id) || !secret) return null;
  const row = await c.env.DB.prepare("SELECT * FROM web_logins WHERE id = ?").bind(id).first<WebLoginRow>();
  const secretHash = await sha256Hex(secret);
  if (!row || !sameHash(row.secret_hash, secretHash)) return null;
  return { row, secretHash };
}

/**
 * GET (poll, every 2 s while the page is visible) → { status }. Once the app approved, this very response signs the
 * browser in (session cookie) and the request is consumed: atomically, so it works once.
 */
appLoginRoutes.get("/:id", async (c) => {
  const r = await browserRequest(c);
  if (!r) return c.json({ error: "Not found" }, 404);
  const { row } = r;
  const t = now();
  if (row.status === "approved") {
    const claimed = await c.env.DB.prepare(
      "UPDATE web_logins SET status = 'consumed' WHERE id = ? AND status = 'approved' AND secret_hash = ? AND expires_at > ? RETURNING user_id",
    )
      .bind(row.id, r.secretHash, t - PICKUP_GRACE_MS)
      .first<{ user_id: string | null }>();
    const user = claimed?.user_id
      ? await c.env.DB.prepare("SELECT status, is_demo FROM users WHERE id = ?").bind(claimed.user_id).first<{ status: string; is_demo: number }>()
      : null;
    if (claimed && user?.status === "active" && !user.is_demo) {
      await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(t, claimed.user_id).run();
      await createSession(c, claimed.user_id!);
      const out: AppLoginPollDTO = { status: "signed_in", expiresAt: row.expires_at };
      return c.json(out);
    }
    const out: AppLoginPollDTO = { status: claimed ? "denied" : "expired", expiresAt: row.expires_at };
    return c.json(out);
  }
  const status = row.status === "pending" && row.expires_at <= t ? "expired" : row.status;
  const out: AppLoginPollDTO = { status: status as AppLoginPollDTO["status"], expiresAt: row.expires_at };
  return c.json(out);
});

/** DELETE (secret header): the browser cancels ("Show a new code", leaving the panel). */
appLoginRoutes.delete("/:id", async (c) => {
  const r = await browserRequest(c);
  if (!r) return c.json({ error: "Not found" }, 404);
  await c.env.DB.prepare("UPDATE web_logins SET status = 'expired' WHERE id = ? AND status IN ('pending', 'approved')").bind(r.row.id).run();
  return c.json({ ok: true });
});

// ---------- App (device token of the approving user) ----------

/**
 * The request as the calling device may see it: QR requests need their nonce (proof the QR was scanned), push requests
 * must target the device's user. Anything else answers 404, so ids cannot be probed. 401 without a device token.
 */
async function appRequest(c: Ctx, nonce: unknown): Promise<{ row: WebLoginRow; userId: string; deviceId: string | null } | Response> {
  const device = await deviceUser(c.env, c.req.header("authorization"));
  if (!device) return c.json({ error: "Sign in to the Postflare app first" }, 401);
  const id = c.req.param("id");
  const row = validId(id) ? await c.env.DB.prepare("SELECT * FROM web_logins WHERE id = ?").bind(id).first<WebLoginRow>() : null;
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.kind === "qr" && (typeof nonce !== "string" || !sameHash(row.nonce_hash, await sha256Hex(nonce)))) return c.json({ error: "Not found" }, 404);
  if (row.kind === "push" && row.user_id !== device.user.id) return c.json({ error: "Not found" }, 404);
  return { row, userId: device.user.id, deviceId: device.deviceId };
}

const live = (row: WebLoginRow) => row.status === "pending" && row.expires_at > now();

/** The right number and two different decoys, shuffled: stable for a request, unknown to anyone without the device. */
async function numberChoices(row: WebLoginRow): Promise<number[]> {
  const hex = await sha256Hex(`${row.id}:${row.nonce_hash}`);
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  const out = [row.number!];
  for (const b of bytes) {
    const n = 10 + (b % 90);
    if (!out.includes(n)) out.push(n);
    if (out.length === 3) break;
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = bytes[i + 8] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** POST /:id/inspect { nonce? }: where the request comes from, for the approval sheet. 410 once it is not pending. */
appLoginRoutes.post("/:id/inspect", async (c) => {
  const body = await c.req.json<{ nonce?: unknown }>().catch(() => ({}) as { nonce?: unknown });
  const r = await appRequest(c, body.nonce);
  if (r instanceof Response) return r;
  const { row } = r;
  if (!live(row)) return c.json({ error: GONE }, 410);
  const agent = describeAgent(row.user_agent);
  const out: AppLoginInspectDTO = {
    kind: row.kind,
    ip: row.ip,
    city: row.city,
    country: row.country,
    browser: agent.browser,
    os: agent.os,
    server: await baseUrl(c.env, c.req.url),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.kind === "push" ? { numbers: await numberChoices(row) } : {}),
  };
  return c.json(out);
});

/**
 * POST /:id/approve { nonce?, number? } (after Face ID in the app). QR: the nonce must match. Push: the number must be
 * the one on the web page, a wrong one denies the request (403). 410 when expired or no longer pending.
 */
appLoginRoutes.post("/:id/approve", async (c) => {
  const body = await c.req.json<{ nonce?: unknown; number?: unknown }>().catch(() => ({}) as { nonce?: unknown; number?: unknown });
  const r = await appRequest(c, body.nonce);
  if (r instanceof Response) return r;
  const { row } = r;
  const db = c.env.DB;
  if (!live(row)) return c.json({ error: GONE }, 410);
  if (row.kind === "push" && Number(body.number) !== row.number) {
    await db.prepare("UPDATE web_logins SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(row.id).run();
    return c.json({ error: "That was not the number shown on the computer. The sign-in request was denied." }, 403);
  }
  const res = await db
    .prepare(
      `UPDATE web_logins SET status = 'approved', user_id = ?, approved_device_id = ? WHERE id = ? AND status = 'pending' AND expires_at > ?
         AND (kind = 'qr' OR user_id = ?)`,
    )
    .bind(r.userId, r.deviceId, row.id, now(), r.userId)
    .run();
  if (!res.meta.changes) return c.json({ error: GONE }, 410);
  return c.json({ ok: true });
});

/** POST /:id/deny: the user did not start this sign-in. */
appLoginRoutes.post("/:id/deny", async (c) => {
  const body = await c.req.json<{ nonce?: unknown }>().catch(() => ({}) as { nonce?: unknown });
  const r = await appRequest(c, body.nonce);
  if (r instanceof Response) return r;
  if (r.row.status === "denied") return c.json({ ok: true });
  if (!live(r.row)) return c.json({ error: GONE }, 410);
  await c.env.DB.prepare("UPDATE web_logins SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(r.row.id).run();
  return c.json({ ok: true });
});
