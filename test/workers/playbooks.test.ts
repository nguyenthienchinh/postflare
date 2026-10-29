import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../worker/index";
import { createApiKey } from "../../worker/lib/auth";
import { encryptJson, hashPassword } from "../../worker/lib/crypto";
import { builtinPlaybooks } from "../../worker/lib/playbooks";
import { countingD1 } from "./d1-counter";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// Own D1 instance (PLAYBOOKS_DB), wrapped to count queries per request.
const { db: DB, count } = countingD1(env.PLAYBOOKS_DB);
const E = { ...env, DB, DEMO_MODE: "false" } as unknown as Env;
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();

async function call(client: Client | null, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.ws) headers["x-workspace-id"] = client.ws;
  if (client?.key) headers.authorization = `Bearer ${client.key}`;
  let body: BodyInit | undefined;
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
  return { status: res.status, json, text };
}

const raw = env.PLAYBOOKS_DB;
const run = (sql: string, ...binds: unknown[]) => raw.prepare(sql).bind(...binds).run();

async function user(id: string, email: string) {
  await run(
    "INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'role_instance_member', 'active', ?, ?)",
    id,
    email,
    id,
    await hashPassword("password123"),
    T0,
    T0,
  );
}

/** Signs in and returns the session cookie. */
async function cookieOf(email: string): Promise<string> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(
    new Request(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": `10.6.${email.length}.1` },
      body: JSON.stringify({ email, password: "password123" }),
    }) as any,
    E,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return sessionCookie(res.headers)!;
}

async function account(id: string, ws: string, provider: string) {
  await run(
    `INSERT INTO accounts (id, provider, external_id, name, username, credentials_enc, expires_at, meta, status, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, 'handle', ?, NULL, '{}', 'active', ?, ?, ?)`,
    id,
    provider,
    `ext_${id}`,
    `${provider} ${id}`,
    await encryptJson(E, { accessToken: "AT" }),
    T0,
    T0,
    ws,
  );
}

let n = 0;
/** A published post with metrics, seeded directly. */
async function published(ws: string, accountId: string, playbook: [string, number, string | null] | null, metrics: Record<string, number>, daysAgo = 5) {
  const id = `pst_pb_${++n}`;
  const t = T0 - daysAgo * DAY;
  await run(
    `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, settings, thread, external_id, attempts, revision, created_at, updated_at, published_at, workspace_id, metrics, metrics_at, playbook_id, playbook_version, variant)
     VALUES (?, ?, ?, 'published', ?, ?, '[]', '{}', '[]', ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    `grp_${id}`,
    accountId,
    t,
    `content ${id}`,
    `ext_${id}`,
    t,
    t,
    t,
    ws,
    JSON.stringify(metrics),
    t + DAY,
    playbook?.[0] ?? null,
    playbook?.[1] ?? null,
    playbook?.[2] ?? null,
  );
  return id;
}

let owner: Client;
let viewer: Client;
let other: Client;

beforeAll(async () => {
  await call(null, "/api/auth/status"); // applies migrations
  await user("usr_pb_owner", "pb-owner@example.com");
  await user("usr_pb_viewer", "pb-viewer@example.com");
  await user("usr_pb_other", "pb-other@example.com");
  await raw.batch([
    raw.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws_pb_a', 'A', ?, ?), ('ws_pb_b', 'B', ?, ?)").bind(T0, T0, T0, T0),
    raw
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES ('ws_pb_a', 'usr_pb_owner', 'role_ws_editor', ?), ('ws_pb_a', 'usr_pb_viewer', 'role_ws_viewer', ?), ('ws_pb_b', 'usr_pb_other', 'role_ws_owner', ?)",
      )
      .bind(T0, T0, T0),
  ]);
  owner = { cookie: await cookieOf("pb-owner@example.com"), ws: "ws_pb_a" };
  viewer = { cookie: await cookieOf("pb-viewer@example.com"), ws: "ws_pb_a" };
  other = { cookie: await cookieOf("pb-other@example.com"), ws: "ws_pb_b" };
  await account("acc_pb_x", "ws_pb_a", "x");
  await account("acc_pb_tt", "ws_pb_a", "tiktok");
  await account("acc_pb_b", "ws_pb_b", "x");
});

describe("permissions", () => {
  it("grants playbooks.manage to the built-in Owner, Admin and Editor roles (migration 0008)", async () => {
    const { results } = await raw.prepare("SELECT id, permissions FROM roles WHERE id LIKE 'role_ws_%' ORDER BY id").all<{ id: string; permissions: string }>();
    const has = Object.fromEntries(results.map((r) => [r.id, JSON.parse(r.permissions).includes("playbooks.manage")]));
    expect(has).toEqual({ role_ws_admin: true, role_ws_editor: true, role_ws_owner: true, role_ws_viewer: false });
  });
});

describe("library", () => {
  it("lists and searches the built-ins (posts.read)", async () => {
    const all = await call(viewer, "/api/playbooks");
    expect(all.status, all.text).toBe(200);
    expect(all.json.length).toBe(builtinPlaybooks().length);
    expect(all.json[0]).not.toHaveProperty("body");
    const game = await call(viewer, "/api/playbooks?q=game%20clip");
    expect(game.json[0].id).toBe("game-clip-hook");
    expect(game.json[0].score).toBeGreaterThan(0);
    const tiktok = (await call(viewer, "/api/playbooks?platform=tiktok&format=video")).json;
    expect(tiktok.length).toBeGreaterThan(0);
    expect(tiktok.every((p: any) => p.formats.includes("video"))).toBe(true);
  });

  it("returns a playbook with the agent prompt for this workspace's accounts", async () => {
    const res = await call(viewer, "/api/playbooks/short-video-hook-script");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ id: "short-video-hook-script", builtin: true, version: 2, versions: [2] });
    expect(res.json.prompt).toContain("acc_pb_tt"); // TikTok matches short-video
    expect(res.json.prompt).not.toContain("acc_pb_b"); // other workspace
    expect(res.json.prompt).toContain('playbookId "short-video-hook-script"');
    expect((await call(viewer, "/api/playbooks/short-video-hook-script?version=3")).status).toBe(404);
    expect((await call(viewer, "/api/playbooks/nope")).status).toBe(404);
  });
});

describe("custom playbooks", () => {
  let id: string;

  it("viewers cannot create playbooks", async () => {
    const res = await call(viewer, "/api/playbooks", { body: { name: "Mine", goal: "reach", body: "## When to use\nAlways." } });
    expect(res.status).toBe(403);
  });

  it("creates, then edits into new immutable versions", async () => {
    const res = await call(owner, "/api/playbooks", { body: { name: "Weekly devlog", goal: "followers", platforms: ["x", "short-video"], formats: ["video"], body: "## When to use\nFridays." } });
    expect(res.status, res.text).toBe(201);
    id = res.json.id;
    expect(res.json).toMatchObject({ slug: "weekly-devlog", version: 1, builtin: false, versions: [1] });

    const dup = await call(owner, "/api/playbooks", { body: { name: "Weekly devlog", goal: "reach", body: "x" } });
    expect(dup.status).toBe(409);

    const v2 = await call(owner, `/api/playbooks/${id}`, { method: "PATCH", body: { body: "## When to use\nFridays and Mondays." } });
    expect(v2.status, v2.text).toBe(200);
    expect(v2.json).toMatchObject({ version: 2, latestVersion: 2, versions: [1, 2] });
    // Same content again: no new version.
    const same = await call(owner, `/api/playbooks/${id}`, { method: "PATCH", body: { body: "## When to use\nFridays and Mondays." } });
    expect(same.json.version).toBe(2);
    // Version 1 is untouched.
    const v1 = await call(viewer, `/api/playbooks/${id}?version=1`);
    expect(v1.json).toMatchObject({ version: 1, latestVersion: 2, body: "## When to use\nFridays." });
    expect((await call(viewer, "/api/playbooks/weekly-devlog")).json.version).toBe(2); // by slug
  });

  it("built-ins are read-only but can be duplicated", async () => {
    expect((await call(owner, "/api/playbooks/how-to-tip", { method: "PATCH", body: { name: "x" } })).status).toBe(409);
    expect((await call(owner, "/api/playbooks/how-to-tip", { method: "DELETE" })).status).toBe(409);
    const copy = await call(owner, "/api/playbooks/how-to-tip/duplicate", { body: {} });
    expect(copy.status, copy.text).toBe(201);
    expect(copy.json).toMatchObject({ slug: "how-to-tip-custom", basedOn: "how-to-tip@2", builtin: false, version: 1 });
    const again = await call(owner, "/api/playbooks/how-to-tip/duplicate", { body: {} });
    expect(again.json.slug).toBe("how-to-tip-custom-2");
  });

  it("custom playbooks of another workspace are 404", async () => {
    expect((await call(other, `/api/playbooks/${id}`)).status).toBe(404);
    expect((await call(other, `/api/playbooks/${id}`, { method: "PATCH", body: { name: "Hijack" } })).status).toBe(404);
    expect((await call(other, `/api/playbooks/${id}/duplicate`, { body: {} })).status).toBe(404);
    expect((await call(other, `/api/playbooks/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(other, "/api/playbooks?source=custom")).json).toEqual([]);
  });

  describe("post attribution", () => {
    const draft = (extra: Record<string, unknown>) => ({ scheduledAt: null, posts: [{ accountId: "acc_pb_x", content: "Hello" }], ...extra });

    it("stores built-in and custom playbooks (by id or slug) with version and variant", async () => {
      const a = await call(owner, "/api/posts", { body: draft({ playbookId: "text-thread", variant: " A " }) });
      expect(a.status, a.text).toBe(201);
      expect(a.json[0]).toMatchObject({ playbookId: "text-thread", playbookVersion: 2, variant: "A" });
      const b = await call(owner, "/api/posts", { body: draft({ playbookId: "weekly-devlog", playbookVersion: 1 }) });
      expect(b.json[0]).toMatchObject({ playbookId: id, playbookVersion: 1, variant: null });
      const c = await call(owner, "/api/posts", { body: draft({ playbookId: id }) });
      expect(c.json[0].playbookVersion).toBe(2);

      // Variant only: the playbook and its version stay.
      const patched = await call(owner, `/api/posts/${b.json[0].id}`, { method: "PATCH", body: { variant: "B" } });
      expect(patched.json).toMatchObject({ playbookId: id, playbookVersion: 1, variant: "B" });
      const cleared = await call(owner, `/api/posts/${b.json[0].id}`, { method: "PATCH", body: { playbookId: null, variant: null } });
      expect(cleared.json).toMatchObject({ playbookId: null, playbookVersion: null, variant: null });

      const list = await call(viewer, "/api/posts?playbookId=text-thread");
      expect(list.json.map((p: any) => p.id)).toEqual([a.json[0].id]);
    });

    it("refuses unknown playbooks, versions and other workspaces' playbooks", async () => {
      expect((await call(owner, "/api/posts", { body: draft({ playbookId: "nope" }) })).status).toBe(404);
      expect((await call(owner, "/api/posts", { body: draft({ playbookId: "text-thread", playbookVersion: 9 }) })).status).toBe(400);
      expect((await call(owner, "/api/posts", { body: draft({ playbookId: id, playbookVersion: 3 }) })).status).toBe(400);
      expect((await call(owner, "/api/posts", { body: draft({ variant: "x".repeat(33) }) })).status).toBe(400);
      // ws B cannot attribute to ws A's custom playbook.
      const res = await call(other, "/api/posts", { body: { scheduledAt: null, posts: [{ accountId: "acc_pb_b", content: "Hi" }], playbookId: id } });
      expect(res.status).toBe(404);
      expect(res.json.error).toMatch(/not found/);
    });

    it("archiving hides a playbook and blocks new attributions, existing posts keep it", async () => {
      expect((await call(owner, `/api/playbooks/${id}`, { method: "DELETE" })).status).toBe(200);
      expect((await call(viewer, "/api/playbooks?source=custom")).json.some((p: any) => p.id === id)).toBe(false);
      expect((await call(owner, "/api/posts", { body: draft({ playbookId: id }) })).status).toBe(400);
      expect((await call(viewer, `/api/playbooks/${id}`)).json.archived).toBe(true);
    });
  });
});

describe("stats", () => {
  beforeAll(async () => {
    await account("acc_pb_x2", "ws_pb_b", "x");
    // ws B, account x2: baseline engagement rate 2 % (no playbook); text-thread posts at 3 % (v1: A and B variants).
    for (let i = 0; i < 4; i++) await published("ws_pb_b", "acc_pb_x2", null, { impressions: 1000, likes: 20 });
    for (let i = 0; i < 6; i++) await published("ws_pb_b", "acc_pb_x2", ["text-thread", 1, i % 2 ? "A" : "B"], { impressions: 1000, likes: i % 2 ? 40 : 20 });
    await published("ws_pb_b", "acc_pb_x2", ["how-to-tip", 1, null], { impressions: 2000, likes: 20 });
    // Outside the range, and a workspace A post: ignored.
    await published("ws_pb_b", "acc_pb_x2", ["how-to-tip", 1, null], { impressions: 10, likes: 1000 }, 200);
    await published("ws_pb_a", "acc_pb_x", ["how-to-tip", 1, null], { impressions: 10, likes: 1000 });
  });

  it("ranks playbooks by lift vs each account's baseline, in a few D1 queries", async () => {
    count.reset();
    const res = await call(other, "/api/playbooks/stats?days=90");
    expect(res.status, res.text).toBe(200);
    // Session lookup + one aggregate query (+ names of custom playbooks when used): far below the 50-query budget.
    expect(count.calls).toBeLessThan(15);
    const s = res.json;
    expect(s.postsAnalyzed).toBe(11);
    expect(s.baseline).toMatchObject({ playbookId: null, posts: 4, accounts: 1, confidence: "insufficient" });
    expect(s.baseline.medianEngagementRate).toBeCloseTo(0.02);
    const [first, second] = s.playbooks;
    expect(first).toMatchObject({ playbookId: "text-thread", name: builtinPlaybooks().find((p) => p.id === "text-thread")!.name, builtin: true, posts: 6, confidence: "low" });
    // Rates 2 % (B) and 4 % (A) against a 2 % baseline → lifts 1 and 2, median 1.5 → +50 %.
    expect(first.lift).toBeCloseTo(0.5);
    expect(first.variants.map((v: any) => [v.variant, v.posts, Math.round(v.lift * 100)])).toEqual([
      ["A", 3, 100],
      ["B", 3, 0],
    ]);
    expect(second).toMatchObject({ playbookId: "how-to-tip", posts: 1, confidence: "insufficient" });
    expect(second.lift).toBeCloseTo(-0.5);
    expect(s.method).toMatch(/correlation/);
  });

  it("filters by platform and account, and stays in the workspace", async () => {
    expect((await call(other, "/api/playbooks/stats?platform=tiktok")).json.postsAnalyzed).toBe(0);
    expect((await call(other, "/api/playbooks/stats?accountId=acc_pb_x")).json.postsAnalyzed).toBe(0);
    const a = (await call(viewer, "/api/playbooks/stats")).json;
    expect(a.postsAnalyzed).toBe(1);
  });
});

describe("MCP", () => {
  let key: string;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await call({ key }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    expect(res.status, res.text).toBe(200);
    const r = res.json.result;
    return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
  };

  beforeAll(async () => {
    key = (await createApiKey(E, "mcp", "usr_pb_owner", "ws_pb_a")).token;
  });

  it("lists the playbook tools and tells agents to use them", async () => {
    const list = await call({ key }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const names = list.json.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_playbooks", "get_playbook", "get_playbook_stats"]));
    expect(list.json.result.tools.find((t: any) => t.name === "create_post").inputSchema.properties).toHaveProperty("playbookId");
    const init = await call({ key }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    expect(init.json.result.instructions).toMatch(/search_playbooks/);
  });

  it("searches, returns the prompt, creates an attributed post and ranks", async () => {
    const found = await tool("search_playbooks", { q: "launch", platform: "x", limit: 3 });
    expect(found.data[0].id).toBe("launch-announcement");
    expect(found.data.length).toBeLessThanOrEqual(3);
    const pb = await tool("get_playbook", { id: "launch-announcement" });
    expect(pb.data.prompt).toContain("acc_pb_x");
    expect(pb.data.checklist.length).toBeGreaterThan(0);
    const created = await tool("create_post", { scheduledAt: null, content: "Launch!", accounts: [{ accountId: "acc_pb_x" }], playbookId: "launch-announcement", playbookVersion: 1, variant: "A" });
    expect(created.error).toBeNull();
    expect(created.data[0]).toMatchObject({ playbookId: "launch-announcement", playbookVersion: 1, variant: "A" });
    const stats = await tool("get_playbook_stats", { days: 30 });
    expect(stats.data.postsAnalyzed).toBe(1);
    expect(stats.data.playbooks[0]).toMatchObject({ playbookId: "how-to-tip", confidence: "insufficient" });
    expect((await tool("get_playbook", { id: "../keys" })).error).toBeTruthy();
  });
});
