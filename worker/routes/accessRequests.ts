// Access requests (docs/hosted-spec.md "Access requests"): with signup_mode "apply", people ask for an account on /apply
// and an instance admin approves (an email-bound invitation into a new workspace of their own) or rejects each one.
//
// Public form budget (Free plan): one settings read (mode + both throttles), the optional Turnstile siteverify, then one
// D1 batch (throttle counters, the upsert, the admin devices and emails to notify). Notifications run after the
// response: at most MAX_ADMIN_DEVICES APNs requests and MAX_ADMIN_EMAILS emails, only for a new request.

import { Hono, type Context } from "hono";
import {
  ACCESS_REQUEST_PLATFORMS,
  ACCESS_REQUEST_ROLES,
  ACCESS_REQUEST_VOLUMES,
  type AccessRequestDTO,
  type AccessRequestInput,
  type AccessRequestListDTO,
  type AccessRequestReviewDTO,
  type AccessRequestReviewInput,
  type AccessRequestStatus,
} from "../../shared/types";
import { requireInstancePermission, throttleIp, type AppEnv } from "../lib/auth";
import { accessApprovedEmail, accessRejectedEmail, emailConfigured, newAccessRequestEmail, sendEmail } from "../lib/email";
import { ROLE } from "../lib/permissions";
import { accessRequestAlert, adminPushStatement, pushAlert, type PushDevice } from "../lib/push";
import { baseUrl } from "../lib/settings";
import { SIGNUP_MODE_SETTING } from "../lib/signup";
import { normalizeEmail, normalizeName } from "../lib/users";
import { newId, now, parseJson } from "../lib/util";
import { botCheck, type Failures } from "./auth";
import { INVITE_TTL_MS, invitationStatement } from "./invitations";

type Ctx = Context<AppEnv>;

const NOT_OPEN = "Requests for access are not open on this instance";
const MAX_PER_IP = 5;
const IP_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_EMAIL = 3;
const EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ADMIN_DEVICES = 5;
const MAX_ADMIN_EMAILS = 3;
export const USE_CASE_MIN = 20;
export const USE_CASE_MAX = 1000;

export const ROLE_LABELS: Record<AccessRequestDTO["role"], string> = {
  creator: "Creator",
  agency: "Agency",
  startup: "Startup / app developer",
  brand: "Brand / marketing team",
  other: "Other",
};

interface AccessRequestRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  url: string;
  role: string;
  platforms: string;
  accounts: number | null;
  volume: string | null;
  use_case: string;
  referral: string | null;
  status: AccessRequestStatus;
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  created_at: number;
  updated_at: number;
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_note: string | null;
  invitation_id: string | null;
  reviewer_name: string | null;
  invitation_accepted: number;
  existing_user: number;
}

const SELECT = `SELECT r.*, ru.name AS reviewer_name, (i.accepted_at IS NOT NULL) AS invitation_accepted,
  EXISTS (SELECT 1 FROM users u WHERE u.email = r.email AND u.is_demo = 0) AS existing_user
  FROM access_requests r LEFT JOIN users ru ON ru.id = r.reviewed_by LEFT JOIN invitations i ON i.id = r.invitation_id`;

const toDto = (r: AccessRequestRow): AccessRequestDTO => ({
  id: r.id,
  name: r.name,
  email: r.email,
  company: r.company,
  url: r.url,
  role: r.role as AccessRequestDTO["role"],
  platforms: parseJson<AccessRequestDTO["platforms"]>(r.platforms, []),
  accounts: r.accounts,
  volume: r.volume as AccessRequestDTO["volume"],
  useCase: r.use_case,
  referral: r.referral,
  status: r.status,
  ip: r.ip,
  country: r.country,
  userAgent: r.user_agent,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  reviewedBy: r.reviewed_by ? { id: r.reviewed_by, name: r.reviewer_name ?? "A former user" } : null,
  reviewedAt: r.reviewed_at,
  reviewNote: r.review_note,
  invitationId: r.invitation_id,
  invitationAccepted: !!r.invitation_accepted,
  existingUser: !!r.existing_user,
});

/** "https://example.com/x" from what people type ("example.com/x", "@handle" is not a URL); null when not http(s). */
export function normalizeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  try {
    const u = new URL(s);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname.includes(".") || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const optionalText = (v: unknown, max: number) => (typeof v === "string" ? normalizeName(v, max) : null);

/** The validated row fields of a form submission, or the first error. */
export function validateAccessRequest(body: Partial<Record<keyof AccessRequestInput, unknown>>):
  | { error: string }
  | { value: { name: string; email: string; company: string | null; url: string; role: string; platforms: string[]; accounts: number | null; volume: string | null; useCase: string; referral: string | null } } {
  const name = normalizeName(body.name);
  if (!name) return { error: "Name is required" };
  const email = normalizeEmail(body.email)?.toLowerCase();
  if (!email) return { error: "A valid email is required" };
  if (email.endsWith("@postflare.local")) return { error: "Use your real email address" };
  const url = normalizeUrl(body.url);
  if (!url) return { error: "Enter your website or main social profile as a link (https://…)" };
  if (typeof body.role !== "string" || !(ACCESS_REQUEST_ROLES as readonly string[]).includes(body.role)) return { error: "Choose what describes you best" };
  const platforms = Array.isArray(body.platforms) ? [...new Set(body.platforms)] : [];
  if (!platforms.length || platforms.some((p) => !(ACCESS_REQUEST_PLATFORMS as readonly unknown[]).includes(p))) return { error: "Choose the platforms you plan to use" };
  let accounts: number | null = null;
  if (body.accounts !== undefined && body.accounts !== null && body.accounts !== "") {
    const n = Number(body.accounts);
    if (!Number.isInteger(n) || n < 0 || n > 1000) return { error: "Accounts to connect must be a whole number between 0 and 1000" };
    accounts = n;
  }
  let volume: string | null = null;
  if (body.volume !== undefined && body.volume !== null && body.volume !== "") {
    if (typeof body.volume !== "string" || !(ACCESS_REQUEST_VOLUMES as readonly string[]).includes(body.volume)) return { error: "Choose how many posts per month" };
    volume = body.volume;
  }
  const useCase = typeof body.useCase === "string" ? body.useCase.trim().replace(/\r\n/g, "\n") : "";
  if (useCase.length < USE_CASE_MIN) return { error: `Tell us a bit more about how you'll use Postflare (at least ${USE_CASE_MIN} characters)` };
  if (useCase.length > USE_CASE_MAX) return { error: `Keep the use case under ${USE_CASE_MAX} characters` };
  if (body.consent !== true) return { error: "Agree to the Terms and the Privacy Policy to continue" };
  return {
    value: { name, email, company: optionalText(body.company, 100), url, role: body.role, platforms: platforms as string[], accounts, volume, useCase, referral: optionalText(body.referral, 200) },
  };
}

// ---------- Public: the /apply form ----------

export const accessRequestPublicRoutes = new Hono<AppEnv>();

/**
 * POST /api/access-requests (public, signup_mode apply; 404 otherwise). Answers `{ ok: true }` whether or not the email
 * applied before or has an account (no enumeration); a pending request of the same email is updated in place.
 * Throttled: 5 per IP per hour and 3 per email per day, counting every accepted submission.
 */
accessRequestPublicRoutes.post("/", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Partial<Record<keyof AccessRequestInput, unknown>>>().catch(() => ({}) as Partial<Record<keyof AccessRequestInput, unknown>>);
  const ipKey = `apply:${throttleIp(c.req.header("cf-connecting-ip"))}`;
  const emailForKey = normalizeEmail(body.email)?.toLowerCase();
  const emailKey = `apply:email:${emailForKey ?? ""}`;
  // The mode, both throttle counters and the stored public URL (for the admin email): one query.
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?, 'public_url')")
    .bind(SIGNUP_MODE_SETTING, ipKey, emailKey)
    .all<{ key: string; value: string }>();
  const s = new Map(results.map((r) => [r.key, r.value]));
  if (s.get(SIGNUP_MODE_SETTING) !== "apply") return c.json({ error: NOT_OPEN }, 404);
  const v = validateAccessRequest(body);
  if ("error" in v) return c.json({ error: v.error }, 400);
  const t = now();
  const ipF = parseJson<Failures>(s.get(ipKey), { n: 0, until: 0 });
  const emailF = parseJson<Failures>(s.get(emailKey), { n: 0, until: 0 });
  const live = (f: Failures) => f.until > t;
  if ((live(ipF) && ipF.n >= MAX_PER_IP) || (live(emailF) && emailF.n >= MAX_PER_EMAIL)) {
    return c.json({ error: "Too many requests. Try again later." }, 429);
  }
  // Before any write or notification.
  const blocked = await botCheck(c, "apply", body.turnstileToken);
  if (blocked) return blocked;

  const r = v.value;
  const counter = (key: string, f: Failures, windowMs: number) =>
    db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, JSON.stringify(live(f) ? { n: f.n + 1, until: f.until } : { n: 1, until: t + windowMs }));
  const cf = (c.req.raw as { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" ? cf.country : (c.req.header("cf-ipcountry") ?? null);
  const pushStmt = adminPushStatement(c.env, db, t);
  const mail = emailConfigured(c.env);
  const batch = await db.batch([
    counter(ipKey, ipF, IP_WINDOW_MS),
    counter(emailKey, emailF, EMAIL_WINDOW_MS),
    db
      .prepare(
        `INSERT INTO access_requests (id, name, email, company, url, role, platforms, accounts, volume, use_case, referral, status, ip, country, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
         ON CONFLICT (email) WHERE status = 'pending' DO UPDATE SET name = excluded.name, company = excluded.company, url = excluded.url, role = excluded.role,
           platforms = excluded.platforms, accounts = excluded.accounts, volume = excluded.volume, use_case = excluded.use_case, referral = excluded.referral,
           ip = excluded.ip, country = excluded.country, user_agent = excluded.user_agent, updated_at = excluded.updated_at
         RETURNING id, created_at`,
      )
      .bind(
        newId("ar_"),
        r.name,
        r.email,
        r.company,
        r.url,
        r.role,
        JSON.stringify(r.platforms),
        r.accounts,
        r.volume,
        r.useCase,
        r.referral,
        c.req.header("cf-connecting-ip") ?? null,
        country,
        c.req.header("user-agent")?.slice(0, 300) ?? null,
        t,
        t,
      ),
    ...(pushStmt ? [pushStmt] : []),
    ...(mail
      ? [
          db
            .prepare(
              `SELECT u.email FROM users u JOIN roles ro ON ro.id = u.role_id AND EXISTS (SELECT 1 FROM json_each(ro.permissions) WHERE value = 'instance.users.manage')
               WHERE u.status = 'active' AND u.is_demo = 0 ORDER BY u.created_at LIMIT ${MAX_ADMIN_EMAILS}`,
            ),
        ]
      : []),
  ]);
  const saved = (batch[2].results as Array<{ id: string; created_at: number }>)[0];
  // Only a new request notifies (an update of a pending one does not ping the admins again).
  if (saved && saved.created_at === t) {
    const devices = pushStmt ? ((batch[3].results ?? []) as PushDevice[]).slice(0, MAX_ADMIN_DEVICES) : [];
    const admins = mail ? ((batch[pushStmt ? 4 : 3].results ?? []) as Array<{ email: string }>) : [];
    if (devices.length || admins.length) {
      const base = c.env.PUBLIC_URL?.replace(/\/$/, "") || s.get("public_url") || new URL(c.req.url).origin;
      c.executionCtx.waitUntil(notifyAdmins(c, `${base}/admin/requests?id=${saved.id}`, saved.id, r, devices, admins.map((a) => a.email)));
    }
  }
  return c.json({ ok: true });
});

async function notifyAdmins(c: Ctx, reviewUrl: string, id: string, r: { name: string; email: string; company: string | null; url: string; role: string; useCase: string }, devices: PushDevice[], emails: string[]) {
  const role = ROLE_LABELS[r.role as AccessRequestDTO["role"]] ?? r.role;
  const who = r.company ?? hostOf(r.url);
  const jobs: Promise<unknown>[] = [];
  if (devices.length) jobs.push(pushAlert(c.env, c.env.DB, devices, accessRequestAlert(id, r.name, who, role)));
  for (const to of emails) jobs.push(sendEmail(c.env, newAccessRequestEmail(to, { ...r, role }, reviewUrl)));
  const results = await Promise.allSettled(jobs);
  for (const res of results) if (res.status === "rejected") console.error("access request notification failed", (res.reason as Error)?.message ?? res.reason);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// ---------- Instance admins (instance.users.manage) ----------

export const accessRequestRoutes = new Hono<AppEnv>();
const manageUsers = requireInstancePermission("instance.users.manage");
const STATUSES: AccessRequestStatus[] = ["pending", "approved", "rejected", "withdrawn"];

/** GET /api/access-requests?status=pending|approved|rejected|withdrawn|all&q=&limit=&before= (newest first) + counts per status. */
accessRequestRoutes.get("/access-requests", manageUsers, async (c) => {
  const db = c.env.DB;
  const status = c.req.query("status") ?? "all";
  if (status !== "all" && !STATUSES.includes(status as AccessRequestStatus)) return c.json({ error: "status must be pending, approved, rejected, withdrawn or all" }, 400);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status !== "all") where.push("r.status = ?") && binds.push(status);
  const q = c.req.query("q")?.trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(r.name LIKE ? ESCAPE '\\' OR r.email LIKE ? ESCAPE '\\' OR r.company LIKE ? ESCAPE '\\' OR r.url LIKE ? ESCAPE '\\')");
    binds.push(like, like, like, like);
  }
  const before = Number(c.req.query("before"));
  if (Number.isFinite(before) && before > 0) where.push("r.created_at < ?") && binds.push(before);
  const [list, counts] = await db.batch([
    db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.created_at DESC LIMIT ?`).bind(...binds, limit + 1),
    db.prepare("SELECT status, COUNT(*) AS n FROM access_requests GROUP BY status"),
  ]);
  const rows = list.results as unknown as AccessRequestRow[];
  const out: AccessRequestListDTO = {
    items: rows.slice(0, limit).map(toDto),
    counts: { pending: 0, approved: 0, rejected: 0, withdrawn: 0 },
    nextBefore: rows.length > limit ? rows[limit - 1].created_at : null,
  };
  for (const r of counts.results as Array<{ status: AccessRequestStatus; n: number }>) if (r.status in out.counts) out.counts[r.status] = r.n;
  return c.json(out);
});

/** GET /api/access-requests/count → { pending } (the nav badge). */
accessRequestRoutes.get("/access-requests/count", manageUsers, async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'").first<{ n: number }>();
  return c.json({ pending: row?.n ?? 0 });
});

const loadRow = (db: D1Database, id: string) => db.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first<AccessRequestRow>();

accessRequestRoutes.get("/access-requests/:id", manageUsers, async (c) => {
  const row = await loadRow(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "Access request not found" }, 404);
  return c.json(toDto(row));
});

/**
 * PATCH /api/access-requests/:id { status: approved | rejected, note?, notify? }. Approve: an invitation bound to the
 * email (instance role Member, a new workspace named after the company or "<name>'s workspace", normal expiry), mailed
 * to the applicant when email is configured; the link is always in the answer. An approved request whose invitation
 * is unused can be approved again for a new link (the old one is revoked). An email that already has an account is
 * only marked approved. Reject: optionally mails a short note; rejecting an approved request revokes its unused
 * invitation.
 */
accessRequestRoutes.patch("/access-requests/:id", manageUsers, async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Partial<AccessRequestReviewInput>>().catch(() => ({}) as Partial<AccessRequestReviewInput>);
  if (body.status !== "approved" && body.status !== "rejected") return c.json({ error: "status must be approved or rejected" }, 400);
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return c.json({ error: "note must be text" }, 400);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) || null : null;
  if (body.notify !== undefined && typeof body.notify !== "boolean") return c.json({ error: "notify must be true or false" }, 400);
  const notify = body.notify !== false && emailConfigured(c.env);
  const row = await loadRow(db, c.req.param("id"));
  if (!row) return c.json({ error: "Access request not found" }, 404);
  if (row.invitation_accepted) return c.json({ error: `${row.email} has already accepted the invitation` }, 409);
  const t = now();
  const admin = c.var.user.id;
  // Guarded on the state that was read: a concurrent review makes this one a no-op (409).
  const guard = "WHERE id = ? AND status = ? AND invitation_id IS ?";
  const guardBinds = [row.id, row.status, row.invitation_id];
  const revokeOld = row.invitation_id ? [db.prepare("DELETE FROM invitations WHERE id = ? AND accepted_at IS NULL").bind(row.invitation_id)] : [];
  let out: Omit<AccessRequestReviewDTO, "request">;

  if (body.status === "approved") {
    if (row.status === "approved" && (row.existing_user || !row.invitation_id)) return c.json({ error: "This request is already approved" }, 409);
    if (row.existing_user) {
      const res = await db
        .prepare(`UPDATE access_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? ${guard}`)
        .bind(admin, t, note, t, ...guardBinds)
        .run();
      if (!res.meta.changes) return c.json({ error: "This request was just reviewed by someone else" }, 409);
      out = { existingUser: true, emailed: false };
    } else {
      const inv = await invitationStatement(db, {
        email: row.email,
        instanceRoleId: ROLE.instanceMember,
        workspaceId: null,
        workspaceRoleId: null,
        newWorkspaceName: row.company ?? `${row.name}'s workspace`.slice(0, 100),
        invitedBy: admin,
      });
      const [upd] = await db.batch([
        db
          .prepare(`UPDATE access_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, invitation_id = ?, updated_at = ? ${guard}`)
          .bind(admin, t, note ?? (row.status === "approved" ? row.review_note : null), inv.id, t, ...guardBinds),
        ...revokeOld,
        inv.statement,
      ]);
      if (!upd.meta.changes) {
        await db.prepare("DELETE FROM invitations WHERE id = ?").bind(inv.id).run();
        return c.json({ error: "This request was just reviewed by someone else" }, 409);
      }
      const url = `${await baseUrl(c.env, c.req.url)}${inv.path}`;
      const emailed = notify && (await trySend(c, accessApprovedEmail(row.email, row.name, url, INVITE_TTL_MS / 86_400_000)));
      out = { invitation: { id: inv.id, url, expiresAt: inv.expiresAt }, emailed };
    }
  } else {
    if (row.status === "rejected") return c.json({ error: "This request is already rejected" }, 409);
    const [upd] = await db.batch([
      db
        .prepare(`UPDATE access_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?, invitation_id = NULL, updated_at = ? ${guard}`)
        .bind(admin, t, note, t, ...guardBinds),
      ...revokeOld,
    ]);
    if (!upd.meta.changes) return c.json({ error: "This request was just reviewed by someone else" }, 409);
    const host = new URL(await baseUrl(c.env, c.req.url)).host;
    const emailed = notify && (await trySend(c, accessRejectedEmail(row.email, row.name, host, note)));
    out = { emailed };
  }
  const review: AccessRequestReviewDTO = { request: toDto((await loadRow(db, row.id))!), ...out };
  return c.json(review);
});

/** Sends one email; false (logged) when the binding refuses it (e.g. Workers Free: only verified addresses). */
async function trySend(c: Ctx, msg: Parameters<typeof sendEmail>[1]): Promise<boolean> {
  try {
    await sendEmail(c.env, msg);
    return true;
  } catch (err) {
    console.error("access request email failed", (err as { code?: string })?.code ?? "", (err as Error)?.message ?? err);
    return false;
  }
}
