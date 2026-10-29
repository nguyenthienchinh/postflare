import { describe, expect, it } from "vitest";
import { moltbook, moltTitle } from "../../worker/providers/moltbook";
import { json, mockFetch, testAccount, testContext } from "../helpers";

const API = "https://www.moltbook.com/api/v1";
const account = testAccount({ provider: "moltbook", externalId: "agent", credentials: { accessToken: "moltbook_KEY" } });
const post = (settings: Record<string, any> = {}, content = "First line\nmore text") => ({ id: "p1", content, media: [], settings });

describe("moltbook", () => {
  it("connect with an API key checks claim status and profile", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${API}/agents/status`, () => ({ success: true, status: "claimed" })],
      [`GET ${API}/agents/me`, () => ({ success: true, agent: { id: "a1", name: "postbot", display_name: "Post Bot" } })],
    ]);
    const [acc] = await moltbook.connect!(testContext(fetch), { apiKey: "moltbook_KEY" });
    expect(acc).toMatchObject({ externalId: "postbot", name: "Post Bot", username: "postbot", credentials: { accessToken: "moltbook_KEY" } });
    expect(requests[0].headers.authorization).toBe("Bearer moltbook_KEY");
  });

  it("refuses unclaimed agents", async () => {
    const { fetch } = mockFetch([[`GET ${API}/agents/status`, () => ({ success: true, status: "pending_claim" })]]);
    await expect(moltbook.connect!(testContext(fetch), { apiKey: "k" })).rejects.toThrow(/not claimed/);
  });

  it("registers a new agent and returns the key + claim URL in the error", async () => {
    const { fetch, requests } = mockFetch([
      [`POST ${API}/agents/register`, () => ({ success: true, agent: { api_key: "moltbook_NEW", claim_url: "https://www.moltbook.com/claim/x", verification_code: "reef-1" } })],
    ]);
    const err = await moltbook.connect!(testContext(fetch), { apiKey: "", name: "postbot", description: "" }).catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(err.message).toContain("moltbook_NEW");
    expect(err.message).toContain("https://www.moltbook.com/claim/x");
    expect(requests[0].json).toEqual({ name: "postbot", description: "Postflare social media scheduler" });
  });

  it("publishes a text post", async () => {
    const { fetch, requests } = mockFetch([[`POST ${API}/posts`, () => json({ success: true, post: { id: 123 } }, 201)]]);
    const res = await moltbook.publish(testContext(fetch), account, post({ submolt: "m/agents" }));
    expect(res).toEqual({ status: "published", externalId: "123", url: "https://www.moltbook.com/post/123" });
    expect(requests[0].json).toEqual({ submolt: "agents", title: "First line", content: "First line\nmore text" });
  });

  it("publishes a link post with a custom title", async () => {
    const { fetch, requests } = mockFetch([[`POST ${API}/posts`, () => ({ success: true, post: { id: "p9" } })]]);
    await moltbook.publish(testContext(fetch), account, post({ title: "Read this", url: "https://x.com" }));
    expect(requests[0].json).toEqual({ submolt: "general", title: "Read this", url: "https://x.com" });
  });

  it("replies as nested comments", async () => {
    const { fetch, requests } = mockFetch([[`POST ${API}/posts/123/comments`, () => ({ success: true, comment: { id: "c1" } })]]);
    const first = await moltbook.reply!(testContext(fetch), account, { rootId: "123", parentId: "123" }, post());
    expect(first).toEqual({ externalId: "c1", url: "https://www.moltbook.com/post/123", urlIsPost: true });
    expect(requests[0].json).toEqual({ content: "First line\nmore text" });
    await moltbook.reply!(testContext(fetch), account, { rootId: "123", parentId: "c1" }, post());
    expect(requests[1].json).toEqual({ content: "First line\nmore text", parent_id: "c1" });
  });

  it("maps errors", async () => {
    const { fetch } = mockFetch([
      [`GET ${API}/agents/status`, () => json({ success: false, error: "Invalid API key" }, 401)],
      [`POST ${API}/posts/1/comments`, () => json({ success: false, error: "slow down", retry_after_minutes: 20 }, 429)],
      [`POST ${API}/posts`, () => ({ success: false, error: "Submolt not found", hint: "check the name" })],
    ]);
    await expect(moltbook.connect!(testContext(fetch), { apiKey: "bad" })).rejects.toMatchObject({ kind: "auth" });
    await expect(moltbook.reply!(testContext(fetch), account, { rootId: "1", parentId: "1" }, post())).rejects.toMatchObject({ kind: "rate_limit" });
    await expect(moltbook.publish(testContext(fetch), account, post())).rejects.toMatchObject({ kind: "invalid", message: "Moltbook: Submolt not found (check the name)" });
  });

  it("derives titles", () => {
    expect(moltTitle("", "x".repeat(400))).toHaveLength(300);
    expect(moltTitle(" T ", "body")).toBe("T");
  });
});
