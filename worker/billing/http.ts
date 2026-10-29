// Provider API calls and webhook signature helpers: global fetch with a timeout, Web Crypto HMAC only (no SDKs).
// Signatures are compared with crypto.subtle.verify (constant time), never with string equality.

import { ProviderApiError } from "./types";

const TIMEOUT_MS = 10_000;

/** JSON request to a provider API. Throws ProviderApiError with the provider's message on non-2xx answers. */
export async function providerJson<T = any>(
  provider: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderApiError(`${provider} did not answer: ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ProviderApiError(`${provider} API error ${res.status}: ${errorText(data) ?? text.slice(0, 200)}`);
  return data as T;
}

/** The message of the usual error shapes (Stripe `error.message`, Polar `detail`, JSON:API `errors[].detail`). */
function errorText(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  if (typeof data.error?.message === "string") return data.error.message;
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail)) return data.detail.map((d: any) => d?.msg ?? JSON.stringify(d)).join("; ");
  if (Array.isArray(data.errors)) return data.errors.map((e: any) => e?.detail ?? e?.title ?? JSON.stringify(e)).join("; ");
  if (typeof data.message === "string") return data.message;
  if (typeof data.error === "string") return data.error;
  return null;
}

/** application/x-www-form-urlencoded body with Stripe's nested keys (`a[b][c]=v`). */
export function formBody(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.toString();
}

const enc = new TextEncoder();

export const hmacKey = (raw: Uint8Array | string) =>
  crypto.subtle.importKey("raw", typeof raw === "string" ? enc.encode(raw) : raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** Constant-time HMAC-SHA256 check of `signature` (raw bytes) over `message`. */
export async function hmacVerify(key: CryptoKey, signature: Uint8Array, message: string): Promise<boolean> {
  if (signature.length !== 32) return false;
  return crypto.subtle.verify("HMAC", key, signature, enc.encode(message));
}

export async function hmacSign(key: CryptoKey, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Hex → bytes (empty array for malformed input, which then fails verification). */
export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Standard base64 → bytes (empty array for malformed input). */
export function fromBase64(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** ISO date or epoch seconds → ms (undefined when absent or invalid). */
export function toMs(v: unknown, unit: "iso" | "seconds" = "iso"): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = unit === "seconds" ? Number(v) * 1000 : Date.parse(String(v));
  return Number.isFinite(n) ? n : undefined;
}

/** Webhook timestamps older or newer than this are refused (replays). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
