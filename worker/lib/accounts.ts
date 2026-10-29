import type { AccountDTO } from "../../shared/types";
import { getProvider, providers, redirectUriFor } from "../providers/registry";
import { ProviderError } from "../providers/errors";
import type { AccountRecord, ConnectedAccount, CredentialsUpdate, Provider, ProviderContext } from "../providers/types";
import { AVATARS_PER_CONNECT, avatarUrl, copyAvatar, deleteAvatars, storedAvatarName } from "./avatars";
import { decryptJson, encryptJson } from "./crypto";
import { mediaAccess } from "./media";
import { terminateWorkflow } from "./posts";
import { metricsStatusDto } from "./metrics";
import { baseUrl } from "./settings";
import { newId, now, parseJson } from "./util";

export interface AccountRow {
  id: string;
  provider: string;
  external_id: string;
  name: string;
  username: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  credentials_enc: string;
  expires_at: number | null;
  meta: string;
  status: "active" | "disabled" | "reconnect";
  status_message: string | null;
  created_at: number;
  updated_at: number;
  workspace_id: string | null;
  created_by: string | null;
  metrics?: string | null;
  metrics_status?: string | null;
  metrics_message?: string | null;
  metrics_checked_at?: number | null;
  metrics_next_at?: number | null;
  metrics_fails?: number;
  group_id?: string | null;
  avatar_checked_at?: number | null;
  reconnected_at?: number | null;
}

/**
 * External id as shown to API clients. A webhook's id is its full URL, which often is the credential itself
 * (Zapier/Make/n8n/Slack hook URLs): only its origin is shown, to every role that can list accounts.
 */
export function publicExternalId(provider: string, externalId: string): string {
  if (provider !== "webhook") return externalId;
  try {
    return `${new URL(externalId).origin}/…`;
  } catch {
    return "…";
  }
}

export function accountDto(row: AccountRow): AccountDTO {
  return {
    id: row.id,
    provider: row.provider,
    externalId: publicExternalId(row.provider, row.external_id),
    name: row.name,
    username: row.username,
    avatarUrl: row.avatar_url,
    profileUrl: row.profile_url,
    status: row.status,
    statusMessage: row.status_message,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    reconnectedAt: row.reconnected_at ?? null,
    metricsStatus: metricsStatusDto(row),
    groupId: row.group_id ?? null,
  };
}

export async function getAppConfig(env: Env, provider: string): Promise<Record<string, string>> {
  const row = await env.DB.prepare("SELECT config_enc FROM platform_apps WHERE provider = ?")
    .bind(provider)
    .first<{ config_enc: string }>();
  return row ? await decryptJson<Record<string, string>>(env, row.config_enc) : {};
}

export async function providerContext(
  env: Env,
  provider: Provider,
  opts: { requestUrl?: string; log?: ProviderContext["log"] } = {},
): Promise<ProviderContext> {
  const base = await baseUrl(env, opts.requestUrl);
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    app: await getAppConfig(env, provider.id),
    redirectUri: redirectUriFor(base, provider),
    baseUrl: base,
    media: mediaAccess(env),
    log: opts.log ?? ((level, message) => console[level === "info" ? "log" : level](`[${provider.id}] ${message}`)),
  };
}

export async function accountRecord(env: Env, row: AccountRow): Promise<AccountRecord> {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    name: row.name,
    username: row.username,
    credentials: await decryptJson(env, row.credentials_enc),
    expiresAt: row.expires_at,
    meta: parseJson(row.meta, {}),
  };
}

/** Unscoped: only for workflows and cron. Request handlers use `findAccount`. */
export async function getAccountRow(env: Env, id: string): Promise<AccountRow | null> {
  return env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
}

/** An account of the given workspace (null for unknown ids and accounts of other workspaces). */
export async function findAccount(env: Env, workspaceId: string, id: string): Promise<AccountRow | null> {
  return env.DB.prepare("SELECT * FROM accounts WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first<AccountRow>();
}

/**
 * Remove accounts with everything tied to them: their scheduled workflows are stopped, then their posts, post logs,
 * post and account metrics and the account rows (tokens, profile data) are deleted. Unscoped: callers check access.
 * Used by "Remove" on the Accounts page and by the Meta data deletion callback. 2 D1 round trips whatever the count;
 * their avatar copies in R2 go too (one R2 list per account).
 */
export async function removeAccounts(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const list = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT workflow_id FROM posts WHERE account_id IN (${list}) AND status = 'scheduled' AND workflow_id IS NOT NULL`,
  )
    .bind(...ids)
    .all<{ workflow_id: string }>();
  await Promise.all(results.map((r) => terminateWorkflow(env, r.workflow_id)));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM post_logs WHERE post_id IN (SELECT id FROM posts WHERE account_id IN (${list}))`).bind(...ids),
    env.DB.prepare(`DELETE FROM post_metrics WHERE post_id IN (SELECT id FROM posts WHERE account_id IN (${list}))`).bind(...ids),
    env.DB.prepare(`DELETE FROM account_metrics WHERE account_id IN (${list})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts WHERE account_id IN (${list})`).bind(...ids),
    env.DB.prepare(`DELETE FROM accounts WHERE id IN (${list})`).bind(...ids),
  ]);
  await deleteAvatars(env, ids);
}

/** Thrown when a social account is already connected in another workspace (it is never moved silently). */
export class AccountElsewhereError extends Error {}

/**
 * Insert or update connected accounts (matching provider + external id) in a workspace. Returns their ids.
 * All-or-nothing: if any account is already connected in another workspace, nothing is saved.
 */
export async function saveConnectedAccounts(
  env: Env,
  providerId: string,
  accounts: ConnectedAccount[],
  owner: { workspaceId: string; userId: string },
  /** Plan limit check for the accounts that are new to the workspace (reconnects don't count); throws to refuse. */
  limit?: (adding: number) => Promise<void>,
): Promise<string[]> {
  const existing = new Map<string, { id: string; workspace_id: string | null; avatar_url: string | null }>();
  if (accounts.length) {
    const { results } = await env.DB.prepare(
      `SELECT id, external_id, workspace_id, avatar_url FROM accounts WHERE provider = ? AND external_id IN (${accounts.map(() => "?").join(",")})`,
    )
      .bind(providerId, ...accounts.map((a) => a.externalId))
      .all<{ id: string; external_id: string; workspace_id: string | null; avatar_url: string | null }>();
    for (const r of results) existing.set(r.external_id, r);
  }
  const elsewhere = accounts.filter((a) => {
    const e = existing.get(a.externalId);
    return e && e.workspace_id !== owner.workspaceId;
  });
  if (elsewhere.length) {
    const names = elsewhere.map((a) => (a.username ? `${a.name} (@${a.username})` : a.name)).join(", ");
    throw new AccountElsewhereError(
      `${names} ${elsewhere.length > 1 ? "are" : "is"} already connected in another workspace. Remove ${elsewhere.length > 1 ? "them" : "it"} there first.`,
    );
  }
  if (limit) {
    const adding = accounts.filter((a) => !existing.has(a.externalId)).length;
    if (adding) await limit(adding);
  }
  const ids = accounts.map((a) => existing.get(a.externalId)?.id ?? newId("acc_"));
  // Copy the (often expiring) avatar URLs into R2 first, so the rows get the stable URL. Failures keep the platform's
  // URL with avatar_checked_at NULL: the cron retries soon.
  const avatars = await connectAvatars(env, accounts.slice(0, AVATARS_PER_CONNECT).map((a, i) => ({ id: ids[i], remote: a.avatarUrl ?? null })));
  // One batch whatever the number of accounts (a Facebook login may return dozens of pages): D1 query budget.
  const statements: D1PreparedStatement[] = [];
  const t = now();
  for (const [i, a] of accounts.entries()) {
    const id = ids[i];
    const enc = await encryptJson(env, a.credentials);
    const stored = avatars.get(id);
    // No picture at all counts as checked; a failed copy does not.
    const checked = stored || !a.avatarUrl ? t : null;
    statements.push(
      env.DB.prepare(
        `INSERT INTO accounts (id, provider, external_id, name, username, avatar_url, profile_url, credentials_enc, expires_at, refresh_expires_at, meta, status, status_message, created_at, updated_at, workspace_id, created_by, avatar_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username, avatar_url = excluded.avatar_url,
           avatar_checked_at = excluded.avatar_checked_at,
           profile_url = excluded.profile_url, credentials_enc = excluded.credentials_enc, expires_at = excluded.expires_at,
           refresh_expires_at = excluded.refresh_expires_at, meta = excluded.meta, status = 'active', status_message = NULL, updated_at = excluded.updated_at,
           reconnected_at = excluded.updated_at,
           metrics_status = CASE WHEN accounts.metrics_status = 'ok' THEN 'ok' ELSE NULL END, metrics_message = NULL, metrics_next_at = NULL, metrics_fails = 0
         WHERE accounts.workspace_id = excluded.workspace_id`,
      ).bind(
        id,
        providerId,
        a.externalId,
        a.name,
        a.username ?? null,
        stored?.url ?? a.avatarUrl ?? null,
        a.profileUrl ?? null,
        enc,
        a.expiresAt ?? null,
        a.refreshExpiresAt ?? null,
        JSON.stringify(a.meta ?? {}),
        t,
        t,
        owner.workspaceId,
        owner.userId,
        checked,
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  // Reconnects: the previous copies of a replaced picture go.
  const reconnected = new Set([...existing.values()].map((e) => e.id));
  await Promise.all([...avatars].filter(([id]) => reconnected.has(id)).map(([id, copy]) => deleteAvatars(env, [id], copy.name)));
  return ids;
}

/** Copies of the accounts' pictures (in parallel), by account id. Never throws. */
async function connectAvatars(env: Env, list: Array<{ id: string; remote: string | null }>): Promise<Map<string, { name: string; url: string }>> {
  const out = new Map<string, { name: string; url: string }>();
  const todo = list.filter((a) => a.remote && !storedAvatarName(a.remote, a.id));
  if (!todo.length) return out;
  const base = await baseUrl(env).catch(() => null);
  await Promise.all(
    todo.map(async (a) => {
      const copy = await copyAvatar(env, base, a.id, a.remote!);
      if (copy) out.set(a.id, copy);
    }),
  );
  return out;
}

async function applyUpdate(env: Env, account: AccountRecord, update: CredentialsUpdate): Promise<AccountRecord> {
  const merged: AccountRecord = {
    ...account,
    credentials: { ...account.credentials, ...update.credentials },
    expiresAt: update.expiresAt === undefined ? account.expiresAt : update.expiresAt,
    meta: update.meta ? { ...account.meta, ...update.meta } : account.meta,
  };
  const refreshExpires = update.refreshExpiresAt === undefined ? null : update.refreshExpiresAt;
  await env.DB.prepare(
    // Keep an account the user disabled disabled; a successful refresh only clears 'reconnect'.
    `UPDATE accounts SET credentials_enc = ?, expires_at = ?, meta = ?, ${update.refreshExpiresAt === undefined ? "" : "refresh_expires_at = ?, "}status = CASE WHEN status = 'disabled' THEN status ELSE 'active' END, status_message = CASE WHEN status = 'disabled' THEN status_message ELSE NULL END, updated_at = ? WHERE id = ?`,
  )
    .bind(
      ...[await encryptJson(env, merged.credentials), merged.expiresAt, JSON.stringify(merged.meta)],
      ...(update.refreshExpiresAt === undefined ? [] : [refreshExpires]),
      now(),
      account.id,
    )
    .run();
  return merged;
}

export async function markReconnect(env: Env, accountId: string, message: string) {
  await env.DB.prepare("UPDATE accounts SET status = 'reconnect', status_message = ?, updated_at = ? WHERE id = ?")
    .bind(message.slice(0, 500), now(), accountId)
    .run();
}

const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/** Returns the account with fresh credentials, refreshing when the token expires soon (or `force`). */
export async function freshAccount(
  env: Env,
  provider: Provider,
  ctx: ProviderContext,
  row: AccountRow,
  opts: { force?: boolean; withinMs?: number } = {},
): Promise<AccountRecord> {
  const account = await accountRecord(env, row);
  if (!provider.refresh) return account;
  const due = account.expiresAt !== null && account.expiresAt - (opts.withinMs ?? REFRESH_MARGIN_MS) < now();
  if (!due && !opts.force) return account;
  try {
    return await applyUpdate(env, account, await provider.refresh(ctx, account));
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "auth") {
      // A concurrent refresh (another workflow, cron) may have rotated the refresh token we just used: use its result.
      const latest = await getAccountRow(env, row.id);
      if (latest && latest.credentials_enc !== row.credentials_enc && latest.status !== "reconnect") {
        return accountRecord(env, latest);
      }
      await markReconnect(env, row.id, `Token refresh failed: ${err.message}`);
    }
    throw err;
  }
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/** Cron refreshes access tokens expiring before the next 15-minute tick plus a margin (publishing refreshes on demand). */
export const REFRESH_WINDOW_MS = 45 * MINUTE;
/** Refresh credentials that expire themselves (refresh tokens, Instagram/Threads long-lived tokens) this early. */
export const REFRESH_TOKEN_WINDOW_MS = 7 * DAY;
/** ...at most this often per account (a refresh that does not extend the refresh token would repeat every tick). */
const REFRESH_TOKEN_RETRY_MS = 12 * 60 * MINUTE;
/**
 * Accounts refreshed per cron tick: about 1 fetch and 2 D1 queries each, so the tick stays within the Free plan's
 * 50 subrequests / 50 D1 queries next to analytics. The rest is handled by the next tick (oldest first).
 */
export const REFRESHES_PER_TICK = 5;

/**
 * Cron: keep idle accounts connected without refreshing every short-lived token on every tick. Refreshes, oldest
 * first and at most REFRESHES_PER_TICK:
 * - access tokens expiring within REFRESH_WINDOW_MS;
 * - accounts whose refresh credential (`refresh_expires_at`) expires within REFRESH_TOKEN_WINDOW_MS.
 * Publishing and analytics refresh on demand anyway (`freshAccount`). Returns the number of accounts tried.
 */
export async function refreshExpiringAccounts(env: Env, opts: { limit?: number } = {}): Promise<number> {
  const refreshable = providers.filter((p) => p.refresh).map((p) => p.id);
  const t = now();
  const { results } = await env.DB.prepare(
    // Demo workspaces hold fake tokens: never refresh them.
    `SELECT * FROM accounts WHERE status = 'active' AND provider IN (${refreshable.map(() => "?").join(",")})
       AND ((expires_at IS NOT NULL AND expires_at < ?) OR (refresh_expires_at IS NOT NULL AND refresh_expires_at < ? AND updated_at < ?))
       AND (workspace_id IS NULL OR workspace_id NOT IN (SELECT id FROM workspaces WHERE is_demo = 1))
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(...refreshable, t + REFRESH_WINDOW_MS, t + REFRESH_TOKEN_WINDOW_MS, t - REFRESH_TOKEN_RETRY_MS, opts.limit ?? REFRESHES_PER_TICK)
    .all<AccountRow>();
  const contexts = new Map<string, Promise<ProviderContext>>();
  for (const row of results) {
    const provider = getProvider(row.provider);
    if (!provider?.refresh) continue;
    try {
      let ctx = contexts.get(provider.id);
      if (!ctx) contexts.set(provider.id, (ctx = providerContext(env, provider)));
      await freshAccount(env, provider, await ctx, row, { force: true });
    } catch (err) {
      console.error(`refresh ${row.provider}/${row.id} failed`, err);
      // Move it to the back of the queue so one failing account does not take every tick's slots.
      await env.DB.prepare("UPDATE accounts SET updated_at = ? WHERE id = ?").bind(now(), row.id).run().catch(() => {});
    }
  }
  return results.length;
}

/** Re-check stored avatars this often (platforms' pictures change; their URLs expire within days). */
export const AVATAR_RECHECK_MS = 7 * DAY;
/** ...and retry failed copies after a day. */
const AVATAR_RETRY_MS = DAY;
/**
 * Accounts whose avatar the frequent cron checks per tick: at most 3 fetches (token refresh, profile, picture), 1-2 D1
 * queries (app config, refresh) and 2-3 R2 calls each, plus one SELECT and one UPDATE batch for the tick. Never
 * copied accounts (new ones whose copy failed, accounts connected before avatars were copied) go first.
 */
export const AVATARS_PER_TICK = 2;

/**
 * Cron (and POST /accounts/:id/refresh with `rows`): copy account avatars into R2 (lib/avatars.ts). Per account: a
 * fresh picture URL from `Provider.profile` when the platform has one (its URLs expire), else the stored platform
 * URL; the copy replaces `avatar_url` and older copies are deleted. Accounts already pointing at a copy that the
 * platform cannot refresh only get their URL rewritten when the media domain changed. Never throws; returns the
 * number of accounts checked.
 */
export async function refreshAvatars(env: Env, opts: { limit?: number; rows?: AccountRow[] } = {}): Promise<number> {
  const t = now();
  const rows =
    opts.rows ??
    (
      await env.DB.prepare(
        `SELECT * FROM accounts WHERE status != 'disabled' AND (avatar_checked_at IS NULL OR avatar_checked_at < ?)
           AND (workspace_id IS NULL OR workspace_id NOT IN (SELECT id FROM workspaces WHERE is_demo = 1))
         ORDER BY avatar_checked_at, created_at LIMIT ?`,
      )
        .bind(t - AVATAR_RECHECK_MS, opts.limit ?? AVATARS_PER_TICK)
        .all<AccountRow>()
        .catch(() => ({ results: [] as AccountRow[] }))
    ).results;
  if (!rows.length) return 0;
  const base = await baseUrl(env).catch(() => null);
  const contexts = new Map<string, Promise<ProviderContext>>();
  const updates: Array<{ row: AccountRow; url: string | null; name: string | null; checked: number }> = [];
  for (const row of rows) {
    const provider = getProvider(row.provider);
    let remote: string | null = null;
    if (provider?.profile && row.status === "active") {
      try {
        let ctx = contexts.get(provider.id);
        if (!ctx) contexts.set(provider.id, (ctx = providerContext(env, provider)));
        const account = await freshAccount(env, provider, await ctx, row);
        remote = (await provider.profile(await ctx, account)).avatarUrl;
      } catch (err) {
        console.warn(`profile of ${row.provider}/${row.id} failed`, err);
      }
    }
    const current = storedAvatarName(row.avatar_url, row.id);
    if (!remote && !current) remote = row.avatar_url;
    let url = row.avatar_url;
    let name = current;
    let ok = !remote && !!current;
    if (remote) {
      const copy = await copyAvatar(env, base, row.id, remote);
      if (copy) {
        url = copy.url;
        name = copy.name;
        ok = true;
      } else if (!current) {
        // Not copied: the fresh platform URL still beats an expired one (retried tomorrow).
        url = remote;
      }
    } else if (current) {
      // Our copy, but the media domain (MEDIA_PUBLIC_URL) or the public URL changed since: same file, new URL.
      url = (await avatarUrl(env, base, current)) ?? url;
    }
    updates.push({ row, url, name, checked: ok || !url ? t : t - AVATAR_RECHECK_MS + AVATAR_RETRY_MS });
  }
  try {
    // Guarded on the URL read above: a reconnect meanwhile wins.
    const results = await env.DB.batch(
      updates.map((u) =>
        env.DB.prepare("UPDATE accounts SET avatar_url = ?, avatar_checked_at = ? WHERE id = ? AND avatar_url IS ?").bind(u.url, u.checked, u.row.id, u.row.avatar_url),
      ),
    );
    await Promise.all(updates.map((u, i) => (u.name && results[i].meta.changes ? deleteAvatars(env, [u.row.id], u.name) : null)));
  } catch (err) {
    console.error("avatar refresh not saved", err);
  }
  return rows.length;
}
