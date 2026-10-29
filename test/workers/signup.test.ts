import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker, { dailyJobs } from "../../worker/index";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// Public sign-up (docs/hosted-spec.md "Sign-up"): off by default, verified by email when email is configured (pending
// users cannot sign in, same answer for existing emails, single-use link), immediate without email, throttled per IP,
// pending users listed for admins and cleaned up after 7 days, trial when billing is on. Own D1 (SIGNUP_DB).

const sent: Array<{ to: string; subject: string; text: string }> = [];
const EMAIL = { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) } as unknown as SendEmail;
const E = { ...env, DB: env.SIGNUP_DB, EMAIL, EMAIL_FROM: "Postflare <hello@pf.test>" } as unknown as Env;
/** Same instance without email configured. */
const NOEMAIL = { ...E, EMAIL: undefined } as Env;
const PW = "password123";

async function call(client: Client | null, path: string, opts: CallOptions = {}, e: Env = E) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.ws) headers["x-workspace-id"] = client.ws;
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

let ip = 0;
const signup = (body: Record<string, unknown>, e: Env = E, addr = `10.30.0.${++ip}`) => call(null, "/api/auth/signup", { body, headers: { "cf-connecting-ip": addr } }, e);
const verify = (token: string) => call(null, "/api/auth/signup/verify", { body: { token } });
const tokenOf = (m: { text: string }) => m.text.match(/\/auth\/verify#([\w-]+)/)![1];
const login = (email: string) => call(null, "/api/auth/login", { body: { email, password: PW }, headers: { "cf-connecting-ip": `10.31.0.${++ip}` } });

let admin: Client;

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Sam", email: "sam@example.com", password: PW } });
  expect(setup.status, setup.text).toBe(200);
  admin = { cookie: sessionCookie(setup.headers)! };
});

beforeEach(() => {
  sent.length = 0;
});

describe("public sign-up", () => {
  it("is off by default (404, not in the status)", async () => {
    expect((await call(null, "/api/auth/status")).json.signup).toBeUndefined();
    expect((await signup({ name: "Ann", email: "ann@example.com", password: PW })).status).toBe(404);
    expect((await verify("x".repeat(43))).status).toBe(404);
    expect((await call(admin, "/api/admin/signup")).json).toEqual({ mode: "off", enabled: false, emailConfigured: true });
  });

  it("is turned on by an instance admin", async () => {
    const res = await call(admin, "/api/admin/signup", { method: "PATCH", body: { enabled: true } });
    expect(res.json).toEqual({ mode: "open", enabled: true, emailConfigured: true });
    expect((await call(null, "/api/auth/status")).json.signup).toBe(true);
    expect((await call(admin, "/api/admin/billing")).json.signupEnabled).toBe(true);
  });

  it("validates input", async () => {
    expect((await signup({ name: "", email: "a@b.co", password: PW })).status).toBe(400);
    expect((await signup({ name: "A", email: "nope", password: PW })).status).toBe(400);
    expect((await signup({ name: "A", email: "a@b.co", password: "short" })).status).toBe(400);
  });

  it("with email: creates a pending user and mails a confirmation link; pending users cannot sign in", async () => {
    const res = await signup({ name: "Ann", email: "ann@example.com", password: PW, workspaceName: "Ann Co" });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ ok: true, verify: true });
    expect(sessionCookie(res.headers)).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ann@example.com", subject: "Confirm your Postflare account" });
    const user = await E.DB.prepare("SELECT status, role_id FROM users WHERE email = 'ann@example.com'").first<{ status: string; role_id: string }>();
    expect(user).toEqual({ status: "pending", role_id: "role_instance_member" });
    const l = await login("ann@example.com");
    expect(l.status).toBe(403);
    expect(l.json.error).toMatch(/Confirm your email/);
    // Admins see them, marked pending; they don't count as an instance user for setup.
    const listed = (await call(admin, "/api/users")).json.find((u: any) => u.email === "ann@example.com");
    expect(listed.status).toBe("pending");
    expect((await call(null, "/api/auth/status")).json.setup).toBe(true);
    expect((await call(admin, "/api/admin/overview")).json.counts.users.pending).toBe(1);
    // Sign-in links are only for active users and only ever open a "login" link.
    expect((await call(null, "/api/auth/magic-link/verify", { body: { token: tokenOf(sent[0]) } })).status).toBe(404);

    const v = await verify(tokenOf(sent[0]));
    expect(v.status, v.text).toBe(200);
    const cookie = sessionCookie(v.headers)!;
    const me = (await call({ cookie }, "/api/me")).json;
    expect(me.user.email).toBe("ann@example.com");
    expect(me.workspaces).toHaveLength(1);
    expect(me.workspaces[0]).toMatchObject({ id: v.json.workspaceId, name: "Ann Co", role: { id: "role_ws_owner" } });
    expect(me.instancePermissions).toEqual(["instance.workspaces.create"]);
    expect((await verify(tokenOf(sent[0]))).status).toBe(400);
    expect((await login("ann@example.com")).status).toBe(200);
  });

  it("answers the same for an existing email and tells its owner to sign in instead", async () => {
    const res = await signup({ name: "Mallory", email: "ANN@example.com", password: PW });
    expect(res.json).toEqual({ ok: true, verify: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ann@example.com", subject: "You already have a Postflare account" });
    expect(sent[0].text).not.toMatch(/auth\/verify/);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'ann@example.com'").first<{ n: number }>())!.n).toBe(1);
  });

  it("a second sign-up for a pending email replaces the link; invalid tokens are 400", async () => {
    await signup({ name: "Ben", email: "ben@example.com", password: PW });
    await signup({ name: "Ben B", email: "ben@example.com", password: PW });
    expect(sent).toHaveLength(2);
    expect((await verify(tokenOf(sent[0]))).status).toBe(400);
    expect((await verify("short")).status).toBe(400);
    const v = await verify(tokenOf(sent[1]));
    expect(v.status).toBe(200);
    expect((await call({ cookie: sessionCookie(v.headers)! }, "/api/me")).json.workspaces[0].name).toBe("Ben B's workspace");
  });

  it("throttles 5 sign-ups per IP per hour", async () => {
    for (let i = 0; i < 5; i++) expect((await signup({ name: "T", email: `t${i}@example.com`, password: PW }, E, "10.99.0.1")).status).toBe(200);
    const res = await signup({ name: "T", email: "t6@example.com", password: PW }, E, "10.99.0.1");
    expect(res.status).toBe(429);
    expect((await signup({ name: "T", email: "t7@example.com", password: PW }, E, "10.99.0.2")).status).toBe(200);
  });

  it("the daily job deletes pending users after 7 days", async () => {
    await E.DB.prepare("UPDATE users SET created_at = ? WHERE email = 't0@example.com'").bind(Date.now() - 8 * 86_400_000).run();
    await dailyJobs(E);
    expect(await E.DB.prepare("SELECT 1 AS x FROM users WHERE email = 't0@example.com'").first()).toBeNull();
    expect(await E.DB.prepare("SELECT 1 AS x FROM users WHERE email = 't1@example.com'").first()).not.toBeNull();
    expect(await E.DB.prepare("SELECT 1 AS x FROM users WHERE email = 'ann@example.com'").first()).not.toBeNull();
  });

  it("without email: immediate account, signed in; an existing email answers 409", async () => {
    expect((await call(admin, "/api/admin/signup", {}, NOEMAIL)).json).toEqual({ mode: "open", enabled: true, emailConfigured: false });
    const res = await signup({ name: "Cat", email: "cat@example.com", password: PW }, NOEMAIL);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ ok: true, verify: false });
    const me = (await call({ cookie: sessionCookie(res.headers)! }, "/api/me", {}, NOEMAIL)).json;
    expect(me.workspaces[0]).toMatchObject({ id: res.json.workspaceId, name: "Cat's workspace", role: { id: "role_ws_owner" } });
    expect((await signup({ name: "Cat", email: "cat@example.com", password: PW }, NOEMAIL)).status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("starts the trial when billing is on", async () => {
    await call(admin, "/api/admin/billing/providers/polar", { method: "PUT", body: { values: { accessToken: "t", webhookSecret: "whsec_x" } } });
    await call(admin, "/api/admin/billing/plans", { body: { name: "Pro", priceMonth: 900, isTrialDefault: true, limits: { accounts: 5 } } });
    expect((await call(admin, "/api/admin/billing", { method: "PATCH", body: { activeProvider: "polar", enabled: true, trialDays: 14 } })).json.active).toBe(true);
    await signup({ name: "Dan", email: "dan@example.com", password: PW });
    const v = await verify(tokenOf(sent[0]));
    const b = (await call({ cookie: sessionCookie(v.headers)!, ws: v.json.workspaceId }, "/api/billing")).json;
    expect(b).toMatchObject({ enabled: true, exempt: false, state: "trial", status: "trialing", limits: { accounts: 5 } });
    expect(b.trialEndsAt - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
  });

  it("turning sign-up off closes it again", async () => {
    await call(admin, "/api/admin/signup", { method: "PATCH", body: { enabled: false } });
    expect((await signup({ name: "Eli", email: "eli@example.com", password: PW })).status).toBe(404);
    expect((await call(null, "/api/auth/status")).json.signup).toBeUndefined();
  });
});
