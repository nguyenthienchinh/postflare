import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ProviderError } from "./errors";
import { requestJson, requireApp, type RequestOptions } from "./http";
import type { AccountRecord, Provider, ProviderContext, PublishPost } from "./types";

const API = "https://api.neynar.com/v2/farcaster";
const MAX_BYTES = 1024;

// ---------- app custody key: BIP-39 mnemonic -> m/44'/60'/0'/0/0 ----------

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const toBig = (b: Uint8Array) => BigInt(`0x${bytesToHex(b) || "0"}`);
const to32 = (n: bigint) => hexToBytes(n.toString(16).padStart(64, "0"));
const ser32 = (i: number) => new Uint8Array([(i >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]);

async function mnemonicSeed(mnemonic: string): Promise<Uint8Array> {
  const words = mnemonic.normalize("NFKD").trim().split(/\s+/).join(" ");
  const key = await crypto.subtle.importKey("raw", utf8ToBytes(words), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: utf8ToBytes("mnemonic"), iterations: 2048 }, key, 512);
  return new Uint8Array(bits);
}

function derivePath(seed: Uint8Array, path: number[]): Uint8Array {
  let I = hmac(sha512, utf8ToBytes("Bitcoin seed"), seed);
  let k = I.slice(0, 32);
  let c = I.slice(32);
  for (const index of path) {
    const data = index >= 0x80000000 ? concatBytes(new Uint8Array([0]), k, ser32(index)) : concatBytes(secp256k1.getPublicKey(k, true), ser32(index));
    I = hmac(sha512, c, data);
    k = to32((toBig(I.slice(0, 32)) + toBig(k)) % N);
    c = I.slice(32);
  }
  return k;
}

/** Private key of the app's custody address from a recovery phrase (or a 0x hex private key). */
export async function custodyKey(secret: string): Promise<Uint8Array> {
  const s = secret.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return hexToBytes(s.replace(/^0x/, ""));
  const words = s.split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) throw new ProviderError("App mnemonic must be 12-24 words or a 0x private key", "invalid");
  const H = 0x80000000;
  return derivePath(await mnemonicSeed(s), [44 + H, 60 + H, 0 + H, 0, 0]);
}

export function ethAddress(privateKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privateKey, false).slice(1);
  return `0x${bytesToHex(keccak_256(pub).slice(-20))}`;
}

// ---------- EIP-712 SignedKeyRequest ----------

const kHash = (s: string) => keccak_256(utf8ToBytes(s));

export function signedKeyRequestDigest(appFid: number, publicKeyHex: string, deadline: number): Uint8Array {
  const domain = keccak_256(
    concatBytes(
      kHash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      kHash("Farcaster SignedKeyRequestValidator"),
      kHash("1"),
      to32(10n),
      to32(BigInt("0x00000000fc700472606ed4fa22623acf62c60553")),
    ),
  );
  const struct = keccak_256(
    concatBytes(
      kHash("SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline)"),
      to32(BigInt(appFid)),
      keccak_256(hexToBytes(publicKeyHex.replace(/^0x/, ""))),
      to32(BigInt(deadline)),
    ),
  );
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domain, struct));
}

/** 65-byte Ethereum signature r || s || v. */
export function ethSign(digest: Uint8Array, privateKey: Uint8Array): string {
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" });
  return `0x${bytesToHex(sig.slice(1))}${(27 + sig[0]).toString(16)}`;
}

// ---------- Neynar ----------

function neynar<T = any>(ctx: ProviderContext, path: string, opts: RequestOptions = {}) {
  const { apiKey } = requireApp(ctx, "Farcaster", "apiKey");
  return requestJson<T>(ctx, `${API}${path}`, {
    ...opts,
    headers: { "x-api-key": apiKey, accept: "application/json", ...(opts.headers as Record<string, string>) },
    // A revoked/unknown signer is an account problem, not a content one.
    classify: (status, body) => (/signer/i.test(String(body?.message ?? "")) && [400, 403, 404].includes(status) ? "auth" : undefined),
  });
}

async function idem(postId: string) {
  const d = await crypto.subtle.digest("SHA-256", utf8ToBytes(postId));
  return bytesToHex(new Uint8Array(d)).slice(0, 16);
}

/**
 * Not marked `commit: true`: Neynar deduplicates casts by `idem` (derived from our post id), so a failed call may be
 * retried without double-posting (docs/provider-brief.md "Commit semantics").
 */
async function cast(ctx: ProviderContext, account: AccountRecord, post: PublishPost, extra: Record<string, unknown>) {
  const signer = account.credentials.signerUuid as string;
  if (!signer) throw new ProviderError("Farcaster signer missing, reconnect the account", "auth");
  const embeds = post.media.slice(0, 2).map((m) => ({ url: m.url }));
  const res = await neynar<{ cast: { hash: string } }>(ctx, "/cast/", {
    method: "POST",
    json: { signer_uuid: signer, text: post.content ?? "", ...(embeds.length ? { embeds } : {}), idem: await idem(post.id), ...extra },
  });
  const hash = res.cast.hash;
  return { externalId: hash, url: `https://farcaster.xyz/${account.username}/${hash}`, data: { hash } };
}

export const farcaster: Provider = {
  hotlinksMedia: true,
  id: "farcaster",
  name: "Farcaster",
  color: "855DCD",
  icon: "farcaster",
  category: "social",
  auth: "credentials",
  appFields: [
    { key: "apiKey", label: "Neynar API key", type: "password", required: true },
    { key: "appFid", label: "App FID", type: "text", required: true, help: "FID of the Farcaster account that represents your app." },
    {
      key: "appMnemonic",
      label: "App custody recovery phrase",
      type: "password",
      required: true,
      help: "Recovery phrase (or 0x private key) of the app account's custody address. Used only to sign signer requests.",
    },
    { key: "sponsor", label: "Let Neynar sponsor signers (billed in Neynar credits)", type: "checkbox" },
  ],
  docsUrl: "https://dev.neynar.com",
  setupNotes: [
    "Posting uses **Neynar managed signers** (Sign in with Neynar was retired).",
    "1. Create an app at [dev.neynar.com](https://dev.neynar.com) and copy the **API key**.",
    "2. Pick a Farcaster account to represent the app: enter its **FID** and the **recovery phrase** of its custody address.",
    "3. Connect an account: the first attempt returns an approval link (open it on the phone with the Farcaster app). After approving, connect again with the shown **Signer UUID**.",
  ].join("\n"),
  credentialFields: [
    {
      key: "signerUuid",
      label: "Signer UUID",
      type: "text",
      help: "Leave empty the first time: you will get an approval link and a signer UUID to paste here after approving.",
    },
  ],
  settingsFields: [
    { key: "channel", label: "Channel", type: "select", dynamicOptions: true, help: "Channels you are active in." },
    { key: "channelId", label: "…or channel id", type: "text", placeholder: "neynar", help: "Overrides the list above." },
  ],
  capabilities: {
    maxLength: MAX_BYTES,
    text: "optional",
    media: { images: 2, videos: 0, mixed: false, required: false },
    thread: true,
    threadLabel: "Thread replies",
  },

  validate(post) {
    return new TextEncoder().encode(post.content ?? "").length > MAX_BYTES ? [`Farcaster casts are limited to ${MAX_BYTES} bytes`] : [];
  },

  async connect(ctx, values) {
    const app = requireApp(ctx, "Farcaster", "apiKey", "appFid", "appMnemonic");
    const existing = values.signerUuid?.trim();
    if (!existing) {
      const signer = await neynar<{ signer_uuid: string; public_key: string }>(ctx, "/signer/", { method: "POST" });
      const deadline = Math.floor(Date.now() / 1000) + 24 * 3600;
      const appFid = Number(app.appFid);
      if (!Number.isInteger(appFid) || appFid <= 0) throw new ProviderError("App FID must be a number", "invalid");
      const signature = ethSign(signedKeyRequestDigest(appFid, signer.public_key, deadline), await custodyKey(app.appMnemonic));
      const reg = await neynar<{ signer_approval_url?: string; approval_url?: string }>(ctx, "/signer/signed_key/", {
        method: "POST",
        json: {
          signer_uuid: signer.signer_uuid,
          app_fid: appFid,
          deadline,
          signature,
          ...(app.sponsor === "true" ? { sponsor: { sponsored_by_neynar: true } } : {}),
        },
      });
      const url = reg.signer_approval_url ?? reg.approval_url;
      // The contract has no "pending connect" step: hand the approval link back through the error message.
      throw new ProviderError(
        `Approve the signer in the Farcaster app: ${url}  — then connect again with Signer UUID ${signer.signer_uuid}`,
        "invalid",
      );
    }
    const signer = await neynar<{ status: string; fid?: number; signer_approval_url?: string }>(ctx, "/signer", { query: { signer_uuid: existing } });
    if (signer.status !== "approved" || !signer.fid) {
      const hint = signer.signer_approval_url ? `: ${signer.signer_approval_url}` : "";
      throw new ProviderError(`Signer is ${signer.status.replace(/_/g, " ")}; approve it in the Farcaster app first${hint}`, "invalid");
    }
    const { users } = await neynar<{ users: any[] }>(ctx, "/user/bulk", { query: { fids: signer.fid } });
    const u = users?.[0] ?? {};
    return [
      {
        externalId: String(signer.fid),
        name: u.display_name || u.username || `fid ${signer.fid}`,
        username: u.username ?? String(signer.fid),
        avatarUrl: u.pfp_url ?? null,
        profileUrl: u.username ? `https://farcaster.xyz/${u.username}` : null,
        credentials: { signerUuid: existing },
        meta: { fid: signer.fid },
      },
    ];
  },

  async options(ctx, account, key) {
    if (key !== "channel") return [];
    const res = await neynar<{ channels: any[] }>(ctx, "/user/channels", { query: { fid: account.externalId, limit: 100 } });
    return [{ value: "", label: "No channel (home feed)" }, ...(res?.channels ?? []).map((c) => ({ value: c.id, label: c.name ? `${c.name} (/${c.id})` : `/${c.id}` }))];
  },

  async publish(ctx, account, post) {
    const channel = String(post.settings.channelId || post.settings.channel || "").trim().replace(/^\//, "");
    return { status: "published", ...(await cast(ctx, account, post, channel ? { channel_id: channel } : {})) };
  },

  async reply(ctx, account, target, post) {
    return cast(ctx, account, post, { parent: target.parentId, parent_author_fid: Number(account.externalId) });
  },
};
