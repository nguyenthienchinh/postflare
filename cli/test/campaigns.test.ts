import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deps } from "../src/context.js";
import { run } from "../src/main.js";

// App Store campaign links: --app on post / posts edit, apps, links, campaign results in posts show, analytics and
// playbooks stats, against a fake API (fetch is injected).

const dir = mkdtempSync(join(tmpdir(), "postflare-camp-"));
const NOW = new Date(2026, 9, 12, 10, 30, 0, 0);

const ACCOUNTS = [
  { id: "acc_x", provider: "x", name: "Tempo", username: "tempoapp", status: "active", statusMessage: null },
  { id: "acc_ig", provider: "instagram_standalone", name: "Tempo IG", username: "tempo.ig", status: "active", statusMessage: null },
];
const PROVIDERS = [
  { id: "x", name: "X", category: "social", auth: "oauth2", capabilities: { maxLength: 280, text: "optional", media: { images: 4, videos: 1, mixed: false, required: false }, thread: true }, settingsFields: [] },
  {
    id: "instagram_standalone",
    name: "Instagram",
    category: "social",
    auth: "oauth2",
    capabilities: { maxLength: 2200, text: "optional", media: { images: 10, videos: 10, mixed: true, required: false }, thread: true },
    settingsFields: [],
  },
];
const APPS = [
  { id: "app_tempo", appStoreId: "1234567890", name: "Tempo", iconUrl: null, revflareAppId: "rf_1", createdAt: 0 },
  { id: "app_beat", appStoreId: "987654321", name: "Beat Maker", iconUrl: null, revflareAppId: null, createdAt: 0 },
];
const results = { clicks: 42, downloads: 7, redownloads: 1, purchases: 2, proceeds: 12.5, sales: 14, currency: "USD", asOf: "2026-10-09" };
const link = (o: object) => ({
  code: "AbCd1234",
  kind: "post",
  trackedUrl: "https://pf.test/a/AbCd1234",
  appStoreUrl: "https://apps.apple.com/app/apple-store/id1234567890?pt=123&ct=pf-x-abc&mt=8",
  ct: "pf-x-abc",
  postId: "pst_1",
  accountId: "acc_x",
  provider: "x",
  appId: "app_tempo",
  appStoreId: "1234567890",
  createdAt: 0,
  ...results,
  ...o,
});
const post = (o: object) => ({
  id: "pst_1",
  groupId: "grp",
  accountId: "acc_x",
  status: "published",
  scheduledAt: null,
  content: "Tempo 2.0 https://pf.test/a/AbCd1234",
  media: [],
  settings: {},
  thread: [],
  externalId: "1",
  externalUrl: "https://x.com/tempoapp/status/1",
  error: null,
  attempts: 1,
  createdAt: 0,
  updatedAt: 0,
  publishedAt: NOW.getTime() - 86_400_000,
  appId: "app_tempo",
  autoLink: null,
  ...o,
});
const zero = { posts: 0, postsWithMetrics: 0, views: 0, impressions: 0, reach: 0, engagements: 0, likes: 0, comments: 0, shares: 0, engagementRate: null, followers: null, followersChange: null };
const statsRow = (o: object) => ({ playbookId: "launch", name: "Launch", builtin: true, posts: 8, accounts: 1, medianEngagementRate: 0.02, meanEngagementRate: 0.02, medianViews: 900, lift: 0.1, liftPosts: 8, confidence: "low", campaignPosts: 0, clicks: 0, downloads: 0, proceeds: 0, downloadsPerPost: null, proceedsPerPost: null, ...o });

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  json: any;
}

function fakeApi() {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method, path: u.pathname, query: u.searchParams, json: body });
    switch (`${init.method} ${u.pathname}`) {
      case "GET /api/accounts":
        return json(ACCOUNTS);
      case "GET /api/providers":
        return json(PROVIDERS);
      case "GET /api/apps":
        return json(APPS);
      case "POST /api/apps":
        return json({ id: "app_new", appStoreId: body.appStoreId, name: body.name ?? "Looked Up", iconUrl: null, revflareAppId: null, createdAt: 0 }, 201);
      case "POST /api/apps/import":
        return json({ imported: 2, apps: APPS });
      case "DELETE /api/apps/app_beat":
        return json({ ok: true });
      case "POST /api/posts":
        return json(
          body.posts.map((p: any, i: number) =>
            post({ id: `pst_${i + 1}`, accountId: p.accountId, status: "scheduled", publishedAt: null, content: p.accountId === "acc_x" && body.autoLink !== false ? `${p.content} https://pf.test/a/AbCd1234` : p.content, appId: body.appId ?? null, autoLink: body.autoLink ?? null }),
          ),
          201,
        );
      case "GET /api/campaigns/links":
        return json([link({})]);
      case "POST /api/campaigns/bio-links":
        return json(link({ kind: "bio", postId: null, accountId: body.accountId, provider: "instagram_standalone", ct: "pf-ig-bio", code: "Bio12345", trackedUrl: "https://pf.test/a/Bio12345", clicks: 3, downloads: null, redownloads: null, proceeds: null, asOf: null }), 201);
      case "GET /api/posts/pst_1":
        return json({ ...post({}), campaign: link({}), logs: [] });
      case "GET /api/posts/pst_1/metrics":
        return json({ postId: "pst_1", publishedAt: 1, metrics: { views: 1000, likes: 10 }, metricsAt: 1, metricsNextAt: null, snapshots: [], campaign: { ...results, clicks: 50 } });
      case "PATCH /api/posts/pst_1":
        return json(post({ status: "scheduled", ...body }));
      case "GET /api/analytics/summary":
        return json({
          from: 0,
          to: 7 * 86_400_000,
          tz: "UTC",
          totals: { ...zero, posts: 4, postsWithMetrics: 4, views: 5000, engagements: 200, engagementRate: 0.04, campaignPosts: 2, clicks: 80, downloads: 9, redownloads: 1, proceeds: 20 },
          previous: { ...zero, posts: 2, campaignPosts: 1, clicks: 40, downloads: 3, redownloads: 0, proceeds: 5 },
          byProvider: [
            { ...zero, key: "x", provider: "x", name: "X", posts: 3, views: 4000, engagements: 150, campaignPosts: 2, clicks: 80, downloads: 9, redownloads: 1, proceeds: 20 },
            { ...zero, key: "instagram_standalone", provider: "instagram_standalone", name: "Instagram", posts: 1, views: 1000, engagements: 50, campaignPosts: 0, clicks: 0, downloads: 0, redownloads: 0, proceeds: 0 },
          ],
          byAccount: [],
          daily: [],
          followers: [],
          currency: "USD",
        });
      case "GET /api/analytics/posts":
        return json([
          { id: "pst_1", groupId: "grp", accountId: "acc_x", provider: "x", accountName: "Tempo", accountUsername: "tempoapp", excerpt: "Tempo 2.0", media: [], externalId: "1", externalUrl: null, publishedAt: 1, metrics: { views: 1000 }, metricsAt: 1, metricsNextAt: null, engagements: 10, engagementRate: 0.01, campaign: results },
        ]);
      case "GET /api/playbooks/stats":
        return json({
          from: 0,
          to: 1,
          days: 90,
          platform: null,
          accountId: null,
          postsAnalyzed: 12,
          capped: false,
          baseline: statsRow({ playbookId: null, name: "No playbook", builtin: false, posts: 4, lift: 0 }),
          playbooks: [{ ...statsRow({ campaignPosts: 4, clicks: 90, downloads: 11, proceeds: 33.5, downloadsPerPost: 2.75, proceedsPerPost: 8.375 }), versions: [], variants: [] }],
          method: "…",
          sort: u.searchParams.get("sort") ?? "lift",
          currency: "USD",
        });
    }
    return json({ error: "Not found" }, 404);
  };
  return { calls, fetch };
}

let out = "";
let err = "";
let api: ReturnType<typeof fakeApi>;
let deps: Deps;

beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => ((err += String(s)), true));
  api = fakeApi();
  deps = {
    fetch: api.fetch as any,
    env: { POSTFLARE_URL: "https://pf.test/", POSTFLARE_API_KEY: "pf_test", POSTFLARE_CONFIG: join(dir, "none.json"), POSTFLARE_NO_VERSION_CHECK: "1" },
    readStdin: async () => null,
    now: () => NOW,
  };
});

afterEach(() => vi.restoreAllMocks());

const last = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path).at(-1);

describe("post --app", () => {
  it("resolves the app by name, App Store id or id and sends its id", async () => {
    for (const ref of ["tempo", "1234567890", "id1234567890", "app_tempo"]) {
      expect(await run(["post", "-a", "x", "--text", "Tempo 2.0", "--draft", "--app", ref, "--json"], deps)).toBe(0);
      expect(last("POST", "/api/posts")!.json).toMatchObject({ appId: "app_tempo" });
      expect(last("POST", "/api/posts")!.json).not.toHaveProperty("autoLink");
    }
  });

  it("unknown app: usage error listing the apps, nothing created", async () => {
    expect(await run(["post", "-a", "x", "--text", "hi", "--draft", "--app", "Nope"], deps)).toBe(2);
    expect(err).toContain('No app matches "Nope"');
    expect(err).toMatch(/app_tempo\s+1234567890\s+Tempo/);
    expect(err).toMatch(/app_beat\s+987654321\s+Beat Maker/);
    expect(last("POST", "/api/posts")).toBeUndefined();
  });

  it("--no-autolink sends autoLink false; --autolink needs --app", async () => {
    expect(await run(["post", "-a", "x", "--text", "hi", "--draft", "--app", "Tempo", "--no-autolink", "--json"], deps)).toBe(0);
    expect(last("POST", "/api/posts")!.json).toMatchObject({ appId: "app_tempo", autoLink: false });
    expect(await run(["post", "-a", "x", "--text", "hi", "--draft", "--autolink"], deps)).toBe(2);
    expect(await run(["post", "-a", "x", "--text", "hi", "--draft", "--app", "Tempo", "--autolink", "--no-autolink"], deps)).toBe(2);
  });

  it("reports the tracked link and the bio-link hint for Instagram", async () => {
    expect(await run(["post", "-a", "x", "-a", "instagram_standalone", "--text", "Tempo 2.0", "--draft", "--app", "Tempo", "--no-color"], deps)).toBe(0);
    expect(Object.fromEntries(last("GET", "/api/campaigns/links")!.query)).toMatchObject({ appId: "app_tempo", kind: "post" });
    expect(out).toContain("Tracked link added for X");
    expect(out).toContain("Instagram captions aren't clickable: use the bio link: postflare apps bio-link -a acc_ig --app app_tempo");
  });
});

describe("posts edit / show", () => {
  it("--app, --no-app and --autolink", async () => {
    expect(await run(["posts", "edit", "pst_1", "--no-app"], deps)).toBe(0);
    expect(last("PATCH", "/api/posts/pst_1")!.json).toEqual({ appId: null });
    expect(await run(["posts", "edit", "pst_1", "--app", "beat maker", "--autolink"], deps)).toBe(0);
    expect(last("PATCH", "/api/posts/pst_1")!.json).toEqual({ appId: "app_beat", autoLink: true });
    expect(await run(["posts", "edit", "pst_1", "--app", "Tempo", "--no-app"], deps)).toBe(2);
  });

  it("show prints the app, the tracked link and its results (metrics endpoint wins) with the data note", async () => {
    expect(await run(["posts", "show", "pst_1", "--no-color"], deps)).toBe(0);
    expect(out).toContain("App: Tempo (1234567890)");
    expect(out).toContain("Tracked link: https://pf.test/a/AbCd1234  ct pf-x-abc");
    expect(out).toContain("clicks 50  App Store downloads 7  redownloads 1  proceeds $12.50  (as of 2026-10-09)");
    expect(out).toContain("lag 2-3 days");
    out = "";
    expect(await run(["posts", "show", "pst_1", "--json"], deps)).toBe(0);
    const j = JSON.parse(out);
    expect(j.campaign.trackedUrl).toBe("https://pf.test/a/AbCd1234");
    expect(j.metrics.campaign.clicks).toBe(50);
  });
});

describe("apps and links", () => {
  it("lists apps with their source", async () => {
    expect(await run(["apps", "--no-color"], deps)).toBe(0);
    expect(out).toMatch(/app_beat\s+987654321\s+Beat Maker\s+manual/);
    expect(out).toMatch(/app_tempo\s+1234567890\s+Tempo\s+revflare/);
  });

  it("add, import, rm", async () => {
    expect(await run(["apps", "add", "id555", "--name", "New"], deps)).toBe(0);
    expect(last("POST", "/api/apps")!.json).toEqual({ appStoreId: "id555", name: "New" });
    expect(await run(["apps", "import"], deps)).toBe(0);
    expect(out).toContain("Imported 2 apps from Revflare");
    expect(await run(["apps", "rm", "Beat Maker"], deps)).toBe(0);
    expect(last("DELETE", "/api/apps/app_beat")).toBeDefined();
  });

  it("bio-link resolves the account and app and prints the URL and campaign token", async () => {
    expect(await run(["apps", "bio-link", "-a", "@tempo.ig", "--app", "Tempo", "--no-color"], deps)).toBe(0);
    expect(last("POST", "/api/campaigns/bio-links")!.json).toEqual({ accountId: "acc_ig", appId: "app_tempo" });
    expect(out).toContain("Bio link:  https://pf.test/a/Bio12345");
    expect(out).toContain("Campaign:  pf-ig-bio");
    out = "";
    expect(await run(["apps", "bio-link", "-a", "@tempo.ig", "--app", "Tempo", "--json"], deps)).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ trackedUrl: "https://pf.test/a/Bio12345", ct: "pf-ig-bio" });
    expect(await run(["apps", "bio-link", "-a", "@tempo.ig"], deps)).toBe(2);
  });

  it("links filters by account, app and kind", async () => {
    expect(await run(["links", "-a", "x", "--app", "Tempo", "--kind", "post", "--no-color"], deps)).toBe(0);
    expect(Object.fromEntries(last("GET", "/api/campaigns/links")!.query)).toEqual({ accountId: "acc_x", appId: "app_tempo", kind: "post" });
    expect(out).toMatch(/post\s+x @tempoapp\s+pst_1\s+pf-x-abc\s+42\s+7\s+\$12\.50\s+2026-10-09\s+https:\/\/pf\.test\/a\/AbCd1234/);
    expect(await run(["links", "--kind", "nope"], deps)).toBe(2);
  });
});

describe("analytics and playbooks stats with campaign results", () => {
  it("analytics shows clicks, installs and proceeds KPIs and columns", async () => {
    expect(await run(["analytics", "--no-color"], deps)).toBe(0);
    expect(out).toMatch(/Clicks\s+80\s+\+40/);
    expect(out).toMatch(/Installs\s+9\s+\+6/);
    expect(out).toMatch(/Proceeds\s+\$20\.00/);
    expect(out).toMatch(/Proceeds\/post\s+\$10\.00\s+2 posts with tracked links/);
    expect(out).toMatch(/CLICKS\s+INSTALLS\s+PROCEEDS/);
    expect(out).toContain("lag 2-3 days");
  });

  it("analytics top --sort installs asks the server for downloads and shows the columns", async () => {
    expect(await run(["analytics", "top", "--sort", "installs", "--no-color"], deps)).toBe(0);
    expect(last("GET", "/api/analytics/posts")!.query.get("sort")).toBe("downloads");
    expect(out).toMatch(/INSTALLS\s+PROCEEDS/);
    expect(out).toMatch(/42\s+7\s+\$12\.50/);
    expect(await run(["analytics", "top", "--sort", "proceeds"], deps)).toBe(0);
    expect(last("GET", "/api/analytics/posts")!.query.get("sort")).toBe("proceeds");
    expect(await run(["analytics", "top", "--sort", "nope"], deps)).toBe(2);
  });

  it("playbooks stats --sort maps to the server values and shows installs / proceeds", async () => {
    expect(await run(["playbooks", "stats", "--sort", "installs", "--no-color"], deps)).toBe(0);
    expect(last("GET", "/api/playbooks/stats")!.query.get("sort")).toBe("downloads");
    expect(out).toMatch(/INSTALLS\s+PROCEEDS/);
    expect(out).toMatch(/launch\s+Launch\s+↑ \+10%\s+2%\s+900\s+8\s+11\s+\$33\.50\s+low/);
    out = "";
    expect(await run(["playbooks", "stats", "--sort", "proceeds-per-post", "--no-color"], deps)).toBe(0);
    expect(last("GET", "/api/playbooks/stats")!.query.get("sort")).toBe("proceedsPerPost");
    expect(out).toMatch(/INSTALLS\/POST\s+PROCEEDS\/POST/);
    expect(out).toMatch(/2\.8\s+\$8\.38/);
    expect(await run(["playbooks", "stats", "--sort", "views"], deps)).toBe(2);
  });
});
