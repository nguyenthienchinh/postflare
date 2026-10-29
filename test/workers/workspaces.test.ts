import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AccountElsewhereError, saveConnectedAccounts } from "../../worker/lib/accounts";
import { acceptAsNewUser, call, login, me, sessionCookie, type Client } from "./helpers";

// One instance, shared by the tests below (they run in order):
// - Fiona: instance Admin, Owner of "Fiona" (wsF)
// - Alex: instance Member, Owner of "Alex" (wsA), invited into a new workspace
// - Vera (Viewer), Emre (Editor), Wade (workspace Admin) in wsF
const PW = "password123";
const F_EMAIL = "fiona@example.com";

let fiona: Client;
let alex: Client;
let vera: Client;
let emre: Client;
let wade: Client;
let wsF: string;
let wsA: string;
const ids: Record<string, string> = {};

async function invite(by: Client, body: Record<string, unknown>) {
  const res = await call(by, "/api/invitations", { body });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${res.text}`);
  return res.json as { id: string; url: string; expiresAt: number };
}

async function connectWebhook(client: Client, name: string, url: string) {
  const res = await call(client, "/api/connect/webhook", { body: { values: { name, url } } });
  return res;
}

async function upload(client: Client, name: string) {
  const res = await call(client, "/api/media", {
    method: "POST",
    raw: new Uint8Array([1, 2, 3, 4]),
    headers: { "content-type": "image/png", "x-filename": name, "content-length": "4" },
  });
  if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${res.text}`);
  return res.json.id as string;
}

beforeAll(async () => {
  const status = await call(null, "/api/auth/status");
  expect(status.json).toEqual({ setup: false, authenticated: false });
  const setup = await call(null, "/api/auth/setup", { body: { name: "Fiona", email: F_EMAIL, password: PW, workspaceName: "Fiona" } });
  expect(setup.status).toBe(200);
  fiona = { cookie: sessionCookie(setup.headers)! };
  wsF = (await me(fiona)).currentWorkspaceId;
  fiona.ws = wsF;

  const a = await invite(fiona, { email: "alex@example.com", instanceRoleId: "role_instance_member", workspaceId: null, newWorkspaceName: "Alex" });
  const accepted = await acceptAsNewUser(a.url, "Alex", "alex@example.com");
  wsA = accepted.workspaceId;
  alex = { cookie: accepted.cookie, ws: wsA };

  const inviteInto = async (role: string, name: string) => {
    const inv = await invite(fiona, { instanceRoleId: "role_instance_member", workspaceId: wsF, workspaceRoleId: role });
    const r = await acceptAsNewUser(inv.url, name, `${name.toLowerCase()}@example.com`);
    expect(r.workspaceId).toBe(wsF);
    return { cookie: r.cookie, ws: wsF };
  };
  vera = await inviteInto("role_ws_viewer", "Vera");
  emre = await inviteInto("role_ws_editor", "Emre");
  wade = await inviteInto("role_ws_admin", "Wade");

  // Content in both workspaces.
  const cf = await connectWebhook(fiona, "Fiona hook", "https://hooks.example.com/fiona");
  expect(cf.status).toBe(200);
  ids.accF = cf.json.ids[0];
  const ca = await connectWebhook(alex, "Alex hook", "https://hooks.example.com/alex");
  expect(ca.status).toBe(200);
  ids.accA = ca.json.ids[0];
  ids.medF = await upload(fiona, "f.png");
  ids.medA = await upload(alex, "a.png");
  const pf = await call(fiona, "/api/posts", { body: { scheduledAt: null, posts: [{ accountId: ids.accF, content: "F draft", media: [ids.medF] }] } });
  expect(pf.status).toBe(201);
  ids.postF = pf.json[0].id;
  const pa = await call(alex, "/api/posts", { body: { scheduledAt: null, posts: [{ accountId: ids.accA, content: "A draft", media: [ids.medA] }] } });
  expect(pa.status).toBe(201);
  ids.postA = pa.json[0].id;
  const lf = await call(fiona, "/api/upload-links", { body: { note: "F" } });
  expect(lf.status).toBe(201);
  ids.linkF = lf.json.id;
  const kf = await call(fiona, "/api/keys", { body: { name: "Fiona key" } });
  ids.keyF = kf.json.id;
  ids.tokenF = kf.json.token;
  const ka = await call(alex, "/api/keys", { body: { name: "Alex key" } });
  expect(ka.status).toBe(201);
  ids.keyA = ka.json.id;
  ids.tokenA = ka.json.token;
});

describe("setup, login, me", () => {
  it("setup only works once", async () => {
    const again = await call(null, "/api/auth/setup", { body: { name: "X", email: "x@example.com", password: PW } });
    expect(again.status).toBe(409);
    expect((await call(fiona, "/api/auth/status")).json).toEqual({ setup: true, authenticated: true });
  });

  it("logs in with email + password (case-insensitive email)", async () => {
    const ok = await login("FIONA@example.com", PW, "10.1.0.1");
    expect(ok.status).toBe(200);
    expect(ok.cookie).toBeTruthy();
    const bad = await login(F_EMAIL, "wrong-password", "10.1.0.2");
    expect(bad.status).toBe(401);
    const unknown = await login("nobody@example.com", PW, "10.1.0.3");
    expect(unknown.status).toBe(401);
  });

  it("GET /api/me describes the user, permissions and workspaces", async () => {
    const m = await me(fiona);
    expect(m.user).toMatchObject({ name: "Fiona", email: F_EMAIL, role: { id: "role_instance_admin", name: "Admin" } });
    expect(m.instancePermissions).toContain("instance.users.manage");
    expect(m.currentWorkspaceId).toBe(wsF);
    const own = m.workspaces.find((w: any) => w.id === wsF);
    expect(own).toMatchObject({ name: "Fiona", role: { id: "role_ws_owner" } });
    expect(own.viaAdmin).toBeUndefined();
    // Instance admins see every workspace, marked.
    expect(m.workspaces.find((w: any) => w.id === wsA)).toMatchObject({ name: "Alex", viaAdmin: true });

    const a = await me(alex);
    expect(a.user.role.id).toBe("role_instance_member");
    expect(a.instancePermissions).toEqual(["instance.workspaces.create"]);
    expect(a.workspaces.map((w: any) => w.id)).toEqual([wsA]);
    expect(a.workspaces[0].permissions).toContain("workspace.delete");

    const v = await me(vera);
    expect(v.workspaces).toHaveLength(1);
    expect(v.workspaces[0].permissions.sort()).toEqual(["accounts.read", "media.read", "posts.read"]);
  });

  it("stores the selected workspace on the session", async () => {
    const noHeader = { cookie: fiona.cookie };
    expect((await call(noHeader, "/api/me/workspace", { body: { workspaceId: "ws_nope" } })).status).toBe(404);
    expect((await call(noHeader, "/api/me/workspace", { body: { workspaceId: wsA } })).status).toBe(200);
    expect((await me(noHeader)).currentWorkspaceId).toBe(wsA);
    expect((await call(noHeader, "/api/accounts")).json.map((a: any) => a.id)).toEqual([ids.accA]);
    await call(noHeader, "/api/me/workspace", { body: { workspaceId: wsF } });
    expect((await me(noHeader)).currentWorkspaceId).toBe(wsF);
  });
});

describe("workspace isolation", () => {
  it("lists only the current workspace's data", async () => {
    expect((await call(alex, "/api/accounts")).json.map((a: any) => a.id)).toEqual([ids.accA]);
    expect((await call(alex, "/api/posts")).json.map((p: any) => p.id)).toEqual([ids.postA]);
    expect((await call(alex, "/api/media")).json.map((m: any) => m.id)).toEqual([ids.medA]);
    expect((await call(alex, "/api/keys")).json.map((k: any) => k.id)).toEqual([ids.keyA]);
    const overview = (await call(alex, "/api/overview")).json;
    expect(overview.counts).toEqual({ draft: 1 });
    expect(overview.accounts.total).toBe(1);
    expect((await call(fiona, "/api/accounts")).json.map((a: any) => a.id)).toEqual([ids.accF]);
  });

  it("returns 404 for ids of another workspace", async () => {
    const checks: Array<[string, string, unknown?]> = [
      ["GET", `/api/posts/${ids.postF}`],
      ["PATCH", `/api/posts/${ids.postF}`, { content: "hacked" }],
      ["DELETE", `/api/posts/${ids.postF}`],
      ["POST", `/api/posts/${ids.postF}/retry`],
      ["POST", `/api/posts/${ids.postF}/cancel`],
      ["PATCH", `/api/accounts/${ids.accF}`, { status: "disabled" }],
      ["DELETE", `/api/accounts/${ids.accF}`],
      ["POST", `/api/accounts/${ids.accF}/refresh`],
      ["GET", `/api/accounts/${ids.accF}/options/x`],
      ["PATCH", `/api/media/${ids.medF}`, { alt: "hacked" }],
      ["DELETE", `/api/media/${ids.medF}`],
      ["POST", `/api/media/multipart/${ids.medF}/complete`, { parts: [] }],
      ["PUT", `/api/media/multipart/${ids.medF}/1`, "x"],
      ["GET", `/api/upload-links/${ids.linkF}`],
      ["DELETE", `/api/keys/${ids.keyF}`],
      ["GET", `/api/workspaces/${wsF}/members`],
      ["PATCH", `/api/workspaces/${wsF}`, { name: "hacked" }],
      ["DELETE", `/api/workspaces/${wsF}`],
      ["DELETE", `/api/workspaces/${wsF}/members/${(await me(vera)).user.id}`],
    ];
    for (const [method, path, body] of checks) {
      const res = await call(alex, path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // Nothing changed in Fiona's workspace.
    const post = (await call(fiona, `/api/posts/${ids.postF}`)).json;
    expect(post.content).toBe("F draft");
    expect((await call(fiona, "/api/accounts")).json[0].status).toBe("active");
    expect((await call(fiona, "/api/media")).json[0].alt).toBeNull();
    expect((await call(fiona, "/api/keys")).json.map((k: any) => k.id)).toEqual([ids.keyF]);
  });

  it("refuses accounts and media of another workspace in posts", async () => {
    const foreignAccount = await call(alex, "/api/posts", { body: { scheduledAt: null, posts: [{ accountId: ids.accF, content: "x" }] } });
    expect(foreignAccount.status).toBe(400);
    expect(foreignAccount.json.error).toMatch(/not found/);
    const foreignMedia = await call(alex, "/api/posts", {
      body: { scheduledAt: null, posts: [{ accountId: ids.accA, content: "x", media: [ids.medF] }] },
    });
    expect(foreignMedia.status).toBe(400);
    const foreignThreadMedia = await call(alex, `/api/posts/${ids.postA}`, {
      method: "PATCH",
      body: { thread: [{ content: "t", media: [ids.medF] }] },
    });
    expect(foreignThreadMedia.status).toBe(400);
    expect((await call(alex, "/api/posts", { body: { posts: [{ accountId: ids.accA, content: "x" }], scheduledAt: null } })).status).toBe(201);
  });

  it("rejects an X-Workspace-Id the user cannot access (never falls back)", async () => {
    const res = await call({ cookie: alex.cookie, ws: wsF }, "/api/posts");
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("Workspace not found");
    expect((await call({ cookie: alex.cookie, ws: "ws_unknown" }, "/api/accounts")).status).toBe(404);
  });

  it("lets instance admins act in any workspace", async () => {
    const asAdmin = { cookie: fiona.cookie, ws: wsA };
    expect((await call(asAdmin, "/api/accounts")).json.map((a: any) => a.id)).toEqual([ids.accA]);
    expect((await call(asAdmin, `/api/posts/${ids.postA}`)).status).toBe(200);
    expect((await call(asAdmin, `/api/workspaces/${wsA}/members`)).json.map((m: any) => m.name)).toEqual(["Alex"]);
    // ...and see every key of the workspace.
    expect((await call(asAdmin, "/api/keys")).json.map((k: any) => k.id)).toEqual([ids.keyA]);
  });

  it("binds API keys to their workspace", async () => {
    const key = { key: ids.tokenA };
    expect((await call(key, "/api/accounts")).json.map((a: any) => a.id)).toEqual([ids.accA]);
    // The header is ignored for API keys.
    expect((await call(key, "/api/accounts", { headers: { "x-workspace-id": wsF } })).json.map((a: any) => a.id)).toEqual([ids.accA]);
    expect((await call(key, `/api/posts/${ids.postF}`)).status).toBe(404);
    expect((await call(key, "/api/me/workspace", { body: { workspaceId: wsA } })).status).toBe(400);
    expect((await call(key, "/api/workspaces")).json.map((w: any) => w.id)).toEqual([wsA]);
    // Even an admin's key cannot reach another workspace through /api/workspaces/:id.
    expect((await call({ key: ids.tokenF }, `/api/workspaces/${wsA}/members`)).status).toBe(404);
    expect((await call({ key: "pf_invalid" }, "/api/accounts")).status).toBe(401);
  });

  it("refuses to connect an account that is connected in another workspace", async () => {
    const res = await connectWebhook(alex, "Steal", "https://hooks.example.com/fiona");
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/already connected in another workspace/);
    // Reconnecting in the same workspace updates it in place.
    const again = await connectWebhook(fiona, "Fiona hook 2", "https://hooks.example.com/fiona");
    expect(again.json.ids).toEqual([ids.accF]);
    // All-or-nothing for multi-account connections.
    await expect(
      saveConnectedAccounts(
        env,
        "webhook",
        [
          { externalId: "https://hooks.example.com/new", name: "new", credentials: {} },
          { externalId: "https://hooks.example.com/fiona", name: "Fiona", credentials: {} },
        ],
        { workspaceId: wsA, userId: "x" },
      ),
    ).rejects.toBeInstanceOf(AccountElsewhereError);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE external_id = 'https://hooks.example.com/new'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("finishes OAuth only for the user and workspace that started it", async () => {
    const userA = (await me(alex)).user.id;
    await env.DB.prepare("INSERT INTO oauth_states (state, provider, code_verifier, user_id, workspace_id, created_at) VALUES (?, 'x', 'v', ?, ?, ?)")
      .bind("state-of-alex", userA, wsA, Date.now())
      .run();
    const res = await call({ cookie: fiona.cookie }, "/oauth/x/callback?state=state-of-alex&code=c");
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location")!.replace(/\+/g, " "))).toMatch(/started by another user/);
  });

  it("writes upload link media into the link's workspace", async () => {
    const link = await call(alex, "/api/upload-links", { body: {} });
    const token = link.json.putUrl.split("/u/")[1].split("/")[0];
    const res = await call(null, `/u/${token}/file`, {
      method: "PUT",
      raw: new Uint8Array([9, 9]),
      headers: { "content-type": "image/jpeg", "x-filename": "phone.jpg", "content-length": "2" },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT workspace_id, created_by FROM media WHERE id = ?").bind(res.json.id).first<any>();
    expect(row.workspace_id).toBe(wsA);
    expect((await call(alex, `/api/upload-links/${link.json.id}`)).json.media.map((m: any) => m.id)).toEqual([res.json.id]);
    expect((await call(fiona, "/api/media")).json.map((m: any) => m.id)).not.toContain(res.json.id);
  });
});

describe("permissions", () => {
  it("Viewer can read but not write", async () => {
    expect((await call(vera, "/api/posts")).status).toBe(200);
    expect((await call(vera, "/api/accounts")).status).toBe(200);
    expect((await call(vera, "/api/media")).status).toBe(200);
    const denied: Array<[string, string, unknown?]> = [
      ["POST", "/api/posts", { scheduledAt: null, posts: [{ accountId: ids.accF, content: "x" }] }],
      ["PATCH", `/api/posts/${ids.postF}`, { content: "x" }],
      ["DELETE", `/api/posts/${ids.postF}`],
      ["POST", "/api/upload-links", {}],
      ["POST", "/api/media/from-url", { url: "https://example.com/a.png" }],
      ["DELETE", `/api/media/${ids.medF}`],
      ["PATCH", `/api/accounts/${ids.accF}`, { status: "disabled" }],
      ["POST", "/api/connect/webhook", { values: { name: "x", url: "https://x.example.com" } }],
      ["GET", "/api/connect/x/url"],
      ["GET", "/api/keys"],
      ["POST", "/api/keys", { name: "k" }],
      ["POST", "/api/invitations", { workspaceId: wsF, workspaceRoleId: "role_ws_viewer", instanceRoleId: "role_instance_member" }],
      ["PATCH", `/api/workspaces/${wsF}`, { name: "x" }],
      ["GET", "/api/users"],
      ["PUT", "/api/platforms/x", { values: {} }],
      ["PUT", "/api/settings", { timezone: "UTC" }],
    ];
    for (const [method, path, body] of denied) {
      const res = await call(vera, path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json.error, `${method} ${path}`).toMatch(/^You (don't have permission|can only)/);
    }
    expect((await call(vera, "/api/posts", { body: { scheduledAt: null, posts: [] } })).json.error).toBe(
      "You don't have permission to create or change posts",
    );
    // Readable by everyone signed in.
    expect((await call(vera, "/api/providers")).status).toBe(200);
    expect((await call(vera, "/api/settings")).status).toBe(200);
    expect((await call(vera, "/api/roles")).status).toBe(200);
    expect((await call(vera, "/api/permissions")).json.length).toBe(18);
  });

  it("Editor writes posts and manages own keys only", async () => {
    const res = await call(emre, "/api/posts", { body: { scheduledAt: null, posts: [{ accountId: ids.accF, content: "by Emre" }] } });
    expect(res.status).toBe(201);
    const key = await call(emre, "/api/keys", { body: { name: "Emre key" } });
    expect(key.status).toBe(201);
    ids.tokenE = key.json.token;
    ids.keyE = key.json.id;
    expect((await call(emre, "/api/keys")).json.map((k: any) => k.id)).toEqual([ids.keyE]);
    expect((await call(emre, `/api/keys/${ids.keyF}`, { method: "DELETE" })).status).toBe(404);
    const inv = await call(emre, "/api/invitations", { body: { workspaceId: wsF, workspaceRoleId: "role_ws_viewer", instanceRoleId: "role_instance_member" } });
    expect(inv.status).toBe(403);
    expect((await call(emre, `/api/workspaces/${wsF}/members`)).status).toBe(200);
  });

  it("workspace Admin manages members within their own permissions", async () => {
    const veraId = (await me(vera)).user.id;
    const fionaId = (await me(fiona)).user.id;
    // Cannot create Owners (by invite or role change), cannot touch the Owner.
    const ownerInvite = await call(wade, "/api/invitations", { body: { workspaceId: wsF, workspaceRoleId: "role_ws_owner", instanceRoleId: "role_instance_admin" } });
    expect(ownerInvite.status).toBe(403);
    expect((await call(wade, `/api/workspaces/${wsF}/members/${veraId}`, { method: "PATCH", body: { roleId: "role_ws_owner" } })).status).toBe(403);
    expect((await call(wade, `/api/workspaces/${wsF}/members/${fionaId}`, { method: "PATCH", body: { roleId: "role_ws_viewer" } })).status).toBe(403);
    expect((await call(wade, `/api/workspaces/${wsF}/members/${fionaId}`, { method: "DELETE" })).status).toBe(403);
    expect((await call(wade, `/api/workspaces/${wsF}`, { method: "DELETE" })).status).toBe(403);
    // Can invite Editors (instance role forced to Member) and change Viewer -> Editor -> Viewer.
    const inv = await call(wade, "/api/invitations", { body: { workspaceId: wsF, workspaceRoleId: "role_ws_editor", instanceRoleId: "role_instance_admin" } });
    expect(inv.status).toBe(201);
    const pending = (await call(wade, "/api/invitations")).json;
    const mine = pending.find((i: any) => i.id === inv.json.id);
    expect(mine).toMatchObject({ instanceRole: { id: "role_instance_member" }, workspaceId: wsF, workspaceRole: { id: "role_ws_editor" } });
    expect((await call(alex, "/api/invitations")).json.find((i: any) => i.id === inv.json.id)).toBeUndefined();
    expect((await call(alex, `/api/invitations/${inv.json.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(wade, `/api/invitations/${inv.json.id}`, { method: "DELETE" })).status).toBe(200);
    const promoted = await call(wade, `/api/workspaces/${wsF}/members/${veraId}`, { method: "PATCH", body: { roleId: "role_ws_editor" } });
    expect(promoted.status).toBe(200);
    expect(promoted.json.role.id).toBe("role_ws_editor");
    await call(wade, `/api/workspaces/${wsF}/members/${veraId}`, { method: "PATCH", body: { roleId: "role_ws_viewer" } });
    expect((await call(wade, `/api/workspaces/${wsF}`, { method: "PATCH", body: { name: "Fiona & co" } })).json.name).toBe("Fiona & co");
  });

  it("only instance admins invite into new workspaces and manage platforms/users/settings", async () => {
    expect((await call(alex, "/api/invitations", { body: { workspaceId: null, instanceRoleId: "role_instance_member" } })).status).toBe(403);
    expect((await call(alex, "/api/platforms/x")).status).toBe(403);
    expect((await call(alex, "/api/users")).status).toBe(403);
    expect((await call(alex, "/api/roles", { body: { scope: "workspace", name: "x", permissions: [] } })).status).toBe(403);
    expect((await call(fiona, "/api/users")).json.length).toBe(5);
    expect((await call(fiona, "/api/settings", { method: "PUT", body: { timezone: "Europe/Istanbul" } })).status).toBe(200);
  });

  it("MCP tools use the key's workspace and permissions", async () => {
    const mcp = (token: string, name: string, args: unknown = {}) =>
      call({ key: token }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    const list = await mcp(ids.tokenE, "list_accounts");
    expect(JSON.parse(list.json.result.content[0].text).map((a: any) => a.id)).toEqual([ids.accF]);
    const foreign = await mcp(ids.tokenE, "get_post", { id: ids.postA });
    expect(foreign.json.result.isError).toBe(true);
    // Demote Emre to Viewer: his key can still read, but not write.
    const emreId = (await me(emre)).user.id;
    await call(fiona, `/api/workspaces/${wsF}/members/${emreId}`, { method: "PATCH", body: { roleId: "role_ws_viewer" } });
    const denied = await mcp(ids.tokenE, "create_post", { scheduledAt: null, accounts: [{ accountId: ids.accF, content: "x" }] });
    expect(denied.json.result.isError).toBe(true);
    expect(denied.json.result.content[0].text).toBe("You don't have permission to create or change posts");
    expect((await mcp(ids.tokenE, "list_posts")).json.result.isError).toBeUndefined();
    await call(fiona, `/api/workspaces/${wsF}/members/${emreId}`, { method: "PATCH", body: { roleId: "role_ws_editor" } });
  });
});

describe("role invariants", () => {
  it("a user cannot change their own instance role or disable/delete themselves", async () => {
    const fionaId = (await me(fiona)).user.id;
    expect((await call(fiona, `/api/users/${fionaId}`, { method: "PATCH", body: { roleId: "role_instance_member" } })).status).toBe(403);
    expect((await call(fiona, `/api/users/${fionaId}`, { method: "PATCH", body: { status: "disabled" } })).status).toBe(403);
    expect((await call(fiona, `/api/users/${fionaId}`, { method: "DELETE" })).status).toBe(403);
  });

  it("keeps at least one active instance Admin", async () => {
    // A custom instance role that can manage users, given to Wade.
    const role = await call(fiona, "/api/roles", {
      body: { scope: "instance", name: "Support", description: "Helps users", permissions: ["instance.users.manage", "instance.workspaces.create"] },
    });
    expect(role.status).toBe(201);
    expect(role.json).toMatchObject({ builtin: false, scope: "instance", assigned: 0 });
    const wadeId = (await me(wade)).user.id;
    expect((await call(fiona, `/api/users/${wadeId}`, { method: "PATCH", body: { roleId: role.json.id } })).status).toBe(200);
    const fionaId = (await me(fiona)).user.id;
    const demote = await call(wade, `/api/users/${fionaId}`, { method: "PATCH", body: { roleId: "role_instance_member" } });
    expect(demote.status).toBe(409);
    expect((await call(wade, `/api/users/${fionaId}`, { method: "PATCH", body: { status: "disabled" } })).status).toBe(409);
    expect((await call(wade, `/api/users/${fionaId}`, { method: "DELETE" })).status).toBe(409);
    // Roles in use cannot be deleted; built-ins cannot be changed.
    expect((await call(fiona, `/api/roles/${role.json.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await call(fiona, "/api/roles/role_ws_owner", { method: "PATCH", body: { name: "Boss" } })).status).toBe(403);
    expect((await call(fiona, `/api/roles/${role.json.id}`, { method: "PATCH", body: { permissions: ["posts.write"] } })).status).toBe(400);
    expect((await call(fiona, `/api/users/${wadeId}`, { method: "PATCH", body: { roleId: "role_instance_member" } })).status).toBe(200);
    expect((await call(fiona, `/api/roles/${role.json.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("keeps at least one Owner per workspace", async () => {
    const alexId = (await me(alex)).user.id;
    const fionaId = (await me(fiona)).user.id;
    expect((await call(alex, `/api/workspaces/${wsA}/members/${alexId}`, { method: "DELETE" })).status).toBe(409);
    expect((await call(alex, `/api/workspaces/${wsA}/members/${alexId}`, { method: "PATCH", body: { roleId: "role_ws_editor" } })).status).toBe(409);
    expect((await call(fiona, `/api/users/${alexId}`, { method: "DELETE" })).status).toBe(409);
    expect((await call(fiona, `/api/users/${alexId}`, { method: "PATCH", body: { status: "disabled" } })).status).toBe(409);
    expect((await call(fiona, `/api/workspaces/${wsF}/members/${fionaId}`, { method: "DELETE" })).status).toBe(409);
  });

  it("members can leave a workspace", async () => {
    const inv = await invite(fiona, { workspaceId: wsF, workspaceRoleId: "role_ws_viewer", instanceRoleId: "role_instance_member" });
    const temp = await acceptAsNewUser(inv.url, "Tom", "tom@example.com");
    const tom = { cookie: temp.cookie, ws: wsF };
    const tomId = (await me(tom)).user.id;
    expect((await call(tom, `/api/workspaces/${wsF}/members/${tomId}`, { method: "DELETE" })).status).toBe(200);
    expect((await me({ cookie: tom.cookie })).workspaces).toEqual([]);
    expect((await call({ cookie: tom.cookie }, "/api/posts")).status).toBe(403);
    expect((await call(fiona, `/api/users/${tomId}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(tom, "/api/me")).status).toBe(401);
  });
});

describe("users", () => {
  it("disabled users cannot log in and their sessions and keys stop working", async () => {
    const emreId = (await me(emre)).user.id;
    expect((await call({ key: ids.tokenE }, "/api/accounts")).status).toBe(200);
    const res = await call(fiona, `/api/users/${emreId}`, { method: "PATCH", body: { status: "disabled" } });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("disabled");
    expect((await call(emre, "/api/me")).status).toBe(401);
    expect((await call({ key: ids.tokenE }, "/api/accounts")).status).toBe(401);
    const mcp = await call({ key: ids.tokenE }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(mcp.status).toBe(401);
    expect((await login("emre@example.com", PW, "10.2.0.1")).status).toBe(403);
    // Re-enabled: the key works again, the user signs in again.
    await call(fiona, `/api/users/${emreId}`, { method: "PATCH", body: { status: "active" } });
    expect((await call({ key: ids.tokenE }, "/api/accounts")).status).toBe(200);
    const again = await login("emre@example.com", PW, "10.2.0.2");
    expect(again.status).toBe(200);
    emre = { cookie: again.cookie, ws: wsF };
  });

  it("lists users with their workspaces", async () => {
    const users = (await call(fiona, "/api/users")).json;
    const alexRow = users.find((u: any) => u.email === "alex@example.com");
    expect(alexRow).toMatchObject({ name: "Alex", status: "active", role: { id: "role_instance_member", name: "Member" } });
    expect(alexRow.workspaces).toEqual([{ id: wsA, name: "Alex", role: { id: "role_ws_owner", name: "Owner" } }]);
  });

  it("changing the password signs out the user's other sessions", async () => {
    const other = await login("vera@example.com", PW, "10.3.0.1");
    const res = await call(vera, "/api/me/password", { body: { current: PW, next: "new-password-1" } });
    expect(res.status).toBe(200);
    expect((await call({ cookie: other.cookie }, "/api/me")).status).toBe(401);
    const fresh = sessionCookie(res.headers)!;
    expect((await call({ cookie: fresh }, "/api/me")).status).toBe(200);
    expect((await call({ cookie: fresh }, "/api/me/password", { body: { current: "wrong", next: "whatever12" } })).status).toBe(400);
    vera = { cookie: fresh, ws: wsF };
  });

  it("updates the profile; emails stay unique", async () => {
    expect((await call(vera, "/api/me", { method: "PATCH", body: { email: F_EMAIL.toUpperCase() } })).status).toBe(409);
    const res = await call(vera, "/api/me", { method: "PATCH", body: { name: "Vera V", email: "vera.v@example.com" } });
    expect(res.json).toMatchObject({ name: "Vera V", email: "vera.v@example.com" });
  });

  it("throttles logins per email across IPs", async () => {
    for (let i = 0; i < 10; i++) expect((await login("alex@example.com", "nope-nope", `10.9.0.${i}`)).status).toBe(401);
    expect((await login("alex@example.com", PW, "10.9.1.1")).status).toBe(429);
    // Per IP: 5 failures lock the IP for every email.
    for (let i = 0; i < 5; i++) await login(`x${i}@example.com`, "nope-nope", "10.8.0.1");
    expect((await login(F_EMAIL, PW, "10.8.0.1")).status).toBe(429);
  });
});

describe("invitations", () => {
  it("looks up and accepts once; email must match", async () => {
    const inv = await invite(fiona, { email: "zoe@example.com", workspaceId: wsF, workspaceRoleId: "role_ws_editor", instanceRoleId: "role_instance_member" });
    const token = inv.url.split("/invite/")[1];
    expect(inv.url.startsWith("https://pf.test/invite/")).toBe(true);
    const lookup = await call(null, `/api/invitations/lookup/${token}`);
    expect(lookup.json).toEqual({
      email: "zoe@example.com",
      workspaceName: "Fiona & co",
      workspaceRole: { id: "role_ws_editor", name: "Editor" },
      newWorkspaceName: null,
      invitedBy: "Fiona",
      expired: false,
      accepted: false,
    });
    expect((await call(null, "/api/invitations/lookup/not-a-real-token-xxxxxxxxxx")).status).toBe(404);
    const wrong = await call(null, "/api/invitations/accept", { body: { token, name: "Z", email: "other@example.com", password: PW } });
    expect(wrong.status).toBe(400);
    const shortPw = await call(null, "/api/invitations/accept", { body: { token, name: "Z", email: "zoe@example.com", password: "short" } });
    expect(shortPw.status).toBe(400);
    const ok = await call(null, "/api/invitations/accept", { body: { token, name: "Zoe", email: "ZOE@example.com", password: PW } });
    expect(ok.status).toBe(200);
    expect(ok.json.workspaceId).toBe(wsF);
    expect((await call(null, "/api/invitations/accept", { body: { token, name: "Zoe", email: "zoe@example.com", password: PW } })).status).toBe(410);
    expect((await call(null, `/api/invitations/lookup/${token}`)).json.accepted).toBe(true);
  });

  it("a signed-in user accepts by joining", async () => {
    const inv = await invite(fiona, { workspaceId: wsF, workspaceRoleId: "role_ws_viewer", instanceRoleId: "role_instance_admin" });
    const token = inv.url.split("/invite/")[1];
    const res = await call({ cookie: alex.cookie }, "/api/invitations/accept", { body: { token } });
    expect(res.status).toBe(200);
    const m = await me({ cookie: alex.cookie });
    expect(m.currentWorkspaceId).toBe(wsF);
    expect(m.workspaces.map((w: any) => w.id).sort()).toEqual([wsA, wsF].sort());
    // The instance role of an existing user does not change.
    expect(m.user.role.id).toBe("role_instance_member");
    expect((await call({ cookie: alex.cookie, ws: wsF }, "/api/posts")).status).toBe(200);
    expect((await call({ cookie: alex.cookie, ws: wsF }, "/api/posts", { body: { scheduledAt: null, posts: [] } })).status).toBe(403);
    await call({ cookie: alex.cookie, ws: wsF }, `/api/workspaces/${wsF}/members/${m.user.id}`, { method: "DELETE" });
  });

  it("expired invitations cannot be accepted", async () => {
    const inv = await invite(fiona, { workspaceId: wsF, workspaceRoleId: "role_ws_viewer", instanceRoleId: "role_instance_member" });
    await env.DB.prepare("UPDATE invitations SET expires_at = 1 WHERE id = ?").bind(inv.id).run();
    const token = inv.url.split("/invite/")[1];
    expect((await call(null, `/api/invitations/lookup/${token}`)).json.expired).toBe(true);
    expect((await call(null, "/api/invitations/accept", { body: { token, name: "Late", email: "late@example.com", password: PW } })).status).toBe(410);
  });
});

describe("workspaces", () => {
  it("creates, renames and deletes a workspace with everything in it", async () => {
    const created = await call(alex, "/api/workspaces", { body: { name: "Temp" } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "Temp", role: { id: "role_ws_owner" }, memberCount: 1 });
    const temp: Client = { cookie: alex.cookie, ws: created.json.id };
    const acc = await connectWebhook(temp, "Temp hook", "https://hooks.example.com/temp");
    const med = await upload(temp, "t.png");
    const r2key = (await env.DB.prepare("SELECT r2_key FROM media WHERE id = ?").bind(med).first<{ r2_key: string }>())!.r2_key;
    expect(await env.MEDIA.head(r2key)).not.toBeNull();
    const post = await call(temp, "/api/posts", {
      body: { scheduledAt: Date.now() + 30 * 24 * 60 * 60 * 1000, posts: [{ accountId: acc.json.ids[0], content: "later", media: [med] }] },
    });
    expect(post.status).toBe(201);
    expect(post.json[0].status).toBe("scheduled");
    await call(temp, "/api/upload-links", { body: {} });
    await call(temp, "/api/keys", { body: { name: "temp" } });
    await invite(alex, { workspaceId: created.json.id, workspaceRoleId: "role_ws_viewer", instanceRoleId: "role_instance_member" });
    expect((await call(vera, `/api/workspaces/${created.json.id}`, { method: "DELETE" })).status).toBe(404);

    const del = await call(alex, `/api/workspaces/${created.json.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    for (const table of ["accounts", "posts", "media", "upload_links", "api_keys", "invitations", "workspace_members"]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).bind(created.json.id).first<{ n: number }>();
      expect(n?.n, table).toBe(0);
    }
    expect(await env.DB.prepare("SELECT 1 FROM post_logs WHERE post_id = ?").bind(post.json[0].id).first()).toBeNull();
    expect(await env.MEDIA.head(r2key)).toBeNull();
    expect((await call(temp, "/api/accounts")).status).toBe(404);
    // Other workspaces are untouched.
    expect((await call(alex, "/api/accounts")).json.map((a: any) => a.id)).toEqual([ids.accA]);
  });

  it("needs instance.workspaces.create to create workspaces", async () => {
    const role = await call(fiona, "/api/roles", { body: { scope: "instance", name: "Restricted", permissions: [] } });
    const veraId = (await me(vera)).user.id;
    await call(fiona, `/api/users/${veraId}`, { method: "PATCH", body: { roleId: role.json.id } });
    expect((await call(vera, "/api/workspaces", { body: { name: "Nope" } })).status).toBe(403);
    await call(fiona, `/api/users/${veraId}`, { method: "PATCH", body: { roleId: "role_instance_member" } });
  });
});
