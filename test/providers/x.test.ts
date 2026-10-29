import { describe, expect, it } from "vitest";
import { x, xWeightedLength } from "../../worker/providers/x";
import { MetricsUnavailableError, ProviderError } from "../../worker/providers/errors";
import { hollowMedia, image, json, lazyStream, mockFetch, testAccount, testContext, video } from "../helpers";

const app = { clientId: "cid", clientSecret: "csecret" };
const account = testAccount({ provider: "x", username: "jack", externalId: "12" });
const post = (over: Partial<Parameters<typeof x.publish>[2]> = {}) => ({ id: "p1", content: "hello", media: [], settings: {}, ...over });

describe("x weighted length", () => {
  it("counts latin as 1, CJK and emoji as 2, URLs as 23", () => {
    expect(xWeightedLength("hello")).toBe(5);
    expect(xWeightedLength("日本")).toBe(4);
    expect(xWeightedLength("👍")).toBe(2);
    expect(xWeightedLength("👨‍👩‍👧")).toBe(2);
    expect(xWeightedLength("see https://example.com/a/very/long/path?with=query")).toBe(4 + 23);
    expect(xWeightedLength("go to example.com.")).toBe(6 + 23 + 1);
    expect(xWeightedLength("mail me@example.com")).toBe(19);
  });

  it("validate enforces 280 unless premium", () => {
    const long = "a".repeat(281);
    expect(x.validate!(post({ content: long }))[0]).toMatch(/281\/280/);
    expect(x.validate!(post({ content: long, settings: { premium: true } }))).toEqual([]);
    expect(x.validate!(post({ content: "字".repeat(141) }))[0]).toMatch(/282\/280/);
  });

  it("validate checks media mix and polls", () => {
    expect(x.validate!(post({ media: [video(), image()] }))).toHaveLength(1);
    expect(x.validate!(post({ media: [image({ mime: "image/gif" }), image()] }))).toHaveLength(1);
    expect(x.validate!(post({ settings: { poll: true, pollOptions: ["a"] } }))).toEqual(["X: a poll needs 2 to 4 options"]);
    expect(x.validate!(post({ settings: { poll: true, pollOptions: ["a", "b"] } }))).toEqual([]);
  });
});

describe("x oauth", () => {
  it("builds the authorize URL with PKCE", async () => {
    const ctx = testContext(mockFetch([]).fetch, app, "x");
    const url = new URL(await x.authorize!(ctx, { state: "st", codeVerifier: "v", codeChallenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/x/callback");
    expect(url.searchParams.get("scope")).toBe("tweet.read tweet.write users.read offline.access media.write");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("exchanges the code and loads the user", async () => {
    const m = mockFetch([
      ["POST https://api.x.com/2/oauth2/token", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 7200 })],
      ["GET https://api.x.com/2/users/me", () => ({ data: { id: "12", name: "Jack", username: "jack", profile_image_url: "https://img" } })],
    ]);
    const [acc] = await x.callback!(testContext(m.fetch, app, "x"), { code: "c", codeVerifier: "v", params: new URLSearchParams() });
    expect(acc).toMatchObject({ externalId: "12", username: "jack", credentials: { accessToken: "AT", refreshToken: "RT" } });
    expect(acc.expiresAt).toBeGreaterThan(Date.now());
    const tokenReq = m.requests[0];
    expect(tokenReq.headers.authorization).toBe(`Basic ${btoa("cid:csecret")}`);
    expect(tokenReq.form).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v" });
    expect(m.requests[1].headers.authorization).toBe("Bearer AT");
  });

  it("refreshes with rotating refresh tokens", async () => {
    const m = mockFetch([["POST https://api.x.com/2/oauth2/token", () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 7200 })]]);
    const upd = await x.refresh!(testContext(m.fetch, app), account);
    expect(upd.credentials).toMatchObject({ accessToken: "AT2", refreshToken: "RT2" });
    expect(m.requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
  });

  it("maps invalid_grant on refresh to auth", async () => {
    const m = mockFetch([["POST https://api.x.com/2/oauth2/token", () => json({ error: "invalid_grant" }, 400)]]);
    await expect(x.refresh!(testContext(m.fetch, app), account)).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("x publish", () => {
  it("posts text with settings", async () => {
    const m = mockFetch([["POST https://api.x.com/2/tweets", () => json({ data: { id: "99", text: "hello" } }, 201)]]);
    const res = await x.publish(
      testContext(m.fetch, app),
      account,
      post({ settings: { replySettings: "following", community: "https://x.com/i/communities/1493446837214187523", madeWithAi: true } }),
    );
    expect(res).toEqual({ status: "published", externalId: "99", url: "https://x.com/jack/status/99" });
    expect(m.requests[0].json).toEqual({
      text: "hello",
      reply_settings: "following",
      community_id: "1493446837214187523",
      made_with_ai: true,
    });
  });

  it("replies to another post given its URL", async () => {
    const m = mockFetch([["POST https://api.x.com/2/tweets", () => ({ data: { id: "2" } })]]);
    await x.publish(testContext(m.fetch, app), account, post({ settings: { replyTo: "https://x.com/zerocost_lab/status/2111442603388314109?s=46" } }));
    expect(m.requests[0].json).toEqual({ text: "hello", reply: { in_reply_to_tweet_id: "2111442603388314109" } });
    expect(x.validate!(post({ settings: { replyTo: "https://example.com/nope" } }))).toContain("X: reply to must be a post URL or numeric id");
    expect(x.validate!(post({ settings: { replyTo: "2111442603388314109" } }))).toEqual([]);
  });

  it("posts a poll", async () => {
    const m = mockFetch([["POST https://api.x.com/2/tweets", () => ({ data: { id: "1" } })]]);
    await x.publish(testContext(m.fetch, app), account, post({ settings: { poll: true, pollOptions: ["Yes", "No"], pollDuration: "60" } }));
    expect(m.requests[0].json.poll).toEqual({ options: ["Yes", "No"], duration_minutes: 60 });
  });

  it("uploads images with alt text", async () => {
    let n = 0;
    const m = mockFetch([
      ["POST https://api.x.com/2/media/upload", () => ({ data: { id: `m${++n}` } })],
      ["POST https://api.x.com/2/media/metadata", () => ({ data: {} })],
      ["POST https://api.x.com/2/tweets", () => ({ data: { id: "2" } })],
    ]);
    const res = await x.publish(testContext(m.fetch, app), account, post({ media: [image(), image({ alt: null, mime: "image/heic" })] }));
    expect(res.status).toBe("published");
    const uploads = m.requests.filter((r) => r.url === "https://api.x.com/2/media/upload");
    expect(uploads).toHaveLength(2);
    expect(uploads[0].formData?.get("media_category")).toBe("tweet_image");
    expect((uploads[1].formData?.get("media") as Blob).type).toBe("image/jpeg");
    const meta = m.requests.filter((r) => r.url.endsWith("/media/metadata"));
    expect(meta).toHaveLength(1);
    expect(meta[0].json).toEqual({ id: "m1", metadata: { alt_text: { text: "alt text" } } });
    expect(m.requests.at(-1)!.json.media).toEqual({ media_ids: ["m1", "m2"] });
  });

  it("uploads video in chunks and goes pending until processed", async () => {
    let status = "in_progress";
    const m = mockFetch([
      ["POST https://api.x.com/2/media/upload/initialize", () => ({ data: { id: "v1" } })],
      ["POST https://api.x.com/2/media/upload/v1/append", () => new Response(null, { status: 204 })],
      ["POST https://api.x.com/2/media/upload/v1/finalize", () => ({ data: { id: "v1", processing_info: { state: "pending", check_after_secs: 7 } } })],
      ["GET https://api.x.com/2/media/upload", () => ({ data: { id: "v1", processing_info: { state: status, check_after_secs: 3 } } })],
      ["POST https://api.x.com/2/tweets", () => ({ data: { id: "3" } })],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await x.publish(ctx, account, post({ media: [video({ size: 9 * 1024 * 1024 })] }));
    expect(res).toMatchObject({ status: "pending", retryAfterSeconds: 7 });
    const init = m.requests[0];
    expect(init.json).toEqual({ media_type: "video/mp4", total_bytes: 9 * 1024 * 1024, media_category: "tweet_video" });
    const appends = m.requests.filter((r) => r.url.endsWith("/append"));
    expect(appends.map((a) => a.formData?.get("segment_index"))).toEqual(["0", "1", "2"]);
    expect(m.requests.some((r) => r.url.includes("/tweets"))).toBe(false);

    const state = (res as any).state;
    const again = await x.checkStatus!(ctx, account, state);
    expect(again).toMatchObject({ status: "pending", retryAfterSeconds: 5 });
    expect(m.requests.at(-1)!.url).toContain("command=STATUS");

    status = "succeeded";
    const done = await x.checkStatus!(ctx, account, (again as any).state);
    expect(done).toMatchObject({ status: "published", externalId: "3" });
    expect(m.requests.at(-1)!.json.media).toEqual({ media_ids: ["v1"] });
  });

  it("uploads a 512MB video across calls within the subrequest budget, resuming from state", async () => {
    const MiB = 1024 * 1024;
    const size = 512 * MiB;
    const m = mockFetch([
      ["POST https://api.x.com/2/media/upload/initialize", () => ({ data: { id: "big" } })],
      ["POST https://api.x.com/2/media/upload/big/append", () => new Response(null, { status: 204 })],
      ["POST https://api.x.com/2/media/upload/big/finalize", () => ({ data: { id: "big", processing_info: { state: "pending", check_after_secs: 10 } } })],
      ["GET https://api.x.com/2/media/upload", () => ({ data: { id: "big", processing_info: { state: "succeeded" } } })],
      ["POST https://api.x.com/2/tweets", () => ({ data: { id: "9" } })],
    ]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    const ranges: number[][] = [];
    ctx.media.stream = async (_v, r) => (r && ranges.push([r.offset, r.length]), lazyStream(1));
    ctx.media.range = async () => {
      throw new Error("must not copy video bytes into memory");
    };
    const calls: number[] = [];
    let seen = 0;
    const track = () => (calls.push(m.requests.length - seen), (seen = m.requests.length));
    let res = await x.publish(ctx, account, post({ media: [video({ size })] }));
    track();
    while (res.status === "pending") {
      res = await x.checkStatus!(ctx, account, JSON.parse(JSON.stringify(res.state)));
      track();
    }
    expect(res).toMatchObject({ status: "published", externalId: "9" });
    expect(Math.max(...calls)).toBeLessThanOrEqual(40);
    expect(calls.length).toBeGreaterThan(3);
    expect(m.requests.filter((r) => r.url.endsWith("/initialize"))).toHaveLength(1);
    const segs = m.requests.filter((r) => r.url.endsWith("/append")).map((r) => Number(r.formData?.get("segment_index")));
    expect(segs).toEqual(Array.from({ length: 128 }, (_, i) => i));
    expect(ranges.every(([offset, len], i) => offset === i * 4 * MiB && len === 4 * MiB)).toBe(true);
    expect(m.requests.at(-1)!.json.media).toEqual({ media_ids: ["big"] });
  });

  it("keeps upload progress when an APPEND fails transiently", async () => {
    let fail = true;
    const m = mockFetch([
      ["POST https://api.x.com/2/media/upload/initialize", () => ({ data: { id: "v1" } })],
      [
        "POST https://api.x.com/2/media/upload/v1/append",
        (r) => {
          if (r.formData?.get("segment_index") === "1" && fail) {
            fail = false;
            return json({ title: "Service Unavailable" }, 503);
          }
          return new Response(null, { status: 204 });
        },
      ],
      ["POST https://api.x.com/2/media/upload/v1/finalize", () => ({ data: { id: "v1" } })],
      ["POST https://api.x.com/2/tweets", () => ({ data: { id: "3" } })],
    ]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    const res = await x.publish(ctx, account, post({ media: [video({ size: 9 * 1024 * 1024 })] }));
    expect(res).toMatchObject({ status: "pending", state: { phase: "upload", progress: { upload: { id: "v1", next: 1 } } } });
    const done = await x.checkStatus!(ctx, account, (res as any).state);
    expect(done).toMatchObject({ status: "published", externalId: "3" });
    const segs = m.requests.filter((r) => r.url.endsWith("/append")).map((r) => r.formData?.get("segment_index"));
    expect(segs).toEqual(["0", "1", "1", "2"]);
    expect(m.requests.filter((r) => r.url.endsWith("/initialize"))).toHaveLength(1);
  });

  it("fails when processing fails", async () => {
    const m = mockFetch([
      ["GET https://api.x.com/2/media/upload", () => ({ data: { processing_info: { state: "failed", error: { message: "bad codec" } } } })],
    ]);
    await expect(x.checkStatus!(testContext(m.fetch, app), account, { body: {}, processing: ["v1"] })).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("bad codec"),
    });
  });

  it("uses tweet_gif for GIFs", async () => {
    const m = mockFetch([
      ["POST https://api.x.com/2/media/upload/initialize", () => ({ data: { id: "g1" } })],
      ["POST https://api.x.com/2/media/upload/g1/append", () => ({})],
      ["POST https://api.x.com/2/media/upload/g1/finalize", () => ({ data: { id: "g1" } })],
      ["POST https://api.x.com/2/media/metadata", () => ({})],
      ["POST https://api.x.com/2/tweets", () => ({ data: { id: "4" } })],
    ]);
    const res = await x.publish(testContext(m.fetch, app), account, post({ media: [image({ mime: "image/gif", size: 1000 })] }));
    expect(res.status).toBe("published");
    expect(m.requests[0].json.media_category).toBe("tweet_gif");
  });

  it("maps 401 to auth and 429 to rate_limit", async () => {
    const m401 = mockFetch([["POST https://api.x.com/2/tweets", () => json({ title: "Unauthorized" }, 401)]]);
    const err = await x.publish(testContext(m401.fetch, app), account, post()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");
    const m429 = mockFetch([["POST https://api.x.com/2/tweets", () => json({ title: "Too Many Requests" }, 429)]]);
    await expect(x.publish(testContext(m429.fetch, app), account, post())).rejects.toMatchObject({ kind: "rate_limit" });
  });
});

describe("x reply", () => {
  it("replies to the parent without root-only settings", async () => {
    const m = mockFetch([["POST https://api.x.com/2/tweets", () => ({ data: { id: "5" } })]]);
    const r = await x.reply!(
      testContext(m.fetch, app),
      account,
      { rootId: "1", parentId: "4" },
      post({ content: "more", settings: { poll: true, pollOptions: ["a", "b"], replySettings: "verified" } }),
    );
    expect(r).toEqual({ externalId: "5", url: "https://x.com/jack/status/5" });
    expect(m.requests[0].json).toEqual({ text: "more", reply: { in_reply_to_tweet_id: "4" } });
  });

  it("rejects reply videos too big for one step before uploading anything", async () => {
    const m = mockFetch([]);
    const err = await x.reply!(testContext(m.fetch, app), account, { rootId: "1", parentId: "1" }, post({ media: [video({ size: 300 * 1024 * 1024 })] })).catch((e) => e);
    expect(err).toMatchObject({ kind: "invalid" });
    expect(m.requests).toHaveLength(0);
  });

  it("bounds reply processing polls by the subrequest budget", async () => {
    const m = mockFetch([
      ["POST https://api.x.com/2/media/upload/initialize", () => ({ data: { id: "v1" } })],
      ["POST https://api.x.com/2/media/upload/v1/append", () => new Response(null, { status: 204 })],
      ["POST https://api.x.com/2/media/upload/v1/finalize", () => ({ data: { id: "v1", processing_info: { state: "pending", check_after_secs: 0 } } })],
      ["GET https://api.x.com/2/media/upload", () => ({ data: { processing_info: { state: "in_progress", check_after_secs: 0 } } })],
    ]);
    const err = await x.reply!(hollowMedia(testContext(m.fetch, app)), account, { rootId: "1", parentId: "1" }, post({ media: [video({ size: 100 * 1024 * 1024 })] })).catch((e) => e);
    expect(err).toMatchObject({ kind: "transient" });
    expect(m.requests.length).toBeLessThanOrEqual(40);
  });

  it("rejects over-long replies", async () => {
    const m = mockFetch([]);
    await expect(
      x.reply!(testContext(m.fetch, app), account, { rootId: "1", parentId: "1" }, post({ content: "a".repeat(300) })),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("x metrics", () => {
  const item = (externalId: string) => ({ externalId, publishedAt: 0 });

  it("describes the metrics", () => {
    expect(x.metrics).toMatchObject({ batch: 100, scopes: ["tweet.read", "users.read"] });
  });

  it("fetches up to 100 posts in one call; not-found ids are null", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(1800000000000000000n + BigInt(i)));
    const m = mockFetch([
      [
        "GET https://api.x.com/2/tweets",
        () => ({
          data: [
            { id: ids[0], text: "hi", public_metrics: { retweet_count: 2, reply_count: 3, like_count: 10, quote_count: 1, bookmark_count: 4, impression_count: 500 } },
          ],
          errors: [{ value: ids[1], detail: "Could not find tweet", type: "https://api.twitter.com/2/problems/resource-not-found", resource_id: ids[1] }],
        }),
      ],
    ]);
    const res = await x.postMetrics!(testContext(m.fetch, app), account, ids.map(item));
    expect(m.requests).toHaveLength(1);
    const q = new URL(m.requests[0].url).searchParams;
    expect(q.get("ids")).toBe(ids.join(","));
    expect(q.get("tweet.fields")).toBe("public_metrics");
    expect(m.requests[0].headers.authorization).toBe("Bearer AT");
    expect(res[ids[0]]).toEqual({ impressions: 500, likes: 10, replies: 3, reposts: 2, quotes: 1, saves: 4 });
    expect(res[ids[1]]).toBeNull();
    expect(res[ids[99]]).toBeNull();
  });

  it("an app without read access is not_supported; usage caps back off", async () => {
    const forbidden = mockFetch([
      [
        "GET https://api.x.com/2/tweets",
        () =>
          json(
            { client_id: "1", reason: "client-not-enrolled", title: "Client Forbidden", type: "https://api.twitter.com/2/problems/client-forbidden", detail: "This request must be made using an approved developer account." },
            403,
          ),
      ],
    ]);
    const err = await x.postMetrics!(testContext(forbidden.fetch, app), account, [item("1")]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("not_supported");

    const capped = mockFetch([["GET https://api.x.com/2/tweets", () => json({ title: "UsageCapExceeded" }, 429)]]);
    await expect(x.postMetrics!(testContext(capped.fetch, app), account, [item("1")])).rejects.toMatchObject({ kind: "rate_limit" });
    const credits = mockFetch([["GET https://api.x.com/2/users/me", () => json({ title: "CreditsDepleted" }, 402)]]);
    await expect(x.accountMetrics!(testContext(credits.fetch, app), account)).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("account metrics from users/me public_metrics", async () => {
    const m = mockFetch([
      [
        "GET https://api.x.com/2/users/me",
        () => ({ data: { id: "12", username: "jack", public_metrics: { followers_count: 300, following_count: 20, tweet_count: 1500, listed_count: 7, like_count: 99 } } }),
      ],
    ]);
    expect(await x.accountMetrics!(testContext(m.fetch, app), account)).toEqual({ followers: 300, following: 20, posts: 1500, extra: { listed: 7 } });
    expect(new URL(m.requests[0].url).searchParams.get("user.fields")).toBe("public_metrics");
  });
});
