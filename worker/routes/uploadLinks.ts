import { Hono, type Context } from "hono";
import { BILLING_COLUMNS, assertNotLocked, enforceWorkspace, snapshotFromRow, type BillingColumnsRow, type BillingSnapshot } from "../billing/entitlements";
import { forbidInDemoWorkspace, requirePermission, wsId, type AppEnv } from "../lib/auth";
import { mediaDto, safeFilename, type MediaRow } from "../lib/media";
import { baseUrl } from "../lib/settings";
import { newId, now, parseJson, randomToken, sha256Hex } from "../lib/util";
import { PART_SIZE, SINGLE_UPLOAD_MAX, checkMeta, completeMultipart, dto, insertMedia, multipart, num, safeDecode, type Meta } from "./media";

/**
 * Upload links (reusable until they expire, at most MAX_LINK_FILES files). An AI client (claude.ai, mobile apps) cannot pass chat attachments to MCP tools, so it
 * creates a link instead: the user opens it on their phone and picks files, or the AI's code sandbox PUTs the bytes.
 * The link token is the only credential and only allows uploading media.
 */

interface LinkRow {
  id: string;
  token_hash: string;
  note: string | null;
  media: string;
  created_at: number;
  expires_at: number;
  workspace_id: string;
  created_by: string | null;
  /** Billing state of the link's workspace (read with the link). */
  billing?: BillingSnapshot;
}

const DEFAULT_TTL_MIN = 120;
/** Files one link accepts: anyone holding the link can upload until it expires, so cap what they can store. */
export const MAX_LINK_FILES = 50;
const MAX_TTL_MIN = 7 * 24 * 60;

async function linkMedia(env: Env, base: string, row: LinkRow) {
  const ids = parseJson<string[]>(row.media, []);
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT * FROM media WHERE workspace_id = ? AND status = 'ready' AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(row.workspace_id, ...ids)
    .all<MediaRow>();
  return Promise.all(results.map((r) => mediaDto(env, base, r)));
}

/** Authenticated API: create and inspect links. */
export const uploadLinkRoutes = new Hono<AppEnv>();

uploadLinkRoutes.post("/upload-links", requirePermission("media.write"), forbidInDemoWorkspace("Uploading media"), async (c) => {
  const body = await c.req.json<{ expiresMinutes?: number; note?: string }>().catch(() => ({}) as { expiresMinutes?: number; note?: string });
  const ttl = Math.min(Math.max(Number(body.expiresMinutes) || DEFAULT_TTL_MIN, 5), MAX_TTL_MIN);
  await assertNotLocked(c);
  const token = randomToken(24);
  const id = newId("upl_");
  const t = now();
  await c.env.DB.prepare(
    "INSERT INTO upload_links (id, token_hash, note, created_at, expires_at, workspace_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, await sha256Hex(token), body.note?.slice(0, 200) ?? null, t, t + ttl * 60_000, wsId(c), c.var.user.id)
    .run();
  const base = await baseUrl(c.env, c.req.url);
  return c.json(
    {
      id,
      pageUrl: `${base}/u/${token}`,
      putUrl: `${base}/u/${token}/file`,
      expiresAt: t + ttl * 60_000,
    },
    201,
  );
});

uploadLinkRoutes.get("/upload-links/:id", requirePermission("media.read"), async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM upload_links WHERE id = ? AND workspace_id = ?")
    .bind(c.req.param("id"), wsId(c))
    .first<LinkRow>();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({
    id: row.id,
    note: row.note,
    expiresAt: row.expires_at,
    expired: row.expires_at < now(),
    media: await linkMedia(c.env, await baseUrl(c.env, c.req.url), row),
  });
});

/** Public routes under /u/:token. */
export const uploadLinkPublic = new Hono<AppEnv>();

async function findLink(c: Context<AppEnv>): Promise<LinkRow | null> {
  const token = c.req.param("token") ?? "";
  if (token.length < 20) return null;
  const row = await c.env.DB.prepare(`SELECT l.*, w.is_demo, ${BILLING_COLUMNS} FROM upload_links l LEFT JOIN workspaces w ON w.id = l.workspace_id WHERE l.token_hash = ?`)
    .bind(await sha256Hex(token))
    .first<LinkRow & BillingColumnsRow>();
  // Media uploaded through the link goes into the link's workspace (never a demo workspace).
  return row && row.expires_at > now() && row.workspace_id && !row.is_demo ? { ...row, billing: snapshotFromRow(row) } : null;
}

/** Hosted mode: the link's workspace must have storage left for `bytes` (402 otherwise; no query while billing is off). */
const checkStorage = (c: Context<AppEnv>, link: LinkRow, bytes: number) => enforceWorkspace(c.env.DB, link.workspace_id, link.billing, { storage_mb: bytes }, c.req.url);

const linkOwner = (link: LinkRow) => ({ workspaceId: link.workspace_id, userId: link.created_by });

async function attach(env: Env, linkId: string, mediaId: string) {
  await env.DB.prepare("UPDATE upload_links SET media = json_insert(media, '$[#]', ?) WHERE id = ?").bind(mediaId, linkId).run();
}

const gone = (c: Context<AppEnv>) => c.json({ error: "This upload link is invalid or has expired" }, 410);
const full = (link: LinkRow) => parseJson<string[]>(link.media, []).length >= MAX_LINK_FILES;
const tooMany = (c: Context<AppEnv>) => c.json({ error: `An upload link accepts at most ${MAX_LINK_FILES} files: create a new link` }, 409);

uploadLinkPublic.get("/:token", async (c) => {
  const link = await findLink(c);
  if (!link) return c.html(page(null), 410);
  return c.html(page({ note: link.note, expiresAt: link.expires_at }));
});

/** Single-request upload (≤90MB). Raw body; metadata in headers or query (?filename=). */
uploadLinkPublic.on(["PUT", "POST"], "/:token/file", async (c) => {
  const link = await findLink(c);
  if (!link) return gone(c);
  if (full(link)) return tooMany(c);
  const meta: Meta = {
    filename: safeDecode(c.req.header("x-filename") ?? c.req.query("filename") ?? ""),
    mime: (c.req.header("content-type") ?? "").split(";")[0],
    size: Number(c.req.header("content-length") ?? 0),
    width: num(c.req.header("x-width") ?? c.req.query("width")),
    height: num(c.req.header("x-height") ?? c.req.query("height")),
    duration: num(c.req.header("x-duration") ?? c.req.query("duration")),
    alt: c.req.header("x-alt") ? safeDecode(c.req.header("x-alt")!) : null,
  };
  const err = checkMeta(meta);
  if (err) return c.json({ error: err }, 400);
  if (meta.size > SINGLE_UPLOAD_MAX) return c.json({ error: "File too large for a single upload, use multipart" }, 413);
  await checkStorage(c, link, meta.size);
  const id = newId("med_");
  const key = `${id}/${safeFilename(meta.filename)}`;
  await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType: meta.mime } });
  await insertMedia(c.env, id, key, meta, "ready", null, linkOwner(link), "upload_link");
  await attach(c.env, link.id, id);
  return c.json(await dto(c, link.workspace_id, id));
});

uploadLinkPublic.post("/:token/multipart", async (c) => {
  const link = await findLink(c);
  if (!link) return gone(c);
  if (full(link)) return tooMany(c);
  const meta = await c.req.json<Meta>();
  const err = checkMeta(meta);
  if (err) return c.json({ error: err }, 400);
  await checkStorage(c, link, meta.size);
  const id = newId("med_");
  const key = `${id}/${safeFilename(meta.filename)}`;
  const upload = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: meta.mime } });
  await insertMedia(c.env, id, key, meta, "uploading", upload.uploadId, linkOwner(link), "upload_link");
  await attach(c.env, link.id, id);
  return c.json({ id, partSize: PART_SIZE, parts: Math.ceil(meta.size / PART_SIZE) });
});

/** The media must have been started through this same link. */
function owns(link: LinkRow, mediaId: string) {
  return parseJson<string[]>(link.media, []).includes(mediaId);
}

uploadLinkPublic.put("/:token/multipart/:id/:part", async (c) => {
  const link = await findLink(c);
  if (!link) return gone(c);
  if (!owns(link, c.req.param("id"))) return c.json({ error: "Upload not found" }, 404);
  const upload = await multipart(c.env, link.workspace_id, c.req.param("id"));
  if (!upload) return c.json({ error: "Upload not found" }, 404);
  if (!c.req.raw.body) return c.json({ error: "Empty part" }, 400);
  return c.json(await upload.uploadPart(Number(c.req.param("part")), c.req.raw.body));
});

uploadLinkPublic.post("/:token/multipart/:id/complete", async (c) => {
  const link = await findLink(c);
  if (!link) return gone(c);
  const id = c.req.param("id");
  if (!owns(link, id)) return c.json({ error: "Upload not found" }, 404);
  const { parts } = await c.req.json<{ parts: R2UploadedPart[] }>();
  if (!(await completeMultipart(c.env, link.workspace_id, id, parts))) return c.json({ error: "Upload not found" }, 404);
  return c.json(await dto(c, link.workspace_id, id));
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function page(link: { note: string | null; expiresAt: number } | null): string {
  const body = link
    ? `<h1>Upload media</h1>
  ${link.note ? `<p class="note">${escapeHtml(link.note)}</p>` : ""}
  <label class="pick"><input id="files" type="file" accept="image/*,video/*" multiple><span>Choose photos or videos</span></label>
  <ul id="list"></ul>
  <p class="muted" id="done" hidden>Done. You can go back to the chat — your assistant can see these files now.</p>
  <p class="muted">Link expires ${new Date(link.expiresAt).toUTCString()}.</p>`
    : `<h1>Link expired</h1><p class="muted">Ask your assistant for a new upload link.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Postflare upload</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;font-family:-apple-system,system-ui,sans-serif}
body{max-width:520px;margin:0 auto;padding:32px 20px}
h1{font-size:22px;margin:0 0 8px}.note{margin:0 0 16px}.muted{color:#888;font-size:13px}
.pick{display:block;margin:20px 0;padding:28px;border:2px dashed #f97316;border-radius:16px;text-align:center;font-weight:600;color:#ea580c;cursor:pointer}
.pick input{display:none}ul{list-style:none;padding:0}
li{padding:10px 0;border-bottom:1px solid #8883;font-size:14px}
.bar{height:6px;background:#8883;border-radius:3px;margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#f97316}
.ok{color:#16a34a}.err{color:#dc2626}
</style></head><body>${body}
<script>
const base = location.pathname.replace(/\\/$/, "");
const MAX_SINGLE = ${SINGLE_UPLOAD_MAX};
const input = document.getElementById("files");
if (input) input.addEventListener("change", async () => {
  const files = [...input.files];
  for (const f of files) await upload(f);
  document.getElementById("done").hidden = false;
});
function dims(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    if (file.type.startsWith("video/")) {
      const v = document.createElement("video"); v.preload = "metadata";
      v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
      v.onerror = () => done({}); v.src = url;
    } else {
      const i = new Image(); i.onload = () => done({ width: i.naturalWidth, height: i.naturalHeight }); i.onerror = () => done({}); i.src = url;
    }
  });
}
function send(method, url, body, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open(method, url);
    for (const k in headers) x.setRequestHeader(k, headers[k]);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    x.onload = () => { let j = null; try { j = JSON.parse(x.responseText); } catch {}
      x.status < 300 ? resolve(j) : reject(new Error((j && j.error) || "HTTP " + x.status)); };
    x.onerror = () => reject(new Error("Network error")); x.send(body);
  });
}
async function upload(file) {
  const li = document.createElement("li");
  li.innerHTML = '<div></div><div class="bar"><i></i></div>';
  li.firstChild.textContent = file.name;
  document.getElementById("list").append(li);
  const bar = li.querySelector("i");
  const progress = (n) => (bar.style.width = Math.min(100, (n / file.size) * 100) + "%");
  try {
    const d = await dims(file);
    const type = file.type || (/\\.mov$/i.test(file.name) ? "video/quicktime" : "application/octet-stream");
    if (file.size <= MAX_SINGLE) {
      const h = { "Content-Type": type, "X-Filename": encodeURIComponent(file.name) };
      if (d.width) { h["X-Width"] = d.width; h["X-Height"] = d.height; }
      if (d.duration) h["X-Duration"] = d.duration;
      await send("PUT", base + "/file", file, h, progress);
    } else {
      const start = await send("POST", base + "/multipart", JSON.stringify({ filename: file.name, mime: type, size: file.size, ...d }), { "Content-Type": "application/json" }, () => {});
      const parts = [];
      for (let p = 0; p * start.partSize < file.size; p++) {
        const off = p * start.partSize;
        parts.push(await send("PUT", base + "/multipart/" + start.id + "/" + (p + 1), file.slice(off, off + start.partSize), {}, (n) => progress(off + n)));
      }
      await send("POST", base + "/multipart/" + start.id + "/complete", JSON.stringify({ parts }), { "Content-Type": "application/json" }, () => {});
    }
    progress(file.size);
    li.firstChild.className = "ok"; li.firstChild.textContent = "✓ " + file.name;
  } catch (e) {
    li.firstChild.className = "err"; li.firstChild.textContent = "✗ " + file.name + " — " + e.message;
  }
}
</script></body></html>`;
}
