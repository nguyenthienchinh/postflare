import { Hono } from "hono";
import type { RoleDTO, RoleInput, UserDTO } from "../../shared/types";
import { requireInstancePermission, type AppEnv } from "../lib/auth";
import { PERMISSIONS, ROLE, isDemoRole, isPermission, parsePermissions } from "../lib/permissions";
import {
  activeAdminCount,
  getRole,
  lastOwnerMessage,
  normalizeName,
  soleOwnerWorkspaces,
  type RoleRow,
} from "../lib/users";
import { newId, now } from "../lib/util";

/** Roles, permission catalog (readable by every signed-in user) and user management (instance admins). */
export const userRoutes = new Hono<AppEnv>();

const manageUsers = requireInstancePermission("instance.users.manage");

async function isDemoUser(db: D1Database, id: string) {
  return !!(await db.prepare("SELECT 1 AS x FROM users WHERE id = ? AND is_demo = 1").bind(id).first());
}

userRoutes.get("/permissions", (c) => c.json(PERMISSIONS.map(({ action: _a, ...p }) => p)));

const roleDto = (r: RoleRow & { assigned: number }): RoleDTO => ({
  id: r.id,
  scope: r.scope,
  name: r.name,
  description: r.description,
  permissions: parsePermissions(r.permissions, r.scope),
  builtin: !!r.builtin,
  createdAt: r.created_at,
  assigned: r.assigned,
});

const ROLE_QUERY = `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) + (SELECT COUNT(*) FROM workspace_members m WHERE m.role_id = r.id) AS assigned FROM roles r`;

async function loadRole(db: D1Database, id: string) {
  const row = await db.prepare(`${ROLE_QUERY} WHERE r.id = ?`).bind(id).first<RoleRow & { assigned: number }>();
  return row ? roleDto(row) : null;
}

userRoutes.get("/roles", async (c) => {
  const { results } = await c.env.DB.prepare(`${ROLE_QUERY} ORDER BY r.scope, r.builtin DESC, r.created_at, r.name`).all<
    RoleRow & { assigned: number }
  >();
  // The live demo's roles are internal (they cannot be granted).
  return c.json(results.filter((r) => !isDemoRole(r.id)).map(roleDto));
});

function parseRoleInput(body: Partial<RoleInput>, scope: RoleInput["scope"], partial: boolean): { error: string } | { name?: string; description?: string | null; permissions?: string[] } {
  const out: { name?: string; description?: string | null; permissions?: string[] } = {};
  if (!partial || body.name !== undefined) {
    const name = normalizeName(body.name, 60);
    if (!name) return { error: "Name is required" };
    out.name = name;
  }
  if (body.description !== undefined) out.description = body.description ? String(body.description).slice(0, 300) : null;
  if (!partial || body.permissions !== undefined) {
    if (!Array.isArray(body.permissions)) return { error: "permissions must be an array" };
    const bad = body.permissions.filter((p) => !isPermission(p, scope));
    if (bad.length) return { error: `Unknown ${scope} permission: ${bad.join(", ")}` };
    out.permissions = [...new Set(body.permissions)];
  }
  return out;
}

userRoutes.post("/roles", manageUsers, async (c) => {
  const body = await c.req.json<Partial<RoleInput>>().catch(() => ({}) as Partial<RoleInput>);
  if (body.scope !== "instance" && body.scope !== "workspace") return c.json({ error: "scope must be instance or workspace" }, 400);
  const input = parseRoleInput(body, body.scope, false);
  if ("error" in input) return c.json(input, 400);
  const id = newId("role_");
  await c.env.DB.prepare("INSERT INTO roles (id, scope, name, description, permissions, builtin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(id, body.scope, input.name, input.description ?? null, JSON.stringify(input.permissions), now())
    .run();
  return c.json(await loadRole(c.env.DB, id), 201);
});

userRoutes.patch("/roles/:id", manageUsers, async (c) => {
  const role = await getRole(c.env.DB, c.req.param("id"));
  if (!role) return c.json({ error: "Role not found" }, 404);
  if (role.builtin) return c.json({ error: "Built-in roles cannot be changed" }, 403);
  const input = parseRoleInput(await c.req.json<Partial<RoleInput>>().catch(() => ({})), role.scope, true);
  if ("error" in input) return c.json(input, 400);
  await c.env.DB.prepare(
    "UPDATE roles SET name = COALESCE(?, name), description = CASE WHEN ? THEN ? ELSE description END, permissions = COALESCE(?, permissions) WHERE id = ? AND builtin = 0",
  )
    .bind(
      input.name ?? null,
      input.description !== undefined ? 1 : 0,
      input.description ?? null,
      input.permissions ? JSON.stringify(input.permissions) : null,
      role.id,
    )
    .run();
  return c.json(await loadRole(c.env.DB, role.id));
});

userRoutes.delete("/roles/:id", manageUsers, async (c) => {
  const role = await loadRole(c.env.DB, c.req.param("id"));
  if (!role) return c.json({ error: "Role not found" }, 404);
  if (role.builtin) return c.json({ error: "Built-in roles cannot be deleted" }, 403);
  const invites = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM invitations WHERE accepted_at IS NULL AND expires_at > ? AND (instance_role_id = ? OR workspace_role_id = ?)",
  )
    .bind(now(), role.id, role.id)
    .first<{ n: number }>();
  if (role.assigned || invites?.n) return c.json({ error: "This role is still assigned (or used by pending invitations). Change those first." }, 409);
  await c.env.DB.prepare("DELETE FROM roles WHERE id = ? AND builtin = 0").bind(role.id).run();
  return c.json({ ok: true });
});

interface UserRow {
  id: string;
  name: string;
  email: string;
  status: UserDTO["status"];
  role_id: string;
  role_name: string;
  created_at: number;
  last_login_at: number | null;
}

async function listUsers(db: D1Database, id?: string): Promise<UserDTO[]> {
  const where = id ? "WHERE u.id = ?" : "";
  const [users, memberships] = await db.batch<any>([
    db
      .prepare(
        `SELECT u.id, u.name, u.email, u.status, u.role_id, r.name AS role_name, u.created_at, u.last_login_at
         FROM users u JOIN roles r ON r.id = u.role_id ${where} ORDER BY u.created_at`,
      )
      .bind(...(id ? [id] : [])),
    db
      .prepare(
        `SELECT m.user_id, w.id, w.name, m.role_id, r.name AS role_name FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id JOIN roles r ON r.id = m.role_id ${id ? "WHERE m.user_id = ?" : ""}
         ORDER BY w.name COLLATE NOCASE`,
      )
      .bind(...(id ? [id] : [])),
  ]);
  const byUser = new Map<string, UserDTO["workspaces"]>();
  for (const m of memberships.results as Array<{ user_id: string; id: string; name: string; role_id: string; role_name: string }>) {
    const list = byUser.get(m.user_id) ?? [];
    list.push({ id: m.id, name: m.name, role: { id: m.role_id, name: m.role_name } });
    byUser.set(m.user_id, list);
  }
  return (users.results as UserRow[]).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    role: { id: u.role_id, name: u.role_name },
    workspaces: byUser.get(u.id) ?? [],
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  }));
}

userRoutes.get("/users", manageUsers, async (c) => c.json(await listUsers(c.env.DB)));

userRoutes.patch("/users/:id", manageUsers, async (c) => {
  const db = c.env.DB;
  const [target] = await listUsers(db, c.req.param("id"));
  if (!target) return c.json({ error: "User not found" }, 404);
  if (await isDemoUser(db, target.id)) return c.json({ error: "The live demo user is managed automatically" }, 409);
  const body = await c.req.json<{ roleId?: string; status?: string; name?: string }>().catch(() => ({}) as Record<string, string>);
  const self = target.id === c.var.user.id;
  const sets: string[] = [];
  const binds: unknown[] = [];
  const wasAdmin = target.role.id === ROLE.instanceAdmin && target.status === "active";
  let losesAdmin = false;

  if (body.roleId !== undefined && body.roleId !== target.role.id) {
    if (self) return c.json({ error: "You cannot change your own instance role" }, 403);
    const role = await getRole(db, body.roleId, "instance");
    if (!role) return c.json({ error: "Unknown instance role" }, 400);
    losesAdmin ||= role.id !== ROLE.instanceAdmin;
    sets.push("role_id = ?") && binds.push(role.id);
  }
  if (body.status !== undefined && body.status !== target.status) {
    if (body.status !== "active" && body.status !== "disabled") return c.json({ error: "status must be active or disabled" }, 400);
    if (self) return c.json({ error: "You cannot disable your own account" }, 403);
    if (body.status === "disabled") {
      losesAdmin = true;
      const owned = await soleOwnerWorkspaces(db, target.id);
      if (owned.length) return c.json({ error: lastOwnerMessage(`${target.name} is`, owned) }, 409);
    }
    sets.push("status = ?") && binds.push(body.status);
  }
  if (body.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name) return c.json({ error: "Name is required" }, 400);
    sets.push("name = ?") && binds.push(name);
  }
  if (wasAdmin && losesAdmin && !(await activeAdminCount(db, target.id))) {
    return c.json({ error: "The instance must keep at least one active admin" }, 409);
  }
  if (sets.length) {
    await db.batch([
      db.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...binds, now(), target.id),
      // A disabled user is signed out everywhere (API keys are rejected while disabled) and their sign-in links end.
      ...(body.status === "disabled"
        ? [
            db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
            db.prepare("DELETE FROM magic_links WHERE user_id = ?").bind(target.id),
            // Their iOS devices are signed out with the sessions (device tokens) and stop getting pushes.
            db.prepare("DELETE FROM devices WHERE user_id = ?").bind(target.id),
          ]
        : []),
    ]);
  }
  return c.json((await listUsers(db, target.id))[0]);
});

/** Delete a user: memberships, sessions, API keys and sign-in links go; content they created stays in the workspaces. */
userRoutes.delete("/users/:id", manageUsers, async (c) => {
  const db = c.env.DB;
  const [target] = await listUsers(db, c.req.param("id"));
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.id === c.var.user.id) return c.json({ error: "You cannot delete your own account" }, 403);
  if (await isDemoUser(db, target.id)) return c.json({ error: "The live demo user is managed automatically" }, 409);
  if (target.role.id === ROLE.instanceAdmin && target.status === "active" && !(await activeAdminCount(db, target.id))) {
    return c.json({ error: "The instance must keep at least one active admin" }, 409);
  }
  const owned = await soleOwnerWorkspaces(db, target.id);
  if (owned.length) return c.json({ error: lastOwnerMessage(`${target.name} is`, owned) }, 409);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM oauth_states WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM magic_links WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM devices WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM workspace_members WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM users WHERE id = ?").bind(target.id),
  ]);
  return c.json({ ok: true });
});
