import { describe, expect, it } from "vitest";
import { verifySignedRequest } from "../worker/lib/meta-deletion";
import { base64url } from "../worker/lib/util";

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

const encode = (payload: unknown) => base64url(JSON.stringify(payload));

describe("verifySignedRequest", () => {
  const body = encode({ algorithm: "HMAC-SHA256", user_id: 1234567890, issued_at: 1700000000, expires: 0 });

  it("accepts a request signed with any of the secrets and reports which", async () => {
    const signed = `${await sign("b", body)}.${body}`;
    const res = await verifySignedRequest(signed, ["a", "b", "", "b"]);
    expect(res?.matched).toEqual([1, 3]);
    expect(res?.payload).toMatchObject({ user_id: "1234567890", issued_at: 1700000000 });
  });

  it("rejects wrong secrets, tampering and malformed input", async () => {
    const sig = await sign("a", body);
    expect(await verifySignedRequest(`${sig}.${body}`, ["x"])).toBeNull();
    expect(await verifySignedRequest(`${sig}.${encode({ algorithm: "HMAC-SHA256", user_id: "999" })}`, ["a"])).toBeNull();
    expect(await verifySignedRequest(`${sig}.${body}.extra`, ["a"])).toBeNull();
    expect(await verifySignedRequest(body, ["a"])).toBeNull();
    expect(await verifySignedRequest("", ["a"])).toBeNull();
    expect(await verifySignedRequest(`${sig}.!!!`, ["a"])).toBeNull();
    // Unsupported algorithm or no user id, even when correctly signed.
    for (const p of [{ algorithm: "HMAC-SHA1", user_id: "1" }, { algorithm: "HMAC-SHA256" }]) {
      const b = encode(p);
      expect(await verifySignedRequest(`${await sign("a", b)}.${b}`, ["a"])).toBeNull();
    }
  });
});
