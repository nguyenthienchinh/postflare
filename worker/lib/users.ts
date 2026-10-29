import type { RoleScope } from "../../shared/types";
import { trialStatements } from "../billing/entitlements";
import { deleteAvatars } from "./avatars";
import { mediaKeys } from "./media";
import { terminateWorkflow } from "./posts";
import { ROLE, isDemoRole, parsePermissions } from "./permissions";
import { defaultProvidersStatement } from "./settings";
import { newId, now } from "./util";

export interface RoleRow {
  id: string;
  scope: RoleScope;
  name: string;
  description: string | null;
  permissions: string;
  builtin: number;
  created_at: number;
}

export async function getRole(db: D1Database, id: string | null | undefined, scope?: RoleScope): Promise<RoleRow | null> {
  // The live demo's roles are never granted through the API (invitations, member and user role changes).
  if (!id || isDemoRole(id)) return null;
  const row = await db.prepare("SELECT * FROM roles WHERE id = ?").bind(id).first<RoleRow>();
  return row && (!scope || row.scope === scope) ? row : null;
}

export const rolePermissions = (role: RoleRow) => parsePermissions(role.permissions, role.scope);

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

export function normalizeName(name: unknown, max = 100): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim().replace(/\s+/g, " ");
  return n ? n.slice(0, max) : null;
}

export const PASSWORD_MIN = 8;

export function passwordError(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > 256) return "Password is too long";
  return null;
}

/** Number of active users with the built-in instance Admin role, optionally ignoring one user. */
export async function activeAdminCount(db: D1Database, exceptUserId = ""): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND status = 'active' AND id != ?")
    .bind(ROLE.instanceAdmin, exceptUserId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Workspaces where `userId` is an Owner and no other active user is. */
export async function soleOwnerWorkspaces(db: D1Database, userId: string): Promise<Array<{ id: string; name: string }>> {
  const { results } = await db
    .prepare(
      `SELECT w.id, w.name FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? AND m.role_id = ? AND NOT EXISTS (
         SELECT 1 FROM workspace_members o JOIN users u ON u.id = o.user_id
         WHERE o.workspace_id = m.workspace_id AND o.role_id = ? AND o.user_id != m.user_id AND u.status = 'active')`,
    )
    .bind(userId, ROLE.owner, ROLE.owner)
    .all<{ id: string; name: string }>();
  return results;
}

/** Other active Owners of a workspace besides `userId`. */
export async function otherOwnerCount(db: D1Database, workspaceId: string, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.role_id = ? AND m.user_id != ? AND u.status = 'active'`,
    )
    .bind(workspaceId, ROLE.owner, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function lastOwnerMessage(who: string, workspaces: Array<{ name: string }>): string {
  const names = workspaces.map((w) => `"${w.name}"`).join(", ");
  return `${who} the last owner of ${names}. Make someone else owner or delete the workspace first.`;
}

/** Statements creating a workspace with `userId` as its Owner (and its trial, in hosted mode with billing on). */
export function createWorkspaceStatements(db: D1Database, name: string, userId: string, id = newId("ws_")) {
  const t = now();
  return {
    id,
    statements: [
      db.prepare("INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, userId, t, t),
      db
        .prepare("INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, userId, ROLE.owner, t),
      ...trialStatements(db, id, userId, t),
      defaultProvidersStatement(db, id),
    ],
  };
}

/** Workflows terminated per workspace delete (Free plan subrequest budget); the rest skip themselves (row is gone). */
const MAX_TERMINATE = 20;

/**
 * Delete a workspace and everything in it: posts (and their scheduled workflows), logs, accounts, media (R2 objects
 * too), upload links, API keys, OAuth states, invitations and memberships.
 */
export async function deleteWorkspace(env: Env, workspaceId: string): Promise<void> {
  const db = env.DB;
  const { results: scheduled } = await db
    .prepare("SELECT workflow_id FROM posts WHERE workspace_id = ? AND status = 'scheduled' AND workflow_id IS NOT NULL LIMIT ?")
    .bind(workspaceId, MAX_TERMINATE)
    .all<{ workflow_id: string }>();
  const { results: media } = await db
    .prepare("SELECT id, r2_key, upload_id, status, has_thumb FROM media WHERE workspace_id = ?")
    .bind(workspaceId)
    .all<{ id: string; r2_key: string; upload_id: string | null; status: string; has_thumb: number }>();

  // RETURNING: the ids of the accounts whose avatar copies go after the rows.
  const deleteAccounts = db.prepare("DELETE FROM accounts WHERE workspace_id = ? RETURNING id").bind(workspaceId);
  // Rows first: a workflow that wakes up after this finds no post and skips (publishing ones fail cleanly).
  const statements = [
    db.prepare("DELETE FROM post_logs WHERE post_id IN (SELECT id FROM posts WHERE workspace_id = ?)").bind(workspaceId),
    db.prepare("DELETE FROM post_metrics WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM account_metrics WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM posts WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM campaign_clicks WHERE code IN (SELECT code FROM campaign_links WHERE workspace_id = ?)").bind(workspaceId),
    db.prepare("DELETE FROM campaign_links WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM campaign_stats WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM workspace_apps WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM playbook_versions WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM playbooks WHERE workspace_id = ?").bind(workspaceId),
    deleteAccounts,
    db.prepare("DELETE FROM account_groups WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM media WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM upload_links WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM api_keys WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM oauth_states WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM invitations WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM workspaces WHERE id = ?").bind(workspaceId),
  ];
  const removed = await db.batch(statements);

  await Promise.allSettled(scheduled.map((r) => terminateWorkflow(env, r.workflow_id)));
  const keys = mediaKeys(media.filter((m) => m.status === "ready" || !m.upload_id));
  // Avatar copies of the accounts (lib/avatars.ts).
  await deleteAvatars(env, ((removed[statements.indexOf(deleteAccounts)]?.results ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (let i = 0; i < keys.length; i += 1000) await env.MEDIA.delete(keys.slice(i, i + 1000));
  await Promise.allSettled(
    media
      .filter((m) => m.status === "uploading" && m.upload_id)
      .slice(0, 10)
      .map((m) => env.MEDIA.resumeMultipartUpload(m.r2_key, m.upload_id!).abort()),
  );
}
