import { describe, expect, it } from "vitest";
import { counted } from "../../worker/providers/budget";
import { tumblr } from "../../worker/providers/tumblr";
import { streamingMultipart } from "../../worker/providers/multipart";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const app = { clientId: "CID", clientSecret: "CSEC" };
const account = () => testAccount({ provider: "tumblr", externalId: "t:uuid", username: "myblog", meta: { blog: "myblog" } });
const post = (over: any = {}) => ({ id: "p1", content: "Hello\n\nWorld", media: [], settings: {}, ...over });

describe("tumblr oauth", () => {
  it("builds the authorize URL", () => {
    const url = new URL(tumblr.authorize!(testContext(fetch, app, "tumblr"), { state: "S", codeVerifier: "v", codeChallenge: "c" }) as string);
    expect(url.origin + url.pathname).toBe("https://www.tumblr.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "CID",
      response_type: "code",
      scope: "basic write offline_access",
      state: "S",
      redirect_uri: "https://pf.example.com/oauth/tumblr/callback",
    });
  });

  it("exchanges the code and returns one account per blog", async () => {
    const { fetch, requests } = mockFetch([
      ["POST https://api.tumblr.com/v2/oauth2/token", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 2520 })],
      [
        "GET https://api.tumblr.com/v2/user/info",
        () => ({
          response: {
            user: {
              name: "me",
              blogs: [
                { name: "myblog", title: "My Blog", uuid: "t:1", url: "https://myblog.tumblr.com/", primary: true },
                { name: "side", title: "", uuid: "t:2", url: "https://side.tumblr.com/" },
              ],
            },
          },
        }),
      ],
    ]);
    const accounts = await tumblr.callback!(testContext(fetch, app, "tumblr"), { code: "C", codeVerifier: "v", params: new URLSearchParams() });
    expect(requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "C", client_id: "CID", client_secret: "CSEC" });
    expect(requests[1].headers.authorization).toBe("Bearer AT");
    expect(accounts.map((a) => [a.externalId, a.name, a.username, a.meta?.blog])).toEqual([
      ["t:1", "My Blog", "myblog", "myblog"],
      ["t:2", "side", "side", "side"],
    ]);
    expect(accounts[0].credentials).toEqual({ accessToken: "AT", refreshToken: "RT" });
    expect(accounts[0].expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes", async () => {
    const { fetch, requests } = mockFetch([[/oauth2\/token/, () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 2520 })]]);
    const up = await tumblr.refresh!(testContext(fetch, app), account());
    expect(requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
    expect(up.credentials).toEqual({ accessToken: "AT2", refreshToken: "RT2" });
  });

  it("maps invalid_grant on refresh to auth", async () => {
    const { fetch } = mockFetch([[/oauth2\/token/, () => json({ error: "invalid_grant" }, 400)]]);
    await expect(tumblr.refresh!(testContext(fetch, app), account())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("tumblr publish", () => {
  it("posts NPF JSON for text", async () => {
    const { fetch, requests } = mockFetch([
      ["POST https://api.tumblr.com/v2/blog/myblog/posts", () => json({ meta: { status: 201 }, response: { id: 123, id_string: "123" } }, 201)],
    ]);
    const res = await tumblr.publish(
      testContext(fetch),
      account(),
      post({ settings: { state: "queue", title: "Title", tags: ["#one", "two"], link: "example.com", sourceUrl: "https://src.example" } }),
    );
    expect(res).toEqual({ status: "published", externalId: "123", url: "https://www.tumblr.com/myblog/123" });
    expect(requests[0].json).toEqual({
      content: [
        { type: "text", subtype: "heading1", text: "Title" },
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
        { type: "link", url: "https://example.com" },
      ],
      state: "queue",
      tags: "one,two",
      source_url: "https://src.example",
    });
  });

  it("streams images and video in a multipart request", async () => {
    const { fetch, requests } = mockFetch([[/\/posts$/, () => json({ response: { id_string: "9" } }, 201)]]);
    const img = image({ size: 1000 });
    const vid = video({ size: 5000 });
    await tumblr.publish(testContext(fetch), account(), post({ content: "x", media: [img, vid] }));
    const r = requests[0];
    expect(r.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(Number(r.headers["content-length"])).toBe(r.body!.length);
    expect(r.body).toContain('name="media-0"; filename="photo.jpg"');
    expect(r.body).toContain('name="media-1"; filename="clip.mp4"');
    const jsonPart = r.body!.split('name="json"\r\nContent-Type: application/json\r\n\r\n')[1].split("\r\n")[0];
    expect(JSON.parse(jsonPart).content).toEqual([
      { type: "text", text: "x" },
      { type: "image", media: [{ type: "image/jpeg", identifier: "media-0", width: 1080, height: 1080 }], alt_text: "alt text" },
      { type: "video", provider: "tumblr", media: { type: "video/mp4", identifier: "media-1", width: 1080, height: 1920 } },
    ]);
  });

  it("maps 401 to auth and media upload errors to transient", async () => {
    const { fetch } = mockFetch([[/\/posts$/, () => json({ meta: { status: 401, msg: "Unauthorized" } }, 401)]]);
    await expect(tumblr.publish(testContext(fetch), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const { fetch: f2 } = mockFetch([[/\/posts$/, () => json({ errors: [{ code: 8006, detail: "upload error" }] }, 400)]]);
    await expect(tumblr.publish(testContext(f2), account(), post())).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("streamingMultipart", () => {
  it("produces a body matching FormData semantics and the declared length", async () => {
    const mp = streamingMultipart([
      { name: "a", value: "1" },
      { name: "f", filename: "x.bin", type: "application/octet-stream", size: 3, open: async () => new Uint8Array([65, 66, 67]).buffer },
    ]);
    const text = await new Response(mp.body).text();
    expect(text.length).toBe(mp.length);
    const parsed = await new Response(text, { headers: { "content-type": mp.headers["content-type"] } }).formData();
    expect(parsed.get("a")).toBe("1");
    expect(await (parsed.get("f") as File).text()).toBe("ABC");
  });
});

describe("tumblr metrics", () => {
  const T = "https://api.tumblr.com/v2/blog/myblog";
  const items = (...ids: string[]) => ids.map((externalId) => ({ externalId, publishedAt: Date.now() }));

  it("maps note totals per post and returns null for missing posts", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${T}/notes?id=404`, () => json({ meta: { status: 404 }, errors: [{ code: 0, detail: "Not found" }] }, 404)],
      [`GET ${T}/notes`, () => ({ response: { notes: [], total_notes: 12, total_likes: 7, total_reblogs: 3 } })],
    ]);
    const res = await tumblr.postMetrics!(testContext(fetch), account(), items("111", "404"));
    expect(res).toEqual({ "111": { likes: 7, reposts: 3, extra: { notes: 12 } }, "404": null });
    const u = new URL(requests[0].url);
    expect(u.searchParams.get("mode")).toBe("conversation");
    expect(requests[0].headers.authorization).toBe("Bearer AT");
  });

  it("keeps only notes when likes/reblogs are not reported", async () => {
    const { fetch } = mockFetch([[`GET ${T}/notes`, () => ({ response: { notes: [], total_notes: 4 } })]]);
    expect(await tumblr.postMetrics!(testContext(fetch), account(), items("1"))).toEqual({ "1": { extra: { notes: 4 } } });
  });

  it("stops at the fetch budget", async () => {
    const { fetch, requests } = mockFetch([[`GET ${T}/notes`, () => ({ response: { total_notes: 1, total_likes: 1, total_reblogs: 0 } })]]);
    const res = await tumblr.postMetrics!(counted(testContext(fetch), 2), account(), items("1", "2", "3", "4"));
    expect(requests).toHaveLength(2);
    expect(Object.keys(res).sort()).toEqual(["1", "2"]);
  });

  it("reads followers and posts from blog info", async () => {
    const { fetch, requests } = mockFetch([[`GET ${T}/info`, () => ({ response: { blog: { name: "myblog", followers: 321, posts: 45 } } })]]);
    expect(await tumblr.accountMetrics!(testContext(fetch), account())).toEqual({ followers: 321, posts: 45 });
    expect(requests).toHaveLength(1);
    expect(tumblr.metrics).toMatchObject({ post: ["likes", "reposts"], account: ["followers", "posts"] });
  });
});
