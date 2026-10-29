// Push notifications to the Postflare iOS app (APNs, token auth with an ES256 JWT signed by Web Crypto): publish
// results (published / failed / needs_check), "sign in on the web" requests (docs/app-login-spec.md) and new access
// requests (instance admins). Texts are
// localized on the device (title-loc-key / loc-key + args; the keys are listed in docs/ios-api.md "Push
// notifications"); `title` / `body` carry an English fallback.
//
// Free plan budget: the target devices come from one query (in the same D1 batch as the status change for publish
// results), at most MAX_DEVICES_PER_EVENT APNs requests per event (in parallel), and at most one batch afterwards
// (dead tokens, last_push_at).

import { es256Jwt } from "./crypto";
import { now, parseJson } from "./util";

/** Notification preferences of one device (devices.prefs). */
export interface DevicePrefs {
  /** A post was published. */
  published: boolean;
  /** A post failed, or needs a check (the platform may or may not have it). */
  failed: boolean;
  /** Instance admins: a new access request (only sent to users with instance.users.manage). */
  accessRequests: boolean;
  /** Support staff: a customer wrote in the support chat (only sent to users with instance.support.manage). */
  support: boolean;
  /** Only posts of these workspaces; null = every workspace the user can see posts of. */
  workspaces: string[] | null;
}

export const DEFAULT_PREFS: DevicePrefs = { published: true, failed: true, accessRequests: true, support: true, workspaces: null };

export function parsePrefs(json: string | null | undefined): DevicePrefs {
  return cleanPrefs(parseJson<unknown>(json, {}), DEFAULT_PREFS);
}

/** `base` updated with the valid fields of an untrusted prefs object (unknown fields are dropped). */
export function cleanPrefs(input: unknown, base: DevicePrefs): DevicePrefs {
  const out = { ...base };
  if (!input || typeof input !== "object") return out;
  const src = input as Record<string, unknown>;
  if (typeof src.published === "boolean") out.published = src.published;
  if (typeof src.failed === "boolean") out.failed = src.failed;
  if (typeof src.accessRequests === "boolean") out.accessRequests = src.accessRequests;
  if (typeof src.support === "boolean") out.support = src.support;
  if (src.workspaces === null) out.workspaces = null;
  else if (Array.isArray(src.workspaces)) out.workspaces = [...new Set(src.workspaces.filter((w): w is string => typeof w === "string" && w.length <= 64))].slice(0, 100);
  return out;
}

/** At most this many devices get a push per event (the most recently used ones); keeps one event far below 50 fetches. */
export const MAX_DEVICES_PER_EVENT = 10;

export function apnsConfigured(env: Env): boolean {
  return !!(env.APNS_PRIVATE_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);
}

let jwtCache: { value: string; at: number; key: string } | null = null;

/** Provider token for APNs: Apple wants it refreshed at most every 20 minutes and at least every hour. */
async function apnsJwt(env: Env): Promise<string> {
  const key = `${env.APNS_TEAM_ID}:${env.APNS_KEY_ID}`;
  if (jwtCache && jwtCache.key === key && jwtCache.at > Date.now() - 40 * 60_000) return jwtCache.value;
  const value = await es256Jwt(env.APNS_PRIVATE_KEY!, { kid: env.APNS_KEY_ID }, { iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) });
  jwtCache = { value, at: Date.now(), key };
  return value;
}

/** For tests: forget the cached provider token. */
export function resetApnsJwt() {
  jwtCache = null;
}

export interface PushDevice {
  id: string;
  apns_token: string;
  environment: string;
}

export interface Alert {
  titleKey: string;
  titleArgs: string[];
  bodyKey: string;
  bodyArgs: string[];
  /** English fallback texts. */
  title: string;
  body: string;
  /** Groups notifications in Notification Center (aps.thread-id). */
  threadId: string;
  category?: string;
  interruption?: "passive" | "active" | "time-sensitive";
  /** Custom keys next to `aps` ({ type, ... }). */
  data: Record<string, string>;
  collapseId?: string;
  /** Unix seconds after which APNs drops an undelivered notification (default: one hour). */
  expiration?: number;
}

export function alertPayload(a: Alert) {
  return {
    aps: {
      // An empty key means the text is user content (support messages): no localization.
      alert: {
        title: a.title,
        body: a.body,
        ...(a.titleKey ? { "title-loc-key": a.titleKey, "title-loc-args": a.titleArgs } : {}),
        ...(a.bodyKey ? { "loc-key": a.bodyKey, "loc-args": a.bodyArgs } : {}),
      },
      sound: "default",
      "thread-id": a.threadId,
      ...(a.category ? { category: a.category } : {}),
      "interruption-level": a.interruption ?? "active",
    },
    ...a.data,
  };
}

type SendResult = { ok: boolean; status: number; reason?: string; dead: boolean };

async function send(env: Env, jwt: string, device: PushDevice, a: Alert): Promise<SendResult> {
  const host = device.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  try {
    const res = await fetch(`https://${host}/3/device/${device.apns_token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": env.APNS_TOPIC!,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(a.expiration ?? Math.floor(Date.now() / 1000) + 3600),
        ...(a.collapseId ? { "apns-collapse-id": a.collapseId.slice(0, 64) } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(alertPayload(a)),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, status: res.status, dead: false };
    const reason = ((await res.json().catch(() => ({}))) as { reason?: string }).reason;
    // 410 Unregistered (app removed / push turned off), or a token that is not for this app or environment.
    const dead = res.status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic";
    // A rejected provider token is signed again on the next event.
    if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") jwtCache = null;
    console.warn(JSON.stringify({ event: "apns_rejected", status: res.status, reason, environment: device.environment }));
    return { ok: false, status: res.status, reason, dead };
  } catch (err) {
    console.warn(JSON.stringify({ event: "apns_failed", message: (err as Error)?.message ?? String(err) }));
    return { ok: false, status: 0, dead: false };
  }
}

/**
 * Sends `alert` to the devices (at most MAX_DEVICES_PER_EVENT, in parallel). Dead tokens are cleared (push off for
 * that device, the device itself stays signed in) and last_push_at recorded: one batch, only if anything changed.
 * Never throws.
 */
export async function pushAlert(env: Env, db: D1Database, devices: PushDevice[], alert: Alert): Promise<{ sent: number; removed: number }> {
  const list = devices.slice(0, MAX_DEVICES_PER_EVENT);
  if (!apnsConfigured(env) || !list.length) return { sent: 0, removed: 0 };
  let jwt: string;
  try {
    jwt = await apnsJwt(env);
  } catch (err) {
    console.error("APNs key could not be used (APNS_PRIVATE_KEY must be the .p8 file contents)", (err as Error)?.message);
    return { sent: 0, removed: 0 };
  }
  const results = await Promise.all(list.map((d) => send(env, jwt, d, alert)));
  const sent = list.filter((_, i) => results[i].ok).map((d) => d.id);
  const dead = list.filter((_, i) => results[i].dead).map((d) => d.id);
  const t = now();
  const marks = (ids: string[]) => ids.map(() => "?").join(",");
  const writes = [
    ...(sent.length ? [db.prepare(`UPDATE devices SET last_push_at = ? WHERE id IN (${marks(sent)})`).bind(t, ...sent)] : []),
    ...(dead.length ? [db.prepare(`UPDATE devices SET apns_token = NULL, updated_at = ? WHERE id IN (${marks(dead)})`).bind(t, ...dead)] : []),
  ];
  if (writes.length) await db.batch(writes).catch((err) => console.error("push bookkeeping failed", err));
  return { sent: sent.length, removed: dead.length };
}

/** "First line of the post…" for notification bodies. */
export function snippet(text: string | null | undefined, max = 100): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// ---------- Publish results ----------

export type PostPushKind = "published" | "failed" | "needs_check";

/** Loc keys of the notifications (the iOS app ships their strings; docs/ios-api.md lists them in en and tr). */
export const PUSH_KEYS = {
  postTitle: "PUSH_POST_TITLE",
  published: "PUSH_POST_PUBLISHED_BODY",
  publishedEmpty: "PUSH_POST_PUBLISHED_BODY_EMPTY",
  failed: "PUSH_POST_FAILED_BODY",
  needsCheck: "PUSH_POST_NEEDS_CHECK_BODY",
  webLoginTitle: "PUSH_WEB_LOGIN_TITLE",
  webLoginBody: "PUSH_WEB_LOGIN_BODY",
  testTitle: "PUSH_TEST_TITLE",
  testBody: "PUSH_TEST_BODY",
  accessRequestTitle: "PUSH_ACCESS_REQUEST_TITLE",
  accessRequestBody: "PUSH_ACCESS_REQUEST_BODY",
  supportTitle: "PUSH_SUPPORT_TITLE",
} as const;

interface PostPushRow extends PushDevice {
  account_name: string | null;
  provider: string | null;
  content: string;
  error: string | null;
  workspace_id: string;
}

/** What the "notify" step of the publish workflow sends (returned by the mark step, so it is a plain JSON value). */
export interface PostPushJob {
  kind: PostPushKind;
  postId: string;
  workspaceId: string;
  accountName: string;
  provider: string;
  /** Post text (published, needs_check) or the error (failed), already shortened. */
  text: string;
  devices: PushDevice[];
}

/**
 * The devices to notify about a post's publish result, for the mark step's batch (no extra round trip): only when
 * the guarded status change of that batch happened (same guard as its log: revision, status and updated_at = t).
 * Members of the post's workspace whose role can see posts, active non-demo users, signed-in devices with a push
 * token whose preferences want this kind (and this workspace). Never in a demo workspace. Null when APNs is off.
 */
export function postPushStatement(env: Env, db: D1Database, postId: string, revision: number, status: PostPushKind, t: number): D1PreparedStatement | null {
  if (!apnsConfigured(env)) return null;
  const pref = status === "published" ? "$.published" : "$.failed";
  return db
    .prepare(
      `SELECT d.id, d.apns_token, d.environment, a.name AS account_name, a.provider, p.content, p.error, p.workspace_id
       FROM posts p JOIN workspaces w ON w.id = p.workspace_id AND w.is_demo = 0
       LEFT JOIN accounts a ON a.id = p.account_id
       JOIN workspace_members m ON m.workspace_id = p.workspace_id JOIN roles r ON r.id = m.role_id
       JOIN users u ON u.id = m.user_id AND u.status = 'active' AND u.is_demo = 0
       JOIN devices d ON d.user_id = m.user_id AND d.apns_token IS NOT NULL
       JOIN sessions s ON s.id = d.session_id AND s.kind = 'device' AND s.expires_at > ?
       WHERE p.id = ? AND p.revision = ? AND p.status = ? AND p.updated_at = ?
         AND EXISTS (SELECT 1 FROM json_each(r.permissions) WHERE value = 'posts.read')
         AND COALESCE(json_extract(d.prefs, '${pref}'), 1) = 1
         AND (json_type(d.prefs, '$.workspaces') IS NOT 'array' OR EXISTS (SELECT 1 FROM json_each(d.prefs, '$.workspaces') WHERE value = p.workspace_id))
       ORDER BY s.last_used_at DESC LIMIT ${MAX_DEVICES_PER_EVENT}`,
    )
    .bind(t, postId, revision, status, t);
}

/** The push job of a mark step from the rows of `postPushStatement` (null when nobody is to be notified). */
export function postPushJob(kind: PostPushKind, postId: string, rows: PostPushRow[] | undefined): PostPushJob | null {
  const first = rows?.[0];
  if (!first) return null;
  return {
    kind,
    postId,
    workspaceId: first.workspace_id,
    accountName: first.account_name ?? "",
    provider: first.provider ?? "",
    text: snippet(kind === "failed" ? first.error : first.content || first.error),
    devices: rows.map((r) => ({ id: r.id, apns_token: r.apns_token, environment: r.environment })),
  };
}

export function postAlert(job: PostPushJob, platformName: string): Alert {
  const title = [job.accountName, platformName].filter(Boolean).join(" · ") || "Postflare";
  const body =
    job.kind === "published"
      ? job.text
        ? { key: PUSH_KEYS.published, args: [job.text], en: `Published: ${job.text}` }
        : { key: PUSH_KEYS.publishedEmpty, args: [], en: "Your post is live." }
      : job.kind === "failed"
        ? { key: PUSH_KEYS.failed, args: [job.text], en: `Failed: ${job.text}` }
        : { key: PUSH_KEYS.needsCheck, args: [job.text], en: `Check needed: ${job.text}` };
  return {
    titleKey: PUSH_KEYS.postTitle,
    titleArgs: [job.accountName, platformName],
    bodyKey: body.key,
    bodyArgs: body.args,
    title,
    body: body.en,
    threadId: job.workspaceId,
    data: { type: `post_${job.kind}`, postId: job.postId, workspaceId: job.workspaceId },
    collapseId: `${job.postId}:${job.kind}`,
  };
}

// ---------- Sign in on the web with the app ----------

export function webLoginAlert(id: string, browser: string, os: string, location: string, expiresAt: number): Alert {
  return {
    titleKey: PUSH_KEYS.webLoginTitle,
    titleArgs: [],
    bodyKey: PUSH_KEYS.webLoginBody,
    bodyArgs: [browser, os, location],
    title: "Sign-in request",
    body: `${browser} on ${os} · ${location}`,
    threadId: "web-login",
    category: "WEB_LOGIN",
    interruption: "time-sensitive",
    data: { type: "web_login", id },
    collapseId: id,
    expiration: Math.floor(expiresAt / 1000),
  };
}

/** Signed-in devices of one active, non-demo user that have a push token (most recently used first). */
export async function userPushDevices(db: D1Database, userId: string): Promise<PushDevice[]> {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.apns_token, d.environment FROM devices d JOIN users u ON u.id = d.user_id AND u.status = 'active' AND u.is_demo = 0
       JOIN sessions s ON s.id = d.session_id AND s.kind = 'device' AND s.expires_at > ?
       WHERE d.user_id = ? AND d.apns_token IS NOT NULL ORDER BY s.last_used_at DESC LIMIT ${MAX_DEVICES_PER_EVENT}`,
    )
    .bind(now(), userId)
    .all<PushDevice>();
  return results;
}

// ---------- New access requests (instance admins) ----------

/**
 * Devices of the instance admins (active, non-demo users whose instance role has instance.users.manage) that want
 * access request pushes: for the D1 batch of POST /api/access-requests (no extra round trip). Null when APNs is off.
 */
export function adminPushStatement(env: Env, db: D1Database, t: number): D1PreparedStatement | null {
  if (!apnsConfigured(env)) return null;
  return db
    .prepare(
      `SELECT d.id, d.apns_token, d.environment FROM devices d
       JOIN users u ON u.id = d.user_id AND u.status = 'active' AND u.is_demo = 0
       JOIN roles r ON r.id = u.role_id AND EXISTS (SELECT 1 FROM json_each(r.permissions) WHERE value = 'instance.users.manage')
       JOIN sessions s ON s.id = d.session_id AND s.kind = 'device' AND s.expires_at > ?
       WHERE d.apns_token IS NOT NULL AND COALESCE(json_extract(d.prefs, '$.accessRequests'), 1) = 1
       ORDER BY s.last_used_at DESC LIMIT ${MAX_DEVICES_PER_EVENT}`,
    )
    .bind(t);
}

export function accessRequestAlert(id: string, name: string, who: string, role: string): Alert {
  return {
    titleKey: PUSH_KEYS.accessRequestTitle,
    titleArgs: [],
    bodyKey: PUSH_KEYS.accessRequestBody,
    bodyArgs: [name, who, role],
    title: "New access request",
    body: [name, who, role].filter(Boolean).join(" · "),
    threadId: "access-requests",
    interruption: "passive",
    data: { type: "access_request", id },
    collapseId: id,
    expiration: Math.floor(Date.now() / 1000) + 7 * 86_400,
  };
}

/**
 * Devices of the users who answer support chats (instance.support.manage) with support pushes on, most recently used
 * first; `exceptUser` (the staff member who just wrote) is skipped.
 */
export function supportPushStatement(env: Env, db: D1Database, t: number, exceptUser: string | null = null): D1PreparedStatement | null {
  if (!apnsConfigured(env)) return null;
  return db
    .prepare(
      `SELECT d.id, d.apns_token, d.environment FROM devices d
       JOIN users u ON u.id = d.user_id AND u.status = 'active' AND u.is_demo = 0
       JOIN roles r ON r.id = u.role_id AND EXISTS (SELECT 1 FROM json_each(r.permissions) WHERE value = 'instance.support.manage')
       JOIN sessions s ON s.id = d.session_id AND s.kind = 'device' AND s.expires_at > ?
       WHERE d.apns_token IS NOT NULL AND COALESCE(json_extract(d.prefs, '$.support'), 1) = 1 AND u.id IS NOT ?
       ORDER BY s.last_used_at DESC LIMIT ${MAX_DEVICES_PER_EVENT}`,
    )
    .bind(t, exceptUser);
}

/** "Ann · #12" / the message: a customer wrote in the support chat. */
export function supportAlert(id: string, number: number, who: string, message: string): Alert {
  const title = `${who} · #${number}`;
  return {
    titleKey: PUSH_KEYS.supportTitle,
    titleArgs: [who, String(number)],
    bodyKey: "",
    bodyArgs: [],
    title,
    body: snippet(message, 180),
    threadId: `support-${id}`,
    interruption: "active",
    data: { type: "support_message", id },
    collapseId: id,
    expiration: Math.floor(Date.now() / 1000) + 2 * 86_400,
  };
}
