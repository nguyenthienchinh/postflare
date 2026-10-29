import { ProviderError, commitKindForStatus, kindForStatus, type ProviderErrorKind } from "./errors";
import type { ProviderContext } from "./types";

type HttpContext = Pick<ProviderContext, "fetch"> & Partial<Pick<ProviderContext, "commit">>;

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** JSON body (sets content-type). */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string | number | boolean | undefined | null>;
  body?: BodyInit | null;
  /** Bearer token. */
  token?: string;
  /** Query parameters appended to the URL. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Map an error response to a kind (e.g. 400 with "invalid_token" -> auth). */
  classify?: (status: number, body: any) => ProviderErrorKind | undefined;
  /**
   * This request creates the post (or otherwise makes it public): the irreversible call of a publish. A network
   * error, timeout or 5xx then becomes ProviderError("ambiguous") instead of "transient": the request may have
   * reached the platform, so it is never retried automatically (the post goes to `needs_check`). Leave it off for
   * calls the platform deduplicates (idempotency key, deterministic id): those may be retried.
   */
  commit?: boolean;
}

/** No platform call may hang a publish: a stalled request fails after this (Workflow steps time out at 15 min). */
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function withQuery(url: string, query?: RequestOptions["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
}

/** fetch + error mapping. Returns the raw Response on 2xx. */
export async function request(ctx: HttpContext, url: string, opts: RequestOptions = {}): Promise<Response> {
  const { json, form, token, query, classify, commit, headers: h, body, ...init } = opts;
  const headers = new Headers(h);
  let finalBody: BodyInit | null | undefined = body;
  if (json !== undefined) {
    headers.set("content-type", "application/json");
    finalBody = JSON.stringify(json);
  } else if (form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) params.set(k, String(v));
    finalBody = params.toString();
  }
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("user-agent")) headers.set("user-agent", "postflare/1.0");

  if (commit && ctx.commit) ctx.commit.sent = true;
  let res: Response;
  try {
    res = await ctx.fetch(withQuery(url, query), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init, headers, body: finalBody });
  } catch (err) {
    const host = new URL(url).host;
    if (commit) throw new ProviderError(`Network error calling ${host} while creating the post: ${(err as Error).message}`, "ambiguous");
    throw new ProviderError(`Network error calling ${host}: ${(err as Error).message}`, "transient");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const fallback = commit ? commitKindForStatus(res.status) : kindForStatus(res.status);
    let kind = classify?.(res.status, parsed) ?? fallback;
    // A classifier may call a 5xx "transient"; on a commit request that is still ambiguous.
    if (commit && kind === "transient") kind = "ambiguous";
    throw new ProviderError(`${new URL(url).host} ${res.status}: ${describe(parsed) || res.statusText}`, kind, res.status, parsed);
  }
  if (commit && ctx.commit) ctx.commit.accepted = true;
  return res;
}

/**
 * Run a commit that does not go through `request` (websockets, a provider's own fetch loop...). Marks the commit as
 * sent before `fn`, accepted after it, and turns unknown or transient failures into ProviderError("ambiguous").
 * ProviderErrors of other kinds (a definite refusal: invalid, auth, rate_limit) pass through unchanged.
 */
export async function commitCall<T>(ctx: HttpContext, fn: () => Promise<T>): Promise<T> {
  if (ctx.commit) ctx.commit.sent = true;
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    if (err instanceof ProviderError && err.kind !== "transient") throw err;
    throw new ProviderError(`Could not confirm the post was created: ${(err as Error)?.message ?? String(err)}`, "ambiguous");
  }
  if (ctx.commit) ctx.commit.accepted = true;
  return out;
}

/**
 * A commit whose API reports refusals in a 2xx body (Graph `error`, Slack `ok: false`, Reddit `json.errors`, GraphQL
 * `errors`...): `send` makes the `commit: true` request, `check` throws on such a body. A refusal created nothing, so
 * the `accepted` mark `request` set is undone (it keeps the value it had before, e.g. from an earlier commit).
 */
export async function checkedCommit<T>(ctx: HttpContext, send: () => Promise<T>, check: (out: T) => void): Promise<T> {
  const before = ctx.commit?.accepted ?? false;
  const out = await send();
  try {
    check(out);
  } catch (err) {
    if (ctx.commit) ctx.commit.accepted = before;
    throw err;
  }
  return out;
}

export async function requestJson<T = any>(ctx: HttpContext, url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(ctx, url, opts);
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

function describe(body: any): string {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 500);
  const e = body.error;
  const candidates = [
    e?.message,
    e?.error_user_msg,
    typeof e === "string" ? e : undefined,
    body.error_description,
    body.message,
    body.detail,
    body.title,
    body.errors?.[0]?.message,
    body.errors?.[0]?.detail,
  ];
  const found = candidates.find((c) => typeof c === "string" && c);
  return found ?? JSON.stringify(body).slice(0, 500);
}

/** Standard OAuth2 token request (authorization_code / refresh_token). */
export async function oauthToken(
  ctx: Pick<ProviderContext, "fetch">,
  url: string,
  params: Record<string, string | undefined>,
  opts: { basicAuth?: { id: string; secret: string }; headers?: Record<string, string> } = {},
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  [k: string]: any;
}> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.basicAuth) headers.authorization = `Basic ${btoa(`${opts.basicAuth.id}:${opts.basicAuth.secret}`)}`;
  return requestJson(ctx, url, {
    method: "POST",
    headers,
    form: params,
    classify: (status, body) =>
      body?.error === "invalid_grant" || body?.error === "invalid_token" || status === 401 ? "auth" : undefined,
  });
}

export function expiresAt(expiresInSeconds?: number | null): number | null {
  return expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Requires that app fields are configured; throws a readable error otherwise. */
export function requireApp(ctx: ProviderContext, providerName: string, ...keys: string[]): Record<string, string> {
  const missing = keys.filter((k) => !ctx.app[k]);
  if (missing.length) throw new ProviderError(`${providerName} is not configured: set ${missing.join(", ")} on the Platforms page`, "invalid");
  return ctx.app;
}

export const clientFields = (idLabel = "Client ID", secretLabel = "Client Secret") => [
  { key: "clientId", label: idLabel, type: "text" as const, required: true },
  { key: "clientSecret", label: secretLabel, type: "password" as const, required: true },
];
