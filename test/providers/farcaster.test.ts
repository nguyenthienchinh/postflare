import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { custodyKey, ethAddress, ethSign, farcaster, signedKeyRequestDigest } from "../../worker/providers/farcaster";
import { image, json, mockFetch, testAccount, testContext } from "../helpers";

// Well-known Hardhat/Anvil dev mnemonic -> account #0.
const MNEMONIC = "test test test test test test test test test test test junk";
const KEY0 = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const app = { apiKey: "NK", appFid: "1234", appMnemonic: MNEMONIC, sponsor: "true" };
const account = () => testAccount({ provider: "farcaster", externalId: "42", username: "alice", credentials: { signerUuid: "sig-1" }, meta: { fid: 42 } });
const post = (over: any = {}) => ({ id: "p1", content: "gm", media: [], settings: {}, ...over });

describe("farcaster keys", () => {
  it("derives the custody key from a BIP-39 mnemonic", async () => {
    const k = await custodyKey(MNEMONIC);
    expect(bytesToHex(k)).toBe(KEY0);
    expect(ethAddress(k)).toBe(ADDR0);
    expect(bytesToHex(await custodyKey(`0x${KEY0}`))).toBe(KEY0);
  });

  it("signs the EIP-712 SignedKeyRequest so the custody address is recoverable", () => {
    const digest = signedKeyRequestDigest(1234, `0x${"ab".repeat(32)}`, 1_700_000_000);
    const sig = ethSign(digest, hexToBytes(KEY0));
    expect(sig).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/);
    const bytes = hexToBytes(sig.slice(2));
    const recovered = new Uint8Array([bytes[64] - 27, ...bytes.slice(0, 64)]);
    const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false).slice(1);
    expect(`0x${bytesToHex(keccak_256(uncompressed).slice(-20))}`).toBe(ADDR0);
  });
});

describe("farcaster connect", () => {
  it("creates and registers a managed signer, returning the approval link", async () => {
    const { fetch, requests } = mockFetch([
      ["POST https://api.neynar.com/v2/farcaster/signer/signed_key/", () => ({ signer_uuid: "sig-1", status: "pending_approval", signer_approval_url: "https://client.farcaster.xyz/deeplinks/signed-key-request?token=0x1" })],
      ["POST https://api.neynar.com/v2/farcaster/signer/", () => ({ signer_uuid: "sig-1", public_key: `0x${"cd".repeat(32)}`, status: "generated" })],
    ]);
    const err = await farcaster.connect!(testContext(fetch, app), { signerUuid: "" }).catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(err.message).toContain("https://client.farcaster.xyz/deeplinks/signed-key-request?token=0x1");
    expect(err.message).toContain("sig-1");
    expect(requests[0].headers["x-api-key"]).toBe("NK");
    const reg = requests[1].json;
    expect(reg).toMatchObject({ signer_uuid: "sig-1", app_fid: 1234, sponsor: { sponsored_by_neynar: true } });
    expect(reg.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(reg.deadline).toBeGreaterThan(Date.now() / 1000);
  });

  it("connects an approved signer", async () => {
    const { fetch } = mockFetch([
      ["GET https://api.neynar.com/v2/farcaster/signer?signer_uuid=sig-1", () => ({ signer_uuid: "sig-1", status: "approved", fid: 42 })],
      ["GET https://api.neynar.com/v2/farcaster/user/bulk?fids=42", () => ({ users: [{ fid: 42, username: "alice", display_name: "Alice", pfp_url: "https://p" }] })],
    ]);
    const [acc] = await farcaster.connect!(testContext(fetch, app), { signerUuid: " sig-1 " });
    expect(acc).toMatchObject({ externalId: "42", name: "Alice", username: "alice", avatarUrl: "https://p", credentials: { signerUuid: "sig-1" } });
  });

  it("refuses a signer that is not approved yet", async () => {
    const { fetch } = mockFetch([[/\/signer\?/, () => ({ status: "pending_approval", signer_approval_url: "https://approve" })]]);
    await expect(farcaster.connect!(testContext(fetch, app), { signerUuid: "sig-1" })).rejects.toThrow(/pending approval.*https:\/\/approve/);
  });

  it("requires the app configuration", async () => {
    await expect(farcaster.connect!(testContext(fetch, {}), {})).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("farcaster publish", () => {
  it("casts with embeds, a channel and an idempotency key", async () => {
    const { fetch, requests } = mockFetch([["POST https://api.neynar.com/v2/farcaster/cast/", () => ({ success: true, cast: { hash: "0xabc", author: { fid: 42 } } })]]);
    const res = await farcaster.publish(testContext(fetch, app), account(), post({ media: [image(), image({ url: "https://x/2.jpg" })], settings: { channel: "dev" } }));
    expect(res).toEqual({ status: "published", externalId: "0xabc", url: "https://farcaster.xyz/alice/0xabc", data: { hash: "0xabc" } });
    const body = requests[0].json;
    expect(body).toMatchObject({ signer_uuid: "sig-1", text: "gm", channel_id: "dev", embeds: [{ url: image().url }, { url: "https://x/2.jpg" }] });
    expect(body.idem).toMatch(/^[0-9a-f]{16}$/);
  });

  it("lists channels", async () => {
    const { fetch } = mockFetch([[/user\/channels\?fid=42/, () => ({ channels: [{ id: "dev", name: "Dev" }] })]]);
    expect(await farcaster.options!(testContext(fetch, app), account(), "channel", {})).toEqual([
      { value: "", label: "No channel (home feed)" },
      { value: "dev", label: "Dev (/dev)" },
    ]);
  });

  it("replies to the parent hash", async () => {
    const { fetch, requests } = mockFetch([[/cast\//, () => ({ success: true, cast: { hash: "0xdef" } })]]);
    const r = await farcaster.reply!(testContext(fetch, app), account(), { rootId: "0xabc", parentId: "0xb2" }, post({ id: "p1-r2", content: "more" }));
    expect(r.externalId).toBe("0xdef");
    expect(requests[0].json).toMatchObject({ parent: "0xb2", parent_author_fid: 42, text: "more" });
    expect(requests[0].json.channel_id).toBeUndefined();
  });

  it("maps 401 and revoked signers to auth", async () => {
    const { fetch } = mockFetch([[/cast\//, () => json({ message: "Unauthorized" }, 401)]]);
    await expect(farcaster.publish(testContext(fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const { fetch: f2 } = mockFetch([[/cast\//, () => json({ message: "Signer is not approved" }, 403)]]);
    await expect(farcaster.publish(testContext(f2, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
  });

  it("validates bytes", () => {
    expect(farcaster.validate!(post({ content: "é".repeat(513) }))).toHaveLength(1);
  });
});
