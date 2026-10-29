// Meta's "Data Deletion Request Callback": when someone removes the app in Facebook/Instagram/Threads settings and asks
// for their data to be deleted, Meta POSTs a signed_request here. Spec:
// https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
import { removeAccounts } from "./accounts";
import { decryptJson } from "./crypto";
import { baseUrl, getSetting, setSetting } from "./settings";
import { fromBase64url, now, parseJson, randomToken } from "./util";

/** Providers whose developer app lives in the Meta dashboard (each may have its own app secret). */
export const META_PROVIDERS = ["facebook", "instagram", "instagram_standalone", "threads"] as const;

/** Path Meta calls (`/oauth/meta/data-deletion`; `/oauth/<provider>/data-deletion` only checks that app's secret). */
export const DATA_DELETION_PATH = "/oauth/meta/data-deletion";
export const dataDeletionUri = (base: string) => `${base}${DATA_DELETION_PATH}`;

/** Requests are kept this long for the status page, then the daily cron removes them. */
export const DELETION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const KEY_PREFIX = "meta_deletion:";

export interface SignedRequestPayload {
  algorithm: string;
  user_id: string;
  issued_at?: number;
  expires?: number;
}

export interface DeletionRecord {
  status: "completed" | "no_data";
  providers: string[];
  accounts: number;
  requested_at: number;
  completed_at: number;
}

/**
 * Verify `<base64url HMAC-SHA256 signature>.<base64url JSON payload>` with each secret (crypto.subtle.verify compares
 * in constant time). Returns the payload and the indexes of the secrets that signed it, or null when none did or the
 * payload is malformed.
 */
export async function verifySignedRequest(
  signedRequest: string,
  secrets: string[],
): Promise<{ payload: SignedRequestPayload; matched: number[] } | null> {
  const [sig, body, extra] = signedRequest.split(".");
  if (!sig || !body || extra !== undefined) return null;
  let signature: Uint8Array;
  let payload: SignedRequestPayload;
  try {
    signature = fromBase64url(sig);
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
  } catch {
    return null;
  }
  if (payload?.algorithm?.toUpperCase?.() !== "HMAC-SHA256" || !payload.user_id) return null;
  const data = new TextEncoder().encode(body);
  const matched: number[] = [];
  for (const [i, secret] of secrets.entries()) {
    if (!secret) continue;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (await crypto.subtle.verify("HMAC", key, signature, data)) matched.push(i);
  }
  return matched.length ? { payload: { ...payload, user_id: String(payload.user_id) }, matched } : null;
}

/** App secrets of the configured Meta providers (one D1 query). */
async function metaSecrets(env: Env, providers: readonly string[]): Promise<Array<{ provider: string; secret: string }>> {
  const { results } = await env.DB.prepare(`SELECT provider, config_enc FROM platform_apps WHERE provider IN (${providers.map(() => "?").join(",")})`)
    .bind(...providers)
    .all<{ provider: string; config_enc: string }>();
  const out: Array<{ provider: string; secret: string }> = [];
  for (const r of results) {
    const config = await decryptJson<Record<string, string>>(env, r.config_enc).catch(() => null);
    if (config?.clientSecret) out.push({ provider: r.provider, secret: config.clientSecret });
  }
  return out;
}

export type DeletionResult = { ok: true; url: string; code: string; record: DeletionRecord } | { ok: false; error: string };

/**
 * Handle a deletion request for `providers` (all Meta providers, or one). Accounts of the providers whose secret
 * signed the request and that belong to the user (external id, or `meta.metaUserId` stored at connect time) are removed
 * like "Remove" on the Accounts page. The request is recorded (without the user id) for the status page.
 */
export async function handleDataDeletion(
  env: Env,
  signedRequest: string,
  opts: { providers?: readonly string[]; requestUrl?: string } = {},
): Promise<DeletionResult> {
  const secrets = await metaSecrets(env, opts.providers ?? META_PROVIDERS);
  if (!secrets.length) return { ok: false, error: "No Meta app is configured on this instance" };
  const verified = await verifySignedRequest(signedRequest, secrets.map((s) => s.secret));
  if (!verified) return { ok: false, error: "Invalid signed_request" };
  const providers = [...new Set(verified.matched.map((i) => secrets[i].provider))];
  const userId = verified.payload.user_id;
  const { results } = await env.DB.prepare(
    `SELECT id FROM accounts WHERE provider IN (${providers.map(() => "?").join(",")})
       AND (external_id = ? OR json_extract(meta, '$.metaUserId') = ?)`,
  )
    .bind(...providers, userId, userId)
    .all<{ id: string }>();
  await removeAccounts(env, results.map((r) => r.id));

  const code = randomToken(12);
  const t = now();
  const record: DeletionRecord = {
    status: results.length ? "completed" : "no_data",
    providers,
    accounts: results.length,
    requested_at: t,
    completed_at: t,
  };
  await setSetting(env.DB, KEY_PREFIX + code, JSON.stringify(record));
  return { ok: true, code, url: `${await baseUrl(env, opts.requestUrl)}/data-deletion/?code=${code}`, record };
}

export async function deletionStatus(db: D1Database, code: string): Promise<DeletionRecord | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return null;
  return parseJson<DeletionRecord | null>(await getSetting(db, KEY_PREFIX + code), null);
}

/** Daily cron: forget requests older than DELETION_RETENTION_MS (one query). */
export function pruneDeletionsStatement(db: D1Database, t: number): D1PreparedStatement {
  return db
    .prepare("DELETE FROM settings WHERE key LIKE 'meta_deletion:%' AND json_extract(value, '$.requested_at') < ?")
    .bind(t - DELETION_RETENTION_MS);
}
