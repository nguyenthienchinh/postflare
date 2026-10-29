import type { MediaDTO } from "../../shared/types";
import type { MediaAccess, MediaItem } from "../providers/types";
import { ProviderError } from "../providers/errors";
import { fixedLength } from "../providers/multipart";
import { sign } from "./crypto";

export interface MediaRow {
  id: string;
  r2_key: string;
  filename: string;
  mime: string;
  size: number;
  kind: "image" | "video";
  width: number | null;
  height: number | null;
  duration: number | null;
  alt: string | null;
  status: string;
  upload_id: string | null;
  created_at: number;
  workspace_id: string | null;
  created_by: string | null;
  /** 1 when the image has a thumbnail at `thumbKey(id)` (migration 0016). */
  has_thumb?: number;
}

/** Longest side of image thumbnails (px). */
export const THUMB_SIZE = 480;
/** R2 key of a media item's thumbnail. A sub-path: `safeFilename` never makes a "/", so it cannot be the file itself. */
export const thumbKey = (id: string) => `${id}/thumb/${THUMB_SIZE}.webp`;
/** Path of the thumbnail under the signed /m/:id/:sig/ prefix. */
const THUMB_PATH = `thumb/${THUMB_SIZE}.webp`;
/** Images bigger than this get no thumbnail (beyond what the Images binding takes as input). */
const THUMB_INPUT_MAX = 70 * 1024 * 1024;

/**
 * Origin of the public R2 custom domain (`MEDIA_PUBLIC_URL`, e.g. https://cdn.example.com), or null when unset.
 * When set, media URLs point straight at R2 (`<origin>/<r2_key>`): views cost no Worker request, D1 or R2 read.
 */
export function mediaCdn(env: Env): string | null {
  const v = env.MEDIA_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return v && /^https?:\/\/[^/]+$/.test(v) ? v : null;
}

const cdnUrl = (cdn: string, key: string) => `${cdn}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** `${base}/m/:id/:sig` — the signed public prefix (always served by the Worker, also when a CDN is set). */
async function signedPrefix(env: Env, base: string, id: string): Promise<string> {
  return `${base}/m/${id}/${await sign(env, `media:${id}`)}`;
}

type UrlRow = Pick<MediaRow, "id" | "filename"> & Partial<Pick<MediaRow, "r2_key" | "status" | "has_thumb">>;

/**
 * Public URL of a media file (platforms pull it, apps show it). The CDN URL only for finished uploads (`status =
 * 'ready'`): unfinished ones get the signed /m/ link, which answers 404 until the upload completes.
 */
export async function publicMediaUrl(env: Env, base: string, row: UrlRow, prefix?: string): Promise<string> {
  const cdn = mediaCdn(env);
  if (cdn && row.r2_key && row.status === "ready") return cdnUrl(cdn, row.r2_key);
  return `${prefix ?? (await signedPrefix(env, base, row.id))}/${encodeURIComponent(safeFilename(row.filename))}`;
}

/** URL of the image's thumbnail, or null (videos, images uploaded before thumbnails, failed transforms). */
export async function thumbnailUrl(env: Env, base: string, row: UrlRow, prefix?: string): Promise<string | null> {
  if (!row.has_thumb || row.status !== "ready") return null;
  const cdn = mediaCdn(env);
  if (cdn) return cdnUrl(cdn, thumbKey(row.id));
  return `${prefix ?? (await signedPrefix(env, base, row.id))}/${THUMB_PATH}`;
}

/**
 * Make the WebP thumbnail of a just-stored image (one Images transformation, one R2 read and write). Returns whether it
 * exists; never throws (the upload must not fail because of its thumbnail). GIFs use their first frame.
 */
export async function makeThumbnail(
  env: Env,
  m: { id: string; key: string; mime: string; size: number; width?: number | null; height?: number | null },
): Promise<boolean> {
  if (!m.mime.startsWith("image/") || !env.IMAGES || m.size > THUMB_INPUT_MAX) return false;
  // Already small: the file itself is the thumbnail (saves a transformation).
  if (m.width && m.height && Math.max(m.width, m.height) <= THUMB_SIZE && m.size <= 256 * 1024) return false;
  try {
    const obj = await env.MEDIA.get(m.key);
    if (!obj) return false;
    const result = await env.IMAGES.input(obj.body)
      .transform({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80, anim: false });
    const bytes = await result.response().arrayBuffer();
    if (!bytes.byteLength) return false;
    await env.MEDIA.put(thumbKey(m.id), bytes, { httpMetadata: { contentType: "image/webp" } });
    return true;
  } catch (err) {
    console.warn(`thumbnail of ${m.id} failed`, err);
    return false;
  }
}

/** R2 keys of media rows (file + thumbnail) to delete. */
export function mediaKeys(rows: Array<{ id: string; r2_key: string; has_thumb?: number | null }>): string[] {
  return rows.flatMap((r) => (r.has_thumb ? [r.r2_key, thumbKey(r.id)] : [r.r2_key]));
}

export function safeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";
}

export async function mediaDto(env: Env, base: string, row: MediaRow): Promise<MediaDTO> {
  // One signature for both URLs (none when both are CDN URLs).
  const prefix = mediaCdn(env) && row.status === "ready" ? undefined : await signedPrefix(env, base, row.id);
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    width: row.width,
    height: row.height,
    duration: row.duration,
    alt: row.alt,
    url: await publicMediaUrl(env, base, row, prefix),
    thumbUrl: await thumbnailUrl(env, base, row, prefix),
    createdAt: row.created_at,
  };
}

export async function loadMediaItems(env: Env, base: string, ids: string[]): Promise<MediaItem[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM media WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<MediaRow>();
  const byId = new Map(results.map((r) => [r.id, r]));
  const items: MediaItem[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    // Definite, pre-send failures: the post fails (not retried, nothing reached the platform).
    if (!row) throw new ProviderError(`Media ${id} not found (it was deleted)`, "invalid");
    if (row.status !== "ready") throw new ProviderError(`Media ${row.filename} has not finished uploading`, "invalid");
    items.push({
      id: row.id,
      kind: row.kind,
      mime: row.mime,
      filename: row.filename,
      size: row.size,
      width: row.width,
      height: row.height,
      duration: row.duration,
      alt: row.alt,
      url: await publicMediaUrl(env, base, row),
      r2Key: row.r2_key,
    });
  }
  return items;
}

export function mediaAccess(env: Env): MediaAccess {
  const keyFor = async (item: MediaItem) => {
    if (item.r2Key) return item.r2Key;
    const row = await env.DB.prepare("SELECT r2_key FROM media WHERE id = ?").bind(item.id).first<{ r2_key: string }>();
    if (!row) throw new Error(`Media ${item.id} not found`);
    return row.r2_key;
  };
  const get = async (item: MediaItem, range?: R2Range) => {
    const obj = await env.MEDIA.get(await keyFor(item), range ? { range } : undefined);
    if (!obj) throw new ProviderError(`Media file ${item.filename} is missing from storage`, "invalid");
    return obj;
  };
  return {
    stream: async (item, range) => (await get(item, range && { offset: range.offset, length: Math.max(0, Math.min(range.length, item.size - range.offset)) })).body,
    bytes: async (item) => (await get(item)).arrayBuffer(),
    rangeStream: async (item, offset, length) => {
      const len = Math.max(0, Math.min(length, item.size - offset));
      return fixedLength((await get(item, { offset, length: len })).body, len);
    },
    range: async (item, offset, length) => (await get(item, { offset, length })).arrayBuffer(),
    blob: async (item) => new Blob([await (await get(item)).arrayBuffer()], { type: item.mime }),
    image: async (item, opts) => {
      const format = opts.format ?? "image/jpeg";
      const result = await env.IMAGES.input((await get(item)).body)
        .transform({ width: opts.maxWidth, height: opts.maxHeight, fit: "scale-down" })
        .output({ format, quality: opts.quality ?? 85 });
      return new Blob([await result.response().arrayBuffer()], { type: format });
    },
  };
}
