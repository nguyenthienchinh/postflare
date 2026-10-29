import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { saveConnectedAccounts } from "../../worker/lib/accounts";
import { createApiKey } from "../../worker/lib/auth";
import { encryptJson, hashPassword } from "../../worker/lib/crypto";
import { demoAccountMetrics, demoPostMetrics } from "../../worker/lib/demo-metrics";
import { CHECKPOINTS, MAX_POST_FAILS, collectMetrics, expireMetricsSchedules, nextCheckpoint, utcDay } from "../../worker/lib/metrics";
import { getProvider } from "../../worker/providers/registry";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// Own D1 instance (ANALYTICS_DB): posts and metrics are seeded directly, provider APIs are mocked on globalThis.fetch.

const DB = env.ANALYTICS_DB;
const E = { ...env, DB, DEMO_MODE: "false" } as unknown as Env;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
  return { status: res.status, json, text, headers: res.headers };
}

const one = <T>(sql: string, ...binds: unknown[]) => DB.prepare(sql).bind(...binds).first<T>();
const run = (sql: string, ...binds: unknown[]) => DB.prepare(sql).bind(...binds).run();

let owner: Client;
let viewer: Client;
let other: Client;
const T0 = Date.now();

async function user(id: string, email: string) {
  const t = Date.now();
  await run(
    "INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'role_instance_member', 'active', ?, ?)",
    id,
    email,
    id,
    await hashPassword("password123"),
    t,
    t,
  );
}

async function login(email: string, ws: string): Promise<Client> {
  const res = await call(null, "/api/auth/login", { body: { email, password: "password123" }, headers: { "cf-connecting-ip": `10.9.${email.length}.1` } });
  expect(res.status, res.text).toBe(200);
  return { cookie: sessionCookie(res.headers)!, ws };
}

async function account(id: string, ws: string, provider: string, externalId: string, credentials: Record<string, unknown>, extra: { status?: string; meta?: unknown } = {}) {
  await run(
    `INSERT INTO accounts (id, provider, external_id, name, username, credentials_enc, expires_at, meta, status, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
    id,
    provider,
    externalId,
    `${provider} ${id}`,
    await encryptJson(E, credentials),
    JSON.stringify(extra.meta ?? {}),
    extra.status ?? "active",
    T0,
    T0,
    ws,
  );
}

async function post(id: string, ws: string, accountId: string, publishedAt: number, opts: { metrics?: unknown; nextAt?: number | null; externalId?: string } = {}) {
  await run(
    `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, settings, thread, external_id, external_url, attempts, revision, created_at, updated_at, published_at, workspace_id, metrics, metrics_at, metrics_next_at)
     VALUES (?, ?, ?, 'published', ?, ?, '["med_1"]', '{}', '[]', ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    `grp_${id}`,
    accountId,
    publishedAt,
    `Content of ${id}`,
    opts.externalId ?? `ext_${id}`,
    `https://example.com/${id}`,
    publishedAt,
    publishedAt,
    publishedAt,
    ws,
    opts.metrics ? JSON.stringify(opts.metrics) : null,
    opts.metrics ? publishedAt + HOUR : null,
    opts.nextAt ?? null,
  );
}

/** Mock of the YouTube Data API: videos.list (all ids except "gone") and channels.list; token NOSCOPE lacks youtube.readonly. */
function mockProviders() {
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    calls.push(req.url);
    const url = new URL(req.url);
    if (req.headers.get("authorization") === "Bearer NOSCOPE") {
      return Response.json(
        { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" } },
        { status: 403 },
      );
    }
    if (url.pathname === "/youtube/v3/videos") {
      const ids = url.searchParams.get("id")!.split(",").filter((id) => !id.includes("gone"));
      return Response.json({ items: ids.map((id) => ({ id, statistics: { viewCount: "100", likeCount: "7", commentCount: "2", favoriteCount: "0" } })) });
    }
    if (url.host === "youtubeanalytics.googleapis.com") {
      const dims = url.searchParams.get("dimensions") ?? "";
      const ids = url.searchParams.get("filters")!.replace("video==", "").split(",");
      const table = (names: string[], rows: unknown[][]) => Response.json({ columnHeaders: names.map((name) => ({ name })), rows });
      if (dims.includes("elapsedVideoTimeRatio")) return table(["elapsedVideoTimeRatio", "audienceWatchRatio"], Array.from({ length: 100 }, (_, i) => [(i + 1) / 100, 0.9 - i / 200]));
      if (dims.includes("insightTrafficSourceType")) return table(["insightTrafficSourceType", "views"], [["YT_SEARCH", 30], ["RELATED_VIDEO", 70]]);
      return table(["estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "shares"], ids.length === 1 ? [[321, 95, 47.5, 4]] : []);
    }
    if (url.pathname === "/youtube/v3/channels") {
      return Response.json({ items: [{ id: url.searchParams.get("id"), statistics: { subscriberCount: "1234", videoCount: "12", viewCount: "99999", hiddenSubscriberCount: false } }] });
    }
    return Response.json({ error: `unexpected ${req.url}` }, { status: 500 });
  });
  return { calls, spy, videoCalls: () => calls.filter((u) => u.includes("/youtube/v3/videos")) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeAll(async () => {
  await call(null, "/api/auth/status"); // applies migrations
  const t = Date.now();
  await user("usr_an_owner", "an-owner@example.com");
  await user("usr_an_viewer", "an-viewer@example.com");
  await user("usr_an_other", "an-other@example.com");
  await DB.batch([
    DB.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws_an_a', 'A', ?, ?), ('ws_an_b', 'B', ?, ?)").bind(t, t, t, t),
    DB.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES ('ws_an_a', 'usr_an_owner', 'role_ws_owner', ?), ('ws_an_a', 'usr_an_viewer', 'role_ws_viewer', ?), ('ws_an_b', 'usr_an_other', 'role_ws_owner', ?)",
    ).bind(t, t, t),
  ]);
  owner = await login("an-owner@example.com", "ws_an_a");
  viewer = await login("an-viewer@example.com", "ws_an_a");
  other = await login("an-other@example.com", "ws_an_b");
});

describe("schedule", () => {
  it("collects ~1h, 24h, 3d, 7d, 30d after publishing, then weekly until 90 days", () => {
    const p = 1_000_000;
    const seq: number[] = [];
    for (let t = p, n = nextCheckpoint(p, t); n !== null; t = n, n = nextCheckpoint(p, t)) seq.push((n - p) / DAY);
    expect(seq).toEqual([1 / 24, 1, 3, 7, 30, 37, 44, 51, 58, 65, 72, 79, 86, 90]);
    expect(nextCheckpoint(p, p + 90 * DAY)).toBeNull();
    // Catch-up: a late collection plans the next checkpoint after now, not the missed ones.
    expect(nextCheckpoint(p, p + 10 * DAY)).toBe(p + 30 * DAY);
    expect(CHECKPOINTS.length).toBe(14);
  });
});

describe("summary math and scoping", () => {
  const from = T0 - 10 * DAY;
  const to = T0;
  beforeAll(async () => {
    await account("acc_an_yt", "ws_an_a", "youtube", "UC_A", { accessToken: "AT" }, { meta: { channelId: "UC_A" } });
    await account("acc_an_x", "ws_an_a", "x", "X_A", { accessToken: "AT" });
    await account("acc_an_hook", "ws_an_a", "webhook", "hook", { url: "https://hooks.example.com" });
    await account("acc_an_b", "ws_an_b", "youtube", "UC_B", { accessToken: "AT" });
    await post("p1", "ws_an_a", "acc_an_yt", from + 1 * DAY, { metrics: { views: 1000, likes: 50, comments: 10, extra: { favorites: 3 } } });
    await post("p2", "ws_an_a", "acc_an_x", from + 2 * DAY, { metrics: { impressions: 2000, likes: 30, replies: 5, reposts: 5 } });
    await post("p3", "ws_an_a", "acc_an_yt", from - 3 * DAY, { metrics: { views: 500, likes: 5 } });
    await post("p4", "ws_an_a", "acc_an_hook", from + 3 * DAY);
    await post("pb", "ws_an_b", "acc_an_b", from + 1 * DAY, { metrics: { views: 777, likes: 1 } });
    const am = (acc: string, ws: string, t: number, followers: number) =>
      run("INSERT INTO account_metrics (account_id, workspace_id, day, captured_at, metrics) VALUES (?, ?, ?, ?, ?)", acc, ws, utcDay(t), t, JSON.stringify({ followers }));
    await am("acc_an_yt", "ws_an_a", from - 2 * DAY, 100);
    await am("acc_an_yt", "ws_an_a", to - DAY, 150);
    await am("acc_an_x", "ws_an_a", from + 3 * DAY, 40); // connected during the period
    await am("acc_an_x", "ws_an_a", to - 1, 60);
    await am("acc_an_b", "ws_an_b", to - 1, 9999);
    await run("INSERT INTO post_metrics (post_id, workspace_id, captured_at, metrics) VALUES ('p1', 'ws_an_a', ?, '{\"views\":400}'), ('p1', 'ws_an_a', ?, '{\"views\":1000}')", from + DAY + HOUR, from + 2 * DAY);
  });

  it("totals, engagement rate, previous period and followers", async () => {
    const res = await call(owner, `/api/analytics/summary?from=${from}&to=${to}&tz=UTC`);
    expect(res.status, res.text).toBe(200);
    const s = res.json;
    expect(s.totals).toEqual({
      posts: 3,
      postsWithMetrics: 2,
      views: 1000,
      impressions: 2000,
      reach: 0,
      engagements: 100, // (50 + 10) + (30 + 5 + 5)
      likes: 80,
      comments: 10,
      shares: 0,
      saves: 0,
      watchTimeMinutes: 0,
      engagementRate: 100 / 3000, // exposure: views of p1, impressions of p2
      followers: 210, // 150 + 60
      followersChange: 70, // (150 - 100) + (60 - 40)
      // No tracked App Store links in this workspace.
      campaignPosts: 0,
      clicks: 0,
      downloads: 0,
      redownloads: 0,
      proceeds: 0,
    });
    expect(s.previous).toMatchObject({ posts: 1, views: 500, engagements: 5, engagementRate: 5 / 500, followers: 100, followersChange: 0 });
    expect(s.tz).toBe("UTC");
  });

  it("daily series (publish-day attribution), breakdowns and follower series", async () => {
    const s = (await call(owner, `/api/analytics/summary?from=${from}&to=${to}&tz=UTC`)).json;
    expect(s.daily.length).toBe(11);
    expect(s.daily.reduce((n: number, d: any) => n + d.posts, 0)).toBe(3);
    expect(s.daily.find((d: any) => d.day === utcDay(from + DAY))).toEqual({ day: utcDay(from + DAY), posts: 1, views: 1000, engagements: 60, likes: 50, comments: 10, shares: 0 });
    expect(s.daily.find((d: any) => d.day === utcDay(from + 2 * DAY))).toMatchObject({ posts: 1, views: 2000, engagements: 40 });
    const yt = s.byProvider.find((p: any) => p.provider === "youtube");
    expect(yt).toMatchObject({ key: "youtube", name: "YouTube", posts: 1, views: 1000, followers: 150, followersChange: 50 });
    expect(s.byProvider.find((p: any) => p.provider === "webhook")).toMatchObject({ posts: 1, postsWithMetrics: 0, engagementRate: null });
    expect(s.byAccount.map((a: any) => a.accountId).sort()).toEqual(["acc_an_hook", "acc_an_x", "acc_an_yt"]);
    expect(s.followers.find((f: any) => f.accountId === "acc_an_yt").points).toEqual([{ day: utcDay(to - DAY), followers: 150 }]);
    // Filters.
    const onlyX = (await call(owner, `/api/analytics/summary?from=${from}&to=${to}&provider=x`)).json;
    expect(onlyX.totals).toMatchObject({ posts: 1, impressions: 2000, followers: 60 });
    const onlyYt = (await call(owner, `/api/analytics/summary?from=${from}&to=${to}&accountId=acc_an_yt`)).json;
    expect(onlyYt.totals).toMatchObject({ posts: 1, views: 1000 });
  });

  it("days follow the requested timezone", async () => {
    const s = (await call(owner, `/api/analytics/summary?from=${from}&to=${to}&tz=Pacific/Kiritimati`)).json; // UTC+14
    expect(s.tz).toBe("Pacific/Kiritimati");
    expect(s.daily.reduce((n: number, d: any) => n + d.posts, 0)).toBe(3);
    expect(s.daily.find((d: any) => d.posts === 1 && d.views === 1000).day).toBe(utcDay(from + DAY + 14 * HOUR));
  });

  it("validates the range", async () => {
    expect((await call(owner, `/api/analytics/summary?from=${to}&to=${from}`)).status).toBe(400);
    expect((await call(owner, `/api/analytics/summary?from=${to - 400 * DAY}&to=${to}`)).status).toBe(400);
    expect((await call(owner, "/api/analytics/summary?from=yesterday")).status).toBe(400);
    expect((await call(owner, "/api/analytics/posts?sort=random")).status).toBe(400);
  });

  it("lists posts with their latest metrics, sorted", async () => {
    const list = async (sort: string) => (await call(owner, `/api/analytics/posts?from=${from}&to=${to}&sort=${sort}`)).json as any[];
    expect((await list("views")).map((p) => p.id)).toEqual(["p2", "p1", "p4"]);
    expect((await list("engagements")).map((p) => p.id)).toEqual(["p1", "p2", "p4"]);
    expect((await list("engagementRate")).map((p) => p.id)).toEqual(["p1", "p2", "p4"]);
    expect((await list("publishedAt")).map((p) => p.id)).toEqual(["p4", "p2", "p1"]);
    const p1 = (await list("views")).find((p) => p.id === "p1");
    expect(p1).toMatchObject({
      accountId: "acc_an_yt",
      provider: "youtube",
      excerpt: "Content of p1",
      media: ["med_1"],
      externalUrl: "https://example.com/p1",
      metrics: { views: 1000, likes: 50, comments: 10, extra: { favorites: 3 } },
      engagements: 60,
      engagementRate: 0.06,
    });
    const limited = (await call(owner, `/api/analytics/posts?from=${from}&to=${to}&sort=views&limit=1&offset=1`)).json;
    expect(limited.map((p: any) => p.id)).toEqual(["p1"]);
  });

  it("returns the snapshot series of a post", async () => {
    const res = await call(owner, "/api/posts/p1/metrics");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ postId: "p1", metrics: { views: 1000 }, snapshots: [{ metrics: { views: 400 } }, { metrics: { views: 1000 } }] });
  });

  it("is scoped to the workspace", async () => {
    const b = (await call(other, `/api/analytics/summary?from=${from}&to=${to}`)).json;
    expect(b.totals).toMatchObject({ posts: 1, views: 777, followers: 9999 });
    expect(b.byAccount.map((a: any) => a.accountId)).toEqual(["acc_an_b"]);
    expect((await call(other, `/api/analytics/posts?from=${from}&to=${to}&accountId=acc_an_yt`)).json).toEqual([]);
    expect((await call(other, `/api/analytics/summary?from=${from}&to=${to}&accountId=acc_an_yt`)).json.totals.posts).toBe(0);
    expect((await call(other, "/api/posts/p1/metrics")).status).toBe(404);
    expect((await call(other, "/api/analytics/refresh", { body: { postId: "p1" } })).status).toBe(404);
    expect((await call(other, "/api/analytics/refresh", { body: { accountId: "acc_an_yt" } })).status).toBe(404);
    // Workspace A asked for by a non-member.
    expect((await call({ ...other, ws: "ws_an_a" }, "/api/analytics/summary")).status).toBeGreaterThanOrEqual(400);
  });

  it("needs posts.read to read and posts.write to refresh", async () => {
    expect((await call(viewer, `/api/analytics/summary?from=${from}&to=${to}`)).status).toBe(200);
    expect((await call(viewer, "/api/posts/p1/metrics")).status).toBe(200);
    expect((await call(viewer, "/api/analytics/refresh", { body: { postId: "p1" } })).status).toBe(403);
    expect((await call(owner, "/api/analytics/refresh", { body: {} })).status).toBe(400);
  });

  it("exposes the analytics status of accounts and the capabilities of platforms", async () => {
    const accounts = (await call(owner, "/api/accounts")).json as any[];
    expect(accounts.find((a) => a.id === "acc_an_hook").metricsStatus).toMatchObject({ status: "not_supported" });
    expect(accounts.find((a) => a.id === "acc_an_yt").metricsStatus).toMatchObject({ status: "pending", metrics: null });
    const providers = (await call(owner, "/api/providers")).json as any[];
    expect(providers.find((p) => p.id === "youtube").analytics).toEqual({
      post: true,
      account: true,
      metrics: ["views", "likes", "comments", "shares", "watchTimeMinutes", "avgViewDurationSeconds", "avgViewPercentage", "followers", "posts"],
    });
    expect(providers.find((p) => p.id === "youtube").capabilities.mediaNote).toMatch(/custom thumbnail/);
    expect(providers.find((p) => p.id === "webhook").analytics).toEqual({ post: false, account: false, metrics: [] });
  });
});

describe("MCP analytics tools", () => {
  const from = T0 - 10 * DAY;
  const to = T0;
  let ownerKey: string;
  let viewerKey: string;
  const tool = async (key: string, name: string, args: unknown = {}) => {
    const res = await call({ key }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    expect(res.status, res.text).toBe(200);
    const r = res.json.result;
    return { error: r.isError ? (r.content[0].text as string) : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  beforeAll(async () => {
    ownerKey = (await call(owner, "/api/keys", { body: { name: "mcp" } })).json.token;
    // Viewers cannot create keys themselves (no apikeys.manage); a key keeps acting with its user's permissions.
    viewerKey = (await createApiKey(E, "mcp", "usr_an_viewer", "ws_an_a")).token;
  });

  it("lists the analytics tools and mentions them in the instructions", async () => {
    const list = await call({ key: ownerKey }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const names = list.json.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_analytics_summary", "get_top_posts", "get_post_metrics", "refresh_metrics"]));
    const init = await call({ key: ownerKey }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    expect(init.json.result.instructions).toContain("get_analytics_summary");
  });

  it("get_analytics_summary: compact totals, rate in %, deltas, no empty arrays", async () => {
    const { data, error } = await tool(ownerKey, "get_analytics_summary", { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    expect(error).toBeNull();
    expect(data.range).toEqual({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), tz: "UTC" });
    expect(data.totals).toEqual({
      posts: 3,
      postsWithMetrics: 2,
      views: 1000,
      impressions: 2000,
      engagements: 100,
      likes: 80,
      comments: 10,
      engagementRatePct: 3.33,
      followers: 210,
      followersChange: 70,
    });
    expect(data.previousPeriod).toMatchObject({ posts: 1, views: 500, engagementRatePct: 1 });
    expect(data.change).toMatchObject({ posts: "+2 (+200%)", views: "+500 (+100%)", engagementRatePct: "+2.33 pts" });
    expect(data.byProvider.find((p: any) => p.provider === "youtube")).toMatchObject({ name: "YouTube", posts: 1, views: 1000, engagementRatePct: 6 });
    expect(data.byAccount.find((a: any) => a.accountId === "acc_an_x")).toMatchObject({ provider: "x", impressions: 2000, followers: 60 });
    expect(data.daily).toHaveLength(3); // only days with posts
    expect(data.followers.find((f: any) => f.accountId === "acc_an_yt")).toMatchObject({ start: 150, end: 150, change: 0 });
    // Relative range + filter.
    const rel = await tool(ownerKey, "get_analytics_summary", { from: "30d", provider: "x" });
    expect(rel.data.totals).toMatchObject({ posts: 1, impressions: 2000 });
    expect((await tool(ownerKey, "get_analytics_summary", { from: "last week" })).error).toContain("Invalid from");
  });

  it("get_top_posts: sorted compact rows, limit capped at 50", async () => {
    const { data } = await tool(ownerKey, "get_top_posts", { from: new Date(from).toISOString(), to: new Date(to).toISOString(), sort: "engagements", limit: 500 });
    expect(data.map((p: any) => p.id)).toEqual(["p1", "p2", "p4"]);
    expect(data[0]).toEqual({
      id: "p1",
      accountId: "acc_an_yt",
      account: "youtube acc_an_yt",
      provider: "youtube",
      publishedAt: new Date(from + DAY).toISOString(),
      excerpt: "Content of p1",
      url: "https://example.com/p1",
      views: 1000,
      engagements: 60,
      engagementRatePct: 6,
      metrics: { views: 1000, likes: 50, comments: 10 },
      metricsAt: new Date(from + DAY + HOUR).toISOString(),
    });
    expect(data[2]).toMatchObject({ id: "p4", note: "no metrics collected yet" });
    expect(data[2].views).toBeUndefined();
    const one = await tool(ownerKey, "get_top_posts", { from: "30d", sort: "views", limit: 1 });
    expect(one.data.map((p: any) => p.id)).toEqual(["p2"]);
  });

  it("get_post_metrics: latest metrics and snapshot series; scoped to the key's workspace", async () => {
    const { data } = await tool(viewerKey, "get_post_metrics", { id: "p1" });
    expect(data).toMatchObject({ postId: "p1", metrics: { views: 1000 }, engagements: 60, engagementRatePct: 6 });
    expect(data.snapshots.map((s: any) => s.views)).toEqual([400, 1000]);
    expect(data.snapshots[0].at).toBe(new Date(from + DAY + HOUR).toISOString());
    expect((await tool(viewerKey, "get_post_metrics", { id: "pb" })).error).toBe("Not found");
    expect(data.details).toBeUndefined();
    // YouTube details (retention, traffic sources) of the latest snapshot that has them.
    const at = from + 9 * DAY;
    const details = { retention: [[0.5, 0.42]], trafficSources: [{ source: "YT_SEARCH", views: 12 }] };
    await run("INSERT INTO post_metrics (post_id, workspace_id, captured_at, metrics) VALUES ('p1', 'ws_an_a', ?, ?)", at, JSON.stringify({ views: 1000, details }));
    const withDetails = (await tool(viewerKey, "get_post_metrics", { id: "p1" })).data;
    expect(withDetails.details).toEqual(details);
    expect(withDetails.detailsAt).toBe(new Date(at).toISOString());
    expect(withDetails.snapshots.at(-1).details).toBeUndefined();
    await run("DELETE FROM post_metrics WHERE post_id = 'p1' AND captured_at = ?", at);
  });

  it("get_post_metrics accepts real post ids, `postId` and string arguments (regression: \"Invalid id\")", async () => {
    const id = "pst_JigXPHc1GeGPQqD2-x";
    await post(id, "ws_an_a", "acc_an_x", from - 50 * DAY, { metrics: { impressions: 10, likes: 1 } });
    try {
      for (const args of [{ id }, { postId: id }, { id: ` ${id} ` }, JSON.stringify({ id })]) {
        const r = await tool(viewerKey, "get_post_metrics", args);
        expect(r.error, JSON.stringify(args)).toBeNull();
        expect(r.data).toMatchObject({ postId: id, metrics: { impressions: 10 } });
      }
      expect((await tool(viewerKey, "get_post", { postId: id })).data).toMatchObject({ id });
      expect((await tool(viewerKey, "get_post_metrics", {})).error).toMatch(/^Missing id/);
      expect((await tool(viewerKey, "get_post_metrics", { id: { x: 1 } })).error).toMatch(/^Invalid id/);
      expect((await tool(viewerKey, "get_post_metrics", { id: ".." })).error).toMatch(/^Invalid id/);
    } finally {
      await run("DELETE FROM posts WHERE id = ?", id);
    }
  });

  it("list_accounts filters by platform id and documented aliases (regression: filter was ignored)", async () => {
    const ids = async (args: Record<string, unknown>) => (await tool(viewerKey, "list_accounts", args)).data.map((a: any) => a.id).sort();
    expect(await ids({ platform: "youtube" })).toEqual(["acc_an_yt"]);
    expect(await ids({ platform: "X" })).toEqual(["acc_an_x"]);
    expect(await ids({ platform: "twitter" })).toEqual(["acc_an_x"]);
    expect(await ids({ platform: "yt, webhook" })).toEqual(["acc_an_hook", "acc_an_yt"]);
    expect(await ids({ platform: "instagram" })).toEqual([]);
    expect(await ids({ platform: "" })).toEqual(["acc_an_hook", "acc_an_x", "acc_an_yt"]);
    expect(await ids({ platform: "x", group: "none" })).toEqual(["acc_an_x"]);
    const list = await call({ key: viewerKey }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const schema = list.json.result.tools.find((t: any) => t.name === "list_accounts").inputSchema;
    expect(schema.properties.platform.description).toContain("twitter");
  });

  it("refresh_metrics needs posts.write and exactly one target", async () => {
    expect((await tool(ownerKey, "refresh_metrics", {})).error).toContain("either postId or accountId");
    expect((await tool(viewerKey, "refresh_metrics", { postId: "p1" })).error).toMatch(/permission/i);
    expect((await tool(ownerKey, "refresh_metrics", { postId: "pb" })).error).toBe("Not found");
  });

  it("list_accounts is compact with followers and analytics status", async () => {
    await run("UPDATE accounts SET metrics = '{\"followers\":150}', metrics_status = 'ok' WHERE id = 'acc_an_yt'");
    const { data } = await tool(viewerKey, "list_accounts");
    expect(data.find((a: any) => a.id === "acc_an_yt")).toEqual({ id: "acc_an_yt", provider: "youtube", name: "youtube acc_an_yt", status: "active", followers: 150, analytics: "ok" });
    expect(data.find((a: any) => a.id === "acc_an_hook")).toMatchObject({ analytics: "not_supported" });
    expect(data.some((a: any) => a.id === "acc_an_b")).toBe(false);
    await run("UPDATE accounts SET metrics = NULL, metrics_status = NULL WHERE id = 'acc_an_yt'");
  });
});

describe("collection", () => {
  const now = Date.now();
  beforeAll(async () => {
    // Earlier fixtures are not due (no metrics_next_at); these are.
    await account("acc_c_yt", "ws_an_b", "youtube", "UC_C", { accessToken: "AT" }, { meta: { channelId: "UC_C" } });
    for (let i = 0; i < 59; i++) await post(`c${String(i).padStart(2, "0")}`, "ws_an_b", "acc_c_yt", now - 2 * HOUR, { nextAt: now - HOUR + i, externalId: `vid${i}` });
    await post("c_gone", "ws_an_b", "acc_c_yt", now - 2 * HOUR, { nextAt: now - HOUR + 100, externalId: "gone1" });
    await post("c_future", "ws_an_b", "acc_c_yt", now - 2 * HOUR, { nextAt: now + HOUR, externalId: "vid_future" });
    await post("c_old", "ws_an_b", "acc_c_yt", now - 100 * DAY, { nextAt: now - DAY, externalId: "vid_old" });
    await account("acc_c_dis", "ws_an_b", "youtube", "UC_DIS", { accessToken: "AT" }, { status: "disabled" });
    await post("c_dis", "ws_an_b", "acc_c_dis", now - 2 * HOUR, { nextAt: now - HOUR, externalId: "vid_dis" });
    // Account metrics of the other fixtures are due too: keep them out of these counts.
    await run("UPDATE accounts SET metrics_next_at = ? WHERE id IN ('acc_an_yt', 'acc_an_x', 'acc_an_b')", now + DAY);
  });

  it("batches by account, stops at the fetch budget and keeps the rest due", async () => {
    const m = mockProviders();
    const stats = await collectMetrics(E, { budget: 1 });
    // Budget 1: no account metrics (they need headroom), one videos.list call with the first 50 due posts.
    expect(m.calls).toHaveLength(1);
    expect(m.videoCalls()).toHaveLength(1);
    expect(new URL(m.calls[0]).searchParams.get("id")!.split(",")).toHaveLength(50);
    expect(stats).toMatchObject({ posts: 50, budgetLeft: 0 });
    const c0 = await one<any>("SELECT metrics, metrics_at, metrics_next_at, metrics_fails FROM posts WHERE id = 'c00'");
    expect(JSON.parse(c0.metrics)).toEqual({ views: 100, likes: 7, comments: 2, extra: { favorites: 0 } });
    // Published 2h ago: next checkpoint is 24h after publishing.
    expect(c0.metrics_next_at).toBe(now - 2 * HOUR + DAY);
    expect((await one<any>("SELECT COUNT(*) AS n FROM post_metrics WHERE post_id = 'c00'")).n).toBe(1);
    expect((await one<any>("SELECT COUNT(*) AS n FROM posts WHERE account_id = 'acc_c_yt' AND id != 'c_old' AND metrics_next_at <= ?", Date.now())).n).toBe(10);
    // Too old: not collected; the daily job stops planning it.
    expect((await one<any>("SELECT metrics_next_at FROM posts WHERE id = 'c_old'")).metrics_next_at).not.toBeNull();
    expect(await expireMetricsSchedules(E)).toBeGreaterThanOrEqual(1);
    expect((await one<any>("SELECT metrics_next_at FROM posts WHERE id = 'c_old'")).metrics_next_at).toBeNull();
  });

  it("collects the rest and the account metrics on the next tick; unknown posts back off", async () => {
    const m = mockProviders();
    const stats = await collectMetrics(E);
    expect(m.videoCalls()).toHaveLength(1);
    expect(m.calls.filter((u) => u.includes("/channels"))).toHaveLength(1); // acc_c_yt (the others are not due, acc_c_dis is disabled)
    expect(stats.posts).toBe(9);
    const gone = await one<any>("SELECT metrics, metrics_next_at, metrics_fails FROM posts WHERE id = 'c_gone'");
    expect(gone.metrics).toBeNull();
    expect(gone.metrics_fails).toBe(1);
    expect(gone.metrics_next_at).toBeGreaterThan(Date.now() + HOUR - 60_000);
    // Not due yet / disabled account: untouched.
    expect((await one<any>("SELECT metrics FROM posts WHERE id = 'c_future'")).metrics).toBeNull();
    expect((await one<any>("SELECT metrics FROM posts WHERE id = 'c_dis'")).metrics).toBeNull();
    expect(m.calls.some((u) => u.includes("vid_future") || u.includes("vid_dis"))).toBe(false);
    const acc = await one<any>("SELECT metrics, metrics_status, metrics_next_at FROM accounts WHERE id = 'acc_c_yt'");
    expect(JSON.parse(acc.metrics)).toEqual({ followers: 1234, posts: 12, extra: { channel_views: 99999 } });
    expect(acc.metrics_status).toBe("ok");
    expect(acc.metrics_next_at).toBeGreaterThan(Date.now());
    expect(await one<any>("SELECT day FROM account_metrics WHERE account_id = 'acc_c_yt'")).toEqual({ day: utcDay(Date.now()) });
  });

  it("gives up on a post after repeated failures", async () => {
    await run("UPDATE posts SET metrics_fails = ?, metrics_next_at = ? WHERE id = 'c_gone'", MAX_POST_FAILS - 1, Date.now() - 1);
    mockProviders();
    await collectMetrics(E);
    expect(await one<any>("SELECT metrics_fails, metrics_next_at FROM posts WHERE id = 'c_gone'")).toEqual({ metrics_fails: MAX_POST_FAILS, metrics_next_at: null });
  });

  it("a missing analytics scope blocks analytics only, until the account is reconnected", async () => {
    await account("acc_c_noscope", "ws_an_b", "youtube", "UC_NS", { accessToken: "NOSCOPE" }, { meta: { channelId: "UC_NS" } });
    await post("c_ns", "ws_an_b", "acc_c_noscope", Date.now() - 2 * HOUR, { nextAt: Date.now() - 1, externalId: "vid_ns" });
    let m = mockProviders();
    await collectMetrics(E);
    const acc = await one<any>("SELECT status, metrics_status, metrics_message, metrics_next_at FROM accounts WHERE id = 'acc_c_noscope'");
    expect(acc.status).toBe("active"); // publishing is not affected
    expect(acc.metrics_status).toBe("reconnect_required");
    expect(acc.metrics_message).toContain("youtube.readonly");
    expect(acc.metrics_next_at).toBeGreaterThan(Date.now() + 6 * DAY);
    // The post is not penalised, just skipped while the account is blocked.
    expect(await one<any>("SELECT metrics_fails, metrics_next_at <= ? AS due FROM posts WHERE id = 'c_ns'", Date.now())).toEqual({ metrics_fails: 0, due: 1 });
    const dto = (await call(other, "/api/accounts")).json.find((a: any) => a.id === "acc_c_noscope");
    expect(dto).toMatchObject({ status: "active", metricsStatus: { status: "reconnect_required" } });
    m.spy.mockClear();
    m = mockProviders();
    await collectMetrics(E);
    expect(m.calls.filter((u) => u.includes("vid_ns"))).toHaveLength(0);

    // Reconnect with a token that has the scope: analytics resume.
    await saveConnectedAccounts(E, "youtube", [{ externalId: "UC_NS", name: "NS", credentials: { accessToken: "AT" }, meta: { channelId: "UC_NS" } }], {
      workspaceId: "ws_an_b",
      userId: "usr_an_other",
    });
    expect((await one<any>("SELECT metrics_status FROM accounts WHERE id = 'acc_c_noscope'")).metrics_status).toBeNull();
    m = mockProviders();
    await collectMetrics(E);
    expect(JSON.parse((await one<any>("SELECT metrics FROM posts WHERE id = 'c_ns'")).metrics)).toMatchObject({ views: 100 });
    expect((await one<any>("SELECT metrics_status FROM accounts WHERE id = 'acc_c_noscope'")).metrics_status).toBe("ok");
  });

  it("YouTube Analytics: watch time in posts.metrics, retention + traffic sources only in the snapshot and the post's metrics DTO", async () => {
    const t = Date.now();
    await account("acc_c_yta", "ws_an_b", "youtube", "UC_YTA", { accessToken: "AT" }, { meta: { channelId: "UC_YTA" } });
    await post("c_week", "ws_an_b", "acc_c_yta", t - 7 * DAY - HOUR, { nextAt: t - 1, externalId: "vid_week" });
    const m = mockProviders();
    await collectMetrics(E, { posts: 10, accounts: 0 });
    // videos.list + watch-time report + traffic sources + retention
    expect(m.calls.filter((u) => u.includes("vid_week"))).toHaveLength(4);
    const row = await one<any>("SELECT metrics FROM posts WHERE id = 'c_week'");
    expect(JSON.parse(row.metrics)).toEqual({
      views: 100,
      likes: 7,
      comments: 2,
      shares: 4,
      watchTimeMinutes: 321,
      avgViewDurationSeconds: 95,
      avgViewPercentage: 47.5,
      extra: { favorites: 0 },
    });
    const snap = JSON.parse((await one<any>("SELECT metrics FROM post_metrics WHERE post_id = 'c_week'")).metrics);
    expect(snap.details.retention).toHaveLength(100);
    expect(snap.details.trafficSources).toEqual([
      { source: "RELATED_VIDEO", views: 70 },
      { source: "YT_SEARCH", views: 30 },
    ]);
    // A later snapshot without details (e.g. the curve request did not fit): the DTO keeps the latest details.
    await run("INSERT INTO post_metrics (post_id, workspace_id, captured_at, metrics) VALUES ('c_week', 'ws_an_b', ?, '{\"views\":150}')", t + 2 * HOUR);
    const dto = (await call(other, "/api/posts/c_week/metrics")).json;
    expect(dto.metrics.watchTimeMinutes).toBe(321);
    expect(dto.details.trafficSources[0]).toEqual({ source: "RELATED_VIDEO", views: 70 });
    expect(dto.details.retention[0]).toEqual([0.01, 0.9]);
    expect(dto.detailsAt).toBeLessThan(t + HOUR);
    expect(dto.snapshots.map((s: any) => s.metrics.details)).toEqual([undefined, undefined]);
    expect(dto.snapshots.map((s: any) => s.metrics.views)).toEqual([100, 150]);
    // List endpoints never carry the curve.
    const list = (await call(other, `/api/analytics/posts?from=${t - 30 * DAY}&to=${t + DAY}&limit=200`)).json;
    expect(list.find((p: any) => p.id === "c_week").metrics.details).toBeUndefined();
  });

  it("manual refresh collects one post now (posts.write)", async () => {
    await run("UPDATE posts SET metrics_at = NULL, metrics = NULL WHERE id = 'c_future'");
    const m = mockProviders();
    const res = await call(other, "/api/analytics/refresh", { body: { postId: "c_future" } });
    expect(res.status, res.text).toBe(200);
    expect(res.json.post).toMatchObject({ id: "c_future", metrics: { views: 100 }, engagements: 9 });
    expect(m.videoCalls()).toHaveLength(1);
    // Within the cooldown: served from the database.
    const again = await call(other, "/api/analytics/refresh", { body: { postId: "c_future" } });
    expect(again.status).toBe(200);
    expect(m.videoCalls()).toHaveLength(1);
    const acc = await call(other, "/api/analytics/refresh", { body: { accountId: "acc_an_b" } });
    expect(acc.status, acc.text).toBe(200);
    expect(acc.json.account).toMatchObject({ id: "acc_an_b", metricsStatus: { status: "ok", metrics: { followers: 1234 } } });
  });
});

describe("demo workspace", () => {
  it("demo YouTube posts get watch time from 24h and a retention curve + traffic sources between 7 and 37 days", () => {
    const yt = getProvider("youtube")!;
    const p = { content: "demo video", published_at: 0 };
    const early = demoPostMetrics(yt, p, 2 * HOUR);
    expect(early.watchTimeMinutes).toBeUndefined();
    expect(early.details).toBeUndefined();
    const day3 = demoPostMetrics(yt, p, 3 * DAY);
    expect(day3.avgViewPercentage).toBeGreaterThan(0);
    expect(day3.avgViewPercentage).toBeLessThan(100);
    expect(day3.avgViewDurationSeconds).toBeGreaterThan(0);
    expect(day3.watchTimeMinutes).toBeGreaterThan(0);
    expect(day3.details).toBeUndefined();
    const week = demoPostMetrics(yt, p, 7 * DAY);
    expect(week.details!.retention).toHaveLength(100);
    expect(week.details!.trafficSources!.reduce((n, s) => n + s.views, 0)).toBeGreaterThan(0);
    expect(demoPostMetrics(yt, p, 44 * DAY).details).toBeUndefined();
  });

  it("never calls providers: due demo posts and accounts get generated, growing numbers", async () => {
    const t = Date.now();
    await run("INSERT INTO workspaces (id, name, created_at, updated_at, is_demo) VALUES ('ws_an_demo', 'Demo', ?, ?, 1)", t, t);
    await account("acc_an_demo_tt", "ws_an_demo", "tiktok", "demo-tt", { accessToken: "demo-not-a-real-token" });
    await post("d1", "ws_an_demo", "acc_an_demo_tt", t - 3 * DAY, { nextAt: t - 1 });
    const m = mockProviders();
    await collectMetrics(E, { budget: 0 });
    expect(m.calls).toHaveLength(0);
    const d1 = JSON.parse((await one<any>("SELECT metrics FROM posts WHERE id = 'd1'")).metrics);
    expect(Object.keys(d1).sort()).toEqual(["comments", "likes", "shares", "views"]);
    expect(d1.views).toBeGreaterThan(0);
    expect((await one<any>("SELECT metrics_status FROM accounts WHERE id = 'acc_an_demo_tt'")).metrics_status).toBe("ok");

    const tiktok = getProvider("tiktok")!;
    const p = { content: "Demo post", published_at: t };
    // Deterministic and growing with age.
    expect(demoPostMetrics(tiktok, p, t + DAY)).toEqual(demoPostMetrics(tiktok, p, t + DAY));
    expect(demoPostMetrics(tiktok, p, t + 7 * DAY).views!).toBeGreaterThan(demoPostMetrics(tiktok, p, t + DAY).views!);
    expect(demoPostMetrics(tiktok, p, t + HOUR).views!).toBeLessThan(demoPostMetrics(tiktok, p, t + DAY).views!);
    expect(demoAccountMetrics(tiktok, "demo-tt", t + 30 * DAY).followers!).toBeGreaterThan(demoAccountMetrics(tiktok, "demo-tt", t).followers!);
  });
});
