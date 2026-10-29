import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  bech32Decode,
  bech32Encode,
  eventId,
  noteLink,
  noteTemplate,
  nostr,
  parseSecretKey,
  publishToRelays,
  serializeEvent,
  signEvent,
} from "../../worker/providers/nostr";
import { image, testAccount, testContext } from "../helpers";

const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const NSEC_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";
const NPUB_HEX = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
// BIP-340 test vector 1: secret key 3.
const SK3 = "0000000000000000000000000000000000000000000000000000000000000003";
const PK3 = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

type Relay = (msg: any[], reply: (m: unknown[]) => void) => void;

/** Fake Worker outbound WebSockets: fetch(..., {Upgrade}) returns a Response carrying `webSocket`. */
function relayFetch(relays: Record<string, Relay>) {
  const sent: Array<{ url: string; msg: any[] }> = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = relays[url];
    expect(new Headers(init?.headers).get("upgrade")).toBe("websocket");
    if (!handler) return new Response("nope", { status: 502 });
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const emit = (type: string, e: any) => (listeners[type] ?? []).forEach((fn) => fn(e));
    const ws = {
      accept() {},
      close() {},
      addEventListener(type: string, fn: (e: any) => void) {
        (listeners[type] ??= []).push(fn);
      },
      send(data: string) {
        const msg = JSON.parse(data);
        sent.push({ url, msg });
        queueMicrotask(() => handler(msg, (m) => emit("message", { data: JSON.stringify(m) })));
      },
    };
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, "webSocket", { value: ws });
    return res;
  };
  return { fetch: fetchFn as typeof fetch, sent };
}

const acceptAll: Relay = (msg, reply) => msg[0] === "EVENT" && reply(["OK", msg[1].id, true, ""]);
const account = () =>
  testAccount({
    provider: "nostr",
    externalId: PK3,
    credentials: { privateKey: SK3 },
    meta: { relays: ["wss://r1.example", "wss://r2.example"] },
  });
const post = (over: any = {}) => ({ id: "p1", content: "gm #Nostr", media: [], settings: {}, ...over });

describe("nostr crypto", () => {
  it("decodes and encodes NIP-19 keys", () => {
    expect(parseSecretKey(NSEC)).toBe(NSEC_HEX);
    expect(parseSecretKey(NSEC_HEX.toUpperCase())).toBe(NSEC_HEX);
    expect(bech32Encode("nsec", hexToBytes(NSEC_HEX))).toBe(NSEC);
    const d = bech32Decode(NPUB);
    expect(d.hrp).toBe("npub");
    expect(Buffer.from(d.bytes).toString("hex")).toBe(NPUB_HEX);
    expect(bech32Encode("npub", hexToBytes(NPUB_HEX))).toBe(NPUB);
    expect(() => bech32Decode(NPUB.slice(0, -1) + "q")).toThrow(/checksum/);
    expect(() => parseSecretKey("nope")).toThrow();
  });

  it("serializes per NIP-01 and hashes to the event id", () => {
    const e = { pubkey: PK3, created_at: 1700000000, kind: 1, tags: [["t", "nostr"]], content: 'hi\n"x"\\ é' };
    const expected = `[0,"${PK3}",1700000000,1,[["t","nostr"]],"hi\\n\\"x\\"\\\\ é"]`;
    expect(serializeEvent(e)).toBe(expected);
    expect(eventId(e)).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
  });

  it("signs with BIP-340 schnorr", () => {
    const ev = signEvent({ kind: 1, tags: [], content: "hello", created_at: 1700000000 }, SK3);
    expect(ev.pubkey).toBe(PK3);
    expect(ev.id).toBe(eventId(ev));
    expect(ev.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(PK3))).toBe(true);
  });

  it("encodes note links", () => {
    const id = "0".repeat(63) + "1";
    const link = noteLink(id);
    expect(link).toMatch(/^https:\/\/njump\.me\/note1[02-9ac-hj-np-z]{58}$/);
    expect(Buffer.from(bech32Decode(link.split("/").pop()!).bytes).toString("hex")).toBe(id);
  });
});

describe("nostr connect", () => {
  it("derives the pubkey and loads the kind 0 profile", async () => {
    const meta = signEvent({ kind: 0, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice", picture: "https://p/a.png" }) }, NSEC_HEX);
    const { fetch, sent } = relayFetch({
      "https://r1.example": (msg, reply) => {
        reply(["EVENT", msg[1], meta]);
        reply(["EOSE", msg[1]]);
      },
      "https://r2.example": (msg, reply) => reply(["EOSE", msg[1]]),
    });
    const [acc] = await nostr.connect!(testContext(fetch), { privateKey: NSEC, relays: "wss://r1.example\nwss://r2.example, junk" });
    expect(sent[0].msg[0]).toBe("REQ");
    expect(sent[0].msg[2]).toEqual({ kinds: [0], authors: [meta.pubkey], limit: 1 });
    expect(acc).toMatchObject({
      externalId: meta.pubkey,
      name: "Alice",
      username: "alice",
      avatarUrl: "https://p/a.png",
      credentials: { privateKey: NSEC_HEX },
      meta: { relays: ["wss://r1.example", "wss://r2.example"] },
    });
  });

  it("still connects when relays are unreachable", async () => {
    const { fetch } = relayFetch({});
    const [acc] = await nostr.connect!(testContext(fetch), { privateKey: SK3, relays: "wss://down.example" });
    expect(acc.externalId).toBe(PK3);
    expect(acc.name).toMatch(/^npub1/);
  });
});

describe("nostr publish", () => {
  it("signs a kind 1 note, publishes it and returns a njump link", async () => {
    const { fetch, sent } = relayFetch({
      "https://r1.example": acceptAll,
      "https://r2.example": (msg, reply) => reply(["OK", msg[1].id, false, "blocked: no"]),
    });
    const ctx = testContext(fetch);
    const res = await nostr.publish(ctx, account(), post());
    const ev = sent[0].msg[1];
    expect(sent[0].msg[0]).toBe("EVENT");
    expect(ev.kind).toBe(1);
    expect(ev.content).toBe("gm #Nostr");
    expect(ev.tags).toEqual([["t", "nostr"]]);
    expect(schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(PK3))).toBe(true);
    expect(res).toEqual({ status: "published", externalId: ev.id, url: noteLink(ev.id), data: { pubkey: PK3, relay: "wss://r1.example", relays: ["wss://r1.example"] } });
    expect(ctx.logs.some((l) => l.includes("blocked"))).toBe(true);
  });

  it("appends media URLs with NIP-92 imeta tags", () => {
    const t = noteTemplate(post({ content: "look", media: [image()], settings: { contentWarning: "spoilers" } }));
    expect(t.content).toBe(`look\n\n${image().url}`);
    expect(t.tags).toEqual([
      ["imeta", `url ${image().url}`, "m image/jpeg", "dim 1080x1080", "alt alt text"],
      ["content-warning", "spoilers"],
    ]);
  });

  it("fails transiently when no relay accepts", async () => {
    const { fetch } = relayFetch({ "https://r1.example": (msg, reply) => reply(["OK", msg[1].id, false, "error: x"]) });
    await expect(nostr.publish(testContext(fetch), account(), post())).rejects.toMatchObject({ kind: "transient" });
  });

  it("times out silent relays", async () => {
    const { fetch } = relayFetch({ "https://r1.example": () => {} });
    const ev = signEvent({ kind: 1, tags: [], content: "x" }, SK3);
    const r = await publishToRelays(testContext(fetch), ["wss://r1.example"], ev, 50);
    expect(r.accepted).toEqual([]);
    expect(r.errors[0]).toMatch(/timeout/);
  });

  it("replies with NIP-10 root/reply markers", async () => {
    const { fetch, sent } = relayFetch({ "https://r1.example": acceptAll, "https://r2.example": acceptAll });
    const root = "a".repeat(64);
    const parent = "b".repeat(64);
    await nostr.reply!(testContext(fetch), account(), { rootId: root, parentId: parent, rootData: { relay: "wss://r1.example" } }, post({ content: "more" }));
    expect(sent[0].msg[1].tags).toEqual([
      ["e", root, "wss://r1.example", "root", PK3],
      ["e", parent, "", "reply", PK3],
      ["p", PK3],
    ]);
    await nostr.reply!(testContext(fetch), account(), { rootId: root, parentId: root }, post({ content: "first" }));
    expect(sent[2].msg[1].tags).toEqual([
      ["e", root, "", "root", PK3],
      ["p", PK3],
    ]);
  });

  it("maps a missing key to auth", async () => {
    const { fetch } = relayFetch({});
    await expect(nostr.publish(testContext(fetch), testAccount({ credentials: {} }), post())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("nostr deterministic events", () => {
  const scheduled = Date.UTC(2026, 9, 1, 12, 0, 0);

  it("signs the same event id for the same post across publish calls", async () => {
    const p = post({ scheduledAt: scheduled, createdAt: scheduled - 86_400_000 });
    const one = relayFetch({ "https://r1.example": acceptAll });
    const two = relayFetch({ "https://r1.example": acceptAll });
    const a = await nostr.publish(testContext(one.fetch), account(), p);
    const b = await nostr.publish(testContext(two.fetch), account(), p);
    expect(a.status === "published" && b.status === "published" && a.externalId === b.externalId).toBe(true);
    expect(one.sent[0].msg[1].created_at).toBe(scheduled / 1000);
  });

  it("orders replies after the root and accepts a relay's duplicate answer", async () => {
    expect(noteTemplate(post({ id: "p1-r2", scheduledAt: scheduled })).created_at).toBe(scheduled / 1000 + 2);
    const { fetch } = relayFetch({ "https://r1.example": (msg, reply) => reply(["OK", msg[1].id, false, "duplicate: already have this event"]) });
    await expect(nostr.publish(testContext(fetch), account(), post({ scheduledAt: scheduled }))).resolves.toMatchObject({ status: "published" });
  });
});
