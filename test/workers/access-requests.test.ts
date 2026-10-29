import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyJobs } from "../../worker/index";
import { hashPassword } from "../../worker/lib/crypto";
import { resetApnsJwt } from "../../worker/lib/push";
import { SITEVERIFY_URL } from "../../worker/lib/turnstile";
import { apnsKey, apnsToken, makeCall } from "./app-helpers";
import { countingD1 } from "./d1-counter";

// Access requests ("Request access" on /apply, docs/hosted-spec.md "Access requests"): the sign-up modes (off / apply /
// open, migrated from signup_enabled), the public form (validation, enumeration-safe answer, duplicate update,
// throttles, Turnstile), the admin review (permissions, approve = an email-bound invitation that the normal accept
// flow takes, with the trial when billing is on; existing accounts; reject with a note), admin notifications (APNs
// mocked through globalThis.fetch, a fake EMAIL binding) and the daily cleanup. Own D1 (ACCESS_DB).

const key = await apnsKey();
const { db: DB, count } = countingD1(env.ACCESS_DB);
const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
const EMAIL = { send: async (m: { to: string; subject: string; text: string; html: string }) => void sent.push(m) } as unknown as SendEmail;
const APNS = { APNS_PRIVATE_KEY: key.pem, APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "app.ferdi.postflare" };
const E = { ...env, DB, DEMO_MODE: "false", EMAIL, EMAIL_FROM: "Postflare <hello@pf.test>", ...APNS } as unknown as Env;
/** Same instance without email and push. */
const BARE = { ...env, DB, DEMO_MODE: "false" } as unknown as Env;
/** Same instance with Turnstile configured by env. */
const BOT = { ...E, TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekey000001", TURNSTILE_SECRET_KEY: "0x4AAAAAAAsecret-key-0000000000000001" } as unknown as Env;
const call = makeCall(E);
const callBare = makeCall(BARE);
const callBot = makeCall(BOT);
const PW = "password123";

let apns: Array<{ token: string; body: any }> = [];
let siteverify: string[] = [];
function mockFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith("push.apple.com")) {
      apns.push({ token: url.pathname.split("/").pop()!, body: await req.json() });
      return new Response(null, { status: 200 });
    }
    if (req.url === SITEVERIFY_URL) {
      const response = new URLSearchParams(String(init?.body)).get("response")!;
      siteverify.push(response);
      return Response.json(response.startsWith("ok:") ? { success: true, hostname: "pf.test", action: response.slice(3) } : { success: false, "error-codes": ["invalid-input-response"] });
    }
    throw new Error(`unexpected fetch ${req.url}`);
  });
}

let ipN = 0;
const valid = (over: Record<string, unknown> = {}) => ({
  name: "Ann Applicant",
  email: "ann@example.com",
  company: "Ann Co",
  url: "annco.example.com",
  role: "startup",
  platforms: ["tiktok", "instagram"],
  accounts: 3,
  volume: "31-100",
  useCase: "We post short clips about our habit tracker app to TikTok and Reels.",
  referral: "X",
  consent: true,
  ...over,
});
const apply = (body: Record<string, unknown>, addr = `10.80.${++ipN}.1`, c = call) => c(null, "/api/access-requests", { body, headers: { "cf-connecting-ip": addr, "user-agent": "TestAgent/1.0" }, cf: { country: "DE" } });
const setMode = (mode: string) => call(admin, "/api/admin/signup", { method: "PATCH", body: { mode } });

let admin: { cookie: string };
let member: { cookie: string };

beforeAll(async () => {
  // An instance that had public sign-up on before signup_mode existed: the migration turns it into "open".
  const setup = await call(null, "/api/auth/setup", { body: { name: "Ada", email: "ada@example.com", password: PW, workspaceName: "A" } });
  expect(setup.status, setup.text).toBe(200);
  admin = { cookie: setup.cookie! };
  const t = Date.now();
  await DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES ('usr_m', 'm@example.com', 'Max', ?, 'role_instance_member', 'active', ?, ?)")
    .bind(await hashPassword(PW), t, t)
    .run();
  const login = await call(null, "/api/auth/login", { body: { email: "m@example.com", password: PW }, headers: { "cf-connecting-ip": "10.81.0.1" } });
  member = { cookie: login.cookie! };
  // The admin's iPhone (push on) and a second device that turned access request pushes off.
  for (const [n, prefs] of [[1, undefined], [2, { accessRequests: false }]] as const) {
    const d = await call(null, "/api/auth/device", { body: { email: "ada@example.com", password: PW, deviceName: `iPhone ${n}` }, headers: { "cf-connecting-ip": `10.82.0.${n}` } });
    expect(d.status, d.text).toBe(200);
    expect((await call({ token: d.json.token }, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(n), prefs } })).status).toBe(200);
  }
  // The member's phone never gets admin pushes.
  const md = await call(null, "/api/auth/device", { body: { email: "m@example.com", password: PW, deviceName: "M" }, headers: { "cf-connecting-ip": "10.82.0.9" } });
  await call({ token: md.json.token }, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(9) } });
});

beforeEach(() => {
  sent.length = 0;
  apns = [];
  siteverify = [];
  resetApnsJwt();
  mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sign-up mode", () => {
  it("migrates signup_enabled = 1 to signup_mode open", async () => {
    const { migrate } = await import("../../worker/lib/migrate");
    const db = env.LEGACY_DB;
    await migrate(db, (n) => n < "0017");
    await db.prepare("INSERT INTO settings (key, value) VALUES ('signup_enabled', '1')").run();
    await migrate(db);
    const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'signup_%'").all<{ key: string; value: string }>();
    expect(rows.results).toEqual([{ key: "signup_mode", value: "open" }]);
  });

  it("is off by default: invitations only, the form answers 404", async () => {
    const s = (await call(null, "/api/auth/status")).json;
    expect(s.signup).toBeUndefined();
    expect(s.signupMode).toBeUndefined();
    expect((await call(admin, "/api/admin/signup")).json).toEqual({ mode: "off", enabled: false, emailConfigured: true });
    expect((await apply(valid())).status).toBe(404);
  });

  it("only instance settings admins change it; bad values are 400", async () => {
    expect((await call(member, "/api/admin/signup", { method: "PATCH", body: { mode: "apply" } })).status).toBe(403);
    expect((await setMode("nope")).status).toBe(400);
  });

  it("open: public sign-up, status keeps signup: true; the form is closed", async () => {
    expect((await setMode("open")).json).toEqual({ mode: "open", enabled: true, emailConfigured: true });
    expect((await call(null, "/api/auth/status")).json).toMatchObject({ signup: true, signupMode: "open" });
    expect((await call(admin, "/api/admin/billing")).json.signupEnabled).toBe(true);
    expect((await apply(valid())).status).toBe(404);
  });

  it("older clients: { enabled } still works, and signupEnabled false leaves apply alone", async () => {
    expect((await call(admin, "/api/admin/signup", { method: "PATCH", body: { enabled: false } })).json.mode).toBe("off");
    await setMode("apply");
    await call(admin, "/api/admin/billing", { method: "PATCH", body: { signupEnabled: false } });
    expect((await call(admin, "/api/admin/signup")).json.mode).toBe("apply");
  });

  it("apply: status has signupMode apply (no signup), /signup stays closed", async () => {
    const s = (await call(null, "/api/auth/status")).json;
    expect(s.signupMode).toBe("apply");
    expect(s.signup).toBeUndefined();
    expect((await call(null, "/api/auth/signup", { body: { name: "X", email: "x@example.com", password: PW } })).status).toBe(404);
  });
});

describe("the public form", () => {
  it("validates input", async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "" }, /Name/],
      [{ email: "nope" }, /email/],
      [{ url: "" }, /link/],
      [{ url: "javascript:alert(1)" }, /link/],
      [{ url: "localhost" }, /link/],
      [{ role: "ceo" }, /describes/],
      [{ platforms: [] }, /platforms/],
      [{ platforms: ["myspace"] }, /platforms/],
      [{ accounts: -1 }, /whole number/],
      [{ accounts: 2.5 }, /whole number/],
      [{ volume: "lots" }, /posts per month/],
      [{ useCase: "too short" }, /at least 20/],
      [{ useCase: "x".repeat(1001) }, /under 1000/],
      [{ consent: false }, /Terms/],
      [{ consent: undefined }, /Terms/],
    ];
    for (const [over, msg] of bad) {
      const res = await apply(valid(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.json.error).toMatch(msg);
    }
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM access_requests").first("n")).toBe(0);
  });

  it("stores a request, notifies the admins (push + email) within one batch, answers { ok }", async () => {
    count.reset();
    const res = await apply(valid());
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ ok: true });
    // Settings (mode, throttles), Turnstile config, one batch, and the push bookkeeping after the response.
    expect(count.sql).toEqual([expect.stringContaining("FROM settings"), expect.stringContaining("FROM settings"), "[batch of 5]", "[batch of 1]"]);
    const row = await DB.prepare("SELECT * FROM access_requests WHERE email = 'ann@example.com'").first<any>();
    expect(row).toMatchObject({
      name: "Ann Applicant",
      company: "Ann Co",
      url: "https://annco.example.com/",
      role: "startup",
      platforms: '["tiktok","instagram"]',
      accounts: 3,
      volume: "31-100",
      referral: "X",
      status: "pending",
      country: "DE",
      user_agent: "TestAgent/1.0",
    });
    expect(apns.map((a) => a.token)).toEqual([apnsToken(1)]);
    expect(apns[0].body).toMatchObject({
      aps: { alert: { "title-loc-key": "PUSH_ACCESS_REQUEST_TITLE", "loc-key": "PUSH_ACCESS_REQUEST_BODY", "loc-args": ["Ann Applicant", "Ann Co", "Startup / app developer"] }, "thread-id": "access-requests" },
      type: "access_request",
      id: row.id,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ada@example.com", subject: "Access request: Ann Applicant (Ann Co)" });
    expect(sent[0].text).toContain(`/admin/requests?id=${row.id}`);
  });

  it("a second request of a pending email updates it in place and does not notify again", async () => {
    const res = await apply(valid({ email: "ANN@example.com", company: "Ann Labs", useCase: "Actually we are an agency now, posting for three clients." }));
    expect(res.json).toEqual({ ok: true });
    const rows = await DB.prepare("SELECT company, use_case FROM access_requests WHERE email = 'ann@example.com'").all<any>();
    expect(rows.results).toEqual([{ company: "Ann Labs", use_case: "Actually we are an agency now, posting for three clients." }]);
    expect(apns).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("answers the same for an email that has an account (no enumeration, no email to the applicant)", async () => {
    const res = await apply(valid({ email: "m@example.com", name: "Max" }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(sent.every((m) => m.to === "ada@example.com")).toBe(true);
  });

  it("throttles 5 per IP per hour and 3 per email per day", async () => {
    for (let i = 0; i < 5; i++) expect((await apply(valid({ email: `ip${i}@example.com` }), "10.90.0.1")).status).toBe(200);
    expect((await apply(valid({ email: "ip5@example.com" }), "10.90.0.1")).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await apply(valid({ email: "same@example.com" }))).status).toBe(200);
    expect((await apply(valid({ email: "same@example.com" }))).status).toBe(429);
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE email = 'same@example.com'").first("n")).toBe(1);
  });

  it("needs a Turnstile token (action apply) when configured", async () => {
    expect((await callBot(null, "/api/auth/status")).json.turnstileSiteKey).toBe("0x4AAAAAAAsitekey000001");
    const missing = await apply(valid({ email: "bot@example.com" }), undefined, callBot);
    expect(missing.status).toBe(400);
    expect(missing.json.code).toBe("captcha");
    expect((await apply(valid({ email: "bot@example.com", turnstileToken: "ok:signup" }), undefined, callBot)).json.code).toBe("captcha");
    expect((await apply(valid({ email: "bot@example.com", turnstileToken: "ok:apply" }), undefined, callBot)).status).toBe(200);
    expect(siteverify).toEqual(["ok:signup", "ok:apply"]);
  });

  it("without email and push configured nothing is sent", async () => {
    expect((await apply(valid({ email: "quiet@example.com" }), undefined, callBare)).status).toBe(200);
    expect(apns).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("admin review", () => {
  const idOf = async (email: string) => (await DB.prepare("SELECT id FROM access_requests WHERE email = ? ORDER BY created_at DESC").bind(email).first<{ id: string }>())!.id;

  it("needs instance.users.manage (403 for members and signed out)", async () => {
    const id = await idOf("ann@example.com");
    expect((await call(member, "/api/access-requests")).status).toBe(403);
    expect((await call(member, `/api/access-requests/${id}`)).status).toBe(403);
    expect((await call(member, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "approved" } })).status).toBe(403);
    expect((await call(member, "/api/access-requests/count")).status).toBe(403);
    expect((await call(null, "/api/access-requests")).status).toBe(401);
    expect((await call(admin, "/api/access-requests/ar_nope")).status).toBe(404);
  });

  it("lists with a status filter, search, counts and pages", async () => {
    const all = (await call(admin, "/api/access-requests?status=pending")).json;
    expect(all.counts.pending).toBe(all.items.length);
    expect(all.items[0]).toMatchObject({ status: "pending" });
    const ann = (await call(admin, "/api/access-requests?q=ann%20labs")).json;
    expect(ann.items.map((r: any) => r.email)).toEqual(["ann@example.com"]);
    expect(ann.items[0]).toMatchObject({ platforms: ["tiktok", "instagram"], existingUser: false, invitationId: null, reviewedBy: null, country: "DE" });
    expect((await call(admin, "/api/access-requests?q=%25")).json.items).toHaveLength(0);
    const page = (await call(admin, "/api/access-requests?limit=2")).json;
    expect(page.items).toHaveLength(2);
    const next = (await call(admin, `/api/access-requests?limit=2&before=${page.nextBefore}`)).json;
    expect(next.items[0].id).not.toBe(page.items[1].id);
    expect((await call(admin, "/api/access-requests/count")).json.pending).toBe(all.counts.pending);
    expect((await call(admin, "/api/access-requests?status=nope")).status).toBe(400);
    expect((await call(admin, "/api/access-requests/x", { method: "PATCH", body: { status: "maybe" } })).status).toBe(400);
  });

  it("approve: an email-bound invitation into a new workspace, emailed; the link works with the normal accept flow (trial when billing is on)", async () => {
    // Billing on with a trial plan.
    await call(admin, "/api/admin/billing/providers/polar", { method: "PUT", body: { values: { accessToken: "t", webhookSecret: "whsec_x" } } });
    await call(admin, "/api/admin/billing/plans", { body: { name: "Pro", priceMonth: 900, isTrialDefault: true, limits: { accounts: 5 } } });
    expect((await call(admin, "/api/admin/billing", { method: "PATCH", body: { activeProvider: "polar", enabled: true, trialDays: 14 } })).json.active).toBe(true);

    const id = await idOf("ann@example.com");
    const res = await call(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "approved", note: "Welcome" } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ emailed: true, invitation: { url: expect.stringMatching(/^https:\/\/pf\.test\/invite\/[\w-]+$/) }, request: { status: "approved", reviewNote: "Welcome", reviewedBy: { name: "Ada" } } });
    expect(res.json.request.invitationId).toBe(res.json.invitation.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ann@example.com", subject: "Your Postflare access request was approved" });
    expect(sent[0].text).toContain(res.json.invitation.url);

    const inv = await DB.prepare("SELECT email, instance_role_id, workspace_id, new_workspace_name FROM invitations WHERE id = ?").bind(res.json.invitation.id).first();
    expect(inv).toEqual({ email: "ann@example.com", instance_role_id: "role_instance_member", workspace_id: null, new_workspace_name: "Ann Labs" });
    // Another admin listing invitations sees it too.
    expect((await call(admin, "/api/invitations")).json.some((i: any) => i.id === res.json.invitation.id)).toBe(true);

    // A new link revokes the old one.
    const again = await call(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "approved", notify: false } });
    expect(again.status, again.text).toBe(200);
    expect(again.json.emailed).toBe(false);
    expect(again.json.request.reviewNote).toBe("Welcome");
    const token = (u: string) => u.split("/invite/")[1];
    expect((await call(null, `/api/invitations/lookup/${token(res.json.invitation.url)}`)).status).toBe(404);
    const lookup = await call(null, `/api/invitations/lookup/${token(again.json.invitation.url)}`);
    expect(lookup.json).toMatchObject({ email: "ann@example.com", newWorkspaceName: "Ann Labs", invitedBy: "Ada" });

    // Someone else cannot use it; the applicant can.
    expect((await call(null, "/api/invitations/accept", { body: { token: token(again.json.invitation.url), name: "Eve", email: "eve@example.com", password: PW } })).status).toBe(400);
    const acc = await call(null, "/api/invitations/accept", { body: { token: token(again.json.invitation.url), name: "Ann", email: "ann@example.com", password: PW } });
    expect(acc.status, acc.text).toBe(200);
    const me = (await call({ cookie: acc.cookie! }, "/api/me")).json;
    expect(me.instancePermissions).toEqual(["instance.workspaces.create"]);
    expect(me.workspaces[0]).toMatchObject({ name: "Ann Labs", role: { id: "role_ws_owner" } });
    const b = (await call({ cookie: acc.cookie!, ws: acc.json.workspaceId }, "/api/billing")).json;
    expect(b).toMatchObject({ state: "trial", status: "trialing" });

    const after = (await call(admin, `/api/access-requests/${id}`)).json;
    expect(after).toMatchObject({ invitationAccepted: true, existingUser: true });
    expect((await call(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "approved" } })).status).toBe(409);
    expect((await call(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "rejected" } })).status).toBe(409);
  });

  it("approve when the email already has an account: only marked approved", async () => {
    const id = await idOf("m@example.com");
    expect((await call(admin, `/api/access-requests/${id}`)).json.existingUser).toBe(true);
    const res = await call(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "approved" } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ existingUser: true, emailed: false, request: { status: "approved", invitationId: null } });
    expect(res.json.invitation).toBeUndefined();
    expect(sent).toHaveLength(0);
    expect((await call(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "approved" } })).status).toBe(409);
  });

  it("reject: optional polite email with the note; rejecting an approved request revokes its link", async () => {
    const id = await idOf("ip0@example.com");
    const res = await call(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "rejected", note: "We are full for now." } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ emailed: true, request: { status: "rejected", reviewNote: "We are full for now." } });
    expect(sent[0]).toMatchObject({ to: "ip0@example.com", subject: "About your Postflare access request" });
    expect(sent[0].text).toContain("We are full for now.");
    expect((await call(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "rejected" } })).status).toBe(409);

    const id2 = await idOf("ip1@example.com");
    const ok = await call(admin, `/api/access-requests/${id2}`, { method: "PATCH", body: { status: "approved", notify: false } });
    const rej = await call(admin, `/api/access-requests/${id2}`, { method: "PATCH", body: { status: "rejected", notify: false } });
    expect(rej.json).toMatchObject({ emailed: false, request: { status: "rejected", invitationId: null } });
    expect(await DB.prepare("SELECT 1 AS x FROM invitations WHERE id = ?").bind(ok.json.invitation.id).first()).toBeNull();
    // A rejected applicant may apply again: a new pending request.
    expect((await apply(valid({ email: "ip1@example.com" }))).status).toBe(200);
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE email = 'ip1@example.com'").first("n")).toBe(2);
  });

  it("without email: approve still returns the link", async () => {
    const id = await idOf("ip2@example.com");
    const res = await callBare(admin, `/api/access-requests/${id}`, { method: "PATCH", body: { status: "approved" } });
    expect(res.json).toMatchObject({ emailed: false, invitation: { url: expect.stringContaining("/invite/") } });
    expect(sent).toHaveLength(0);
  });

  it("the daily job deletes only rejected requests older than 180 days", async () => {
    const old = Date.now() - 181 * 86_400_000;
    await DB.prepare("UPDATE access_requests SET updated_at = ?, created_at = ?").bind(old, old).run();
    const before = (await DB.prepare("SELECT status, COUNT(*) AS n FROM access_requests GROUP BY status").all<{ status: string; n: number }>()).results;
    expect(before.find((r) => r.status === "rejected")!.n).toBeGreaterThan(0);
    await dailyJobs(E);
    const after = (await DB.prepare("SELECT status, COUNT(*) AS n FROM access_requests GROUP BY status").all<{ status: string; n: number }>()).results;
    expect(after.find((r) => r.status === "rejected")).toBeUndefined();
    expect(after.filter((r) => r.status !== "rejected")).toEqual(before.filter((r) => r.status !== "rejected"));
  });

  it("turning the mode off closes the form; the admin list keeps working", async () => {
    await setMode("off");
    expect((await apply(valid({ email: "late@example.com" }))).status).toBe(404);
    expect((await call(admin, "/api/access-requests")).status).toBe(200);
  });
});
