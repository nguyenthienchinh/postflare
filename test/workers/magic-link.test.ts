import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../../worker/index";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// Sign-in links by email: off by default (instance admin toggle), no account enumeration, single use, expiry, disabled
// users, turning off kills links, throttling, the admin test email. Own D1 (MAGIC_LINK_DB).

const sent: Array<{ to: string; text: string; from: unknown }> = [];
let failSend: { code: string; message: string } | null = null;
const EMAIL = {
  send: async (m: { to: string; text: string; from: unknown }) => {
    if (failSend) throw Object.assign(new Error(failSend.message), { code: failSend.code });
    sent.push(m);
  },
} as unknown as SendEmail;
const E = { ...env, DB: env.MAGIC_LINK_DB, EMAIL, EMAIL_FROM: "Postflare <login@pf.test>" } as unknown as Env;
/** Same instance without the EMAIL binding (email not configured). */
const OFF = { ...E, EMAIL: undefined } as Env;
const PW = "password123";

async function call(client: Client | null, path: string, opts: CallOptions = {}, e: Env = E) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body }) as Request<unknown, IncomingRequestCfProperties>, e, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

let ip = 0;
const requestLink = (email: string, headers: Record<string, string> = { "cf-connecting-ip": `10.20.0.${++ip}` }, e: Env = E) =>
  call(null, "/api/auth/magic-link", { body: { email }, headers }, e);
const verify = (token: string, e: Env = E) => call(null, "/api/auth/magic-link/verify", { body: { token } }, e);
const tokenOf = (m: { text: string }) => m.text.match(/\/auth\/link#([\w-]+)/)![1];
const setEnabled = (enabled: boolean, e: Env = E) => call(owner, "/api/admin/email", { method: "PATCH", body: { enabled } }, e);

let owner: Client;
let member: Client;
let memberId: string;

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Mia", email: "mia@example.com", password: PW } });
  expect(setup.status, setup.text).toBe(200);
  owner = { cookie: sessionCookie(setup.headers)! };
  const ws = (await call(owner, "/api/me")).json.currentWorkspaceId;
  const inv = await call(owner, "/api/invitations", { body: { workspaceId: ws, workspaceRoleId: "role_ws_viewer", instanceRoleId: "role_instance_member" } });
  expect(inv.status, inv.text).toBe(201);
  const accepted = await call(null, "/api/invitations/accept", { body: { token: inv.json.url.split("/invite/")[1], name: "Noah", email: "noah@example.com", password: PW } });
  expect(accepted.status, accepted.text).toBe(200);
  member = { cookie: sessionCookie(accepted.headers)! };
  memberId = (await call(member, "/api/me")).json.user.id;
});

beforeEach(async () => {
  sent.length = 0;
  failSend = null;
  // Each test starts with fresh throttle counters (3 links per email in 15 minutes).
  await E.DB.prepare("DELETE FROM settings WHERE key LIKE 'magic_link:%'").run();
});

describe("sign-in links by email", () => {
  it("is off by default: no magicLink in the status, endpoints answer 404", async () => {
    expect((await call(null, "/api/auth/status")).json.magicLink).toBeUndefined();
    expect((await call(owner, "/api/admin/email")).json).toEqual({ configured: true, from: "Postflare <login@pf.test>", enabled: false });
    expect((await requestLink("mia@example.com")).status).toBe(404);
    expect((await verify("x".repeat(43))).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("refuses to turn on when email is not configured", async () => {
    expect((await call(owner, "/api/admin/email", {}, OFF)).json).toEqual({ configured: false, from: "Postflare <login@pf.test>", enabled: false });
    const res = await setEnabled(true, OFF);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/EMAIL_FROM.*Workers Paid/);
    expect((await call(owner, "/api/admin/email/test", { body: {} }, OFF)).status).toBe(400);
  });

  it("is admin only", async () => {
    expect((await call(member, "/api/admin/email")).status).toBe(403);
    expect((await call(member, "/api/admin/email", { method: "PATCH", body: { enabled: true } })).status).toBe(403);
    expect((await call(member, "/api/admin/email/test", { body: {} })).status).toBe(403);
    expect((await call(null, "/api/admin/email")).status).toBe(401);
  });

  it("turns on when configured; status then has magicLink (only while configured)", async () => {
    const res = await setEnabled(true);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ configured: true, from: "Postflare <login@pf.test>", enabled: true });
    expect((await call(null, "/api/auth/status")).json).toMatchObject({ magicLink: true });
    expect((await call(null, "/api/auth/status", {}, OFF)).json.magicLink).toBeUndefined();
    expect((await requestLink("mia@example.com", undefined, OFF)).status).toBe(404);
  });

  it("answers the same for unknown emails and sends nothing", async () => {
    const res = await requestLink("nobody@example.com");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it("signs in once with the emailed link, and ends the user's other links", async () => {
    expect((await requestLink(" MIA@example.com ")).status).toBe(200);
    expect((await requestLink("mia@example.com")).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0].to).toBe("mia@example.com");
    expect(sent[0].from).toEqual({ name: "Postflare", email: "login@pf.test" });
    expect(sent[0].text).toContain(`${ORIGIN}/auth/link#`);
    const [first, second] = sent.map(tokenOf);

    const res = await verify(first);
    expect(res.status, res.text).toBe(200);
    const cookie = sessionCookie(res.headers)!;
    expect((await call({ cookie }, "/api/me")).json.user.email).toBe("mia@example.com");
    // Single use, and the other open link ended with it.
    expect((await verify(first)).json.error).toBe("This sign-in link is invalid, used or expired. Request a new one.");
    expect((await verify(second)).status).toBe(400);
    expect((await verify("nope")).status).toBe(400);
  });

  it("refuses expired links and links of disabled users", async () => {
    await requestLink("mia@example.com");
    await E.DB.prepare("UPDATE magic_links SET expires_at = ? WHERE used_at IS NULL").bind(Date.now() - 1).run();
    expect((await verify(tokenOf(sent[0]))).status).toBe(400);

    // Disabled after the link was sent → 403.
    await requestLink("noah@example.com");
    await E.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(memberId).run();
    expect((await verify(tokenOf(sent[1]))).status).toBe(403);
    // No link for a disabled account.
    await requestLink("noah@example.com");
    expect(sent).toHaveLength(2);
    await E.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(memberId).run();

    // Disabling through the admin API deletes the user's links.
    await requestLink("noah@example.com");
    expect((await call(owner, `/api/users/${memberId}`, { method: "PATCH", body: { status: "disabled" } })).status).toBe(200);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE user_id = ?").bind(memberId).first<{ n: number }>())!.n).toBe(0);
    expect((await verify(tokenOf(sent[2]))).status).toBe(400);
    expect((await call(owner, `/api/users/${memberId}`, { method: "PATCH", body: { status: "active" } })).status).toBe(200);
  });

  it("turning it off kills outstanding links", async () => {
    await requestLink("mia@example.com");
    const token = tokenOf(sent[0]);
    expect((await setEnabled(false)).json.enabled).toBe(false);
    expect((await verify(token)).status).toBe(404);
    expect((await call(null, "/api/auth/status")).json.magicLink).toBeUndefined();
    await setEnabled(true);
    expect((await verify(token)).status).toBe(400);
  });

  it("throttles 3 per email and 10 per IP, and refuses cross-site requests", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await requestLink("throttle@example.com")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const sameIp = { "cf-connecting-ip": "10.30.0.1" };
    const byIp = [];
    for (let i = 0; i < 11; i++) byIp.push((await requestLink(`ip${i}@example.com`, sameIp)).status);
    expect(byIp.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(byIp[10]).toBe(429);
    expect((await requestLink("x@example.com", { origin: "https://evil.example" })).status).toBe(403);
    expect((await call(null, "/api/auth/magic-link/verify", { body: { token: "x" }, headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("sends a test email to the admin, returning Cloudflare's error on failure", async () => {
    const ok = await call(owner, "/api/admin/email/test", { body: {} });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toEqual({ ok: true, to: "mia@example.com" });
    expect(sent.map((m) => m.to)).toEqual(["mia@example.com"]);
    failSend = { code: "E_SENDER_NOT_VERIFIED", message: "sender domain not verified" };
    const bad = await call(owner, "/api/admin/email/test", { body: {} });
    expect(bad.status).toBe(502);
    expect(bad.json.error).toContain("E_SENDER_NOT_VERIFIED");
    expect(bad.json.error).toContain("sender domain not verified");
  });

  it("deletes a user's links when the user is deleted", async () => {
    await requestLink("noah@example.com");
    expect(sent).toHaveLength(1);
    expect((await call(owner, `/api/users/${memberId}`, { method: "DELETE" })).status).toBe(200);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE user_id = ?").bind(memberId).first<{ n: number }>())!.n).toBe(0);
  });
});
