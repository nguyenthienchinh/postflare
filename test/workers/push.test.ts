import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptJson, hashPassword } from "../../worker/lib/crypto";
import { resetApnsJwt } from "../../worker/lib/push";
import { ProviderError } from "../../worker/providers/errors";
import { getProvider } from "../../worker/providers/registry";
import type { Provider } from "../../worker/providers/types";
import { PublishWorkflow } from "../../worker/workflow";
import { apnsKey, apnsToken, makeCall, verifyJwt } from "./app-helpers";
import { countingD1 } from "./d1-counter";

// Push notifications of publish results to the iOS app (worker/lib/push.ts, worker/workflow.ts): who gets them
// (members who can see posts, preferences, workspace filter, never the demo), the APNs request (hosts per
// environment, headers, ES256 provider token, payload with loc keys), dead token cleanup, the device cap and the D1
// budget of a publish. Own D1 (PUSH_DB); api.push.apple.com is mocked through globalThis.fetch.

const key = await apnsKey();
const { db: DB, count } = countingD1(env.PUSH_DB);
const APNS = { APNS_PRIVATE_KEY: key.pem, APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "app.ferdi.postflare" };
const E = { ...env, DB, DEMO_MODE: "false", ...APNS } as unknown as Env;
/** Same instance with push not configured. */
const OFF = { ...env, DB, DEMO_MODE: "false" } as unknown as Env;
const call = makeCall(E);
const PW = "password123";
const run = (sql: string, ...binds: unknown[]) => DB.prepare(sql).bind(...binds).run();

interface ApnsCall {
  host: string;
  token: string;
  headers: Record<string, string>;
  body: any;
}
let apns: ApnsCall[] = [];
const dead = new Set<string>();

function mockFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith("push.apple.com")) {
      const token = url.pathname.split("/").pop()!;
      apns.push({ host: url.hostname, token, headers: Object.fromEntries(req.headers), body: await req.json() });
      if (dead.has(token)) return Response.json({ reason: "Unregistered" }, { status: 410 });
      return new Response(null, { status: 200, headers: { "apns-id": crypto.randomUUID() } });
    }
    return Response.json({ id: "ext_1", url: "https://example.com/p/1" });
  });
}

const hook = getProvider("webhook") as Provider;

async function runWorkflow(postId: string, e: Env = E) {
  const names: string[] = [];
  const step = {
    do: async (name: string, a: any, b?: any) => {
      names.push(name);
      return (typeof a === "function" ? a : b)();
    },
    sleep: async (name: string) => void names.push(`sleep:${name}`),
    sleepUntil: async () => {},
  };
  const w = Object.create(PublishWorkflow.prototype) as PublishWorkflow;
  (w as any).env = e;
  const result = await w.run({ payload: { postId, revision: 0 }, timestamp: new Date(), instanceId: `${postId}-0` } as any, step as any);
  return { result, names };
}

async function post(id: string, ws: string, accountId: string, content = "Hello from the launch thread, with a long enough text to be cut somewhere in the notification body for sure.") {
  const t = Date.now();
  await run(
    `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, settings, thread, attempts, revision, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, 'scheduled', ?, ?, '[]', '{}', '[]', 0, 0, ?, ?, ?)`,
    id,
    `grp_${id}`,
    accountId,
    t - 1000,
    content,
    t,
    t,
    ws,
  );
}

async function account(id: string, ws: string, name: string) {
  const t = Date.now();
  await run(
    `INSERT INTO accounts (id, provider, external_id, name, username, credentials_enc, meta, status, created_at, updated_at, workspace_id)
     VALUES (?, 'webhook', ?, ?, NULL, ?, '{}', 'active', ?, ?, ?)`,
    id,
    `ext_${id}`,
    name,
    await encryptJson(E, { url: "https://hook.example.com/x" }),
    t,
    t,
    ws,
  );
}

let ipN = 0;
/** Signs a user in on a new device and registers its push token. */
async function device(email: string, token: string, opts: { environment?: string; prefs?: unknown } = {}) {
  const login = await call(null, "/api/auth/device", { body: { email, password: PW, deviceName: token.slice(0, 6) }, headers: { "cf-connecting-ip": `10.70.${++ipN}.1` } });
  expect(login.status, login.text).toBe(200);
  const reg = await call({ token: login.json.token }, "/api/devices/me", { method: "PUT", body: { apnsToken: token, environment: opts.environment ?? "production", prefs: opts.prefs } });
  expect(reg.status, reg.text).toBe(200);
  return login.json.deviceId as string;
}

const T = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, apnsToken(n)])) as Record<number, string>;

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Ada", email: "ada@example.com", password: PW, workspaceName: "A" } });
  expect(setup.status, setup.text).toBe(200);
  const t = Date.now();
  const hash = await hashPassword(PW);
  const user = (id: string, email: string) =>
    DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'role_instance_member', 'active', ?, ?)").bind(id, email, id, hash, t, t);
  await DB.batch([
    user("usr_v", "v@example.com"),
    user("usr_n", "n@example.com"),
    user("usr_b", "b@example.com"),
    user("usr_c", "c@example.com"),
    DB.prepare("INSERT INTO roles (id, scope, name, permissions, builtin, created_at) VALUES ('role_ws_noposts', 'workspace', 'Accounts only', '[\"accounts.read\"]', 0, 0)"),
    DB.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws_a', 'A2', ?, ?), ('ws_b', 'B', ?, ?), ('ws_c', 'C', ?, ?)").bind(t, t, t, t, t, t),
    DB.prepare("INSERT INTO workspaces (id, name, created_at, updated_at, is_demo) VALUES ('ws_demo', 'Demo', ?, ?, 1)").bind(t, t),
    DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES ('ws_a', (SELECT id FROM users WHERE email = 'ada@example.com'), 'role_ws_owner', ?), ('ws_a', 'usr_v', 'role_ws_viewer', ?), ('ws_a', 'usr_n', 'role_ws_noposts', ?),
       ('ws_b', 'usr_b', 'role_ws_owner', ?), ('ws_c', 'usr_c', 'role_ws_owner', ?), ('ws_demo', (SELECT id FROM users WHERE email = 'ada@example.com'), 'role_ws_owner', ?)`,
    ).bind(t, t, t, t, t, t),
  ]);
  await account("acc_a", "ws_a", "Tempo App");
  await account("acc_c", "ws_c", "C account");
  await account("acc_demo", "ws_demo", "Demo account");
  await device("ada@example.com", T[1]);
  await device("ada@example.com", T[2], { environment: "sandbox" });
  await device("v@example.com", T[3], { prefs: { published: false } });
  await device("n@example.com", T[4]);
  await device("b@example.com", T[5]);
  // Only wants ws_b: nothing from ws_a.
  await device("ada@example.com", T[6], { prefs: { workspaces: ["ws_b"] } });
});

beforeEach(() => {
  apns = [];
  dead.clear();
  resetApnsJwt();
  mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publish result notifications", () => {
  it("published: members who can see posts and want it; APNs host per environment; headers, JWT and payload", async () => {
    await post("p_pub", "ws_a", "acc_a");
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "x1" });
    const { result, names } = await runWorkflow("p_pub");
    expect(result).toMatchObject({ published: true });
    expect(names).toContain("notify");
    expect(apns.map((a) => a.token).sort()).toEqual([T[1], T[2]].sort());
    expect(apns.find((a) => a.token === T[1])!.host).toBe("api.push.apple.com");
    expect(apns.find((a) => a.token === T[2])!.host).toBe("api.sandbox.push.apple.com");
    const a = apns[0];
    expect(a.headers["apns-topic"]).toBe("app.ferdi.postflare");
    expect(a.headers["apns-push-type"]).toBe("alert");
    expect(a.headers["apns-priority"]).toBe("10");
    expect(a.headers["apns-collapse-id"]).toBe("p_pub:published");
    const [scheme, jwt] = a.headers.authorization.split(" ");
    expect(scheme).toBe("bearer");
    expect(jwt.split(".")).toHaveLength(3);
    const decoded = await verifyJwt(jwt, key.publicKey);
    expect(decoded.valid).toBe(true);
    expect(decoded.header).toEqual({ alg: "ES256", typ: "JWT", kid: "KEY1234567" });
    expect(decoded.payload.iss).toBe("TEAM123456");
    expect(Math.abs(decoded.payload.iat - Date.now() / 1000)).toBeLessThan(60);
    expect(a.body).toEqual({
      aps: {
        alert: {
          title: "Tempo App · Webhook",
          body: expect.stringMatching(/^Published: Hello from the launch thread.*…$/),
          "title-loc-key": "PUSH_POST_TITLE",
          "title-loc-args": ["Tempo App", "Webhook"],
          "loc-key": "PUSH_POST_PUBLISHED_BODY",
          "loc-args": [expect.any(String)],
        },
        sound: "default",
        "thread-id": "ws_a",
        "interruption-level": "active",
      },
      type: "post_published",
      postId: "p_pub",
      workspaceId: "ws_a",
    });
    expect(a.body.aps.alert["loc-args"][0].length).toBeLessThanOrEqual(100);
    // The provider token is reused (Apple throttles new ones).
    expect(new Set(apns.map((x) => x.headers.authorization)).size).toBe(1);
    const row = await DB.prepare("SELECT last_push_at FROM devices WHERE apns_token = ?").bind(T[1]).first<{ last_push_at: number }>();
    expect(row!.last_push_at).toBeGreaterThan(Date.now() - 10_000);
  });

  it("failed and needs_check: the error / the text; viewers with published off still get failures", async () => {
    await post("p_fail", "ws_a", "acc_a");
    vi.spyOn(hook, "publish").mockRejectedValue(new ProviderError("Text too long for this platform", "invalid"));
    expect((await runWorkflow("p_fail")).result).toEqual({ failed: true });
    expect(apns.map((a) => a.token).sort()).toEqual([T[1], T[2], T[3]].sort());
    expect(apns[0].body).toMatchObject({ type: "post_failed", postId: "p_fail", workspaceId: "ws_a" });
    expect(apns[0].body.aps.alert).toMatchObject({ "loc-key": "PUSH_POST_FAILED_BODY", "loc-args": ["Text too long for this platform"], body: "Failed: Text too long for this platform" });

    apns = [];
    vi.restoreAllMocks();
    mockFetch();
    await post("p_check", "ws_a", "acc_a", "Short text");
    vi.spyOn(hook, "publish").mockRejectedValue(new ProviderError("socket hang up", "ambiguous"));
    expect((await runWorkflow("p_check")).result).toEqual({ needsCheck: true });
    expect(apns).toHaveLength(3);
    expect(apns[0].body).toMatchObject({ type: "post_needs_check", aps: { alert: { "loc-key": "PUSH_POST_NEEDS_CHECK_BODY", "loc-args": ["Short text"] } } });
  });

  it("410 Unregistered turns push off for that device (the device stays signed in)", async () => {
    dead.add(T[2]);
    await post("p_dead", "ws_a", "acc_a");
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "x2" });
    await runWorkflow("p_dead");
    expect(apns).toHaveLength(2);
    const row = await DB.prepare("SELECT apns_token, session_id FROM devices WHERE environment = 'sandbox'").first<{ apns_token: string | null; session_id: string }>();
    expect(row!.apns_token).toBeNull();
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").bind(row!.session_id).first("n")).toBe(1);
    // Next event: only the remaining device.
    apns = [];
    await post("p_after", "ws_a", "acc_a");
    await runWorkflow("p_after");
    expect(apns.map((a) => a.token)).toEqual([T[1]]);
  });

  it("never pushes for the demo workspace", async () => {
    await post("p_demo", "ws_demo", "acc_demo");
    const { names } = await runWorkflow("p_demo");
    expect(names).toContain("simulate publish");
    expect(apns).toHaveLength(0);
  });

  it("revoked devices and removed members get nothing", async () => {
    await run("DELETE FROM sessions WHERE id = (SELECT session_id FROM devices WHERE apns_token = ?)", T[3]);
    await post("p_rev", "ws_a", "acc_a");
    vi.spyOn(hook, "publish").mockRejectedValue(new ProviderError("nope", "invalid"));
    await runWorkflow("p_rev");
    expect(apns.map((a) => a.token)).toEqual([T[1]]);
  });

  it("caps an event at 10 devices", async () => {
    for (let i = 0; i < 12; i++) await device("c@example.com", apnsToken(100 + i));
    await post("p_many", "ws_c", "acc_c");
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "x3" });
    await runWorkflow("p_many");
    expect(apns).toHaveLength(10);
    expect(new Set(apns.map((a) => a.token)).size).toBe(10);
  });

  it("D1 budget: the targets ride in the mark batch; one bookkeeping batch when pushes were sent; nothing without APNs", async () => {
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "x4" });
    await post("p_budget_off", "ws_a", "acc_a");
    count.reset();
    const off = await runWorkflow("p_budget_off", OFF);
    // Same as test/workers/publish.test.ts (12 calls for a text post, the mark step one batch of 3).
    expect(count.calls, count.sql.join("\n")).toBe(12);
    expect(count.batchStatements).toBe(3);
    expect(off.names).not.toContain("notify");
    expect(apns).toHaveLength(0);

    await post("p_budget_on", "ws_a", "acc_a");
    count.reset();
    const on = await runWorkflow("p_budget_on");
    expect(apns).toHaveLength(1);
    expect(count.calls, count.sql.join("\n")).toBe(13);
    expect(count.batchStatements).toBe(4 + 1);
    expect(on.names.filter((n) => n === "notify")).toHaveLength(1);

    // APNs on but nobody to notify: no notify step, no extra round trip.
    await post("p_budget_none", "ws_c", "acc_c");
    await run("UPDATE devices SET apns_token = NULL WHERE user_id = 'usr_c'");
    count.reset();
    const none = await runWorkflow("p_budget_none");
    expect(count.calls, count.sql.join("\n")).toBe(12);
    expect(none.names).not.toContain("notify");
  });
});
