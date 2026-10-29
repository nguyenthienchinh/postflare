import { describe, expect, it } from "vitest";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { reddit } from "../../worker/providers/reddit";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const app = { clientId: "cid", clientSecret: "csecret" };
const account = testAccount({ provider: "reddit", username: "spez" });
const post = (settings: Record<string, any> = {}, over: Partial<Parameters<typeof reddit.publish>[2]> = {}) => ({
  id: "p1",
  content: "Body text",
  media: [],
  settings: { subreddit: "r/test", title: "Hello", ...settings },
  ...over,
});
const submitted = (data: any) => ({ json: { errors: [], data } });
const lease = (n: number) => ({
  args: {
    action: "//reddit-uploaded-media.s3-accelerate.amazonaws.com",
    fields: [
      { name: "key", value: `rte_images/f${n}` },
      { name: "policy", value: "pol" },
    ],
  },
  asset: { asset_id: `a${n}` },
});
const s3ok = (n: number) =>
  new Response(`<PostResponse><Location>https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images%2Ff${n}</Location></PostResponse>`, {
    status: 201,
  });

describe("reddit oauth", () => {
  it("builds the authorize URL", async () => {
    const url = new URL(await reddit.authorize!(testContext(mockFetch([]).fetch, app, "reddit"), { state: "st", codeVerifier: "", codeChallenge: "" }));
    expect(url.origin + url.pathname).toBe("https://www.reddit.com/api/v1/authorize");
    expect(url.searchParams.get("duration")).toBe("permanent");
    expect(url.searchParams.get("scope")).toBe("identity submit read mysubreddits flair");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/reddit/callback");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("exchanges the code with basic auth and loads the user", async () => {
    const m = mockFetch([
      ["POST https://www.reddit.com/api/v1/access_token", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 86400 })],
      ["GET https://oauth.reddit.com/api/v1/me", () => ({ id: "u1", name: "spez", icon_img: "https://i.redd.it/a.png?x=1" })],
    ]);
    const [acc] = await reddit.callback!(testContext(m.fetch, app), { code: "c", codeVerifier: "", params: new URLSearchParams() });
    expect(acc).toMatchObject({
      externalId: "u1",
      username: "spez",
      avatarUrl: "https://i.redd.it/a.png",
      credentials: { accessToken: "AT", refreshToken: "RT" },
    });
    expect(m.requests[0].headers.authorization).toBe(`Basic ${btoa("cid:csecret")}`);
    expect(m.requests[0].headers["user-agent"]).toMatch(/^web:postflare/);
    expect(m.requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "c" });
  });

  it("refreshes keeping the permanent refresh token", async () => {
    const m = mockFetch([["POST https://www.reddit.com/api/v1/access_token", () => ({ access_token: "AT2", expires_in: 86400 })]]);
    const upd = await reddit.refresh!(testContext(m.fetch, app), account);
    expect(upd.credentials).toMatchObject({ accessToken: "AT2", refreshToken: "RT" });
  });
});

describe("reddit options", () => {
  it("merges moderated and subscribed subreddits", async () => {
    const m = mockFetch([
      ["GET https://oauth.reddit.com/subreddits/mine/moderator", () => ({ data: { children: [{ data: { display_name: "mysub", display_name_prefixed: "r/mysub" } }] } })],
      [
        "GET https://oauth.reddit.com/subreddits/mine/subscriber",
        () => ({
          data: {
            children: [
              { data: { display_name: "MySub", display_name_prefixed: "r/MySub" } },
              { data: { display_name: "apple", display_name_prefixed: "r/apple" } },
            ],
          },
        }),
      ],
    ]);
    expect(await reddit.options!(testContext(m.fetch, app), account, "subreddit", {})).toEqual([
      { value: "apple", label: "r/apple" },
      { value: "mysub", label: "r/mysub" },
    ]);
  });

  it("loads flairs for the chosen subreddit and tolerates 403", async () => {
    const m = mockFetch([
      ["GET https://oauth.reddit.com/r/test/api/link_flair_v2", () => [{ id: "f1", text: "Discussion" }]],
      ["GET https://oauth.reddit.com/r/closed/api/link_flair_v2", () => json({ message: "Forbidden" }, 403)],
    ]);
    const ctx = testContext(m.fetch, app);
    expect(await reddit.options!(ctx, account, "flair", { subreddit: "/r/test/" })).toEqual([{ value: "f1", label: "Discussion" }]);
    expect(await reddit.options!(ctx, account, "flair", { subreddit: "closed" })).toEqual([]);
    expect(await reddit.options!(ctx, account, "flair", {})).toEqual([]);
  });
});

describe("reddit publish", () => {
  it("submits a self post with flair, nsfw and spoiler", async () => {
    const m = mockFetch([
      ["POST https://oauth.reddit.com/api/submit", () => submitted({ id: "abc", name: "t3_abc", url: "https://www.reddit.com/r/test/comments/abc/hello/" })],
    ]);
    const res = await reddit.publish(testContext(m.fetch, app), account, post({ flair: "f1", nsfw: true, spoiler: true }));
    expect(res).toEqual({ status: "published", externalId: "t3_abc", url: "https://www.reddit.com/r/test/comments/abc/hello/" });
    expect(m.requests[0].form).toMatchObject({
      api_type: "json",
      sr: "test",
      kind: "self",
      title: "Hello",
      text: "Body text",
      flair_id: "f1",
      nsfw: "true",
      spoiler: "true",
      sendreplies: "true",
    });
    expect(m.requests[0].headers.authorization).toBe("Bearer AT");
  });

  it("submits a link post", async () => {
    const m = mockFetch([["POST https://oauth.reddit.com/api/submit", () => submitted({ name: "t3_l", url: "https://www.reddit.com/r/test/comments/l/x/" })]]);
    await reddit.publish(testContext(m.fetch, app), account, post({ kind: "link", url: "https://example.com" }));
    expect(m.requests[0].form).toMatchObject({ kind: "link", url: "https://example.com" });
    expect(m.requests[0].form!.text).toBeUndefined();
  });

  it("uploads an image through the media asset lease, then finds the post", async () => {
    let listing: any[] = [];
    const m = mockFetch([
      ["POST https://oauth.reddit.com/api/media/asset.json", () => lease(1)],
      ["POST https://reddit-uploaded-media.s3-accelerate.amazonaws.com", () => s3ok(1)],
      ["POST https://oauth.reddit.com/api/submit", () => submitted({ user_submitted_page: "https://www.reddit.com/user/spez/submitted/", websocket_url: "wss://x" })],
      ["GET https://oauth.reddit.com/user/spez/submitted", () => ({ data: { children: listing } })],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await reddit.publish(ctx, account, post({ kind: "media" }, { media: [image()] }));
    expect(res.status).toBe("pending");
    expect(m.requests[0].form).toMatchObject({ filepath: "photo.jpg", mimetype: "image/jpeg" });
    const s3 = m.requests[1];
    expect(s3.url).toBe("https://reddit-uploaded-media.s3-accelerate.amazonaws.com/");
    expect(s3.body).toContain('name="key"\r\n\r\nrte_images/f1');
    expect(s3.body).toContain('name="file"; filename="photo.jpg"');
    expect(m.requests[2].form).toMatchObject({ kind: "image", url: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images/f1" });

    const state = (res as any).state;
    expect(await reddit.checkStatus!(ctx, account, state)).toMatchObject({ status: "pending", state: { lookups: 1 } });
    listing = [
      { data: { name: "t3_old", subreddit: "test", title: "Hello", created_utc: state.since / 1000 - 3600, permalink: "/r/test/comments/old/" } },
      { data: { name: "t3_new", subreddit: "Test", title: "Hello", created_utc: state.since / 1000 + 2, permalink: "/r/test/comments/new/hello/" } },
    ];
    expect(await reddit.checkStatus!(ctx, account, state)).toEqual({
      status: "published",
      externalId: "t3_new",
      url: "https://www.reddit.com/r/test/comments/new/hello/",
    });
  });

  it("uploads a video with an image poster", async () => {
    let n = 0;
    let s = 0;
    const m = mockFetch([
      ["POST https://oauth.reddit.com/api/media/asset.json", () => lease(++n)],
      ["POST https://reddit-uploaded-media.s3-accelerate.amazonaws.com", () => s3ok(++s)],
      ["POST https://oauth.reddit.com/api/submit", () => submitted({ user_submitted_page: "https://www.reddit.com/user/spez/submitted/" })],
    ]);
    await reddit.publish(testContext(m.fetch, app), account, post({ kind: "media" }, { media: [video({ size: 1000 }), image()] }));
    const submit = m.requests.at(-1)!;
    expect(submit.form).toMatchObject({
      kind: "video",
      url: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images/f1",
      video_poster_url: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images/f2",
    });
  });

  it("gives up looking for the media post without failing", async () => {
    const m = mockFetch([["GET https://oauth.reddit.com/user/spez/submitted", () => ({ data: { children: [] } })]]);
    const res = await reddit.checkStatus!(testContext(m.fetch, app), account, { username: "spez", subreddit: "test", title: "x", since: 1, lookups: 39, fallbackUrl: "https://u" });
    expect(res).toMatchObject({ status: "published", url: "https://u" });
  });

  it("maps Reddit's 200 error payloads", async () => {
    const m = mockFetch([["POST https://oauth.reddit.com/api/submit", () => ({ json: { errors: [["SUBREDDIT_NOEXIST", "that subreddit doesn't exist", "sr"]] } })]]);
    await expect(reddit.publish(testContext(m.fetch, app), account, post())).rejects.toMatchObject({ kind: "invalid" });
    const m2 = mockFetch([["POST https://oauth.reddit.com/api/submit", () => ({ json: { errors: [["RATELIMIT", "try again in 5 minutes", "ratelimit"]] } })]]);
    await expect(reddit.publish(testContext(m2.fetch, app), account, post())).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("maps 401 to auth", async () => {
    const m = mockFetch([["POST https://oauth.reddit.com/api/submit", () => json({ message: "Unauthorized", error: 401 }, 401)]]);
    await expect(reddit.publish(testContext(m.fetch, app), account, post())).rejects.toMatchObject({ kind: "auth" });
  });

  it("validates", () => {
    expect(reddit.validate!(post())).toEqual([]);
    expect(reddit.validate!(post({ title: "" }))).toContain('Reddit: "Title" is required');
    expect(reddit.validate!(post({ kind: "media" }))).toHaveLength(1);
    expect(reddit.validate!(post({}, { media: [image()] }))).toHaveLength(1);
    expect(reddit.validate!(post({ kind: "link", url: "nope" }))).toHaveLength(1);
  });
});

describe("reddit comments", () => {
  it("comments on the root post", async () => {
    const m = mockFetch([
      ["POST https://oauth.reddit.com/api/comment", () => ({ json: { errors: [], data: { things: [{ data: { name: "t1_c", id: "c", permalink: "/r/test/comments/abc/hello/c/" } }] } } })],
    ]);
    const r = await reddit.reply!(testContext(m.fetch, app), account, { rootId: "t3_abc", parentId: "t1_prev" }, post({}, { content: "First" }));
    expect(r).toEqual({ externalId: "t1_c", url: "https://www.reddit.com/r/test/comments/abc/hello/c/" });
    expect(m.requests[0].form).toMatchObject({ thing_id: "t3_abc", text: "First", api_type: "json" });
  });

  it("refuses to comment on an unresolved post", async () => {
    await expect(reddit.reply!(testContext(mockFetch([]).fetch, app), account, { rootId: "unresolved:x", parentId: "x" }, post())).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});

describe("reddit metrics", () => {
  const listing = (...posts: any[]) => ({ kind: "Listing", data: { children: posts.map((data) => ({ kind: "t3", data })) } });

  it("declares a batch of 100", () => {
    expect(reddit.metrics).toMatchObject({ batch: 100, account: ["followers"] });
  });

  it("fetches the batch in one /api/info request and maps score, comments and ratio", async () => {
    const m = mockFetch([
      [
        "GET https://oauth.reddit.com/api/info",
        () =>
          listing(
            { name: "t3_a", score: 42, num_comments: 5, upvote_ratio: 0.93, num_crossposts: 1, view_count: null },
            { name: "t3_b", score: 0, num_comments: 0, upvote_ratio: 0.5, num_crossposts: 0, view_count: 120 },
          ),
      ],
    ]);
    const res = await reddit.postMetrics!(testContext(m.fetch, app), account, [
      { externalId: "t3_a", publishedAt: 0 },
      { externalId: "b", publishedAt: 0 },
      { externalId: "t3_gone", publishedAt: 0 },
      { externalId: "unresolved:test:123", publishedAt: 0 },
    ]);
    expect(m.requests).toHaveLength(1);
    expect(new URL(m.requests[0].url).searchParams.get("id")).toBe("t3_a,t3_b,t3_gone");
    expect(m.requests[0].headers["user-agent"]).toMatch(/postflare/);
    expect(res).toEqual({
      t3_a: { likes: 42, comments: 5, extra: { upvote_ratio: 0.93, crossposts: 1 } },
      b: { likes: 0, comments: 0, views: 120, extra: { upvote_ratio: 0.5, crossposts: 0 } },
      t3_gone: null,
      "unresolved:test:123": null,
    });
  });

  it("signals reconnect_required on 403", async () => {
    const m = mockFetch([[/\/api\/info/, () => json({ message: "Forbidden", error: 403 }, 403)]]);
    const err = await reddit.postMetrics!(testContext(m.fetch, app), account, [{ externalId: "t3_a", publishedAt: 0 }]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
  });

  it("reads karma and profile followers", async () => {
    const m = mockFetch([
      ["GET https://oauth.reddit.com/api/v1/me", () => ({ name: "spez", total_karma: 100, link_karma: 60, comment_karma: 40, subreddit: { subscribers: 12 } })],
    ]);
    expect(await reddit.accountMetrics!(testContext(m.fetch, app), account)).toEqual({
      followers: 12,
      extra: { total_karma: 100, link_karma: 60, comment_karma: 40 },
    });
  });
});
