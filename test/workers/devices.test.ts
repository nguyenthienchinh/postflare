import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../worker/lib/crypto";
import { makeCall, apnsToken, type AppClient } from "./app-helpers";

// iOS app sign-in (docs/ios-api.md): device tokens from email + password or a pairing code, acting like a web session
// across workspaces (X-Workspace-Id) with the same permissions, CSRF exemption, revoke, disabled users, the device
// list and push registration. Own D1 (DEVICES_DB).

const E = { ...env, DB: env.DEVICES_DB } as unknown as Env;
const call = makeCall(E);
const PW = "password123";

let owner: AppClient;
let ownerWs: string;
let secondWs: string;
let viewer: AppClient;
let viewerId: string;
let ip = 0;
const nextIp = () => ({ "cf-connecting-ip": `10.60.0.${++ip}` });

async function deviceLogin(email: string, password = PW, deviceName = "Test iPhone") {
  return call(null, "/api/auth/device", { body: { email, password, deviceName }, headers: nextIp() });
}

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Olga", email: "olga@example.com", password: PW } });
  expect(setup.status, setup.text).toBe(200);
  owner = { cookie: setup.cookie! };
  ownerWs = (await call(owner, "/api/me")).json.currentWorkspaceId;
  secondWs = (await call(owner, "/api/workspaces", { body: { name: "Second" } })).json.id;
  const inv = await call(owner, "/api/invitations", { body: { workspaceId: ownerWs, workspaceRoleId: "role_ws_viewer", instanceRoleId: "role_instance_member" } });
  expect(inv.status, inv.text).toBe(201);
  const accepted = await call(null, "/api/invitations/accept", { body: { token: inv.json.url.split("/invite/")[1], name: "Vic", email: "vic@example.com", password: PW } });
  expect(accepted.status, accepted.text).toBe(200);
  viewer = { cookie: accepted.cookie! };
  viewerId = (await call(viewer, "/api/me")).json.user.id;
});

describe("device sign-in with email and password", () => {
  it("returns a pfd_ token, the user and all their workspaces", async () => {
    const res = await deviceLogin("olga@example.com");
    expect(res.status, res.text).toBe(200);
    expect(res.json.token).toMatch(/^pfd_[\w-]{40,}$/);
    expect(res.json.deviceId).toMatch(/^dev_/);
    expect(res.json.user).toMatchObject({ name: "Olga", email: "olga@example.com" });
    expect(res.json.workspaces.map((w: any) => w.id).sort()).toEqual([ownerWs, secondWs].sort());
    expect([ownerWs, secondWs]).toContain(res.json.currentWorkspaceId);
    expect(res.json.server).toBe("https://pf.test");
    // No cookie: the app keeps the token.
    expect(res.headers.get("set-cookie")).toBeNull();
    // Only the hash is stored, as a device session.
    const row = await E.DB.prepare("SELECT kind, name FROM sessions WHERE id = (SELECT session_id FROM devices WHERE id = ?)").bind(res.json.deviceId).first();
    expect(row).toEqual({ kind: "device", name: "Test iPhone" });
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").bind(res.json.token).first("n")).toBe(0);
  });

  it("refuses wrong passwords, pending, disabled and demo users like /login", async () => {
    expect((await deviceLogin("olga@example.com", "wrong-password")).status).toBe(401);
    const t = Date.now();
    const hash = await hashPassword(PW);
    await E.DB.batch([
      E.DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES ('usr_pend', 'pend@example.com', 'P', ?, 'role_instance_member', 'pending', ?, ?)").bind(hash, t, t),
      E.DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES ('usr_dis', 'dis@example.com', 'D', ?, 'role_instance_member', 'disabled', ?, ?)").bind(hash, t, t),
      E.DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at, is_demo) VALUES ('usr_demo_x', 'demo-x@example.com', 'Demo', ?, 'role_instance_member', 'active', ?, ?, 1)").bind(hash, t, t),
    ]);
    expect((await deviceLogin("pend@example.com")).status).toBe(403);
    expect((await deviceLogin("dis@example.com")).status).toBe(403);
    expect((await deviceLogin("demo-x@example.com")).status).toBe(401);
  });

  it("shares the login throttle with the web sign-in", async () => {
    const headers = { "cf-connecting-ip": "10.61.0.1" };
    for (let i = 0; i < 5; i++) await call(null, "/api/auth/device", { body: { email: "nobody@example.com", password: "x" }, headers });
    expect((await call(null, "/api/auth/device", { body: { email: "olga@example.com", password: PW }, headers })).status).toBe(429);
    expect((await call(null, "/api/auth/login", { body: { email: "olga@example.com", password: PW }, headers })).status).toBe(429);
  });
});

describe("device token as a principal", () => {
  let token: string;
  let viewerToken: string;
  beforeAll(async () => {
    token = (await deviceLogin("olga@example.com")).json.token;
    viewerToken = (await deviceLogin("vic@example.com")).json.token;
  });

  it("acts in every workspace of the user through X-Workspace-Id, like the web session", async () => {
    const me = await call({ token }, "/api/me");
    expect(me.status).toBe(200);
    expect(me.json.workspaces).toHaveLength(2);
    for (const ws of [ownerWs, secondWs]) {
      expect((await call({ token, ws }, "/api/posts")).status).toBe(200);
      expect((await call({ token, ws }, "/api/accounts")).status).toBe(200);
      expect((await call({ token, ws }, "/api/overview")).status).toBe(200);
    }
    expect((await call({ token, ws: "ws_nope" }, "/api/posts")).status).toBe(404);
    // Instance permissions of the user too (admin routes work as in the browser, unlike API keys).
    expect((await call({ token }, "/api/users")).status).toBe(200);
    // The remembered workspace can be switched like a session's.
    expect((await call({ token }, "/api/me/workspace", { body: { workspaceId: secondWs } })).json).toEqual({ ok: true, currentWorkspaceId: secondWs });
    expect((await call({ token }, "/api/me")).json.currentWorkspaceId).toBe(secondWs);
  });

  it("has the user's role permissions: a viewer reads but cannot write, and never reaches other workspaces", async () => {
    expect((await call({ token: viewerToken, ws: ownerWs }, "/api/posts")).status).toBe(200);
    const create = await call({ token: viewerToken, ws: ownerWs }, "/api/posts", { body: { scheduledAt: null, posts: [] } });
    expect(create.status).toBe(403);
    expect((await call({ token: viewerToken, ws: secondWs }, "/api/posts")).status).toBe(404);
    expect((await call({ token: viewerToken }, "/api/users")).status).toBe(403);
  });

  it("is not blocked by the same-origin check (no cookie, not a CSRF target); cookies still are", async () => {
    const evil = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    expect((await call({ token }, "/api/me/workspace", { body: { workspaceId: ownerWs }, headers: evil })).status).toBe(200);
    expect((await call(owner, "/api/me/workspace", { body: { workspaceId: ownerWs }, headers: evil })).status).toBe(403);
  });

  it("an unknown or revoked token is 401 and never falls back to the cookie", async () => {
    const res = await call({ token: "pfd_nope", cookie: owner.cookie }, "/api/me");
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("device_signed_out");
    // A device token is not a session cookie, nor the other way round.
    expect((await call({ cookie: `pf_session=${token}` }, "/api/me")).status).toBe(401);
  });

  it("cannot mint API keys or pairing codes (they would outlive its revocation)", async () => {
    expect((await call({ token, ws: ownerWs }, "/api/keys", { body: { name: "x" } })).status).toBe(403);
    expect((await call({ token }, "/api/pairing-codes", { body: {} })).status).toBe(403);
  });

  it("slides its expiry when used after 10 minutes", async () => {
    const hash = (await E.DB.prepare("SELECT s.id FROM sessions s JOIN devices d ON d.session_id = s.id WHERE s.user_id = ? AND s.kind = 'device' ORDER BY s.created_at DESC LIMIT 1").bind(viewerId).first<{ id: string }>())!.id;
    const soon = Date.now() + 60_000;
    await E.DB.prepare("UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE id = ?").bind(soon, Date.now() - 11 * 60_000, hash).run();
    expect((await call({ token: viewerToken }, "/api/me")).status).toBe(200);
    const row = await E.DB.prepare("SELECT expires_at, last_used_at FROM sessions WHERE id = ?").bind(hash).first<{ expires_at: number; last_used_at: number }>();
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 360 * 24 * 60 * 60 * 1000);
    expect(row!.last_used_at).toBeGreaterThan(Date.now() - 5000);
  });

  it("stops working when the user is disabled", async () => {
    const t = await deviceLogin("vic@example.com");
    expect((await call({ token: t.json.token }, "/api/me")).status).toBe(200);
    expect((await call(owner, `/api/users/${viewerId}`, { method: "PATCH", body: { status: "disabled" } })).status).toBe(200);
    expect((await call({ token: t.json.token }, "/api/me")).status).toBe(401);
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").bind(viewerId).first("n")).toBe(0);
    await call(owner, `/api/users/${viewerId}`, { method: "PATCH", body: { status: "active" } });
    expect((await call({ token: t.json.token }, "/api/me")).status).toBe(401);
  });

  it("a password change from the app keeps this device and signs out the others", async () => {
    const a = (await deviceLogin("olga@example.com", PW, "A")).json.token;
    const b = (await deviceLogin("olga@example.com", PW, "B")).json.token;
    expect((await call({ token: a }, "/api/me/password", { body: { current: PW, next: "password456" } })).status).toBe(200);
    expect((await call({ token: a }, "/api/me")).status).toBe(200);
    expect((await call({ token: b }, "/api/me")).status).toBe(401);
    expect((await call(owner, "/api/me")).status).toBe(401);
    expect((await call({ token: a }, "/api/me/password", { body: { current: "password456", next: PW } })).status).toBe(200);
    owner = { cookie: (await call(null, "/api/auth/login", { body: { email: "olga@example.com", password: PW }, headers: nextIp() })).cookie! };
    token = (await deviceLogin("olga@example.com")).json.token;
  });

  it("POST /api/auth/device/logout revokes the calling token", async () => {
    const t = (await deviceLogin("olga@example.com")).json;
    expect((await call({ token: t.token }, "/api/auth/device/logout", { body: {} })).json).toEqual({ ok: true });
    expect((await call({ token: t.token }, "/api/me")).status).toBe(401);
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE id = ?").bind(t.deviceId).first("n")).toBe(0);
  });
});

describe("pairing codes", () => {
  it("web session → QR payload and code; the app pairs once; the page sees it used", async () => {
    const pc = await call({ ...owner, ws: secondWs }, "/api/pairing-codes", { body: {} });
    expect(pc.status, pc.text).toBe(201);
    expect(pc.json.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(pc.json.url).toBe(`postflare://pair?s=${encodeURIComponent("https://pf.test")}&c=${pc.json.code}`);
    expect(pc.json.expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await call(owner, `/api/pairing-codes/${pc.json.id}`)).json).toMatchObject({ status: "pending", deviceName: null });
    // Other users cannot poll it.
    expect((await call({ token: (await deviceLogin("vic@example.com")).json.token }, `/api/pairing-codes/${pc.json.id}`)).status).toBe(404);

    const typed = `${pc.json.code.slice(0, 5)}-${pc.json.code.slice(5).toLowerCase()}`;
    const paired = await call(null, "/api/auth/pair", { body: { code: typed, deviceName: "Olga's iPhone" }, headers: nextIp() });
    expect(paired.status, paired.text).toBe(200);
    expect(paired.json.token).toMatch(/^pfd_/);
    // The workspace shown when the code was made.
    expect(paired.json.currentWorkspaceId).toBe(secondWs);
    expect((await call({ token: paired.json.token }, "/api/me")).json.user.email).toBe("olga@example.com");
    expect((await call(owner, `/api/pairing-codes/${pc.json.id}`)).json).toMatchObject({ status: "used", deviceName: "Olga's iPhone" });
    // Single use.
    expect((await call(null, "/api/auth/pair", { body: { code: pc.json.code }, headers: nextIp() })).status).toBe(400);
  });

  it("expired codes and codes of disabled users do not pair", async () => {
    const pc = (await call(owner, "/api/pairing-codes", { body: {} })).json;
    await E.DB.prepare("UPDATE pairing_codes SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, pc.id).run();
    expect((await call(null, "/api/auth/pair", { body: { code: pc.code }, headers: nextIp() })).status).toBe(400);
    expect((await call(owner, `/api/pairing-codes/${pc.id}`)).json.status).toBe("expired");
    viewer = { cookie: (await call(null, "/api/auth/login", { body: { email: "vic@example.com", password: PW }, headers: nextIp() })).cookie! };
    const v = (await call(viewer, "/api/pairing-codes", { body: {} })).json;
    expect(v.code).toMatch(/^[A-Z2-9]{10}$/);
    await E.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(viewerId).run();
    expect((await call(null, "/api/auth/pair", { body: { code: v.code }, headers: nextIp() })).status).toBe(400);
    await E.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(viewerId).run();
  });

  it("is throttled per IP after 10 wrong codes", async () => {
    const headers = { "cf-connecting-ip": "10.62.0.1" };
    for (let i = 0; i < 10; i++) expect((await call(null, "/api/auth/pair", { body: { code: "AAAAAAAAAA" }, headers })).status).toBe(400);
    const pc = (await call(owner, "/api/pairing-codes", { body: {} })).json;
    expect((await call(null, "/api/auth/pair", { body: { code: pc.code }, headers })).status).toBe(429);
  });
});

describe("devices and push registration", () => {
  it("lists the user's devices, registers the APNs token, moves a reused token, updates prefs, revokes", async () => {
    const a = (await deviceLogin("olga@example.com", PW, "Phone A")).json;
    const b = (await deviceLogin("olga@example.com", PW, "Phone B")).json;
    // Only the app registers (cookie sessions cannot).
    expect((await call(owner, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(1) } })).status).toBe(403);
    expect((await call({ token: a.token }, "/api/devices/me", { method: "PUT", body: { apnsToken: "not-hex" } })).status).toBe(400);
    const reg = await call({ token: a.token }, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(1).toUpperCase(), environment: "sandbox", name: "Olga's iPhone", prefs: { published: false } } });
    expect(reg.status, reg.text).toBe(200);
    expect(reg.json).toMatchObject({ id: a.deviceId, name: "Olga's iPhone", push: true, environment: "sandbox", prefs: { published: false, failed: true, workspaces: null }, current: true });
    expect(await E.DB.prepare("SELECT apns_token FROM devices WHERE id = ?").bind(a.deviceId).first("apns_token")).toBe(apnsToken(1));

    // Same physical phone signed in again (B): the token moves, A no longer gets pushes.
    await call({ token: b.token }, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(1) } });
    expect(await E.DB.prepare("SELECT apns_token FROM devices WHERE id = ?").bind(a.deviceId).first("apns_token")).toBeNull();

    const prefs = await call({ token: b.token }, "/api/devices/me/prefs", { method: "PATCH", body: { failed: false, workspaces: [ownerWs, 42], bogus: 1 } });
    expect(prefs.json.prefs).toEqual({ published: true, failed: false, accessRequests: true, support: true, workspaces: [ownerWs] });

    const list = await call(owner, "/api/devices");
    expect(list.status).toBe(200);
    const ids = list.json.items.map((d: any) => d.id);
    expect(ids).toEqual(expect.arrayContaining([a.deviceId, b.deviceId]));
    expect(list.json.items.find((d: any) => d.id === b.deviceId)).toMatchObject({ name: "Phone B", push: true, lastSeenAt: expect.any(Number) });
    expect(list.json.items.some((d: any) => d.current)).toBe(false);
    expect((await call({ token: b.token }, "/api/devices")).json.items.find((d: any) => d.current).id).toBe(b.deviceId);
    expect(list.json.push).toBe(false);

    // Another user cannot revoke it; the owner of the device can, from the web.
    const vic = { token: (await deviceLogin("vic@example.com")).json.token };
    expect((await call(vic, `/api/devices/${b.deviceId}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(owner, `/api/devices/${b.deviceId}`, { method: "DELETE" })).json).toEqual({ ok: true });
    expect((await call({ token: b.token }, "/api/me")).status).toBe(401);
    expect((await call(owner, "/api/devices")).json.items.map((d: any) => d.id)).not.toContain(b.deviceId);
    // The app can sign itself out through DELETE /api/devices/me too.
    expect((await call({ token: a.token }, "/api/devices/me", { method: "DELETE" })).json).toEqual({ ok: true });
    expect((await call({ token: a.token }, "/api/me")).status).toBe(401);
  });

  it("test push needs APNs configured", async () => {
    const a = (await deviceLogin("olga@example.com")).json;
    expect((await call({ token: a.token }, "/api/devices/me/test", { body: {} })).status).toBe(400);
  });
});

describe("GET /api/overview (app home screen)", () => {
  it("counts today and this week from the client's period starts, lists failures", async () => {
    const token = (await deviceLogin("olga@example.com")).json.token;
    const DAY = 24 * 60 * 60 * 1000;
    const t = Date.now();
    const todayStart = t - 60 * 60 * 1000;
    const weekStart = t - 3 * DAY;
    const ins = (id: string, status: string, at: number, publishedAt: number | null = null) =>
      E.DB.prepare(
        `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, settings, thread, attempts, revision, created_at, updated_at, published_at, workspace_id, error)
         VALUES (?, ?, 'acc_x', ?, ?, 'x', '[]', '{}', '[]', 0, 0, ?, ?, ?, ?, ?)`,
      ).bind(id, `g_${id}`, status, at, at, at, publishedAt, ownerWs, status === "failed" ? "boom" : null);
    await E.DB.batch([
      E.DB.prepare(
        "INSERT INTO accounts (id, provider, external_id, name, credentials_enc, meta, status, created_at, updated_at, workspace_id) VALUES ('acc_x', 'webhook', 'x', 'X', 'x', '{}', 'active', ?, ?, ?)",
      ).bind(t, t, ownerWs),
      ins("ov_pub_today", "published", t - 2 * DAY, t - 10 * 60_000),
      ins("ov_pub_week", "published", t - 2 * DAY, t - 2 * DAY),
      ins("ov_pub_old", "published", t - 10 * DAY, t - 10 * DAY),
      ins("ov_fail_today", "failed", t - 5 * 60_000),
      ins("ov_check_week", "needs_check", t - DAY),
      ins("ov_sched_today", "scheduled", t + 10 * 60_000),
    ]);
    const res = await call({ token, ws: ownerWs }, `/api/overview?todayStart=${todayStart}&weekStart=${weekStart}`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.periods).toEqual({
      today: { published: 1, failed: 1, scheduled: 1 },
      week: { published: 2, failed: 1, needs_check: 1, scheduled: 1 },
      todayStart,
      weekStart,
    });
    expect(res.json.counts).toMatchObject({ published: 3, failed: 1, needs_check: 1, scheduled: 1 });
    expect(res.json.failures.map((p: any) => p.id).sort()).toEqual(["ov_check_week", "ov_fail_today"]);
    expect(res.json.upcoming.map((p: any) => p.id)).toEqual(["ov_sched_today"]);
    expect(res.json.recent).toHaveLength(5);
    // Default periods: UTC midnight and UTC Monday.
    const def = (await call({ token, ws: ownerWs }, "/api/overview")).json.periods;
    expect(def.todayStart % DAY).toBe(0);
    expect(new Date(def.weekStart).getUTCDay()).toBe(1);
    expect(def.todayStart - def.weekStart).toBeLessThan(7 * DAY);
  });
});
