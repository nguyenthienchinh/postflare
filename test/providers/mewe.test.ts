import { describe, expect, it } from "vitest";
import { mewe, parseExpiry } from "../../worker/providers/mewe";
import { image, json, mockFetch, noCopy, testAccount, testContext } from "../helpers";

const APP = { appId: "APP", apiKey: "KEY" };
const H = "https://mewe.com";
const account = testAccount({ provider: "mewe", externalId: "u1", username: "ada", credentials: { accessToken: "TOK" } });
const post = (settings: Record<string, any> = {}, media: any[] = []) => ({ id: "p1", content: "Hello MeWe", media, settings });

describe("mewe", () => {
  it("authorize builds the login URL", async () => {
    const url = new URL(await mewe.authorize!(testContext(mockFetch([]).fetch, APP, "mewe"), { state: "S", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toBe(`${H}/login`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "APP", redirect_uri: "https://pf.example.com/oauth/mewe/callback", state: "S" });
  });

  it("authorize requires app config", () => {
    expect(() => mewe.authorize!(testContext(mockFetch([]).fetch, {}), { state: "S", codeVerifier: "v", codeChallenge: "c" })).toThrow(/not configured/);
  });

  it("callback exchanges the login request token", async () => {
    const exp = Date.now() + 86400_000;
    const { fetch, requests } = mockFetch([
      [`GET ${H}/api/dev/token`, () => ({ apiToken: "TOK", expiresAt: new Date(exp).toISOString() })],
      [`GET ${H}/api/dev/me`, () => ({ userId: "u1", firstName: "Ada", lastName: "L", handle: "ada" })],
    ]);
    const [acc] = await mewe.callback!(testContext(fetch, APP), { code: "", codeVerifier: "", params: new URLSearchParams("loginRequestToken=LRT&state=S") });
    expect(acc).toMatchObject({ externalId: "u1", name: "Ada L", username: "ada", credentials: { accessToken: "TOK" } });
    expect(Math.abs(acc.expiresAt! - exp)).toBeLessThan(1000);
    expect(requests[0].url).toContain("loginRequestToken=LRT");
    expect(requests[0].headers).toMatchObject({ "x-app-id": "APP", "x-api-key": "KEY" });
    expect(requests[1].headers.authorization).toBe("Bearer TOK");
  });

  it("callback reports pending logins", async () => {
    const { fetch } = mockFetch([[`GET ${H}/api/dev/token`, () => ({ pending: true })]]);
    await expect(mewe.callback!(testContext(fetch, APP), { code: "LRT", codeVerifier: "", params: new URLSearchParams() })).rejects.toThrow(/pending/);
  });

  it("publishes text to the timeline (204)", async () => {
    const { fetch, requests } = mockFetch([[`POST ${H}/api/dev/me/post`, () => new Response(null, { status: 204 })]]);
    const res = await mewe.publish(testContext(fetch, APP), account, post({ postType: "timeline" }));
    expect(res).toEqual({ status: "published", externalId: "p1", url: "https://mewe.com/ada/posts" });
    expect(requests[0].json).toEqual({ text: "Hello MeWe" });
    expect(requests[0].headers["x-app-id"]).toBe("APP");
  });

  it("uploads photos and posts to a group", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      [`POST ${H}/api/dev/photo/upload`, () => ({ id: `ph${++n}` })],
      [`POST ${H}/api/dev/group/g1/post`, () => ({ postItemId: "post9" })],
    ]);
    const res = await mewe.publish(noCopy(testContext(fetch, APP)), account, post({ postType: "group", group: "g1" }, [image(), image({ id: "b" })]));
    expect(res).toEqual({ status: "published", externalId: "post9", url: "https://mewe.com/group/g1" });
    expect(requests[0].formData?.get("file")).toBeInstanceOf(Blob);
    expect((requests[0].formData?.get("file") as File).size).toBe(image().size);
    expect(requests[2].json).toEqual({ text: "Hello MeWe", uploadedPhotoIds: ["ph1", "ph2"] });
  });

  it("requires a group for group posts", async () => {
    expect(mewe.validate!(post({ postType: "group" }))).toHaveLength(1);
    await expect(mewe.publish(testContext(mockFetch([]).fetch, APP), account, post({ postType: "group" }))).rejects.toMatchObject({ kind: "invalid" });
  });

  it("lists groups across pages", async () => {
    const { fetch } = mockFetch([
      [`GET ${H}/api/dev/groups?page=2`, () => ({ groups: [{ groupId: "g2", name: "Two" }] })],
      [`GET ${H}/api/dev/groups`, () => ({ groups: [{ groupId: "g1", name: "One" }], nextPage: "/api/dev/groups?page=2" })],
    ]);
    expect(await mewe.options!(testContext(fetch, APP), account, "group", {})).toEqual([
      { value: "g1", label: "One" },
      { value: "g2", label: "Two" },
    ]);
  });

  it("maps errors", async () => {
    const { fetch } = mockFetch([
      [`POST ${H}/api/dev/me/post`, () => json({ message: "Unauthorized" }, 401)],
      [`POST ${H}/api/dev/group/g1/post`, () => json({ message: "Enhance Your Calm" }, 420)],
    ]);
    await expect(mewe.publish(testContext(fetch, APP), account, post())).rejects.toMatchObject({ kind: "auth" });
    await expect(mewe.publish(testContext(fetch, APP), account, post({ postType: "group", group: "g1" }))).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("parses expiry formats", () => {
    expect(parseExpiry(1700000000)).toBe(1700000000000);
    expect(parseExpiry(1700000000000)).toBe(1700000000000);
    expect(parseExpiry("2030-01-01T00:00:00Z")).toBe(Date.parse("2030-01-01T00:00:00Z"));
    expect(parseExpiry(null)).toBeNull();
  });
});
