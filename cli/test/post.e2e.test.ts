import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import type { Deps } from "../src/context.js";

// The whole CLI against a fake Postflare API (fetch is injected): account resolution, uploads, settings, payloads.

const dir = mkdtempSync(join(tmpdir(), "postflare-e2e-"));
const NOW = new Date(2026, 9, 12, 10, 30, 0, 0); // Monday

const ACCOUNTS = [
  { id: "acc_ig", provider: "instagram_standalone", name: "My App", username: "myapp", status: "active", statusMessage: null, metricsStatus: { status: "ok", message: null, checkedAt: 1, metrics: { followers: 5230 } } },
  { id: "acc_tt", provider: "tiktok", name: "My App TT", username: "myapp_tt", status: "active", statusMessage: null, metricsStatus: { status: "reconnect_required", message: "Reconnect to grant video.list", checkedAt: 1, metrics: null } },
  { id: "acc_x", provider: "x", name: "Fiona", username: "fiona", status: "active", statusMessage: null, metricsStatus: { status: "ok", message: null, checkedAt: 1, metrics: { followers: 99 } } },
  { id: "acc_bs", provider: "bluesky", name: "Fiona", username: "fiona.bsky.social", status: "active", statusMessage: null, metricsStatus: { status: "pending", message: null, checkedAt: null, metrics: null } },
];

const sel = (key: string, def: string | undefined, values: string[], extra: object = {}) => ({ key, label: key, type: "select", default: def, options: values.map((v) => ({ value: v, label: v })), ...extra });

const PROVIDERS = [
  {
    id: "instagram_standalone",
    name: "Instagram",
    category: "social",
    auth: "oauth2",
    capabilities: { maxLength: 2200, text: "optional", media: { images: 10, videos: 10, mixed: true, required: true }, thread: true, threadLabel: "Comments" },
    settingsFields: [sel("post_type", "post", ["post", "story"]), { key: "share_to_feed", label: "Share to feed", type: "checkbox", default: true }],
  },
  {
    id: "tiktok",
    name: "TikTok",
    category: "video",
    auth: "oauth2",
    capabilities: { maxLength: 2200, text: "optional", media: { images: 35, videos: 1, mixed: false, required: true }, thread: false },
    settingsFields: [
      sel("postMode", "direct", ["direct", "inbox"]),
      sel("privacy_level", undefined, ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], { required: true, dynamicOptions: true, showIf: { key: "postMode", equals: "direct" } }),
    ],
  },
  { id: "x", name: "X", category: "social", auth: "oauth2", capabilities: { maxLength: 280, text: "optional", media: { images: 4, videos: 1, mixed: false, required: false }, thread: true }, settingsFields: [sel("replySettings", "everyone", ["everyone", "following"])] },
  { id: "bluesky", name: "Bluesky", category: "social", auth: "credentials", capabilities: { maxLength: 300, text: "optional", media: { images: 4, videos: 1, mixed: false, required: false }, thread: true }, settingsFields: [] },
];

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  json: any;
  size: number;
}

function fakeApi() {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const raw = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array();
    const isJson = init.headers?.["content-type"] === "application/json";
    const call: Call = { method: init.method, path: u.pathname, query: u.searchParams, headers: init.headers, json: isJson ? JSON.parse(new TextDecoder().decode(raw)) : null, size: raw.length };
    calls.push(call);
    if (init.headers.authorization !== "Bearer pf_test") return json({ error: "Unauthorized" }, 401);
    const route = `${init.method} ${u.pathname}`;
    switch (route) {
      case "GET /api/accounts":
        return json(ACCOUNTS);
      case "GET /api/providers":
        return json(PROVIDERS);
      case "POST /api/media":
        return json({ id: "med_up1", filename: decodeURIComponent(init.headers["x-filename"]), mime: init.headers["content-type"], size: raw.length, kind: "video", width: null, height: null, duration: null, alt: null, url: "", createdAt: 0 });
      case "POST /api/posts/validate": {
        const errors = call.json.posts.filter((p: any) => p.accountId === "acc_x" && p.content.length > 280).map(() => "X: 300/280 characters");
        return json({ errors });
      }
      case "POST /api/posts": {
        const body = call.json;
        return json(
          body.posts.map((p: any, i: number) => ({
            id: `pst_${i + 1}`,
            groupId: "grp_1",
            accountId: p.accountId,
            status: body.scheduledAt === null ? "draft" : "scheduled",
            scheduledAt: body.scheduledAt === "now" ? NOW.getTime() : body.scheduledAt,
            content: p.content,
            media: p.media,
            settings: p.settings,
            thread: p.thread,
            externalId: null,
            externalUrl: null,
            error: null,
            attempts: 0,
            createdAt: 0,
            updatedAt: 0,
            publishedAt: null,
          })),
          201,
        );
      }
      case "GET /api/posts/pst_1":
        return json({ id: "pst_1", groupId: "grp_1", accountId: "acc_tt", status: "scheduled", scheduledAt: NOW.getTime() + 3_600_000, content: "Old", media: ["med_1"], settings: { postMode: "direct", privacy_level: "SELF_ONLY" }, thread: [], externalId: null, externalUrl: null, error: null, attempts: 0, createdAt: 0, updatedAt: 0, publishedAt: null, logs: [] });
      case "POST /api/posts/pst_nc/resolve":
        return json({ id: "pst_nc", accountId: "acc_x", status: call.json.published ? "published" : "scheduled", externalUrl: call.json.url ?? null, error: null });
      case "PATCH /api/posts/pst_1":
        return json({ id: "pst_1", accountId: "acc_tt", status: "scheduled", scheduledAt: NOW.getTime() + 86_400_000, ...call.json });
    }
    return json({ error: `Not found: ${route}` }, 404);
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
    fetch: api.fetch,
    env: { POSTFLARE_URL: "https://pf.test/", POSTFLARE_API_KEY: "pf_test", POSTFLARE_CONFIG: join(dir, "none.json") },
    readStdin: async () => null,
    now: () => NOW,
  };
});

afterEach(() => vi.restoreAllMocks());

const created = () => api.calls.find((c) => c.method === "POST" && c.path === "/api/posts")?.json;

describe("post", () => {
  it("uploads local files, resolves accounts, fills defaults, applies scoped settings and schedules", async () => {
    const clip = join(dir, "reel.mp4");
    writeFileSync(clip, new Uint8Array(2048).fill(3));
    const code = await run(
      ["post", "-a", "instagram_standalone", "-a", "@myapp_tt", "--text", "New feature 🎉", "-m", clip, "-m", "med_existing", "--at", "tomorrow 18:00", "--set", "tiktok.privacy_level=public_to_everyone", "--thread", "Link in bio", "--json"],
      deps,
    );
    expect(code).toBe(0);
    expect(err.trim()).toBe("! TikTok does not support follow-ups: --thread is ignored for My App TT (@myapp_tt)");
    const upload = api.calls.find((c) => c.path === "/api/media")!;
    expect(upload.headers).toMatchObject({ "content-type": "video/mp4", "x-filename": "reel.mp4", "content-length": "2048" });
    expect(upload.size).toBe(statSync(clip).size);
    expect(created()).toEqual({
      scheduledAt: new Date(2026, 9, 13, 18, 0).getTime(),
      posts: [
        { accountId: "acc_ig", content: "New feature 🎉", media: ["med_up1", "med_existing"], settings: { post_type: "post", share_to_feed: true }, thread: [{ content: "Link in bio", media: [] }] },
        // TikTok has no follow-ups: the thread is left out for it.
        { accountId: "acc_tt", content: "New feature 🎉", media: ["med_up1", "med_existing"], settings: { postMode: "direct", privacy_level: "PUBLIC_TO_EVERYONE" }, thread: [] },
      ],
    });
    const printed = JSON.parse(out);
    expect(printed.map((p: any) => p.id)).toEqual(["pst_1", "pst_2"]);
    // Authenticated with the env key against the normalized URL.
    expect(api.calls.every((c) => c.headers.authorization === "Bearer pf_test")).toBe(true);
  });

  it("refuses to schedule without the required TikTok privacy, naming the --set to use (nothing uploaded)", async () => {
    const code = await run(["post", "-a", "tiktok", "-m", join(dir, "reel.mp4"), "--now"], deps);
    expect(code).toBe(1);
    expect(err).toContain("--set tiktok.privacy_level=…  (PUBLIC_TO_EVERYONE | SELF_ONLY)");
    expect(api.calls.some((c) => c.path === "/api/media" || c.path === "/api/posts")).toBe(false);
  });

  it("drafts do not need required settings; text comes from stdin", async () => {
    deps.readStdin = async (implicit) => (implicit ? "From a pipe\n" : null);
    expect(await run(["post", "-a", "tiktok", "--draft"], deps)).toBe(0);
    expect(created()).toMatchObject({ scheduledAt: null, posts: [{ accountId: "acc_tt", content: "From a pipe" }] });
    expect(out).toContain("Saved draft");
  });

  it("text from a file and --now", async () => {
    const f = join(dir, "caption.txt");
    writeFileSync(f, "Line 1\nLine 2\n");
    expect(await run(["post", "-a", "x,bluesky", "--text-file", f, "--now"], deps)).toBe(0);
    expect(created()).toMatchObject({ scheduledAt: "now", posts: [{ accountId: "acc_x", content: "Line 1\nLine 2", settings: { replySettings: "everyone" } }, { accountId: "acc_bs", settings: {} }] });
  });

  it("--dry-run validates without creating; validation errors exit 1", async () => {
    expect(await run(["post", "-a", "x", "--text", "ok", "--at", "in 2h", "--dry-run"], deps)).toBe(0);
    expect(out).toContain("Valid for X");
    expect(created()).toBeUndefined();
    expect(await run(["post", "-a", "x", "--text", "y".repeat(300), "--now", "--dry-run"], deps)).toBe(1);
    expect(err).toContain("X: 300/280 characters");
  });

  it("usage errors: ambiguous account, no time, past time, unknown setting", async () => {
    expect(await run(["post", "-a", "fiona", "--text", "x", "--now"], deps)).toBe(2);
    expect(err).toMatch(/"fiona" matches 2 accounts[\s\S]*acc_x[\s\S]*acc_bs/);
    expect(await run(["post", "-a", "x", "--text", "x"], deps)).toBe(2);
    expect(err).toContain("Say when");
    expect(await run(["post", "-a", "x", "--text", "x", "--at", "2026-10-01 09:00"], deps)).toBe(2);
    expect(err).toContain("is in the past");
    expect(await run(["post", "-a", "x", "--text", "x", "--now", "--set", "privacy=public"], deps)).toBe(2);
    expect(err).toContain('Unknown setting "privacy"');
    expect(created()).toBeUndefined();
  });

  it("API errors print the server message and exit 1", async () => {
    deps.env = { ...deps.env, POSTFLARE_API_KEY: "pf_wrong" };
    expect(await run(["accounts"], deps)).toBe(1);
    expect(err).toContain("Unauthorized (check your API key: postflare login)");
  });
});

describe("other commands against the fake API", () => {
  it("posts edit merges settings and reschedules", async () => {
    expect(await run(["posts", "edit", "pst_1", "--at", "tomorrow 9:00", "--set", "privacy_level=PUBLIC_TO_EVERYONE", "--text", "New"], deps)).toBe(0);
    const patch = api.calls.find((c) => c.method === "PATCH")!.json;
    expect(patch).toEqual({ content: "New", scheduledAt: new Date(2026, 9, 13, 9, 0).getTime(), settings: { postMode: "direct", privacy_level: "PUBLIC_TO_EVERYONE" } });
  });

  it("posts resolve marks a needs_check post published (with URL) or retries it", async () => {
    expect(await run(["posts", "resolve", "pst_nc", "--published", "--url", "https://x.com/fiona/status/1"], deps)).toBe(0);
    expect(api.calls.at(-1)!.json).toEqual({ published: true, url: "https://x.com/fiona/status/1" });
    expect(out).toContain("Marked as published: pst_nc");
    expect(await run(["posts", "resolve", "pst_nc", "--retry"], deps)).toBe(0);
    expect(api.calls.at(-1)!.json).toEqual({ published: false });
    const n = api.calls.length;
    expect(await run(["posts", "resolve", "pst_nc"], deps)).toBe(2);
    expect(await run(["posts", "resolve", "pst_nc", "--retry", "--url", "https://x.com/a"], deps)).toBe(2);
    expect(await run(["posts", "resolve", "pst_nc", "--published", "--url", "nope"], deps)).toBe(2);
    expect(api.calls.length).toBe(n);
  });

  it("accounts table shows followers and analytics state", async () => {
    expect(await run(["accounts", "--no-color"], deps)).toBe(0);
    expect(out).toMatch(/acc_ig\s+instagram_standalone\s+My App\s+@myapp\s+active\s+5,230\s+ok/);
    expect(out).toContain("reconnect_required");
    expect(out).toContain("Reconnect to grant video.list");
  });

  it("login saves a 0600 config after checking the key; whoami reads it", async () => {
    const cfgPath = join(dir, "cfg", "config.json");
    const env = { POSTFLARE_CONFIG: cfgPath };
    const me = { user: { id: "usr_1", name: "Fiona", email: "f@example.com", role: { id: "r", name: "Admin" } }, instancePermissions: [], workspaces: [{ id: "ws_1", name: "Apps", role: { id: "o", name: "Owner" }, permissions: ["posts.write"] }], currentWorkspaceId: "ws_1" };
    const fetch = async (url: string, init: any) =>
      init.headers.authorization === "Bearer pf_good" && url === "https://pf.example.com/api/me" ? new Response(JSON.stringify(me)) : new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    expect(await run(["login", "--url", "pf.example.com/", "--key", "pf_bad"], { ...deps, env, fetch })).toBe(1);
    expect(err).toContain("Login failed");
    expect(await run(["login", "--url", "pf.example.com/", "--profile", "work"], { ...deps, env, fetch, readStdin: async () => "pf_good\n" })).toBe(0);
    const saved = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(saved).toEqual({ current: "work", profiles: { work: { url: "https://pf.example.com", key: "pf_good" } } });
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    out = "";
    expect(await run(["whoami", "--json"], { ...deps, env, fetch })).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ url: "https://pf.example.com", profile: "work", source: "config", workspace: { name: "Apps" } });
    expect(await run(["logout"], { ...deps, env, fetch })).toBe(0);
    expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toEqual({ profiles: {} });
  });
});
