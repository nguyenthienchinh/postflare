import { Hono } from "hono";
import type { MediaUsageDTO } from "../../shared/types";
import { enforce } from "../billing/entitlements";
import { forbidInDemoWorkspace, isInstanceAdmin, requirePermission, wsId, type AppEnv } from "../lib/auth";
import { avatarKey, avatarSignedValue, isAvatarName } from "../lib/avatars";
import { verifySignature } from "../lib/crypto";
import { makeThumbnail, mediaDto, mediaKeys, safeFilename, thumbKey, type MediaRow } from "../lib/media";
import { mediaUsage, postsBlockingMediaDelete } from "../lib/media-lifecycle";
import { baseUrl, mediaRetentionDays } from "../lib/settings";
import { mediaEventStatement, utcDay } from "../lib/usage";
import { newId, now } from "../lib/util";

export const mediaRoutes = new Hono<AppEnv>();

/** The demo workspace's media library is fixed (seeded images only): no uploads, edits or deletes. */
const noDemo = forbidInDemoWorkspace("Changing media");

/** Max single-request upload; bigger files use the multipart endpoints (Workers cap request bodies at 100MB). */
export const SINGLE_UPLOAD_MAX = 90 * 1024 * 1024;
export const PART_SIZE = 50 * 1024 * 1024;
const MAX_FILE = 5 * 1024 * 1024 * 1024;

const ALLOWED = /^(image\/(jpeg|png|gif|webp|heic|heif|avif)|video\/(mp4|quicktime|webm|x-m4v|mpeg))$/;

function kindOf(mime: string): "image" | "video" {
  return mime.startsWith("video/") ? "video" : "image";
}

export interface Meta {
  filename: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  alt?: string | null;
}

export function checkMeta(m: Meta): string | null {
  if (!m.filename) return "filename is required";
  if (!ALLOWED.test(m.mime)) return `Unsupported file type ${m.mime}`;
  if (!(m.size > 0) || m.size > MAX_FILE) return "Invalid file size";
  return null;
}

export interface MediaOwner {
  workspaceId: string;
  /** User id (null for media uploaded through an upload link whose creator is unknown). */
  userId: string | null;
}

export async function insertMedia(
  env: Env,
  id: string,
  key: string,
  m: Meta,
  status: "ready" | "uploading",
  uploadId: string | null,
  owner: MediaOwner,
  /** "upload_link" for files sent through an upload link (the media sweep removes them when never used). */
  source: "upload_link" | null = null,
) {
  const db = env.DB;
  // A finished upload (already in R2) gets its image thumbnail first, so the row is written once.
  const thumb = status === "ready" && (await makeThumbnail(env, { id, key, mime: m.mime, size: m.size, width: m.width, height: m.height }));
  const t = now();
  const insert = db
    .prepare(
      `INSERT INTO media (id, r2_key, filename, mime, size, kind, width, height, duration, alt, status, upload_id, created_at, workspace_id, created_by, source, has_thumb)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, key, m.filename, m.mime, m.size, kindOf(m.mime), m.width ?? null, m.height ?? null, m.duration ?? null, m.alt ?? null, status, uploadId, t, owner.workspaceId, owner.userId, source, thumb ? 1 : 0);
  if (status !== "ready") return void (await insert.run());
  // Its usage event joins the same batch (multipart uploads record theirs on completion).
  await db.batch([insert, mediaEventStatement(db, { workspaceId: owner.workspaceId, kind: "media_upload", bytes: m.size, mime: m.mime, t, imagesTx: thumb ? 1 : 0 })]);
}

/**
 * Finish a multipart upload of the workspace: complete it in R2, make its image thumbnail, mark the row ready (stored
 * size from R2) and record its usage event (one batch). False when there is no such unfinished upload.
 */
export async function completeMultipart(env: Env, workspaceId: string, id: string, parts: R2UploadedPart[]): Promise<boolean> {
  const db = env.DB;
  const row = await db
    .prepare("SELECT r2_key, upload_id, mime, width, height FROM media WHERE id = ? AND workspace_id = ? AND status = 'uploading'")
    .bind(id, workspaceId)
    .first<{ r2_key: string; upload_id: string; mime: string; width: number | null; height: number | null }>();
  if (!row) return false;
  const obj = await env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id).complete([...parts].sort((a, b) => a.partNumber - b.partNumber));
  const thumb = await makeThumbnail(env, { id, key: row.r2_key, mime: row.mime, size: obj.size, width: row.width, height: row.height });
  const t = now();
  await db.batch([
    db
      .prepare("UPDATE media SET status = 'ready', upload_id = NULL, size = ?, has_thumb = ? WHERE id = ? AND workspace_id = ?")
      .bind(obj.size, thumb ? 1 : 0, id, workspaceId),
    db
      .prepare(
        `INSERT INTO usage_events (workspace_id, kind, outcome, post_type, has_url, media_count, media_bytes, quantity, images_tx, is_demo, created_at, day)
         SELECT workspace_id, 'media_upload', 'ok', kind, 0, 1, size, 1, ?, 0, ?, ? FROM media WHERE id = ? AND workspace_id = ?`,
      )
      .bind(thumb ? 1 : 0, t, utcDay(t), id, workspaceId),
  ]);
  return true;
}

/** DTO of a media item of the workspace, or null when it is not there. */
export async function dto(c: { env: Env; req: { url: string } }, workspaceId: string, id: string) {
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first<MediaRow>();
  return row ? mediaDto(c.env, await baseUrl(c.env, c.req.url), row) : null;
}

const owner = (c: { var: AppEnv["Variables"] }): MediaOwner => ({ workspaceId: c.var.workspace!.id, userId: c.var.user.id });

mediaRoutes.get("/media", requirePermission("media.read"), async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 60, 200);
  const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM media WHERE workspace_id = ? AND status = 'ready' AND created_at < ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(wsId(c), before, limit)
    .all<MediaRow>();
  const base = await baseUrl(c.env, c.req.url);
  return c.json(await Promise.all(results.map((r) => mediaDto(c.env, base, r))));
});

/** Stored bytes of the workspace (and of the instance, for instance admins) next to the R2 Free plan's 10 GB. */
mediaRoutes.get("/media/usage", requirePermission("media.read"), async (c) => {
  const admin = isInstanceAdmin(c.var.instancePermissions);
  const [workspace, instance, retentionDays] = await Promise.all([
    mediaUsage(c.env.DB, wsId(c)),
    admin ? mediaUsage(c.env.DB, null) : Promise.resolve(null),
    mediaRetentionDays(c.env.DB),
  ]);
  const body: MediaUsageDTO = { workspace, instance, freeTierBytes: 10 * 1024 ** 3, retentionDays };
  return c.json(body);
});

/** Single request upload. Raw body; metadata in headers. */
mediaRoutes.post("/media", requirePermission("media.write"), noDemo, async (c) => {
  const meta: Meta = {
    filename: safeDecode(c.req.header("x-filename") ?? ""),
    mime: (c.req.header("content-type") ?? "").split(";")[0],
    size: Number(c.req.header("content-length") ?? 0),
    width: num(c.req.header("x-width")),
    height: num(c.req.header("x-height")),
    duration: num(c.req.header("x-duration")),
  };
  const err = checkMeta(meta);
  if (err) return c.json({ error: err }, 400);
  if (meta.size > SINGLE_UPLOAD_MAX) return c.json({ error: "File too large for a single upload, use multipart" }, 413);
  await enforce(c, { storage_mb: meta.size });
  const id = newId("med_");
  const key = `${id}/${safeFilename(meta.filename)}`;
  await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType: meta.mime } });
  await insertMedia(c.env, id, key, meta, "ready", null, owner(c));
  return c.json(await dto(c, wsId(c), id));
});

/** Import a file from a URL (handy for the API / MCP). */
mediaRoutes.post("/media/from-url", requirePermission("media.write"), noDemo, async (c) => {
  const { url, filename, alt } = await c.req.json<{ url: string; filename?: string; alt?: string }>();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return c.json({ error: "Invalid url" }, 400);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return c.json({ error: "Invalid url" }, 400);
  // Locked workspaces cannot import; the size is checked once the server tells it.
  await enforce(c, {});
  const res = await fetch(parsed.toString(), { redirect: "follow" });
  if (!res.ok || !res.body) return c.json({ error: `Download failed: ${res.status}` }, 400);
  const length = res.headers.get("content-length");
  const meta: Meta = {
    filename: typeof filename === "string" && filename ? filename : safeDecode(parsed.pathname.split("/").pop() || "file"),
    mime: (res.headers.get("content-type") ?? "").split(";")[0],
    size: Number(length ?? 1),
    alt: typeof alt === "string" ? alt : null,
  };
  const err = checkMeta(meta);
  if (err) {
    await res.body.cancel();
    return c.json({ error: err }, 400);
  }
  if (length) {
    try {
      await enforce(c, { storage_mb: meta.size });
    } catch (e) {
      await res.body.cancel();
      throw e;
    }
  }
  // R2 needs a known length for streams; buffer when the server did not send one, within the Worker's memory.
  const body = length ? res.body : await readAtMost(res.body, SINGLE_UPLOAD_MAX);
  if (!body) return c.json({ error: `The server did not send a Content-Length and the file is over ${SINGLE_UPLOAD_MAX / 1024 / 1024}MB` }, 413);
  const id = newId("med_");
  const key = `${id}/${safeFilename(meta.filename)}`;
  const obj = await c.env.MEDIA.put(key, body, { httpMetadata: { contentType: meta.mime } });
  await insertMedia(c.env, id, key, { ...meta, size: obj?.size ?? meta.size }, "ready", null, owner(c));
  return c.json(await dto(c, wsId(c), id));
});

mediaRoutes.post("/media/multipart", requirePermission("media.write"), noDemo, async (c) => {
  const meta = await c.req.json<Meta>();
  const err = checkMeta(meta);
  if (err) return c.json({ error: err }, 400);
  await enforce(c, { storage_mb: meta.size });
  const id = newId("med_");
  const key = `${id}/${safeFilename(meta.filename)}`;
  const upload = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: meta.mime } });
  await insertMedia(c.env, id, key, meta, "uploading", upload.uploadId, owner(c));
  return c.json({ id, partSize: PART_SIZE, parts: Math.ceil(meta.size / PART_SIZE) });
});

export async function multipart(env: Env, workspaceId: string, id: string) {
  const row = await env.DB.prepare("SELECT r2_key, upload_id FROM media WHERE id = ? AND workspace_id = ? AND status = 'uploading'")
    .bind(id, workspaceId)
    .first<{ r2_key: string; upload_id: string }>();
  return row ? env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id) : null;
}

mediaRoutes.put("/media/multipart/:id/:part", requirePermission("media.write"), noDemo, async (c) => {
  const upload = await multipart(c.env, wsId(c), c.req.param("id"));
  if (!upload) return c.json({ error: "Upload not found" }, 404);
  if (!c.req.raw.body) return c.json({ error: "Empty part" }, 400);
  const part = await upload.uploadPart(Number(c.req.param("part")), c.req.raw.body);
  return c.json(part);
});

mediaRoutes.post("/media/multipart/:id/complete", requirePermission("media.write"), noDemo, async (c) => {
  const id = c.req.param("id");
  const { parts } = await c.req.json<{ parts: R2UploadedPart[] }>();
  if (!(await completeMultipart(c.env, wsId(c), id, parts))) return c.json({ error: "Upload not found" }, 404);
  return c.json(await dto(c, wsId(c), id));
});

mediaRoutes.patch("/media/:id", requirePermission("media.write"), noDemo, async (c) => {
  const { alt } = await c.req.json<{ alt: string | null }>();
  await c.env.DB.prepare("UPDATE media SET alt = ? WHERE id = ? AND workspace_id = ?").bind(typeof alt === "string" && alt ? alt.slice(0, 5000) : null, c.req.param("id"), wsId(c)).run();
  const item = await dto(c, wsId(c), c.req.param("id"));
  return item ? c.json(item) : c.json({ error: "Not found" }, 404);
});

mediaRoutes.delete("/media/:id", requirePermission("media.write"), noDemo, async (c) => {
  const row = await c.env.DB.prepare("SELECT id, r2_key, upload_id, status, size, mime, has_thumb FROM media WHERE id = ? AND workspace_id = ?")
    .bind(c.req.param("id"), wsId(c))
    .first<{ id: string; r2_key: string; upload_id: string | null; status: string; size: number; mime: string; has_thumb: number }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  // Deleting it would make these posts fail when they publish.
  const postIds = await postsBlockingMediaDelete(c.env.DB, wsId(c), c.req.param("id"));
  if (postIds.length) {
    return c.json(
      { error: `This file is used by ${postIds.length === 1 ? "a draft, scheduled or unresolved post" : `${postIds.length} draft, scheduled or unresolved posts`}: remove it from ${postIds.length === 1 ? "that post" : "them"} first.`, postIds },
      409,
    );
  }
  if (row.status === "uploading" && row.upload_id) {
    await c.env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => {});
  } else {
    // With MEDIA_PUBLIC_URL, edge and browser caches may still serve the deleted file for up to their TTL (README).
    await c.env.MEDIA.delete(mediaKeys([row]));
  }
  const db = c.env.DB;
  const del = db.prepare("DELETE FROM media WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), wsId(c));
  if (row.status === "ready") {
    await db.batch([del, mediaEventStatement(db, { workspaceId: wsId(c), kind: "media_delete", bytes: row.size, mime: row.mime, t: now() })]);
  } else {
    await del.run();
  }
  return c.json({ ok: true });
});

/** decodeURIComponent that keeps malformed input as is (instead of throwing a 500). */
export function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Reads a stream into memory, or returns null (and cancels it) once it exceeds `max` bytes. */
async function readAtMost(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function num(v: string | undefined): number | null {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : null;
}

/**
 * Public media: /m/:id/:signature/:filename — platforms download attachments from here. With MEDIA_PUBLIC_URL set, new
 * URLs point at the R2 custom domain instead, but these links stay valid (URLs already handed out, posts, self-hosters
 * without a zone).
 */
export const publicMedia = new Hono<AppEnv>();

/**
 * Account avatar copied to R2 (lib/avatars.ts): /m/avatars/:signature/:name, used when MEDIA_PUBLIC_URL is not set.
 * Before the media route, which would take "avatars" for a media id. No D1 read.
 */
publicMedia.on(["GET", "HEAD"], "/avatars/:sig/:name", async (c) => {
  const name = c.req.param("name");
  if (!isAvatarName(name) || !(await verifySignature(c.env, avatarSignedValue(name), c.req.param("sig")))) return c.text("Not found", 404);
  const head = c.req.method === "HEAD";
  const obj: R2Object | R2ObjectBody | null = head ? await c.env.MEDIA.head(avatarKey(name)) : await c.env.MEDIA.get(avatarKey(name), { onlyIf: c.req.raw.headers });
  if (!obj) return c.text("Not found", 404);
  const headers = new Headers({
    "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
    // The name holds the content hash: a new picture gets a new URL.
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    etag: obj.httpEtag,
  });
  if (!head && !("body" in obj)) return new Response(null, { status: 304, headers });
  headers.set("content-length", String(obj.size));
  if (head) return new Response(null, { headers });
  return new Response((obj as R2ObjectBody).body, { headers });
});

/** Image thumbnail: /m/:id/:signature/thumb/480.webp (same signature). No D1 read: thumbnails exist only for finished uploads and are deleted with them. */
publicMedia.on(["GET", "HEAD"], "/:id/:sig/thumb/:name", async (c) => {
  const id = c.req.param("id");
  if (!(await verifySignature(c.env, `media:${id}`, c.req.param("sig")))) return c.text("Not found", 404);
  const head = c.req.method === "HEAD";
  const obj: R2Object | R2ObjectBody | null = head ? await c.env.MEDIA.head(thumbKey(id)) : await c.env.MEDIA.get(thumbKey(id), { onlyIf: c.req.raw.headers });
  if (!obj) return c.text("Not found", 404);
  const headers = new Headers({ "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag });
  if (!head && !("body" in obj)) return new Response(null, { status: 304, headers });
  headers.set("content-length", String(obj.size));
  if (head) return new Response(null, { headers });
  return new Response((obj as R2ObjectBody).body, { headers });
});

publicMedia.on(["GET", "HEAD"], "/:id/:sig/:name?", async (c) => {
  const id = c.req.param("id");
  if (!(await verifySignature(c.env, `media:${id}`, c.req.param("sig")))) return c.text("Not found", 404);
  const row = await c.env.DB.prepare("SELECT r2_key, mime FROM media WHERE id = ? AND status = 'ready'")
    .bind(id)
    .first<{ r2_key: string; mime: string }>();
  if (!row) return c.text("Not found", 404);

  const headers = new Headers({
    "content-type": row.mime,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
  });
  if (c.req.method === "HEAD") {
    const head = await c.env.MEDIA.head(row.r2_key);
    if (!head) return c.text("Not found", 404);
    headers.set("content-length", String(head.size));
    headers.set("etag", head.httpEtag);
    return new Response(null, { headers });
  }
  let obj: R2Object | R2ObjectBody | null;
  try {
    obj = await c.env.MEDIA.get(row.r2_key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
  } catch (err) {
    // R2 rejects ranges past the end of the object.
    if (!c.req.header("range")) throw err;
    const head = await c.env.MEDIA.head(row.r2_key);
    return new Response(null, { status: 416, headers: head ? { "content-range": `bytes */${head.size}` } : {} });
  }
  if (!obj) return c.text("Not found", 404);
  headers.set("etag", obj.httpEtag);
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && c.req.header("range")) {
    // Clamp: the requested range may extend past the end of the object.
    const offset = range.suffix !== undefined ? Math.max(obj.size - range.suffix, 0) : range.offset ?? 0;
    const length = Math.min(range.suffix ?? range.length ?? obj.size - offset, obj.size - offset);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
});
