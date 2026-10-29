import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../worker/lib/crypto";
import { resetApnsJwt } from "../../worker/lib/push";
import { apnsKey, apnsToken, makeCall, type AppClient } from "./app-helpers";

// Sign in on the web with the iOS app (docs/app-login-spec.md): auth status flags, the QR flow (poll secret, nonce,
// single use, expiry), the push flow with number matching (enumeration-safe start, wrong number denies), throttles,
// device-only approval, disabled and demo users. Own D1 (APP_LOGIN_DB); APNs mocked through globalThis.fetch.

const key = await apnsKey();
const APNS = { APNS_PRIVATE_KEY: key.pem, APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "app.ferdi.postflare" };
const BASE = { ...env, DB: env.APP_LOGIN_DB, DEMO_MODE: "false" } as unknown as Env;
const E = { ...BASE, ...APNS } as Env;
const call = makeCall(E);
const callBase = makeCall(BASE);
const callStore = makeCall({ ...BASE, APP_STORE_URL: "https://apps.apple.com/app/id123" } as Env);
const PW = "password123";

let apns: Array<{ token: string; headers: Record<string, string>; body: any }> = [];
function mockApns() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    apns.push({ token: new URL(req.url).pathname.split("/").pop()!, headers: Object.fromEntries(req.headers), body: await req.json() });
    return new Response(null, { status: 200 });
  });
}

let ipN = 0;
const ip = () => ({ "cf-connecting-ip": `10.80.${++ipN}.1` });
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const start = (body: unknown, headers: Record<string, string> = ip()) =>
  call(null, "/api/auth/app-login", { body, headers: { ...headers, "user-agent": CHROME_MAC }, cf: { city: "Berlin", country: "DE" } });
const poll = (id: string, secret: string) => call(null, `/api/auth/app-login/${id}`, { headers: { "x-login-secret": secret } });
const parseQr = (qr: string) => {
  const u = new URL(qr.replace("postflare://", "https://x/"));
  return { s: u.searchParams.get("s"), r: u.searchParams.get("r")!, k: u.searchParams.get("k")! };
};

let ada: AppClient;
let bob: AppClient;
let bobId: string;

async function deviceToken(email: string) {
  const res = await call(null, "/api/auth/device", { body: { email, password: PW }, headers: ip() });
  expect(res.status, res.text).toBe(200);
  return res.json.token as string;
}

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Ada", email: "ada@example.com", password: PW } });
  expect(setup.status, setup.text).toBe(200);
  const t = Date.now();
  await E.DB.batch([
    E.DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES ('usr_bob', 'bob@example.com', 'Bob', ?, 'role_instance_member', 'active', ?, ?)").bind(await hashPassword(PW), t, t),
  ]);
  bobId = "usr_bob";
});

beforeEach(() => {
  apns = [];
  resetApnsJwt();
  mockApns();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth status", () => {
  it("appLogin once the app is in use (or APP_STORE_URL is set); pushLogin with APNs and a device with push", async () => {
    let s = (await callBase(null, "/api/auth/status")).json;
    expect(s.appLogin).toBeUndefined();
    expect(s.pushLogin).toBeUndefined();
    expect((await start({ kind: "qr" })).status).toBe(404);
    s = (await callStore(null, "/api/auth/status")).json;
    expect(s).toMatchObject({ appLogin: true, appStoreUrl: "https://apps.apple.com/app/id123" });
    expect(s.pushLogin).toBeUndefined();

    ada = { token: await deviceToken("ada@example.com") };
    expect((await callBase(null, "/api/auth/status")).json.appLogin).toBe(true);
    // A device without push token: no push sign-in yet.
    expect((await call(null, "/api/auth/status")).json.pushLogin).toBeUndefined();
    await call(ada, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(1) } });
    expect((await call(null, "/api/auth/status")).json.pushLogin).toBe(true);
    // Not without APNs.
    expect((await callBase(null, "/api/auth/status")).json.pushLogin).toBeUndefined();

    bob = { token: await deviceToken("bob@example.com") };
    await call(bob, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(2) } });
  });
});

describe("QR", () => {
  it("scan → inspect → approve → the polling browser (and only it) is signed in, once", async () => {
    const res = await start({ kind: "qr" });
    expect(res.status, res.text).toBe(200);
    const { id, secret, qr, expiresAt } = res.json;
    expect(id).toMatch(/^wl_/);
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(expiresAt - Date.now()).toBeGreaterThan(2.5 * 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(3 * 60_000);
    const q = parseQr(qr);
    expect(qr.startsWith("postflare://web-login?")).toBe(true);
    expect(q).toMatchObject({ s: "https://pf.test", r: id });
    expect(qr).not.toContain(secret);
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM web_logins WHERE secret_hash = ? OR nonce_hash = ?").bind(secret, q.k).first("n")).toBe(0);

    expect((await poll(id, secret)).json.status).toBe("pending");
    expect((await poll(id, "wrong")).status).toBe(404);
    expect((await call(null, `/api/auth/app-login/${id}`)).status).toBe(404);

    // The app: device token required, and the nonce (proof the QR was seen).
    expect((await call(null, `/api/auth/app-login/${id}/inspect`, { body: { nonce: q.k } })).status).toBe(401);
    expect((await call({ cookie: (await call(null, "/api/auth/login", { body: { email: "ada@example.com", password: PW }, headers: ip() })).cookie }, `/api/auth/app-login/${id}/inspect`, { body: { nonce: q.k } })).status).toBe(401);
    expect((await call(ada, `/api/auth/app-login/${id}/inspect`, { body: {} })).status).toBe(404);
    expect((await call(ada, `/api/auth/app-login/${id}/inspect`, { body: { nonce: "x".repeat(22) } })).status).toBe(404);
    const info = await call(ada, `/api/auth/app-login/${id}/inspect`, { body: { nonce: q.k } });
    expect(info.status, info.text).toBe(200);
    expect(info.json).toMatchObject({ kind: "qr", city: "Berlin", country: "DE", browser: "Chrome", os: "macOS", server: "https://pf.test", expiresAt });
    expect(info.json.numbers).toBeUndefined();

    expect((await call(ada, `/api/auth/app-login/${id}/approve`, { body: { nonce: "nope" } })).status).toBe(404);
    expect((await call(ada, `/api/auth/app-login/${id}/approve`, { body: { nonce: q.k } })).json).toEqual({ ok: true });
    // A second approval (or someone else's) is too late.
    expect((await call(bob, `/api/auth/app-login/${id}/approve`, { body: { nonce: q.k } })).status).toBe(410);

    // Someone without the secret cannot pick up the session.
    expect((await poll(id, secret.slice(1))).status).toBe(404);
    const done = await poll(id, secret);
    expect(done.json.status).toBe("signed_in");
    expect(done.cookie).toBeTruthy();
    expect((await call({ cookie: done.cookie }, "/api/me")).json.user.email).toBe("ada@example.com");
    const again = await poll(id, secret);
    expect(again.json.status).toBe("consumed");
    expect(again.cookie).toBeUndefined();
  });

  it("expires after 3 minutes: 410 for the app, expired for the browser", async () => {
    const { id, secret, qr } = (await start({ kind: "qr" })).json;
    await E.DB.prepare("UPDATE web_logins SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run();
    const { k } = parseQr(qr);
    expect((await call(ada, `/api/auth/app-login/${id}/inspect`, { body: { nonce: k } })).status).toBe(410);
    expect((await call(ada, `/api/auth/app-login/${id}/approve`, { body: { nonce: k } })).status).toBe(410);
    expect((await poll(id, secret)).json.status).toBe("expired");
  });

  it("deny and cancel", async () => {
    const a = (await start({ kind: "qr" })).json;
    expect((await call(ada, `/api/auth/app-login/${a.id}/deny`, { body: { nonce: parseQr(a.qr).k } })).json).toEqual({ ok: true });
    expect((await poll(a.id, a.secret)).json.status).toBe("denied");
    expect((await call(ada, `/api/auth/app-login/${a.id}/approve`, { body: { nonce: parseQr(a.qr).k } })).status).toBe(410);
    const b = (await start({ kind: "qr" })).json;
    expect((await call(null, `/api/auth/app-login/${b.id}`, { method: "DELETE", headers: { "x-login-secret": "wrong" } })).status).toBe(404);
    expect((await call(null, `/api/auth/app-login/${b.id}`, { method: "DELETE", headers: { "x-login-secret": b.secret } })).json).toEqual({ ok: true });
    expect((await poll(b.id, b.secret)).json.status).toBe("expired");
  });

  it("an approval by a user disabled before the pickup does not sign in", async () => {
    const token = await deviceToken("bob@example.com");
    const a = (await start({ kind: "qr" })).json;
    expect((await call({ token }, `/api/auth/app-login/${a.id}/approve`, { body: { nonce: parseQr(a.qr).k } })).json).toEqual({ ok: true });
    await E.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(bobId).run();
    const res = await poll(a.id, a.secret);
    expect(res.json.status).toBe("denied");
    expect(res.cookie).toBeUndefined();
    // And the disabled user's device can no longer approve anything.
    const b = (await start({ kind: "qr" })).json;
    expect((await call({ token }, `/api/auth/app-login/${b.id}/approve`, { body: { nonce: parseQr(b.qr).k } })).status).toBe(401);
    await E.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(bobId).run();
    bob = { token: await deviceToken("bob@example.com") };
    await call(bob, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(2) } });
  });
});

describe("push with number matching", () => {
  it("sends a time-sensitive WEB_LOGIN alert to the user's devices; the right number approves", async () => {
    const res = await start({ kind: "push", email: "ADA@example.com" });
    expect(res.status, res.text).toBe(200);
    const { id, secret, number } = res.json;
    expect(number).toBeGreaterThanOrEqual(10);
    expect(number).toBeLessThanOrEqual(99);
    expect(res.json.qr).toBeUndefined();
    expect(apns.map((a) => a.token)).toEqual([apnsToken(1)]);
    const a = apns[0];
    expect(a.headers["apns-push-type"]).toBe("alert");
    expect(Number(a.headers["apns-expiration"])).toBe(Math.floor(res.json.expiresAt / 1000));
    expect(a.body).toEqual({
      aps: {
        alert: {
          title: "Sign-in request",
          body: "Chrome on macOS · Berlin, DE",
          "title-loc-key": "PUSH_WEB_LOGIN_TITLE",
          "title-loc-args": [],
          "loc-key": "PUSH_WEB_LOGIN_BODY",
          "loc-args": ["Chrome", "macOS", "Berlin, DE"],
        },
        sound: "default",
        "thread-id": "web-login",
        category: "WEB_LOGIN",
        "interruption-level": "time-sensitive",
      },
      type: "web_login",
      id,
    });
    // The number is not in the push.
    expect(JSON.stringify(a.body)).not.toContain(`"${number}"`);

    // Only the target user's devices may see it.
    expect((await call(bob, `/api/auth/app-login/${id}/inspect`, { body: {} })).status).toBe(404);
    const info = await call(ada, `/api/auth/app-login/${id}/inspect`, { body: {} });
    expect(info.json.kind).toBe("push");
    expect(info.json.numbers).toHaveLength(3);
    expect(new Set(info.json.numbers).size).toBe(3);
    expect(info.json.numbers).toContain(number);
    // Stable choices (re-opening the sheet must not reveal the right one by elimination).
    expect((await call(ada, `/api/auth/app-login/${id}/inspect`, { body: {} })).json.numbers).toEqual(info.json.numbers);
    expect((await call(ada, `/api/auth/app-login/${id}/approve`, { body: { number } })).json).toEqual({ ok: true });
    const done = await poll(id, secret);
    expect(done.json.status).toBe("signed_in");
    expect((await call({ cookie: done.cookie }, "/api/me")).json.user.email).toBe("ada@example.com");
  });

  it("a wrong number denies the request", async () => {
    const { id, secret, number } = (await start({ kind: "push", email: "ada@example.com" })).json;
    const wrong = number === 99 ? 98 : number + 1;
    expect((await call(ada, `/api/auth/app-login/${id}/approve`, { body: { number: wrong } })).status).toBe(403);
    expect((await poll(id, secret)).json.status).toBe("denied");
    expect((await call(ada, `/api/auth/app-login/${id}/approve`, { body: { number } })).status).toBe(410);
  });

  it("answers the same for unknown emails, users without devices and demo users, and pushes nothing", async () => {
    const t = Date.now();
    await E.DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at, is_demo) VALUES ('usr_demo_l', 'demo-l@example.com', 'Demo', 'x', 'role_instance_member', 'active', ?, ?, 1)").bind(t, t).run();
    const shapes: string[] = [];
    for (const email of ["nobody@example.com", "demo-l@example.com"]) {
      const res = await start({ kind: "push", email });
      expect(res.status).toBe(200);
      shapes.push(Object.keys(res.json).sort().join(","));
      expect((await poll(res.json.id, res.json.secret)).json.status).toBe("pending");
    }
    expect(new Set(shapes)).toEqual(new Set(["expiresAt,id,number,secret"]));
    expect(apns).toHaveLength(0);
    expect((await start({ kind: "push", email: "not-an-email" })).status).toBe(400);
  });

  it("needs APNs", async () => {
    const res = await callBase(null, "/api/auth/app-login", { body: { kind: "push", email: "ada@example.com" }, headers: ip() });
    expect(res.status).toBe(404);
  });
});

describe("throttles", () => {
  it("10 starts per IP and 3 push starts per email in 10 minutes", async () => {
    const headers = { "cf-connecting-ip": "10.90.0.1" };
    for (let i = 0; i < 10; i++) expect((await start({ kind: "qr" }, headers)).status).toBe(200);
    expect((await start({ kind: "qr" }, headers)).status).toBe(429);

    for (let i = 0; i < 3; i++) expect((await start({ kind: "push", email: "bob@example.com" })).status).toBe(200);
    expect((await start({ kind: "push", email: "bob@example.com" })).status).toBe(429);
    expect(apns).toHaveLength(3);
  });
});
