// Usage metering (`usage_events`, migrations/0007). One row per unit of work, written by a statement that joins the
// batch of the state change it describes (no extra D1 round trip on the publish path):
// - publish: the workflow's "mark published" / "mark failed" / "mark needs check" batch (worker/workflow.ts), and the
//   demo simulation batch (lib/demo.ts, flagged is_demo = 1);
// - reply: each follow-up (the success is one best-effort INSERT in the reply step; a failure joins its batch);
// - metrics_refresh: one row per collector chunk (provider, quantity = posts, platform_api_calls = fetches);
// - media_upload / media_delete: uploads, manual deletes and the daily lifecycle sweep (one row per workspace and rule).
//
// Demo workspaces: events are recorded with is_demo = 1 and excluded from instance totals (the overview shows them
// apart). Demo metrics are made up locally and are not recorded at all.
//
// No separate daily-counters table: every quota estimate (workflow steps, D1 writes, R2 bytes, Images) is derived
// from these rows at read time (index on `day`), which costs nothing on the write path. Rows are kept
// USAGE_RETENTION_DAYS (daily cron, bounded deletes).

import { URL_RE } from "../providers/x";

export const USAGE_RETENTION_DAYS = 400;
/** Rows deleted per daily run (one statement); more is left for the next day. */
export const USAGE_PRUNE_BATCH = 5000;

export type UsageKind = "publish" | "reply" | "metrics_refresh" | "media_upload" | "media_delete";
export type UsageOutcome = "published" | "failed" | "needs_check" | "ok";

/** YYYY-MM-DD (UTC). */
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

const URL_TEST = new RegExp(URL_RE.source, "i");

/** True when the text contains a URL, including bare domains like `postflare.io` (X bills posts with links ~13x). */
export function hasUrl(text: string | null | undefined): boolean {
  return !!text && URL_TEST.test(text);
}

/** Usage measured during one provider call (a commit step of the publish workflow). Persisted in the step result. */
export interface AttemptUsage {
  /** Provider fetches (ctx.fetch), including a token refresh. */
  fetches: number;
  /** Cloudflare Images transformations (ctx.media.image). */
  imagesTx: number;
  /** The text sent contains a URL (null when the post was not loaded). */
  hasUrl: boolean | null;
}

/** What one publish workflow instance used so far (summed over its commit steps). */
export interface PublishMeter {
  steps: number;
  fetches: number;
  imagesTx: number;
  hasUrl: boolean;
}

export const newMeter = (): PublishMeter => ({ steps: 0, fetches: 0, imagesTx: 0, hasUrl: false });

export function addUsage(meter: PublishMeter, usage: AttemptUsage | undefined) {
  if (!usage) return;
  meter.fetches += usage.fetches || 0;
  meter.imagesTx += usage.imagesTx || 0;
  if (usage.hasUrl) meter.hasUrl = true;
}

/** SQL expressions over a JSON array of media ids (`col`, e.g. `p.media`). */
const mediaBytes = (col: string) => `(SELECT COALESCE(SUM(size), 0) FROM media WHERE id IN (SELECT value FROM json_each(${col})))`;
const postType = (col: string) =>
  `(SELECT CASE WHEN json_array_length(${col}) = 0 THEN 'text' WHEN COUNT(*) = 0 THEN NULL WHEN SUM(kind = 'video') = 0 THEN 'image' WHEN SUM(kind = 'image') = 0 THEN 'video' ELSE 'mixed' END
     FROM media WHERE id IN (SELECT value FROM json_each(${col})))`;

const COLUMNS =
  "workspace_id, account_id, post_id, revision, provider, kind, outcome, post_type, has_url, media_count, media_bytes, quantity, workflow_steps, platform_api_calls, images_tx, is_demo, message, created_at, day";

/**
 * The publish outcome of a post, for the batch that sets it. Guarded like the post logs of that batch: only inserted
 * when the post is at `revision`, in `status`, with `updated_at = t` (i.e. this very batch changed it), so a replayed
 * step or a post resolved meanwhile records nothing.
 */
export function publishEventStatement(
  db: D1Database,
  e: { postId: string; revision: number; status: "published" | "failed" | "needs_check"; t: number; meter: PublishMeter; message?: string | null },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO usage_events (${COLUMNS})
       SELECT p.workspace_id, p.account_id, p.id, p.revision, a.provider, 'publish', ?, ${postType("p.media")}, ?, json_array_length(p.media), ${mediaBytes("p.media")},
              1, ?, ?, ?, COALESCE(w.is_demo, 0), ?, ?, ?
       FROM posts p LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = ? AND p.revision = ? AND p.status = ? AND p.updated_at = ?`,
    )
    .bind(
      e.status,
      e.meter.hasUrl ? 1 : 0,
      e.meter.steps,
      e.meter.fetches,
      e.meter.imagesTx,
      e.message ? e.message.slice(0, 500) : null,
      e.t,
      utcDay(e.t),
      e.postId,
      e.revision,
      e.status,
      e.t,
    );
}

/**
 * Demo simulation (lib/demo.ts): publish events of the posts in `pairs` ([post id, fake external id]) that this run
 * published (the random external id is ours), flagged is_demo. One statement for the whole batch.
 */
export function demoPublishEventsStatement(db: D1Database, pairs: Array<[string, string]>, contents: Record<string, string>, t: number): D1PreparedStatement {
  const urls = JSON.stringify(Object.keys(contents).filter((id) => hasUrl(contents[id])));
  return db
    .prepare(
      `INSERT INTO usage_events (${COLUMNS})
       SELECT p.workspace_id, p.account_id, p.id, p.revision, a.provider, 'publish', 'published', ${postType("p.media")},
              p.id IN (SELECT value FROM json_each(?)), json_array_length(p.media), ${mediaBytes("p.media")}, 1, NULL, 0, 0, 1, NULL, ?, ?
       FROM json_each(?) j JOIN posts p ON p.id = json_extract(j.value, '$[0]') AND p.external_id = json_extract(j.value, '$[1]')
       LEFT JOIN accounts a ON a.id = p.account_id`,
    )
    .bind(urls, t, utcDay(t), JSON.stringify(pairs));
}

/** A follow-up (reply N) of a post. `media` = ids of the follow-up's media. */
export function replyEventStatement(
  db: D1Database,
  e: { postId: string; outcome: "published" | "failed" | "needs_check"; media: string[]; hasUrl: boolean; fetches?: number | null; imagesTx?: number; message?: string | null; t: number },
): D1PreparedStatement {
  const ids = JSON.stringify(e.media);
  return db
    .prepare(
      `INSERT INTO usage_events (${COLUMNS})
       SELECT p.workspace_id, p.account_id, p.id, p.revision, a.provider, 'reply', ?, ${postType("?")}, ?, json_array_length(?), ${mediaBytes("?")},
              1, ?, ?, ?, COALESCE(w.is_demo, 0), ?, ?, ?
       FROM posts p LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = ?`,
    )
    .bind(
      e.outcome,
      ids,
      ids,
      e.hasUrl ? 1 : 0,
      ids,
      ids,
      // The reply step, plus the "reply N failed" step of a failure.
      e.outcome === "published" ? 1 : 2,
      e.fetches ?? null,
      e.imagesTx ?? 0,
      e.message ? e.message.slice(0, 500) : null,
      e.t,
      utcDay(e.t),
      e.postId,
    );
}

/** One metrics collection chunk of an account (quantity = posts in it). */
export interface MetricsEvent {
  workspaceId: string | null;
  accountId: string;
  provider: string;
  outcome: "ok" | "failed";
  quantity: number;
  fetches: number;
  message?: string | null;
  t: number;
}

/**
 * Several metrics events in ONE statement (the metrics cron collects them during the tick and writes them with its
 * last-run marker in one batch: the tick stays under the Free plan's 50 queries even if batch statements count).
 */
export function metricsEventsStatement(db: D1Database, events: MetricsEvent[]): D1PreparedStatement {
  const rows = events.map((e) => [e.workspaceId, e.accountId, e.provider, e.outcome, e.quantity, e.fetches, e.message ? e.message.slice(0, 500) : null, e.t, utcDay(e.t)]);
  return db
    .prepare(
      `INSERT INTO usage_events (${COLUMNS})
       SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), NULL, NULL, json_extract(j.value, '$[2]'), 'metrics_refresh', json_extract(j.value, '$[3]'), NULL, 0, 0, 0,
              json_extract(j.value, '$[4]'), NULL, json_extract(j.value, '$[5]'), 0, 0, json_extract(j.value, '$[6]'), json_extract(j.value, '$[7]'), json_extract(j.value, '$[8]')
       FROM json_each(?) j`,
    )
    .bind(JSON.stringify(rows));
}

export function metricsEventStatement(db: D1Database, e: MetricsEvent): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO usage_events (${COLUMNS}) VALUES (?, ?, NULL, NULL, ?, 'metrics_refresh', ?, NULL, 0, 0, 0, ?, NULL, ?, 0, 0, ?, ?, ?)`)
    .bind(e.workspaceId, e.accountId, e.provider, e.outcome, e.quantity, e.fetches, e.message ? e.message.slice(0, 500) : null, e.t, utcDay(e.t));
}

/** A media upload or a manual delete (one file). */
export function mediaEventStatement(
  db: D1Database,
  /** imagesTx: Images transformations spent (1 for an upload whose thumbnail was made). */
  e: { workspaceId: string; kind: "media_upload" | "media_delete"; bytes: number; mime?: string; t: number; imagesTx?: number },
): D1PreparedStatement {
  const type = e.mime ? (e.mime.startsWith("video/") ? "video" : "image") : null;
  return db
    .prepare(`INSERT INTO usage_events (${COLUMNS}) VALUES (?, NULL, NULL, NULL, NULL, ?, 'ok', ?, 0, 1, ?, 1, NULL, NULL, ?, 0, NULL, ?, ?)`)
    .bind(e.workspaceId, e.kind, type, e.bytes, e.imagesTx ?? 0, e.t, utcDay(e.t));
}

/**
 * Media about to be removed by the lifecycle sweep: one `media_delete` row per workspace (quantity = files). `ids` is
 * a SELECT of media ids (alias-free) evaluated in the same batch, right before the DELETE.
 */
export function mediaSweepEventStatement(db: D1Database, idsSql: string, binds: unknown[], t: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO usage_events (${COLUMNS})
       SELECT workspace_id, NULL, NULL, NULL, NULL, 'media_delete', 'ok', NULL, 0, COUNT(*), COALESCE(SUM(size), 0), COUNT(*), NULL, NULL, 0, 0, 'lifecycle sweep', ?, ?
       FROM media WHERE id IN (${idsSql}) GROUP BY workspace_id`,
    )
    .bind(t, utcDay(t), ...binds);
}

/** Daily cron: drop old events, bounded. */
export function pruneUsageStatement(db: D1Database, t: number): D1PreparedStatement {
  return db
    .prepare("DELETE FROM usage_events WHERE id IN (SELECT id FROM usage_events WHERE day < ? LIMIT ?)")
    .bind(utcDay(t - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000), USAGE_PRUNE_BATCH);
}

/** Settings key holding the last run of a cron job (`frequent`, `metrics`, `daily`): JSON {at, ms}. */
export const cronLastRunKey = (name: string) => `cron_last_run:${name}`;

export function cronRunStatement(db: D1Database, name: string, startedAt: number, finishedAt: number): D1PreparedStatement {
  return db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(cronLastRunKey(name), JSON.stringify({ at: finishedAt, ms: finishedAt - startedAt }));
}
