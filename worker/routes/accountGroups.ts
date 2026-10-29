import { Hono } from "hono";
import type { AccountGroupDTO, AccountGroupInput } from "../../shared/types";
import { ACCOUNT_GROUP_BULK_MAX, ACCOUNT_GROUP_COLORS, ACCOUNT_GROUP_NAME_MAX, isAccountGroupColor } from "../../shared/accountGroups";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { newId, now } from "../lib/util";

// Account groups: workspace-scoped "brand / project" folders. An account is in at most one group (accounts.group_id).
// Reading needs accounts.read, every change accounts.manage. Ids of other workspaces answer 404, and a group of another
// workspace can never be assigned. Every handler is at most 3 D1 round trips.

export const accountGroupRoutes = new Hono<AppEnv>();

interface GroupRow {
  id: string;
  workspace_id: string;
  name: string;
  color: string;
  position: number;
  created_at: number;
  updated_at: number;
  account_count?: number;
}

const groupDto = (r: GroupRow): AccountGroupDTO => ({
  id: r.id,
  name: r.name,
  color: r.color,
  position: r.position,
  accountCount: r.account_count ?? 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SELECT_GROUPS = `SELECT g.*, (SELECT COUNT(*) FROM accounts a WHERE a.workspace_id = g.workspace_id AND a.group_id = g.id) AS account_count
  FROM account_groups g WHERE g.workspace_id = ?`;

/** A group of the workspace (null for unknown ids and other workspaces' groups). */
export function findGroup(db: D1Database, workspaceId: string, id: string): Promise<GroupRow | null> {
  return db.prepare(`${SELECT_GROUPS} AND g.id = ?`).bind(workspaceId, id).first<GroupRow>();
}

function cleanName(v: unknown): string | { error: string } {
  if (typeof v !== "string" || !v.trim()) return { error: "Name is required" };
  const name = v.trim().replace(/\s+/g, " ");
  if (name.length > ACCOUNT_GROUP_NAME_MAX) return { error: `Name is too long (max ${ACCOUNT_GROUP_NAME_MAX} characters)` };
  return name;
}

const isUniqueError = (err: unknown) => /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err));
const DUPLICATE = (name: string) => ({ error: `A group named "${name}" already exists` });

const body = async <T>(c: { req: { json: <U>() => Promise<U> } }): Promise<Partial<T>> => {
  const b = await c.req.json<Partial<T>>().catch(() => null);
  return b && typeof b === "object" ? b : {};
};

accountGroupRoutes.get("/account-groups", requirePermission("accounts.read"), async (c) => {
  const { results } = await c.env.DB.prepare(`${SELECT_GROUPS} ORDER BY g.position, g.created_at`).bind(wsId(c)).all<GroupRow>();
  return c.json(results.map(groupDto));
});

accountGroupRoutes.post("/account-groups", requirePermission("accounts.manage"), async (c) => {
  const input = await body<AccountGroupInput>(c);
  const name = cleanName(input.name);
  if (typeof name !== "string") return c.json(name, 400);
  if (input.color !== undefined && !isAccountGroupColor(input.color)) return c.json({ error: "Invalid color" }, 400);
  const ws = wsId(c);
  const id = newId("agr_");
  const t = now();
  try {
    // Appended at the end; without a color, the palette is cycled by position (defaultGroupColor, in SQL).
    const cycle = ACCOUNT_GROUP_COLORS.slice(1);
    const row = await c.env.DB.prepare(
      `INSERT INTO account_groups (id, workspace_id, name, color, position, created_at, updated_at)
       SELECT ?, ?, ?, COALESCE(?, json_extract(?, '$[' || CAST(COALESCE(MAX(position) + 1, 0) % ? AS INTEGER) || ']')), COALESCE(MAX(position) + 1, 0), ?, ?
       FROM account_groups WHERE workspace_id = ?
       RETURNING *`,
    )
      .bind(id, ws, name, input.color ?? null, JSON.stringify(cycle), cycle.length, t, t, ws)
      .first<GroupRow>();
    return c.json(groupDto({ ...row!, account_count: 0 }), 201);
  } catch (err) {
    if (isUniqueError(err)) return c.json(DUPLICATE(name), 409);
    throw err;
  }
});

accountGroupRoutes.patch("/account-groups/:id", requirePermission("accounts.manage"), async (c) => {
  const ws = wsId(c);
  const db = c.env.DB;
  const input = await body<AccountGroupInput>(c);
  const row = await findGroup(db, ws, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.name !== undefined) {
    const name = cleanName(input.name);
    if (typeof name !== "string") return c.json(name, 400);
    sets.push("name = ?");
    binds.push(name);
  }
  if (input.color !== undefined) {
    if (!isAccountGroupColor(input.color)) return c.json({ error: "Invalid color" }, 400);
    sets.push("color = ?");
    binds.push(input.color);
  }
  const stmts: D1PreparedStatement[] = [];
  if (sets.length) {
    stmts.push(db.prepare(`UPDATE account_groups SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND workspace_id = ?`).bind(...binds, now(), row.id, ws));
  }
  if (input.position !== undefined) {
    if (typeof input.position !== "number" || !Number.isInteger(input.position)) return c.json({ error: "position must be an integer" }, 400);
    // Move to that index and renumber the workspace's groups 0..n-1 in one statement.
    const { results } = await db.prepare("SELECT id FROM account_groups WHERE workspace_id = ? ORDER BY position, created_at").bind(ws).all<{ id: string }>();
    const order = results.map((r) => r.id).filter((id) => id !== row.id);
    order.splice(Math.max(0, Math.min(input.position, order.length)), 0, row.id);
    stmts.push(
      db
        .prepare(
          `UPDATE account_groups SET position = json_extract(m.value, '$[1]') FROM (SELECT value FROM json_each(?)) AS m
           WHERE account_groups.id = json_extract(m.value, '$[0]') AND account_groups.workspace_id = ?`,
        )
        .bind(JSON.stringify(order.map((id, i) => [id, i])), ws),
    );
  }
  try {
    if (stmts.length) await db.batch(stmts);
  } catch (err) {
    if (isUniqueError(err)) return c.json(DUPLICATE(String(binds[0])), 409);
    throw err;
  }
  return c.json(groupDto((await findGroup(db, ws, row.id))!));
});

accountGroupRoutes.delete("/account-groups/:id", requirePermission("accounts.manage"), async (c) => {
  const ws = wsId(c);
  const db = c.env.DB;
  const row = await findGroup(db, ws, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  // Its accounts become ungrouped.
  const [ungrouped] = await db.batch([
    db.prepare("UPDATE accounts SET group_id = NULL, updated_at = ? WHERE workspace_id = ? AND group_id = ?").bind(now(), ws, row.id),
    db.prepare("DELETE FROM account_groups WHERE id = ? AND workspace_id = ?").bind(row.id, ws),
  ]);
  return c.json({ ok: true, ungrouped: ungrouped.meta.changes ?? 0 });
});

/** Move accounts into a group (`groupId: null` = ungroup). Unknown ids or ids of other workspaces: 404, nothing changes. */
accountGroupRoutes.post("/accounts/group", requirePermission("accounts.manage"), async (c) => {
  const ws = wsId(c);
  const db = c.env.DB;
  const input = await body<{ accountIds: unknown; groupId: unknown }>(c);
  if (!Array.isArray(input.accountIds) || !input.accountIds.length || !input.accountIds.every((x) => typeof x === "string" && x)) {
    return c.json({ error: "accountIds must be a non-empty array of account ids" }, 400);
  }
  const ids = [...new Set(input.accountIds as string[])];
  if (ids.length > ACCOUNT_GROUP_BULK_MAX) return c.json({ error: `At most ${ACCOUNT_GROUP_BULK_MAX} accounts per request` }, 400);
  if (input.groupId !== null && typeof input.groupId !== "string") return c.json({ error: "groupId must be a group id or null" }, 400);
  const groupId = input.groupId as string | null;
  const json = JSON.stringify(ids);
  // One read checks the accounts and the group together.
  const check = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM accounts WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))) AS n,
         (? IS NULL OR EXISTS (SELECT 1 FROM account_groups WHERE id = ? AND workspace_id = ?)) AS group_ok`,
    )
    .bind(ws, json, groupId, groupId, ws)
    .first<{ n: number; group_ok: number }>();
  if (!check?.group_ok) return c.json({ error: "Group not found" }, 404);
  if (check.n !== ids.length) return c.json({ error: "Account not found" }, 404);
  const res = await db
    .prepare("UPDATE accounts SET group_id = ?, updated_at = ? WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(groupId, now(), ws, json)
    .run();
  return c.json({ ok: true, updated: res.meta.changes ?? ids.length, groupId });
});
