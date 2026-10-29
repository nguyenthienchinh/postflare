import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../worker/index";
import { ORIGIN, sessionCookie } from "./helpers";

// Helpers of the iOS app tests (devices, push, app-login): requests against an own env (own D1), with a session
// cookie, an iOS device token (Bearer pfd_...) or nothing.

export interface AppClient {
  cookie?: string;
  /** Device token (Bearer). */
  token?: string;
  /** X-Workspace-Id */
  ws?: string;
}

export interface AppCallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** request.cf (city / country of the browser). */
  cf?: Record<string, string>;
}

export function makeCall(env: Env) {
  return async function call(client: AppClient | null, path: string, opts: AppCallOptions = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (client?.cookie) headers.cookie = client.cookie;
    if (client?.token) headers.authorization = `Bearer ${client.token}`;
    if (client?.ws && !headers["x-workspace-id"]) headers["x-workspace-id"] = client.ws;
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const ctx = createExecutionContext();
    const req = new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, ...(opts.cf ? { cf: opts.cf } : {}) } as RequestInit);
    const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
    await waitOnExecutionContext(ctx);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers, cookie: sessionCookie(res.headers) };
  };
}

/** A P-256 key pair: the private key as a .p8-style PEM (APNS_PRIVATE_KEY) and the public key to verify JWTs. */
export async function apnsKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`, publicKey: pair.publicKey };
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));

/** Decodes a JWT and verifies its ES256 signature with `publicKey`. */
export async function verifyJwt(jwt: string, publicKey: CryptoKey) {
  const [h, p, s] = jwt.split(".");
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  return { header: JSON.parse(new TextDecoder().decode(b64url(h))), payload: JSON.parse(new TextDecoder().decode(b64url(p))), valid };
}

/** An APNs device token (64 hex characters). */
export const apnsToken = (n: number) => n.toString(16).padStart(8, "0").repeat(8);
