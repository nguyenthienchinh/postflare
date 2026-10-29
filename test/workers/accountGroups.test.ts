import { beforeAll, describe, expect, it } from "vitest";
import { acceptAsNewUser, call, me, sessionCookie, type Client } from "./helpers";

// Account groups: CRUD, ordering, single and bulk assignment, delete → ungrouped, workspace isolation, permissions,
// the posts filter and MCP output.
// - Gina: Owner of wsG (3 webhook accounts), Otto: Owner of his own wsO (1 account), Vic: Viewer in wsG.

let gina: Client;
let otto: Client;
let vic: Client;
let wsG: string;
const acc: Record<string, string> = {};

async function invite(by: Client, body: Record<string, unknown>) {
  const res = await call(by, "/api/invitations", { body });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${res.text}`);
  return res.json as { url: string };
}

async function connect(client: Client, name: string) {
  const res = await call(client, "/api/connect/webhook", { body: { values: { name, url: `https://hooks.example.com/${encodeURIComponent(name)}` } } });
  expect(res.status, res.text).toBe(200);
  return res.json.ids[0] as string;
}

const createGroup = async (client: Client, body: Record<string, unknown>) => call(client, "/api/account-groups", { body });
const groups = async (client: Client) => (await call(client, "/api/account-groups")).json as any[];
const accounts = async (client: Client) => (await call(client, "/api/accounts")).json as any[];

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Gina", email: "gina@example.com", password: "password123", workspaceName: "Gina" } });
  expect(setup.status).toBe(200);
  gina = { cookie: sessionCookie(setup.headers)! };
  wsG = (await me(gina)).currentWorkspaceId;
  gina.ws = wsG;
  const o = await acceptAsNewUser((await invite(gina, { instanceRoleId: "role_instance_member", workspaceId: null, newWorkspaceName: "Otto" })).url, "Otto", "otto@example.com");
  otto = { cookie: o.cookie, ws: o.workspaceId };
  const v = await acceptAsNewUser((await invite(gina, { instanceRoleId: "role_instance_member", workspaceId: wsG, workspaceRoleId: "role_ws_viewer" })).url, "Vic", "vic@example.com");
  vic = { cookie: v.cookie, ws: wsG };
  acc.ig = await connect(gina, "Party Games IG");
  acc.yt = await connect(gina, "Party Games YT");
  acc.x = await connect(gina, "Postflare X");
  acc.otto = await connect(otto, "Otto hook");
});

describe("account groups", () => {
  const ids: Record<string, string> = {};

  it("creates groups appended in order, with a default color from the palette", async () => {
    const a = await createGroup(gina, { name: "  Party   Games " });
    expect(a.status, a.text).toBe(201);
    expect(a.json).toMatchObject({ name: "Party Games", position: 0, accountCount: 0 });
    expect(a.json.color).toMatch(/^[a-z]+$/);
    ids.party = a.json.id;
    const b = await createGroup(gina, { name: "Airport Officer", color: "sky" });
    expect(b.json).toMatchObject({ name: "Airport Officer", color: "sky", position: 1 });
    ids.airport = b.json.id;
    const c = await createGroup(gina, { name: "Postflare", color: "orange" });
    ids.postflare = c.json.id;
    expect((await groups(gina)).map((g) => g.name)).toEqual(["Party Games", "Airport Officer", "Postflare"]);
    // New accounts are ungrouped.
    expect((await accounts(gina)).every((x) => x.groupId === null)).toBe(true);
  });

  it("validates names and colors; names are unique per workspace (case-insensitive)", async () => {
    expect((await createGroup(gina, { name: "" })).status).toBe(400);
    expect((await createGroup(gina, { name: "x".repeat(51) })).status).toBe(400);
    expect((await createGroup(gina, { name: "Nope", color: "#ff0000" })).status).toBe(400);
    const dup = await createGroup(gina, { name: "party games" });
    expect(dup.status, dup.text).toBe(409);
    expect(dup.json.error).toMatch(/already exists/);
    // Same name in another workspace is fine.
    const other = await createGroup(otto, { name: "Party Games" });
    expect(other.status).toBe(201);
    ids.ottoGroup = other.json.id;
  });

  it("renames, recolors and reorders", async () => {
    const r = await call(gina, `/api/account-groups/${ids.airport}`, { method: "PATCH", body: { name: "Airport Officer 2", color: "teal" } });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ name: "Airport Officer 2", color: "teal" });
    expect((await call(gina, `/api/account-groups/${ids.airport}`, { method: "PATCH", body: { name: "Postflare" } })).status).toBe(409);
    expect((await call(gina, `/api/account-groups/${ids.airport}`, { method: "PATCH", body: { color: "plaid" } })).status).toBe(400);
    // Move Postflare to the top, then Party Games to the end (out-of-range positions clamp).
    expect((await call(gina, `/api/account-groups/${ids.postflare}`, { method: "PATCH", body: { position: 0 } })).json.position).toBe(0);
    await call(gina, `/api/account-groups/${ids.party}`, { method: "PATCH", body: { position: 99 } });
    const list = await groups(gina);
    expect(list.map((g) => [g.name, g.position])).toEqual([
      ["Postflare", 0],
      ["Airport Officer 2", 1],
      ["Party Games", 2],
    ]);
    expect((await call(gina, `/api/account-groups/${ids.party}`, { method: "PATCH", body: { position: 1.5 } })).status).toBe(400);
  });

  it("assigns one account (PATCH /accounts/:id) and many at once (POST /accounts/group)", async () => {
    const one = await call(gina, `/api/accounts/${acc.x}`, { method: "PATCH", body: { groupId: ids.postflare } });
    expect(one.status, one.text).toBe(200);
    expect(one.json.groupId).toBe(ids.postflare);
    expect(one.json.status).toBe("active");
    // Status changes still work and keep the group.
    const st = await call(gina, `/api/accounts/${acc.x}`, { method: "PATCH", body: { status: "disabled" } });
    expect(st.json).toMatchObject({ status: "disabled", groupId: ids.postflare });
    await call(gina, `/api/accounts/${acc.x}`, { method: "PATCH", body: { status: "active" } });
    expect((await call(gina, `/api/accounts/${acc.x}`, { method: "PATCH", body: {} })).status).toBe(400);

    const bulk = await call(gina, "/api/accounts/group", { body: { accountIds: [acc.ig, acc.yt, acc.ig], groupId: ids.party } });
    expect(bulk.status, bulk.text).toBe(200);
    expect(bulk.json).toMatchObject({ ok: true, updated: 2, groupId: ids.party });
    const byId = new Map((await accounts(gina)).map((a) => [a.id, a.groupId]));
    expect(byId.get(acc.ig)).toBe(ids.party);
    expect(byId.get(acc.yt)).toBe(ids.party);
    expect((await groups(gina)).find((g) => g.id === ids.party).accountCount).toBe(2);

    // Ungroup with null.
    const un = await call(gina, `/api/accounts/${acc.yt}`, { method: "PATCH", body: { groupId: null } });
    expect(un.json.groupId).toBeNull();
    await call(gina, "/api/accounts/group", { body: { accountIds: [acc.yt], groupId: ids.party } });

    expect((await call(gina, "/api/accounts/group", { body: { accountIds: [], groupId: ids.party } })).status).toBe(400);
    expect((await call(gina, "/api/accounts/group", { body: { accountIds: [acc.ig], groupId: 5 } })).status).toBe(400);
  });

  it("filters posts by account group", async () => {
    const p = await call(gina, "/api/posts", {
      body: { scheduledAt: null, posts: [{ accountId: acc.ig, content: "party" }, { accountId: acc.x, content: "pf" }] },
    });
    expect(p.status, p.text).toBe(201);
    const party = await call(gina, `/api/posts?accountGroupId=${ids.party}`);
    expect(party.json.map((x: any) => x.content)).toEqual(["party"]);
    const none = await call(gina, "/api/posts?accountGroupId=none");
    expect(none.json).toEqual([]);
    // Another workspace's group matches nothing.
    expect((await call(gina, `/api/posts?accountGroupId=${ids.ottoGroup}`)).json).toEqual([]);
  });

  it("isolates workspaces: other workspaces' groups and accounts answer 404 and change nothing", async () => {
    expect((await call(otto, `/api/account-groups/${ids.party}`, { method: "PATCH", body: { name: "Mine" } })).status).toBe(404);
    expect((await call(otto, `/api/account-groups/${ids.party}`, { method: "DELETE" })).status).toBe(404);
    expect((await groups(otto)).map((g) => g.id)).toEqual([ids.ottoGroup]);
    // Assigning Gina's group to Otto's account, or Otto's group to Gina's account.
    expect((await call(otto, `/api/accounts/${acc.otto}`, { method: "PATCH", body: { groupId: ids.party } })).status).toBe(404);
    expect((await call(gina, `/api/accounts/${acc.ig}`, { method: "PATCH", body: { groupId: ids.ottoGroup } })).status).toBe(404);
    expect((await call(otto, `/api/accounts/${acc.ig}`, { method: "PATCH", body: { groupId: ids.ottoGroup } })).status).toBe(404);
    // Bulk: a foreign account id in the list → 404 and nothing moves; a foreign group → 404.
    const mixed = await call(otto, "/api/accounts/group", { body: { accountIds: [acc.otto, acc.ig], groupId: ids.ottoGroup } });
    expect(mixed.status).toBe(404);
    expect((await accounts(otto))[0].groupId).toBeNull();
    expect((await call(gina, "/api/accounts/group", { body: { accountIds: [acc.ig], groupId: ids.ottoGroup } })).status).toBe(404);
    expect((await accounts(gina)).find((a) => a.id === acc.ig).groupId).toBe(ids.party);
  });

  it("viewers read groups but cannot change them", async () => {
    expect((await groups(vic)).length).toBe(3);
    expect((await accounts(vic)).find((a) => a.id === acc.ig).groupId).toBe(ids.party);
    expect((await createGroup(vic, { name: "Viewer group" })).status).toBe(403);
    expect((await call(vic, `/api/account-groups/${ids.party}`, { method: "PATCH", body: { name: "x" } })).status).toBe(403);
    expect((await call(vic, `/api/account-groups/${ids.party}`, { method: "DELETE" })).status).toBe(403);
    expect((await call(vic, `/api/accounts/${acc.ig}`, { method: "PATCH", body: { groupId: null } })).status).toBe(403);
    expect((await call(vic, "/api/accounts/group", { body: { accountIds: [acc.ig], groupId: null } })).status).toBe(403);
  });

  it("MCP: list_accounts includes the group and filters by it; list_account_groups", async () => {
    const key = (await call(gina, "/api/keys", { body: { name: "mcp" } })).json.token as string;
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await call({ key }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
      expect(res.status, res.text).toBe(200);
      const r = res.json.result;
      if (r.isError) throw new Error(r.content[0].text);
      return JSON.parse(r.content[0].text);
    };
    const all = await tool("list_accounts");
    expect(all.find((a: any) => a.id === acc.ig).group).toEqual({ id: ids.party, name: "Party Games" });
    expect(all.find((a: any) => a.id === acc.x).group).toEqual({ id: ids.postflare, name: "Postflare" });
    expect((await tool("list_accounts", { group: "party games" })).map((a: any) => a.id).sort()).toEqual([acc.ig, acc.yt].sort());
    expect((await tool("list_accounts", { group: ids.postflare })).map((a: any) => a.id)).toEqual([acc.x]);
    expect(await tool("list_accounts", { group: "none" })).toEqual([]);
    // Both filters combine: platform first, then group.
    expect((await tool("list_accounts", { group: "party games", platform: "webhook" })).map((a: any) => a.id).sort()).toEqual([acc.ig, acc.yt].sort());
    expect(await tool("list_accounts", { group: "party games", platform: "x" })).toEqual([]);
    await expect(tool("list_accounts", { group: "Nope" })).rejects.toThrow(/No account group matches "Nope"/);
    expect(await tool("list_account_groups")).toEqual([
      { id: ids.postflare, name: "Postflare", accounts: 1 },
      { id: ids.airport, name: "Airport Officer 2", accounts: 0 },
      { id: ids.party, name: "Party Games", accounts: 2 },
    ]);
    const list = await call({ key }, "/mcp", { body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    expect(list.json.result.tools.map((t: any) => t.name)).toContain("list_account_groups");
  });

  it("deleting a group ungroups its accounts", async () => {
    const del = await call(gina, `/api/account-groups/${ids.party}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true, ungrouped: 2 });
    const list = await accounts(gina);
    expect(list.find((a) => a.id === acc.ig).groupId).toBeNull();
    expect(list.find((a) => a.id === acc.yt).groupId).toBeNull();
    expect(list.find((a) => a.id === acc.x).groupId).toBe(ids.postflare);
    expect((await groups(gina)).map((g) => g.id)).toEqual([ids.postflare, ids.airport]);
    expect((await call(gina, `/api/account-groups/${ids.party}`, { method: "DELETE" })).status).toBe(404);
  });

  it("removing an account updates the group's count", async () => {
    await call(gina, `/api/accounts/${acc.x}`, { method: "DELETE" });
    expect((await groups(gina)).find((g) => g.id === ids.postflare).accountCount).toBe(0);
  });
});
