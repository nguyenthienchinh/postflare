// Media lifecycle: R2 storage is the Free plan's bottleneck for media posts (10 GB), and nothing else ever deletes a
// file. The daily cron (`sweepMedia`) removes, in bounded batches (the rest waits for the next day):
// (a) media older than the instance's retention ("Media retention (days)", default 30, 0 = forever) that no post
//     still needs: not used by a draft/scheduled/publishing/needs_check/failed post, nor by a post published to a
//     platform that keeps linking to our copy (`Provider.hotlinksMedia`: DEV, Hashnode, Medium, Listmonk, Nostr,
//     Farcaster, Discord embeds, webhooks);
// (b) uploads that never finished (`status = 'uploading'`) after 2 days: the multipart upload is aborted;
// (c) files sent through an upload link that no post ever used, after 7 days (only when retention is on).
// Demo workspaces are never touched (they have their own daily reset). Each delete re-checks its rule in the same
// statement, so media attached to a post meanwhile is kept.

import { providers } from "../providers/registry";
import { mediaKeys } from "./media";
import { mediaRetentionDays } from "./settings";
import { mediaSweepEventStatement } from "./usage";
import { now } from "./util";

const DAY = 24 * 60 * 60 * 1000;
export const STALE_UPLOAD_MS = 2 * DAY;
export const UNUSED_LINK_MEDIA_MS = 7 * DAY;
/** Rows per rule and run: one D1 statement and one R2 call each, whatever the number. */
export const SWEEP_BATCH = 100;
/** Unfinished uploads per run: one R2 abort call each. */
export const STALE_UPLOADS_PER_RUN = 20;

/** Post statuses whose media must stay (they may still be published or edited). */
export const MEDIA_IN_USE_STATUSES = ["draft", "scheduled", "publishing", "needs_check", "failed"] as const;
/** Media of these posts cannot be deleted by hand either (failed posts can be edited before a retry: they warn). */
export const MEDIA_DELETE_BLOCKING_STATUSES = ["draft", "scheduled", "publishing", "needs_check"] as const;

export const hotlinkingProviders = () => providers.filter((p) => p.hotlinksMedia).map((p) => p.id);

const list = (values: readonly string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ") || "NULL";

/** A post of media `m`'s workspace uses it (as post or follow-up media). Ids are quoted JSON strings in both columns. */
const usedBy = (condition: string) =>
  `EXISTS (SELECT 1 FROM posts p LEFT JOIN accounts a ON a.id = p.account_id
     WHERE p.workspace_id IS m.workspace_id AND (instr(p.media, '"' || m.id || '"') > 0 OR instr(p.thread, '"' || m.id || '"') > 0)
       AND (${condition}))`;

const NOT_DEMO = "(m.workspace_id IS NULL OR m.workspace_id NOT IN (SELECT id FROM workspaces WHERE is_demo = 1))";

/** Posts of the workspace whose media must not be deleted by hand (DELETE /api/media/:id answers 409 with them). */
export async function postsBlockingMediaDelete(db: D1Database, workspaceId: string, mediaId: string): Promise<string[]> {
  const needle = `"${mediaId}"`;
  const { results } = await db
    .prepare(
      `SELECT id FROM posts WHERE workspace_id = ? AND status IN (${list(MEDIA_DELETE_BLOCKING_STATUSES)})
         AND (instr(media, ?) > 0 OR instr(thread, ?) > 0) LIMIT 20`,
    )
    .bind(workspaceId, needle, needle)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export interface SweepStats {
  expired: number;
  staleUploads: number;
  unusedLinkMedia: number;
}

/** Daily cron. Returns what was removed. */
export async function sweepMedia(env: Env, opts: { batch?: number } = {}): Promise<SweepStats> {
  const db = env.DB;
  const t = now();
  const batch = opts.batch ?? SWEEP_BATCH;
  const stats: SweepStats = { expired: 0, staleUploads: 0, unusedLinkMedia: 0 };
  const retention = await mediaRetentionDays(db);

  // (b) Unfinished uploads: delete the row (guarded), then abort the multipart upload (Abort is a free R2 operation).
  const { results: stale } = await db
    .prepare(
      `DELETE FROM media WHERE id IN (
         SELECT m.id FROM media m WHERE m.status = 'uploading' AND m.created_at < ? AND ${NOT_DEMO} ORDER BY m.created_at LIMIT ?
       ) AND status = 'uploading' RETURNING r2_key, upload_id`,
    )
    .bind(t - STALE_UPLOAD_MS, STALE_UPLOADS_PER_RUN)
    .all<{ r2_key: string; upload_id: string | null }>();
  for (const row of stale) {
    if (row.upload_id) await env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => {});
    else await env.MEDIA.delete(row.r2_key).catch(() => {});
  }
  stats.staleUploads = stale.length;
  if (retention <= 0) return stats;

  // (a) Expired media nobody needs.
  const keep = `p.status IN (${list(MEDIA_IN_USE_STATUSES)}) OR (p.status = 'published' AND (a.provider IS NULL OR a.provider IN (${list(hotlinkingProviders())})))`;
  stats.expired = await deleteWhere(
    env,
    `m.status = 'ready' AND m.created_at < ? AND ${NOT_DEMO} AND NOT ${usedBy(keep)}`,
    [t - retention * DAY],
    batch,
  );
  // (c) Upload-link files never used by any post.
  stats.unusedLinkMedia = await deleteWhere(
    env,
    `m.source = 'upload_link' AND m.status = 'ready' AND m.created_at < ? AND ${NOT_DEMO} AND NOT ${usedBy("1")}`,
    [t - UNUSED_LINK_MEDIA_MS],
    batch,
  );
  return stats;
}

/** Delete up to `limit` media rows matching `where` (alias m) in one guarded statement, then their R2 objects. */
async function deleteWhere(env: Env, where: string, binds: unknown[], limit: number): Promise<number> {
  const db = env.DB;
  const ids = `SELECT m.id FROM media m WHERE ${where} ORDER BY m.created_at, m.id LIMIT ?`;
  // One batch (one transaction): the usage events of the files about to go (per workspace), then the DELETE. Both
  // evaluate the same rule on the same snapshot. The rule is evaluated by the DELETE itself: a file attached to a post
  // since the run started is kept.
  const [, deleted] = await db.batch<{ id: string; r2_key: string; has_thumb: number }>([
    mediaSweepEventStatement(db, ids, [...binds, limit], now()),
    db.prepare(`DELETE FROM media WHERE id IN (${ids}) RETURNING id, r2_key, has_thumb`).bind(...binds, limit),
  ]);
  const results = deleted.results;
  if (results.length) {
    // One R2 call for up to 1000 keys (file + thumbnail of SWEEP_BATCH rows). If it fails the rows are gone
    // and the objects stay (storage, not a broken post).
    await env.MEDIA.delete(mediaKeys(results)).catch((err) => console.error("media sweep: R2 delete failed", err));
  }
  return results.length;
}

/** GET /api/media/usage. */
export async function mediaUsage(db: D1Database, workspaceId: string | null) {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM media${workspaceId === null ? "" : " WHERE workspace_id = ?"}`)
    .bind(...(workspaceId === null ? [] : [workspaceId]))
    .first<{ bytes: number; count: number }>();
  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 };
}
