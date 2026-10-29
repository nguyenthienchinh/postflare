import { Hono, type Context } from "hono";
import type { AuthStatusDTO, DeviceTokenDTO, SetupInput, SignupDTO, SignupInput } from "../../shared/types";
import { signupEnabled } from "../billing/config";
import { trialStatements } from "../billing/entitlements";
import { createDeviceSession, createSession, destroySession, deviceToken, sessionUser, throttleIp, type AppEnv } from "../lib/auth";
import { demoEnabled } from "../lib/demo";
import { emailConfigured, magicLinkEmail, magicLinkEnabled, sendEmail, signupExistingEmail, verifySignupEmail } from "../lib/email";
import { hashPassword, needsRehash, verifyPassword } from "../lib/crypto";
import { ROLE, parsePermissions } from "../lib/permissions";
import { apnsConfigured } from "../lib/push";
import { signupMode } from "../lib/signup";
import { baseUrl, getSetting, setSetting } from "../lib/settings";
import { CAPTCHA_UNAVAILABLE, allowedHostnames, turnstileConfig, turnstileSiteKey, verifyTurnstile, type TurnstileAction } from "../lib/turnstile";
import { createWorkspaceStatements, normalizeEmail, normalizeName, passwordError } from "../lib/users";
import { listWorkspaces } from "./workspaces";
import { newId, now, parseJson, randomToken, sha256Hex } from "../lib/util";

export const authRoutes = new Hono<AppEnv>();

export async function hasUsers(db: D1Database) {
  // The live demo's shared user does not count: the instance still needs its first real user. Nor do sign-ups that
  // were never verified (status pending).
  return !!(await db.prepare("SELECT 1 AS x FROM users WHERE is_demo = 0 AND status != 'pending' LIMIT 1").first());
}

/** Signed-in iOS app installs on the instance: any at all, and any with a push token (one query). */
export async function appDevices(db: D1Database): Promise<{ any: boolean; push: boolean }> {
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM devices d JOIN sessions s ON s.id = d.session_id AND s.expires_at > ?1) AS any_device,
         EXISTS (SELECT 1 FROM devices d JOIN sessions s ON s.id = d.session_id AND s.expires_at > ?1 WHERE d.apns_token IS NOT NULL) AS push_device`,
    )
    .bind(now())
    .first<{ any_device: number; push_device: number }>();
  return { any: !!row?.any_device, push: !!row?.push_device };
}

authRoutes.get("/status", async (c) => {
  const [setup, session, magicLink, mode, turnstile, devices] = await Promise.all([
    hasUsers(c.env.DB),
    sessionUser(c),
    magicLinkEnabled(c.env),
    signupMode(c.env.DB),
    turnstileSiteKey(c.env),
    appDevices(c.env.DB),
  ]);
  // Demo visitors are signed in even on an instance that has no real user yet.
  const demo = !!session?.user.demo;
  // "Sign in with the iPhone app" (docs/app-login-spec.md): the app exists for this instance (APP_STORE_URL) or is in
  // use (a signed-in device). "Send to my iPhone" also needs APNs and a device with push on.
  const appLogin = setup && (!!c.env.APP_STORE_URL || devices.any);
  const body: AuthStatusDTO = {
    setup: setup || demo,
    authenticated: !!session && (setup || demo),
    // The setup form then asks for the SETUP_TOKEN secret.
    ...(!setup && c.env.SETUP_TOKEN ? { setupToken: true } : {}),
    // Only when the live demo is on (the landing page shows its "Live demo" buttons then).
    ...(demoEnabled(c.env) ? { demo: true } : {}),
    // The sign-in page then offers "Email me a sign-in link instead" (EMAIL + EMAIL_FROM set and turned on by an admin).
    ...(setup && magicLink ? { magicLink: true } : {}),
    // How new people get in (docs/hosted-spec.md): "Create an account" (open, `signup` kept for older clients) or
    // "Request access" (apply). Absent = invitations only.
    ...(setup && mode === "open" ? { signup: true } : {}),
    ...(setup && mode !== "off" ? { signupMode: mode } : {}),
    // Cloudflare Turnstile is configured: sign-up, sign-in links and sign-in after 3 failures need a widget token.
    ...(turnstile ? { turnstileSiteKey: turnstile } : {}),
    ...(appLogin ? { appLogin: true as const } : {}),
    ...(appLogin && devices.push && apnsConfigured(c.env) ? { pushLogin: true as const } : {}),
    ...(c.env.APP_STORE_URL ? { appStoreUrl: c.env.APP_STORE_URL } : {}),
  };
  return c.json(body);
});

/**
 * Bot check (worker/lib/turnstile.ts) of a public auth form, before any expensive work: null when it passes or
 * Turnstile is not configured, else the error response (400 code "captcha", 503 when Cloudflare cannot be reached).
 */
export async function botCheck(c: Context<AppEnv>, action: TurnstileAction, token: unknown, extra: Record<string, unknown> = {}): Promise<Response | null> {
  const cfg = await turnstileConfig(c.env, { secret: true });
  if (!cfg.siteKey || !cfg.secretSet) return null;
  // A stored secret that no longer decrypts (SECRET_KEY changed): fail closed rather than silently turning the check off.
  if (!cfg.secretKey) return c.json({ error: CAPTCHA_UNAVAILABLE, code: "captcha_unavailable" }, 503);
  const v = await verifyTurnstile({
    secret: cfg.secretKey,
    token,
    action,
    hostnames: allowedHostnames(c.req.url, c.env.PUBLIC_URL),
    remoteip: c.req.header("cf-connecting-ip"),
  });
  if (v.ok) return null;
  return c.json({ error: v.error, code: v.code, ...extra }, v.status);
}

/** First run: creates the first user (instance Admin) and their workspace (Owner), then signs in. */
authRoutes.post("/setup", async (c) => {
  const body = await c.req.json<Partial<SetupInput>>().catch(() => ({}) as Partial<SetupInput>);
  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  if (!name) return c.json({ error: "Name is required" }, 400);
  if (!email) return c.json({ error: "A valid email is required" }, 400);
  const pwError = passwordError(body.password);
  if (pwError) return c.json({ error: pwError }, 400);
  if (await hasUsers(c.env.DB)) return c.json({ error: "Already set up" }, 409);
  // Until the first user exists anyone who finds the URL could claim the instance; SETUP_TOKEN closes that window.
  if (c.env.SETUP_TOKEN && (await sha256Hex(String(body.setupToken ?? ""))) !== (await sha256Hex(c.env.SETUP_TOKEN))) {
    return c.json({ error: "Wrong setup token (the SETUP_TOKEN secret of this deployment)" }, 403);
  }

  const db = c.env.DB;
  const userId = newId("usr_");
  const workspaceId = newId("ws_");
  const t = now();
  const userExists = "WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)";
  // Atomic and race-safe: the user is only inserted while there is none, the workspace only if that insert happened.
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at, last_login_at)
         SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE is_demo = 0 AND status != 'pending')`,
      )
      .bind(userId, email, name, await hashPassword(body.password!), ROLE.instanceAdmin, t, t, t),
    db
      .prepare(`INSERT INTO workspaces (id, name, created_by, created_at, updated_at) SELECT ?, ?, ?, ?, ? ${userExists}`)
      .bind(workspaceId, normalizeName(body.workspaceName) ?? "My workspace", userId, t, t, userId),
    db
      .prepare(`INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) SELECT ?, ?, ?, ? ${userExists}`)
      .bind(workspaceId, userId, ROLE.owner, t, userId),
    // Billing cannot be on before the first user exists; kept so every workspace creation path starts a trial.
    ...trialStatements(db, workspaceId, userId, t),
  ]);
  if (!res.meta.changes) return c.json({ error: "Already set up" }, 409);
  await baseUrl(c.env, c.req.url);
  await createSession(c, userId, workspaceId);
  return c.json({ ok: true });
});

const MAX_FAILURES_IP = 5;
const MAX_FAILURES_EMAIL = 10;
const LOCK_MS = 15 * 60 * 1000;

export type Failures = { n: number; until: number };

/** Failed logins per IP and per email, kept in D1 so the limit holds across isolates. */
export async function failures(env: Env, key: string): Promise<Failures> {
  return parseJson<Failures>(await getSetting(env.DB, key), { n: 0, until: 0 });
}

/** Counts one more failure (the window restarts); returns the new count. */
async function recordFailure(env: Env, key: string, f: Failures): Promise<number> {
  const n = (f.until > Date.now() ? f.n : 0) + 1;
  await setSetting(env.DB, key, JSON.stringify({ n, until: Date.now() + LOCK_MS }));
  return n;
}

/** Failed sign-ins (per IP or per email) after which the bot check is required, when Turnstile is configured. */
const CAPTCHA_AFTER_FAILURES = 3;

// Verified for unknown emails so they cost the same PBKDF2 as wrong passwords (no user enumeration by timing).
const DUMMY_HASH = "pbkdf2$20000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type LoginBody = { email?: unknown; password?: unknown; turnstileToken?: unknown; deviceName?: unknown };

/**
 * Email + password check shared by the web sign-in and the iOS app's (POST /device): persistent per-IP and per-email
 * throttle, the bot check after 3 recent failures, pending and disabled users refused. The user id, or the error.
 */
async function checkLogin(c: Context<AppEnv>, body: LoginBody): Promise<{ userId: string } | { response: Response }> {
  const ipKey = `login_fail:${throttleIp(c.req.header("cf-connecting-ip"))}`;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const emailKey = `login_fail:email:${email}`;
  const [ipF, emailF] = await Promise.all([failures(c.env, ipKey), email ? failures(c.env, emailKey) : { n: 0, until: 0 }]);
  const locked = (f: Failures, max: number) => f.n >= max && f.until > Date.now();
  if (locked(ipF, MAX_FAILURES_IP) || locked(emailF, MAX_FAILURES_EMAIL)) {
    return { response: c.json({ error: "Too many attempts, try again in a few minutes" }, 429) };
  }
  const recent = (f: Failures) => (f.until > Date.now() ? f.n : 0);
  if (Math.max(recent(ipF), recent(emailF)) >= CAPTCHA_AFTER_FAILURES) {
    const blocked = await botCheck(c, "login", body.turnstileToken, { captchaRequired: true });
    if (blocked) return { response: blocked };
  }
  const user = email
    ? await c.env.DB.prepare("SELECT id, password_hash, status FROM users WHERE email = ? AND is_demo = 0")
        .bind(email)
        .first<{ id: string; password_hash: string; status: string }>()
    : null;
  const password = typeof body.password === "string" ? body.password : "";
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    const [ipN, emailN] = await Promise.all([recordFailure(c.env, ipKey, ipF), email ? recordFailure(c.env, emailKey, emailF) : 0]);
    // From now on this IP or email needs the bot check: the sign-in form shows the widget.
    const captcha = Math.max(ipN, emailN) >= CAPTCHA_AFTER_FAILURES && !!(await turnstileSiteKey(c.env));
    return { response: c.json({ error: "Wrong email or password", ...(captcha ? { captchaRequired: true } : {}) }, 401) };
  }
  if (user.status === "pending") return { response: c.json({ error: "Confirm your email first: open the link we sent you when you signed up" }, 403) };
  if (user.status !== "active") return { response: c.json({ error: "This account is disabled" }, 403) };
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM settings WHERE key IN (?, ?)").bind(ipKey, emailKey),
    c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), user.id),
  ]);
  if (needsRehash(user.password_hash)) {
    await c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(password), now(), user.id).run();
  }
  return { userId: user.id };
}

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<LoginBody>().catch(() => ({}) as LoginBody);
  const r = await checkLogin(c, body);
  if ("response" in r) return r.response;
  await createSession(c, r.userId);
  return c.json({ ok: true });
});

// ---------- iOS app (docs/ios-api.md): device tokens ----------

/** Name of the device as given by the app ("Ferdi's iPhone"), at most 100 characters. */
const deviceName = (v: unknown) => normalizeName(v) ?? "iPhone";

/** Device token + who it belongs to: what the app needs to start (same workspaces as GET /api/me). */
async function deviceResponse(c: Context<AppEnv>, userId: string, workspaceId: string | null, name: string): Promise<DeviceTokenDTO> {
  const db = c.env.DB;
  const user = await db
    .prepare("SELECT u.id, u.name, u.email, u.role_id, r.name AS role_name, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?")
    .bind(userId)
    .first<{ id: string; name: string; email: string; role_id: string; role_name: string; permissions: string }>();
  const instancePermissions = parsePermissions(user!.permissions, "instance") as DeviceTokenDTO["instancePermissions"];
  const workspaces = (await listWorkspaces(db, userId, instancePermissions)).map(({ createdAt: _c, memberCount: _m, ...w }) => w);
  const current = workspaces.find((w) => w.id === workspaceId)?.id ?? workspaces.find((w) => !w.viaAdmin)?.id ?? workspaces[0]?.id ?? null;
  const device = await createDeviceSession(db, userId, current, name);
  return {
    token: device.token,
    deviceId: device.deviceId,
    user: { id: user!.id, name: user!.name, email: user!.email, role: { id: user!.role_id, name: user!.role_name } },
    instancePermissions,
    workspaces,
    currentWorkspaceId: current,
    server: await baseUrl(c.env, c.req.url),
  };
}

/** iOS app sign-in with email and password (same throttle, bot check and refusals as /login): a device token. */
authRoutes.post("/device", async (c) => {
  const body = await c.req.json<LoginBody>().catch(() => ({}) as LoginBody);
  const r = await checkLogin(c, body);
  if ("response" in r) return r.response;
  return c.json(await deviceResponse(c, r.userId, null, deviceName(body.deviceName)));
});

const MAX_PAIR_FAILURES_IP = 10;
const INVALID_CODE = "This code is invalid, used or expired. Show a new one in Postflare on the web (Profile → Postflare for iPhone).";

/** Pairing code as typed or scanned: letters and digits only ("ABCDE-FGHJK" → "ABCDEFGHJK"). */
export const normalizeCode = (v: unknown) => (typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

/** iOS app sign-in with a pairing code (QR code on the web Profile page): single use, 5 minutes. */
authRoutes.post("/pair", async (c) => {
  const body = await c.req.json<{ code?: unknown; deviceName?: unknown }>().catch(() => ({}) as { code?: unknown; deviceName?: unknown });
  const code = normalizeCode(body.code);
  const ipKey = `pair_fail:${throttleIp(c.req.header("cf-connecting-ip"))}`;
  const ipF = await failures(c.env, ipKey);
  if (ipF.n >= MAX_PAIR_FAILURES_IP && ipF.until > Date.now()) return c.json({ error: "Too many attempts, try again in a few minutes" }, 429);
  if (code.length < 8 || code.length > 16) {
    await recordFailure(c.env, ipKey, ipF);
    return c.json({ error: INVALID_CODE }, 400);
  }
  const t = now();
  const row = await c.env.DB.prepare(
    `UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = pairing_codes.user_id AND u.status = 'active' AND u.is_demo = 0)
     RETURNING id, user_id, workspace_id`,
  )
    .bind(t, await sha256Hex(code), t)
    .first<{ id: string; user_id: string; workspace_id: string | null }>();
  if (!row) {
    await recordFailure(c.env, ipKey, ipF);
    return c.json({ error: INVALID_CODE }, 400);
  }
  const out = await deviceResponse(c, row.user_id, row.workspace_id, deviceName(body.deviceName));
  // The web page polling the code shows which device used it.
  await c.env.DB.prepare("UPDATE pairing_codes SET device_id = ? WHERE id = ?").bind(out.deviceId, row.id).run();
  return c.json(out);
});

/** The app signs out: revokes its device token (and with it the device's push registration). */
authRoutes.post("/device/logout", async (c) => {
  const token = deviceToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "Send the device token as Authorization: Bearer pfd_..." }, 401);
  const id = await sha256Hex(token);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM devices WHERE session_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM sessions WHERE id = ? AND kind = 'device'").bind(id),
  ]);
  return c.json({ ok: true });
});

const LINK_TTL_MS = 15 * 60 * 1000;
const MAX_LINKS_IP = 10;
const MAX_LINKS_EMAIL = 3;
const INVALID_LINK = "This sign-in link is invalid, used or expired. Request a new one.";
const NOT_ENABLED = "Sign-in links by email are not turned on for this instance";

/**
 * Sign-in links by email ("magic link"): mails a single-use link to an existing active user. The answer is the same
 * whether or not the email has an account: the user lookup, the link and the email all happen after the response.
 * Throttled per email (3) and per IP (10) in 15 minutes, counting every request.
 */
authRoutes.post("/magic-link", async (c) => {
  if (!(await magicLinkEnabled(c.env))) return c.json({ error: NOT_ENABLED }, 404);
  const body = await c.req.json<{ email?: unknown; turnstileToken?: unknown }>().catch(() => ({}) as { email?: unknown; turnstileToken?: unknown });
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "A valid email is required" }, 400);
  const ipKey = `magic_link:${throttleIp(c.req.header("cf-connecting-ip"))}`;
  const emailKey = `magic_link:email:${email.toLowerCase()}`;
  const [ipF, emailF] = await Promise.all([failures(c.env, ipKey), failures(c.env, emailKey)]);
  const over = (f: Failures, max: number) => f.n >= max && f.until > Date.now();
  if (over(ipF, MAX_LINKS_IP) || over(emailF, MAX_LINKS_EMAIL)) return c.json({ error: "Too many sign-in links requested. Try again in 15 minutes." }, 429);
  const blocked = await botCheck(c, "magic_link", body.turnstileToken);
  if (blocked) return blocked;
  await Promise.all([recordFailure(c.env, ipKey, ipF), recordFailure(c.env, emailKey, emailF)]);

  c.executionCtx.waitUntil(
    (async () => {
      const user = await c.env.DB.prepare("SELECT id, email FROM users WHERE email = ? AND is_demo = 0 AND status = 'active'")
        .bind(email)
        .first<{ id: string; email: string }>();
      if (!user) return;
      const token = randomToken(32);
      const t = now();
      await c.env.DB.prepare("INSERT INTO magic_links (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex(token), user.id, t, t + LINK_TTL_MS)
        .run();
      // The token goes in the fragment: never sent to a server, so it stays out of request logs.
      const url = `${await baseUrl(c.env, c.req.url)}/auth/link#${token}`;
      await sendEmail(c.env, magicLinkEmail(user.email, url, LINK_TTL_MS / 60_000));
    })().catch((err) => console.error("sign-in link email failed", err?.code ?? "", err?.message ?? err)),
  );
  return c.json({ ok: true });
});

/**
 * Opens a session from an emailed sign-in link (POSTed by the /auth/link page on click, so link scanners cannot use it
 * up). Single use; the user's other open links end. Turning the feature off ends outstanding links too (404).
 */
authRoutes.post("/magic-link/verify", async (c) => {
  if (!(await magicLinkEnabled(c.env))) return c.json({ error: NOT_ENABLED }, 404);
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^[\w-]{20,100}$/.test(token)) return c.json({ error: INVALID_LINK }, 400);
  const t = now();
  const row = await c.env.DB.prepare(
    "UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND purpose = 'login' RETURNING user_id",
  )
    .bind(t, await sha256Hex(token), t)
    .first<{ user_id: string }>();
  if (!row) return c.json({ error: INVALID_LINK }, 400);
  const user = await c.env.DB.prepare("SELECT status, is_demo FROM users WHERE id = ?").bind(row.user_id).first<{ status: string; is_demo: number }>();
  if (!user || user.is_demo) return c.json({ error: INVALID_LINK }, 400);
  if (user.status !== "active") return c.json({ error: "This account is disabled" }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE magic_links SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND purpose = 'login'").bind(t, row.user_id),
    c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(t, row.user_id),
  ]);
  await createSession(c, row.user_id);
  return c.json({ ok: true });
});

// ---------- Public sign-up (hosted mode, docs/hosted-spec.md "Sign-up"): off until an instance admin turns it on ----------

const SIGNUP_OFF = "Sign-up is not open on this instance";
const MAX_SIGNUPS_IP = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const INVALID_VERIFY = "This confirmation link is invalid, used or expired. Sign up again to get a new one.";

/**
 * POST /api/auth/signup {name, email, password, workspaceName?}. With email configured (EMAIL + EMAIL_FROM) the user is
 * created pending and a confirmation link is mailed; the answer is the same whether or not the email already has an
 * account (an existing user is told to sign in instead), and the lookup and email happen after the response. Without
 * email the account is created right away and signed in (an existing email then answers 409). 5 per IP per hour.
 */
authRoutes.post("/signup", async (c) => {
  if (!(await signupEnabled(c.env.DB)) || !(await hasUsers(c.env.DB))) return c.json({ error: SIGNUP_OFF }, 404);
  const body = await c.req.json<Partial<SignupInput>>().catch(() => ({}) as Partial<SignupInput>);
  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  if (!name) return c.json({ error: "Name is required" }, 400);
  if (!email) return c.json({ error: "A valid email is required" }, 400);
  if (email.toLowerCase().endsWith("@postflare.local")) return c.json({ error: "Use your real email address" }, 400);
  const pwError = passwordError(body.password);
  if (pwError) return c.json({ error: pwError }, 400);
  const ipKey = `signup:${throttleIp(c.req.header("cf-connecting-ip"))}`;
  const ipF = await failures(c.env, ipKey);
  if (ipF.n >= MAX_SIGNUPS_IP && ipF.until > Date.now()) return c.json({ error: "Too many sign-ups from your network. Try again in an hour." }, 429);
  // Before the throttle write, PBKDF2 and the user/email work.
  const blocked = await botCheck(c, "signup", body.turnstileToken);
  if (blocked) return blocked;
  const n = (ipF.until > Date.now() ? ipF.n : 0) + 1;
  await setSetting(c.env.DB, ipKey, JSON.stringify({ n, until: ipF.until > Date.now() ? ipF.until : Date.now() + SIGNUP_WINDOW_MS }));

  const db = c.env.DB;
  const passwordHash = await hashPassword(body.password!);
  const workspaceName = normalizeName(body.workspaceName) ?? `${name}'s workspace`;
  const t = now();

  if (!emailConfigured(c.env)) {
    // No way to verify the address: immediate account (the admin card warns hosted instances to configure email).
    const userId = newId("usr_");
    const ws = createWorkspaceStatements(db, workspaceName, userId);
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .bind(userId, email, name, passwordHash, ROLE.instanceMember, t, t, t),
        ...ws.statements,
      ]);
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) return c.json({ error: "An account with this email already exists: sign in instead" }, 409);
      throw err;
    }
    await createSession(c, userId, ws.id);
    const out: SignupDTO = { ok: true, verify: false, workspaceId: ws.id };
    return c.json(out);
  }

  c.executionCtx.waitUntil(
    (async () => {
      const base = await baseUrl(c.env, c.req.url);
      const existing = await db.prepare("SELECT id, email, status, is_demo FROM users WHERE email = ?").bind(email).first<{ id: string; email: string; status: string; is_demo: number }>();
      if (existing && existing.status !== "pending") {
        if (existing.status === "active" && !existing.is_demo) await sendEmail(c.env, signupExistingEmail(existing.email, `${base}/login`));
        return;
      }
      // A pending sign-up with this email (never confirmed) is replaced: only the mailbox owner can confirm it.
      const userId = existing?.id ?? newId("usr_");
      const token = randomToken(32);
      await db.batch([
        existing
          ? db.prepare("UPDATE users SET name = ?, password_hash = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(name, passwordHash, t, userId)
          : db
              .prepare(`INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
              .bind(userId, email, name, passwordHash, ROLE.instanceMember, t, t),
        db.prepare("DELETE FROM magic_links WHERE user_id = ? AND purpose = 'verify'").bind(userId),
        db
          .prepare("INSERT INTO magic_links (token_hash, user_id, created_at, expires_at, purpose, data) VALUES (?, ?, ?, ?, 'verify', ?)")
          .bind(await sha256Hex(token), userId, t, t + VERIFY_TTL_MS, JSON.stringify({ workspaceName })),
      ]);
      // The token goes in the fragment: never sent to a server, so it stays out of request logs.
      await sendEmail(c.env, verifySignupEmail(email, `${base}/auth/verify#${token}`, VERIFY_TTL_MS / 3_600_000));
    })().catch((err) => console.error("sign-up email failed", err?.code ?? "", err?.message ?? err)),
  );
  const out: SignupDTO = { ok: true, verify: true };
  return c.json(out);
});

/**
 * POST /api/auth/signup/verify {token} (the /auth/verify page, on click): activates the pending user, creates their
 * workspace (trial when billing is on) and signs in. Single use. 404 while sign-up is off.
 */
authRoutes.post("/signup/verify", async (c) => {
  if (!(await signupEnabled(c.env.DB))) return c.json({ error: SIGNUP_OFF }, 404);
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^[\w-]{20,100}$/.test(token)) return c.json({ error: INVALID_VERIFY }, 400);
  const db = c.env.DB;
  const t = now();
  const link = await db
    .prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND purpose = 'verify' RETURNING user_id, data")
    .bind(t, await sha256Hex(token), t)
    .first<{ user_id: string; data: string | null }>();
  if (!link) return c.json({ error: INVALID_VERIFY }, 400);
  const user = await db.prepare("SELECT id, name, status FROM users WHERE id = ?").bind(link.user_id).first<{ id: string; name: string; status: string }>();
  if (!user || user.status !== "pending") return c.json({ error: INVALID_VERIFY }, 400);
  const workspaceName = normalizeName(parseJson<{ workspaceName?: string }>(link.data, {}).workspaceName) ?? `${user.name}'s workspace`;
  const ws = createWorkspaceStatements(db, workspaceName, user.id);
  // The link was claimed atomically above: a second click (or a concurrent one) cannot create a second workspace.
  const [activated] = await db.batch([
    db.prepare("UPDATE users SET status = 'active', updated_at = ?, last_login_at = ? WHERE id = ? AND status = 'pending'").bind(t, t, user.id),
    ...ws.statements,
  ]);
  if (!activated.meta.changes) return c.json({ error: INVALID_VERIFY }, 400);
  await createSession(c, user.id, ws.id);
  return c.json({ ok: true, workspaceId: ws.id });
});

authRoutes.post("/logout", async (c) => {
  // The app may call the web logout too: it ends its device token, never a cookie session.
  if (deviceToken(c.req.header("authorization"))) {
    const id = await sha256Hex(deviceToken(c.req.header("authorization"))!);
    await c.env.DB.batch([c.env.DB.prepare("DELETE FROM devices WHERE session_id = ?").bind(id), c.env.DB.prepare("DELETE FROM sessions WHERE id = ? AND kind = 'device'").bind(id)]);
    return c.json({ ok: true });
  }
  await destroySession(c);
  return c.json({ ok: true });
});
