import { describe, expect, it } from "vitest";
import { counted } from "../../worker/providers/budget";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { facebook } from "../../worker/providers/facebook";
import { ProviderError } from "../../worker/providers/errors";
import { classifyGraphError, FB_GRAPH } from "../../worker/providers/meta-shared";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

/** mockFetch accepting plain values (or Responses) as handlers. */
const mf = (routes: Array<[string | RegExp, unknown]>) =>
  mockFetch(routes.map(([k, h]) => [k, typeof h === "function" ? (h as any) : () => (h instanceof Response ? h.clone() : h)]));
const APP = { clientId: "APPID", clientSecret: "SECRET" };
const page = () => testAccount({ provider: "facebook", externalId: "PAGE1", credentials: { accessToken: "PAGETOKEN" } });
const post = (over: Partial<Parameters<typeof facebook.publish>[2]> = {}) => ({ id: "p1", content: "Hello", media: [], settings: {}, ...over });

describe("facebook", () => {
  it("builds the authorize URL", async () => {
    const ctx = testContext(mf([]).fetch, APP, "facebook");
    const url = new URL(await facebook.authorize!(ctx, { state: "ST", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toMatch(/^https:\/\/www\.facebook\.com\/v\d+\.0\/dialog\/oauth$/);
    expect(url.searchParams.get("client_id")).toBe("APPID");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/facebook/callback");
    expect(url.searchParams.get("state")).toBe("ST");
    expect(url.searchParams.get("scope")).toContain("pages_manage_posts");
    // Nothing that forces a new login (it would end the user's session on the platform's website).
    for (const k of ["force_reauth", "auth_type"]) expect(url.searchParams.has(k)).toBe(false);
  });

  it("uses config_id for Login for Business", async () => {
    const ctx = testContext(mf([]).fetch, { ...APP, configId: "CFG" }, "facebook");
    const url = new URL(await facebook.authorize!(ctx, { state: "ST", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.searchParams.get("config_id")).toBe("CFG");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("exchanges the code and returns one account per page", async () => {
    const m = mf([
      [
        /oauth\/access_token/,
        (r: any) => (new URL(r.url).searchParams.get("grant_type") === "fb_exchange_token" ? { access_token: "LONG", expires_in: 5e6 } : { access_token: "SHORT" }),
      ],
      [
        `GET ${FB_GRAPH}/me/accounts`,
        {
          data: [
            { id: "PAGE1", name: "Page One", username: "pageone", access_token: "PT1", picture: { data: { url: "https://img/1" } }, tasks: ["CREATE_CONTENT"] },
            { id: "PAGE2", name: "Read only", access_token: "PT2", tasks: ["ANALYZE"] },
          ],
          paging: { next: `${FB_GRAPH}/me/accounts?after=X&access_token=LONG` },
        },
      ],
      [`GET ${FB_GRAPH}/me/businesses`, { data: [{ id: "BIZ" }] }],
      [`GET ${FB_GRAPH}/BIZ/owned_pages`, { data: [{ id: "PAGE3", name: "Biz page", access_token: "PT3" }, { id: "PAGE1", name: "dup", access_token: "x" }] }],
      [`GET ${FB_GRAPH}/BIZ/client_pages`, json({ error: { message: "no", code: 200 } }, 400)],
      [`GET ${FB_GRAPH}/me?`, { id: "FBUSER" }],
    ]);
    const ctx = testContext(m.fetch, APP, "facebook");
    const accounts = await facebook.callback!(ctx, { code: "CODE", codeVerifier: "v", params: new URLSearchParams() });
    expect(accounts.map((a) => a.externalId)).toEqual(["PAGE1", "PAGE3"]);
    expect(accounts[0]).toMatchObject({ name: "Page One", username: "pageone", avatarUrl: "https://img/1", credentials: { accessToken: "PT1" }, expiresAt: null });
    // The Facebook user who logged in: matched by Meta's data deletion callback.
    expect(accounts[1].meta).toEqual({ pageId: "PAGE3", metaUserId: "FBUSER" });
    const first = new URL(m.requests[0].url);
    expect(first.searchParams.get("code")).toBe("CODE");
    expect(first.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/facebook/callback");
    expect(new URL(m.requests[1].url).searchParams.get("fb_exchange_token")).toBe("SHORT");
    expect(new URL(m.requests[2].url).searchParams.get("access_token")).toBe("LONG");
  });

  it("publishes a text post with link", async () => {
    const m = mf([
      [`POST ${FB_GRAPH}/PAGE1/feed`, { id: "PAGE1_99" }],
      [`GET ${FB_GRAPH}/PAGE1_99`, { permalink_url: "https://www.facebook.com/pageone/posts/99" }],
    ]);
    const res = await facebook.publish(testContext(m.fetch), page(), post({ settings: { url: "https://example.com" } }));
    expect(res).toEqual({ status: "published", externalId: "PAGE1_99", url: "https://www.facebook.com/pageone/posts/99" });
    expect(m.requests[0].json).toEqual({ message: "Hello", link: "https://example.com", published: true });
    expect(new URL(m.requests[0].url).searchParams.get("access_token")).toBe("PAGETOKEN");
  });

  it("falls back to plain text when the background preset is rejected", async () => {
    let calls = 0;
    const m = mf([
      [`POST ${FB_GRAPH}/PAGE1/feed`, () => (++calls === 1 ? json({ error: { message: "Invalid text_format_preset_id", code: 100 } }, 400) : { id: "P_1" })],
      [`GET ${FB_GRAPH}/P_1`, json({ error: { message: "x", code: 100 } }, 400)],
    ]);
    const ctx = testContext(m.fetch);
    const res = await facebook.publish(ctx, page(), post({ settings: { text_format_preset_id: "123" } }));
    expect(res).toMatchObject({ status: "published", externalId: "P_1", url: "https://www.facebook.com/P_1" });
    expect(m.requests[0].json.text_format_preset_id).toBe("123");
    expect(m.requests[1].json.text_format_preset_id).toBeUndefined();
  });

  it("publishes multiple photos, re-encoding unsupported formats", async () => {
    let n = 0;
    const m = mf([
      [`POST ${FB_GRAPH}/PAGE1/photos`, () => ({ id: `PH${++n}` })],
      [`POST ${FB_GRAPH}/PAGE1/feed`, { id: "PAGE1_5" }],
      [`GET ${FB_GRAPH}/PAGE1_5`, { permalink_url: "https://fb/p/5" }],
    ]);
    const res = await facebook.publish(
      testContext(m.fetch),
      page(),
      post({ media: [image(), image({ id: "w", mime: "image/webp", filename: "a.webp" })] }),
    );
    expect(res).toMatchObject({ status: "published", externalId: "PAGE1_5" });
    expect(m.requests[0].json).toEqual({ url: image().url, published: false, alt_text_custom: "alt text" });
    const fd = m.requests[1].formData!;
    expect(fd.get("published")).toBe("false");
    expect((fd.get("source") as File).name).toBe("a.jpg");
    expect(m.requests[2].json.attached_media).toEqual([{ media_fbid: "PH1" }, { media_fbid: "PH2" }]);
  });

  it("publishes a video and polls until it is ready", async () => {
    let ready = false;
    const m = mf([
      [`POST ${FB_GRAPH}/PAGE1/videos`, { id: "VID" }],
      [
        `GET ${FB_GRAPH}/VID`,
        (r: any) =>
          new URL(r.url).searchParams.get("fields") === "status"
            ? { status: { video_status: ready ? "ready" : "processing" } }
            : { permalink_url: "/pageone/videos/VID/" },
      ],
    ]);
    const ctx = testContext(m.fetch);
    const res = await facebook.publish(ctx, page(), post({ media: [video()], settings: { title: "My video" } }));
    expect(res.status).toBe("pending");
    expect(m.requests[0].json).toMatchObject({ file_url: video().url, description: "Hello", title: "My video", published: true });
    const state = (res as any).state;
    expect(await facebook.checkStatus!(ctx, page(), state)).toMatchObject({ status: "pending" });
    ready = true;
    expect(await facebook.checkStatus!(ctx, page(), state)).toEqual({
      status: "published",
      externalId: "VID",
      url: "https://www.facebook.com/pageone/videos/VID/",
    });
  });

  it("publishes a reel: upload, finish once uploaded, then wait for publishing", async () => {
    let phase = "uploading";
    const m = mf([
      [
        `POST ${FB_GRAPH}/PAGE1/video_reels`,
        (r: any) => (r.json.upload_phase === "start" ? { video_id: "R1", upload_url: "https://rupload.facebook.com/video-upload/v25.0/R1" } : { success: true }),
      ],
      ["POST https://rupload.facebook.com/", { success: true }],
      [
        `GET ${FB_GRAPH}/R1`,
        () => ({
          status: {
            video_status: phase === "live" ? "ready" : "processing",
            uploading_phase: { status: phase === "uploading" ? "in_progress" : "complete" },
            publishing_phase: { status: phase === "live" ? "complete" : "not_started" },
          },
        }),
      ],
    ]);
    const ctx = testContext(m.fetch);
    const res = await facebook.publish(ctx, page(), post({ media: [video()], settings: { post_type: "reel" } }));
    const upload = m.requests.find((r) => r.url.startsWith("https://rupload"))!;
    expect(upload.headers.authorization).toBe("OAuth PAGETOKEN");
    expect(upload.headers.file_url).toBe(video().url);
    let r = await facebook.checkStatus!(ctx, page(), (res as any).state);
    expect(r).toMatchObject({ status: "pending", state: { finished: false } });
    phase = "processing";
    r = await facebook.checkStatus!(ctx, page(), (r as any).state);
    expect(r).toMatchObject({ status: "pending", state: { finished: true } });
    const finish = m.requests.filter((x) => x.json?.upload_phase === "finish");
    expect(finish).toHaveLength(1);
    expect(finish[0].json).toMatchObject({ video_id: "R1", video_state: "PUBLISHED", description: "Hello" });
    phase = "live";
    expect(await facebook.checkStatus!(ctx, page(), (r as any).state)).toEqual({
      status: "published",
      externalId: "R1",
      url: "https://www.facebook.com/reel/R1",
    });
  });

  it("publishes stories one at a time", async () => {
    const m = mf([
      [`POST ${FB_GRAPH}/PAGE1/photos`, { id: "PH1" }],
      [`POST ${FB_GRAPH}/PAGE1/video_stories`, (r: any) => (r.json.upload_phase === "start" ? { video_id: "VS1", upload_url: "https://rupload.facebook.com/x/VS1" } : { success: true, post_id: "S2" })],
      ["POST https://rupload.facebook.com/", { success: true }],
      [`POST ${FB_GRAPH}/PAGE1/photo_stories`, { success: true, post_id: "S1" }],
      [`GET ${FB_GRAPH}/VS1`, { status: { video_status: "upload_complete", uploading_phase: { status: "complete" } } }],
    ]);
    const ctx = testContext(m.fetch);
    const res = await facebook.publish(ctx, page(), post({ media: [image(), video()], settings: { post_type: "story" } }));
    expect(res).toMatchObject({ status: "pending", state: { kind: "story", items: [{ kind: "photo", id: "PH1" }, { kind: "video", id: "VS1" }], done: 0 } });
    const r1 = await facebook.checkStatus!(ctx, page(), (res as any).state);
    expect(r1).toMatchObject({ status: "pending", state: { done: 1, lastPostId: "S1" } });
    const r2 = await facebook.checkStatus!(ctx, page(), (r1 as any).state);
    expect(r2).toMatchObject({ status: "published", externalId: "S2" });
    expect(m.requests.filter((x) => x.url.includes("photo_stories"))).toHaveLength(1);
  });

  it("rejects a story without media", async () => {
    await expect(facebook.publish(testContext(mf([]).fetch), page(), post({ settings: { post_type: "story" } }))).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("comments on the root post", async () => {
    const m = mf([
      [`POST ${FB_GRAPH}/PAGE1_99/comments`, { id: "99_555" }],
    ]);
    const r = await facebook.reply!(testContext(m.fetch), page(), { rootId: "PAGE1_99", parentId: "C0" }, post({ content: "First!", media: [image()] }));
    // The comment's own link, built without a Graph round trip.
    expect(r).toEqual({ externalId: "99_555", url: "https://www.facebook.com/PAGE1_99?comment_id=555" });
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0].json).toEqual({ message: "First!", attachment_url: image().url });
  });

  it("maps Graph errors", async () => {
    const m = mf([[`POST ${FB_GRAPH}/PAGE1/feed`, json({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, 400)]]);
    const err = await facebook.publish(testContext(m.fetch), page(), post()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");

    const m401 = mf([[`POST ${FB_GRAPH}/PAGE1/feed`, json({}, 401)]]);
    expect((await facebook.publish(testContext(m401.fetch), page(), post()).catch((e) => e)).kind).toBe("auth");

    expect(classifyGraphError(400, { error: { code: 100, type: "OAuthException" } })).toBeUndefined();
    expect(classifyGraphError(400, { error: { code: 32 } })).toBe("rate_limit");
    expect(classifyGraphError(400, { error: { code: 613 } })).toBe("rate_limit");
    expect(classifyGraphError(500, { error: { code: 99, is_transient: true } })).toBe("transient");
    expect(classifyGraphError(400, { error: { code: 200, error_subcode: 463 } })).toBe("auth");
  });
});

describe("facebook metrics", () => {
  const item = (externalId: string) => ({ externalId, publishedAt: 0 });
  const ins = (v: Record<string, number>) => ({ data: Object.entries(v).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }] })) });
  const batchMock = (reply: (url: string) => [number, unknown] | null) =>
    mf([
      [
        `POST ${FB_GRAPH}`,
        (r: any) => JSON.parse(r.form.batch).map((b: any) => {
          const out = reply(b.relative_url);
          return out && { code: out[0], body: JSON.stringify(out[1]) };
        }),
      ],
    ]);

  it("requests read_insights", async () => {
    const url = new URL(await facebook.authorize!(testContext(mf([]).fetch, APP, "facebook"), { state: "S", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.searchParams.get("scope")).toContain("read_insights");
    expect(facebook.setupNotes).toContain("read_insights");
  });

  it("batches counts and insights of posts and videos into one request", async () => {
    const m = batchMock((u) => {
      if (u.startsWith("PAGE1_1?")) return [200, { id: "PAGE1_1", shares: { count: 4 }, reactions: { summary: { total_count: 30 } }, comments: { summary: { total_count: 5 } } }];
      if (u.startsWith("PAGE1_1/insights")) return [200, ins({ post_media_view: 1000, post_total_media_view_unique: 700, post_clicks: 12 })];
      if (u.startsWith("PAGE1_2?")) return [200, { id: "PAGE1_2", reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } } }];
      if (u.startsWith("PAGE1_2/insights")) return [400, { error: { message: "(#100) Invalid metric", code: 100 } }];
      if (u.startsWith("V1?")) return [200, { id: "V1", likes: { summary: { total_count: 9 } }, comments: { summary: { total_count: 2 } } }];
      if (u.startsWith("V1/video_insights")) return [200, ins({ fb_reels_total_plays: 3000, post_impressions_unique: 2500 })];
      return [400, { error: { message: "Object with ID does not exist", code: 100, error_subcode: 33 } }];
    });
    const ctx = testContext(m.fetch, APP);
    const res = await facebook.postMetrics!(ctx, page(), [item("PAGE1_1"), item("PAGE1_2"), item("V1"), item("PAGE1_GONE")]);
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0].form!.access_token).toBe("PAGETOKEN");
    expect(JSON.parse(m.requests[0].form!.batch).map((b: any) => b.relative_url)).toEqual([
      "PAGE1_1?fields=shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
      "PAGE1_1/insights?metric=post_media_view,post_total_media_view_unique,post_clicks",
      "PAGE1_2?fields=shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
      "PAGE1_2/insights?metric=post_media_view,post_total_media_view_unique,post_clicks",
      "V1?fields=likes.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
      "V1/video_insights",
      "PAGE1_GONE?fields=shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
      "PAGE1_GONE/insights?metric=post_media_view,post_total_media_view_unique,post_clicks",
    ]);
    expect(res).toEqual({
      PAGE1_1: { likes: 30, comments: 5, shares: 4, views: 1000, reach: 700, clicks: 12 },
      // Insights failed (not a permission problem): counts are still reported.
      PAGE1_2: { likes: 0, comments: 0, shares: 0 },
      V1: { likes: 9, comments: 2, views: 3000, reach: 2500 },
      PAGE1_GONE: null,
    });
  });

  it("signals reconnect_required when read_insights is missing", async () => {
    const m = batchMock((u) =>
      u.includes("/insights") ? [403, { error: { message: "(#200) Requires read_insights permission", code: 200 } }] : [200, { id: "x" }],
    );
    const err = await facebook.postMetrics!(testContext(m.fetch, APP), page(), [item("PAGE1_1")]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
  });

  it("does not fetch without budget", async () => {
    const m = mf([]);
    expect(await facebook.postMetrics!(counted(testContext(m.fetch, APP), 0), page(), [item("PAGE1_1")])).toEqual({});
    expect(m.requests).toHaveLength(0);
  });

  it("reads page followers and fans", async () => {
    const m = mf([[`GET ${FB_GRAPH}/PAGE1`, { followers_count: 500, fan_count: 450, id: "PAGE1" }]]);
    expect(await facebook.accountMetrics!(testContext(m.fetch, APP), page())).toEqual({ followers: 500, extra: { fans: 450 } });
    expect(new URL(m.requests[0].url).searchParams.get("fields")).toBe("followers_count,fan_count");
  });
});
