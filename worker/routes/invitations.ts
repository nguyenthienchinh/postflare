import { Hono } from "hono";
import type {
  AcceptInvitationInput,
  CreateInvitationInput,
  CreatedInvitationDTO,
  InvitationDTO,
  InvitationLookupDTO,
} from "../../shared/types";
import { enforceWorkspace, loadSnapshot, trialStatements } from "../billing/entitlements";
import { createSession, forbidDemoUser, isInstanceAdmin, sessionUser, workspaceAccess, type AppEnv } from "../lib/auth";
import { hashPassword } from "../lib/crypto";
import { ROLE, isSubset, permissionError } from "../lib/permissions";
import { baseUrl, defaultProvidersStatement } from "../lib/settings";
import { getRole, normalizeEmail, normalizeName, passwordError, rolePermissions } from "../lib/users";
import { newId, now, randomToken, sha256Hex } from "../lib/util";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The INSERT of a new invitation (for a batch) with its id, link path (`/invite/<token>`, the token is only ever in
 * the link: the row has its hash) and expiry. Accepted through POST /api/invitations/accept.
 */
export async function invitationStatement(
  db: D1Database,
  i: { email: string | null; instanceRoleId: string; workspaceId: string | null; workspaceRoleId: string | null; newWorkspaceName: string | null; invitedBy: string },
) {
  const token = randomToken(32);
  const id = newId("inv_");
  const t = now();
  const statement = db
    .prepare(
      `INSERT INTO invitations (id, token_hash, email, instance_role_id, workspace_id, workspace_role_id, new_workspace_name, invited_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, await sha256Hex(token), i.email, i.instanceRoleId, i.workspaceId, i.workspaceRoleId, i.newWorkspaceName, i.invitedBy, t, t + INVITE_TTL_MS);
  return { id, path: `/invite/${token}`, expiresAt: t + INVITE_TTL_MS, statement };
}

interface InvitationRow {
  id: string;
  token_hash: string;
  email: string | null;
  instance_role_id: string;
  workspace_id: string | null;
  workspace_role_id: string | null;
  new_workspace_name: string | null;
  invited_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
}

/** Authenticated: create, list and revoke invitations. */
export const invitationRoutes = new Hono<AppEnv>();

invitationRoutes.post("/invitations", forbidDemoUser, async (c) => {
  const db = c.env.DB;
  const admin = isInstanceAdmin(c.var.instancePermissions);
  const body = await c.req.json<Partial<CreateInvitationInput>>().catch(() => ({}) as Partial<CreateInvitationInput>);
  let email: string | null = null;
  if (body.email) {
    email = normalizeEmail(body.email);
    if (!email) return c.json({ error: "Invalid email" }, 400);
  }
  // Only instance admins choose the instance role; everyone else invites regular members.
  const instanceRole = admin ? await getRole(db, body.instanceRoleId ?? ROLE.instanceMember, "instance") : await getRole(db, ROLE.instanceMember);
  if (!instanceRole) return c.json({ error: "Unknown instance role" }, 400);

  let workspaceId: string | null = null;
  let workspaceRoleId: string | null = null;
  let newWorkspaceName: string | null = null;
  if (body.workspaceId) {
    // API keys only reach the workspace they are bound to.
    const ws =
      c.var.auth === "api_key" && c.var.workspace?.id !== body.workspaceId
        ? null
        : await workspaceAccess(db, c.var.user.id, c.var.instancePermissions, body.workspaceId);
    if (!ws) return c.json({ error: "Workspace not found" }, 404);
    if (!ws.permissions.includes("members.manage")) return c.json({ error: permissionError("members.manage") }, 403);
    const role = await getRole(db, body.workspaceRoleId, "workspace");
    if (!role) return c.json({ error: "Choose a workspace role" }, 400);
    if (!isSubset(rolePermissions(role), ws.permissions)) return c.json({ error: "You can only grant roles whose permissions you have yourself" }, 403);
    if (email) {
      const member = await db
        .prepare("SELECT 1 AS x FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?")
        .bind(ws.id, email)
        .first();
      if (member) return c.json({ error: `${email} is already a member of this workspace` }, 409);
    }
    // Hosted mode: members + pending invitations count against the plan.
    await enforceWorkspace(db, ws.id, ws.billing, { members: 1 }, c.req.url);
    workspaceId = ws.id;
    workspaceRoleId = role.id;
  } else {
    if (!admin) return c.json({ error: "Only instance admins can invite someone into a new workspace" }, 403);
    newWorkspaceName = normalizeName(body.newWorkspaceName);
  }

  const inv = await invitationStatement(db, { email, instanceRoleId: instanceRole.id, workspaceId, workspaceRoleId, newWorkspaceName, invitedBy: c.var.user.id });
  await inv.statement.run();
  const out: CreatedInvitationDTO = { id: inv.id, url: `${await baseUrl(c.env, c.req.url)}${inv.path}`, expiresAt: inv.expiresAt };
  return c.json(out, 201);
});

/** SQL condition: the user may manage invitations of this row (members.manage there, or they sent it). */
const MANAGEABLE = `(i.invited_by = ? OR EXISTS (
  SELECT 1 FROM workspace_members m JOIN roles r ON r.id = m.role_id
  WHERE m.workspace_id = i.workspace_id AND m.user_id = ? AND EXISTS (SELECT 1 FROM json_each(r.permissions) WHERE value = 'members.manage')))`;

invitationRoutes.get("/invitations", async (c) => {
  const admin = isInstanceAdmin(c.var.instancePermissions);
  const workspaceId = c.req.query("workspaceId");
  const where = ["i.accepted_at IS NULL", "i.expires_at > ?"];
  const binds: unknown[] = [now()];
  if (!admin) where.push(MANAGEABLE) && binds.push(c.var.user.id, c.var.user.id);
  if (workspaceId) where.push("i.workspace_id = ?") && binds.push(workspaceId);
  if (c.var.auth === "api_key") where.push("i.workspace_id = ?") && binds.push(c.var.workspace!.id);
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, w.name AS workspace_name, ir.name AS instance_role_name, wr.name AS workspace_role_name, u.name AS invited_by_name
     FROM invitations i
     LEFT JOIN workspaces w ON w.id = i.workspace_id
     LEFT JOIN roles ir ON ir.id = i.instance_role_id
     LEFT JOIN roles wr ON wr.id = i.workspace_role_id
     LEFT JOIN users u ON u.id = i.invited_by
     WHERE ${where.join(" AND ")} ORDER BY i.created_at DESC`,
  )
    .bind(...binds)
    .all<InvitationRow & { workspace_name: string | null; instance_role_name: string | null; workspace_role_name: string | null; invited_by_name: string | null }>();
  return c.json(
    results.map(
      (r): InvitationDTO => ({
        id: r.id,
        email: r.email,
        instanceRole: { id: r.instance_role_id, name: r.instance_role_name ?? r.instance_role_id },
        workspaceId: r.workspace_id,
        workspaceName: r.workspace_name,
        workspaceRole: r.workspace_role_id ? { id: r.workspace_role_id, name: r.workspace_role_name ?? r.workspace_role_id } : null,
        newWorkspaceName: r.new_workspace_name,
        invitedBy: r.invited_by_name ? { id: r.invited_by, name: r.invited_by_name } : null,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      }),
    ),
  );
});

invitationRoutes.delete("/invitations/:id", async (c) => {
  const admin = isInstanceAdmin(c.var.instancePermissions);
  const res = await c.env.DB.prepare(
    `DELETE FROM invitations AS i WHERE i.id = ? ${admin ? "" : `AND ${MANAGEABLE}`} ${c.var.auth === "api_key" ? "AND i.workspace_id = ?" : ""}`,
  )
    .bind(c.req.param("id"), ...(admin ? [] : [c.var.user.id, c.var.user.id]), ...(c.var.auth === "api_key" ? [c.var.workspace!.id] : []))
    .run();
  if (!res.meta.changes) return c.json({ error: "Invitation not found" }, 404);
  return c.json({ ok: true });
});

/** Public: look up and accept invitations (the token in the link is the credential). */
export const invitationPublicRoutes = new Hono<AppEnv>();

async function findInvitation(db: D1Database, token: string | undefined) {
  if (!token || token.length < 20) return null;
  return db.prepare("SELECT * FROM invitations WHERE token_hash = ?").bind(await sha256Hex(token)).first<InvitationRow>();
}

invitationPublicRoutes.get("/lookup/:token", async (c) => {
  const inv = await findInvitation(c.env.DB, c.req.param("token"));
  if (!inv) return c.json({ error: "Invitation not found" }, 404);
  const info = await c.env.DB.prepare(
    `SELECT (SELECT name FROM workspaces WHERE id = ?) AS workspace_name, (SELECT name FROM roles WHERE id = ?) AS role_name,
       (SELECT name FROM users WHERE id = ?) AS inviter`,
  )
    .bind(inv.workspace_id, inv.workspace_role_id, inv.invited_by)
    .first<{ workspace_name: string | null; role_name: string | null; inviter: string | null }>();
  const out: InvitationLookupDTO = {
    email: inv.email,
    workspaceName: info?.workspace_name ?? null,
    workspaceRole: inv.workspace_role_id ? { id: inv.workspace_role_id, name: info?.role_name ?? inv.workspace_role_id } : null,
    newWorkspaceName: inv.workspace_id ? null : inv.new_workspace_name ?? "New workspace",
    invitedBy: info?.inviter ?? "A former user",
    expired: inv.expires_at < now(),
    accepted: !!inv.accepted_at,
  };
  return c.json(out);
});

/**
 * Accept an invitation. Signed in: the current user joins (their instance role is unchanged). Otherwise a new user
 * is created with the invitation's instance role and signed in. Returns `{ ok, workspaceId }`.
 */
invitationPublicRoutes.post("/accept", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Partial<AcceptInvitationInput>>().catch(() => ({}) as Partial<AcceptInvitationInput>);
  const inv = await findInvitation(db, body.token);
  if (!inv) return c.json({ error: "Invitation not found" }, 404);
  if (inv.accepted_at) return c.json({ error: "This invitation has already been used" }, 410);
  if (inv.expires_at < now()) return c.json({ error: "This invitation has expired" }, 410);

  const session = await sessionUser(c);
  if (session?.user.demo) return c.json({ error: "Sign out of the demo to accept an invitation" }, 403);
  if (session) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "Cross-origin request blocked" }, 403);
  }
  // Hosted mode: the plan of the workspace being joined must still have room (this invitation is already counted).
  if (inv.workspace_id) await enforceWorkspace(db, inv.workspace_id, await loadSnapshot(db, inv.workspace_id), { members: 0 }, c.req.url);
  const t = now();
  let userId: string;
  const statements: D1PreparedStatement[] = [];
  if (session) {
    userId = session.user.id;
    if (inv.email && inv.email.toLowerCase() !== session.user.email.toLowerCase()) {
      return c.json({ error: `This invitation is for ${inv.email}. Sign out and accept it with that account.` }, 403);
    }
    if (inv.workspace_id) {
      const member = await db.prepare("SELECT 1 AS x FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(inv.workspace_id, userId).first();
      if (member) return c.json({ error: "You are already a member of this workspace" }, 409);
    }
  } else {
    const name = normalizeName(body.name);
    const email = normalizeEmail(body.email);
    if (!name) return c.json({ error: "Name is required" }, 400);
    if (!email) return c.json({ error: "A valid email is required" }, 400);
    if (inv.email && inv.email.toLowerCase() !== email.toLowerCase()) return c.json({ error: `This invitation is for ${inv.email}` }, 400);
    const pwError = passwordError(body.password);
    if (pwError) return c.json({ error: pwError }, 400);
    if (await db.prepare("SELECT 1 AS x FROM users WHERE email = ?").bind(email).first()) {
      return c.json({ error: "An account with this email already exists. Sign in, then open the invitation link again." }, 409);
    }
    userId = newId("usr_");
    statements.push(
      db
        .prepare(
          `INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at, last_login_at)
           SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ? WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_by = ?)`,
        )
        .bind(userId, email, name, await hashPassword(body.password!), inv.instance_role_id, t, t, t, inv.id, userId),
    );
  }

  // Claim the invitation first; every following insert only runs if this request won the claim.
  const claimed = `WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_by = ?)`;
  const workspaceId = inv.workspace_id ?? newId("ws_");
  const roleId = inv.workspace_id ? inv.workspace_role_id ?? ROLE.viewer : ROLE.owner;
  if (!inv.workspace_id) {
    const wsName = inv.new_workspace_name ?? `${normalizeName(body.name) ?? session?.user.name ?? "New"}'s workspace`;
    statements.push(
      db
        .prepare(`INSERT INTO workspaces (id, name, created_by, created_at, updated_at) SELECT ?, ?, ?, ?, ? ${claimed}`)
        .bind(workspaceId, wsName, userId, t, t, inv.id, userId),
      // Hosted mode: the new workspace starts its trial (nothing happens while billing is off).
      ...trialStatements(db, workspaceId, userId, t),
      defaultProvidersStatement(db, workspaceId),
    );
  }
  statements.push(
    db
      .prepare(`INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role_id, created_at) SELECT ?, ?, ?, ? ${claimed}`)
      .bind(workspaceId, userId, roleId, t, inv.id, userId),
  );
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare("UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND expires_at > ?")
        .bind(t, userId, inv.id, t),
      ...statements,
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return c.json({ error: "An account with this email already exists" }, 409);
    if (/FOREIGN KEY/i.test(String(err))) return c.json({ error: "The workspace or role of this invitation no longer exists" }, 410);
    throw err;
  }
  if (!results[0].meta.changes) return c.json({ error: "This invitation has already been used" }, 410);

  if (session) {
    await db.prepare("UPDATE sessions SET workspace_id = ? WHERE id = ?").bind(workspaceId, session.sessionId).run();
  } else {
    await createSession(c, userId, workspaceId);
  }
  return c.json({ ok: true, workspaceId });
});
