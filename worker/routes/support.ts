// Support chat (docs/support-spec.md): the public widget API (any website, a visitor token; the session cookie on this
// origin links the signed-in user) and the staff inbox (instance.support.manage, web session or iOS device token).
//
// Free plan budget: a widget poll is one read (plus a write at most every 30 s to mark replies seen); a message is
// one batch (insert, conversation update, the staff devices to push) and at most 5 APNs requests after the response.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type {
  SupportAuthor,
  SupportConversationDTO,
  SupportMessageDTO,
  SupportSettingsDTO,
  SupportStatus,
  SupportTicketDTO,
  SupportTicketListDTO,
  SupportWidgetDTO,
} from "../../shared/types";
import { requireInstancePermission, sessionUser, throttleIp, type AppEnv } from "../lib/auth";
import { emailConfigured, sendEmail, supportReplyEmail } from "../lib/email";
import { pushAlert, supportAlert, supportPushStatement, type PushDevice } from "../lib/push";
import { baseUrl, getSetting } from "../lib/settings";
import { normalizeEmail, normalizeName } from "../lib/users";
import { newId, now, sha256Hex } from "../lib/util";

type Ctx = Context<AppEnv>;

export const SUPPORT_SETTING = { enabled: "support_enabled", teamName: "support_team_name", greeting: "support_greeting" } as const;
const DEFAULT_TEAM = "Postflare";
const DEFAULT_GREETING = "Hi! Ask us anything, we usually answer within a few hours.";

export const BODY_MAX = 5000;
const MAX_NEW_PER_IP_HOUR = 5;
const MAX_NEW_PER_HOUR = 100;
const MAX_MESSAGES_10_MIN = 20;
/** The widget marks replies seen at most this often (one write). */
const SEEN_EVERY_MS = 30_000;
/** A staff reply is emailed when the widget has not fetched the conversation for this long. */
const EMAIL_AFTER_MS = 2 * 60_000;
const STATUSES: SupportStatus[] = ["open", "pending", "closed"];

interface ConversationRow {
  id: string;
  number: number;
  status: SupportStatus;
  subject: string | null;
  name: string | null;
  email: string | null;
  user_id: string | null;
  workspace_id: string | null;
  visitor_hash: string;
  source: "widget" | "app";
  page_url: string | null;
  user_agent: string | null;
  ip: string | null;
  country: string | null;
  assignee_id: string | null;
  staff_unread: number;
  customer_unread: number;
  customer_seen_at: number | null;
  last_message_at: number;
  last_message_preview: string | null;
  last_author: "customer" | "staff" | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface TicketRow extends ConversationRow {
  user_name: string | null;
  user_email: string | null;
  workspace_name: string | null;
  assignee_name: string | null;
}

interface MessageRow {
  id: string;
  author: SupportAuthor;
  author_name: string | null;
  body: string;
  created_at: number;
}

const toConversation = (r: ConversationRow): SupportConversationDTO => ({
  id: r.id,
  number: r.number,
  status: r.status,
  subject: r.subject,
  name: r.name,
  email: r.email,
  unread: r.customer_unread,
  lastMessageAt: r.last_message_at,
  lastMessagePreview: r.last_message_preview,
  lastAuthor: r.last_author,
  createdAt: r.created_at,
});

const toTicket = (r: TicketRow): SupportTicketDTO => ({
  ...toConversation(r),
  staffUnread: r.staff_unread,
  source: r.source,
  pageUrl: r.page_url,
  userAgent: r.user_agent,
  country: r.country,
  ip: r.ip,
  user: r.user_id && r.user_name ? { id: r.user_id, name: r.user_name, email: r.user_email ?? "" } : null,
  workspace: r.workspace_id && r.workspace_name ? { id: r.workspace_id, name: r.workspace_name } : null,
  assignee: r.assignee_id && r.assignee_name ? { id: r.assignee_id, name: r.assignee_name } : null,
  customerSeenAt: r.customer_seen_at,
  closedAt: r.closed_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): SupportMessageDTO => ({ id: r.id, author: r.author, authorName: r.author_name, body: r.body, createdAt: r.created_at });

/** Message text: trimmed, 1..BODY_MAX characters, or null. */
export function cleanBody(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return s && Array.from(s).length <= BODY_MAX ? s : null;
}

/** One line for lists and pushes. */
const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 140);

const cleanUrl = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};

async function supportSettings(db: D1Database) {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)")
    .bind(SUPPORT_SETTING.enabled, SUPPORT_SETTING.teamName, SUPPORT_SETTING.greeting)
    .all<{ key: string; value: string }>();
  const s = new Map(results.map((r) => [r.key, r.value]));
  return {
    enabled: s.get(SUPPORT_SETTING.enabled) === "1",
    teamName: s.get(SUPPORT_SETTING.teamName) || DEFAULT_TEAM,
    greeting: s.get(SUPPORT_SETTING.greeting) || DEFAULT_GREETING,
  };
}

// ---------- Public widget API ----------

export const supportPublicRoutes = new Hono<AppEnv>();

/** Any website may embed the widget: CORS without credentials (cookies only ever come along on this origin). */
const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PATCH",
        "access-control-allow-headers": "content-type, x-support-visitor",
        "access-control-max-age": "86400",
      },
    });
  }
  await next();
  c.res.headers.set("access-control-allow-origin", "*");
  c.res.headers.set("vary", "origin");
};
supportPublicRoutes.use("*", cors);

/** The visitor: hash of the widget's token, and the signed-in user when the request comes from this origin. */
async function visitor(c: Ctx) {
  const token = c.req.header("x-support-visitor") ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const origin = c.req.header("origin");
  // Other sites (even same-site subdomains, which get Lax cookies) never act as the signed-in user.
  const sameOrigin = !origin || origin === new URL(c.req.url).origin;
  const session = sameOrigin ? await sessionUser(c) : null;
  return { hash: await sha256Hex(`support:${token}`), session: session && !session.user.demo ? session : null };
}

type Visitor = NonNullable<Awaited<ReturnType<typeof visitor>>>;

const BAD_VISITOR = { error: "Missing or invalid X-Support-Visitor header" };
const NOT_FOUND = { error: "Conversation not found" };

/** The conversation if this visitor (token or signed-in user) owns it. */
async function ownConversation(db: D1Database, v: Visitor, id: string) {
  const row = await db.prepare("SELECT * FROM support_conversations WHERE id = ?").bind(id).first<ConversationRow>();
  if (!row) return null;
  return row.visitor_hash === v.hash || (v.session && row.user_id === v.session.user.id) ? row : null;
}

supportPublicRoutes.get("/widget", async (c) => {
  const s = await supportSettings(c.env.DB);
  const origin = c.req.header("origin");
  const session = !origin || origin === new URL(c.req.url).origin ? await sessionUser(c) : null;
  const out: SupportWidgetDTO = { ...s, staff: !!session?.instancePermissions.includes("instance.support.manage"), signedIn: !!session && !session.user.demo };
  return c.json(out);
});

supportPublicRoutes.get("/conversations", async (c) => {
  const v = await visitor(c);
  if (!v) return c.json(BAD_VISITOR, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM support_conversations WHERE visitor_hash = ?1 OR (?2 IS NOT NULL AND user_id = ?2) ORDER BY last_message_at DESC LIMIT 20`,
  )
    .bind(v.hash, v.session?.user.id ?? null)
    .all<ConversationRow>();
  return c.json({ items: results.map(toConversation) });
});

supportPublicRoutes.post("/conversations", async (c) => {
  const db = c.env.DB;
  const v = await visitor(c);
  if (!v) return c.json(BAD_VISITOR, 400);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const s = await supportSettings(db);
  if (!s.enabled) return c.json({ error: "Support chat is off" }, 404);
  // Honeypot: a field people never see.
  if (typeof body.website === "string" && body.website.trim()) return c.json({ error: "Invalid request" }, 400);
  const text = cleanBody(body.body);
  if (!text) return c.json({ error: `Write a message (at most ${BODY_MAX} characters)` }, 400);
  const email = body.email === undefined || body.email === null || body.email === "" ? null : normalizeEmail(body.email)?.toLowerCase();
  if (email === undefined) return c.json({ error: "Enter a valid email or leave it empty" }, 400);
  const user = v.session?.user ?? null;
  const name = normalizeName(body.name) ?? user?.name ?? null;
  const t = now();
  const ip = c.req.header("cf-connecting-ip") ? throttleIp(c.req.header("cf-connecting-ip")) : null;
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM support_conversations WHERE ip IS ?1 AND created_at > ?2) AS by_ip,
              (SELECT COUNT(*) FROM support_conversations WHERE created_at > ?2) AS total`,
    )
    .bind(ip, t - 3_600_000)
    .first<{ by_ip: number; total: number }>();
  if ((counts?.by_ip ?? 0) >= MAX_NEW_PER_IP_HOUR || (counts?.total ?? 0) >= MAX_NEW_PER_HOUR) {
    return c.json({ error: "Too many new conversations. Try again in a while, or continue an earlier one." }, 429);
  }
  const cf = (c.req.raw as { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" ? cf.country : (c.req.header("cf-ipcountry") ?? null);
  const id = newId("sc_");
  const messageId = newId("sm_");
  const subject = text.split("\n")[0].slice(0, 120);
  const pushStmt = supportPushStatement(c.env, db, t);
  const batch = await db.batch([
    db
      .prepare(
        `INSERT INTO support_conversations (id, number, status, subject, name, email, user_id, workspace_id, visitor_hash, source, page_url, user_agent, ip, country,
           staff_unread, customer_unread, last_message_at, last_message_preview, last_author, created_at, updated_at)
         VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM support_conversations), 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 'customer', ?, ?)`,
      )
      .bind(
        id,
        subject,
        name,
        email ?? user?.email ?? null,
        user?.id ?? null,
        v.session?.sessionWorkspaceId ?? null,
        v.hash,
        body.source === "app" ? "app" : "widget",
        cleanUrl(body.pageUrl),
        c.req.header("user-agent")?.slice(0, 300) ?? null,
        ip,
        country,
        t,
        preview(text),
        t,
        t,
      ),
    db.prepare("INSERT INTO support_messages (id, conversation_id, author, author_id, author_name, body, created_at) VALUES (?, ?, 'customer', ?, ?, ?, ?)").bind(messageId, id, user?.id ?? null, name, text, t),
    db.prepare("SELECT * FROM support_conversations WHERE id = ?").bind(id),
    ...(pushStmt ? [pushStmt] : []),
  ]);
  const conv = (batch[2].results as unknown as ConversationRow[])[0];
  notifyStaff(c, conv, text, pushStmt ? (batch[3].results as unknown as PushDevice[]) : []);
  return c.json({ conversation: toConversation(conv), messages: [toMessage({ id: messageId, author: "customer", author_name: name, body: text, created_at: t })] }, 201);
});

supportPublicRoutes.get("/conversations/:id", async (c) => {
  const db = c.env.DB;
  const v = await visitor(c);
  if (!v) return c.json(BAD_VISITOR, 400);
  const conv = await ownConversation(db, v, c.req.param("id"));
  if (!conv) return c.json(NOT_FOUND, 404);
  const after = Number(c.req.query("after")) || 0;
  const { results } = await db
    .prepare("SELECT id, author, author_name, body, created_at FROM support_messages WHERE conversation_id = ? AND author != 'note' AND created_at > ? ORDER BY created_at LIMIT 300")
    .bind(conv.id, after)
    .all<MessageRow>();
  const t = now();
  if (conv.customer_unread || !conv.customer_seen_at || conv.customer_seen_at < t - SEEN_EVERY_MS) {
    await db.prepare("UPDATE support_conversations SET customer_unread = 0, customer_seen_at = ? WHERE id = ?").bind(t, conv.id).run();
    conv.customer_unread = 0;
  }
  return c.json({ conversation: toConversation(conv), messages: results.map(toMessage) });
});

supportPublicRoutes.post("/conversations/:id/messages", async (c) => {
  const db = c.env.DB;
  const v = await visitor(c);
  if (!v) return c.json(BAD_VISITOR, 400);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const text = cleanBody(body.body);
  if (!text) return c.json({ error: `Write a message (at most ${BODY_MAX} characters)` }, 400);
  const conv = await ownConversation(db, v, c.req.param("id"));
  if (!conv) return c.json(NOT_FOUND, 404);
  if (!(await supportSettings(db)).enabled) return c.json({ error: "Support chat is off" }, 404);
  const t = now();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ? AND author = 'customer' AND created_at > ?")
    .bind(conv.id, t - 600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_MESSAGES_10_MIN) return c.json({ error: "You are sending messages too fast. Wait a few minutes." }, 429);
  const id = newId("sm_");
  const name = conv.name ?? v.session?.user.name ?? null;
  const pushStmt = supportPushStatement(c.env, db, t);
  const batch = await db.batch([
    db.prepare("INSERT INTO support_messages (id, conversation_id, author, author_id, author_name, body, created_at) VALUES (?, ?, 'customer', ?, ?, ?, ?)").bind(id, conv.id, v.session?.user.id ?? null, name, text, t),
    db
      .prepare(
        `UPDATE support_conversations SET status = 'open', closed_at = NULL, staff_unread = staff_unread + 1, customer_unread = 0, customer_seen_at = ?1,
           last_message_at = ?1, last_message_preview = ?2, last_author = 'customer', updated_at = ?1,
           user_id = COALESCE(user_id, ?3) WHERE id = ?4 RETURNING *`,
      )
      .bind(t, preview(text), v.session?.user.id ?? null, conv.id),
    ...(pushStmt ? [pushStmt] : []),
  ]);
  const updated = (batch[1].results as unknown as ConversationRow[])[0];
  notifyStaff(c, updated, text, pushStmt ? (batch[2].results as unknown as PushDevice[]) : []);
  return c.json({ message: toMessage({ id, author: "customer", author_name: name, body: text, created_at: t }), conversation: toConversation(updated) }, 201);
});

/** The visitor adds (or fixes) their name and email. */
supportPublicRoutes.patch("/conversations/:id", async (c) => {
  const db = c.env.DB;
  const v = await visitor(c);
  if (!v) return c.json(BAD_VISITOR, 400);
  const conv = await ownConversation(db, v, c.req.param("id"));
  if (!conv) return c.json(NOT_FOUND, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.email !== undefined) {
    const email = body.email === null || body.email === "" ? null : normalizeEmail(body.email)?.toLowerCase();
    if (email === undefined) return c.json({ error: "Enter a valid email" }, 400);
    sets.push("email = ?") && binds.push(email);
  }
  if (body.name !== undefined) sets.push("name = ?") && binds.push(normalizeName(body.name));
  if (!sets.length) return c.json({ error: "Nothing to change (name, email)" }, 400);
  const row = await db.prepare(`UPDATE support_conversations SET ${sets.join(", ")}, updated_at = ? WHERE id = ? RETURNING *`).bind(...binds, now(), conv.id).first<ConversationRow>();
  return c.json({ conversation: toConversation(row!) });
});

/** Push to support staff after the response. */
function notifyStaff(c: Ctx, conv: ConversationRow, text: string, devices: PushDevice[]) {
  if (!devices.length) return;
  const who = conv.name || conv.email || "Visitor";
  c.executionCtx.waitUntil(
    pushAlert(c.env, c.env.DB, devices.slice(0, 5), supportAlert(conv.id, conv.number, who, text)).catch((err) => console.error("support push failed", (err as Error)?.message ?? err)),
  );
}

// ---------- Staff inbox (instance.support.manage) ----------

export const supportAdminRoutes = new Hono<AppEnv>();
const staff = requireInstancePermission("instance.support.manage");

const TICKET_SELECT = `SELECT sc.*, u.name AS user_name, u.email AS user_email, w.name AS workspace_name, a.name AS assignee_name
  FROM support_conversations sc LEFT JOIN users u ON u.id = sc.user_id LEFT JOIN workspaces w ON w.id = sc.workspace_id LEFT JOIN users a ON a.id = sc.assignee_id`;

const loadTicket = (db: D1Database, id: string) => db.prepare(`${TICKET_SELECT} WHERE sc.id = ?`).bind(id).first<TicketRow>();

supportAdminRoutes.get("/admin/support/conversations", staff, async (c) => {
  const db = c.env.DB;
  const status = c.req.query("status") ?? "open";
  if (status !== "all" && !STATUSES.includes(status as SupportStatus)) return c.json({ error: "status must be open, pending, closed or all" }, 400);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status !== "all") where.push("sc.status = ?") && binds.push(status);
  if (["1", "true"].includes(c.req.query("mine") ?? "")) where.push("sc.assignee_id = ?") && binds.push(c.var.user.id);
  if (["1", "true"].includes(c.req.query("unread") ?? "")) where.push("sc.staff_unread > 0");
  const q = c.req.query("q")?.trim().slice(0, 100);
  if (q) {
    const num = /^#?(\d{1,9})$/.exec(q)?.[1];
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(
      `(${num ? "sc.number = ? OR " : ""}sc.name LIKE ? ESCAPE '\\' OR sc.email LIKE ? ESCAPE '\\' OR sc.subject LIKE ? ESCAPE '\\' OR sc.last_message_preview LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`,
    );
    binds.push(...(num ? [Number(num)] : []), like, like, like, like, like);
  }
  const before = Number(c.req.query("before"));
  if (Number.isFinite(before) && before > 0) where.push("sc.last_message_at < ?") && binds.push(before);
  const [list, counts] = await db.batch([
    db.prepare(`${TICKET_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sc.last_message_at DESC LIMIT ?`).bind(...binds, limit + 1),
    db.prepare("SELECT status, COUNT(*) AS n, SUM(staff_unread > 0) AS unread FROM support_conversations GROUP BY status"),
  ]);
  const rows = list.results as unknown as TicketRow[];
  const out: SupportTicketListDTO = { items: rows.slice(0, limit).map(toTicket), counts: { open: 0, pending: 0, closed: 0, unread: 0 }, nextBefore: rows.length > limit ? rows[limit - 1].last_message_at : null };
  for (const r of counts.results as Array<{ status: SupportStatus; n: number; unread: number | null }>) {
    if (r.status in out.counts) out.counts[r.status] = r.n;
    out.counts.unread += r.unread ?? 0;
  }
  return c.json(out);
});

supportAdminRoutes.get("/admin/support/count", staff, async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) FILTER (WHERE staff_unread > 0) AS unread, COUNT(*) FILTER (WHERE status = 'open') AS open FROM support_conversations WHERE status != 'closed' OR staff_unread > 0").first<{
    unread: number;
    open: number;
  }>();
  return c.json({ unread: row?.unread ?? 0, open: row?.open ?? 0 });
});

supportAdminRoutes.get("/admin/support/conversations/:id", staff, async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  // Opening it marks the customer's messages read.
  const [, msgs, row] = await db.batch([
    db.prepare("UPDATE support_conversations SET staff_unread = 0 WHERE id = ? AND staff_unread > 0").bind(id),
    db.prepare("SELECT id, author, author_name, body, created_at FROM support_messages WHERE conversation_id = ? ORDER BY created_at LIMIT 1000").bind(id),
    db.prepare(`${TICKET_SELECT} WHERE sc.id = ?`).bind(id),
  ]);
  const conv = (row.results as unknown as TicketRow[])[0];
  if (!conv) return c.json(NOT_FOUND, 404);
  return c.json({ conversation: toTicket(conv), messages: (msgs.results as unknown as MessageRow[]).map(toMessage) });
});

supportAdminRoutes.post("/admin/support/conversations/:id/messages", staff, async (c) => {
  const db = c.env.DB;
  const conv = await loadTicket(db, c.req.param("id"));
  if (!conv) return c.json(NOT_FOUND, 404);
  const body = await c.req.json<{ body?: unknown; note?: unknown; status?: unknown }>().catch(() => ({}) as { body?: unknown; note?: unknown; status?: unknown });
  const text = cleanBody(body.body);
  if (!text) return c.json({ error: `Write a message (at most ${BODY_MAX} characters)` }, 400);
  const note = body.note === true;
  if (body.status !== undefined && !STATUSES.includes(body.status as SupportStatus)) return c.json({ error: "status must be open, pending or closed" }, 400);
  const status = (body.status as SupportStatus | undefined) ?? (note ? conv.status : "pending");
  const t = now();
  const me = c.var.user;
  const id = newId("sm_");
  await db.batch([
    db.prepare("INSERT INTO support_messages (id, conversation_id, author, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, conv.id, note ? "note" : "staff", me.id, me.name, text, t),
    note
      ? db
          .prepare("UPDATE support_conversations SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?")
          .bind(status, status, t, t, conv.id)
      : db
          .prepare(
            `UPDATE support_conversations SET status = ?1, closed_at = CASE WHEN ?1 = 'closed' THEN ?2 ELSE NULL END, customer_unread = customer_unread + 1, staff_unread = 0,
               last_message_at = ?2, last_message_preview = ?3, last_author = 'staff', updated_at = ?2, assignee_id = COALESCE(assignee_id, ?4) WHERE id = ?5`,
          )
          .bind(status, t, preview(text), me.id, conv.id),
  ]);
  const updated = (await loadTicket(db, conv.id))!;
  if (!note && conv.email && emailConfigured(c.env) && (!conv.customer_seen_at || conv.customer_seen_at < t - EMAIL_AFTER_MS)) {
    const team = (await getSetting(db, SUPPORT_SETTING.teamName)) || DEFAULT_TEAM;
    c.executionCtx.waitUntil(
      sendEmail(c.env, supportReplyEmail(conv.email, { team, staffName: me.name.split(" ")[0] || me.name, number: conv.number, reply: text, url: conv.page_url })).catch((err) =>
        console.error("support reply email failed", (err as Error)?.message ?? err),
      ),
    );
  }
  return c.json({ message: toMessage({ id, author: note ? "note" : "staff", author_name: me.name, body: text, created_at: t }), conversation: toTicket(updated) }, 201);
});

supportAdminRoutes.patch("/admin/support/conversations/:id", staff, async (c) => {
  const db = c.env.DB;
  const conv = await loadTicket(db, c.req.param("id"));
  if (!conv) return c.json(NOT_FOUND, 404);
  const body = await c.req.json<{ status?: unknown; assigneeId?: unknown; subject?: unknown }>().catch(() => ({}) as { status?: unknown; assigneeId?: unknown; subject?: unknown });
  const t = now();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as SupportStatus)) return c.json({ error: "status must be open, pending or closed" }, 400);
    sets.push("status = ?", "closed_at = ?") && binds.push(body.status, body.status === "closed" ? (conv.closed_at ?? t) : null);
  }
  if (body.assigneeId !== undefined) {
    if (body.assigneeId !== null) {
      const ok = await db
        .prepare(
          `SELECT 1 AS x FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.status = 'active' AND EXISTS (SELECT 1 FROM json_each(r.permissions) WHERE value = 'instance.support.manage')`,
        )
        .bind(String(body.assigneeId))
        .first();
      if (!ok) return c.json({ error: "Assignee must be a user who answers support chats" }, 400);
    }
    sets.push("assignee_id = ?") && binds.push(body.assigneeId);
  }
  if (body.subject !== undefined) sets.push("subject = ?") && binds.push(normalizeName(body.subject, 120));
  if (!sets.length) return c.json({ error: "Nothing to change (status, assigneeId, subject)" }, 400);
  await db.prepare(`UPDATE support_conversations SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...binds, t, conv.id).run();
  return c.json({ conversation: toTicket((await loadTicket(db, conv.id))!) });
});

supportAdminRoutes.delete("/admin/support/conversations/:id", staff, async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM support_conversations WHERE id = ?").bind(c.req.param("id")).run();
  return res.meta.changes ? c.json({ ok: true }) : c.json(NOT_FOUND, 404);
});

supportAdminRoutes.get("/admin/support/staff", staff, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active' AND u.is_demo = 0 AND EXISTS (SELECT 1 FROM json_each(r.permissions) WHERE value = 'instance.support.manage') ORDER BY u.name`,
  ).all<{ id: string; name: string; email: string }>();
  return c.json({ items: results });
});

async function settingsDto(c: Ctx): Promise<SupportSettingsDTO> {
  const s = await supportSettings(c.env.DB);
  const base = await baseUrl(c.env, c.req.url);
  return { ...s, emailConfigured: emailConfigured(c.env), snippet: `<script src="${base}/support/widget.js" async></script>` };
}

supportAdminRoutes.get("/admin/support/settings", staff, async (c) => c.json(await settingsDto(c)));

supportAdminRoutes.patch("/admin/support/settings", staff, async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ enabled?: unknown; teamName?: unknown; greeting?: unknown }>().catch(() => ({}) as { enabled?: unknown; teamName?: unknown; greeting?: unknown });
  const writes: D1PreparedStatement[] = [];
  const put = (key: string, value: string | null) =>
    writes.push(
      value === null
        ? db.prepare("DELETE FROM settings WHERE key = ?").bind(key)
        : db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value),
    );
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    put(SUPPORT_SETTING.enabled, body.enabled ? "1" : null);
  }
  if (body.teamName !== undefined) put(SUPPORT_SETTING.teamName, normalizeName(body.teamName, 60));
  if (body.greeting !== undefined) {
    if (body.greeting !== null && typeof body.greeting !== "string") return c.json({ error: "greeting must be text" }, 400);
    put(SUPPORT_SETTING.greeting, typeof body.greeting === "string" ? body.greeting.trim().slice(0, 300) || null : null);
  }
  if (!writes.length) return c.json({ error: "Nothing to change (enabled, teamName, greeting)" }, 400);
  await db.batch(writes);
  return c.json(await settingsDto(c));
});
