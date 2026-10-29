// Account avatars. Platforms hand out signed, expiring picture URLs (Instagram / Facebook `profile_picture_url`, TikTok
// `avatar_url`...): stored as is, they break after a few days and the apps fall back to initials. So the picture is
// copied into R2 at `avatars/<account id>-<content hash>.<ext>` when an account is connected, and re-checked about
// weekly by the frequent cron (`refreshAvatars` in lib/accounts.ts, a few accounts per tick, fresh URL from
// `Provider.profile`). `accounts.avatar_url` holds the copy's public URL: the MEDIA_PUBLIC_URL custom domain when set,
// else a signed `/m/avatars/:sig/:name` link of the Worker. Copies never block connecting: on any failure the
// platform's URL is kept and retried later.

import { sign } from "./crypto";
import { mediaCdn } from "./media";

/** Bigger pictures are not copied (platform avatars are 10-200 KB). */
export const AVATAR_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const PREFIX = "avatars/";
/** Pictures copied per connect (a Facebook login may return dozens of Pages): the rest is copied by the cron. */
export const AVATARS_PER_CONNECT = 10;

/** Image types we keep, by magic bytes (never SVG: it could carry scripts). */
function sniff(b: Uint8Array): { mime: string; ext: string } | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: "image/gif", ext: "gif" };
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

/** File names we write: `<account id>-<16 hex>.<ext>`. */
const NAME = /^[\w-]+-[0-9a-f]{16}\.(?:jpg|png|gif|webp)$/;
const SUFFIX = /^[0-9a-f]{16}\.(?:jpg|png|gif|webp)$/;
/** `name` is a stored avatar of this very account (not of an account whose id merely starts the same). */
const ownName = (name: string, accountId: string) => name.startsWith(`${accountId}-`) && SUFFIX.test(name.slice(accountId.length + 1));

/** Public URL of a stored avatar (CDN, else the signed Worker route; `base` is only needed then). */
export async function avatarUrl(env: Env, base: string | null, name: string): Promise<string | null> {
  const cdn = mediaCdn(env);
  if (cdn) return `${cdn}/${PREFIX}${name}`;
  if (!base) return null;
  return `${base}/m/avatars/${await sign(env, avatarSignedValue(name))}/${name}`;
}

/** What the `/m/avatars/:sig/:name` signature covers. */
export const avatarSignedValue = (name: string) => `avatar:${name}`;
export const avatarKey = (name: string) => `${PREFIX}${name}`;
export const isAvatarName = (name: string) => NAME.test(name);

/** File name of a copy of this account's avatar in `url` (any of our URL forms), else null (a platform URL). */
export function storedAvatarName(url: string | null | undefined, accountId: string): string | null {
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  return path.includes(`/${PREFIX}`) && ownName(name, accountId) ? name : null;
}

/** Reads at most `max` bytes; null when the body is bigger. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Download `remote` (https, ≤ AVATAR_MAX_BYTES, JPEG/PNG/GIF/WebP) and store it for the account. Returns the stored
 * file's name and public URL, or null on any failure (never throws). The same picture keeps the same name, so
 * re-checks of an unchanged avatar rewrite nothing.
 */
export async function copyAvatar(
  env: Env,
  base: string | null,
  accountId: string,
  remote: string,
): Promise<{ name: string; url: string } | null> {
  try {
    if (!/^https:\/\//i.test(remote) || !env.MEDIA) return null;
    const res = await fetch(remote, { headers: { accept: "image/*" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (Number(res.headers.get("content-length") ?? 0) > AVATAR_MAX_BYTES) {
      await res.body.cancel().catch(() => {});
      return null;
    }
    const bytes = await readCapped(res.body, AVATAR_MAX_BYTES);
    const type = bytes && sniff(bytes);
    if (!bytes || !type) return null;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const name = `${accountId}-${hash}.${type.ext}`;
    const url = await avatarUrl(env, base, name);
    if (!url) return null;
    if (!(await env.MEDIA.head(avatarKey(name)))) {
      await env.MEDIA.put(avatarKey(name), bytes, { httpMetadata: { contentType: type.mime, cacheControl: "public, max-age=31536000, immutable" } });
    }
    return { name, url };
  } catch (err) {
    console.warn(`avatar copy for ${accountId} failed`, err);
    return null;
  }
}

/** Delete the account's stored avatars, except `keep` (one R2 list per account). Never throws. */
export async function deleteAvatars(env: Env, accountIds: string[], keep?: string | null): Promise<void> {
  if (!env.MEDIA) return;
  await Promise.all(
    accountIds.map(async (id) => {
      try {
        const { objects } = await env.MEDIA.list({ prefix: `${PREFIX}${id}-`, limit: 100 });
        const keys = objects.map((o) => o.key).filter((k) => ownName(k.slice(PREFIX.length), id) && k !== (keep ? avatarKey(keep) : null));
        if (keys.length) await env.MEDIA.delete(keys);
      } catch (err) {
        console.warn(`avatar cleanup for ${id} failed`, err);
      }
    }),
  );
}
