import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { publishGate } from "../../worker/workflow";
import { enforceWorkspace, loadSnapshot, type LimitAdds } from "../../worker/billing/entitlements";
import { newMeter, publishEventStatement } from "../../worker/lib/usage";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// Hosted mode (docs/hosted-spec.md): billing off changes nothing, enabling is refused until configured, plans CRUD,
// trials (start, one per user, expiry), every limit key, the locked state, exempt / manual overrides, permissions,
// checkout and portal of the three providers with a mocked fetch, the admin overview numbers. Own D1 (BILLING_DB).

// Scheduled posts get a stub workflow: nothing here publishes, and terminating real sleeping instances is noisy.
const workflowStub = {
  create: async ({ id }: { id: string }) => ({ id }),
  createBatch: async (list: Array<{ id: string }>) => list.map(({ id }) => ({ id })),
  get: async (id: string) => ({ id, status: async () => ({ status: "waiting" }), terminate: async () => {} }),
};
const E = { ...env, DB: env.BILLING_DB, PUBLISH_WORKFLOW: workflowStub } as unknown as Env;
const PW = "password123";

async function call(client: Client | null, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.key) headers.authorization = `Bearer ${client.key}`;
  if (client?.ws && !headers["x-workspace-id"]) headers["x-workspace-id"] = client.ws;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(opts.body);
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body }) as any, E, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

const one = <T>(sql: string, ...binds: unknown[]) => E.DB.prepare(sql).bind(...binds).first<T>();
const run = (sql: string, ...binds: unknown[]) => E.DB.prepare(sql).bind(...binds).run();

/** Mocks global fetch (provider APIs) with `answer`; returns the recorded requests. */
function mockFetch(answer: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(answer(url, init ?? {})), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

let ada: Client; // instance admin, Owner of adaWs
let adaWs: string;
let eve: Client; // Editor in adaWs
let bob: Client; // instance Member, Owner of bobWs
let bobWs: string;
let proId: string;
let freeId: string;

const billing = (client: Client, ws?: string) => call(ws ? { ...client, ws } : client, "/api/billing");
const connectWebhook = (client: Client, url: string) => call(client, "/api/connect/webhook", { body: { values: { name: "Hook", url } } });
const draft = (client: Client, accountIds: string[]) => call(client, "/api/posts", { body: { posts: accountIds.map((accountId) => ({ accountId, content: "Hello" })), scheduledAt: null } });

/** A time later in the current UTC month (flaky only in its last minute). */
const soon = () => Date.now() + 60_000;
/** Mid UTC month `k` months from now. */
const inMonths = (k: number) => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 15);
};
const nextMonth = () => inMonths(1);
const monthName = (t: number) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(t);
const schedule = (client: Client, accountIds: string[], scheduledAt: number | "now") =>
  call(client, "/api/posts", { body: { posts: accountIds.map((accountId) => ({ accountId, content: "Hello" })), scheduledAt } });
const patch = (client: Client, id: string, body: Record<string, unknown>) => call(client, `/api/posts/${id}`, { method: "PATCH", body });
const usage = async (ws: string) => (await billing(bob, ws)).json.usage;
const trialAccount = async () => (await one<{ id: string }>("SELECT id FROM accounts WHERE workspace_id = ? AND provider = 'webhook'", trialWs))!.id;

/** Ids of the workspace's posts in `status` (scheduled ones: in the month of `month`, default this month). */
async function postsIn(ws: string, status: string, month = soon()) {
  const d = new Date(month);
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const inMonth = status === "scheduled";
  const { results } = await E.DB.prepare(
    `SELECT id FROM posts WHERE workspace_id = ? AND status = ? ${inMonth ? "AND scheduled_at >= ? AND scheduled_at < ?" : ""} ORDER BY created_at, id`,
  )
    .bind(...(inMonth ? [ws, status, from, to] : [ws, status]))
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** What the publish workflow's final batch does: the post's outcome plus its usage event (worker/lib/usage.ts). */
async function finish(postId: string, status: "published" | "failed" | "needs_check") {
  const row = (await one<{ revision: number }>("SELECT revision FROM posts WHERE id = ?", postId))!;
  const t = Date.now();
  await E.DB.batch([
    E.DB.prepare("UPDATE posts SET status = ?, updated_at = ?, published_at = ? WHERE id = ?").bind(status, t, status === "published" ? t : null, postId),
    publishEventStatement(E.DB, { postId, revision: row.revision, status, t, meter: newMeter() }),
  ]);
  expect(await one("SELECT id FROM usage_events WHERE post_id = ? AND outcome = ?", postId, status)).not.toBeNull();
}

async function insertAccount(workspaceId: string, provider: string, status = "active") {
  const id = `acc_${provider}_${Math.random().toString(36).slice(2, 10)}`;
  await run(
    "INSERT INTO accounts (id, provider, external_id, name, credentials_enc, status, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?)",
    id,
    provider,
    id,
    `${provider} account`,
    status,
    Date.now(),
    Date.now(),
    workspaceId,
  );
  return id;
}

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Ada", email: "ada@example.com", password: PW } });
  expect(setup.status, setup.text).toBe(200);
  ada = { cookie: sessionCookie(setup.headers)! };
  adaWs = (await call(ada, "/api/me")).json.currentWorkspaceId;
  ada.ws = adaWs;
  const inv = await call(ada, "/api/invitations", { body: { workspaceId: adaWs, workspaceRoleId: "role_ws_editor", instanceRoleId: "role_instance_member" } });
  const accepted = await call(null, "/api/invitations/accept", { body: { token: inv.json.url.split("/invite/")[1], name: "Eve", email: "eve@example.com", password: PW } });
  expect(accepted.status, accepted.text).toBe(200);
  eve = { cookie: sessionCookie(accepted.headers)!, ws: adaWs };
  const inv2 = await call(ada, "/api/invitations", { body: { instanceRoleId: "role_instance_member", newWorkspaceName: "Bob" } });
  const accepted2 = await call(null, "/api/invitations/accept", { body: { token: inv2.json.url.split("/invite/")[1], name: "Bob", email: "bob@example.com", password: PW } });
  expect(accepted2.status, accepted2.text).toBe(200);
  bobWs = accepted2.json.workspaceId;
  bob = { cookie: sessionCookie(accepted2.headers)!, ws: bobWs };
});

describe("billing off (default)", () => {
  it("reports unlimited, no plans, no usage, and refuses checkout", async () => {
    const b = await billing(bob);
    expect(b.status, b.text).toBe(200);
    expect(b.json).toMatchObject({ enabled: false, state: "unlimited", usage: null, limits: null, plans: [], canManage: true, status: "none" });
    expect((await call(null, "/api/billing/plans")).json).toEqual({ enabled: false, currency: "USD", plans: [] });
    expect((await call(bob, "/api/billing/checkout", { body: { planId: "pln_x", interval: "month" } })).status).toBe(409);
  });

  it("enforces nothing", async () => {
    const acc = await connectWebhook(bob, "https://hooks.example.com/off-1");
    expect(acc.status, acc.text).toBe(200);
    const res = await draft(bob, [acc.json.ids[0], acc.json.ids[0], acc.json.ids[0]]);
    expect(res.status, res.text).toBe(201);
    expect((await call(bob, "/api/keys", { method: "POST", body: { name: "k" } })).status).toBe(201);
  });

  it("gives billing.manage to Owners only", async () => {
    const me = await call(eve, "/api/me");
    expect(me.json.workspaces[0].permissions).not.toContain("billing.manage");
    expect((await call(bob, "/api/me")).json.workspaces.find((w: any) => w.id === bobWs).permissions).toContain("billing.manage");
    const roles = (await call(ada, "/api/roles")).json;
    expect(roles.find((r: any) => r.id === "role_ws_owner").permissions).toContain("billing.manage");
    expect(roles.find((r: any) => r.id === "role_ws_admin").permissions).not.toContain("billing.manage");
  });
});

describe("admin billing", () => {
  it("needs instance.settings.manage / instance.users.manage", async () => {
    expect((await call(eve, "/api/admin/billing")).status).toBe(403);
    expect((await call(bob, "/api/admin/billing/plans", { body: { name: "X" } })).status).toBe(403);
    expect((await call(bob, `/api/admin/workspaces/${bobWs}/billing`, { method: "PATCH", body: { exempt: true } })).status).toBe(403);
    expect((await call(bob, "/api/admin/billing/workspaces")).status).toBe(403);
  });

  it("starts off, Polar first, and refuses to turn on until a provider and a paid plan exist", async () => {
    const s = await call(ada, "/api/admin/billing");
    expect(s.status, s.text).toBe(200);
    expect(s.json).toMatchObject({ enabled: false, active: false, activeProvider: null, trialDays: 7, pastDueGraceDays: 7, signupEnabled: false, emailConfigured: false });
    expect(s.json.providers.map((p: any) => p.id)).toEqual(["polar", "stripe", "lemonsqueezy"]);
    expect(s.json.providers[0]).toMatchObject({ recommended: true, configured: false, sandbox: false, webhookUrl: `${ORIGIN}/api/billing/webhooks/polar` });
    expect(s.json.providers[1].sandbox).toBeNull();
    expect(s.json.limits.map((l: any) => l.key)).toEqual(["accounts", "posts_per_month", "x_posts_per_month", "members", "storage_mb", "api"]);
    const on = await call(ada, "/api/admin/billing", { method: "PATCH", body: { enabled: true } });
    expect(on.status).toBe(400);
    expect(on.json.problems).toHaveLength(2);
    expect(on.json.error).toMatch(/can't be turned on yet/);
  });

  it("stores provider credentials encrypted and never returns secrets", async () => {
    const res = await call(ada, "/api/admin/billing/providers/polar", { method: "PUT", body: { values: { accessToken: "polar_oat_secret", webhookSecret: "whsec_c2VjcmV0" }, sandbox: true } });
    expect(res.status, res.text).toBe(200);
    const polar = res.json.providers[0];
    expect(polar).toMatchObject({ configured: true, sandbox: true });
    expect(polar.fields.every((f: any) => f.set && f.value === null)).toBe(true);
    expect(res.text).not.toContain("polar_oat_secret");
    const stored = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'billing_provider:polar'");
    expect(stored!.value.startsWith("v1.")).toBe(true);
    expect(stored!.value).not.toContain("polar_oat_secret");
    // An empty secret keeps the stored one; unknown fields are refused.
    expect((await call(ada, "/api/admin/billing/providers/polar", { method: "PUT", body: { values: { accessToken: "" } } })).json.providers[0].configured).toBe(true);
    expect((await call(ada, "/api/admin/billing/providers/polar", { method: "PUT", body: { values: { nope: "x" } } })).status).toBe(400);
    expect((await call(ada, "/api/admin/billing/providers/paypal", { method: "PUT", body: { values: {} } })).status).toBe(404);
  });

  it("tests the connection with one API call", async () => {
    const calls = mockFetch(() => ({ items: [{ name: "Acme", slug: "acme" }] }));
    const res = await call(ada, "/api/admin/billing/providers/polar/test", { method: "POST" });
    expect(res.json).toEqual({ ok: true, account: "Acme (acme) · sandbox" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sandbox-api.polar.sh/v1/organizations/?limit=1");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer polar_oat_secret");
  });

  it("creates suggested plans and deletes unused plans", async () => {
    const res = await call(ada, "/api/admin/billing/plans/suggested", { method: "POST" });
    expect(res.status, res.text).toBe(201);
    expect(res.json.map((p: any) => p.name)).toEqual(["Free", "Creator", "Team"]);
    expect(res.json[0]).toMatchObject({ isFree: true, limits: { accounts: 3, posts_per_month: 30, x_posts_per_month: 0, members: 1, storage_mb: 500, api: false } });
    expect(res.json[1]).toMatchObject({ priceMonth: 1900, isTrialDefault: true, highlight: true });
    for (const p of res.json) {
      const del = await call(ada, `/api/admin/billing/plans/${p.id}`, { method: "DELETE" });
      expect(del.json).toEqual({ ok: true });
    }
    expect((await call(ada, "/api/admin/billing/plans")).json).toEqual([]);
  });

  it("validates and saves plans; free and trial default are exclusive", async () => {
    expect((await call(ada, "/api/admin/billing/plans", { body: { name: "Bad", limits: { bogus: 1 } } })).status).toBe(400);
    expect((await call(ada, "/api/admin/billing/plans", { body: { name: "Bad", limits: { accounts: -1 } } })).status).toBe(400);
    expect((await call(ada, "/api/admin/billing/plans", { body: { name: "Bad", priceMonth: 9.5 } })).status).toBe(400);
    expect((await call(ada, "/api/admin/billing/plans", { body: { name: "Bad", providerPrices: { paypal: { month: "x" } } } })).status).toBe(400);
    const free = await call(ada, "/api/admin/billing/plans", { body: { name: "Free", isFree: true, limits: { posts_per_month: 30, x_posts_per_month: 0, api: false } } });
    expect(free.status, free.text).toBe(201);
    freeId = free.json.id;
    const pro = await call(ada, "/api/admin/billing/plans", {
      body: {
        name: "Pro",
        priceMonth: 1900,
        features: ["1 account"],
        isTrialDefault: true,
        limits: { accounts: 1, posts_per_month: 2, x_posts_per_month: 0, members: 1, storage_mb: 1, api: false },
        providerPrices: { polar: { month: "prod_m" }, stripe: { month: "price_m" }, lemonsqueezy: { month: "123" } },
      },
    });
    expect(pro.status, pro.text).toBe(201);
    proId = pro.json.id;
    expect(pro.json).toMatchObject({ name: "Pro", currency: "USD", priceYear: null, active: true, workspaces: 0, providerPrices: { polar: { month: "prod_m" } } });
    const other = await call(ada, "/api/admin/billing/plans", { body: { name: "Other", isFree: true } });
    expect((await call(ada, "/api/admin/billing/plans")).json.find((p: any) => p.id === freeId).isFree).toBe(false);
    await call(ada, `/api/admin/billing/plans/${freeId}`, { method: "PATCH", body: { isFree: true, description: "Starter" } });
    const list = (await call(ada, "/api/admin/billing/plans")).json;
    expect(list.find((p: any) => p.id === other.json.id).isFree).toBe(false);
    expect(list.find((p: any) => p.id === freeId)).toMatchObject({ isFree: true, description: "Starter" });
    expect((await call(ada, `/api/admin/billing/plans/${other.json.id}`, { method: "DELETE" })).json).toEqual({ ok: true });
  });

  it("turns on once Polar is the active provider; workspaces that existed become exempt", async () => {
    const res = await call(ada, "/api/admin/billing", { method: "PATCH", body: { activeProvider: "polar", enabled: true } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ enabled: true, active: true, problems: [], activeProvider: "polar" });
    expect((await billing(ada)).json).toMatchObject({ enabled: true, exempt: true, state: "unlimited" });
    expect((await billing(bob)).json).toMatchObject({ enabled: true, exempt: true, state: "unlimited" });
    const plans = (await call(null, "/api/billing/plans")).json;
    expect(plans.enabled).toBe(true);
    expect(plans.plans.map((p: any) => [p.name, p.checkoutIntervals])).toEqual([
      ["Free", []],
      ["Pro", ["month"]],
    ]);
  });
});

let trialWs: string;
let freeWs: string;

describe("trials and limits", () => {
  it("a new workspace starts the trial on the trial default plan; a user gets one trial", async () => {
    const created = await call(bob, "/api/workspaces", { body: { name: "Trial" } });
    expect(created.status, created.text).toBe(201);
    trialWs = created.json.id;
    const b = (await billing(bob, trialWs)).json;
    expect(b).toMatchObject({ enabled: true, exempt: false, state: "trial", status: "trialing", subscribedPlanId: proId, canManage: true });
    expect(b.plan).toMatchObject({ id: proId, name: "Pro" });
    expect(b.trialEndsAt - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(b.limits).toEqual({ accounts: 1, posts_per_month: 2, x_posts_per_month: 0, members: 1, storage_mb: 1, api: false });
    const second = await call(bob, "/api/workspaces", { body: { name: "Second" } });
    freeWs = second.json.id;
    expect((await billing(bob, freeWs)).json).toMatchObject({ state: "free", status: "none", plan: { id: freeId } });
  });

  it("accounts: new ones count, reconnects don't, re-enabling counts", async () => {
    const c = { ...bob, ws: trialWs };
    expect((await connectWebhook(c, "https://hooks.example.com/t1")).status).toBe(200);
    const second = await connectWebhook(c, "https://hooks.example.com/t2");
    expect(second.status, second.text).toBe(402);
    expect(second.json).toMatchObject({ code: "plan_limit", limit: "accounts", used: 1, max: 1, upgradeUrl: `${ORIGIN}/workspace?tab=billing` });
    expect((await connectWebhook(c, "https://hooks.example.com/t1")).status).toBe(200);
    const disabled = await insertAccount(trialWs, "webhook", "disabled");
    const enable = await call(c, `/api/accounts/${disabled}`, { method: "PATCH", body: { status: "active" } });
    expect(enable.status).toBe(402);
    expect(enable.json.limit).toBe("accounts");
    await run("DELETE FROM accounts WHERE id = ?", disabled);
  });

  it("accounts: an OAuth callback over the limit names it in the redirect (the app opens the upgrade dialog)", async () => {
    expect((await call(ada, "/api/platforms/x", { method: "PUT", body: { values: { clientId: "cid", clientSecret: "secret" } } })).status).toBe(200);
    const bobId = (await call(bob, "/api/me")).json.user.id;
    await run("INSERT INTO oauth_states (state, provider, code_verifier, user_id, workspace_id, created_at) VALUES ('state-over', 'x', 'v', ?, ?, ?)", bobId, trialWs, Date.now());
    mockFetch((url) =>
      url.includes("/oauth2/token") ? { access_token: "at", refresh_token: "rt", expires_in: 7200, token_type: "bearer" } : { data: { id: "x-over-1", username: "over", name: "Over" } },
    );
    const res = await call(bob, "/oauth/x/callback?state=state-over&code=c");
    expect(res.status).toBe(302);
    const q = new URL(res.headers.get("location")!, ORIGIN).searchParams;
    expect(q.get("planLimit")).toBe("accounts");
    expect(q.get("error")).toMatch(/connected accounts/);
    expect(await one("SELECT id FROM accounts WHERE external_id = 'x-over-1'")).toBeNull();
  });

  it("posts per month: drafts are free, scheduled posts count in their month", async () => {
    const c = { ...bob, ws: trialWs };
    const acc = await trialAccount();
    expect((await draft(c, [acc, acc, acc])).status).toBe(201);
    expect((await usage(trialWs)).postsThisMonth).toBe(0);
    const two = await schedule(c, [acc, acc], soon());
    expect(two.status, two.text).toBe(201);
    const over = await schedule(c, [acc], soon());
    expect(over.status).toBe(402);
    expect(over.json).toMatchObject({ limit: "posts_per_month", used: 2, max: 2 });
    expect(over.json.error).toMatch(/Pro allows 2 posts this month/);
    expect((await schedule(c, [acc], "now")).status).toBe(402); // publish now
    // Next month has its own quota, and says which month is full.
    expect((await schedule(c, [acc, acc], nextMonth())).status).toBe(201);
    const nextOver = await schedule(c, [acc], nextMonth());
    expect(nextOver.status).toBe(402);
    expect(nextOver.json).toMatchObject({ limit: "posts_per_month", used: 2, max: 2 });
    expect(nextOver.json.error).toContain(`Pro allows 2 posts in ${monthName(nextMonth())}`);
    expect((await usage(trialWs)).postsThisMonth).toBe(2);
  });

  it("posts per month: rescheduling, deleting, cancelling and retrying", async () => {
    const c = { ...bob, ws: trialWs };
    const [a, b] = await postsIn(trialWs, "scheduled", soon());
    const [n1] = await postsIn(trialWs, "scheduled", nextMonth());
    const [d1, d2] = await postsIn(trialWs, "draft");
    // Moving within the month keeps its slot; into a full month or scheduling a draft needs one.
    expect((await patch(c, a, { scheduledAt: soon() + 1000 })).status).toBe(200);
    expect((await patch(c, a, { content: "edited, still scheduled" })).status).toBe(200);
    expect((await patch(c, a, { scheduledAt: nextMonth() })).json).toMatchObject({ limit: "posts_per_month", used: 2 });
    expect((await patch(c, d1, { scheduledAt: soon() })).status).toBe(402);
    // Deleting a scheduled post frees its slot.
    expect((await call(c, `/api/posts/${b}`, { method: "DELETE" })).status).toBe(200);
    expect((await usage(trialWs)).postsThisMonth).toBe(1);
    expect((await patch(c, d1, { scheduledAt: soon() })).status).toBe(200);
    expect((await patch(c, d2, { scheduledAt: soon() })).status).toBe(402);
    // Turning a scheduled post back into a draft frees it too; next month's slot moves with a reschedule.
    expect((await patch(c, n1, { scheduledAt: null })).status).toBe(200);
    expect((await patch(c, a, { scheduledAt: nextMonth() })).status).toBe(200);
    expect((await usage(trialWs)).postsThisMonth).toBe(1);
    expect((await patch(c, d2, { scheduledAt: soon() })).status).toBe(200);
    // Cancelling frees the slot; retrying a cancelled or failed post takes one again.
    expect((await call(c, `/api/posts/${d2}/cancel`, { method: "POST" })).status).toBe(200);
    expect((await usage(trialWs)).postsThisMonth).toBe(1);
    expect((await call(c, `/api/posts/${n1}`, { method: "PATCH", body: { scheduledAt: soon() } })).status).toBe(200);
    const retry = await call(c, `/api/posts/${d2}/retry`, { method: "POST" });
    expect(retry.status).toBe(402);
    expect(retry.json).toMatchObject({ limit: "posts_per_month", used: 2, max: 2 });
  });

  it("posts per month: a published post counts after it is deleted; failed posts don't count", async () => {
    const c = { ...bob, ws: trialWs };
    const [p1, p2] = await postsIn(trialWs, "scheduled");
    await finish(p1, "published");
    expect((await call(c, `/api/posts/${p1}`, { method: "DELETE" })).status).toBe(200);
    expect(await one("SELECT id FROM posts WHERE id = ?", p1)).toBeNull();
    expect((await usage(trialWs)).postsThisMonth).toBe(2);
    const [d] = await postsIn(trialWs, "draft");
    expect((await patch(c, d, { scheduledAt: soon() })).status).toBe(402);
    // A failed attempt frees the slot (and deleting the failed post changes nothing).
    await finish(p2, "failed");
    expect((await usage(trialWs)).postsThisMonth).toBe(1);
    expect((await patch(c, d, { scheduledAt: soon() })).status).toBe(200);
    expect((await call(c, `/api/posts/${p2}/retry`, { method: "POST" })).json).toMatchObject({ limit: "posts_per_month", used: 2 });
    // needs_check (maybe published) keeps counting, also once deleted; re-publishing it is not counted twice.
    await finish(d, "needs_check");
    expect((await usage(trialWs)).postsThisMonth).toBe(2);
    await run("UPDATE posts SET status = 'scheduled', revision = revision + 1 WHERE id = ?", d);
    expect((await usage(trialWs)).postsThisMonth).toBe(2);
  });

  it("checks every month of a batch", async () => {
    const snapshot = await loadSnapshot(E.DB, trialWs);
    const check = (adds: LimitAdds) => enforceWorkspace(E.DB, trialWs, snapshot, adds, ORIGIN);
    // This month and next month are full (2 of 2), the month after is empty.
    const later = inMonths(2);
    await expect(check({ posts_per_month: [{ at: soon(), n: 0 }, { at: later, n: 2 }] })).resolves.toBeUndefined();
    await expect(check({ posts_per_month: [{ at: later, n: 1 }, { at: soon(), n: 1 }] })).rejects.toMatchObject({ body: { limit: "posts_per_month", used: 2 } });
    await expect(check({ posts_per_month: [{ at: later, n: 1 }, { at: nextMonth(), n: 1 }] })).rejects.toMatchObject({ body: { used: 2 } });
    await expect(check({ posts_per_month: [{ at: later, n: 2 }, { at: later + 1000, n: 1 }] })).rejects.toMatchObject({ body: { used: 0 } });
  });

  it("X posts per month (same rules, X accounts only)", async () => {
    // Free plan: 30 posts, 0 X posts.
    const f = { ...bob, ws: freeWs };
    const x = await insertAccount(freeWs, "x");
    expect((await draft(f, [x])).status).toBe(201);
    const xRes = await schedule(f, [x], soon());
    expect(xRes.status).toBe(402);
    expect(xRes.json).toMatchObject({ limit: "x_posts_per_month", used: 0, max: 0 });
    const hook = await connectWebhook(f, "https://hooks.example.com/free1");
    expect((await schedule(f, [hook.json.ids[0]], soon())).status).toBe(201);
    // A published X post counts after it is deleted (and after its account is gone).
    const [p] = await postsIn(freeWs, "scheduled");
    await run("UPDATE posts SET account_id = ? WHERE id = ?", x, p);
    await finish(p, "published");
    expect((await call(f, `/api/posts/${p}`, { method: "DELETE" })).status).toBe(200);
    await run("DELETE FROM posts WHERE account_id = ?", x);
    await run("DELETE FROM accounts WHERE id = ?", x);
    expect((await usage(freeWs))).toMatchObject({ postsThisMonth: 1, xPostsThisMonth: 1 });
  });

  it("members (members + pending invitations)", async () => {
    const res = await call(bob, "/api/invitations", { body: { workspaceId: trialWs, workspaceRoleId: "role_ws_viewer" } });
    expect(res.status).toBe(402);
    expect(res.json).toMatchObject({ limit: "members", used: 1, max: 1 });
  });

  it("storage", async () => {
    const c = { ...bob, ws: trialWs };
    const small = await call(c, "/api/media", { raw: new Uint8Array(1000), headers: { "content-type": "image/png", "x-filename": "a.png", "content-length": "1000" } });
    expect(small.status, small.text).toBe(200);
    const big = await call(c, "/api/media", { raw: new Uint8Array(1024 * 1024), headers: { "content-type": "image/png", "x-filename": "b.png", "content-length": String(1024 * 1024) } });
    expect(big.status).toBe(402);
    expect(big.json.limit).toBe("storage_mb");
    const multi = await call(c, "/api/media/multipart", { body: { filename: "v.mp4", mime: "video/mp4", size: 5 * 1024 * 1024 } });
    expect(multi.status).toBe(402);
  });

  it("api: no API keys, and existing keys answer 402", async () => {
    const res = await call({ ...bob, ws: trialWs }, "/api/keys", { method: "POST", body: { name: "cli" } });
    expect(res.status).toBe(402);
    expect(res.json).toMatchObject({ limit: "api", max: false });
    // A key made before the plan changed.
    const key = (await call(bob, "/api/keys", { method: "POST", body: { name: "old" } })).json; // bobWs is exempt
    await run("UPDATE api_keys SET workspace_id = ? WHERE id = ?", trialWs, key.id);
    const viaKey = await call({ key: key.token }, "/api/posts");
    expect(viaKey.status).toBe(402);
    expect(viaKey.json.code).toBe("plan_limit");
    await run("UPDATE api_keys SET workspace_id = ? WHERE id = ?", bobWs, key.id);
    expect((await call({ key: key.token }, "/api/posts")).status).toBe(200);
  });

  it("shows usage next to the limits", async () => {
    const b = (await billing(bob, trialWs)).json;
    expect(b.usage).toEqual({ accounts: 1, postsThisMonth: 2, xPostsThisMonth: 0, members: 1, storageMb: 0 });
  });

  it("trial expiry falls back to the free plan, then to locked (read-only) without one", async () => {
    const c = { ...bob, ws: trialWs };
    await run("UPDATE workspaces SET trial_ends_at = ? WHERE id = ?", Date.now() - 1000, trialWs);
    expect((await billing(bob, trialWs)).json).toMatchObject({ state: "free", status: "trialing", plan: { id: freeId } });
    await call(ada, `/api/admin/billing/plans/${freeId}`, { method: "PATCH", body: { active: false } });
    expect((await billing(bob, trialWs)).json).toMatchObject({ state: "locked", plan: null });
    const acc = (await one<{ id: string }>("SELECT id FROM accounts WHERE workspace_id = ? AND provider = 'webhook'", trialWs))!.id;
    const locked = await draft(c, [acc]);
    expect(locked.status).toBe(402);
    expect(locked.json).toMatchObject({ code: "plan_limit", limit: "locked" });
    expect(locked.json.error).toMatch(/no active plan/);
    const post = (await one<{ id: string }>("SELECT id FROM posts WHERE workspace_id = ? AND status IN ('draft', 'failed') LIMIT 1", trialWs))!.id;
    expect((await call(c, `/api/posts/${post}`, { method: "PATCH", body: { scheduledAt: Date.now() + 3600_000 } })).status).toBe(402);
    expect((await call(c, `/api/posts/${post}`, { method: "PATCH", body: { content: "still editable as a draft" } })).status).toBe(200);
    expect((await call(c, "/api/upload-links", { body: {} })).status).toBe(402);
    expect((await call(c, "/api/posts")).status).toBe(200);
    expect((await call(c, "/api/accounts")).status).toBe(200);
    // Already scheduled posts fail at publish time (the workflow's sandbox check reads it in the same query).
    expect(await publishGate(E.DB, post)).toEqual({ demo: false, locked: true });
    expect((await call(c, `/api/posts/${post}`, { method: "DELETE" })).status).toBe(200);
    await call(ada, `/api/admin/billing/plans/${freeId}`, { method: "PATCH", body: { active: true } });
    expect(await publishGate(E.DB, (await one<{ id: string }>("SELECT id FROM posts WHERE workspace_id = ? LIMIT 1", trialWs))!.id)).toEqual({ demo: false, locked: false });
  });
});

describe("instance admin overrides", () => {
  it("comps a workspace and assigns a plan by hand (provider manual)", async () => {
    const comp = await call(ada, `/api/admin/workspaces/${trialWs}/billing`, { method: "PATCH", body: { exempt: true } });
    expect(comp.status, comp.text).toBe(200);
    expect(comp.json).toMatchObject({ workspaceId: trialWs, exempt: true, state: "unlimited" });
    expect((await call({ ...bob, ws: trialWs }, "/api/keys", { method: "POST", body: { name: "now ok" } })).status).toBe(201);
    const manual = await call(ada, `/api/admin/workspaces/${trialWs}/billing`, { method: "PATCH", body: { exempt: false, planId: proId } });
    expect(manual.json).toMatchObject({ exempt: false, state: "plan", status: "active", provider: "manual", planId: proId, planName: "Pro" });
    expect((await call(ada, `/api/admin/workspaces/${trialWs}/billing`, { method: "PATCH", body: { planId: "pln_nope" } })).status).toBe(404);
    expect((await call(ada, `/api/admin/workspaces/${trialWs}/billing`, { method: "PATCH", body: { status: "bogus" } })).status).toBe(400);
    expect((await call(ada, "/api/admin/workspaces/ws_nope/billing")).status).toBe(404);
    const list = (await call(ada, "/api/admin/billing/workspaces?status=active")).json;
    expect(list.map((w: any) => w.workspaceId)).toEqual([trialWs]);
    // Archive instead of delete while a workspace is on the plan (another paid plan keeps billing on: archiving the last
    // one would turn billing off, see recomputeBillingOn).
    expect((await call(ada, "/api/admin/billing/plans", { body: { name: "Team", priceYear: 49000, position: 5 } })).status).toBe(201);
    expect((await call(ada, `/api/admin/billing/plans/${proId}`, { method: "DELETE" })).json).toEqual({ ok: true, archived: true });
    expect((await billing(bob, trialWs)).json).toMatchObject({ state: "plan", plan: { id: proId } });
    await call(ada, `/api/admin/billing/plans/${proId}`, { method: "PATCH", body: { active: true, isTrialDefault: true } });
  });
});

describe("permissions", () => {
  it("members without billing.manage see the plan but cannot buy; other workspaces are 404", async () => {
    const b = await billing(eve);
    expect(b.status).toBe(200);
    expect(b.json.canManage).toBe(false);
    expect((await call(eve, "/api/billing/checkout", { body: { planId: proId, interval: "month" } })).status).toBe(403);
    expect((await call(eve, "/api/billing/portal", { method: "POST" })).status).toBe(403);
    expect((await billing(bob, adaWs)).status).toBe(404);
    expect((await call({ ...bob, ws: adaWs }, "/api/billing/checkout", { body: { planId: proId, interval: "month" } })).status).toBe(404);
  });
});

describe("checkout and portal", () => {
  it("Polar checkout: products, metadata, return URLs", async () => {
    const calls = mockFetch(() => ({ url: "https://sandbox.polar.sh/checkout/c1" }));
    const c = { ...bob, ws: freeWs };
    const res = await call(c, "/api/billing/checkout", { body: { planId: proId, interval: "month" } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ url: "https://sandbox.polar.sh/checkout/c1" });
    expect(calls[0].url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      products: ["prod_m"],
      success_url: `${ORIGIN}/workspace?tab=billing&checkout=success`,
      return_url: `${ORIGIN}/workspace?tab=billing&checkout=canceled`,
      customer_email: "bob@example.com",
      metadata: { workspace_id: freeWs, plan_id: proId, interval: "month" },
    });
    expect((await call(c, "/api/billing/checkout", { body: { planId: proId, interval: "year" } })).status).toBe(400);
    expect((await call(c, "/api/billing/checkout", { body: { planId: freeId, interval: "month" } })).status).toBe(400);
    expect((await call(c, "/api/billing/checkout", { body: { planId: "pln_nope", interval: "month" } })).status).toBe(404);
    expect((await call(bob, "/api/billing/checkout", { body: { planId: proId, interval: "month" } })).status).toBe(409); // exempt
  });

  it("Stripe checkout: form-encoded subscription session", async () => {
    await call(ada, "/api/admin/billing/providers/stripe", { method: "PUT", body: { values: { secretKey: "sk_test_1", webhookSecret: "whsec_s" } } });
    await call(ada, "/api/admin/billing", { method: "PATCH", body: { activeProvider: "stripe" } });
    const calls = mockFetch(() => ({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    const res = await call({ ...bob, ws: freeWs }, "/api/billing/checkout", { body: { planId: proId, interval: "month" } });
    expect(res.json).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer sk_test_1");
    expect(h["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(form)).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_m",
      "line_items[0][quantity]": "1",
      client_reference_id: freeWs,
      "metadata[workspace_id]": freeWs,
      "subscription_data[metadata][workspace_id]": freeWs,
      customer_email: "bob@example.com",
      success_url: `${ORIGIN}/workspace?tab=billing&checkout=success`,
    });
  });

  it("Lemon Squeezy checkout: JSON:API with custom data", async () => {
    await call(ada, "/api/admin/billing/providers/lemonsqueezy", { method: "PUT", body: { values: { apiKey: "ls_key", storeId: "77", webhookSecret: "lssecret" } } });
    const state = await call(ada, "/api/admin/billing", { method: "PATCH", body: { activeProvider: "lemonsqueezy" } });
    expect(state.json.providers[2].fields.find((f: any) => f.key === "storeId")).toMatchObject({ set: true, value: "77" });
    const calls = mockFetch(() => ({ data: { attributes: { url: "https://acme.lemonsqueezy.com/checkout/custom/1" } } }));
    const res = await call({ ...bob, ws: freeWs }, "/api/billing/checkout", { body: { planId: proId, interval: "month" } });
    expect(res.json).toEqual({ url: "https://acme.lemonsqueezy.com/checkout/custom/1" });
    expect(calls[0].url).toBe("https://api.lemonsqueezy.com/v1/checkouts");
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/vnd.api+json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: { email: "bob@example.com", custom: { workspace_id: freeWs, plan_id: proId, interval: "month" } },
          product_options: { redirect_url: `${ORIGIN}/workspace?tab=billing&checkout=success` },
        },
        relationships: { store: { data: { type: "stores", id: "77" } }, variant: { data: { type: "variants", id: "123" } } },
      },
    });
  });

  it("portal per provider; a running subscription refuses a second checkout", async () => {
    const c = { ...bob, ws: freeWs };
    expect((await call(c, "/api/billing/portal", { method: "POST" })).status).toBe(409);
    await run("UPDATE workspaces SET billing_provider = 'stripe', billing_customer_id = 'cus_1', billing_subscription_id = 'sub_1', billing_status = 'active', plan_id = ? WHERE id = ?", proId, freeWs);
    expect((await call(c, "/api/billing/checkout", { body: { planId: proId, interval: "month" } })).status).toBe(409);
    let calls = mockFetch(() => ({ url: "https://billing.stripe.com/p/session/1" }));
    expect((await call(c, "/api/billing/portal", { method: "POST" })).json).toEqual({ url: "https://billing.stripe.com/p/session/1" });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({ customer: "cus_1", return_url: `${ORIGIN}/workspace?tab=billing` });
    vi.restoreAllMocks();

    await run("UPDATE workspaces SET billing_provider = 'polar', billing_customer_id = 'cust-uuid' WHERE id = ?", freeWs);
    calls = mockFetch(() => ({ customer_portal_url: "https://polar.sh/acme/portal?token=t" }));
    expect((await call(c, "/api/billing/portal", { method: "POST" })).json).toEqual({ url: "https://polar.sh/acme/portal?token=t" });
    expect(calls[0].url).toBe("https://sandbox-api.polar.sh/v1/customer-sessions/");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ customer_id: "cust-uuid", return_url: `${ORIGIN}/workspace?tab=billing` });
    vi.restoreAllMocks();

    await run("UPDATE workspaces SET billing_provider = 'lemonsqueezy', billing_customer_id = '9', billing_subscription_id = '42' WHERE id = ?", freeWs);
    calls = mockFetch(() => ({ data: { attributes: { urls: { customer_portal: "https://acme.lemonsqueezy.com/billing?expires=1" } } } }));
    expect((await call(c, "/api/billing/portal", { method: "POST" })).json).toEqual({ url: "https://acme.lemonsqueezy.com/billing?expires=1" });
    expect(calls[0].url).toBe("https://api.lemonsqueezy.com/v1/subscriptions/42");
    expect(calls[0].init.method).toBe("GET");
  });

  it("provider errors answer 502 with the provider's message", async () => {
    await run("UPDATE workspaces SET billing_subscription_id = NULL, billing_status = 'none' WHERE id = ?", freeWs);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ errors: [{ detail: "The variant is not published." }] }), { status: 422 }));
    const res = await call({ ...bob, ws: freeWs }, "/api/billing/checkout", { body: { planId: proId, interval: "month" } });
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/The variant is not published/);
  });

  it("refuses to delete the provider that sells while billing is on", async () => {
    expect((await call(ada, "/api/admin/billing/providers/lemonsqueezy", { method: "DELETE" })).status).toBe(409);
  });
});

describe("admin overview", () => {
  it("counts paying, trialing and exempt workspaces and estimates MRR", async () => {
    await run("UPDATE workspaces SET billing_provider = 'stripe', billing_status = 'active', billing_interval = 'month', plan_id = ? WHERE id = ?", proId, freeWs);
    const o = (await call(ada, "/api/admin/overview")).json;
    expect(o.billing).toMatchObject({ enabled: true, paying: 1, manual: 1, trialing: 0, pastDue: 0, mrrCents: 1900, currency: "USD" });
    expect(o.billing.exempt).toBeGreaterThanOrEqual(2);
    expect(o.counts.users.pending).toBe(0);
  });

  it("turning billing off removes every limit at once", async () => {
    await call(ada, "/api/admin/billing", { method: "PATCH", body: { enabled: false } });
    expect((await billing(bob, trialWs)).json).toMatchObject({ enabled: false, state: "unlimited", limits: null });
    expect((await call({ ...bob, ws: trialWs }, "/api/invitations", { body: { workspaceId: trialWs, workspaceRoleId: "role_ws_viewer" } })).status).toBe(201);
  });
});
