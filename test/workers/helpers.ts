import { SELF } from "cloudflare:test";

export const ORIGIN = "https://pf.test";

export interface Client {
  cookie?: string;
  key?: string;
  /** Sent as X-Workspace-Id (session clients only, like the web app). */
  ws?: string;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw body (media uploads). */
  raw?: BodyInit;
}

export async function call(client: Client | null, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.key) headers.authorization = `Bearer ${client.key}`;
  if (client?.ws && !headers["x-workspace-id"]) headers["x-workspace-id"] = client.ws;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await SELF.fetch(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

/** The session cookie (name=value) from a response. */
export function sessionCookie(headers: Headers): string | undefined {
  const set = headers.get("set-cookie") ?? "";
  return set.match(/pf_session=[^;]+/)?.[0];
}

export async function login(email: string, password: string, ip = "10.0.0.1") {
  const res = await call(null, "/api/auth/login", { body: { email, password }, headers: { "cf-connecting-ip": ip } });
  return { ...res, cookie: sessionCookie(res.headers) };
}

/** Accept an invitation as a new user; returns a session client. */
export async function acceptAsNewUser(url: string, name: string, email: string, password = "password123") {
  const token = url.split("/invite/")[1];
  const res = await call(null, "/api/invitations/accept", { body: { token, name, email, password } });
  if (res.status !== 200) throw new Error(`accept failed: ${res.status} ${res.text}`);
  return { cookie: sessionCookie(res.headers)!, workspaceId: res.json.workspaceId as string };
}

export async function me(client: Client) {
  return (await call(client, "/api/me")).json;
}
