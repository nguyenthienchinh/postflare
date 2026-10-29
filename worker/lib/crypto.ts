import { base64url, fromBase64url, randomToken } from "./util";
import { getSetting, setSetting } from "./settings";

const keyCache = new WeakMap<D1Database, Promise<CryptoKey>>();

async function rootSecret(env: Env): Promise<string> {
  if (env.SECRET_KEY) return env.SECRET_KEY;
  let stored = await getSetting(env.DB, "encryption_key");
  if (!stored) {
    stored = randomToken(32);
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('encryption_key', ?)").bind(stored).run();
    stored = (await getSetting(env.DB, "encryption_key"))!;
  }
  return stored;
}

function encryptionKey(env: Env): Promise<CryptoKey> {
  let key = keyCache.get(env.DB);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(await rootSecret(env)), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("postflare"), info: new TextEncoder().encode("aes") },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(env.DB, key);
    key.catch(() => keyCache.delete(env.DB));
  }
  return key;
}

export async function encryptJson(env: Env, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), data);
  return `v1.${base64url(iv)}.${base64url(ct)}`;
}

export async function decryptJson<T>(env: Env, blob: string): Promise<T> {
  const [version, iv, ct] = blob.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("Unsupported ciphertext");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv) },
    await encryptionKey(env),
    fromBase64url(ct),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

const hmacCache = new WeakMap<D1Database, Promise<CryptoKey>>();

/** Media link signing key: read from D1 and imported once per isolate (like the AES key), not once per `sign()`. */
function hmacKey(env: Env): Promise<CryptoKey> {
  let key = hmacCache.get(env.DB);
  if (!key) {
    key = (async () => {
      let secret = await getSetting(env.DB, "signing_key");
      if (!secret) {
        await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('signing_key', ?)").bind(randomToken(32)).run();
        secret = (await getSetting(env.DB, "signing_key"))!;
      }
      return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    hmacCache.set(env.DB, key);
    key.catch(() => hmacCache.delete(env.DB));
  }
  return key;
}

/** Short HMAC signature, used for public media links. */
export async function sign(env: Env, value: string, length = 22): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(value));
  return base64url(sig).slice(0, length);
}

export async function verifySignature(env: Env, value: string, signature: string): Promise<boolean> {
  const expected = await sign(env, value, signature.length);
  if (expected.length !== signature.length || signature.length < 16) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// Measured on Workers: 100k iterations cost ~22ms CPU, over the Free plan's 10ms budget. 20k (~4-5ms) fits;
// brute force is limited by the persistent login throttle in routes/auth.ts instead.
const PBKDF2_ITERATIONS = 20_000;

/** True when a stored hash uses different parameters than new hashes (rehash it after a successful login). */
export function needsRehash(stored: string): boolean {
  const [scheme, iter] = stored.split("$");
  return scheme !== "pbkdf2" || Number(iter) !== PBKDF2_ITERATIONS;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const bits = base64url(await pbkdf2(password, fromBase64url(salt), Number(iter)));
  if (bits.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export { setSetting };

/** PEM (or bare base64) PKCS#8 private key → bytes. */
export function pemToBytes(pem: string): Uint8Array {
  return fromBase64url(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

const signingKeys = new Map<string, Promise<CryptoKey>>();

/** ES256 JWT signed with an Apple .p8 key (APNs token auth). The imported key is cached per isolate. */
export async function es256Jwt(pem: string, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  let key = signingKeys.get(pem);
  if (!key) {
    key = crypto.subtle.importKey("pkcs8", pemToBytes(pem) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    key.catch(() => signingKeys.delete(pem));
    signingKeys.set(pem, key);
  }
  const head = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", ...header }));
  const body = base64url(JSON.stringify(payload));
  // Web Crypto signs ECDSA as raw r || s (IEEE P1363), which is exactly the JWS ES256 signature format.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(sig)}`;
}
