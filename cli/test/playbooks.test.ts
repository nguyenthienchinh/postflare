import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePlaybookRef } from "../src/commands/playbooks.js";
import type { Deps } from "../src/context.js";
import { run } from "../src/main.js";

// Playbook commands and --playbook attribution against a fake API (fetch is injected).

const dir = mkdtempSync(join(tmpdir(), "postflare-pb-"));
const NOW = new Date(2026, 9, 12, 10, 30, 0, 0);

const ACCOUNTS = [{ id: "acc_x", provider: "x", name: "Tempo", username: "tempoapp", status: "active", statusMessage: null, metricsStatus: { status: "ok", message: null, checkedAt: 1, metrics: null } }];
const PROVIDERS = [{ id: "x", name: "X", category: "social", auth: "oauth2", capabilities: { maxLength: 280, text: "optional", media: { images: 4, videos: 1, mixed: false, required: false }, thread: true }, settingsFields: [] }];
const SUMMARY = {
  id: "text-thread",
  slug: "text-thread",
  version: 1,
  name: "Text thread",
  summary: "A thread whose first post stands alone.",
  goal: "reach",
  platforms: ["microblog"],
  formats: ["thread"],
  tags: ["thread"],
  inputs: ["topic"],
  builtin: true,
  basedOn: null,
  archived: false,
  updatedAt: null,
};
const row = (o: object) => ({ playbookId: "text-thread", name: "Text thread", builtin: true, posts: 12, accounts: 1, medianEngagementRate: 0.031, meanEngagementRate: 0.03, medianViews: 1800, lift: 0.42, liftPosts: 12, confidence: "low", ...o });
const STATS = {
  from: 0,
  to: 1,
  days: 90,
  platform: null,
  accountId: null,
  postsAnalyzed: 30,
  capped: false,
  baseline: row({ playbookId: null, name: "No playbook", builtin: false, posts: 18, lift: 0.01, confidence: "low" }),
  playbooks: [{ ...row({}), versions: [row({ version: 1 })], variants: [row({ variant: "A", posts: 6, lift: 0.6 }), row({ variant: "B", posts: 6, lift: 0.2 })] }],
  method: "…correlation…",
};

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
      case "GET /api/playbooks":
        return json(u.searchParams.get("q") === "nothing" ? [] : [{ ...SUMMARY, score: 12 }]);
      case "GET /api/playbooks/text-thread":
        return json({ ...SUMMARY, latestVersion: 1, versions: [1], body: "## When to use\n…", markdown: "---\nid: text-thread\n---\n\n## When to use\n…\n", checklist: ["First post stands alone"], prompt: "PROMPT for acc_x" });
      case "GET /api/playbooks/stats":
        return json(STATS);
      case "POST /api/posts":
        return json(body.posts.map((p: any, i: number) => ({ id: `pst_${i + 1}`, groupId: "grp", accountId: p.accountId, status: "draft", scheduledAt: null, content: p.content, media: [], settings: {}, thread: [], externalId: null, externalUrl: null, error: null, attempts: 0, createdAt: 0, updatedAt: 0, publishedAt: null, playbookId: body.playbookId, playbookVersion: body.playbookVersion ?? 1, variant: body.variant ?? null })), 201);
      case "GET /api/posts/pst_1":
        return json({ id: "pst_1", groupId: "grp", accountId: "acc_x", status: "draft", scheduledAt: null, content: "x", media: [], settings: {}, thread: [], externalId: null, externalUrl: null, error: null, attempts: 0, createdAt: 0, updatedAt: 0, publishedAt: null, playbookId: "text-thread", playbookVersion: 1, variant: "A", logs: [] });
      case "PATCH /api/posts/pst_1":
        return json({ id: "pst_1", accountId: "acc_x", status: "draft", ...body });
      case "GET /api/posts":
        return json([]);
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

const last = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path).at(-1)!;

describe("playbooks commands", () => {
  it("parses id@version", () => {
    expect(parsePlaybookRef("text-thread")).toEqual({ id: "text-thread" });
    expect(parsePlaybookRef("pbk_abc@3")).toEqual({ id: "pbk_abc", version: 3 });
    expect(() => parsePlaybookRef("a@b@c")).toThrow(/id>@<version/);
  });

  it("lists and searches with filters", async () => {
    expect(await run(["playbooks", "--platform", "x", "--goal", "reach", "--no-color"], deps)).toBe(0);
    expect(Object.fromEntries(last("GET", "/api/playbooks").query)).toEqual({ platform: "x", goal: "reach" });
    expect(out).toMatch(/text-thread\s+reach\s+microblog\s+Text thread/);
    expect(await run(["playbooks", "search", "thread", "hooks", "--format", "thread"], deps)).toBe(0);
    expect(Object.fromEntries(last("GET", "/api/playbooks").query)).toEqual({ q: "thread hooks", format: "thread" });
    // `playbooks <words>` searches too.
    expect(await run(["playbooks", "nothing"], deps)).toBe(0);
    expect(out).toContain('No playbook matches "nothing".');
  });

  it("show prints the markdown, --prompt the agent prompt (narrowed to an account)", async () => {
    expect(await run(["playbooks", "show", "text-thread", "--no-color"], deps)).toBe(0);
    expect(out).toContain("# text-thread v1 · built-in");
    expect(out).toContain("## When to use");
    out = "";
    expect(await run(["playbooks", "show", "text-thread@1", "--prompt", "-a", "@tempoapp"], deps)).toBe(0);
    expect(out.trim()).toBe("PROMPT for acc_x");
    expect(Object.fromEntries(last("GET", "/api/playbooks/text-thread").query)).toEqual({ version: "1", accountId: "acc_x" });
  });

  it("stats prints the ranking with variants and the baseline", async () => {
    expect(await run(["playbooks", "stats", "--days", "30", "--platform", "x", "--no-color"], deps)).toBe(0);
    expect(Object.fromEntries(last("GET", "/api/playbooks/stats").query)).toEqual({ days: "30", platform: "x" });
    expect(out).toMatch(/text-thread\s+Text thread\s+↑ \+42%\s+3\.1%\s+1,800\s+12\s+low/);
    expect(out).toMatch(/variant A\s+↑ \+60%/);
    expect(out).toMatch(/No playbook \(baseline\)/);
    expect(out).toContain("Correlation, not causation");
    out = "";
    expect(await run(["playbooks", "stats", "--json"], deps)).toBe(0);
    expect(JSON.parse(out).playbooks[0].playbookId).toBe("text-thread");
  });
});

describe("--playbook attribution", () => {
  it("post sends playbookId, version and variant", async () => {
    expect(await run(["post", "-a", "x", "--text", "1/ hi", "--draft", "--playbook", "text-thread@1", "--variant", "A", "--json"], deps)).toBe(0);
    expect(last("POST", "/api/posts").json).toMatchObject({ scheduledAt: null, playbookId: "text-thread", playbookVersion: 1, variant: "A" });
    expect(await run(["post", "-a", "x", "--text", "hi", "--draft", "--playbook", "bad@x"], deps)).toBe(2);
  });

  it("posts edit changes or removes the attribution; posts filters by playbook; show prints it", async () => {
    expect(await run(["posts", "edit", "pst_1", "--variant", "B"], deps)).toBe(0);
    expect(last("PATCH", "/api/posts/pst_1").json).toEqual({ variant: "B" });
    expect(await run(["posts", "edit", "pst_1", "--no-playbook"], deps)).toBe(0);
    expect(last("PATCH", "/api/posts/pst_1").json).toEqual({ playbookId: null });
    expect(await run(["posts", "edit", "pst_1", "--no-playbook", "--playbook", "x"], deps)).toBe(2);
    expect(await run(["posts", "--playbook", "text-thread"], deps)).toBe(0);
    expect(last("GET", "/api/posts").query.get("playbookId")).toBe("text-thread");
    out = "";
    expect(await run(["posts", "show", "pst_1", "--no-color"], deps)).toBe(0);
    expect(out).toContain("Playbook text-thread@1 · variant A");
  });
});
