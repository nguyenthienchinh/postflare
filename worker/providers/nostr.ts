import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ProviderError } from "./errors";
import type { AccountRecord, MediaItem, Provider, ProviderContext, PublishPost } from "./types";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://relay.nostr.band", "wss://nostr.mom"];
const PUBLISH_TIMEOUT_MS = 8000;
const PROFILE_TIMEOUT_MS = 4000;

// ---------- bech32 (NIP-19) ----------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    acc = (acc << from) | data[i];
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max))) throw new Error("Invalid bech32 padding");
  return out;
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

export function bech32Decode(str: string): { hrp: string; bytes: Uint8Array } {
  const s = str.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new Error("Invalid bech32 string");
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const d = CHARSET.indexOf(c);
    if (d < 0) throw new Error("Invalid bech32 character");
    return d;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("Invalid bech32 checksum");
  return { hrp, bytes: new Uint8Array(convertBits(data.slice(0, -6), 5, 8, false)) };
}

// ---------- events (NIP-01) ----------

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export const serializeEvent = (e: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">) =>
  JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);

export const eventId = (e: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">) =>
  bytesToHex(sha256(new TextEncoder().encode(serializeEvent(e))));

export function signEvent(
  t: { kind: number; tags: string[][]; content: string; created_at?: number },
  secretKeyHex: string,
): NostrEvent {
  const sk = hexToBytes(secretKeyHex);
  const base = { pubkey: bytesToHex(schnorr.getPublicKey(sk)), created_at: t.created_at ?? Math.floor(Date.now() / 1000), kind: t.kind, tags: t.tags, content: t.content };
  const id = eventId(base);
  return { ...base, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}

export function parseSecretKey(input: string): string {
  const v = input.trim();
  let hex: string;
  if (v.startsWith("nsec1")) {
    const { hrp, bytes } = bech32Decode(v);
    if (hrp !== "nsec" || bytes.length !== 32) throw new ProviderError("Invalid nsec key", "invalid");
    hex = bytesToHex(bytes);
  } else if (/^[0-9a-fA-F]{64}$/.test(v)) hex = v.toLowerCase();
  else throw new ProviderError("Enter the private key as nsec1… or 64 hex characters", "invalid");
  try {
    schnorr.getPublicKey(hexToBytes(hex));
  } catch {
    throw new ProviderError("Invalid Nostr private key", "invalid");
  }
  return hex;
}

export const noteLink = (id: string) => `https://njump.me/${bech32Encode("note", hexToBytes(id))}`;

// ---------- relays ----------

type Socket = {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (e: any) => void): void;
};

/** Outbound WebSocket from a Worker: fetch with `Upgrade: websocket`, then accept the returned socket. */
async function openRelay(ctx: ProviderContext, url: string): Promise<Socket> {
  const res = await ctx.fetch(url.replace(/^ws(s?):\/\//i, "http$1://"), { headers: { upgrade: "websocket" } });
  const ws = (res as any).webSocket as Socket | null | undefined;
  if (!ws) throw new Error(`no WebSocket upgrade (HTTP ${res.status})`);
  ws.accept();
  return ws;
}

/** Sends a message and resolves with `onMessage`'s first non-undefined result, or rejects on timeout/close. */
async function relayExchange<T>(ctx: ProviderContext, url: string, send: unknown[], onMessage: (msg: any[]) => T | undefined, timeoutMs: number): Promise<T> {
  const ws = await openRelay(ctx, url);
  return new Promise<T>((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      try {
        ws.close(1000, "done");
      } catch {}
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("timeout"))), timeoutMs);
    ws.addEventListener("message", (e) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      const out = onMessage(msg);
      if (out !== undefined) done(() => resolve(out));
    });
    ws.addEventListener("close", () => done(() => reject(new Error("closed"))));
    ws.addEventListener("error", () => done(() => reject(new Error("socket error"))));
    ws.send(JSON.stringify(send));
  });
}

export async function publishToRelays(ctx: ProviderContext, relays: string[], event: NostrEvent, timeoutMs = PUBLISH_TIMEOUT_MS) {
  const results = await Promise.allSettled(
    relays.map((url) =>
      relayExchange(
        ctx,
        url,
        ["EVENT", event],
        (m) => (m[0] === "OK" && m[1] === event.id ? { ok: m[2] === true || String(m[3] ?? "").startsWith("duplicate:"), message: String(m[3] ?? "") } : undefined),
        timeoutMs,
      ),
    ),
  );
  const accepted: string[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.ok) accepted.push(relays[i]);
    else errors.push(`${relays[i]}: ${r.status === "fulfilled" ? r.value.message || "rejected" : (r.reason as Error).message}`);
  });
  return { accepted, errors };
}

async function fetchProfile(ctx: ProviderContext, relays: string[], pubkey: string): Promise<Record<string, any>> {
  const sub = `pf${Math.random().toString(36).slice(2, 10)}`;
  const events = await Promise.allSettled(
    relays.slice(0, 4).map((url) =>
      relayExchange<NostrEvent | null>(
        ctx,
        url,
        ["REQ", sub, { kinds: [0], authors: [pubkey], limit: 1 }],
        (m) => (m[0] === "EVENT" && m[1] === sub ? m[2] : m[0] === "EOSE" && m[1] === sub ? null : undefined),
        PROFILE_TIMEOUT_MS,
      ),
    ),
  );
  const latest = events
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((e): e is NostrEvent => !!e && e.pubkey === pubkey && e.kind === 0)
    .sort((a, b) => b.created_at - a.created_at)[0];
  try {
    return latest ? JSON.parse(latest.content) : {};
  } catch {
    return {};
  }
}

function parseRelays(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter((r) => /^wss?:\/\/[^\s]+$/i.test(r));
  return list.length ? [...new Set(list)] : DEFAULT_RELAYS;
}

// ---------- content ----------

function mediaTag(m: MediaItem): string[] {
  const tag = ["imeta", `url ${m.url}`, `m ${m.mime}`];
  if (m.width && m.height) tag.push(`dim ${m.width}x${m.height}`);
  if (m.alt) tag.push(`alt ${m.alt.replace(/\s+/g, " ")}`);
  return tag;
}

/**
 * Event timestamp derived from the post, so a retried publish signs the same event id and relays drop the copy
 * (that is why relay sends are not commits, docs/provider-brief.md "Commit semantics"). Replies (`${postId}-r${n}`)
 * add their index to keep the thread in order.
 */
export function noteCreatedAt(post: Pick<PublishPost, "id" | "scheduledAt" | "createdAt">): number {
  const base = Math.floor((post.scheduledAt ?? post.createdAt ?? Date.now()) / 1000);
  const reply = post.id.match(/-r(\d+)$/);
  return base + (reply ? Number(reply[1]) : 0);
}

export function noteTemplate(post: PublishPost): { kind: number; content: string; tags: string[][]; created_at: number } {
  const urls = post.media.map((m) => m.url);
  const content = [post.content?.trim(), ...urls].filter(Boolean).join("\n\n");
  const tags: string[][] = post.media.map(mediaTag);
  for (const m of (post.content ?? "").matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const t = m[1].toLowerCase();
    if (!tags.some((x) => x[0] === "t" && x[1] === t)) tags.push(["t", t]);
  }
  if (post.settings.contentWarning) tags.push(["content-warning", String(post.settings.contentWarning)]);
  return { kind: 1, content, tags, created_at: noteCreatedAt(post) };
}

/** Each relay is one WebSocket subrequest: cap them to stay within the Free plan budget (see budget.ts). */
const MAX_RELAYS = 20;

const relaysOf = (account: AccountRecord) => {
  const r = account.meta.relays;
  return (Array.isArray(r) && r.length ? (r as string[]) : DEFAULT_RELAYS).slice(0, MAX_RELAYS);
};

async function sendNote(ctx: ProviderContext, account: AccountRecord, template: { kind: number; content: string; tags: string[][]; created_at?: number }) {
  const sk = account.credentials.privateKey as string;
  if (!sk) throw new ProviderError("Nostr private key missing, reconnect the account", "auth");
  const relays = relaysOf(account);
  const event = signEvent(template, sk);
  const { accepted, errors } = await publishToRelays(ctx, relays, event);
  if (!accepted.length) throw new ProviderError(`No relay accepted the note: ${errors.join("; ")}`, "transient");
  if (errors.length) ctx.log("warn", `Some Nostr relays failed: ${errors.join("; ")}`);
  return { externalId: event.id, url: noteLink(event.id), data: { pubkey: event.pubkey, relay: accepted[0], relays: accepted } };
}

export const nostr: Provider = {
  hotlinksMedia: true,
  id: "nostr",
  name: "Nostr",
  color: "8E30EB",
  category: "social",
  auth: "credentials",
  appFields: [],
  setupNotes:
    "No developer app needed. Connect with your private key (`nsec1…` or hex). It is stored encrypted and used to sign notes inside your Worker; it is never sent anywhere. Consider a dedicated key for publishing.",
  credentialFields: [
    { key: "privateKey", label: "Private key", type: "password", required: true, placeholder: "nsec1…" },
    {
      key: "relays",
      label: "Relays",
      type: "textarea",
      default: DEFAULT_RELAYS.join("\n"),
      help: "One wss:// URL per line. The note succeeds when at least one relay accepts it.",
    },
  ],
  settingsFields: [{ key: "contentWarning", label: "Content warning", type: "text", help: "NIP-36 content-warning reason (optional)." }],
  capabilities: {
    maxLength: 64_000,
    text: "optional",
    media: { images: 10, videos: 4, mixed: true, required: false },
    thread: true,
    threadLabel: "Thread replies",
  },

  async connect(ctx, values) {
    const privateKey = parseSecretKey(values.privateKey);
    const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privateKey)));
    const relays = parseRelays(values.relays);
    const npub = bech32Encode("npub", hexToBytes(pubkey));
    const profile = await fetchProfile(ctx, relays, pubkey).catch(() => ({}) as Record<string, any>);
    return [
      {
        externalId: pubkey,
        name: profile.display_name || profile.displayName || profile.name || `${npub.slice(0, 12)}…`,
        username: profile.nip05 || profile.name || npub,
        avatarUrl: typeof profile.picture === "string" ? profile.picture : null,
        profileUrl: `https://njump.me/${npub}`,
        credentials: { privateKey },
        meta: { relays, npub },
      },
    ];
  },

  async publish(ctx, account, post) {
    return { status: "published", ...(await sendNote(ctx, account, noteTemplate(post))) };
  },

  async reply(ctx, account, target, post) {
    const t = noteTemplate(post);
    const pubkey = account.externalId;
    const hint = (d?: Record<string, unknown>) => (typeof d?.relay === "string" ? d.relay : "");
    // NIP-10 marked e tags: root always, reply only when answering something other than the root.
    t.tags.unshift(["e", target.rootId, hint(target.rootData), "root", pubkey]);
    if (target.parentId !== target.rootId) t.tags.splice(1, 0, ["e", target.parentId, hint(target.parentData), "reply", pubkey]);
    t.tags.push(["p", pubkey]);
    return sendNote(ctx, account, t);
  },
};
