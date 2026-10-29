import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deps } from "../src/context.js";
import { run } from "../src/main.js";
import { matchGroup, resolveAccounts, usesGroups } from "../src/resolve.js";
import type { AccountDTO, AccountGroupDTO } from "../src/types.js";

// Account groups: the group:<name> selector, `accounts` GROUP column and --group, `accounts group`, `groups ...`.

const dir = mkdtempSync(join(tmpdir(), "postflare-groups-"));
const NOW = new Date(2026, 9, 12, 10, 30, 0, 0);

const acc = (id: string, provider: string, name: string, username: string, groupId: string | null, status: AccountDTO["status"] = "active") =>
  ({ id, provider, externalId: id, name, username, avatarUrl: null, profileUrl: null, status, statusMessage: null, expiresAt: null, createdAt: 0, groupId, metricsStatus: { status: "ok", message: null, checkedAt: 1, metrics: null } }) as AccountDTO;
const grp = (id: string, name: string, position: number, accountCount: number): AccountGroupDTO => ({ id, name, color: "violet", position, accountCount, createdAt: 0, updatedAt: 0 });

const ACCOUNTS = [
  acc("acc_pg_ig", "instagram_standalone", "Party Games", "partygames", "agr_pg"),
  acc("acc_pg_yt", "youtube", "Party Games", "PartyGamesYT", "agr_pg"),
  acc("acc_pg_old", "tiktok", "Party Games old", "pg_old", "agr_pg", "disabled"),
  acc("acc_ao_ig", "instagram_standalone", "Airport Officer", "airportofficer", "agr_ao"),
  acc("acc_pf_x", "x", "Postflare", "postflareio", null),
];
const GROUPS = [grp("agr_pg", "Party Games", 0, 3), grp("agr_ao", "Airport Officer", 1, 1), grp("agr_empty", "Empty", 2, 0)];
const PROVIDERS = ["instagram_standalone", "youtube", "tiktok", "x"].map((id) => ({
  id,
  name: id,
  category: "social",
  auth: "oauth2",
  capabilities: { maxLength: 2200, text: "optional", media: { images: 4, videos: 1, mixed: false, required: false }, thread: false },
  settingsFields: [],
}));

describe("group:<name> selector", () => {
  it("expands to the group's enabled accounts, deduplicated with other selectors", () => {
    expect(usesGroups(["x", "group:Party Games"])).toBe(true);
    expect(usesGroups(["x,GROUP:agr_pg"])).toBe(true);
    expect(usesGroups(["x", "tiktok:@pg_old"])).toBe(false);
    expect(resolveAccounts(["group:party games"], ACCOUNTS, GROUPS).map((a) => a.id)).toEqual(["acc_pg_ig", "acc_pg_yt"]);
    expect(resolveAccounts(["acc_pg_yt,group:agr_pg", "x"], ACCOUNTS, GROUPS).map((a) => a.id)).toEqual(["acc_pg_yt", "acc_pg_ig", "acc_pf_x"]);
  });

  it("errors name the groups, and empty groups", () => {
    expect(() => resolveAccounts(["group:Nope"], ACCOUNTS, GROUPS)).toThrow(/No account group matches "Nope"[\s\S]*agr_pg  Party Games[\s\S]*agr_ao/);
    expect(() => resolveAccounts(["group:Empty"], ACCOUNTS, GROUPS)).toThrow(/Group "Empty" has no accounts/);
    expect(() => matchGroup("x", [])).toThrow(/no groups yet/);
    // Ambiguous selectors now mention group selectors.
    expect(() => resolveAccounts(["instagram_standalone"], ACCOUNTS, GROUPS)).toThrow(/group:<name>/);
  });
});

interface Call {
  method: string;
  path: string;
  json: any;
}

function fakeApi() {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method, path: u.pathname, json: body });
    const route = `${init.method} ${u.pathname}`;
    switch (route) {
      case "GET /api/accounts":
        return json(ACCOUNTS);
      case "GET /api/account-groups":
        return json(GROUPS);
      case "GET /api/providers":
        return json(PROVIDERS);
      case "POST /api/accounts/group":
        return json({ ok: true, updated: body.accountIds.length, groupId: body.groupId });
      case "POST /api/account-groups":
        return json({ ...grp("agr_new", body.name, 3, 0), color: body.color ?? "red" }, 201);
      case "PATCH /api/account-groups/agr_pg":
        return json({ ...GROUPS[0], ...body });
      case "DELETE /api/account-groups/agr_ao":
        return json({ ok: true, ungrouped: 1 });
      case "POST /api/posts/validate":
        return json({ errors: [] });
      case "POST /api/posts":
        return json(
          body.posts.map((p: any, i: number) => ({ id: `pst_${i + 1}`, groupId: "grp", accountId: p.accountId, status: "scheduled", scheduledAt: body.scheduledAt, content: p.content, media: [], settings: {}, thread: [], externalId: null, externalUrl: null, error: null, attempts: 0, createdAt: 0, updatedAt: 0, publishedAt: null })),
          201,
        );
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
    fetch: api.fetch as any,
    env: { POSTFLARE_URL: "https://pf.test/", POSTFLARE_API_KEY: "pf_test", POSTFLARE_CONFIG: join(dir, "none.json"), POSTFLARE_NO_VERSION_CHECK: "1" },
    readStdin: async () => null,
    now: () => NOW,
  };
});

afterEach(() => vi.restoreAllMocks());

const last = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path).at(-1);

describe("accounts with groups", () => {
  it("shows a GROUP column", async () => {
    expect(await run(["accounts", "--no-color"], deps)).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/USERNAME\s+GROUP\s+STATUS/);
    expect(lines.find((l) => l.includes("acc_ao_ig"))).toMatch(/Airport Officer\s+active/);
    expect(lines.find((l) => l.includes("acc_pf_x"))).toMatch(/@postflareio\s+-\s+active/);
  });

  it("--group filters by name, id or none; --json adds the group", async () => {
    expect(await run(["accounts", "--group", "party games", "--json"], deps)).toBe(0);
    const rows = JSON.parse(out);
    expect(rows.map((a: any) => a.id)).toEqual(["acc_pg_ig", "acc_pg_yt", "acc_pg_old"]);
    expect(rows[0].group).toEqual({ id: "agr_pg", name: "Party Games" });
    out = "";
    expect(await run(["accounts", "--group", "none", "--json"], deps)).toBe(0);
    expect(JSON.parse(out).map((a: any) => a.id)).toEqual(["acc_pf_x"]);
    expect(await run(["accounts", "--group", "Nope"], deps)).toBe(2);
    expect(err).toMatch(/No account group matches "Nope"/);
  });

  it("works against servers without groups (no column)", async () => {
    const fetch = api.fetch;
    deps.fetch = (async (url: string, init: any) => (new URL(url).pathname === "/api/account-groups" ? new Response('{"error":"Not found"}', { status: 404 }) : fetch(url, init))) as any;
    expect(await run(["accounts", "--no-color"], deps)).toBe(0);
    expect(out.split("\n")[0]).not.toMatch(/GROUP/);
  });

  it("accounts group moves accounts in one request (selectors, group:<name>, --to none)", async () => {
    expect(await run(["accounts", "group", "acc_pf_x", "instagram_standalone:@airportofficer", "--to", "Party Games", "--no-color"], deps)).toBe(0);
    expect(last("POST", "/api/accounts/group")!.json).toEqual({ accountIds: ["acc_pf_x", "acc_ao_ig"], groupId: "agr_pg" });
    expect(out).toContain("Moved 2 accounts to Party Games");
    expect(await run(["accounts", "group", "group:Airport Officer", "--to", "none"], deps)).toBe(0);
    expect(last("POST", "/api/accounts/group")!.json).toEqual({ accountIds: ["acc_ao_ig"], groupId: null });
    expect(await run(["accounts", "group", "acc_pf_x"], deps)).toBe(2);
    expect(err).toMatch(/--to/);
  });
});

describe("groups commands", () => {
  it("lists groups", async () => {
    expect(await run(["groups", "--no-color"], deps)).toBe(0);
    expect(out).toMatch(/agr_pg\s+Party Games\s+violet\s+3/);
  });

  it("create, rename, rm", async () => {
    expect(await run(["groups", "create", "Postflare", "--color", "orange"], deps)).toBe(0);
    expect(last("POST", "/api/account-groups")!.json).toEqual({ name: "Postflare", color: "orange" });
    expect(await run(["groups", "create", "Bad", "--color", "plaid"], deps)).toBe(2);
    expect(await run(["groups", "rename", "party games", "Party Games 2"], deps)).toBe(0);
    expect(last("PATCH", "/api/account-groups/agr_pg")!.json).toEqual({ name: "Party Games 2" });
    expect(await run(["groups", "rename", "agr_pg", "--color", "teal"], deps)).toBe(0);
    expect(last("PATCH", "/api/account-groups/agr_pg")!.json).toEqual({ color: "teal" });
    expect(await run(["groups", "rename", "agr_pg"], deps)).toBe(2);
    out = "";
    expect(await run(["groups", "rm", "Airport Officer", "--no-color"], deps)).toBe(0);
    expect(out).toContain("Deleted Airport Officer (1 account now ungrouped)");
  });
});

describe("post -a group:<name>", () => {
  it("posts to every enabled account of the group", async () => {
    expect(await run(["post", "-a", "group:Party Games", "--text", "New level!", "--at", "tomorrow 9:00"], deps)).toBe(0);
    expect(last("POST", "/api/posts")!.json.posts.map((p: any) => p.accountId)).toEqual(["acc_pg_ig", "acc_pg_yt"]);
  });

  it("does not load groups for plain selectors", async () => {
    expect(await run(["post", "-a", "x", "--text", "Hi", "--draft"], deps)).toBe(0);
    expect(api.calls.some((c) => c.path === "/api/account-groups")).toBe(false);
  });
});
