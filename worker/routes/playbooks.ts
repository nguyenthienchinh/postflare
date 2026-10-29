// Playbooks API: the library (built-in + this workspace's custom ones), the agent prompt, custom playbook CRUD with
// immutable versions, and the ranking of playbooks by measured performance. Read: posts.read. Write: playbooks.manage.

import { Hono, type Context } from "hono";
import type { PlaybookInput, PlaybookStatsDTO, PlaybookStatsSort } from "../../shared/types";
import { CAMPAIGN_RESULT_COLUMNS } from "../lib/campaigns";
import { can, requirePermission, wsId, type AppEnv } from "../lib/auth";
import { simulateDueDemoPosts } from "../lib/demo";
import { engagementSql, exposureSql } from "../lib/metrics";
import {
  STATS_MAX_POSTS,
  STATS_METHOD,
  STATS_SORTS,
  builtinPlaybooks,
  computePlaybookStats,
  findPlaybook,
  getBuiltin,
  listCustom,
  playbookDto,
  searchPlaybooks,
  summaryDto,
  validatePlaybookInput,
  type Playbook,
  type PlaybookFields,
  type PromptAccount,
  type StatsPostRow,
} from "../lib/playbooks";
import { newId, now } from "../lib/util";

export const playbookRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const DAY = 24 * 60 * 60 * 1000;

playbookRoutes.get("/playbooks", requirePermission("posts.read"), async (c) => {
  const { q, platform, goal, format, tag, source } = c.req.query();
  const custom = source === "builtin" ? [] : await listCustom(c.env.DB, wsId(c), c.req.query("archived") === "true");
  const all = [...(source === "custom" ? [] : builtinPlaybooks()), ...custom];
  return c.json(searchPlaybooks(all, { q, platform, goal, format, tag }).map((p) => summaryDto(p, q ? p.score : undefined)));
});

// ---------------------------------------------------------------------------------------------------------------
// Ranking (before /playbooks/:id)

playbookRoutes.get("/playbooks/stats", requirePermission("posts.read"), async (c) => {
  const ws = wsId(c);
  const days = Math.min(Math.max(Math.round(Number(c.req.query("days")) || 90), 1), 366);
  const platform = c.req.query("platform") || null;
  const accountId = c.req.query("accountId") || null;
  const rawSort = c.req.query("sort") || "lift";
  const sort = (rawSort === "installs" ? "downloads" : rawSort === "revenue" ? "proceeds" : rawSort) as PlaybookStatsSort;
  if (!STATS_SORTS.includes(sort)) return c.json({ error: `sort must be one of ${STATS_SORTS.join(", ")}` }, 400);
  const to = now();
  const from = to - days * DAY;
  if (c.var.workspace?.demo) await simulateDueDemoPosts(c.env, ws);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (platform) where.push("a.provider = ?") && binds.push(platform);
  if (accountId) where.push("p.account_id = ?") && binds.push(accountId);
  // One query: the most recent published posts with metrics (engagements and exposure computed by D1).
  const { results } = await c.env.DB.prepare(
    `SELECT p.account_id, p.playbook_id, p.playbook_version, p.variant, ${engagementSql()} AS eng, ${exposureSql()} AS exp, ${CAMPAIGN_RESULT_COLUMNS()}
     FROM posts p JOIN accounts a ON a.id = p.account_id
     WHERE p.workspace_id = ? AND p.status = 'published' AND p.published_at >= ? AND p.published_at < ? AND p.metrics IS NOT NULL
       ${where.map((w) => `AND ${w}`).join(" ")}
     ORDER BY p.published_at DESC LIMIT ?`,
  )
    .bind(ws, from, to, ...binds, STATS_MAX_POSTS + 1)
    .all<StatsPostRow>();
  const capped = results.length > STATS_MAX_POSTS;
  const rows = capped ? results.slice(0, STATS_MAX_POSTS) : results;
  // Names of custom playbooks (archived ones too: their posts still count). Only when some post uses one.
  const customIds = [...new Set(rows.map((r) => r.playbook_id).filter((id): id is string => !!id && !getBuiltin(id)))];
  const names = new Map<string, string>();
  if (customIds.length) {
    const { results: named } = await c.env.DB.prepare("SELECT id, name FROM playbooks WHERE workspace_id = ?").bind(ws).all<{ id: string; name: string }>();
    for (const r of named) names.set(r.id, r.name);
  }
  const info = (id: string) => {
    const b = getBuiltin(id);
    return b ? { name: b.name, builtin: true } : { name: names.get(id) ?? id, builtin: false };
  };
  const body: PlaybookStatsDTO = { from, to, days, platform, accountId, capped, method: STATS_METHOD, sort, ...computePlaybookStats(rows, info, sort) };
  return c.json(body);
});

// ---------------------------------------------------------------------------------------------------------------
// One playbook

/** Target accounts for the agent prompt (null without accounts.read). */
async function promptAccounts(c: Ctx): Promise<PromptAccount[] | null> {
  if (!can(c, "accounts.read")) return null;
  const accountId = c.req.query("accountId");
  const { results } = await c.env.DB.prepare(
    `SELECT id, provider, name, username FROM accounts WHERE workspace_id = ? AND status != 'disabled'${accountId ? " AND id = ?" : ""} ORDER BY provider, name LIMIT 50`,
  )
    .bind(wsId(c), ...(accountId ? [accountId] : []))
    .all<PromptAccount>();
  return results;
}

function versionParam(c: Ctx): number | null | "invalid" {
  const v = c.req.query("version");
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : "invalid";
}

playbookRoutes.get("/playbooks/:id", requirePermission("posts.read"), async (c) => {
  const version = versionParam(c);
  if (version === "invalid") return c.json({ error: "version must be a positive integer" }, 400);
  const p = await findPlaybook(c.env.DB, wsId(c), c.req.param("id"), version);
  if (!p) {
    const b = getBuiltin(c.req.param("id"));
    return c.json({ error: b ? `Only version ${b.version} of the built-in playbook ${b.id} is available` : "Not found" }, 404);
  }
  return c.json(playbookDto(p, await promptAccounts(c)));
});

// ---------------------------------------------------------------------------------------------------------------
// Custom playbooks (playbooks.manage)

const fieldsOf = (p: Playbook): PlaybookFields => ({
  slug: p.slug,
  name: p.name,
  summary: p.summary,
  goal: p.goal,
  platforms: p.platforms,
  formats: p.formats,
  tags: p.tags,
  inputs: p.inputs,
  body: p.body,
});

/** Head row + version 1 in one batch. A taken slug (unique index) → error. */
async function insertPlaybook(c: Ctx, f: PlaybookFields, basedOn: string | null) {
  const id = newId("pbk_");
  const t = now();
  const db = c.env.DB;
  const j = JSON.stringify;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO playbooks (id, workspace_id, slug, version, name, summary, goal, platforms, formats, tags, inputs, body, based_on, created_by, created_at, updated_at, archived)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(id, wsId(c), f.slug, f.name, f.summary, f.goal, j(f.platforms), j(f.formats), j(f.tags), j(f.inputs), f.body, basedOn, c.var.user.id, t, t),
      db
        .prepare(
          `INSERT INTO playbook_versions (playbook_id, version, workspace_id, name, summary, goal, platforms, formats, tags, inputs, body, created_by, created_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, wsId(c), f.name, f.summary, f.goal, j(f.platforms), j(f.formats), j(f.tags), j(f.inputs), f.body, c.var.user.id, t),
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return { error: `A playbook with the slug "${f.slug}" already exists in this workspace` };
    throw err;
  }
  return { id };
}

/** A free slug in the workspace: `base`, else `base-2`, `base-3`... (one query). */
async function freeSlug(c: Ctx, base: string): Promise<string> {
  const { results } = await c.env.DB.prepare("SELECT slug FROM playbooks WHERE workspace_id = ? AND (slug = ? OR slug LIKE ?)")
    .bind(wsId(c), base, `${base}-%`)
    .all<{ slug: string }>();
  const taken = new Set(results.map((r) => r.slug));
  if (!taken.has(base) && !getBuiltin(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function created(c: Ctx, id: string) {
  const p = (await findPlaybook(c.env.DB, wsId(c), id))!;
  return c.json(playbookDto(p, await promptAccounts(c)), 201);
}

playbookRoutes.post("/playbooks", requirePermission("playbooks.manage"), async (c) => {
  const body = await c.req.json<PlaybookInput>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid JSON body" }, 400);
  const v = validatePlaybookInput(body);
  if ("errors" in v) return c.json({ error: v.errors.join("\n"), errors: v.errors }, 400);
  const res = await insertPlaybook(c, v.fields, null);
  if ("error" in res) return c.json({ error: res.error }, 409);
  return created(c, res.id);
});

/** Copy a playbook (built-in or custom) into this workspace as a new custom playbook (version 1). */
playbookRoutes.post("/playbooks/:id/duplicate", requirePermission("playbooks.manage"), async (c) => {
  const version = versionParam(c);
  if (version === "invalid") return c.json({ error: "version must be a positive integer" }, 400);
  const src = await findPlaybook(c.env.DB, wsId(c), c.req.param("id"), version);
  if (!src) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ name?: string; slug?: string }>().catch(() => ({}) as { name?: string; slug?: string });
  const name = (typeof body.name === "string" && body.name.trim()) || `${src.name} (custom)`.slice(0, 80);
  const slug = typeof body.slug === "string" && body.slug.trim() ? body.slug.trim() : await freeSlug(c, `${src.slug}-custom`.slice(0, 60));
  const v = validatePlaybookInput({ name, slug }, fieldsOf(src));
  if ("errors" in v) return c.json({ error: v.errors.join("\n"), errors: v.errors }, 400);
  const res = await insertPlaybook(c, v.fields, src.builtin ? `${src.id}@${src.version}` : (src.basedOn ?? `${src.id}@${src.version}`));
  if ("error" in res) return c.json({ error: res.error }, 409);
  return created(c, res.id);
});

/** Edit a custom playbook: saves a NEW version (old versions are never changed). Unchanged content → no new version. */
playbookRoutes.patch("/playbooks/:id", requirePermission("playbooks.manage"), async (c) => {
  if (getBuiltin(c.req.param("id"))) return c.json({ error: "Built-in playbooks are read-only: duplicate it to customize" }, 409);
  const cur = await findPlaybook(c.env.DB, wsId(c), c.req.param("id"));
  if (!cur) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<PlaybookInput & { archived?: boolean }>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid JSON body" }, 400);
  const v = validatePlaybookInput(body, fieldsOf(cur));
  if ("errors" in v) return c.json({ error: v.errors.join("\n"), errors: v.errors }, 400);
  const f = v.fields;
  const db = c.env.DB;
  const j = JSON.stringify;
  const t = now();
  const contentChanged = (["name", "summary", "goal", "platforms", "formats", "tags", "inputs", "body"] as const).some((k) => j(f[k]) !== j(cur[k]));
  const archived = typeof body.archived === "boolean" ? body.archived : cur.archived;
  if (!contentChanged) {
    // Slug / archived only: the head row, no new version.
    if (f.slug !== cur.slug || archived !== cur.archived) {
      try {
        await db.prepare("UPDATE playbooks SET slug = ?, archived = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").bind(f.slug, archived ? 1 : 0, t, cur.id, wsId(c)).run();
      } catch (err) {
        if (/UNIQUE/i.test(String(err))) return c.json({ error: `A playbook with the slug "${f.slug}" already exists in this workspace` }, 409);
        throw err;
      }
    }
    const p = (await findPlaybook(db, wsId(c), cur.id))!;
    return c.json(playbookDto(p, await promptAccounts(c)));
  }
  const next = cur.latestVersion + 1;
  try {
    // The version row's primary key makes a concurrent edit fail (and roll the batch back) instead of overwriting.
    const [, head] = await db.batch([
      db
        .prepare(
          `INSERT INTO playbook_versions (playbook_id, version, workspace_id, name, summary, goal, platforms, formats, tags, inputs, body, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(cur.id, next, wsId(c), f.name, f.summary, f.goal, j(f.platforms), j(f.formats), j(f.tags), j(f.inputs), f.body, c.var.user.id, t),
      db
        .prepare(
          `UPDATE playbooks SET version = ?, slug = ?, name = ?, summary = ?, goal = ?, platforms = ?, formats = ?, tags = ?, inputs = ?, body = ?, archived = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND version = ?`,
        )
        .bind(next, f.slug, f.name, f.summary, f.goal, j(f.platforms), j(f.formats), j(f.tags), j(f.inputs), f.body, archived ? 1 : 0, t, cur.id, wsId(c), cur.latestVersion),
    ]);
    if (!head.meta.changes) return c.json({ error: "The playbook changed meanwhile, reload and try again" }, 409);
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err))) return c.json({ error: "The playbook changed meanwhile (or the slug is taken), reload and try again" }, 409);
    throw err;
  }
  const p = (await findPlaybook(db, wsId(c), cur.id))!;
  return c.json(playbookDto(p, await promptAccounts(c)));
});

/** Archive (soft delete): it leaves the library, posts keep their attribution and the ranking keeps its name. */
playbookRoutes.delete("/playbooks/:id", requirePermission("playbooks.manage"), async (c) => {
  if (getBuiltin(c.req.param("id"))) return c.json({ error: "Built-in playbooks cannot be deleted" }, 409);
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("UPDATE playbooks SET archived = 1, updated_at = ? WHERE workspace_id = ? AND (id = ? OR slug = ?)")
    .bind(now(), wsId(c), id, id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
