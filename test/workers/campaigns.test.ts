import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { TICK_CRON } from "../../worker/index";
import { createApiKey } from "../../worker/lib/auth";
import { encryptJson, hashPassword } from "../../worker/lib/crypto";
import { countingD1 } from "./d1-counter";
import { ORIGIN, sessionCookie, type CallOptions, type Client } from "./helpers";

// App Store campaign links: settings (encrypted Revflare key), apps, tracked links on posts, the public /a/ redirect,
// the Revflare sync (fetch mocked with the JSON shapes of Revflare's routes), analytics, playbook ranking and MCP.
// Own D1 instance (CAMPAIGNS_DB), counted through a proxy for the /a/ budget.

const { db: DB, count } = countingD1(env.CAMPAIGNS_DB);
const E = { ...env, DB, DEMO_MODE: "false", PUBLIC_URL: "https://pf.test" } as unknown as Env;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RF = "https://revflare.example.com";
const KEY = "rf_test_key_0123456789abcdef";
const APP_ID = "1234567890";

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
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" }) as any, E, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

const one = <T>(sql: string, ...binds: unknown[]) => env.CAMPAIGNS_DB.prepare(sql).bind(...binds).first<T>();
const run = (sql: string, ...binds: unknown[]) => env.CAMPAIGNS_DB.prepare(sql).bind(...binds).run();

let owner: Client;
let viewer: Client;
let other: Client;

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
  const res = await call(null, "/api/auth/login", { body: { email, password: "password123" }, headers: { "cf-connecting-ip": `10.7.${email.length}.1` } });
  expect(res.status, res.text).toBe(200);
  return { cookie: sessionCookie(res.headers)!, ws };
}

async function account(id: string, ws: string, provider: string) {
  const t = Date.now();
  await run(
    `INSERT INTO accounts (id, provider, external_id, name, username, credentials_enc, meta, status, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?)`,
    id,
    provider,
    `ext_${id}`,
    `${provider} ${id}`,
    id,
    await encryptJson(E, { accessToken: "AT" }),
    t,
    t,
    ws,
  );
}

/** Revflare's API (shapes of its worker/routes/apps.ts and worker/lib/acquisition.ts), plus the iTunes lookup. */
function mockRevflare(opts: { status?: number; campaigns?: unknown[] } = {}) {
  const calls: Request[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    calls.push(req);
    const url = new URL(req.url);
    if (url.host === "itunes.apple.com") {
      return Response.json({ resultCount: 1, results: [{ trackId: Number(url.searchParams.get("id")), trackName: "Looked Up App", artworkUrl512: "https://is1-ssl.mzstatic.com/a.png" }] });
    }
    if (url.origin !== RF) return Response.json({ error: "unexpected" }, { status: 500 });
    if (opts.status) return Response.json({ error: "Unauthorized" }, { status: opts.status });
    if (req.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (url.pathname === "/api/v1/apps") {
      return Response.json({
        currency: "EUR",
        items: [
          { id: "rf_app_1", name: "Tempo", platform: "ios", bundleId: "com.acme.tempo", appleAppId: APP_ID, iconUrl: "https://example.com/tempo.png", archived: false, mrr: 10, revenue28d: 50 },
          { id: "rf_app_2", name: "Plants", platform: "ios", bundleId: "com.acme.plants", appleAppId: "2222222222", iconUrl: null, archived: false, mrr: 0, revenue28d: 0 },
          { id: "rf_app_3", name: "No store id", platform: "ios", bundleId: "com.acme.x", appleAppId: null, iconUrl: null, archived: false, mrr: 0, revenue28d: 0 },
        ],
      });
    }
    if (url.pathname === "/api/v1/acquisition/campaigns") return Response.json({ currency: "EUR", items: opts.campaigns ?? [] });
    if (url.pathname === "/api/v1/acquisition") {
      expect(url.searchParams.get("by")).toBe("app,campaign");
      const rows = ((opts.campaigns ?? []) as any[]).map((c) => ({ appId: c.appId, campaign: c.campaign, downloads: c.downloads, sales: c.proceeds * 1.2 }));
      return Response.json({ currency: "EUR", from: "2015-01-01", to: "2026-10-17", by: ["app", "campaign"], level: "detailed", totals: {}, rows, firstDay: "2026-09-01", lastDay: "2026-10-14" });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  return { calls, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeAll(async () => {
  await call(null, "/api/auth/status"); // applies migrations
  const t = Date.now();
  await user("usr_cp_owner", "cp-owner@example.com");
  await user("usr_cp_viewer", "cp-viewer@example.com");
  await user("usr_cp_other", "cp-other@example.com");
  await env.CAMPAIGNS_DB.batch([
    env.CAMPAIGNS_DB.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws_cp_a', 'A', ?, ?), ('ws_cp_b', 'B', ?, ?)").bind(t, t, t, t),
    env.CAMPAIGNS_DB.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES ('ws_cp_a', 'usr_cp_owner', 'role_ws_owner', ?), ('ws_cp_a', 'usr_cp_viewer', 'role_ws_viewer', ?), ('ws_cp_b', 'usr_cp_other', 'role_ws_owner', ?)",
    ).bind(t, t, t),
  ]);
  owner = await login("cp-owner@example.com", "ws_cp_a");
  viewer = await login("cp-viewer@example.com", "ws_cp_a");
  other = await login("cp-other@example.com", "ws_cp_b");
  await account("acc_cp_x", "ws_cp_a", "x");
  await account("acc_cp_th", "ws_cp_a", "threads");
  await account("acc_cp_ig", "ws_cp_a", "instagram_standalone");
  await account("acc_cp_pin", "ws_cp_a", "pinterest");
  await account("acc_cp_bx", "ws_cp_b", "x");
});

describe("settings", () => {
  it("needs workspace.manage to change; the Revflare key is stored encrypted and never returned", async () => {
    expect((await call(viewer, "/api/campaigns/settings", { method: "PUT", body: { providerToken: "123456" } })).status).toBe(403);
    expect((await call(viewer, "/api/campaigns/settings")).status).toBe(200);
    const res = await call(owner, "/api/campaigns/settings", { method: "PUT", body: { providerToken: "123456", autoLink: true, revflareUrl: `${RF}/api/v1/`, revflareKey: KEY } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ providerToken: "123456", autoLink: true, revflare: { url: RF, keyConfigured: true, status: null }, linkBase: "https://pf.test/a/" });
    expect(res.text).not.toContain(KEY);
    const stored = await one<{ revflare_key_enc: string }>("SELECT revflare_key_enc FROM workspaces WHERE id = 'ws_cp_a'");
    expect(stored!.revflare_key_enc).toMatch(/^v1\./);
    expect(stored!.revflare_key_enc).not.toContain("rf_");
    const got = await call(viewer, "/api/campaigns/settings");
    expect(got.text).not.toContain(KEY);
    expect(got.json.revflare.keyConfigured).toBe(true);
    // Another workspace sees its own (empty) settings.
    expect((await call(other, "/api/campaigns/settings")).json).toMatchObject({ providerToken: null, revflare: { url: null, keyConfigured: false } });
  });

  it("validates the URL (https, public hosts), the key and the provider token", async () => {
    for (const revflareUrl of ["http://revflare.example.com", "https://localhost:8787", "https://10.0.0.1", "https://169.254.169.254", "https://revflare.internal"]) {
      const r = await call(other, "/api/campaigns/settings", { method: "PUT", body: { revflareUrl, revflareKey: KEY } });
      expect(r.status, revflareUrl).toBe(400);
    }
    expect((await call(other, "/api/campaigns/settings", { method: "PUT", body: { revflareUrl: RF, revflareKey: "sk_wrong" } })).status).toBe(400);
    expect((await call(other, "/api/campaigns/settings", { method: "PUT", body: { providerToken: "12 34" } })).status).toBe(400);
  });

  it("test connection: stored or unsaved credentials, with the Bearer key and a 10 s timeout", async () => {
    const { calls } = mockRevflare();
    const ok = await call(owner, "/api/campaigns/test", { body: {} });
    expect(ok.json).toEqual({ ok: true, apps: 2, currency: "EUR" });
    expect(calls[0].url).toBe(`${RF}/api/v1/apps`);
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0].redirect).toBe("manual");
    const bad = await call(owner, "/api/campaigns/test", { body: { revflareKey: "rf_wrong_key_0123456789" } });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toMatch(/rejected the API key/);
    expect((await call(viewer, "/api/campaigns/test", { body: {} })).status).toBe(403);
  });
});

describe("apps", () => {
  it("imports apps with an App Store id from Revflare", async () => {
    mockRevflare();
    const res = await call(owner, "/api/apps/import", { body: {} });
    expect(res.status, res.text).toBe(200);
    expect(res.json.imported).toBe(2);
    expect(res.json.apps.map((a: any) => [a.appStoreId, a.name, a.revflareAppId])).toEqual([
      ["2222222222", "Plants", "rf_app_2"],
      [APP_ID, "Tempo", "rf_app_1"],
    ]);
    // Again: updated, not duplicated.
    await call(owner, "/api/apps/import", { body: {} });
    expect((await call(viewer, "/api/apps")).json).toHaveLength(2);
  });

  it("adds by hand (name looked up on the App Store), scoped and permission-checked", async () => {
    const { calls } = mockRevflare();
    expect((await call(viewer, "/api/apps", { body: { appStoreId: "3333333333" } })).status).toBe(403);
    expect((await call(owner, "/api/apps", { body: { appStoreId: "abc" } })).status).toBe(400);
    const res = await call(other, "/api/apps", { body: { appStoreId: "id3333333333" } });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ appStoreId: "3333333333", name: "Looked Up App", iconUrl: "https://is1-ssl.mzstatic.com/a.png" });
    expect(calls.some((r) => r.url === "https://itunes.apple.com/lookup?id=3333333333")).toBe(true);
    const named = await call(other, "/api/apps", { body: { appStoreId: "4444444444", name: "Mine" } });
    expect(named.json.name).toBe("Mine");
    // Another workspace's app: 404, and invisible.
    expect((await call(owner, `/api/apps/${res.json.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(owner, "/api/apps")).json.some((a: any) => a.id === res.json.id)).toBe(false);
  });
});

let xPost: any;
let thPost: any;
let igPost: any;

describe("posts with an app", () => {
  it("creates tracked links on clickable platforms and rewrites the text at create time", async () => {
    const res = await call(owner, "/api/posts", {
      body: {
        scheduledAt: null,
        appId: "Tempo",
        posts: [
          { accountId: "acc_cp_x", content: `Tempo 2.0 → https://apps.apple.com/us/app/tempo/id${APP_ID}` },
          { accountId: "acc_cp_th", content: "Tempo 2.0 is out" },
          { accountId: "acc_cp_ig", content: `Link in bio! https://apps.apple.com/app/id${APP_ID}` },
          { accountId: "acc_cp_pin", content: "Calm focus", settings: { board: "b1" } },
        ],
      },
    });
    expect(res.status, res.text).toBe(201);
    const byAccount = Object.fromEntries(res.json.map((p: any) => [p.accountId, p]));
    xPost = byAccount.acc_cp_x;
    thPost = byAccount.acc_cp_th;
    igPost = byAccount.acc_cp_ig;
    const links = (await env.CAMPAIGNS_DB.prepare("SELECT * FROM campaign_links WHERE workspace_id = 'ws_cp_a' AND kind = 'post'").all<any>()).results;
    expect(links).toHaveLength(3); // not Instagram
    const xLink = links.find((l) => l.post_id === xPost.id);
    expect(xLink.ct).toMatch(/^pf-x-[a-z0-9]{10}$/);
    expect(xLink.url).toBe(`https://apps.apple.com/app/apple-store/id${APP_ID}?pt=123456&ct=${xLink.ct}&mt=8`);
    expect(xPost.content).toBe(`Tempo 2.0 → https://pf.test/a/${xLink.code}`);
    expect(xPost.appId).toMatch(/^app_/);
    expect(thPost.content).toMatch(/^Tempo 2\.0 is out\n\nhttps:\/\/pf\.test\/a\/[0-9A-Za-z]{8}$/);
    expect(igPost.content).toBe(`Link in bio! https://apps.apple.com/app/id${APP_ID}`);
    expect(byAccount.acc_cp_pin.settings.link).toMatch(/^https:\/\/pf\.test\/a\//);
    expect(byAccount.acc_cp_pin.content).toBe("Calm focus");
    const detail = await call(viewer, `/api/posts/${xPost.id}`);
    expect(detail.json.campaign).toMatchObject({ code: xLink.code, ct: xLink.ct, trackedUrl: `https://pf.test/a/${xLink.code}`, appStoreId: APP_ID, clicks: 0, downloads: null });
    expect((await call(viewer, `/api/posts/${igPost.id}`)).json.campaign).toBeNull();
  });

  it("autoLink: false keeps the text but still creates the tracked link", async () => {
    const res = await call(owner, "/api/posts", { body: { scheduledAt: null, appId: APP_ID, autoLink: false, posts: [{ accountId: "acc_cp_th", content: "No link please" }] } });
    expect(res.status).toBe(201);
    expect(res.json[0].content).toBe("No link please");
    expect(res.json[0].autoLink).toBe(false);
    expect(await one("SELECT code FROM campaign_links WHERE post_id = ?", res.json[0].id)).not.toBeNull();
  });

  it("edits keep the code and token (stable); a reschedule does not touch the text", async () => {
    const before = await one<any>("SELECT * FROM campaign_links WHERE post_id = ?", thPost.id);
    const res = await call(owner, `/api/posts/${thPost.id}`, { method: "PATCH", body: { content: `New text https://apps.apple.com/app/id${APP_ID}` } });
    expect(res.status, res.text).toBe(200);
    expect(res.json.content).toBe(`New text https://pf.test/a/${before.code}`);
    const after = await one<any>("SELECT * FROM campaign_links WHERE post_id = ?", thPost.id);
    expect(after).toEqual(before);
    // Removing the link by hand, then only changing the schedule: the link is not appended again.
    await call(owner, `/api/posts/${thPost.id}`, { method: "PATCH", body: { content: "Text only" } });
    await run("UPDATE posts SET content = 'Text only' WHERE id = ?", thPost.id);
    const rescheduled = await call(owner, `/api/posts/${thPost.id}`, { method: "PATCH", body: { scheduledAt: null } });
    expect(rescheduled.json.content).toBe("Text only");
    // Another app: same token, the link points at the new app.
    const plants = (await call(owner, "/api/apps")).json.find((a: any) => a.appStoreId === "2222222222");
    const moved = await call(owner, `/api/posts/${thPost.id}`, { method: "PATCH", body: { appId: plants.id, autoLink: false } });
    expect(moved.status, moved.text).toBe(200);
    const link = await one<any>("SELECT * FROM campaign_links WHERE post_id = ?", thPost.id);
    expect(link.ct).toBe(before.ct);
    expect(link.code).toBe(before.code);
    expect(link.url).toContain("id2222222222");
    // Back to Tempo for the rest of the tests.
    await call(owner, `/api/posts/${thPost.id}`, { method: "PATCH", body: { appId: "Tempo", autoLink: false } });
  });

  it("an app of another workspace is not found", async () => {
    const otherApp = (await call(other, "/api/apps")).json[0];
    const res = await call(owner, "/api/posts", { body: { scheduledAt: null, appId: otherApp.id, posts: [{ accountId: "acc_cp_x", content: "hi" }] } });
    expect(res.status).toBe(404);
  });

  it("X length limit: a post that would exceed 280 keeps its text and logs why", async () => {
    const res = await call(owner, "/api/posts", { body: { scheduledAt: null, appId: "Tempo", posts: [{ accountId: "acc_cp_x", content: "a".repeat(270) }] } });
    expect(res.status, res.text).toBe(201);
    expect(res.json[0].content).toBe("a".repeat(270));
    const log = await one<{ message: string }>("SELECT message FROM post_logs WHERE post_id = ? AND level = 'warn'", res.json[0].id);
    expect(log!.message).toMatch(/length limit/);
  });

  it("bio links: one per account and app, ct pf-<platform>-bio", async () => {
    const tempo = (await call(owner, "/api/apps")).json.find((a: any) => a.appStoreId === APP_ID);
    expect((await call(viewer, "/api/campaigns/bio-links", { body: { accountId: "acc_cp_ig", appId: tempo.id } })).status).toBe(403);
    const a = await call(owner, "/api/campaigns/bio-links", { body: { accountId: "acc_cp_ig", appId: tempo.id } });
    expect(a.status, a.text).toBe(201);
    expect(a.json).toMatchObject({ kind: "bio", ct: "pf-igs-bio", accountId: "acc_cp_ig" });
    const again = await call(owner, "/api/campaigns/bio-links", { body: { accountId: "acc_cp_ig", appId: tempo.id } });
    expect(again.json.code).toBe(a.json.code);
    expect((await call(owner, "/api/campaigns/bio-links", { body: { accountId: "acc_cp_bx", appId: tempo.id } })).status).toBe(404);
    const list = await call(viewer, "/api/campaigns/links?kind=bio");
    expect(list.json.map((l: any) => l.ct)).toEqual(["pf-igs-bio"]);
  });
});

describe("GET /a/<code>", () => {
  const browser = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  it("302 to the App Store campaign link, counts browser clicks per day in at most 3 D1 queries", async () => {
    const link = await one<any>("SELECT * FROM campaign_links WHERE post_id = ?", xPost.id);
    await call(null, `/a/${link.code}`, { headers: { "user-agent": browser } }); // warm (schema check)
    count.reset();
    const res = await call(null, `/a/${link.code}`, { headers: { "user-agent": browser } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(link.url);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.text).toBe("");
    expect(count.queries + count.batchStatements).toBeLessThanOrEqual(3);
    expect(count.sql.filter((s) => /INSERT INTO campaign_clicks/.test(s))).toHaveLength(1);
    const clicks = await one<{ clicks: number }>("SELECT clicks FROM campaign_clicks WHERE code = ?", link.code);
    expect(clicks!.clicks).toBe(2);
  });

  it("does not count bots, link previews, HTTP libraries or HEAD requests (still redirects)", async () => {
    const link = await one<any>("SELECT * FROM campaign_links WHERE post_id = ?", thPost.id);
    for (const ua of ["Twitterbot/1.0", "facebookexternalhit/1.1", "Slackbot-LinkExpanding 1.0", "curl/8.4.0", "python-requests/2.31", "Mozilla/5.0 (compatible; Googlebot/2.1)"]) {
      const res = await call(null, `/a/${link.code}`, { headers: { "user-agent": ua } });
      expect(res.status, ua).toBe(302);
    }
    const head = await call(null, `/a/${link.code}`, { method: "HEAD", headers: { "user-agent": browser } });
    expect(head.status).toBe(302);
    expect(await one("SELECT clicks FROM campaign_clicks WHERE code = ?", link.code)).toBeNull();
    await call(null, `/a/${link.code}`, { headers: { "user-agent": browser } });
    expect((await one<{ clicks: number }>("SELECT clicks FROM campaign_clicks WHERE code = ?", link.code))!.clicks).toBe(1);
  });

  it("unknown or malformed codes: 404 page, nothing written", async () => {
    count.reset();
    const res = await call(null, "/a/ZZZZZZZZ", { headers: { "user-agent": browser } });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.text).toContain("Link not found");
    expect(count.sql.some((s) => /INSERT/.test(s))).toBe(false);
    expect((await call(null, "/a/..%2Fapi", {})).status).toBe(404);
    expect((await call(null, "/a/x'--", {})).status).toBe(404);
  });
});

const campaigns = () => [
  // Revflare AcquisitionCampaign (all time, per app); only pf- tokens are kept.
  { campaign: "", appId: "rf_app_1", appleAppId: APP_ID, firstSeen: "2026-09-01", lastSeen: "2026-10-14", impressions: 1, pageViews: 1, downloads: 999, redownloads: 0, purchases: 0, proceeds: 0 },
  { campaign: "newsletter", appId: "rf_app_1", appleAppId: APP_ID, firstSeen: "2026-09-01", lastSeen: "2026-10-14", impressions: 1, pageViews: 1, downloads: 50, redownloads: 1, purchases: 1, proceeds: 1 },
];

describe("Revflare sync and results", () => {
  let xCt: string;
  let thCt: string;
  beforeAll(async () => {
    xCt = (await one<any>("SELECT ct FROM campaign_links WHERE post_id = ?", xPost.id)).ct;
    thCt = (await one<any>("SELECT ct FROM campaign_links WHERE post_id = ?", thPost.id)).ct;
    // Both posts published 5 days ago, with engagement metrics.
    const t = Date.now() - 5 * DAY;
    await run("UPDATE posts SET status = 'published', published_at = ?, external_id = id, metrics = ? WHERE id IN (?, ?, ?)", t, JSON.stringify({ views: 1000, likes: 50 }), xPost.id, thPost.id, igPost.id);
  });

  it("stores downloads, redownloads, purchases, proceeds, sales and currency per campaign token", async () => {
    const list = [
      ...campaigns(),
      { campaign: xCt, appId: "rf_app_1", appleAppId: APP_ID, firstSeen: "2026-10-10", lastSeen: "2026-10-14", impressions: 300, pageViews: 120, downloads: 42, redownloads: 3, purchases: 5, proceeds: 31.5 },
      { campaign: thCt, appId: "rf_app_1", appleAppId: APP_ID, firstSeen: "2026-10-11", lastSeen: "2026-10-13", impressions: 30, pageViews: 12, downloads: 4, redownloads: 0, purchases: 0, proceeds: 0 },
    ];
    const { calls } = mockRevflare({ campaigns: list });
    const res = await call(owner, "/api/campaigns/sync", { body: {} });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ ok: true, campaigns: 2, currency: "EUR", asOf: "2026-10-14" });
    expect(calls.map((r) => new URL(r.url).pathname)).toEqual(["/api/v1/acquisition/campaigns", "/api/v1/acquisition"]);
    const row = await one<any>("SELECT * FROM campaign_stats WHERE workspace_id = 'ws_cp_a' AND ct = ?", xCt);
    expect(row).toMatchObject({ app_store_id: APP_ID, downloads: 42, redownloads: 3, purchases: 5, proceeds: 31.5, sales: 37.8, currency: "EUR", first_day: "2026-10-10", last_day: "2026-10-14" });
    expect(await one("SELECT * FROM campaign_stats WHERE ct = 'newsletter'")).toBeNull();
    const ws = await one<any>("SELECT revflare_status, revflare_currency, revflare_next_at FROM workspaces WHERE id = 'ws_cp_a'");
    expect(ws).toMatchObject({ revflare_status: "ok", revflare_currency: "EUR" });
    expect(ws.revflare_next_at).toBeGreaterThan(Date.now() + 5 * HOUR);
  });

  it("per post: clicks, downloads, proceeds (metrics, analytics list sorted by installs)", async () => {
    const m = await call(viewer, `/api/posts/${xPost.id}/metrics`);
    expect(m.json.campaign).toEqual({ clicks: 2, downloads: 42, redownloads: 3, purchases: 5, proceeds: 31.5, sales: 37.8, currency: "EUR", asOf: "2026-10-14" });
    const ig = await call(viewer, `/api/posts/${igPost.id}/metrics`);
    expect(ig.json.campaign).toBeNull();
    const list = await call(viewer, "/api/analytics/posts?sort=downloads");
    expect(list.status, list.text).toBe(200);
    expect(list.json[0].id).toBe(xPost.id);
    expect(list.json[0].campaign.downloads).toBe(42);
    expect((await call(viewer, "/api/analytics/posts?sort=installs")).json[0].id).toBe(xPost.id);
    expect((await call(viewer, "/api/analytics/posts?sort=proceeds")).json[0].id).toBe(xPost.id);
  });

  it("rollups: totals, per platform and per account, with the currency", async () => {
    const s = (await call(viewer, "/api/analytics/summary")).json;
    expect(s.totals).toMatchObject({ campaignPosts: 2, clicks: 3, downloads: 46, redownloads: 3, proceeds: 31.5 });
    expect(s.currency).toBe("EUR");
    expect(s.byProvider.find((p: any) => p.provider === "x")).toMatchObject({ campaignPosts: 1, downloads: 42, proceeds: 31.5 });
    expect(s.byAccount.find((a: any) => a.accountId === "acc_cp_th")).toMatchObject({ campaignPosts: 1, clicks: 1, downloads: 4 });
    // Other workspace: nothing of A.
    const b = (await call(other, "/api/analytics/summary")).json;
    expect(b.totals).toMatchObject({ campaignPosts: 0, downloads: 0 });
  });

  it("playbook ranking by installs and revenue (still one query)", async () => {
    await run("UPDATE posts SET playbook_id = 'launch-announcement', playbook_version = 1 WHERE id = ?", thPost.id);
    await run("UPDATE posts SET playbook_id = 'text-thread', playbook_version = 1 WHERE id = ?", xPost.id);
    const byLift = await call(viewer, "/api/playbooks/stats");
    expect(byLift.status, byLift.text).toBe(200);
    expect(byLift.json.sort).toBe("lift");
    count.reset();
    const r = await call(viewer, "/api/playbooks/stats?sort=downloads");
    expect(count.sql.filter((s) => s.includes("FROM posts p JOIN accounts a"))).toHaveLength(1);
    expect(r.json.sort).toBe("downloads");
    expect(r.json.currency).toBe("EUR");
    expect(r.json.playbooks.map((p: any) => [p.playbookId, p.downloads, p.proceeds, p.campaignPosts])).toEqual([
      ["text-thread", 42, 31.5, 1],
      ["launch-announcement", 4, 0, 1],
    ]);
    expect(r.json.playbooks[0]).toMatchObject({ downloadsPerPost: 42, proceedsPerPost: 31.5, clicks: 2 });
    expect((await call(viewer, "/api/playbooks/stats?sort=revenue")).json.playbooks[0].playbookId).toBe("text-thread");
    expect((await call(viewer, "/api/playbooks/stats?sort=nope")).status).toBe(400);
  });

  it("a failing sync records the error and backs off", async () => {
    mockRevflare({ status: 401 });
    const res = await call(owner, "/api/campaigns/sync", { body: {} });
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/rejected the API key/);
    const ws = await one<any>("SELECT revflare_status, revflare_fails, revflare_message FROM workspaces WHERE id = 'ws_cp_a'");
    expect(ws).toMatchObject({ revflare_status: "error", revflare_fails: 1 });
    // The stored numbers stay.
    expect(await one("SELECT * FROM campaign_stats WHERE ct = ?", xCt)).not.toBeNull();
    expect((await call(viewer, "/api/campaigns/sync", { body: {} })).status).toBe(403);
  });

  it("the hourly metrics tick syncs due workspaces (2 fetches each), other ticks don't", async () => {
    await run("UPDATE workspaces SET revflare_next_at = NULL, revflare_fails = 0 WHERE id = 'ws_cp_a'");
    const { calls } = mockRevflare({ campaigns: [{ campaign: xCt, appId: "rf_app_1", appleAppId: APP_ID, firstSeen: "2026-10-10", lastSeen: "2026-10-15", impressions: 1, pageViews: 1, downloads: 50, redownloads: 3, purchases: 6, proceeds: 40 }] });
    const at = (h: number, m: number) => {
      const d = new Date();
      d.setUTCHours(h, m, 0, 0);
      return d.getTime();
    };
    const tick = async (time: number) => {
      const ctx = createExecutionContext();
      await worker.scheduled!(createScheduledController({ cron: TICK_CRON, scheduledTime: time }), E, ctx);
      await waitOnExecutionContext(ctx);
    };
    await tick(at(10, 5)); // :05 metrics tick: no campaign sync
    expect(calls.filter((r) => r.url.startsWith(RF))).toHaveLength(0);
    await tick(at(10, 50));
    expect(calls.filter((r) => r.url.startsWith(RF))).toHaveLength(2);
    expect((await one<any>("SELECT downloads FROM campaign_stats WHERE ct = ?", xCt)).downloads).toBe(50);
    await tick(at(11, 50)); // not due again for 6 hours
    expect(calls.filter((r) => r.url.startsWith(RF))).toHaveLength(2);
  });

  it("removing the connection keeps the numbers; the key cannot be read back", async () => {
    const res = await call(owner, "/api/campaigns/settings", { method: "PUT", body: { revflareKey: null } });
    expect(res.json.revflare).toMatchObject({ url: null, keyConfigured: false });
    expect(await one("SELECT * FROM campaign_stats WHERE ct = ?", xCt)).not.toBeNull();
  });
});

describe("MCP", () => {
  let key: string;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await call({ key }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    expect(res.status, res.text).toBe(200);
    const r = res.json.result;
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  beforeAll(async () => {
    key = (await createApiKey(E, "mcp", "usr_cp_owner", "ws_cp_a")).token;
  });

  it("list_apps, get_post_metrics and get_top_posts include clicks, installs and proceeds", async () => {
    const apps = await tool("list_apps");
    expect(apps.map((a: any) => a.appStoreId).sort()).toEqual([APP_ID, "2222222222"].sort());
    const m = await tool("get_post_metrics", { id: xPost.id });
    expect(m.campaign).toMatchObject({ clicks: 2, installs: 50, proceeds: 40, currency: "EUR" });
    const top = await tool("get_top_posts", { sort: "installs", limit: 5 });
    expect(top[0]).toMatchObject({ id: xPost.id, campaign: { installs: 50, proceeds: 40 } });
    const summary = await tool("get_analytics_summary", {});
    expect(summary.totals).toMatchObject({ trackedPosts: 2, installs: 50, proceeds: 40 }); // the last sync only reported the X token
    const stats = await tool("get_playbook_stats", { sort: "installs" });
    expect(stats.playbooks[0]).toMatchObject({ playbookId: "text-thread", installs: 50 });
  });

  it("create_post with appId gets a tracked link; get_bio_link", async () => {
    const created = await tool("create_post", { scheduledAt: null, appId: APP_ID, content: "From an agent", accounts: [{ accountId: "acc_cp_th" }] });
    expect(created[0].content).toMatch(/^From an agent\n\nhttps:\/\/pf\.test\/a\//);
    const bio = await tool("get_bio_link", { accountId: "acc_cp_ig", appId: APP_ID });
    expect(bio).toMatchObject({ ct: "pf-igs-bio" });
    expect(bio.url).toMatch(/^https:\/\/pf\.test\/a\//);
  });
});

describe("workspace deletion", () => {
  it("removes apps, links, clicks and stats", async () => {
    const t = Date.now();
    await run("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws_cp_del', 'Del', ?, ?)", t, t);
    await run("INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES ('ws_cp_del', 'usr_cp_owner', 'role_ws_owner', ?)", t);
    await run("INSERT INTO workspace_apps (id, workspace_id, app_store_id, name, created_at) VALUES ('app_del', 'ws_cp_del', '5555555555', 'D', ?)", t);
    await run("INSERT INTO campaign_links (code, workspace_id, kind, account_id, provider, app_id, app_store_id, ct, url, created_at) VALUES ('DELcode1', 'ws_cp_del', 'bio', 'a', 'x', 'app_del', '5555555555', 'pf-x-bio', 'https://apps.apple.com/app/apple-store/id5555555555', ?)", t);
    await run("INSERT INTO campaign_clicks (code, day, clicks) VALUES ('DELcode1', '2026-10-01', 3)");
    await run("INSERT INTO campaign_stats (workspace_id, app_store_id, ct, synced_at) VALUES ('ws_cp_del', '5555555555', 'pf-x-bio', ?)", t);
    const res = await call({ ...owner, ws: "ws_cp_del" }, "/api/workspaces/ws_cp_del", { method: "DELETE" });
    expect(res.status, res.text).toBe(200);
    for (const table of ["workspace_apps", "campaign_links", "campaign_stats"]) expect(await one(`SELECT 1 FROM ${table} WHERE workspace_id = 'ws_cp_del'`), table).toBeNull();
    expect(await one("SELECT 1 FROM campaign_clicks WHERE code = 'DELcode1'")).toBeNull();
    expect((await call(null, "/a/DELcode1")).status).toBe(404);
  });
});
