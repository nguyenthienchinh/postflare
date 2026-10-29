import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../worker/index";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// Payment provider webhooks (docs/hosted-spec.md "Webhook route"): payloads are signed here with each provider's
// documented scheme (Polar: Standard Webhooks, both secret formats; Stripe: Stripe-Signature; Lemon Squeezy:
// X-Signature), then checked for verification, idempotency, product → plan mapping, ordering and the status
// transitions active → past_due → canceled → expired. Own D1 (WEBHOOKS_DB).

const E = { ...env, DB: env.WEBHOOKS_DB } as unknown as Env;
const PW = "password123";
const DAY = 86_400_000;

async function call(client: Client | null, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.ws) headers["x-workspace-id"] = client.ws;
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

const enc = new TextEncoder();
async function hmac(key: Uint8Array | string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

const POLAR_SECRET = `whsec_${b64(crypto.getRandomValues(new Uint8Array(24)))}`;
const STRIPE_SECRET = "whsec_stripe_test_secret";
const LS_SECRET = "lemon-secret-123";

let polarSeq = 0;
/** A signed Polar delivery. `scheme`: Standard Webhooks key (base64 after whsec_) or Polar's older key (the whole string). */
async function polar(payload: unknown, opts: { id?: string; ts?: number; scheme?: "standard" | "legacy"; badSig?: boolean } = {}) {
  const raw = JSON.stringify(payload);
  const id = opts.id ?? `msg_${++polarSeq}`;
  const ts = String(Math.floor((opts.ts ?? Date.now()) / 1000));
  const key = opts.scheme === "legacy" ? POLAR_SECRET : fromB64(POLAR_SECRET.slice(6));
  let sig = b64(await hmac(key, `${id}.${ts}.${raw}`));
  if (opts.badSig) sig = b64(await hmac("wrong", `${id}.${ts}.${raw}`));
  return call(null, "/api/billing/webhooks/polar", { raw, headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` } });
}

async function stripe(event: unknown, opts: { ts?: number; extraSig?: string; badSig?: boolean; origin?: string } = {}) {
  const raw = JSON.stringify(event);
  const t = Math.floor((opts.ts ?? Date.now()) / 1000);
  const sig = hex(await hmac(opts.badSig ? "nope" : STRIPE_SECRET, `${t}.${raw}`));
  const header = `t=${t},${opts.extraSig ? `v1=${opts.extraSig},` : ""}v1=${sig},v0=deadbeef`;
  return call(null, "/api/billing/webhooks/stripe", { raw, headers: { "content-type": "application/json", "stripe-signature": header, ...(opts.origin ? { origin: opts.origin } : {}) } });
}

async function lemon(payload: any, opts: { badSig?: boolean } = {}) {
  const raw = JSON.stringify(payload);
  const sig = hex(await hmac(opts.badSig ? "nope" : LS_SECRET, raw));
  return call(null, "/api/billing/webhooks/lemonsqueezy", { raw, headers: { "content-type": "application/json", "x-signature": sig, "x-event-name": payload.meta.event_name } });
}

const iso = (ms: number) => new Date(ms).toISOString();
let owner: Client;
let wsP: string; // Polar
let wsS: string; // Stripe (no trial: one per user, wsP had it)
let wsL: string; // Lemon Squeezy
let proId: string;
let freeId: string;

const billing = (ws: string) => call({ ...owner, ws }, "/api/billing").then((r) => r.json);
const row = (ws: string) => E.DB.prepare("SELECT * FROM workspaces WHERE id = ?").bind(ws).first<any>();

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Wes", email: "wes@example.com", password: PW } });
  owner = { cookie: sessionCookie(setup.headers)! };
  const put = (id: string, values: Record<string, string>) => call(owner, `/api/admin/billing/providers/${id}`, { method: "PUT", body: { values } });
  expect((await put("polar", { accessToken: "tok", webhookSecret: POLAR_SECRET })).status).toBe(200);
  const free = await call(owner, "/api/admin/billing/plans", { body: { name: "Free", isFree: true, limits: { accounts: 1 } } });
  freeId = free.json.id;
  const pro = await call(owner, "/api/admin/billing/plans", {
    body: {
      name: "Pro",
      priceMonth: 1000,
      priceYear: 10000,
      isTrialDefault: true,
      providerPrices: { polar: { month: "prod_m", year: "prod_y" }, stripe: { month: "price_m", year: "price_y" }, lemonsqueezy: { month: "123", year: "124" } },
    },
  });
  proId = pro.json.id;
  const on = await call(owner, "/api/admin/billing", { method: "PATCH", body: { activeProvider: "polar", enabled: true } });
  expect(on.json.active, on.text).toBe(true);
  wsP = (await call(owner, "/api/workspaces", { body: { name: "P" } })).json.id;
  wsS = (await call(owner, "/api/workspaces", { body: { name: "S" } })).json.id;
  wsL = (await call(owner, "/api/workspaces", { body: { name: "L" } })).json.id;
});

const polarSub = (over: Record<string, unknown> = {}) => ({
  id: "sub_p1",
  status: "active",
  cancel_at_period_end: false,
  current_period_end: iso(Date.now() + 30 * DAY),
  ended_at: null,
  ends_at: null,
  recurring_interval: "month",
  customer_id: "cust_p1",
  product_id: "prod_m",
  metadata: { workspace_id: wsP },
  customer: { id: "cust_p1", external_id: null },
  modified_at: iso(Date.now()),
  ...over,
});

describe("routing", () => {
  it("404 for unknown or unconfigured providers", async () => {
    expect((await call(null, "/api/billing/webhooks/paypal", { raw: "{}" })).status).toBe(404);
    expect((await lemon({ meta: { event_name: "subscription_created" }, data: {} })).status).toBe(404);
  });
});

describe("Polar", () => {
  it("rejects bad signatures, stale timestamps and missing headers (400)", async () => {
    expect((await polar({ type: "subscription.active", data: polarSub() }, { badSig: true })).status).toBe(400);
    expect((await polar({ type: "subscription.active", data: polarSub() }, { ts: Date.now() - 10 * 60_000 })).status).toBe(400);
    expect((await call(null, "/api/billing/webhooks/polar", { raw: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await row(wsP)).billing_status).toBe("trialing");
  });

  it("subscription.active: maps the product to the plan, ends the trial; duplicates change nothing", async () => {
    const res = await polar({ type: "subscription.active", timestamp: iso(Date.now()), data: polarSub() }, { id: "msg_fixed" });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ ok: true, workspaceId: wsP });
    const b = await billing(wsP);
    expect(b).toMatchObject({ state: "plan", status: "active", provider: "polar", interval: "month", subscribedPlanId: proId, trialEndsAt: null, hasSubscription: true });
    const r = await row(wsP);
    expect(r).toMatchObject({ billing_customer_id: "cust_p1", billing_subscription_id: "sub_p1" });
    // Same webhook-id again (a provider retry): 200, nothing applied.
    await E.DB.prepare("UPDATE workspaces SET billing_interval = 'year' WHERE id = ?").bind(wsP).run();
    const dup = await polar({ type: "subscription.active", data: polarSub() }, { id: "msg_fixed" });
    expect(dup.json).toEqual({ ok: true, duplicate: true });
    expect((await row(wsP)).billing_interval).toBe("year");
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE provider = 'polar' AND event_id = 'msg_fixed'").first<{ n: number }>())!.n).toBe(1);
  });

  it("accepts secrets of Polar's older scheme (key = the whole whsec_ string)", async () => {
    const res = await polar({ type: "subscription.updated", data: polarSub({ product_id: "prod_y", recurring_interval: "year" }) }, { scheme: "legacy" });
    expect(res.status, res.text).toBe(200);
    expect((await billing(wsP)).interval).toBe("year");
  });

  it("active → past_due (grace) → canceled (until period end) → expired", async () => {
    await polar({ type: "subscription.past_due", data: polarSub({ status: "past_due", modified_at: iso(Date.now() + 1000) }) });
    let b = await billing(wsP);
    expect(b).toMatchObject({ status: "past_due", state: "plan" });
    expect(b.graceEndsAt - Date.now()).toBeGreaterThan(6.9 * DAY);
    // Grace over: the free plan applies.
    await E.DB.prepare("UPDATE workspaces SET billing_past_due_since = ? WHERE id = ?").bind(Date.now() - 8 * DAY, wsP).run();
    expect((await billing(wsP)).state).toBe("free");

    const end = Date.now() + 10 * DAY;
    await polar({ type: "subscription.canceled", data: polarSub({ status: "active", cancel_at_period_end: true, current_period_end: iso(end), modified_at: iso(Date.now() + 2000) }) });
    b = await billing(wsP);
    expect(b).toMatchObject({ status: "canceled", state: "plan", currentPeriodEnd: end, hasSubscription: true });
    expect((await row(wsP)).billing_past_due_since).toBeNull();

    await polar({ type: "subscription.uncanceled", data: polarSub({ modified_at: iso(Date.now() + 3000) }) });
    expect((await billing(wsP)).status).toBe("active");

    await polar({ type: "subscription.revoked", data: polarSub({ status: "canceled", ended_at: iso(Date.now()), modified_at: iso(Date.now() + 4000) }) });
    b = await billing(wsP);
    expect(b).toMatchObject({ status: "expired", state: "free", plan: { id: freeId }, hasSubscription: false });
  });

  it("ignores events older than the last applied change", async () => {
    const res = await polar({ type: "subscription.updated", data: polarSub({ modified_at: iso(Date.now() - 60_000) }) });
    expect(res.json).toEqual({ ok: true, stale: true, workspaceId: wsP });
    expect((await row(wsP)).billing_status).toBe("expired");
  });

  it("finds the workspace by subscription id without metadata; unknown workspaces and other events answer 200", async () => {
    const res = await polar({ type: "subscription.active", data: polarSub({ metadata: {}, modified_at: iso(Date.now() + 5000) }) });
    expect(res.json.workspaceId).toBe(wsP);
    expect((await row(wsP)).billing_status).toBe("active");
    const unknown = await polar({ type: "subscription.active", data: polarSub({ id: "sub_other", customer_id: "c_other", metadata: { workspace_id: "ws_missing" } }) });
    expect(unknown.json).toEqual({ ok: true, ignored: true, workspaceId: null });
    expect((await polar({ type: "order.created", data: { id: "o1" } })).json).toEqual({ ok: true, ignored: true });
    expect((await polar({ type: "subscription.created", data: polarSub({ status: "incomplete" }) })).json).toEqual({ ok: true, ignored: true });
  });
});

describe("Stripe", () => {
  beforeAll(async () => {
    await call(owner, "/api/admin/billing/providers/stripe", { method: "PUT", body: { values: { secretKey: "sk_test_x", webhookSecret: STRIPE_SECRET } } });
  });

  const sub = (over: Record<string, unknown> = {}) => ({
    id: "sub_s1",
    object: "subscription",
    status: "active",
    customer: "cus_s1",
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: {},
    items: { data: [{ current_period_end: Math.floor((Date.now() + 365 * DAY) / 1000), price: { id: "price_y", recurring: { interval: "year" } } }] },
    ...over,
  });
  let seq = 0;
  const ev = (type: string, object: unknown, created = Date.now()) => ({ id: `evt_${++seq}`, object: "event", type, created: Math.floor(created / 1000), data: { object } });

  it("verifies Stripe-Signature (any v1 entry), refuses wrong or old signatures", async () => {
    const e = ev("checkout.session.completed", { mode: "subscription", client_reference_id: wsS, customer: "cus_s1", subscription: "sub_s1", metadata: { workspace_id: wsS } });
    expect((await stripe(e, { badSig: true })).status).toBe(400);
    expect((await stripe(e, { ts: Date.now() - 6 * 60_000 })).status).toBe(400);
    // A browser-looking Origin does not matter: the webhook route is exempt from the same-origin check.
    const res = await stripe(e, { extraSig: "00".repeat(32), origin: "https://evil.example" });
    expect(res.status, res.text).toBe(200);
    expect(await row(wsS)).toMatchObject({ billing_provider: "stripe", billing_customer_id: "cus_s1", billing_subscription_id: "sub_s1", billing_status: "none" });
  });

  it("subscription events: items' current_period_end, yearly price, cancel at period end, deleted", async () => {
    expect((await stripe(ev("customer.subscription.created", sub()))).json.workspaceId).toBe(wsS);
    let b = await billing(wsS);
    expect(b).toMatchObject({ state: "plan", status: "active", interval: "year", subscribedPlanId: proId });
    expect(b.currentPeriodEnd).toBeGreaterThan(Date.now() + 360 * DAY);
    // API versions before 2025-03-31: current_period_end on the subscription itself.
    const legacyEnd = Math.floor((Date.now() + 20 * DAY) / 1000);
    await stripe(ev("customer.subscription.updated", sub({ cancel_at_period_end: true, current_period_end: legacyEnd, items: { data: [{ price: { id: "price_m", recurring: { interval: "month" } } }] } }), Date.now() + 1000));
    b = await billing(wsS);
    expect(b).toMatchObject({ status: "canceled", state: "plan", interval: "month", currentPeriodEnd: legacyEnd * 1000 });
    await stripe(ev("customer.subscription.updated", sub({ status: "past_due" }), Date.now() + 2000));
    expect((await billing(wsS)).status).toBe("past_due");
    await stripe(ev("customer.subscription.deleted", sub({ status: "canceled" }), Date.now() + 3000));
    expect(await billing(wsS)).toMatchObject({ status: "expired", state: "free" });
    expect((await stripe(ev("invoice.paid", { id: "in_1" }))).json).toEqual({ ok: true, ignored: true });
  });

  it("an old subscription expiring does not end a newer one", async () => {
    await stripe(ev("customer.subscription.created", sub({ id: "sub_s2", metadata: { workspace_id: wsS } }), Date.now() + 4000));
    expect(await row(wsS)).toMatchObject({ billing_subscription_id: "sub_s2", billing_status: "active" });
    const late = await stripe(ev("customer.subscription.deleted", sub({ id: "sub_s1", status: "canceled", metadata: { workspace_id: wsS } }), Date.now() + 5000));
    expect(late.json).toEqual({ ok: true, ignored: true, workspaceId: wsS });
    expect((await row(wsS)).billing_status).toBe("active");
  });
});

describe("Lemon Squeezy", () => {
  beforeAll(async () => {
    await call(owner, "/api/admin/billing/providers/lemonsqueezy", { method: "PUT", body: { values: { apiKey: "k", storeId: "1", webhookSecret: LS_SECRET } } });
  });

  const payload = (event: string, attrs: Record<string, unknown> = {}, custom: Record<string, unknown> = { workspace_id: wsL }) => ({
    meta: { event_name: event, custom_data: custom },
    data: {
      type: "subscriptions",
      id: "77",
      attributes: {
        store_id: 1,
        customer_id: 5,
        variant_id: 123,
        status: "active",
        cancelled: false,
        renews_at: iso(Date.now() + 30 * DAY),
        ends_at: null,
        updated_at: iso(Date.now()),
        ...attrs,
      },
    },
  });

  it("verifies X-Signature, maps the variant, dedupes identical deliveries", async () => {
    const p = payload("subscription_created");
    expect((await lemon(p, { badSig: true })).status).toBe(400);
    const res = await lemon(p);
    expect(res.status, res.text).toBe(200);
    expect(await billing(wsL)).toMatchObject({ state: "plan", status: "active", provider: "lemonsqueezy", interval: "month", subscribedPlanId: proId });
    expect(await row(wsL)).toMatchObject({ billing_customer_id: "5", billing_subscription_id: "77" });
    expect((await lemon(p)).json).toEqual({ ok: true, duplicate: true });
  });

  it("ignores payment events (they carry invoices); cancelled → canceled until ends_at → expired", async () => {
    const invoice = { meta: { event_name: "subscription_payment_success", custom_data: { workspace_id: wsL } }, data: { type: "subscription-invoices", id: "9", attributes: { status: "paid" } } };
    expect((await lemon(invoice)).json).toEqual({ ok: true, ignored: true });
    const end = Date.now() + 5 * DAY;
    await lemon(payload("subscription_cancelled", { status: "cancelled", cancelled: true, ends_at: iso(end), updated_at: iso(Date.now() + 1000) }));
    expect(await billing(wsL)).toMatchObject({ status: "canceled", state: "plan", currentPeriodEnd: end });
    await lemon(payload("subscription_expired", { status: "expired", cancelled: true, ends_at: iso(Date.now()), updated_at: iso(Date.now() + 2000) }));
    expect(await billing(wsL)).toMatchObject({ status: "expired", state: "free" });
  });
});

describe("retention", () => {
  it("the daily job deletes events older than 90 days", async () => {
    await E.DB.prepare("UPDATE billing_events SET created_at = ? WHERE event_id = 'msg_fixed'").bind(Date.now() - 91 * DAY).run();
    const { dailyJobs } = await import("../../worker/index");
    await dailyJobs(E);
    expect(await E.DB.prepare("SELECT 1 AS x FROM billing_events WHERE event_id = 'msg_fixed'").first()).toBeNull();
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM billing_events").first<{ n: number }>())!.n).toBeGreaterThan(5);
  });
});
