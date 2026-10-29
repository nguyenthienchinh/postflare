import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../worker/lib/crypto";
import { resetApnsJwt } from "../../worker/lib/push";
import { apnsKey, apnsToken, makeCall } from "./app-helpers";

// Support chat (docs/support-spec.md): the widget API (visitor token, CORS, the session on this origin only, honeypot
// and throttles), the staff inbox (permission, read marks, replies, notes, status, assignee), pushes to staff (APNs
// mocked through globalThis.fetch) and reply emails (fake EMAIL binding). Own D1 (SUPPORT_DB).

const key = await apnsKey();
const DB = env.SUPPORT_DB;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const EMAIL = { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) } as unknown as SendEmail;
const APNS = { APNS_PRIVATE_KEY: key.pem, APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "app.ferdi.postflare" };
const E = { ...env, DB, DEMO_MODE: "false", PUBLIC_URL: "https://pf.test", EMAIL, EMAIL_FROM: "Postflare <hello@pf.test>", ...APNS } as unknown as Env;
const call = makeCall(E);
const PW = "password123";

let apns: Array<{ token: string; body: any }> = [];
function mockFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    if (new URL(req.url).hostname.endsWith("push.apple.com")) {
      apns.push({ token: new URL(req.url).pathname.split("/").pop()!, body: await req.json() });
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch ${req.url}`);
  });
}

const V1 = "visitor-token-aaaaaaaaaaaaaaaaaaaaaaaa";
const V2 = "visitor-token-bbbbbbbbbbbbbbbbbbbbbbbb";
let ipN = 0;
const widget = (path: string, token: string | null, opts: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string } = {}) =>
  call(opts.cookie ? { cookie: opts.cookie } : null, `/api/support${path}`, {
    method: opts.method,
    body: opts.body,
    headers: {
      ...(token ? { "x-support-visitor": token } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      "cf-connecting-ip": opts.ip ?? `10.90.${++ipN}.1`,
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1",
    },
    cf: { country: "TR" },
  });

let admin: { cookie: string };
let member: { cookie: string };

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Ada Admin", email: "ada@example.com", password: PW, workspaceName: "A" } });
  expect(setup.status, setup.text).toBe(200);
  admin = { cookie: setup.cookie! };
  const t = Date.now();
  await DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES ('usr_m', 'max@example.com', 'Max Member', ?, 'role_instance_member', 'active', ?, ?)")
    .bind(await hashPassword(PW), t, t)
    .run();
  const login = await call(null, "/api/auth/login", { body: { email: "max@example.com", password: PW }, headers: { "cf-connecting-ip": "10.91.0.1" } });
  member = { cookie: login.cookie! };
  // The admin's iPhone (support pushes on) and one that turned them off; the member's phone never gets them.
  for (const [email, n, prefs] of [["ada@example.com", 1, undefined], ["ada@example.com", 2, { support: false }], ["max@example.com", 9, undefined]] as const) {
    const d = await call(null, "/api/auth/device", { body: { email, password: PW, deviceName: `iPhone ${n}` }, headers: { "cf-connecting-ip": `10.92.0.${n}` } });
    expect(d.status, d.text).toBe(200);
    expect((await call({ token: d.json.token }, "/api/devices/me", { method: "PUT", body: { apnsToken: apnsToken(n), prefs } })).status).toBe(200);
  }
});

beforeEach(() => {
  sent.length = 0;
  apns = [];
  resetApnsJwt();
  mockFetch();
});
afterEach(() => vi.restoreAllMocks());

describe("support chat", () => {
  it("is off by default; staff turn it on", async () => {
    const cfg = await widget("/widget", null);
    expect(cfg.status).toBe(200);
    expect(cfg.json).toMatchObject({ enabled: false, staff: false, signedIn: false, teamName: "Postflare" });
    expect(cfg.headers.get("access-control-allow-origin")).toBe("*");
    expect((await widget("/conversations", V1, { body: { body: "Hi" } })).status).toBe(404);
    expect((await call(member, "/api/admin/support/settings", { method: "PATCH", body: { enabled: true } })).status).toBe(403);
    const on = await call(admin, "/api/admin/support/settings", { method: "PATCH", body: { enabled: true, teamName: "Postflare team", greeting: "Hello!" } });
    expect(on.status, on.text).toBe(200);
    expect(on.json).toMatchObject({ enabled: true, teamName: "Postflare team", greeting: "Hello!", snippet: '<script src="https://pf.test/support/widget.js" async></script>' });
    expect((await widget("/widget", null, { cookie: admin.cookie })).json).toMatchObject({ enabled: true, staff: true, signedIn: true });
  });

  it("answers CORS preflights for other websites", async () => {
    const res = await widget("/conversations", null, { method: "OPTIONS", origin: "https://other.example" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("x-support-visitor");
  });

  let convId = "";
  it("a visitor starts a conversation; staff get a push; other visitors cannot read it", async () => {
    expect((await widget("/conversations", null, { body: { body: "Hi" } })).status).toBe(400);
    expect((await widget("/conversations", V1, { body: { body: "   " } })).status).toBe(400);
    expect((await widget("/conversations", V1, { body: { body: "Hi", website: "spam.example" } })).status).toBe(400);
    expect((await widget("/conversations", V1, { body: { body: "Hi", email: "nope" } })).status).toBe(400);
    // A cross-origin page with a session cookie never posts as that user.
    const res = await widget("/conversations", V1, {
      body: { body: "How do I connect YouTube?\nIt says forbidden.", name: "Vera", pageUrl: "https://pf.test/pricing" },
      cookie: member.cookie,
      origin: "https://evil.example",
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json.conversation).toMatchObject({ number: 1, status: "open", subject: "How do I connect YouTube?", name: "Vera", email: null, unread: 0, lastAuthor: "customer" });
    expect(res.json.messages).toHaveLength(1);
    convId = res.json.conversation.id;
    const row = await DB.prepare("SELECT user_id, country, staff_unread, page_url FROM support_conversations WHERE id = ?").bind(convId).first();
    expect(row).toMatchObject({ user_id: null, country: "TR", staff_unread: 1, page_url: "https://pf.test/pricing" });
    await vi.waitFor(() => expect(apns).toHaveLength(1));
    expect(apns[0].token).toBe(apnsToken(1));
    expect(apns[0].body).toMatchObject({ type: "support_message", id: convId, aps: { alert: { title: "Vera · #1", body: "How do I connect YouTube? It says forbidden." }, "thread-id": `support-${convId}` } });
    expect(apns[0].body.aps.alert["loc-key"]).toBeUndefined();

    expect((await widget(`/conversations/${convId}`, V2)).status).toBe(404);
    expect((await widget(`/conversations/${convId}/messages`, V2, { body: { body: "hijack" } })).status).toBe(404);
    expect((await widget("/conversations", V2)).json.items).toEqual([]);
    expect((await widget("/conversations", V1)).json.items.map((c: any) => c.id)).toEqual([convId]);
  });

  it("staff read, reply and note; the customer sees the reply but not the note", async () => {
    expect((await call(member, "/api/admin/support/conversations")).status).toBe(403);
    const list = await call(admin, "/api/admin/support/conversations?status=open");
    expect(list.status, list.text).toBe(200);
    expect(list.json.counts).toMatchObject({ open: 1, unread: 1 });
    expect(list.json.items[0]).toMatchObject({ id: convId, staffUnread: 1, source: "widget", country: "TR", user: null });
    expect((await call(admin, "/api/admin/support/count")).json).toEqual({ unread: 1, open: 1 });

    const detail = await call(admin, `/api/admin/support/conversations/${convId}`);
    expect(detail.json.conversation.staffUnread).toBe(0);
    expect((await call(admin, "/api/admin/support/count")).json.unread).toBe(0);

    const note = await call(admin, `/api/admin/support/conversations/${convId}/messages`, { body: { body: "Probably the allowlist", note: true } });
    expect(note.status, note.text).toBe(201);
    expect(note.json.conversation.status).toBe("open");
    const reply = await call(admin, `/api/admin/support/conversations/${convId}/messages`, { body: { body: "YouTube needs a reconnect: Accounts → Reconnect." } });
    expect(reply.status, reply.text).toBe(201);
    expect(reply.json.conversation).toMatchObject({ status: "pending", unread: 1, lastAuthor: "staff", assignee: { name: "Ada Admin" } });
    // No email: the conversation has no address yet.
    expect(sent).toHaveLength(0);

    const seen = await widget(`/conversations/${convId}`, V1);
    expect(seen.json.conversation.unread).toBe(0);
    expect(seen.json.messages.map((m: any) => m.author)).toEqual(["customer", "staff"]);
    expect(seen.json.messages[1]).toMatchObject({ authorName: "Ada Admin" });
    const after = await widget(`/conversations/${convId}?after=${seen.json.messages[1].createdAt}`, V1);
    expect(after.json.messages).toEqual([]);
  });

  it("the customer adds an email and answers: the conversation reopens; a later reply is emailed while they are away", async () => {
    expect((await widget(`/conversations/${convId}`, V1, { method: "PATCH", body: { email: "bad" } })).status).toBe(400);
    expect((await widget(`/conversations/${convId}`, V1, { method: "PATCH", body: { email: "Vera@Example.com" } })).json.conversation.email).toBe("vera@example.com");
    const msg = await widget(`/conversations/${convId}/messages`, V1, { body: { body: "Thanks, that worked!" } });
    expect(msg.status, msg.text).toBe(201);
    expect(msg.json.conversation.status).toBe("open");
    await vi.waitFor(() => expect(apns).toHaveLength(1));

    // Seen just now: no email.
    await call(admin, `/api/admin/support/conversations/${convId}/messages`, { body: { body: "Great!", status: "closed" } });
    expect(sent).toHaveLength(0);
    await DB.prepare("UPDATE support_conversations SET customer_seen_at = ? WHERE id = ?").bind(Date.now() - 10 * 60_000, convId).run();
    const r = await call(admin, `/api/admin/support/conversations/${convId}/messages`, { body: { body: "One more tip: turn on push.", status: "closed" } });
    expect(r.json.conversation.status).toBe("closed");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ to: "vera@example.com", subject: "Postflare team: new reply to your message (#1)" });
    expect(sent[0].text).toContain("One more tip: turn on push.");
    expect(sent[0].text).toContain("https://pf.test/pricing");
  });

  it("a signed-in user on this origin is linked; staff assign, rename, filter and search", async () => {
    const res = await widget("/conversations", V2, { body: { body: "Billing question" }, cookie: member.cookie });
    expect(res.status, res.text).toBe(201);
    expect(res.json.conversation).toMatchObject({ number: 2, name: "Max Member", email: "max@example.com" });
    // Same user, another browser (new visitor token): still theirs.
    const other = "visitor-token-cccccccccccccccccccccccc";
    expect((await widget("/conversations", other, { cookie: member.cookie })).json.items.map((c: any) => c.number)).toEqual([2]);
    const id = res.json.conversation.id;

    const ticket = (await call(admin, `/api/admin/support/conversations/${id}`)).json.conversation;
    expect(ticket.user).toMatchObject({ name: "Max Member", email: "max@example.com" });
    expect(ticket.workspace).toBeNull();
    expect((await call(admin, `/api/admin/support/conversations/${id}`, { method: "PATCH", body: { assigneeId: "usr_m" } })).status).toBe(400);
    const staff = await call(admin, "/api/admin/support/staff");
    const me = staff.json.items[0].id;
    const upd = await call(admin, `/api/admin/support/conversations/${id}`, { method: "PATCH", body: { assigneeId: me, subject: "Invoice", status: "pending" } });
    expect(upd.json.conversation).toMatchObject({ subject: "Invoice", status: "pending", assignee: { id: me } });
    expect((await call(admin, "/api/admin/support/conversations?status=all&mine=1")).json.items.map((c: any) => c.number)).toEqual([2, 1]);
    expect((await call(admin, "/api/admin/support/conversations?status=all&q=%232")).json.items.map((c: any) => c.number)).toEqual([2]);
    expect((await call(admin, "/api/admin/support/conversations?status=all&q=vera")).json.items.map((c: any) => c.number)).toEqual([1]);
    expect((await call(admin, "/api/admin/support/conversations?status=closed")).json.items.map((c: any) => c.number)).toEqual([1]);
    expect((await call(admin, `/api/admin/support/conversations/${id}`, { method: "DELETE" })).json).toEqual({ ok: true });
    expect((await widget(`/conversations/${id}`, V2, { cookie: member.cookie })).status).toBe(404);
  });

  it("throttles new conversations per address and messages per conversation", async () => {
    const ip = "10.99.0.1";
    for (let i = 0; i < 5; i++) expect((await widget("/conversations", `visitor-throttle-${i}-aaaaaaaaaaaaaaaaaaaa`, { body: { body: `Hi ${i}` }, ip })).status).toBe(201);
    expect((await widget("/conversations", "visitor-throttle-x-aaaaaaaaaaaaaaaaaaaa", { body: { body: "Hi" }, ip })).status).toBe(429);
    const conv = await widget("/conversations", "visitor-burst-aaaaaaaaaaaaaaaaaaaaaaaaaa", { body: { body: "Start" } });
    for (let i = 0; i < 19; i++) expect((await widget(`/conversations/${conv.json.conversation.id}/messages`, "visitor-burst-aaaaaaaaaaaaaaaaaaaaaaaaaa", { body: { body: `m${i}` } })).status).toBe(201);
    expect((await widget(`/conversations/${conv.json.conversation.id}/messages`, "visitor-burst-aaaaaaaaaaaaaaaaaaaaaaaaaa", { body: { body: "too many" } })).status).toBe(429);
  });
});
