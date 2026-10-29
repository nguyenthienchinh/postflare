import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { InstancePermission, RoleRef, WorkspacePermission } from "../../shared/types";
import { BILLING_COLUMNS, entitlements, snapshotFromRow, upgradeUrl, type BillingColumnsRow, type BillingSnapshot } from "../billing/entitlements";
import { demoEnabled } from "./demo";
import { parseAllowedProviders } from "./settings";
import { DEMO_WORKSPACE_PERMISSIONS, ROLE, WORKSPACE_PERMISSIONS, parsePermissions, permissionError } from "./permissions";
import { newId, now, randomToken, sha256Hex } from "./util";

export const SESSION_COOKIE = "pf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Device tokens (iOS app, `Bearer pfd_...`) live a year and slide: each use after 10 minutes extends them. */
export const DEVICE_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const DEVICE_TOUCH_MS = 10 * 60 * 1000;

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled" | "pending";
  role: RoleRef;
  /** The shared demo visitor (worker/lib/demo.ts): no instance permissions, only reaches demo workspaces. */
  demo: boolean;
}

/** The workspace a request acts in, with the user's effective permissions there. */
export interface CurrentWorkspace {
  id: string;
  name: string;
  role: RoleRef;
  permissions: WorkspacePermission[];
  /** Access comes from `instance.users.manage`, not from a membership. */
  viaAdmin: boolean;
  /** Sandboxed demo workspace: nothing is published, no accounts can be connected, no media uploaded. */
  demo: boolean;
  /** Subscription state read with the workspace (worker/billing/entitlements.ts): limits need no extra query to know billing is off. */
  billing: BillingSnapshot;
  /** Platforms the workspace may connect and post to; null = every platform. */
  allowedProviders: string[] | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** session: web cookie; device: iOS app token (acts like a web session); api_key: bound to one workspace. */
    auth: "session" | "device" | "api_key";
    user: CurrentUser;
    instancePermissions: InstancePermission[];
    /** Null when the user has no workspace or the requested one is not accessible (see `workspaceError`). */
    workspace: CurrentWorkspace | null;
    workspaceError?: string;
    /** Hash of the session id (sessions.id) for session and device requests. */
    sessionId?: string;
    sessionWorkspaceId?: string | null;
    /** devices.id of the calling iOS app install (device token requests). */
    deviceId?: string;
    apiKeyId?: string;
    /** Content-Security-Policy of an HTML response (lib/headers.ts; default: PAGE_CSP). */
    csp?: string;
  };
};

type Ctx = Context<AppEnv>;

interface UserRow {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled" | "pending";
  role_id: string;
  role_name: string;
  role_permissions: string;
  is_demo: number;
}

const USER_COLUMNS =
  "u.id, u.name, u.email, u.status, u.role_id, r.name AS role_name, r.permissions AS role_permissions, u.is_demo";

function toUser(row: UserRow): { user: CurrentUser; instancePermissions: InstancePermission[] } {
  return {
    user: { id: row.id, name: row.name, email: row.email, status: row.status, role: { id: row.role_id, name: row.role_name }, demo: !!row.is_demo },
    // The demo user never gets instance permissions, whatever role an admin gives it.
    instancePermissions: row.is_demo ? [] : (parsePermissions(row.role_permissions, "instance") as InstancePermission[]),
  };
}

export const isInstanceAdmin = (perms: readonly string[]) => perms.includes("instance.users.manage");

export async function createSession(c: Ctx, userId: string, workspaceId: string | null = null, ttlMs = SESSION_TTL_MS) {
  const id = randomToken(32);
  const t = now();
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(id), userId, workspaceId, t, t + ttlMs)
    .run();
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
}

/**
 * A device session for the iOS app: returns its bearer token (`pfd_...`, only its hash is stored) and the devices row
 * that represents the install (push token, preferences; GET /api/devices). One batch.
 */
export async function createDeviceSession(db: D1Database, userId: string, workspaceId: string | null, name: string | null) {
  const token = `pfd_${randomToken(32)}`;
  const sessionId = await sha256Hex(token);
  const deviceId = newId("dev_");
  const t = now();
  await db.batch([
    db
      .prepare("INSERT INTO sessions (id, user_id, workspace_id, created_at, expires_at, kind, name, last_used_at) VALUES (?, ?, ?, ?, ?, 'device', ?, ?)")
      .bind(sessionId, userId, workspaceId, t, t + DEVICE_SESSION_TTL_MS, name, t),
    db.prepare("INSERT INTO devices (id, user_id, session_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(deviceId, userId, sessionId, name, t, t),
  ]);
  return { token, sessionId, deviceId };
}

export async function destroySession(c: Ctx) {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(id)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** The signed-in (active) user of the session cookie, or null. */
export async function sessionUser(c: Ctx) {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return null;
  const hash = await sha256Hex(id);
  const row = await c.env.DB.prepare(
    `SELECT ${USER_COLUMNS}, s.workspace_id AS session_workspace_id FROM sessions s
     JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
     WHERE s.id = ? AND s.kind = 'web' AND s.expires_at > ? AND u.status = 'active'`,
  )
    .bind(hash, now())
    .first<UserRow & { session_workspace_id: string | null }>();
  // Demo sessions end as soon as the instance turns the demo off.
  if (!row || (row.is_demo && !demoEnabled(c.env))) return null;
  return { ...toUser(row), sessionId: hash, sessionWorkspaceId: row.session_workspace_id };
}

/** The device token of an `Authorization: Bearer pfd_...` header, or null. */
export const deviceToken = (header: string | undefined) => header?.match(/^Bearer\s+(pfd_\S+)$/i)?.[1] ?? null;

/**
 * The (active, non-demo) user of an iOS app device token, or null. One query; at most every 10 minutes one more that
 * records the use and slides the expiry (a year from the last use).
 */
export async function deviceUser(env: Env, header: string | undefined) {
  const token = deviceToken(header);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT ${USER_COLUMNS}, s.workspace_id AS session_workspace_id, s.last_used_at, d.id AS device_id FROM sessions s
     JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id LEFT JOIN devices d ON d.session_id = s.id
     WHERE s.id = ? AND s.kind = 'device' AND s.expires_at > ? AND u.status = 'active' AND u.is_demo = 0`,
  )
    .bind(hash, now())
    .first<UserRow & { session_workspace_id: string | null; last_used_at: number | null; device_id: string | null }>();
  if (!row) return null;
  const t = now();
  if (!row.last_used_at || row.last_used_at < t - DEVICE_TOUCH_MS) {
    await env.DB.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?").bind(t, t + DEVICE_SESSION_TTL_MS, hash).run();
  }
  return { ...toUser(row), sessionId: hash, sessionWorkspaceId: row.session_workspace_id, deviceId: row.device_id };
}

export async function isSessionValid(c: Ctx): Promise<boolean> {
  return !!(await sessionUser(c));
}

/** The (active) user and workspace of an API key from an `Authorization: Bearer pf_...` header, or null. */
export async function apiKeyUser(env: Env, header: string | undefined) {
  const token = header?.match(/^Bearer\s+(pf_\S+)$/i)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT ${USER_COLUMNS}, k.id AS key_id, k.workspace_id AS key_workspace_id, k.last_used_at FROM api_keys k
     JOIN users u ON u.id = k.user_id JOIN roles r ON r.id = u.role_id
     WHERE k.hash = ? AND u.status = 'active'`,
  )
    .bind(await sha256Hex(token))
    .first<UserRow & { key_id: string; key_workspace_id: string | null; last_used_at: number | null }>();
  // The demo user cannot create API keys; ignore any that exist anyway.
  if (!row || row.is_demo) return null;
  // At most one write per key per minute.
  if (!row.last_used_at || row.last_used_at < now() - 60_000) {
    await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now(), row.key_id).run();
  }
  return { ...toUser(row), apiKeyId: row.key_id, workspaceId: row.key_workspace_id };
}

export async function createApiKey(env: Env, name: string, userId: string, workspaceId: string) {
  const token = `pf_${randomToken(24)}`;
  const id = newId("key_");
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, prefix, hash, user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, name, token.slice(0, 7), await sha256Hex(token), userId, workspaceId, now())
    .run();
  return { id, token };
}

interface WorkspaceRow extends BillingColumnsRow {
  id: string;
  name: string;
  role_id: string | null;
  role_name: string | null;
  permissions: string | null;
  is_demo: number;
  /** users.is_demo of the user asking. */
  user_demo: number | null;
  allowed_providers: string | null;
}

/** Columns every workspace-access query selects besides the role (`?` = the user id), with the billing state. */
const WS_COLUMNS = `w.id, w.name, w.is_demo, w.allowed_providers, (SELECT is_demo FROM users WHERE id = ?) AS user_demo, ${BILLING_COLUMNS}`;

export function toWorkspace(row: WorkspaceRow, admin: boolean): CurrentWorkspace | null {
  if (row.user_demo) {
    // The demo user only ever reaches demo workspaces, with at most the demo permissions (even if an admin adds it
    // to another workspace or gives it a bigger role).
    if (!row.is_demo || !row.role_id) return null;
    const perms = parsePermissions(row.permissions, "workspace").filter((p) => DEMO_WORKSPACE_PERMISSIONS.includes(p as WorkspacePermission));
    return {
      id: row.id,
      name: row.name,
      role: { id: row.role_id, name: row.role_name ?? row.role_id },
      permissions: perms as WorkspacePermission[],
      viaAdmin: false,
      demo: true,
      billing: snapshotFromRow(row),
      allowedProviders: parseAllowedProviders(row.allowed_providers),
    };
  }
  if (!row.role_id && !admin) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role_id ? { id: row.role_id, name: row.role_name ?? row.role_id } : { id: ROLE.owner, name: "Owner" },
    // Instance admins act as Owner everywhere.
    permissions: admin ? [...WORKSPACE_PERMISSIONS] : (parsePermissions(row.permissions, "workspace") as WorkspacePermission[]),
    viaAdmin: !row.role_id,
    demo: !!row.is_demo,
    billing: snapshotFromRow(row),
    allowedProviders: parseAllowedProviders(row.allowed_providers),
  };
}

/** The user's access to one workspace (membership, or Owner-like access for instance admins), or null. */
export async function workspaceAccess(
  db: D1Database,
  userId: string,
  instancePermissions: readonly string[],
  workspaceId: string,
): Promise<CurrentWorkspace | null> {
  const row = await db
    .prepare(
      `SELECT ${WS_COLUMNS}, m.role_id, r.name AS role_name, r.permissions FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
       LEFT JOIN roles r ON r.id = m.role_id WHERE w.id = ?`,
    )
    .bind(userId, userId, workspaceId)
    .first<WorkspaceRow>();
  return row ? toWorkspace(row, isInstanceAdmin(instancePermissions)) : null;
}

/** The user's first workspace (oldest membership; for admins without memberships the oldest workspace). */
export async function firstWorkspace(db: D1Database, userId: string, instancePermissions: readonly string[]) {
  const row = await db
    .prepare(
      `SELECT ${WS_COLUMNS}, m.role_id, r.name AS role_name, r.permissions FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id JOIN roles r ON r.id = m.role_id
       WHERE m.user_id = ? AND (w.is_demo = 1 OR NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND is_demo = 1))
       ORDER BY m.created_at, w.created_at LIMIT 1`,
    )
    .bind(userId, userId, userId)
    .first<WorkspaceRow>();
  const admin = isInstanceAdmin(instancePermissions);
  if (row) return toWorkspace(row, admin);
  if (!admin) return null;
  const any = await db
    .prepare(
      `SELECT w.id, w.name, w.is_demo, w.allowed_providers, 0 AS user_demo, NULL AS role_id, NULL AS role_name, NULL AS permissions, ${BILLING_COLUMNS}
       FROM workspaces w ORDER BY w.is_demo, w.created_at LIMIT 1`,
    )
    .first<WorkspaceRow>();
  return any ? toWorkspace(any, true) : null;
}

/**
 * Authenticates the request (API key, iOS device token or session cookie) and sets `user`, `instancePermissions` and
 * `workspace`. Workspace: API keys are bound to theirs; sessions and device tokens use `X-Workspace-Id`, else the
 * session's last workspace, else the user's first workspace. Returns an error response, or null on success.
 */
export async function authenticate(c: Ctx): Promise<Response | null> {
  const db = c.env.DB;
  const key = await apiKeyUser(c.env, c.req.header("authorization"));
  if (key) {
    // API keys (CLI, MCP, scripts) act only within their workspace with the user's member role: no instance
    // permissions (users, roles, platform secrets, settings) and no admin override, even for an instance admin.
    const ws = key.workspaceId ? await workspaceAccess(db, key.user.id, [], key.workspaceId) : null;
    if (!ws) return c.json({ error: "This API key no longer has access to its workspace" }, 401);
    // Hosted mode: plans without API access refuse API keys (and so the CLI and MCP) with 402.
    if (entitlements(ws.billing).limits?.api === false) {
      return c.json(
        {
          error: "This workspace's plan doesn't include API access (API keys, the CLI and MCP). Upgrade the plan in Workspace settings → Billing.",
          code: "plan_limit",
          limit: "api",
          used: null,
          max: false,
          upgradeUrl: upgradeUrl(c.req.url),
        },
        402,
      );
    }
    c.set("auth", "api_key");
    c.set("apiKeyId", key.apiKeyId);
    c.set("user", key.user);
    c.set("instancePermissions", []);
    c.set("workspace", ws);
    return null;
  }
  // iOS app: a device token acts like a web session of its user (every workspace, same permissions). A pfd_ header
  // never falls back to the cookie. Not a CSRF target: browsers never attach Authorization headers by themselves.
  const device = deviceToken(c.req.header("authorization")) ? await deviceUser(c.env, c.req.header("authorization")) : undefined;
  if (device === null) return c.json({ error: "This device is signed out. Sign in again in the app.", code: "device_signed_out" }, 401);
  const session = device ?? (await sessionUser(c));
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  // Mutations from the browser must come from our own origin (CSRF defence on top of SameSite=Lax).
  if (!device && isCrossSiteMutation(c)) return c.json({ error: "Cross-origin request blocked" }, 403);
  c.set("auth", device ? "device" : "session");
  if (device?.deviceId) c.set("deviceId", device.deviceId);
  c.set("sessionId", session.sessionId);
  c.set("sessionWorkspaceId", session.sessionWorkspaceId);
  c.set("user", session.user);
  c.set("instancePermissions", session.instancePermissions);
  const requested = c.req.header("x-workspace-id");
  let ws: CurrentWorkspace | null = null;
  if (requested) {
    ws = await workspaceAccess(db, session.user.id, session.instancePermissions, requested);
    // Never fall back silently: the user would act in another workspace than the one on screen.
    if (!ws) c.set("workspaceError", "Workspace not found");
  } else {
    if (session.sessionWorkspaceId) ws = await workspaceAccess(db, session.user.id, session.instancePermissions, session.sessionWorkspaceId);
    ws ??= await firstWorkspace(db, session.user.id, session.instancePermissions);
  }
  c.set("workspace", ws);
  return null;
}

/**
 * True for a state-changing request sent by a browser from another origin. Browsers always send `Origin` on
 * cross-origin POST/PUT/PATCH/DELETE (forms included); API clients (CLI, curl, MCP) send none.
 */
export function isCrossSiteMutation(c: Ctx): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return false;
  const origin = c.req.header("origin");
  if (origin) return origin !== new URL(c.req.url).origin;
  return c.req.header("sec-fetch-site") === "cross-site";
}

/**
 * CSRF guard for every /api route, including the public ones (login, setup, logout, demo, invitation accept):
 * blocks cross-site form posts that would sign a victim into an attacker's account (whose workspace would then
 * receive the social accounts the victim connects) or sign them out.
 */
export const sameOriginMutations: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Payment provider webhooks (public, signed, never from a browser) are exempt, and so are iOS app requests with a
  // device token (a cross-site page cannot set an Authorization header without a CORS preflight, which never passes).
  // The support widget runs on other websites too (CORS); it never acts as the signed-in user for another origin.
  if (c.req.path.startsWith("/api/billing/webhooks/") || c.req.path.startsWith("/api/support/") || deviceToken(c.req.header("authorization"))) return next();
  if (isCrossSiteMutation(c)) return c.json({ error: "Cross-origin request blocked" }, 403);
  return next();
};

/**
 * Client address for throttles. IPv6 users usually control a whole /64, so it counts as one address.
 * (`cf-connecting-ip` is set by Cloudflare and cannot be spoofed by the client.)
 */
export function throttleIp(ip: string | undefined | null): string {
  if (!ip) return "local";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const error = await authenticate(c);
  return error ?? next();
};

/** 403 unless the current workspace grants `permission` (404 when the requested workspace is not accessible). */
export function requirePermission(permission: WorkspacePermission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ws = c.var.workspace;
    if (!ws) {
      return c.var.workspaceError
        ? c.json({ error: c.var.workspaceError }, 404)
        : c.json({ error: "You are not a member of any workspace" }, 403);
    }
    if (!ws.permissions.includes(permission)) return c.json({ error: permissionError(permission) }, 403);
    return next();
  };
}

export function requireInstancePermission(permission: InstancePermission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.var.instancePermissions.includes(permission)) return c.json({ error: permissionError(permission) }, 403);
    return next();
  };
}

/** Id of the current workspace. Only call behind `requirePermission` (which guarantees there is one). */
export function wsId(c: Ctx): string {
  const ws = c.var.workspace;
  if (!ws) throw new Error("No workspace");
  return ws.id;
}

export function can(c: Ctx, permission: WorkspacePermission): boolean {
  return !!c.var.workspace?.permissions.includes(permission);
}

/** 403 for the shared demo user (profile, password, API keys, workspaces, invitations...). */
export const forbidDemoUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.user?.demo) return c.json({ error: "This is not available in the demo. Deploy your own Postflare to try it." }, 403);
  return next();
};

/** 403 in a demo workspace for actions that would reach a real platform or store files (connect, upload). */
export function forbidInDemoWorkspace(what: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.var.workspace?.demo) return c.json({ error: `${what} is disabled in the demo workspace` }, 403);
    return next();
  };
}
