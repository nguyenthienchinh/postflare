import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { hashPassword } from "../../worker/lib/crypto";
import { DEMO_LOGINS_PER_HOUR, DEMO_POSTS_PER_DAY } from "../../worker/lib/demo";
import { DEMO_WORKSPACE_PERMISSIONS } from "../../worker/lib/permissions";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// The worker is called directly (not through SELF) so each test can choose DEMO_MODE and provide a fake ASSETS
// binding (the test config has no static assets). It runs against its own D1 database (a separate instance).

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const assets = {
  fetch: async (input: Request | string) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname;
    return path.startsWith("/demo/") && path.endsWith(".jpg")
      ? new Response(JPEG, { headers: { "content-type": "image/jpeg" } })
      : new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  },
} as unknown as Fetcher;

const DB = env.DEMO_DB;
const ON = { ...env, DB, DEMO_MODE: "true", ASSETS: assets } as unknown as Env;
const OFF = { ...env, DB, DEMO_MODE: "false", ASSETS: assets } as unknown as Env;

/** Like helpers.call, against the worker with a given env. `wait` also waits for waitUntil work (simulated publishing). */
async function call(e: Env, client: Client | null, path: string, opts: CallOptions & { wait?: boolean } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.ws && !headers["x-workspace-id"]) headers["x-workspace-id"] = client.ws;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(opts.body);
  }
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, e, ctx);
  if (opts.wait) await waitOnExecutionContext(ctx);
  const text = /json|text|html/.test(res.headers.get("content-type") ?? "") ? await res.text() : (await res.arrayBuffer(), "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function cron(e: Env) {
  const ctx = createExecutionContext();
  await worker.scheduled!(createScheduledController(), e, ctx);
  await waitOnExecutionContext(ctx);
}

async function demoLogin(ip: string) {
  const res = await call(ON, null, "/demo", { headers: { "cf-connecting-ip": ip } });
  expect(res.status, res.text).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  return { cookie: sessionCookie(res.headers)! } as Client;
}

const one = <T>(sql: string, ...binds: unknown[]) => DB.prepare(sql).bind(...binds).first<T>();

let demo: Client;
let admin: Client;
let otherWs: string;

beforeAll(async () => {
  // A real instance admin with a workspace of their own (created directly: setup may already be taken by another file).
  await call(OFF, null, "/api/auth/status"); // applies migrations
  const t = Date.now();
  await DB.batch([
    DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES ('usr_demo_admin', 'demo-admin@example.com', 'Ada', ?, 'role_instance_admin', 'active', ?, ?)").bind(
      await hashPassword("password123"),
      t,
      t,
    ),
    DB.prepare("INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES ('ws_demo_other', 'Ada private', 'usr_demo_admin', ?, ?)").bind(t, t),
    DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES ('ws_demo_other', 'usr_demo_admin', 'role_ws_owner', ?)").bind(t),
  ]);
  otherWs = "ws_demo_other";
  const res = await call(OFF, null, "/api/auth/login", { body: { email: "demo-admin@example.com", password: "password123" }, headers: { "cf-connecting-ip": "10.7.0.1" } });
  expect(res.status).toBe(200);
  admin = { cookie: sessionCookie(res.headers)!, ws: otherWs };
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("DEMO_MODE off", () => {
  it("404s every demo endpoint and seeds nothing", async () => {
    expect((await call(OFF, null, "/demo")).status).toBe(404);
    expect((await call(OFF, null, "/api/auth/demo", { method: "POST" })).status).toBe(404);
    expect((await call(OFF, null, "/api/auth/status")).json.demo).toBeUndefined();
    await cron(OFF);
    expect(await one("SELECT id FROM workspaces WHERE id = 'ws_demo'")).toBeNull();
    expect(await one("SELECT id FROM users WHERE id = 'usr_demo'")).toBeNull();
    expect(await one("SELECT id FROM roles WHERE id = 'role_ws_demo'")).toBeNull();
  });
});

describe("demo login", () => {
  it("GET /demo seeds the demo, signs in and redirects to the app", async () => {
    expect((await call(ON, null, "/api/auth/status")).json).toMatchObject({ demo: true });
    demo = await demoLogin("10.8.0.1");
    const status = await call(ON, demo, "/api/auth/status");
    expect(status.json).toMatchObject({ setup: true, authenticated: true, demo: true });
    const me = (await call(ON, demo, "/api/me")).json;
    expect(me.user).toMatchObject({ id: "usr_demo", name: "Demo visitor", demo: true });
    expect(me.instancePermissions).toEqual([]);
    expect(me.workspaces).toHaveLength(1);
    expect(me.workspaces[0]).toMatchObject({ id: "ws_demo", name: "Acme Studio (demo)", demo: true });
    expect([...me.workspaces[0].permissions].sort()).toEqual([...DEMO_WORKSPACE_PERMISSIONS].sort());
    expect(me.currentWorkspaceId).toBe("ws_demo");
    // 12h session.
    const session = await one<{ ttl: number }>("SELECT expires_at - created_at AS ttl FROM sessions WHERE user_id = 'usr_demo' ORDER BY created_at DESC LIMIT 1");
    expect(session!.ttl).toBe(12 * 60 * 60 * 1000);
    // Opening the demo again keeps the same session.
    const again = await call(ON, demo, "/demo", { headers: { "cf-connecting-ip": "10.8.0.1" } });
    expect(again.status).toBe(302);
    expect(sessionCookie(again.headers)).toBeUndefined();
  });

  it("seeds realistic content", async () => {
    const accounts = (await call(ON, demo, "/api/accounts")).json;
    expect(accounts.map((a: any) => a.provider).sort()).toEqual(
      ["bluesky", "instagram_standalone", "linkedin_page", "pinterest", "threads", "tiktok", "x", "youtube"].sort(),
    );
    // Account groups: one per app plus the studio; Threads stays ungrouped.
    const accountGroups = (await call(ON, demo, "/api/account-groups")).json;
    expect(accountGroups.map((g: any) => [g.name, g.accountCount])).toEqual([
      ["Tempo", 1],
      ["Pocket Plants", 2],
      ["Acme Studio", 4],
    ]);
    expect(accounts.find((a: any) => a.provider === "threads").groupId).toBeNull();
    expect(accounts.find((a: any) => a.provider === "x").groupId).toBe(accountGroups[0].id);
    const media = (await call(ON, demo, "/api/media")).json;
    expect(media).toHaveLength(8);
    // Copied from the static assets into R2 and served like any media.
    expect(await env.MEDIA.head("demo/tempo-launch.jpg")).not.toBeNull();
    const file = await call(ON, null, new URL(media[0].url).pathname);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/jpeg");

    const posts = (await call(ON, demo, "/api/posts")).json as any[];
    const by = (s: string) => posts.filter((p) => p.status === s);
    expect(by("published").length).toBeGreaterThanOrEqual(10);
    expect(by("scheduled").length).toBeGreaterThanOrEqual(10);
    expect(by("draft")).toHaveLength(2);
    expect(by("failed")).toHaveLength(1);
    expect(by("failed")[0].error).toMatch(/duplicate content/);
    const now = Date.now();
    expect(by("published").every((p) => p.publishedAt < now && p.publishedAt > now - 81 * 864e5 && p.externalUrl.startsWith("https://example.com/demo/"))).toBe(true);
    expect(by("scheduled").every((p) => p.scheduledAt > now && p.scheduledAt < now + 15 * 864e5)).toBe(true);
    // A multi-account group and follow-ups (thread / first comment).
    const groups = new Map<string, number>();
    for (const p of posts) groups.set(p.groupId, (groups.get(p.groupId) ?? 0) + 1);
    expect(Math.max(...groups.values())).toBeGreaterThanOrEqual(5);
    expect(posts.some((p) => p.thread.length >= 3)).toBe(true);
    // Logs like a real publish.
    const detail = (await call(ON, demo, `/api/posts/${by("published")[0].id}`)).json;
    expect(detail.logs.map((l: any) => l.message).join("\n")).toMatch(/Simulated publish — demo workspace, nothing was sent/);
    // No workflows for demo posts.
    expect(await one("SELECT id FROM posts WHERE workspace_id = 'ws_demo' AND workflow_id IS NOT NULL")).toBeNull();
    // Playbook attribution (some A/B variants), so the ranking has something to show.
    const attributed = by("published").filter((p) => p.playbookId);
    expect(attributed.length).toBeGreaterThanOrEqual(25);
    expect(attributed.some((p) => p.variant === "A") && attributed.some((p) => p.variant === "B")).toBe(true);
    const stats = (await call(ON, demo, "/api/playbooks/stats")).json;
    expect(stats.playbooks.length).toBeGreaterThanOrEqual(8);
    expect(stats.playbooks.some((p: any) => p.confidence !== "insufficient" && p.lift > 0)).toBe(true);
    expect(stats.baseline.posts).toBeGreaterThanOrEqual(5);
  });

  it("seeds analytics, and refreshes them without calling any platform", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const summary = await call(ON, demo, "/api/analytics/summary");
    expect(summary.status, summary.text).toBe(200);
    const s = summary.json;
    expect(s.totals.posts).toBeGreaterThanOrEqual(10);
    expect(s.totals.postsWithMetrics).toBe(s.totals.posts);
    expect(s.totals.views + s.totals.impressions).toBeGreaterThan(0);
    expect(s.totals.engagements).toBeGreaterThan(0);
    expect(s.totals.followers).toBeGreaterThan(0);
    expect(s.totals.followersChange).toBeGreaterThan(0);
    expect(s.followers.length).toBeGreaterThanOrEqual(6);
    expect(Math.min(...s.followers.map((f: any) => f.points.length))).toBeGreaterThanOrEqual(29);
    expect(s.daily.some((d: any) => d.views > 0)).toBe(true);
    const top = (await call(ON, demo, "/api/analytics/posts?sort=views")).json;
    expect(top[0].metrics).not.toBeNull();
    const series = (await call(ON, demo, `/api/posts/${top[0].id}/metrics`)).json;
    expect(series.snapshots.length).toBeGreaterThanOrEqual(2);
    // Snapshots grow over time.
    const views = series.snapshots.map((x: any) => x.metrics.views ?? x.metrics.impressions ?? x.metrics.likes);
    expect([...views].sort((a, b) => a - b)).toEqual(views);
    const accounts = (await call(ON, demo, "/api/accounts")).json;
    expect(accounts.every((a: any) => a.metricsStatus.status === "ok")).toBe(true);
    const refresh = await call(ON, demo, "/api/analytics/refresh", { body: { accountId: "acc_demo_yt" } });
    expect(refresh.status, refresh.text).toBe(200);
    expect(refresh.json.account.metricsStatus).toMatchObject({ status: "ok" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("seeds App Store campaign links with sample installs and revenue, and never calls Revflare", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const apps = (await call(ON, demo, "/api/apps")).json;
    expect(apps.map((a: any) => a.name).sort()).toEqual(["Pocket Plants", "Tempo: Focus Timer"]);
    const settings = (await call(ON, demo, "/api/campaigns/settings")).json;
    expect(settings).toMatchObject({ providerToken: "123456", autoLink: true, revflare: { keyConfigured: false, currency: "USD" } });
    const s = (await call(ON, demo, "/api/analytics/summary")).json;
    expect(s.totals.campaignPosts).toBeGreaterThanOrEqual(3);
    expect(s.totals.clicks).toBeGreaterThan(0);
    expect(s.totals.downloads).toBeGreaterThan(0);
    expect(s.currency).toBe("USD");
    const top = (await call(ON, demo, "/api/analytics/posts?sort=downloads")).json;
    expect(top[0].campaign.downloads).toBeGreaterThan(0);
    const bio = (await call(ON, demo, "/api/campaigns/links?kind=bio")).json;
    expect(bio.map((l: any) => l.ct).sort()).toEqual(["pf-igs-bio", "pf-tt-bio"]);
    const ranking = (await call(ON, demo, "/api/playbooks/stats?sort=downloads")).json;
    expect(ranking.playbooks.some((p: any) => p.downloads > 0)).toBe(true);
    // The demo cannot connect or sync Revflare (no workspace.manage, and the workspace refuses it anyway).
    expect((await call(ON, demo, "/api/campaigns/sync", { body: {} })).status).toBe(403);
    expect((await call(ON, demo, "/api/campaigns/settings", { method: "PUT", body: { revflareUrl: "https://revflare.example.com", revflareKey: "rf_0123456789abcdef" } })).status).toBe(403);
    // A tracked link of the demo redirects and counts.
    const link = (await call(ON, demo, "/api/campaigns/links?kind=post&limit=1")).json[0];
    const res = await call(ON, null, `/a/${link.code}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1" }, wait: true });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("apps.apple.com/app/apple-store/id6450000");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is throttled per IP", async () => {
    for (let i = 0; i < DEMO_LOGINS_PER_HOUR; i++) {
      const res = await call(ON, null, "/api/auth/demo", { method: "POST", headers: { "cf-connecting-ip": "10.8.9.9" } });
      expect(res.status, `login ${i + 1}`).toBe(200);
    }
    const blocked = await call(ON, null, "/api/auth/demo", { method: "POST", headers: { "cf-connecting-ip": "10.8.9.9" } });
    expect(blocked.status).toBe(429);
    expect((await call(ON, null, "/demo", { headers: { "cf-connecting-ip": "10.8.9.9" } })).status).toBe(429);
    // Other visitors are not affected.
    expect((await call(ON, null, "/api/auth/demo", { method: "POST", headers: { "cf-connecting-ip": "10.8.9.10" } })).status).toBe(200);
  });

  it("the demo user cannot sign in with a password", async () => {
    const res = await call(ON, null, "/api/auth/login", { body: { email: "demo@postflare.local", password: "" }, headers: { "cf-connecting-ip": "10.8.1.1" } });
    expect(res.status).toBe(401);
  });

  it("does not count as the instance's first user", async () => {
    // Setup state comes from real users only (here: the admin created above).
    const status = (await call(ON, null, "/api/auth/status")).json;
    expect(status.setup).toBe(true);
    expect(await one("SELECT 1 AS x FROM users WHERE is_demo = 0")).not.toBeNull();
  });
});

describe("the demo user is locked down", () => {
  it("cannot change the profile, password, API keys or workspaces", async () => {
    const forbidden: Array<[string, CallOptions]> = [
      ["/api/me", { method: "PATCH", body: { name: "Hacker" } }],
      ["/api/me", { method: "PATCH", body: { email: "x@example.com" } }],
      ["/api/me/password", { body: { current: "", next: "password123" } }],
      ["/api/auth/password", { body: { current: "", next: "password123" } }],
      ["/api/keys", { body: { name: "k" } }],
      ["/api/keys", {}],
      ["/api/workspaces", { body: { name: "Mine" } }],
      ["/api/workspaces/ws_demo", { method: "PATCH", body: { name: "Renamed" } }],
      ["/api/workspaces/ws_demo", { method: "DELETE" }],
      ["/api/workspaces/ws_demo/members/usr_demo", { method: "DELETE" }],
      ["/api/invitations", { body: { instanceRoleId: "role_instance_member", workspaceId: "ws_demo", workspaceRoleId: "role_ws_viewer" } }],
    ];
    for (const [path, opts] of forbidden) {
      const res = await call(ON, demo, path, opts);
      expect(res.status, `${opts.method ?? (opts.body ? "POST" : "GET")} ${path}: ${res.text}`).toBe(403);
    }
    expect((await one<{ name: string }>("SELECT name FROM users WHERE id = 'usr_demo'"))!.name).toBe("Demo visitor");
    expect(await one("SELECT 1 AS x FROM workspace_members WHERE workspace_id = 'ws_demo' AND user_id = 'usr_demo'")).not.toBeNull();
  });

  it("cannot reach admin endpoints", async () => {
    for (const [path, opts] of [
      ["/api/users", {}],
      ["/api/users/usr_demo", { method: "PATCH", body: { roleId: "role_instance_admin" } }],
      ["/api/platforms/x", {}],
      ["/api/platforms/x", { method: "PUT", body: { values: {} } }],
      ["/api/settings", { method: "PUT", body: { timezone: "UTC" } }],
      ["/api/roles", { body: { scope: "workspace", name: "R", permissions: [] } }],
    ] as Array<[string, CallOptions]>) {
      expect((await call(ON, demo, path, opts)).status, path).toBe(403);
    }
  });

  it("cannot upload media, create upload links or connect accounts", async () => {
    const upload = await call(ON, demo, "/api/media", {
      method: "POST",
      raw: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "image/png", "x-filename": "a.png", "content-length": "3" },
    });
    expect(upload.status).toBe(403);
    expect((await call(ON, demo, "/api/media/from-url", { body: { url: "https://example.com/a.png" } })).status).toBe(403);
    expect((await call(ON, demo, "/api/media/multipart", { body: { filename: "a.mp4", mime: "video/mp4", size: 10 } })).status).toBe(403);
    expect((await call(ON, demo, "/api/upload-links", { body: {} })).status).toBe(403);
    expect((await call(ON, demo, "/api/connect/webhook", { body: { values: { name: "h", url: "https://example.com/h" } } })).status).toBe(403);
    expect((await call(ON, demo, "/api/connect/x/url")).status).toBe(403);
    expect((await call(ON, demo, "/api/accounts/acc_demo_x", { method: "DELETE" })).status).toBe(403);
    // Groups are read-only for visitors (no accounts.manage).
    expect((await call(ON, demo, "/api/account-groups", { body: { name: "Mine" } })).status).toBe(403);
    expect((await call(ON, demo, "/api/accounts/group", { body: { accountIds: ["acc_demo_x"], groupId: null } })).status).toBe(403);
  });

  it("only ever reaches the demo workspace, even when an admin adds it elsewhere", async () => {
    await DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES (?, 'usr_demo', 'role_ws_owner', ?)").bind(otherWs, Date.now()).run();
    const me = (await call(ON, demo, "/api/me")).json;
    expect(me.workspaces.map((w: any) => w.id)).toEqual(["ws_demo"]);
    expect((await call(ON, { ...demo, ws: otherWs }, "/api/posts")).status).toBe(404);
    expect((await call(ON, { ...demo, ws: otherWs }, "/api/accounts")).status).toBe(404);
    expect((await call(ON, demo, "/api/me/workspace", { body: { workspaceId: otherWs } })).status).toBe(404);
    expect((await call(ON, demo, `/api/workspaces/${otherWs}/members`)).status).toBe(404);
    expect((await call(ON, demo, "/api/workspaces")).json.map((w: any) => w.id)).toEqual(["ws_demo"]);
    // A bigger role in the demo workspace or an admin instance role does not help either.
    await DB.batch([
      DB.prepare("UPDATE workspace_members SET role_id = 'role_ws_owner' WHERE workspace_id = 'ws_demo' AND user_id = 'usr_demo'"),
      DB.prepare("UPDATE users SET role_id = 'role_instance_admin' WHERE id = 'usr_demo'"),
    ]);
    const me2 = (await call(ON, demo, "/api/me")).json;
    expect(me2.instancePermissions).toEqual([]);
    expect([...me2.workspaces[0].permissions].sort()).toEqual([...DEMO_WORKSPACE_PERMISSIONS].sort());
    expect((await call(ON, demo, "/api/users")).status).toBe(403);
    expect((await call(ON, demo, "/api/keys", { body: { name: "k" } })).status).toBe(403);
    // The next seed restores the identity.
    await DB.prepare("DELETE FROM settings WHERE key = 'demo_reset_at'").run();
    await demoLogin("10.8.0.2");
    expect(await one("SELECT 1 AS x FROM workspace_members WHERE user_id = 'usr_demo' AND workspace_id != 'ws_demo'")).toBeNull();
    expect((await one<{ role_id: string }>("SELECT role_id FROM users WHERE id = 'usr_demo'"))!.role_id).toBe("role_instance_demo");
  });

  it("cannot accept invitations", async () => {
    const inv = await call(ON, admin, "/api/invitations", { body: { instanceRoleId: "role_instance_member", workspaceId: otherWs, workspaceRoleId: "role_ws_viewer" } });
    expect(inv.status).toBe(201);
    const token = inv.json.url.split("/invite/")[1];
    const res = await call(ON, demo, "/api/invitations/accept", { body: { token } });
    expect(res.status).toBe(403);
    expect(await one("SELECT 1 AS x FROM workspace_members WHERE user_id = 'usr_demo' AND workspace_id = ?", otherWs)).toBeNull();
  });

  it("admins cannot hand out the demo roles or change the demo user", async () => {
    expect((await call(ON, admin, "/api/users/usr_demo", { method: "PATCH", body: { roleId: "role_instance_admin" } })).status).toBe(409);
    expect((await call(ON, admin, "/api/users/usr_demo", { method: "DELETE" })).status).toBe(409);
    const roles = (await call(ON, admin, "/api/roles")).json;
    expect(roles.some((r: any) => r.id.includes("demo"))).toBe(false);
    const inv = await call(ON, admin, "/api/invitations", { body: { instanceRoleId: "role_instance_member", workspaceId: otherWs, workspaceRoleId: "role_ws_demo" } });
    expect(inv.status).toBe(400);
  });

  it("the demo workspace is sandboxed for admins too", async () => {
    const inDemo = { ...admin, ws: "ws_demo" };
    expect((await call(ON, inDemo, "/api/connect/webhook", { body: { values: { name: "h", url: "https://example.com/h" } } })).status).toBe(403);
    expect((await call(ON, inDemo, "/api/connect/x/url")).status).toBe(403);
    const upload = await call(ON, inDemo, "/api/media", {
      method: "POST",
      raw: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "image/png", "x-filename": "a.png", "content-length": "3" },
    });
    expect(upload.status).toBe(403);
    expect((await call(ON, inDemo, "/api/upload-links", { body: {} })).status).toBe(403);
    expect((await call(ON, inDemo, "/api/media/med_demo_launch", { method: "DELETE" })).status).toBe(403);
  });
});

describe("publishing in the demo is simulated", () => {
  it("post now: publishing, then published a few seconds later, without any outgoing request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await call(ON, demo, "/api/posts", {
      body: { scheduledAt: "now", posts: [{ accountId: "acc_demo_bs", content: "Hello from the demo", thread: [{ content: "and a reply", media: [] }] }] },
      wait: true,
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json[0].status).toBe("publishing");
    const post = (await call(ON, demo, `/api/posts/${res.json[0].id}`)).json;
    expect(post.status).toBe("published");
    expect(post.externalUrl).toMatch(/^https:\/\/example\.com\/demo\/bluesky\/\d+$/);
    const messages = post.logs.map((l: any) => l.message);
    expect(messages[0]).toBe("Queued for immediate publishing");
    expect(messages).toContain("Simulated publish — demo workspace, nothing was sent to Bluesky");
    expect(messages.some((m: string) => m.startsWith("Follow-up 1 published"))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await one<{ workflow_id: string | null }>("SELECT workflow_id FROM posts WHERE id = ?", post.id))!.workflow_id).toBeNull();
    fetchSpy.mockRestore();
  });

  it("scheduled posts get no workflow and are published by the cron when due", async () => {
    const res = await call(ON, demo, "/api/posts", {
      body: { scheduledAt: Date.now() + 60 * 60 * 1000, posts: [{ accountId: "acc_demo_x", content: "Later" }] },
    });
    expect(res.status).toBe(201);
    const id = res.json[0].id;
    expect(res.json[0].status).toBe("scheduled");
    await DB.prepare("UPDATE posts SET scheduled_at = ? WHERE id = ?").bind(Date.now() - 1000, id).run();
    await cron(ON);
    const post = (await call(ON, demo, `/api/posts/${id}`)).json;
    expect(post.status).toBe("published");
    expect(post.externalUrl).toMatch(/^https:\/\/example\.com\/demo\/x\//);
  });

  it("retrying the failed post is simulated", async () => {
    const failed = (await call(ON, demo, "/api/posts?status=failed")).json[0];
    const res = await call(ON, demo, `/api/posts/${failed.id}/retry`, { method: "POST", wait: true });
    expect(res.status).toBe(200);
    expect((await call(ON, demo, `/api/posts/${failed.id}`)).json.status).toBe("published");
  });

  it("the publish workflow never calls a provider for a demo post", async () => {
    const draft = (await call(ON, demo, "/api/posts?status=draft")).json[0];
    // Even if a workflow were started for a demo post, it simulates.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await DB.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, revision = 7 WHERE id = ?").bind(Date.now(), draft.id).run();
    const { PublishWorkflow } = await import("../../worker/workflow");
    const wf = Object.create(PublishWorkflow.prototype) as InstanceType<typeof PublishWorkflow>;
    (wf as any).env = ON;
    const step = {
      do: async (_name: string, a: any, b?: any) => (typeof a === "function" ? a() : b()),
      sleep: async () => {},
      sleepUntil: async () => {},
    };
    const result = await wf.run({ payload: { postId: draft.id, revision: 7 }, timestamp: new Date(), instanceId: "x" } as any, step as any);
    expect(result).toMatchObject({ published: true, simulated: true });
    expect((await call(ON, demo, `/api/posts/${draft.id}`)).json.status).toBe("published");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("dynamic options are a small fake list", async () => {
    const boards = (await call(ON, demo, "/api/accounts/acc_demo_pin/options/board")).json;
    expect(boards.length).toBeGreaterThan(1);
    expect(boards[0]).toMatchObject({ value: "demo-board-1" });
    const privacy = (await call(ON, demo, "/api/accounts/acc_demo_tt/options/privacy_level")).json;
    expect(privacy.map((o: any) => o.value)).toContain("PUBLIC_TO_EVERYONE");
  });

  it("caps the posts visitors create per day", async () => {
    // Pretend visitors already created the daily maximum.
    await DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO posts (id, group_id, account_id, status, content, created_at, updated_at, workspace_id, created_by)
       SELECT 'pst_cap_' || i, 'grp_cap', 'acc_demo_x', 'draft', 'x', ?, ?, 'ws_demo', 'usr_demo' FROM n`,
    )
      .bind(DEMO_POSTS_PER_DAY, Date.now(), Date.now())
      .run();
    const res = await call(ON, demo, "/api/posts", { body: { scheduledAt: null, posts: [{ accountId: "acc_demo_x", content: "One more" }] } });
    expect(res.status).toBe(429);
    expect(res.json.error).toMatch(/resets daily/);
    await DB.prepare("DELETE FROM posts WHERE group_id = 'grp_cap'").run();
  });
});

describe("daily reset", () => {
  it("replaces everything in the demo workspace once the last reset is over a day old", async () => {
    const seedCount = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE workspace_id = 'ws_demo' AND created_by IS NULL"))!.n;
    const visitor = await call(ON, demo, "/api/posts", { body: { scheduledAt: null, posts: [{ accountId: "acc_demo_x", content: "Visitor draft" }] } });
    expect(visitor.status).toBe(201);

    // Not due yet: nothing happens.
    await cron(ON);
    expect(await one("SELECT id FROM posts WHERE id = ?", visitor.json[0].id)).not.toBeNull();

    // Due, but the demo is off: nothing happens.
    const old = Date.now() - 25 * 60 * 60 * 1000;
    await DB.prepare("UPDATE settings SET value = ? WHERE key = 'demo_reset_at'").bind(String(old)).run();
    await cron(OFF);
    expect(await one("SELECT id FROM posts WHERE id = ?", visitor.json[0].id)).not.toBeNull();

    await cron(ON);
    expect(await one("SELECT id FROM posts WHERE id = ?", visitor.json[0].id)).toBeNull();
    const total = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE workspace_id = 'ws_demo'"))!.n;
    expect(total).toBe(seedCount);
    // Analytics are replaced too (no snapshots left over from deleted posts).
    expect(await one("SELECT id FROM post_metrics WHERE post_id NOT IN (SELECT id FROM posts)")).toBeNull();
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM account_metrics WHERE workspace_id = 'ws_demo'"))!.n).toBeGreaterThan(100);
    expect(Number((await one<{ value: string }>("SELECT value FROM settings WHERE key = 'demo_reset_at'"))!.value)).toBeGreaterThan(old);
    // Visitors keep their session across resets.
    expect((await call(ON, demo, "/api/me")).status).toBe(200);
    expect((await call(ON, demo, "/api/media")).json).toHaveLength(8);
  });

  it("demo sessions stop working when the demo is turned off", async () => {
    expect((await call(OFF, demo, "/api/me")).status).toBe(401);
    expect((await call(OFF, demo, "/api/auth/status")).json).toMatchObject({ authenticated: false });
    expect((await call(ON, demo, "/api/me")).status).toBe(200);
  });
});
