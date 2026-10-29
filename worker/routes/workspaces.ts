import { Hono, type Context } from "hono";
import type { MeDTO, MemberDTO, WorkspaceDTO } from "../../shared/types";
import {
  createSession,
  forbidDemoUser,
  isInstanceAdmin,
  requireInstancePermission,
  workspaceAccess,
  type AppEnv,
  type CurrentWorkspace,
} from "../lib/auth";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { DEMO_WORKSPACE_PERMISSIONS, ROLE, WORKSPACE_PERMISSIONS, isSubset, parsePermissions, permissionError } from "../lib/permissions";
import {
  createWorkspaceStatements,
  deleteWorkspace,
  getRole,
  lastOwnerMessage,
  normalizeEmail,
  normalizeName,
  otherOwnerCount,
  passwordError,
  rolePermissions,
} from "../lib/users";
import { now } from "../lib/util";

type Ctx = Context<AppEnv>;

interface ListedWorkspaceRow {
  id: string;
  name: string;
  created_at: number;
  role_id: string | null;
  role_name: string | null;
  permissions: string | null;
  member_count: number;
  is_demo: number;
}

/**
 * Workspaces of the user (every workspace for instance admins, the non-member ones marked `viaAdmin`). The demo user
 * only sees demo workspaces, with at most the demo permissions (same rules as `toWorkspace` in lib/auth.ts).
 */
export async function listWorkspaces(
  db: D1Database,
  userId: string,
  instancePermissions: readonly string[],
  demoUser = false,
): Promise<WorkspaceDTO[]> {
  const admin = !demoUser && isInstanceAdmin(instancePermissions);
  const { results } = await db
    .prepare(
      `SELECT w.id, w.name, w.created_at, w.is_demo, m.role_id, r.name AS role_name, r.permissions,
         (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count
       FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
       LEFT JOIN roles r ON r.id = m.role_id
       WHERE (m.user_id IS NOT NULL OR ? = 1) AND (? = 0 OR (w.is_demo = 1 AND m.user_id IS NOT NULL))
       ORDER BY m.user_id IS NULL, w.name COLLATE NOCASE`,
    )
    .bind(userId, admin ? 1 : 0, demoUser ? 1 : 0)
    .all<ListedWorkspaceRow>();
  return results.map((r) => {
    let permissions = admin ? [...WORKSPACE_PERMISSIONS] : (parsePermissions(r.permissions, "workspace") as WorkspaceDTO["permissions"]);
    if (demoUser) permissions = permissions.filter((p) => DEMO_WORKSPACE_PERMISSIONS.includes(p));
    return {
      id: r.id,
      name: r.name,
      role: r.role_id ? { id: r.role_id, name: r.role_name ?? r.role_id } : { id: ROLE.owner, name: "Owner" },
      permissions,
      ...(r.role_id ? {} : { viaAdmin: true as const }),
      ...(r.is_demo ? { demo: true as const } : {}),
      createdAt: r.created_at,
      memberCount: r.member_count,
    };
  });
}

/**
 * Access to the workspace in the URL (`:id`). API keys only reach the workspace they are bound to.
 * Returns null when the workspace does not exist or is not accessible (callers answer 404).
 */
async function pathWorkspace(c: Ctx): Promise<CurrentWorkspace | null> {
  const id = c.req.param("id")!;
  if (c.var.auth === "api_key" && c.var.workspace?.id !== id) return null;
  return workspaceAccess(c.env.DB, c.var.user.id, c.var.instancePermissions, id);
}

const notFound = (c: Ctx) => c.json({ error: "Workspace not found" }, 404);

/** Profile, current workspace. */
export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", async (c) => {
  const user = c.var.user;
  const workspaces = await listWorkspaces(c.env.DB, user.id, c.var.instancePermissions, user.demo);
  const preferred = c.var.workspace?.id ?? c.var.sessionWorkspaceId;
  const me: MeDTO = {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, ...(user.demo ? { demo: true as const } : {}) },
    instancePermissions: c.var.instancePermissions,
    workspaces: workspaces.map(({ createdAt: _c, memberCount: _m, ...w }) => w),
    currentWorkspaceId: workspaces.find((w) => w.id === preferred)?.id ?? workspaces.find((w) => !w.viaAdmin)?.id ?? workspaces[0]?.id ?? null,
  };
  return c.json(me);
});

meRoutes.patch("/me", forbidDemoUser, async (c) => {
  const body = await c.req.json<{ name?: string; email?: string }>().catch(() => ({}) as { name?: string; email?: string });
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name) return c.json({ error: "Name is required" }, 400);
    sets.push("name = ?") && binds.push(name);
  }
  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (!email) return c.json({ error: "A valid email is required" }, 400);
    if (email.toLowerCase().endsWith("@postflare.local")) return c.json({ error: "Use your real email address" }, 400);
    sets.push("email = ?") && binds.push(email);
  }
  if (sets.length) {
    try {
      await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...binds, now(), c.var.user.id)
        .run();
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) return c.json({ error: "This email is already used by another user" }, 409);
      throw err;
    }
  }
  const row = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE id = ?").bind(c.var.user.id).first<{ id: string; name: string; email: string }>();
  return c.json({ ...row, role: c.var.user.role });
});

/** Change own password; signs out the user's other sessions and devices (the iOS app calling this stays signed in). */
export async function changePassword(c: Ctx) {
  const { current, next } = await c.req.json<{ current?: string; next?: string }>().catch(() => ({}) as { current?: string; next?: string });
  const row = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(c.var.user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(current ?? "", row.password_hash))) return c.json({ error: "Current password is wrong" }, 400);
  const pwError = passwordError(next);
  if (pwError) return c.json({ error: pwError }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(next!), now(), c.var.user.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(c.var.user.id, c.var.auth === "device" ? c.var.sessionId! : ""),
  ]);
  // Fresh session for this browser (API key callers keep using their key).
  if (c.var.auth === "session") await createSession(c, c.var.user.id, c.var.workspace?.id ?? null);
  return c.json({ ok: true });
}

meRoutes.post("/me/password", forbidDemoUser, changePassword);

/** Remember the selected workspace on the session (used when a request has no X-Workspace-Id header). */
meRoutes.post("/me/workspace", async (c) => {
  if (c.var.auth === "api_key") return c.json({ error: "API keys are bound to one workspace" }, 400);
  const { workspaceId } = await c.req.json<{ workspaceId?: string }>().catch(() => ({}) as { workspaceId?: string });
  const ws = workspaceId ? await workspaceAccess(c.env.DB, c.var.user.id, c.var.instancePermissions, workspaceId) : null;
  if (!ws) return notFound(c);
  await c.env.DB.prepare("UPDATE sessions SET workspace_id = ? WHERE id = ?").bind(ws.id, c.var.sessionId!).run();
  return c.json({ ok: true, currentWorkspaceId: ws.id });
});

/** Workspaces and their members. */
export const workspaceRoutes = new Hono<AppEnv>();

workspaceRoutes.get("/workspaces", async (c) => {
  const list = await listWorkspaces(c.env.DB, c.var.user.id, c.var.instancePermissions, c.var.user.demo);
  // API keys only see their own workspace.
  return c.json(c.var.auth === "api_key" ? list.filter((w) => w.id === c.var.workspace?.id) : list);
});

workspaceRoutes.post("/workspaces", forbidDemoUser, requireInstancePermission("instance.workspaces.create"), async (c) => {
  const { name: raw } = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = normalizeName(raw);
  if (!name) return c.json({ error: "Name is required" }, 400);
  const ws = createWorkspaceStatements(c.env.DB, name, c.var.user.id);
  await c.env.DB.batch(ws.statements);
  const created = (await listWorkspaces(c.env.DB, c.var.user.id, c.var.instancePermissions, c.var.user.demo)).find((w) => w.id === ws.id);
  return c.json(created, 201);
});

workspaceRoutes.patch("/workspaces/:id", async (c) => {
  const ws = await pathWorkspace(c);
  if (!ws) return notFound(c);
  if (!ws.permissions.includes("workspace.manage")) return c.json({ error: permissionError("workspace.manage") }, 403);
  const { name: raw } = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = normalizeName(raw);
  if (!name) return c.json({ error: "Name is required" }, 400);
  await c.env.DB.prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?").bind(name, now(), ws.id).run();
  const updated = (await listWorkspaces(c.env.DB, c.var.user.id, c.var.instancePermissions, c.var.user.demo)).find((w) => w.id === ws.id);
  return c.json(updated);
});

workspaceRoutes.delete("/workspaces/:id", async (c) => {
  const ws = await pathWorkspace(c);
  if (!ws) return notFound(c);
  if (!ws.permissions.includes("workspace.delete")) return c.json({ error: permissionError("workspace.delete") }, 403);
  await deleteWorkspace(c.env, ws.id);
  return c.json({ ok: true });
});

interface MemberRow {
  user_id: string;
  name: string;
  email: string;
  status: MemberDTO["status"];
  role_id: string;
  role_name: string;
  role_permissions: string;
  created_at: number;
  last_login_at: number | null;
}

async function memberRow(db: D1Database, workspaceId: string, userId: string) {
  return db
    .prepare(
      `SELECT m.user_id, u.name, u.email, u.status, m.role_id, r.name AS role_name, r.permissions AS role_permissions, m.created_at, u.last_login_at
       FROM workspace_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
       WHERE m.workspace_id = ? AND m.user_id = ?`,
    )
    .bind(workspaceId, userId)
    .first<MemberRow>();
}

const memberDto = (r: MemberRow): MemberDTO => ({
  userId: r.user_id,
  name: r.name,
  email: r.email,
  status: r.status,
  role: { id: r.role_id, name: r.role_name },
  joinedAt: r.created_at,
  lastLoginAt: r.last_login_at,
});

workspaceRoutes.get("/workspaces/:id/members", async (c) => {
  const ws = await pathWorkspace(c);
  if (!ws) return notFound(c);
  const { results } = await c.env.DB.prepare(
    `SELECT m.user_id, u.name, u.email, u.status, m.role_id, r.name AS role_name, r.permissions AS role_permissions, m.created_at, u.last_login_at
     FROM workspace_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
     WHERE m.workspace_id = ? ORDER BY m.created_at`,
  )
    .bind(ws.id)
    .all<MemberRow>();
  return c.json(results.map(memberDto));
});

workspaceRoutes.patch("/workspaces/:id/members/:userId", async (c) => {
  const ws = await pathWorkspace(c);
  if (!ws) return notFound(c);
  if (!ws.permissions.includes("members.manage")) return c.json({ error: permissionError("members.manage") }, 403);
  const target = await memberRow(c.env.DB, ws.id, c.req.param("userId"));
  if (!target) return c.json({ error: "Member not found" }, 404);
  const { roleId } = await c.req.json<{ roleId?: string }>().catch(() => ({}) as { roleId?: string });
  const role = await getRole(c.env.DB, roleId, "workspace");
  if (!role) return c.json({ error: "Unknown workspace role" }, 400);
  // You can only hand out (and take away) what you have yourself: an Admin cannot create or demote Owners.
  if (!isSubset(rolePermissions(role), ws.permissions)) return c.json({ error: "You can only grant roles whose permissions you have yourself" }, 403);
  if (!isSubset(parsePermissions(target.role_permissions, "workspace"), ws.permissions)) {
    return c.json({ error: "You cannot change the role of a member who has permissions you don't have" }, 403);
  }
  if (target.role_id === ROLE.owner && role.id !== ROLE.owner && !(await otherOwnerCount(c.env.DB, ws.id, target.user_id))) {
    return c.json({ error: "A workspace must keep at least one owner. Make someone else owner first." }, 409);
  }
  await c.env.DB.prepare("UPDATE workspace_members SET role_id = ? WHERE workspace_id = ? AND user_id = ?").bind(role.id, ws.id, target.user_id).run();
  return c.json(memberDto((await memberRow(c.env.DB, ws.id, target.user_id))!));
});

/** Remove a member, or leave the workspace (own user id). */
workspaceRoutes.delete("/workspaces/:id/members/:userId", async (c) => {
  const ws = await pathWorkspace(c);
  if (!ws) return notFound(c);
  const target = await memberRow(c.env.DB, ws.id, c.req.param("userId"));
  const self = c.req.param("userId") === c.var.user.id;
  // Every demo visitor is the same user: one of them leaving would lock everybody out.
  if (self && c.var.user.demo) return c.json({ error: "This is not available in the demo" }, 403);
  if (!self) {
    if (!ws.permissions.includes("members.manage")) return c.json({ error: permissionError("members.manage") }, 403);
    if (!target) return c.json({ error: "Member not found" }, 404);
    if (!isSubset(parsePermissions(target.role_permissions, "workspace"), ws.permissions)) {
      return c.json({ error: "You cannot remove a member who has permissions you don't have" }, 403);
    }
  }
  if (!target) return c.json({ error: "Member not found" }, 404);
  if (target.role_id === ROLE.owner && !(await otherOwnerCount(c.env.DB, ws.id, target.user_id))) {
    return c.json({ error: lastOwnerMessage(self ? "You are" : `${target.name} is`, [ws]) }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(ws.id, target.user_id),
    // Their API keys for this workspace go too (they would be rejected anyway).
    c.env.DB.prepare("DELETE FROM api_keys WHERE workspace_id = ? AND user_id = ?").bind(ws.id, target.user_id),
    c.env.DB.prepare("UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ? AND user_id = ?").bind(ws.id, target.user_id),
  ]);
  return c.json({ ok: true });
});
