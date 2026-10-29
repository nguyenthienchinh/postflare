import { describe, expect, it } from "vitest";
import { webhook } from "../../worker/providers/webhook";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const HOOK = "https://hooks.example.com/abc";
const account = (secret?: string) => testAccount({ provider: "webhook", externalId: HOOK, credentials: { url: HOOK, secret } });

describe("webhook", () => {
  it("connects an https URL", async () => {
    const [acc] = await webhook.connect!(testContext(mockFetch([]).fetch), { name: "Zap", url: HOOK, secret: "s3" });
    expect(acc).toMatchObject({ externalId: HOOK, name: "Zap", username: "hooks.example.com", credentials: { url: HOOK, secret: "s3" } });
  });

  it("rejects non-https and malformed URLs", async () => {
    const ctx = testContext(mockFetch([]).fetch);
    await expect(webhook.connect!(ctx, { name: "x", url: "http://hooks.example.com" })).rejects.toMatchObject({ kind: "invalid" });
    await expect(webhook.connect!(ctx, { name: "x", url: "not a url" })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("posts text and media as JSON with secret and idempotency key", async () => {
    const m = mockFetch([[`POST ${HOOK}`, () => ({ id: "ext1", url: "https://example.com/p/1" })]]);
    const res = await webhook.publish(testContext(m.fetch), account("s3"), {
      id: "p1",
      content: "Hello",
      media: [image(), video()],
      settings: {},
    });
    const req = m.requests[0];
    expect(req.headers["x-postflare-secret"]).toBe("s3");
    expect(req.headers["idempotency-key"]).toBe("p1");
    expect(req.json).toEqual({
      id: "p1",
      content: "Hello",
      settings: {},
      media: [
        { url: image().url, type: "image", mime: "image/jpeg", filename: "photo.jpg", alt: "alt text" },
        { url: video().url, type: "video", mime: "video/mp4", filename: "clip.mp4", alt: null },
      ],
    });
    expect(res).toEqual({ status: "published", externalId: "ext1", url: "https://example.com/p/1" });
  });

  it("falls back to the post id when the receiver returns no JSON", async () => {
    const m = mockFetch([[`POST ${HOOK}`, () => new Response("ok")]]);
    const res = await webhook.publish(testContext(m.fetch), account(), { id: "p2", content: "x", media: [], settings: {} });
    expect(m.requests[0].headers["x-postflare-secret"]).toBeUndefined();
    expect(res).toEqual({ status: "published", externalId: "p2", url: null });
  });

  it("maps errors", async () => {
    const unauth = mockFetch([[`POST ${HOOK}`, () => json({ message: "nope" }, 401)]]);
    await expect(webhook.publish(testContext(unauth.fetch), account(), { id: "p", content: "x", media: [], settings: {} })).rejects.toMatchObject({ kind: "auth" });
    const down = mockFetch([[`POST ${HOOK}`, () => new Response("", { status: 502 })]]);
    await expect(webhook.publish(testContext(down.fetch), account(), { id: "p", content: "x", media: [], settings: {} })).rejects.toMatchObject({ kind: "transient" });
  });
});
