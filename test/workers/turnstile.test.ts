import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { SITEVERIFY_URL } from "../../worker/lib/turnstile";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// Bot protection (Cloudflare Turnstile, worker/lib/turnstile.ts): off unless configured; when configured, sign-up and
// sign-in links need a valid token (action + hostname checked), sign-in only after 3 recent failures; Cloudflare down →
// 503; env keys win over the stored ones; the secret is never returned. Own D1 (TURNSTILE_DB), siteverify mocked.

const sent: Array<{ to: string; subject: string; text: string }> = [];
const EMAIL = { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) } as unknown as SendEmail;
const E = { ...env, DB: env.TURNSTILE_DB, EMAIL, EMAIL_FROM: "Postflare <hello@pf.test>" } as unknown as Env;
const PW = "password123";
const SITE = "0x4AAAAAAAsitekey000001";
const SECRET = "0x4AAAAAAAsecret-key-0000000000000001";

async function call(client: Client | null, path: string, opts: CallOptions = {}, e: Env = E) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body }) as any, e, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

type Verify = { secret: string; response: string; remoteip: string | null; idempotency_key: string | null };
let calls: Verify[] = [];
/** Mocked siteverify: `answer` gets the parsed form and returns the JSON body (or throws for a network error). */
function mockSiteverify(answer: (v: Verify) => Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input instanceof Request ? input.url : input)).toBe(SITEVERIFY_URL);
    expect(init?.method).toBe("POST");
    const form = new URLSearchParams(String(init?.body));
    const v = { secret: form.get("secret")!, response: form.get("response")!, remoteip: form.get("remoteip"), idempotency_key: form.get("idempotency_key") };
    calls.push(v);
    return Response.json(answer(v));
  });
}
/** Cloudflare's answer for a good token "ok:<action>" (hostname pf.test), anything else invalid. */
const realistic = (v: Verify) =>
  v.response.startsWith("ok:")
    ? { success: true, "error-codes": [], hostname: v.response.split(":")[2] ?? "pf.test", action: v.response.split(":")[1], challenge_ts: new Date().toISOString() }
    : { success: false, "error-codes": ["invalid-input-response"] };

let ip = 0;
const nextIp = () => `10.40.0.${++ip}`;
const signup = (body: Record<string, unknown>, e: Env = E) => call(null, "/api/auth/signup", { body: { name: "Ann", password: PW, ...body }, headers: { "cf-connecting-ip": nextIp() } }, e);
const magicLink = (body: Record<string, unknown>, e: Env = E) => call(null, "/api/auth/magic-link", { body, headers: { "cf-connecting-ip": nextIp() } }, e);
const login = (body: Record<string, unknown>, addr: string) => call(null, "/api/auth/login", { body, headers: { "cf-connecting-ip": addr } });

let admin: Client;
let member: Client;

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Sam", email: "sam@example.com", password: PW } });
  expect(setup.status, setup.text).toBe(200);
  admin = { cookie: sessionCookie(setup.headers)! };
  expect((await call(admin, "/api/admin/signup", { method: "PATCH", body: { enabled: true } })).status).toBe(200);
  expect((await call(admin, "/api/admin/email", { method: "PATCH", body: { enabled: true } })).status).toBe(200);
  // A plain member (instance Member role): immediate sign-up on the same instance without email.
  const res = await signup({ email: "mia@example.com" }, { ...E, EMAIL: undefined } as Env);
  expect(res.status, res.text).toBe(200);
  member = { cookie: sessionCookie(res.headers)! };
});

beforeEach(() => {
  sent.length = 0;
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const configure = () => call(admin, "/api/admin/turnstile", { method: "PUT", body: { siteKey: SITE, secretKey: SECRET } });
const unconfigure = () => call(admin, "/api/admin/turnstile", { method: "DELETE" });

describe("off by default", () => {
  it("no site key in the status, nothing asks for a token, siteverify is never called", async () => {
    const spy = mockSiteverify(realistic);
    expect((await call(null, "/api/auth/status")).json.turnstileSiteKey).toBeUndefined();
    expect((await call(admin, "/api/admin/turnstile")).json).toEqual({ configured: false, siteKey: null, siteKeyFromEnv: false, secretSet: false, secretFromEnv: false });
    expect((await signup({ email: "off@example.com" })).status).toBe(200);
    expect((await magicLink({ email: "sam@example.com" })).status).toBe(200);
    const addr = nextIp();
    for (let i = 0; i < 4; i++) {
      const res = await login({ email: "sam@example.com", password: "wrong-password" }, addr);
      expect(res.status).toBe(401);
      expect(res.json.captchaRequired).toBeUndefined();
    }
    expect((await login({ email: "sam@example.com", password: PW }, addr)).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("admin settings", () => {
  afterEach(async () => void (await unconfigure()));

  it("needs instance.settings.manage (403 for a member)", async () => {
    expect((await call(member, "/api/admin/turnstile")).status).toBe(403);
    expect((await call(member, "/api/admin/turnstile", { method: "PUT", body: { siteKey: SITE, secretKey: SECRET } })).status).toBe(403);
    expect((await call(member, "/api/admin/turnstile", { method: "DELETE" })).status).toBe(403);
    expect((await call(member, "/api/admin/turnstile/test", { body: { secretKey: SECRET } })).status).toBe(403);
    expect((await call(null, "/api/admin/turnstile")).status).toBe(401);
  });

  it("stores the secret encrypted and never returns it; an empty secret keeps it; Remove turns it off", async () => {
    expect((await call(admin, "/api/admin/turnstile", { method: "PUT", body: { siteKey: SITE } })).status).toBe(400);
    expect((await call(admin, "/api/admin/turnstile", { method: "PUT", body: { siteKey: "x", secretKey: SECRET } })).status).toBe(400);
    const res = await configure();
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ configured: true, siteKey: SITE, siteKeyFromEnv: false, secretSet: true, secretFromEnv: false });
    expect(res.text).not.toContain(SECRET);
    expect((await call(admin, "/api/admin/turnstile")).text).not.toContain(SECRET);
    const rows = await env.TURNSTILE_DB.prepare("SELECT value FROM settings WHERE key LIKE 'turnstile_%'").all<{ value: string }>();
    expect(rows.results.length).toBe(2);
    expect(rows.results.some((r) => r.value.includes(SECRET))).toBe(false);
    // Site key change only: the secret stays.
    const kept = await call(admin, "/api/admin/turnstile", { method: "PUT", body: { siteKey: "0x4AAAAAAAsitekey000002", secretKey: "" } });
    expect(kept.json).toMatchObject({ configured: true, siteKey: "0x4AAAAAAAsitekey000002", secretSet: true });
    expect((await call(null, "/api/auth/status")).json.turnstileSiteKey).toBe("0x4AAAAAAAsitekey000002");
    const removed = await unconfigure();
    expect(removed.json).toMatchObject({ configured: false, siteKey: null, secretSet: false });
    expect((await call(null, "/api/auth/status")).json.turnstileSiteKey).toBeUndefined();
  });

  it("Test: invalid-input-secret = bad secret, invalid-input-response = secret OK, test secret flagged", async () => {
    let answer: Record<string, unknown> = { success: false, "error-codes": ["invalid-input-secret"] };
    mockSiteverify(() => answer);
    const bad = await call(admin, "/api/admin/turnstile/test", { body: { secretKey: "0x4AAAAAAAwrong-secret-000000" } });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toMatch(/invalid-input-secret/);
    expect(calls[0]).toMatchObject({ secret: "0x4AAAAAAAwrong-secret-000000", response: "XXXX.DUMMY.TOKEN.XXXX" });
    answer = { success: false, "error-codes": ["invalid-input-response"] };
    expect((await call(admin, "/api/admin/turnstile/test", { body: { secretKey: SECRET } })).json).toEqual({ ok: true });
    answer = { success: true, hostname: "example.com", metadata: { result_with_testing_key: true } };
    expect((await call(admin, "/api/admin/turnstile/test", { body: { secretKey: "1x0000000000000000000000000000000AA" } })).json).toEqual({ ok: true, testing: true });
    // Without a secret in the body: the stored one.
    await configure();
    answer = { success: false, "error-codes": ["invalid-input-response"] };
    expect((await call(admin, "/api/admin/turnstile/test", { body: {} })).json).toEqual({ ok: true });
    expect(calls.at(-1)!.secret).toBe(SECRET);
  });
});

describe("when configured", () => {
  beforeAll(async () => void expect((await configure()).status).toBe(200));
  afterAll(async () => void (await unconfigure()));

  it("the status exposes the site key", async () => {
    expect((await call(null, "/api/auth/status")).json.turnstileSiteKey).toBe(SITE);
  });

  it("sign-up needs a valid token, checked before any work (no throttle write, no email)", async () => {
    mockSiteverify(realistic);
    const missing = await signup({ email: "bot@example.com" });
    expect(missing.status).toBe(400);
    expect(missing.json).toEqual({ error: "The bot check failed. Try again.", code: "captcha" });
    expect(calls.length).toBe(0); // no token: Cloudflare not even asked
    const wrong = await signup({ email: "bot@example.com", turnstileToken: "garbage" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.code).toBe("captcha");
    const throttle = await env.TURNSTILE_DB.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'signup:10.40.0.${ip}'`).first<{ n: number }>();
    expect(throttle!.n).toBe(0);
    expect(await env.TURNSTILE_DB.prepare("SELECT 1 FROM users WHERE email = 'bot@example.com'").first()).toBeNull();
    expect(sent.length).toBe(0);

    const ok = await signup({ email: "human@example.com", turnstileToken: "ok:signup" });
    expect(ok.status, ok.text).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["human@example.com"]);
    const v = calls.at(-1)!;
    expect(v).toMatchObject({ secret: SECRET, response: "ok:signup", remoteip: `10.40.0.${ip}` });
    expect(v.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a token solved for another action or on another hostname", async () => {
    mockSiteverify(realistic);
    expect((await signup({ email: "a1@example.com", turnstileToken: "ok:login" })).json.code).toBe("captcha");
    expect((await signup({ email: "a2@example.com", turnstileToken: "ok:signup:evil.example" })).json.code).toBe("captcha");
    expect((await magicLink({ email: "sam@example.com", turnstileToken: "ok:signup" })).status).toBe(400);
    // The PUBLIC_URL host is accepted too.
    const pub = { ...E, PUBLIC_URL: "https://social.example.com" } as Env;
    expect((await signup({ email: "a3@example.com", turnstileToken: "ok:signup:social.example.com" }, pub)).status).toBe(200);
  });

  it("sign-in links need a valid token", async () => {
    mockSiteverify(realistic);
    const missing = await magicLink({ email: "sam@example.com" });
    expect(missing.status).toBe(400);
    expect(missing.json.code).toBe("captcha");
    expect(sent.length).toBe(0);
    expect((await magicLink({ email: "sam@example.com", turnstileToken: "ok:magic_link" })).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["sam@example.com"]);
  });

  it("sign-in needs it only after 3 recent failures, then succeeds with a token", async () => {
    mockSiteverify(realistic);
    const addr = nextIp();
    const bad = { email: "sam@example.com", password: "wrong-password" };
    expect((await login(bad, addr)).json.captchaRequired).toBeUndefined();
    expect((await login(bad, addr)).json.captchaRequired).toBeUndefined();
    const third = await login(bad, addr);
    expect(third.status).toBe(401);
    expect(third.json).toEqual({ error: "Wrong email or password", captchaRequired: true });
    expect(calls.length).toBe(0);

    // Right password without the token: refused before the password is checked.
    const noToken = await login({ email: "sam@example.com", password: PW }, addr);
    expect(noToken.status).toBe(400);
    expect(noToken.json).toMatchObject({ code: "captcha", captchaRequired: true });
    expect(sessionCookie(noToken.headers)).toBeUndefined();
    // Another IP, same email: the email's failures count too.
    expect((await login({ email: "sam@example.com", password: PW }, nextIp())).json.code).toBe("captcha");
    expect((await login({ email: "sam@example.com", password: PW, turnstileToken: "ok:signup" }, addr)).status).toBe(400);

    const ok = await login({ email: "sam@example.com", password: PW, turnstileToken: "ok:login" }, addr);
    expect(ok.status, ok.text).toBe(200);
    expect(sessionCookie(ok.headers)).toBeDefined();
    // Success clears the counters: no token needed any more.
    expect((await login({ email: "sam@example.com", password: PW }, addr)).status).toBe(200);
  });

  it("fails closed when Cloudflare cannot be reached (503)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("network down");
    });
    const res = await signup({ email: "down@example.com", turnstileToken: "ok:signup" });
    expect(res.status).toBe(503);
    expect(res.json.error).toMatch(/could not reach Cloudflare/i);
    expect(await env.TURNSTILE_DB.prepare("SELECT 1 FROM users WHERE email = 'down@example.com'").first()).toBeNull();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    expect((await magicLink({ email: "sam@example.com", turnstileToken: "ok:magic_link" })).status).toBe(503);
    vi.restoreAllMocks();
    mockSiteverify(() => ({ success: false, "error-codes": ["internal-error"] }));
    expect((await signup({ email: "down@example.com", turnstileToken: "ok:signup" })).status).toBe(503);
  });

  it("is not asked of API keys or the first-run setup", async () => {
    const spy = mockSiteverify(realistic);
    const key = await call(admin, "/api/keys", { body: { name: "agent" } });
    expect(key.status, key.text).toBe(201);
    const me = await call(null, "/api/me", { headers: { authorization: `Bearer ${key.json.token}` } });
    expect(me.status, me.text).toBe(200);
    // Setup never asks for a token (here: already set up → 409, not a captcha error).
    expect((await call(null, "/api/auth/setup", { body: { name: "X", email: "x@example.com", password: PW } })).status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("env override", () => {
  const ENV = { ...E, TURNSTILE_SITE_KEY: "0x4AAAAAAAenv-site-key", TURNSTILE_SECRET_KEY: "0x4AAAAAAAenv-secret-key-000000" } as Env;
  afterEach(async () => void (await unconfigure()));

  it("the env keys win over the stored ones and are read-only", async () => {
    await configure();
    expect((await call(null, "/api/auth/status", {}, ENV)).json.turnstileSiteKey).toBe("0x4AAAAAAAenv-site-key");
    const state = await call(admin, "/api/admin/turnstile", {}, ENV);
    expect(state.json).toEqual({ configured: true, siteKey: "0x4AAAAAAAenv-site-key", siteKeyFromEnv: true, secretSet: true, secretFromEnv: true });
    expect(state.text).not.toContain("env-secret");
    mockSiteverify(realistic);
    expect((await signup({ email: "envuser@example.com", turnstileToken: "ok:signup" }, ENV)).status).toBe(200);
    expect(calls.at(-1)!.secret).toBe("0x4AAAAAAAenv-secret-key-000000");
    // Saving with env keys does not store a site key; Remove only removes stored keys (still on through the env).
    expect((await call(admin, "/api/admin/turnstile", { method: "DELETE" }, ENV)).json.configured).toBe(true);
  });

  it("the env alone turns it on", async () => {
    expect((await call(null, "/api/auth/status", {}, ENV)).json.turnstileSiteKey).toBe("0x4AAAAAAAenv-site-key");
    expect((await signup({ email: "envuser2@example.com" }, ENV)).json.code).toBe("captcha");
    // Only a site key in the env, no secret anywhere: still off.
    const half = { ...E, TURNSTILE_SITE_KEY: "0x4AAAAAAAenv-site-key" } as Env;
    expect((await call(null, "/api/auth/status", {}, half)).json.turnstileSiteKey).toBeUndefined();
  });
});
