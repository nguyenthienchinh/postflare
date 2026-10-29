/**
 * Cloudflare Turnstile (bot check) for the public auth forms: sign-up, access requests, sign-in links by email, and sign-in after repeated
 * failures. Off unless configured: a site key + secret key from Admin → Settings (table `settings`, the secret encrypted
 * with encryptJson), or the TURNSTILE_SITE_KEY var + TURNSTILE_SECRET_KEY secret, which win when set.
 *
 * Self-contained so it can be copied to the other *flare apps: it only needs the `settings` table (key, value) and
 * encryptJson/decryptJson from ./crypto. Server-side validation: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
import { decryptJson, encryptJson } from "./crypto";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Settings keys: the site key in clear (it is public), the secret as an encryptJson blob. */
export const TURNSTILE_SETTING = { siteKey: "turnstile_site_key", secret: "turnstile_secret" } as const;
/** Actions set on the widget and checked against siteverify's `action`. */
export type TurnstileAction = "signup" | "magic_link" | "login" | "app_login" | "apply";

export const CAPTCHA_FAILED = "The bot check failed. Try again.";
export const CAPTCHA_UNAVAILABLE = "The bot check could not reach Cloudflare. Try again in a minute.";
const TIMEOUT_MS = 5000;
const MAX_TOKEN = 2048;

interface TurnstileEnv {
  DB: D1Database;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export interface TurnstileConfig {
  siteKey: string | null;
  /** A secret is set (env or stored). */
  secretSet: boolean;
  /** The secret itself: only loaded (decrypted) with `{ secret: true }`. */
  secretKey: string | null;
  siteKeyFromEnv: boolean;
  secretFromEnv: boolean;
}

/** Effective configuration (env first, then settings). One D1 query; the secret is decrypted only when stored and needed. */
export async function turnstileConfig(env: TurnstileEnv, opts: { secret?: boolean } = {}): Promise<TurnstileConfig> {
  const envSite = env.TURNSTILE_SITE_KEY?.trim() || null;
  const envSecret = env.TURNSTILE_SECRET_KEY?.trim() || null;
  let siteKey = envSite;
  let secretKey = opts.secret ? envSecret : null;
  let secretSet = !!envSecret;
  if (!envSite || !envSecret) {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, ?)")
      .bind(TURNSTILE_SETTING.siteKey, TURNSTILE_SETTING.secret)
      .all<{ key: string; value: string }>();
    const s = new Map(results.map((r) => [r.key, r.value]));
    siteKey ??= s.get(TURNSTILE_SETTING.siteKey) || null;
    const blob = s.get(TURNSTILE_SETTING.secret);
    if (!envSecret && blob) {
      secretSet = true;
      // Without opts.secret only presence matters (the public status): no decryption.
      if (opts.secret) secretKey = await decryptJson<string>(env as unknown as Env, blob).catch(() => null);
    }
  }
  return { siteKey, secretSet, secretKey, siteKeyFromEnv: !!envSite, secretFromEnv: !!envSecret };
}

/** The public site key when Turnstile is on (both keys present), else null. */
export async function turnstileSiteKey(env: TurnstileEnv): Promise<string | null> {
  const cfg = await turnstileConfig(env);
  return cfg.siteKey && cfg.secretSet ? cfg.siteKey : null;
}

/** Stores the keys set by an admin. `undefined` keeps a value, `null`/"" removes it. */
export async function saveTurnstileConfig(env: TurnstileEnv, input: { siteKey?: string | null; secretKey?: string | null }) {
  const stmts: D1PreparedStatement[] = [];
  const put = (key: string, value: string | null) =>
    stmts.push(
      value
        ? env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value)
        : env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key),
    );
  if (input.siteKey !== undefined) put(TURNSTILE_SETTING.siteKey, input.siteKey?.trim() || null);
  if (input.secretKey !== undefined) put(TURNSTILE_SETTING.secret, input.secretKey?.trim() ? await encryptJson(env as unknown as Env, input.secretKey.trim()) : null);
  if (stmts.length) await env.DB.batch(stmts);
}

/** Site and secret keys: letters, digits, "-" and "_" (production ones start with 0x, test ones with 1x/2x/3x). */
export const validTurnstileKey = (v: unknown): v is string => typeof v === "string" && /^[\w-]{10,200}$/.test(v.trim());

export type TurnstileVerdict =
  | { ok: true; testing?: true }
  | { ok: false; status: 400; error: string; code: "captcha"; reason: string }
  | { ok: false; status: 503; error: string; code: "captcha_unavailable"; reason: string };

interface SiteverifyResponse {
  success?: boolean;
  "error-codes"?: string[];
  hostname?: string;
  action?: string;
  metadata?: { result_with_testing_key?: boolean };
}

const failed = (reason: string): TurnstileVerdict => ({ ok: false, status: 400, error: CAPTCHA_FAILED, code: "captcha", reason });
const unavailable = (reason: string): TurnstileVerdict => ({ ok: false, status: 503, error: CAPTCHA_UNAVAILABLE, code: "captcha_unavailable", reason });

async function siteverify(secret: string, token: string, remoteip: string | null | undefined, fetcher: typeof fetch): Promise<SiteverifyResponse> {
  const form = new URLSearchParams({ secret, response: token, idempotency_key: crypto.randomUUID() });
  if (remoteip) form.set("remoteip", remoteip);
  const res = await fetcher(SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status >= 500) throw new Error(`siteverify HTTP ${res.status}`);
  return (await res.json()) as SiteverifyResponse;
}

/**
 * Checks a widget token: success, the hostname it was solved on (one of `hostnames`) and the expected action. Fails
 * closed: Cloudflare unreachable (5 s timeout, 5xx, `internal-error`) → 503. Responses to Turnstile's test secret keys
 * (metadata.result_with_testing_key, hostname "example.com", no action) skip the hostname/action checks so local dev
 * with the test keys works; a test secret offers no protection anyway.
 */
export async function verifyTurnstile(opts: {
  secret: string;
  token: unknown;
  action: TurnstileAction;
  hostnames: string[];
  remoteip?: string | null;
  fetch?: typeof fetch;
}): Promise<TurnstileVerdict> {
  const token = typeof opts.token === "string" ? opts.token.trim() : "";
  if (!token || token.length > MAX_TOKEN) return failed("missing-input-response");
  let out: SiteverifyResponse;
  try {
    out = await siteverify(opts.secret, token, opts.remoteip, opts.fetch ?? fetch);
  } catch (err) {
    console.error("turnstile siteverify failed", (err as Error)?.message ?? err);
    return unavailable("network");
  }
  const codes = out["error-codes"] ?? [];
  if (!out.success) {
    if (codes.includes("internal-error")) return unavailable("internal-error");
    // A wrong secret is the admin's problem, not the visitor's: logged so it shows in the Worker logs.
    if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret")) console.error("turnstile: the secret key is invalid");
    return failed(codes[0] ?? "unsuccessful");
  }
  if (out.metadata?.result_with_testing_key) return { ok: true, testing: true };
  const allowed = opts.hostnames.map((h) => h.toLowerCase());
  if (!out.hostname || !allowed.includes(out.hostname.toLowerCase())) return failed("hostname");
  if (out.action !== opts.action) return failed("action");
  return { ok: true };
}

/**
 * Admin "Test": siteverify with a dummy token. `invalid-input-response` means Cloudflare accepted the secret (and
 * rejected the token, as it should); `invalid-input-secret` means the secret is wrong.
 */
export async function testTurnstileSecret(secret: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; testing?: true } | { ok: false; error: string }> {
  let out: SiteverifyResponse;
  try {
    out = await siteverify(secret, "XXXX.DUMMY.TOKEN.XXXX", null, fetcher);
  } catch (err) {
    return { ok: false, error: `Could not reach Cloudflare: ${(err as Error)?.message ?? String(err)}` };
  }
  const codes = out["error-codes"] ?? [];
  if (out.success) return out.metadata?.result_with_testing_key ? { ok: true, testing: true } : { ok: true };
  if (codes.includes("invalid-input-response") || codes.includes("timeout-or-duplicate")) return { ok: true };
  if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret")) return { ok: false, error: "Cloudflare rejected the secret key (invalid-input-secret): copy it again from the widget in the Cloudflare dashboard." };
  return { ok: false, error: `Unexpected answer from Cloudflare: ${codes.join(", ") || "unknown"}` };
}

/** Hostnames a token may come from: the request's and, when set, the public URL's. */
export function allowedHostnames(requestUrl: string, publicUrl?: string | null): string[] {
  const hosts = [new URL(requestUrl).hostname];
  if (publicUrl) {
    try {
      hosts.push(new URL(publicUrl).hostname);
    } catch {}
  }
  return hosts;
}
