import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { cronJob, DAILY_CRON, FREQUENT_CRON, METRICS_CRON, TICK_CRON } from "../../worker/index";
import { REFRESHES_PER_TICK, refreshExpiringAccounts } from "../../worker/lib/accounts";
import { encryptJson, hashPassword } from "../../worker/lib/crypto";
import { sweepMedia } from "../../worker/lib/media-lifecycle";
import { publishDemoPosts } from "../../worker/lib/demo";
import { recoverStuckPosts } from "../../worker/lib/posts";
import { ProviderError } from "../../worker/providers/errors";
import { request, requestJson } from "../../worker/providers/http";
import { getProvider } from "../../worker/providers/registry";
import type { Provider } from "../../worker/providers/types";
import { PublishWorkflow, followUpLabel, followUpLog } from "../../worker/workflow";
import { countingD1 } from "./d1-counter";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// Publishing safety (needs_check, revision guards, publish lock), token refresh pacing, the D1 query budget per
// invocation and the media lifecycle. Own D1 instance (PUBLISH_DB); D1 calls are counted through a proxy; the
// Workflows binding is a fake that records instances (no workflow runs by itself here).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function fakeWorkflows() {
  const created: Array<{ id: string; params: { postId: string; revision: number } }> = [];
  const statuses = new Map<string, string | Error>();
  const handle = (id: string) => ({
    id,
    status: async () => {
      const s = statuses.get(id);
      if (s instanceof Error) throw s;
      return { status: s ?? "running" };
    },
    terminate: async () => {},
  });
  const binding = {
    create: async (o: { id: string; params: any }) => {
      created.push(o);
      return handle(o.id);
    },
    createBatch: async (list: Array<{ id: string; params: any }>) => {
      created.push(...list);
      return list.map((o) => handle(o.id));
    },
    get: async (id: string) => handle(id),
  };
  return { binding, created, statuses };
}

const { db: DB, count } = countingD1(env.PUBLISH_DB);
const wf = fakeWorkflows();
const E = { ...env, DB, PUBLISH_WORKFLOW: wf.binding, DEMO_MODE: "false" } as unknown as Env;

async function call(client: Client | null, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.ws) headers["x-workspace-id"] = client.ws;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
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

const one = <T>(sql: string, ...binds: unknown[]) => DB.prepare(sql).bind(...binds).first<T>();
const run = (sql: string, ...binds: unknown[]) => DB.prepare(sql).bind(...binds).run();

async function user(id: string, email: string, role = "role_instance_member") {
  const t = Date.now();
  await run(
    "INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    id,
    email,
    id,
    await hashPassword("password123"),
    role,
    t,
    t,
  );
}

async function login(email: string, ws: string, ip: string): Promise<Client> {
  const res = await call(null, "/api/auth/login", { body: { email, password: "password123" }, headers: { "cf-connecting-ip": ip } });
  expect(res.status, res.text).toBe(200);
  return { cookie: sessionCookie(res.headers)!, ws };
}

async function account(
  id: string,
  ws: string,
  provider: string,
  opts: { expiresAt?: number | null; refreshExpiresAt?: number | null; updatedAt?: number; credentials?: Record<string, unknown> } = {},
) {
  const t = opts.updatedAt ?? Date.now();
  await run(
    `INSERT INTO accounts (id, provider, external_id, name, username, credentials_enc, expires_at, refresh_expires_at, meta, status, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, '{}', 'active', ?, ?, ?)`,
    id,
    provider,
    `ext_${id}`,
    `${provider} ${id}`,
    await encryptJson(E, opts.credentials ?? { accessToken: "AT", refreshToken: "RT", url: "https://hook.example.com/x" }),
    opts.expiresAt ?? null,
    opts.refreshExpiresAt ?? null,
    t,
    t,
    ws,
  );
}

async function post(
  id: string,
  ws: string,
  accountId: string,
  opts: { status?: string; revision?: number; lock?: string | null; media?: string[]; thread?: unknown[]; updatedAt?: number; workflowId?: string | null; publishedAt?: number | null } = {},
) {
  const t = Date.now();
  await run(
    `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, settings, thread, attempts, revision, workflow_id, created_at, updated_at, published_at, workspace_id, publish_lock)
     VALUES (?, ?, ?, ?, ?, 'Hello', ?, '{}', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    `grp_${id}`,
    accountId,
    opts.status ?? "scheduled",
    t - 1000,
    JSON.stringify(opts.media ?? []),
    JSON.stringify(opts.thread ?? []),
    opts.revision ?? 0,
    opts.workflowId ?? null,
    t,
    opts.updatedAt ?? t,
    opts.publishedAt ?? null,
    ws,
    opts.lock ?? null,
  );
}

const postRow = (id: string) => one<any>("SELECT * FROM posts WHERE id = ?", id);

/** Runs the workflow with a fake step runner. `cached` = results of steps completed before (replayed by name). */
async function runWorkflow(postId: string, revision: number, cached: Record<string, unknown> = {}) {
  const names: string[] = [];
  const step = {
    do: async (name: string, a: any, b?: any) => {
      names.push(name);
      if (name in cached) return cached[name];
      return (typeof a === "function" ? a : b)();
    },
    sleep: async (name: string) => void names.push(`sleep:${name}`),
    sleepUntil: async () => {},
  };
  const w = Object.create(PublishWorkflow.prototype) as PublishWorkflow;
  (w as any).env = E;
  const result = await w.run({ payload: { postId, revision }, timestamp: new Date(), instanceId: `${postId}-${revision}` } as any, step as any);
  return { result, names };
}

/** Steps already completed by the previous code version when it was claimed (an in-flight instance). */
const CLAIMED = { load: Date.now() - 1000, claim: true, "sandbox check": false };

const hook = getProvider("webhook") as Provider;
const COMMIT_URL = "https://hook.example.com/create";
const UPLOAD_URL = "https://hook.example.com/upload";

/** globalThis.fetch: network error for `fail` URLs, 200 JSON otherwise. */
function mockNetwork(fail: (url: string, n: number) => boolean = () => false) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input as any, init).url;
    calls.push(url);
    if (fail(url, calls.filter((c) => c === url).length)) throw new TypeError("Network connection lost");
    return Response.json({ id: "ext_1", url: "https://example.com/p/1" });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

let owner: Client;
let viewer: Client;
let other: Client;

beforeAll(async () => {
  await call(null, "/api/auth/status"); // applies migrations
  const t = Date.now();
  await user("usr_pub_owner", "pub-owner@example.com", "role_instance_admin");
  await user("usr_pub_viewer", "pub-viewer@example.com");
  await user("usr_pub_other", "pub-other@example.com");
  await DB.batch([
    DB.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws_p', 'P', ?, ?), ('ws_q', 'Q', ?, ?)").bind(t, t, t, t),
    DB.prepare("INSERT INTO workspaces (id, name, created_at, updated_at, is_demo) VALUES ('ws_pdemo', 'Demo', ?, ?, 1)").bind(t, t),
    DB.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES ('ws_p', 'usr_pub_owner', 'role_ws_owner', ?), ('ws_p', 'usr_pub_viewer', 'role_ws_viewer', ?), ('ws_q', 'usr_pub_other', 'role_ws_owner', ?)",
    ).bind(t, t, t),
  ]);
  owner = await login("pub-owner@example.com", "ws_p", "10.7.0.1");
  viewer = await login("pub-viewer@example.com", "ws_p", "10.7.0.2");
  other = await login("pub-other@example.com", "ws_q", "10.7.0.3");
  await account("acc_hook", "ws_p", "webhook");
  await call(owner, "/api/settings"); // stores the public URL workflows and the cron use
});

describe("publish workflow: double-post protection", () => {
  it("an ambiguous failure of the commit request goes to needs_check and is never retried", async () => {
    await post("p_amb", "ws_p", "acc_hook");
    const calls = mockNetwork((url) => url === COMMIT_URL);
    const publish = vi.spyOn(hook, "publish").mockImplementation(async (ctx) => {
      await request(ctx, UPLOAD_URL, { method: "POST" }); // pre-commit call: fine
      await requestJson(ctx, COMMIT_URL, { method: "POST", json: {}, commit: true });
      return { status: "published", externalId: "never" };
    });
    const { result, names } = await runWorkflow("p_amb", 0);
    expect(result).toEqual({ needsCheck: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(calls.filter((u) => u === COMMIT_URL)).toHaveLength(1);
    expect(names.some((n) => n.includes("retry"))).toBe(false);
    const row = await postRow("p_amb");
    expect(row.status).toBe("needs_check");
    expect(row.error).toMatch(/We couldn't confirm whether Webhook accepted the post\. Check your profile, then mark it as published or retry\./);
    expect(row.publish_lock).toBe("r0:publish");
  });

  it("an unknown exception after the commit was accepted goes to needs_check", async () => {
    await post("p_after", "ws_p", "acc_hook");
    mockNetwork();
    const publish = vi.spyOn(hook, "publish").mockImplementation(async (ctx) => {
      await requestJson(ctx, COMMIT_URL, { method: "POST", json: {}, commit: true });
      throw new TypeError("Cannot read properties of undefined (reading 'id')");
    });
    expect((await runWorkflow("p_after", 0)).result).toEqual({ needsCheck: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await postRow("p_after")).status).toBe("needs_check");
  });

  it("pre-send failures: invalid fails at once, transient ones are retried in new steps", async () => {
    await post("p_invalid", "ws_p", "acc_hook");
    const invalid = vi.spyOn(hook, "publish").mockRejectedValue(new ProviderError("Text too long", "invalid"));
    expect((await runWorkflow("p_invalid", 0)).result).toEqual({ failed: true });
    expect(invalid).toHaveBeenCalledTimes(1);
    expect(await postRow("p_invalid")).toMatchObject({ status: "failed", error: "Text too long" });
    vi.restoreAllMocks();

    // Media upload (not the commit) fails once with a network error: safe to retry.
    await post("p_retry", "ws_p", "acc_hook");
    mockNetwork((url, n) => url === UPLOAD_URL && n === 1);
    const publish = vi.spyOn(hook, "publish").mockImplementation(async (ctx) => {
      await request(ctx, UPLOAD_URL, { method: "POST" });
      const r = await requestJson(ctx, COMMIT_URL, { method: "POST", json: {}, commit: true });
      return { status: "published", externalId: r.id, url: r.url };
    });
    const { result, names } = await runWorkflow("p_retry", 0);
    expect(result).toMatchObject({ published: true, externalId: "ext_1" });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(names).toContain("sleep:publish (backoff 1)");
    expect(names).toContain("publish (retry 1)");
    expect(await postRow("p_retry")).toMatchObject({ status: "published", external_url: "https://example.com/p/1" });
    vi.restoreAllMocks();

    // Unknown errors before any commit are retried, then the post fails.
    await post("p_bug", "ws_p", "acc_hook");
    const bug = vi.spyOn(hook, "publish").mockRejectedValue(new Error("R2 hiccup"));
    expect((await runWorkflow("p_bug", 0)).result).toEqual({ failed: true });
    expect(bug).toHaveBeenCalledTimes(4);
    expect((await postRow("p_bug")).status).toBe("failed");
  });

  it("a stale instance never calls the platform nor overwrites the post", async () => {
    // Revision 1 is publishing under another instance; instance of revision 0 resumes after its claim.
    await post("p_stale", "ws_p", "acc_hook", { status: "publishing", revision: 1, lock: "r1:free" });
    const publish = vi.spyOn(hook, "publish");
    expect((await runWorkflow("p_stale", 0, CLAIMED)).result).toEqual({ skipped: true });
    expect(publish).not.toHaveBeenCalled();
    expect(await postRow("p_stale")).toMatchObject({ status: "publishing", revision: 1, publish_lock: "r1:free" });
  });

  it("mark published is guarded: a post resolved meanwhile is not overwritten", async () => {
    await post("p_race", "ws_p", "acc_hook");
    vi.spyOn(hook, "publish").mockImplementation(async () => {
      // The user resolved it while the call was in flight (bumps the revision).
      await run("UPDATE posts SET status = 'cancelled', revision = revision + 1 WHERE id = 'p_race'");
      return { status: "published", externalId: "late" };
    });
    expect((await runWorkflow("p_race", 0)).result).toEqual({ skipped: true });
    expect(await postRow("p_race")).toMatchObject({ status: "cancelled", external_id: null });
  });

  it("a re-run of an interrupted commit step does not call the platform again", async () => {
    // The step started (lock taken) and the isolate died before its result was stored.
    await post("p_replay", "ws_p", "acc_hook", { status: "publishing", lock: "r0:publish" });
    const publish = vi.spyOn(hook, "publish");
    expect((await runWorkflow("p_replay", 0, CLAIMED)).result).toEqual({ needsCheck: true });
    expect(publish).not.toHaveBeenCalled();
    expect((await postRow("p_replay")).status).toBe("needs_check");
  });

  it("in-flight instances of the previous version: never publish twice", async () => {
    // Claimed by the old code (no lock), its publish step may have been running at deploy time.
    await post("p_legacy", "ws_p", "acc_hook", { status: "publishing", lock: null });
    const publish = vi.spyOn(hook, "publish");
    expect((await runWorkflow("p_legacy", 0, CLAIMED)).result).toEqual({ needsCheck: true });
    expect(publish).not.toHaveBeenCalled();
    expect((await postRow("p_legacy")).error).toMatch(/interrupted by an update/);

    // Its publish step completed (old result shape, a pending video): it continues with checkStatus.
    await post("p_legacy2", "ws_p", "acc_hook", { status: "publishing", lock: null });
    (hook as any).checkStatus = vi.fn(async () => ({ status: "published", externalId: "vid", url: "https://example.com/v" }));
    try {
      const { result } = await runWorkflow("p_legacy2", 0, { ...CLAIMED, publish: { status: "pending", state: { n: 1 } } });
      expect(result).toMatchObject({ published: true, externalId: "vid" });
      expect(publish).not.toHaveBeenCalled();
      expect((hook as any).checkStatus).toHaveBeenCalledTimes(1);
      expect((await postRow("p_legacy2")).status).toBe("published");
    } finally {
      delete (hook as any).checkStatus;
    }

    // Sleeping instances (scheduled, not claimed yet) publish normally.
    await post("p_sleeping", "ws_p", "acc_hook");
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "ok" });
    expect((await runWorkflow("p_sleeping", 0, { load: Date.now() - 1000 })).result).toMatchObject({ published: true });
  });

  it("an ambiguous follow-up stops the thread and keeps the root published", async () => {
    await post("p_thread", "ws_p", "acc_hook", { thread: [{ content: "one", media: [] }, { content: "two", media: [] }] });
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "root" });
    mockNetwork((url) => url === COMMIT_URL);
    const reply = vi.fn(async (ctx: any) => {
      await requestJson(ctx, COMMIT_URL, { method: "POST", json: {}, commit: true });
      return { externalId: "r" };
    });
    (hook as any).reply = reply;
    try {
      expect((await runWorkflow("p_thread", 0)).result).toMatchObject({ published: true, externalId: "root" });
    } finally {
      delete (hook as any).reply;
    }
    expect(reply).toHaveBeenCalledTimes(1);
    const row = await postRow("p_thread");
    expect(row.status).toBe("published");
    expect(row.error).toMatch(/^Follow-up 1: We couldn't confirm/);
  });
});

describe("recoverStuckPosts", () => {
  it("leaves posts alone when the instance status is unknown; dead instances → needs_check", async () => {
    const old = Date.now() - 2 * HOUR;
    await post("p_stuck_err", "ws_p", "acc_hook", { status: "publishing", updatedAt: old, workflowId: "wf_throw" });
    await post("p_stuck_run", "ws_p", "acc_hook", { status: "publishing", updatedAt: old, workflowId: "wf_running" });
    await post("p_stuck_dead", "ws_p", "acc_hook", { status: "publishing", updatedAt: old, workflowId: "wf_dead" });
    wf.statuses.set("wf_throw", new Error("internal error"));
    wf.statuses.set("wf_running", "waiting");
    wf.statuses.set("wf_dead", "errored");
    await recoverStuckPosts(E);
    expect((await postRow("p_stuck_err")).status).toBe("publishing");
    expect((await postRow("p_stuck_run")).status).toBe("publishing");
    const dead = await postRow("p_stuck_dead");
    expect(dead.status).toBe("needs_check");
    expect(dead.error).toMatch(/couldn't confirm/);
  });
});

describe("POST /api/posts/:id/resolve", () => {
  it("marks a needs_check post published, or publishes it again", async () => {
    await post("p_res1", "ws_p", "acc_hook", { status: "needs_check", revision: 3 });
    await post("p_res2", "ws_p", "acc_hook", { status: "needs_check", revision: 3 });
    await post("p_res3", "ws_p", "acc_hook", { status: "failed" });

    expect((await call(viewer, "/api/posts/p_res1/resolve", { body: { published: true } })).status).toBe(403);
    expect((await call(other, "/api/posts/p_res1/resolve", { body: { published: true } })).status).toBe(404);
    expect((await call(owner, "/api/posts/p_res3/resolve", { body: { published: true } })).status).toBe(409);
    expect((await call(owner, "/api/posts/p_res1/resolve", { body: { published: true, url: "javascript:alert(1)" } })).status).toBe(400);

    const ok = await call(owner, "/api/posts/p_res1/resolve", { body: { published: true, url: "https://example.com/live" } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ status: "published", externalUrl: "https://example.com/live", error: null });
    expect((await postRow("p_res1")).revision).toBe(4);
    expect((await call(owner, "/api/posts/p_res1/resolve", { body: { published: true } })).status).toBe(409);

    const before = wf.created.length;
    const again = await call(owner, "/api/posts/p_res2/resolve", { body: { published: false } });
    expect(again.status, again.text).toBe(200);
    expect(again.json.status).toBe("scheduled");
    expect(wf.created.slice(before)).toEqual([{ id: "p_res2-4", params: { postId: "p_res2", revision: 4 } }]);
    const logs = (await call(owner, "/api/posts/p_res2")).json.logs.map((l: any) => l.message);
    expect(logs.some((m: string) => /Retry requested/.test(m))).toBe(true);

    // The dashboard counts it.
    await post("p_res4", "ws_p", "acc_hook", { status: "needs_check" });
    const overview = (await call(owner, "/api/overview")).json;
    expect(overview.counts.needs_check).toBeGreaterThanOrEqual(1);
    expect(overview.recent.some((p: any) => p.status === "needs_check")).toBe(true);
  });
});

describe("token refresh pacing", () => {
  it("refreshes tokens about to expire (not every short-lived token on every tick), within a cap", async () => {
    const x = getProvider("x") as Provider;
    const refreshed: string[] = [];
    vi.spyOn(x as Required<Provider>, "refresh").mockImplementation(async (_ctx, acc) => {
      refreshed.push(acc.id);
      return { credentials: { ...acc.credentials, accessToken: "NEW" }, expiresAt: Date.now() + 2 * HOUR };
    });
    const t = Date.now();
    await account("acc_r_soon", "ws_q", "x", { expiresAt: t + 30 * 60 * 1000, updatedAt: t - 3 * HOUR });
    await account("acc_r_2h", "ws_q", "x", { expiresAt: t + 2 * HOUR, updatedAt: t - 3 * HOUR });
    // Long-lived token whose refresh credential runs out in 3 days.
    await account("acc_r_rt", "ws_q", "x", { expiresAt: t + 30 * DAY, refreshExpiresAt: t + 3 * DAY, updatedAt: t - DAY });
    await account("acc_r_rt_far", "ws_q", "x", { expiresAt: t + 30 * DAY, refreshExpiresAt: t + 60 * DAY, updatedAt: t - DAY });

    await refreshExpiringAccounts(E);
    expect(refreshed.sort()).toEqual(["acc_r_rt", "acc_r_soon"]);
    // Next ticks: nothing is due any more (the 2h token is not refreshed every tick).
    await refreshExpiringAccounts(E);
    await refreshExpiringAccounts(E);
    expect(refreshed).toHaveLength(2);
    expect((await one<any>("SELECT expires_at FROM accounts WHERE id = 'acc_r_soon'")).expires_at).toBeGreaterThan(t + HOUR);

    // Cap per tick; the rest is refreshed by the next tick.
    for (let i = 0; i < REFRESHES_PER_TICK + 3; i++) await account(`acc_r_cap${i}`, "ws_q", "x", { expiresAt: t + 10 * 60 * 1000, updatedAt: t - HOUR - i });
    refreshed.length = 0;
    expect(await refreshExpiringAccounts(E)).toBe(REFRESHES_PER_TICK);
    expect(refreshed).toHaveLength(REFRESHES_PER_TICK);
    await refreshExpiringAccounts(E);
    expect(refreshed).toHaveLength(REFRESHES_PER_TICK + 3);
    await run("DELETE FROM accounts WHERE id LIKE 'acc_r_%'");
  });
});

describe("D1 queries per invocation (Free plan: 50)", () => {
  it("GET /api/media with 60 items", async () => {
    const t = Date.now();
    await DB.batch(
      Array.from({ length: 60 }, (_, i) =>
        DB.prepare(
          "INSERT INTO media (id, r2_key, filename, mime, size, kind, status, created_at, workspace_id) VALUES (?, ?, 'a.png', 'image/png', 10, 'image', 'ready', ?, 'ws_q')",
        ).bind(`med_list_${i}`, `med_list_${i}/a.png`, t - i),
      ),
    );
    await call(other, "/api/media"); // warm caches (schema, keys) like any isolate after its first request
    count.reset();
    const res = await call(other, "/api/media");
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(60);
    expect(count.calls, count.sql.join("\n")).toBeLessThan(15);
    await run("DELETE FROM media WHERE id LIKE 'med_list_%'");
  });

  it("POST /api/posts to 20 accounts", async () => {
    for (let i = 0; i < 20; i++) await account(`acc_many_${i}`, "ws_p", "webhook");
    const before = wf.created.length;
    count.reset();
    const res = await call(owner, "/api/posts", {
      body: { scheduledAt: Date.now() + DAY, posts: Array.from({ length: 20 }, (_, i) => ({ accountId: `acc_many_${i}`, content: `Hi ${i}` })) },
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toHaveLength(20);
    expect(count.calls, count.sql.join("\n")).toBeLessThan(15);
    expect(count.batches).toBe(1);
    // One createBatch, every post knows its instance.
    expect(wf.created.length - before).toBe(20);
    expect(res.json.every((p: any) => p.status === "scheduled")).toBe(true);
    const ids = await DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE group_id = ? AND workflow_id = id || '-0'").bind(res.json[0].groupId).first<{ n: number }>();
    expect(ids!.n).toBe(20);
    const logs = await one<{ n: number }>("SELECT COUNT(*) AS n FROM post_logs WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)", res.json[0].groupId);
    expect(logs!.n).toBe(20);
  });

  it("one cron tick with 10 accounts", async () => {
    const yt = getProvider("youtube") as Provider;
    vi.spyOn(yt as Required<Provider>, "refresh").mockImplementation(async (_ctx, acc) => ({ credentials: { ...acc.credentials, accessToken: "NEW" }, expiresAt: Date.now() + HOUR }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input as any, init).url);
      if (url.pathname === "/youtube/v3/videos") {
        return Response.json({ items: url.searchParams.get("id")!.split(",").map((id) => ({ id, statistics: { viewCount: "1", likeCount: "1", commentCount: "0" } })) });
      }
      if (url.pathname === "/youtube/v3/channels") return Response.json({ items: [{ id: "c", statistics: { subscriberCount: "5", videoCount: "1", viewCount: "9" } }] });
      return Response.json({});
    });
    const t = Date.now();
    for (let i = 0; i < 10; i++) {
      // Every account: token about to expire, account metrics due, 3 posts due for metrics.
      await account(`acc_tick_${i}`, "ws_q", "youtube", { expiresAt: t + 20 * 60 * 1000, updatedAt: t - HOUR, credentials: { accessToken: "AT", refreshToken: "RT" } });
      for (let j = 0; j < 3; j++) {
        await post(`p_tick_${i}_${j}`, "ws_q", `acc_tick_${i}`, { status: "published", publishedAt: t - 2 * HOUR });
        await run("UPDATE posts SET external_id = ?, metrics_next_at = ? WHERE id = ?", `vid_${i}_${j}`, t - HOUR, `p_tick_${i}_${j}`);
      }
    }
    // Plus overdue scheduled and stuck posts for the safety nets.
    await post("p_tick_sched", "ws_q", "acc_tick_0", { status: "scheduled", workflowId: "wf_tick" });
    await run("UPDATE posts SET scheduled_at = ? WHERE id = 'p_tick_sched'", t - HOUR);
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: FREQUENT_CRON, scheduledTime: t }), E, ctx); // warm
    await waitOnExecutionContext(ctx);
    await run("UPDATE accounts SET expires_at = ?, metrics_next_at = NULL WHERE id LIKE 'acc_tick_%'", t + 20 * 60 * 1000);
    await run("UPDATE posts SET metrics_next_at = ? WHERE id LIKE 'p_tick_%' AND status = 'published'", t - HOUR);
    count.reset();
    const ctx2 = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: FREQUENT_CRON, scheduledTime: t }), E, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(count.calls, count.sql.join("\n")).toBeLessThan(50);
    // Also safe if Cloudflare counts every statement inside a batch toward the 50.
    expect(count.queries + count.batchStatements, count.sql.join("\n")).toBeLessThan(50);
    // Analytics runs on its own trigger with its own budget.
    count.reset();
    const ctx3 = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: METRICS_CRON, scheduledTime: t }), E, ctx3);
    await waitOnExecutionContext(ctx3);
    expect(count.calls, count.sql.join("\n")).toBeLessThan(50);
    expect(count.queries + count.batchStatements, count.sql.join("\n")).toBeLessThan(50);
    expect(count.sql.some((s) => s.includes("metrics_next_at")), "metrics collected").toBe(true);
    await run("DELETE FROM posts WHERE id LIKE 'p_tick_%'");
    await run("DELETE FROM accounts WHERE id LIKE 'acc_tick_%'");
  });

  it("the hourly metrics tick with a Revflare campaign sync (2 workspaces) stays under 50 D1 queries and 40 fetches", async () => {
    const yt = getProvider("youtube") as Provider;
    vi.spyOn(yt as Required<Provider>, "refresh").mockImplementation(async (_ctx, acc) => ({ credentials: { ...acc.credentials, accessToken: "NEW" }, expiresAt: Date.now() + HOUR }));
    const fetches: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input as any, init).url);
      fetches.push(url.toString());
      if (url.host === "revflare.example.com" && url.pathname === "/api/v1/acquisition/campaigns") {
        return Response.json({ currency: "USD", items: Array.from({ length: 300 }, (_, i) => ({ campaign: `pf-x-${String(i).padStart(10, "0")}`, appId: "a1", appleAppId: "1234567890", firstSeen: "2026-10-01", lastSeen: "2026-10-10", impressions: 1, pageViews: 1, downloads: i, redownloads: 0, purchases: 0, proceeds: 0 })) });
      }
      if (url.host === "revflare.example.com" && url.pathname === "/api/v1/acquisition") return Response.json({ currency: "USD", rows: [], lastDay: "2026-10-10" });
      if (url.pathname === "/youtube/v3/videos") {
        return Response.json({ items: url.searchParams.get("id")!.split(",").map((id) => ({ id, statistics: { viewCount: "1", likeCount: "1", commentCount: "0" } })) });
      }
      if (url.pathname === "/youtube/v3/channels") return Response.json({ items: [{ id: "c", statistics: { subscriberCount: "5", videoCount: "1", viewCount: "9" } }] });
      return Response.json({});
    });
    const t = Date.now();
    const keyEnc = await encryptJson(E, { key: "rf_test_key_0123456789" });
    for (const id of ["ws_rf_1", "ws_rf_2", "ws_rf_3"]) {
      await run(
        "INSERT INTO workspaces (id, name, created_at, updated_at, revflare_url, revflare_key_enc) VALUES (?, ?, ?, ?, 'https://revflare.example.com', ?)",
        id,
        id,
        t,
        t,
        keyEnc,
      );
    }
    for (let i = 0; i < 10; i++) {
      await account(`acc_rf_${i}`, "ws_q", "youtube", { expiresAt: t + 20 * 60 * 1000, updatedAt: t - HOUR, credentials: { accessToken: "AT", refreshToken: "RT" } });
      for (let j = 0; j < 3; j++) {
        await post(`p_rf_${i}_${j}`, "ws_q", `acc_rf_${i}`, { status: "published", publishedAt: t - 2 * HOUR });
        await run("UPDATE posts SET external_id = ?, metrics_next_at = ? WHERE id = ?", `vid_rf_${i}_${j}`, t - HOUR, `p_rf_${i}_${j}`);
      }
    }
    await run("UPDATE accounts SET metrics_next_at = NULL WHERE id LIKE 'acc_rf_%'");
    const d = new Date(t);
    d.setUTCMinutes(50, 0, 0);
    // Warm the isolate's caches (schema, encryption key) like any invocation after the first.
    const warm = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: TICK_CRON, scheduledTime: d.getTime() - 45 * 60 * 1000 }), E, warm);
    await waitOnExecutionContext(warm);
    await run("UPDATE posts SET metrics_next_at = ? WHERE id LIKE 'p_rf_%'", t - HOUR);
    await run("UPDATE accounts SET metrics_next_at = NULL WHERE id LIKE 'acc_rf_%'");
    count.reset();
    fetches.length = 0;
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: TICK_CRON, scheduledTime: d.getTime() }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(count.queries + count.batchStatements, count.sql.join("\n")).toBeLessThan(50);
    expect(fetches.length, fetches.join("\n")).toBeLessThanOrEqual(40);
    expect(fetches.filter((u) => u.includes("revflare.example.com"))).toHaveLength(4); // 2 workspaces this tick
    const synced = await one<{ n: number }>("SELECT COUNT(*) AS n FROM workspaces WHERE id LIKE 'ws_rf_%' AND revflare_status = 'ok'");
    expect(synced!.n).toBe(2);
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM campaign_stats WHERE workspace_id = 'ws_rf_1'"))!.n).toBe(300);
    expect(count.sql.some((s) => s.includes("metrics_next_at")), "metrics collected").toBe(true);
    await run("DELETE FROM posts WHERE id LIKE 'p_rf_%'");
    await run("DELETE FROM accounts WHERE id LIKE 'acc_rf_%'");
    await run("DELETE FROM campaign_stats WHERE workspace_id LIKE 'ws_rf_%'");
    await run("DELETE FROM workspaces WHERE id LIKE 'ws_rf_%'");
  });

  it("the single */5 trigger picks the job from the tick's UTC time", () => {
    const at = (h: number, m: number) => Date.UTC(2026, 9, 13, h, m);
    expect([0, 15, 30, 45].map((m) => cronJob(TICK_CRON, at(12, m)))).toEqual(["frequent", "frequent", "frequent", "frequent"]);
    expect([5, 20, 35, 50].map((m) => cronJob(TICK_CRON, at(12, m)))).toEqual(["metrics", "metrics", "metrics", "metrics"]);
    expect(cronJob(TICK_CRON, at(3, 10))).toBe("daily");
    expect([10, 25, 40, 55].map((m) => cronJob(TICK_CRON, at(12, m)))).toEqual([null, null, null, null]);
    // Older multi-trigger configs keep working.
    expect([FREQUENT_CRON, METRICS_CRON, DAILY_CRON].map((c) => cronJob(c, at(12, 1)))).toEqual(["frequent", "metrics", "daily"]);
  });

  it("the daily cron runs the cleanups and the media sweep, not the publishing jobs", async () => {
    await run("INSERT INTO oauth_states (state, provider, code_verifier, created_at) VALUES ('st_old', 'x', 'v', ?)", Date.now() - 2 * HOUR).catch(() => {});
    count.reset();
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: DAILY_CRON, scheduledTime: Date.now() }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(count.calls, count.sql.join("\n")).toBeLessThan(50);
    expect(count.sql.some((s) => s.includes("DELETE FROM sessions"))).toBe(true);
    expect(count.sql.some((s) => s.includes("status = 'publishing'"))).toBe(false);
  });
});

describe("media lifecycle", () => {
  const t = Date.now();
  async function media(id: string, ws: string, opts: { age: number; status?: string; source?: string | null; size?: number }) {
    const key = `${id}/f.png`;
    if (opts.status !== "uploading") await env.MEDIA.put(key, "x");
    let uploadId: string | null = null;
    if (opts.status === "uploading") uploadId = (await env.MEDIA.createMultipartUpload(key)).uploadId;
    await run(
      "INSERT INTO media (id, r2_key, filename, mime, size, kind, status, upload_id, created_at, workspace_id, source) VALUES (?, ?, 'f.png', 'image/png', ?, 'image', ?, ?, ?, ?, ?)",
      id,
      key,
      opts.size ?? 100,
      opts.status ?? "ready",
      uploadId,
      t - opts.age,
      ws,
      opts.source ?? null,
    );
  }
  const exists = async (id: string) => !!(await one("SELECT id FROM media WHERE id = ?", id));

  beforeAll(async () => {
    await account("acc_m_hook", "ws_p", "webhook"); // hotlinks media
    await account("acc_m_yt", "ws_p", "youtube"); // stores its own copy
    await media("med_old_unused", "ws_p", { age: 40 * DAY });
    await media("med_old_draft", "ws_p", { age: 40 * DAY });
    await media("med_old_failed", "ws_p", { age: 40 * DAY });
    await media("med_old_thread", "ws_p", { age: 40 * DAY });
    await media("med_old_hotlinked", "ws_p", { age: 40 * DAY });
    await media("med_old_published", "ws_p", { age: 40 * DAY });
    await media("med_recent", "ws_p", { age: 5 * DAY });
    await media("med_upl_stale", "ws_p", { age: 3 * DAY, status: "uploading" });
    await media("med_upl_fresh", "ws_p", { age: DAY, status: "uploading" });
    await media("med_link_unused", "ws_p", { age: 8 * DAY, source: "upload_link" });
    await media("med_link_cancelled", "ws_p", { age: 8 * DAY, source: "upload_link" });
    await media("med_link_new", "ws_p", { age: 3 * DAY, source: "upload_link" });
    await media("med_demo_old", "ws_pdemo", { age: 400 * DAY });
    await post("p_m_draft", "ws_p", "acc_m_yt", { status: "draft", media: ["med_old_draft"] });
    await post("p_m_failed", "ws_p", "acc_m_yt", { status: "failed", media: ["med_old_failed"] });
    await post("p_m_thread", "ws_p", "acc_m_yt", { status: "scheduled", thread: [{ content: "x", media: ["med_old_thread"] }] });
    await post("p_m_hot", "ws_p", "acc_m_hook", { status: "published", media: ["med_old_hotlinked"] });
    await post("p_m_pub", "ws_p", "acc_m_yt", { status: "published", media: ["med_old_published"] });
    await post("p_m_cancel", "ws_p", "acc_m_yt", { status: "cancelled", media: ["med_link_cancelled"] });
  });

  it("retention 0 keeps everything except unfinished uploads", async () => {
    await run("INSERT INTO settings (key, value) VALUES ('media_retention_days', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const stats = await sweepMedia(E);
    expect(stats).toEqual({ expired: 0, staleUploads: 1, unusedLinkMedia: 0 });
    expect(await exists("med_upl_stale")).toBe(false);
    expect(await exists("med_upl_fresh")).toBe(true);
    expect(await exists("med_old_unused")).toBe(true);
  });

  it("deletes expired media nobody needs, unused upload-link files, never the demo's", async () => {
    const res = await call(owner, "/api/settings", { method: "PUT", body: { mediaRetentionDays: 30 } });
    expect(res.status, res.text).toBe(200);
    expect((await call(owner, "/api/settings")).json.mediaRetentionDays).toBe(30);
    expect((await call(viewer, "/api/settings", { method: "PUT", body: { mediaRetentionDays: 1 } })).status).toBe(403);
    expect((await call(owner, "/api/settings", { method: "PUT", body: { mediaRetentionDays: -1 } })).status).toBe(400);

    const stats = await sweepMedia(E);
    expect(stats.expired).toBe(2);
    expect(stats.unusedLinkMedia).toBe(1);
    for (const id of ["med_old_unused", "med_old_published", "med_link_unused"]) {
      expect(await exists(id), id).toBe(false);
      expect(await env.MEDIA.head(`${id}/f.png`), id).toBeNull();
    }
    for (const id of ["med_old_draft", "med_old_failed", "med_old_thread", "med_old_hotlinked", "med_recent", "med_link_cancelled", "med_link_new", "med_demo_old", "med_upl_fresh"]) {
      expect(await exists(id), id).toBe(true);
    }
    expect(await env.MEDIA.head("med_old_draft/f.png")).not.toBeNull();
    // Nothing left to do.
    expect(await sweepMedia(E)).toEqual({ expired: 0, staleUploads: 0, unusedLinkMedia: 0 });
  });

  it("media used by a draft, scheduled or unresolved post cannot be deleted", async () => {
    const res = await call(owner, "/api/media/med_old_draft", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(res.json.postIds).toEqual(["p_m_draft"]);
    expect((await call(owner, "/api/media/med_old_thread", { method: "DELETE" })).json.postIds).toEqual(["p_m_thread"]);
    // Published posts do not block a manual delete.
    expect((await call(owner, "/api/media/med_old_hotlinked", { method: "DELETE" })).status).toBe(200);
    expect((await call(other, "/api/media/med_recent", { method: "DELETE" })).status).toBe(404);
  });

  it("reports storage usage (instance totals for instance admins only)", async () => {
    const mine = (await call(owner, "/api/media/usage")).json;
    expect(mine.workspace.count).toBeGreaterThan(0);
    expect(mine.workspace.bytes).toBe(mine.workspace.count * 100);
    expect(mine.instance.bytes).toBeGreaterThanOrEqual(mine.workspace.bytes + 100); // + the demo workspace's file
    expect(mine).toMatchObject({ freeTierBytes: 10 * 1024 ** 3, retentionDays: 30 });
    const theirs = (await call(other, "/api/media/usage")).json;
    expect(theirs.instance).toBeNull();
    expect(theirs.workspace).toEqual({ bytes: 0, count: 0 });
  });
});

describe("usage_events (metering)", () => {
  const events = async (postId: string) =>
    (await DB.prepare("SELECT * FROM usage_events WHERE post_id = ? ORDER BY id").bind(postId).all<any>()).results;

  it("records a publish success with its fields, in the mark batch (one D1 round trip fewer than before)", async () => {
    const t = Date.now();
    await run(
      "INSERT INTO media (id, r2_key, filename, mime, size, kind, status, created_at, workspace_id) VALUES ('med_ue_img', 'med_ue_img/a.png', 'a.png', 'image/png', 1234, 'image', 'ready', ?, 'ws_p')",
      t,
    );
    await env.MEDIA.put("med_ue_img/a.png", "x");
    await post("p_ue_ok", "ws_p", "acc_hook", { media: ["med_ue_img"] });
    await run("UPDATE posts SET content = 'New post: postflare.io' WHERE id = 'p_ue_ok'");
    mockNetwork();
    vi.spyOn(hook, "publish").mockImplementation(async (ctx) => {
      await request(ctx, UPLOAD_URL, { method: "POST" });
      const r = await requestJson(ctx, COMMIT_URL, { method: "POST", json: {}, commit: true });
      return { status: "published", externalId: r.id, url: r.url };
    });
    const { result, names } = await runWorkflow("p_ue_ok", 0);
    expect(result).toMatchObject({ published: true });
    const [e] = await events("p_ue_ok");
    expect(e).toMatchObject({
      workspace_id: "ws_p",
      account_id: "acc_hook",
      provider: "webhook",
      kind: "publish",
      outcome: "published",
      post_type: "image",
      has_url: 1,
      media_count: 1,
      media_bytes: 1234,
      workflow_steps: names.filter((n) => !n.startsWith("sleep:")).length,
      platform_api_calls: 2,
      images_tx: 0,
      is_demo: 0,
      message: null,
      revision: 0,
    });
    expect(e.day).toBe(new Date(e.created_at).toISOString().slice(0, 10));
    expect(e.workflow_steps).toBe(6);
    expect(await events("p_ue_ok")).toHaveLength(1);
    // D1 calls of a whole text-post publish (all steps): 13 before usage metering (mark published = UPDATE + log
    // INSERT), now 12: the mark step is one batch (UPDATE + guarded log + guarded usage event).
    vi.restoreAllMocks();
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "ok" });
    await post("p_ue_count", "ws_p", "acc_hook");
    count.reset();
    expect((await runWorkflow("p_ue_count", 0)).result).toMatchObject({ published: true });
    expect(count.calls, count.sql.join("\n")).toBe(12);
    expect(count.batches).toBe(1);
    expect(count.batchStatements).toBe(3);
    // The log of the batch is there too.
    const logs = await DB.prepare("SELECT message FROM post_logs WHERE post_id = 'p_ue_ok'").all<{ message: string }>();
    expect(logs.results.some((l) => l.message.startsWith("Published: https://example.com/p/1"))).toBe(true);

    // A replay of "mark published" (result lost) records nothing more.
    vi.restoreAllMocks();
    const replay = await runWorkflow("p_ue_ok", 0, { ...CLAIMED, publish: { ok: true, value: { status: "published", externalId: "ext_1" } } });
    expect(replay.result).toEqual({ skipped: true });
    expect(await events("p_ue_ok")).toHaveLength(1);
  });

  it("records failed and needs_check outcomes with the error, without extra round trips", async () => {
    await post("p_ue_fail", "ws_p", "acc_hook");
    vi.spyOn(hook, "publish").mockRejectedValue(new ProviderError("Text too long", "invalid"));
    count.reset();
    expect((await runWorkflow("p_ue_fail", 0)).result).toEqual({ failed: true });
    expect(count.calls, count.sql.join("\n")).toBeLessThanOrEqual(12);
    expect(await events("p_ue_fail")).toEqual([
      expect.objectContaining({ kind: "publish", outcome: "failed", post_type: "text", has_url: 0, media_count: 0, media_bytes: 0, message: "Text too long", platform_api_calls: 0 }),
    ]);
    const logs = await DB.prepare("SELECT message FROM post_logs WHERE post_id = 'p_ue_fail'").all<{ message: string }>();
    expect(logs.results.map((l) => l.message)).toContain("Publishing failed: Text too long");
    vi.restoreAllMocks();

    await post("p_ue_check", "ws_p", "acc_hook");
    mockNetwork((url) => url === COMMIT_URL);
    vi.spyOn(hook, "publish").mockImplementation(async (ctx) => {
      await requestJson(ctx, COMMIT_URL, { method: "POST", json: {}, commit: true });
      return { status: "published", externalId: "never" };
    });
    expect((await runWorkflow("p_ue_check", 0)).result).toEqual({ needsCheck: true });
    const [e] = await events("p_ue_check");
    expect(e).toMatchObject({ outcome: "needs_check", platform_api_calls: 1 });
    expect(e.message).toMatch(/couldn't confirm/);
  });

  it("records follow-ups", async () => {
    await post("p_ue_thread", "ws_p", "acc_hook", { thread: [{ content: "more at https://example.com", media: [] }] });
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "root" });
    (hook as any).reply = vi.fn(async () => ({ externalId: "r1" }));
    try {
      expect((await runWorkflow("p_ue_thread", 0)).result).toMatchObject({ published: true });
    } finally {
      delete (hook as any).reply;
    }
    const list = await events("p_ue_thread");
    expect(list.map((e) => [e.kind, e.outcome, e.has_url])).toEqual([
      ["publish", "published", 0],
      ["reply", "published", 1],
    ]);
  });

  it("logs every successful follow-up on the post, in the round trip its usage event already took", async () => {
    await post("p_fu_log", "ws_p", "acc_hook", { thread: [{ content: "one", media: [] }, { content: "two", media: [] }] });
    vi.spyOn(hook, "publish").mockResolvedValue({ status: "published", externalId: "root" });
    (hook as any).reply = vi
      .fn()
      .mockResolvedValueOnce({ externalId: "c1", url: "https://example.com/c/1" })
      .mockResolvedValueOnce({ externalId: "c2" });
    // Same post without follow-ups: the baseline of D1 round trips.
    await post("p_fu_base", "ws_p", "acc_hook");
    try {
      count.reset();
      expect((await runWorkflow("p_fu_base", 0)).result).toMatchObject({ published: true });
      const base = count.calls;
      count.reset();
      expect((await runWorkflow("p_fu_log", 0)).result).toMatchObject({ published: true });
      // 8 round trips per follow-up step, as many as before the log: it joined the usage event's INSERT in one batch.
      expect(count.calls - base, count.sql.join("\n")).toBe(2 * 8);
      expect(count.sql.filter((q) => q === "[batch of 2]")).toHaveLength(2);
      expect(count.calls, count.sql.join("\n")).toBeLessThan(50);
    } finally {
      delete (hook as any).reply;
    }
    const { results: logs } = await DB.prepare("SELECT level, message FROM post_logs WHERE post_id = 'p_fu_log' ORDER BY id").all<{ level: string; message: string }>();
    expect(logs.slice(-2)).toEqual([
      { level: "info", message: "Follow-up 1 posted: https://example.com/c/1" },
      { level: "info", message: "Follow-up 2 posted (id c2)" },
    ]);
    expect((await events("p_fu_log")).filter((e) => e.kind === "reply")).toHaveLength(2);
  });

  it("labels follow-ups of comment-style platforms as comments", () => {
    expect(followUpLabel("First comment", 0)).toBe("First comment");
    expect(followUpLabel("Comments", 0)).toBe("First comment");
    expect(followUpLabel("Comments", 1)).toBe("Comment 2");
    expect(followUpLabel("Thread replies", 0)).toBe("Follow-up 1");
    expect(followUpLabel(undefined, 2)).toBe("Follow-up 3");
  });

  it("links a follow-up only to what the URL really is: the reply, or the post it comments on", () => {
    // Facebook / YouTube / Reddit comments and X / Threads / Bluesky replies have their own URL.
    expect(followUpLog("First comment", { externalId: "1_2", url: "https://www.facebook.com/9_1?comment_id=2" })).toBe(
      "First comment posted: https://www.facebook.com/9_1?comment_id=2",
    );
    expect(followUpLog("Follow-up 1", { externalId: "t2", url: "https://x.com/a/status/t2" })).toBe("Follow-up 1 posted: https://x.com/a/status/t2");
    // Instagram comments have no permalink: the post, with the comment id.
    expect(followUpLog("First comment", { externalId: "1789", url: "https://www.instagram.com/p/ABC/", urlIsPost: true })).toBe(
      "First comment posted on https://www.instagram.com/p/ABC/ (comment id 1789)",
    );
    expect(followUpLog("Follow-up 2", { externalId: "m2", url: "https://whop.com/p/1", urlIsPost: true })).toBe("Follow-up 2 posted on https://whop.com/p/1 (id m2)");
    expect(followUpLog("First comment", { externalId: "1789", url: null, urlIsPost: true })).toBe("First comment posted (id 1789)");
  });

  it("records media uploads and deletes", async () => {
    const up = await call(owner, "/api/media", { raw: "abcdef", headers: { "content-type": "image/png", "x-filename": "u.png", "content-length": "6" } });
    expect(up.status, up.text).toBe(200);
    const del = await call(owner, `/api/media/${up.json.id}`, { method: "DELETE" });
    expect(del.status, del.text).toBe(200);
    const { results } = await DB.prepare("SELECT kind, outcome, media_count, media_bytes, post_type FROM usage_events WHERE workspace_id = 'ws_p' AND kind LIKE 'media_%' AND message IS NULL ORDER BY id DESC LIMIT 2").all<any>();
    expect(results).toEqual([
      { kind: "media_delete", outcome: "ok", media_count: 1, media_bytes: 6, post_type: "image" },
      { kind: "media_upload", outcome: "ok", media_count: 1, media_bytes: 6, post_type: "image" },
    ]);
  });
});

describe("usage_events: demo, metrics, crons", () => {
  it("demo publishes are recorded but flagged", async () => {
    await account("acc_ue_demo", "ws_pdemo", "webhook");
    await post("p_ue_demo", "ws_pdemo", "acc_ue_demo");
    expect(await publishDemoPosts(E, ["p_ue_demo"])).toBe(1);
    const e = await one<any>("SELECT * FROM usage_events WHERE post_id = 'p_ue_demo'");
    expect(e).toMatchObject({ kind: "publish", outcome: "published", is_demo: 1, provider: "webhook", workspace_id: "ws_pdemo" });
    // Already published: a second run records nothing.
    expect(await publishDemoPosts(E, ["p_ue_demo"])).toBe(0);
    expect((await one<any>("SELECT COUNT(*) AS n FROM usage_events WHERE post_id = 'p_ue_demo'")).n).toBe(1);
  });

  it("the metrics cron records one event per chunk, with the cron's last run, in one batch", async () => {
    const yt = getProvider("youtube") as Provider;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input as any, init).url);
      if (url.pathname === "/youtube/v3/videos") return Response.json({ items: url.searchParams.get("id")!.split(",").map((id) => ({ id, statistics: { viewCount: "3" } })) });
      return Response.json({});
    });
    void yt;
    const t = Date.now();
    await account("acc_ue_yt", "ws_q", "youtube", { credentials: { accessToken: "AT", refreshToken: "RT" }, expiresAt: t + DAY });
    await run("UPDATE accounts SET metrics_next_at = ? WHERE id = 'acc_ue_yt'", t + DAY);
    for (const id of ["p_ue_m1", "p_ue_m2"]) {
      await post(id, "ws_q", "acc_ue_yt", { status: "published", publishedAt: t - 2 * HOUR });
      await run("UPDATE posts SET external_id = ?, metrics_next_at = ? WHERE id = ?", `vid_${id}`, t - HOUR, id);
    }
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: METRICS_CRON, scheduledTime: t }), E, ctx);
    await waitOnExecutionContext(ctx);
    const e = await one<any>("SELECT * FROM usage_events WHERE kind = 'metrics_refresh' AND account_id = 'acc_ue_yt'");
    expect(e).toMatchObject({ provider: "youtube", outcome: "ok", quantity: 2, platform_api_calls: 1, workspace_id: "ws_q", is_demo: 0 });
    const last = JSON.parse((await one<any>("SELECT value FROM settings WHERE key = 'cron_last_run:metrics'")).value);
    expect(last.at).toBeGreaterThanOrEqual(t);
    await run("DELETE FROM posts WHERE id LIKE 'p_ue_m%'");
    await run("DELETE FROM accounts WHERE id = 'acc_ue_yt'");
  });

  it("the daily cron prunes old events (bounded) and records its run; the sweep recorded its deletions", async () => {
    const old = Date.now() - 401 * DAY;
    await run(
      "INSERT INTO usage_events (workspace_id, kind, outcome, created_at, day) VALUES ('ws_p', 'media_upload', 'ok', ?, ?)",
      old,
      new Date(old).toISOString().slice(0, 10),
    );
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: DAILY_CRON, scheduledTime: Date.now() }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect((await one<any>("SELECT COUNT(*) AS n FROM usage_events WHERE created_at = ?", old)).n).toBe(0);
    expect(await one("SELECT value FROM settings WHERE key = 'cron_last_run:daily'")).not.toBeNull();
    // The media lifecycle tests above swept 3 files of ws_p (2 expired + 1 unused upload-link file).
    const swept = await one<any>("SELECT SUM(quantity) AS n, SUM(media_bytes) AS bytes FROM usage_events WHERE kind = 'media_delete' AND message = 'lifecycle sweep' AND workspace_id = 'ws_p'");
    expect(swept).toEqual({ n: 3, bytes: 300 });
  });
});

describe("GET /api/admin/overview", () => {
  it("needs instance.overview.view", async () => {
    expect((await call(viewer, "/api/admin/overview")).status).toBe(403);
    expect((await call(other, "/api/admin/overview")).status).toBe(403);
  });

  it("aggregates the instance in one batch of fewer than 15 queries", async () => {
    await call(owner, "/api/admin/overview"); // warm
    count.reset();
    const res = await call(owner, "/api/admin/overview?days=7");
    expect(res.status, res.text).toBe(200);
    expect(count.queries + count.batchStatements, count.sql.join("\n")).toBeLessThan(15);
    const o = res.json;
    expect(o.range.days).toBe(7);
    expect(o.posts.daily).toHaveLength(7);
    expect(o.counts.workspaces).toBe(2);
    expect(o.counts.demoWorkspaces).toBe(1);
    expect(o.counts.users.active).toBeGreaterThanOrEqual(3);
    expect(o.posts.publishedToday).toBeGreaterThan(0);
    // Demo publishes stay out of the totals.
    expect(o.demo.publishedToday).toBe(1);
    const hook = o.posts.byProvider.find((p: any) => p.provider === "webhook");
    expect(hook.attempts.published).toBeGreaterThanOrEqual(2);
    expect(hook.attempts.failed + hook.attempts.needsCheck).toBeGreaterThanOrEqual(2);
    expect(hook.successRate).toBeGreaterThan(0);
    expect(hook.successRate).toBeLessThan(1);
    expect(o.health.lastErrors.length).toBeGreaterThan(0);
    expect(o.health.lastErrors[0]).toMatchObject({ workspaceId: "ws_p", workspaceName: "P" });
    expect(o.quotas.map((q: any) => q.key)).toEqual(["workflow_steps", "d1_rows_written", "r2_storage", "images_transformations"]);
    const steps = o.quotas[0];
    expect(steps.used).toBeGreaterThan(0);
    expect(steps.limit).toBe(3000);
    expect(o.system.crons.map((c: any) => c.name)).toEqual(["frequent", "metrics", "daily"]);
    expect(o.system.crons.find((c: any) => c.name === "daily").lastRunAt).toBeGreaterThan(0);
    expect(o.system.mediaRetentionDays).toBe(30);
    expect(o.workspaces.find((w: any) => w.id === "ws_pdemo").isDemo).toBe(true);
    expect(o.workspaces.find((w: any) => w.id === "ws_p")).toMatchObject({ name: "P", members: 2 });
    // Out-of-range days are clamped.
    expect((await call(owner, "/api/admin/overview?days=5000")).json.range.days).toBe(90);
  });
});

describe("comments under published posts and platform auth errors", () => {
  /** Lends the webhook provider follow-ups (it has none) for the duration of `fn`. */
  async function withReply(reply: NonNullable<Provider["reply"]>, fn: () => Promise<void>) {
    const caps = hook.capabilities as { thread: boolean };
    const before = caps.thread;
    caps.thread = true;
    hook.reply = reply;
    try {
      await fn();
    } finally {
      caps.thread = before;
      delete hook.reply;
    }
  }

  it("publishes the comment under the live post and logs it", async () => {
    await post("p_cmt", "ws_p", "acc_hook", { status: "published", publishedAt: Date.now() });
    await run("UPDATE posts SET external_id = 'ext_live', external_data = ? WHERE id = 'p_cmt'", JSON.stringify({ cid: "c1" }));
    const reply = vi.fn(async () => ({ externalId: "ext_comment", url: "https://example.com/c/1" }));
    await withReply(reply, async () => {
      const res = await call(owner, "/api/posts/p_cmt/comments", { body: { content: "  First!  " } });
      expect(res.status, res.text).toBe(201);
      expect(res.json).toEqual({ externalId: "ext_comment", url: "https://example.com/c/1" });
    });
    expect(reply).toHaveBeenCalledOnce();
    const [, , target, item] = reply.mock.calls[0] as unknown as [unknown, unknown, any, any];
    expect(target).toMatchObject({ rootId: "ext_live", parentId: "ext_live", rootData: { cid: "c1" } });
    expect(item).toMatchObject({ content: "First!", media: [] });
    expect(await one("SELECT message FROM post_logs WHERE post_id = 'p_cmt' AND message LIKE 'Comment added%'")).toBeTruthy();
    // Answering someone's reply under the post.
    await withReply(reply, async () => {
      expect((await call(owner, "/api/posts/p_cmt/comments", { body: { content: "Thanks!", replyTo: "ext_their_reply" } })).status).toBe(201);
      expect((await call(owner, "/api/posts/p_cmt/comments", { body: { content: "Thanks!", replyTo: "a b/c" } })).status).toBe(400);
    });
    expect((reply.mock.calls[1] as unknown as [unknown, unknown, any])[2]).toMatchObject({ rootId: "ext_live", parentId: "ext_their_reply" });
    // The post itself is unchanged.
    expect(await postRow("p_cmt")).toMatchObject({ status: "published", external_id: "ext_live" });
  });

  it("refuses posts that aren't live, empty text, platforms without follow-ups, viewers and other workspaces", async () => {
    await post("p_cmt_sched", "ws_p", "acc_hook", { status: "scheduled" });
    const reply = vi.fn(async () => ({ externalId: "x" }));
    await withReply(reply, async () => {
      expect((await call(owner, "/api/posts/p_cmt_sched/comments", { body: { content: "Hi" } })).status).toBe(409);
      expect((await call(owner, "/api/posts/p_cmt/comments", { body: { content: "   " } })).status).toBe(400);
      expect((await call(viewer, "/api/posts/p_cmt/comments", { body: { content: "Hi" } })).status).toBe(403);
      expect((await call(other, "/api/posts/p_cmt/comments", { body: { content: "Hi" } })).status).toBe(404);
    });
    expect(reply).not.toHaveBeenCalled();
    const unsupported = await call(owner, "/api/posts/p_cmt/comments", { body: { content: "Hi" } });
    expect(unsupported.status).toBe(400);
    expect(unsupported.json.error).toMatch(/does not support/);
  });

  // A 401 makes the web app (and the CLI) treat the Postflare session as expired and sign the user out.
  it("a platform auth failure is a 409, never a 401", async () => {
    await withReply(
      async () => {
        throw new ProviderError("Token expired, reconnect the account", "auth");
      },
      async () => {
        const res = await call(owner, "/api/posts/p_cmt/comments", { body: { content: "Hi" } });
        expect(res.status).toBe(409);
        expect(res.json.error).toMatch(/reconnect/);
      },
    );
    expect(await one("SELECT message FROM post_logs WHERE post_id = 'p_cmt' AND message LIKE 'Comment failed%'")).toBeTruthy();

    hook.options = async () => {
      throw new ProviderError("Token expired, reconnect the account", "auth");
    };
    try {
      const res = await call(owner, "/api/accounts/acc_hook/options/board?settings=%7B%7D");
      expect(res.status).toBe(409);
      expect(res.json.error).toMatch(/reconnect/);
    } finally {
      delete hook.options;
    }
  });
});
