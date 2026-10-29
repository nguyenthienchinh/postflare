import { describe, expect, it } from "vitest";
import { chunkPlan, tiktok } from "../../worker/providers/tiktok";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { hollowMedia, image, json, lazyStream, mockFetch, testAccount, testContext, video } from "../helpers";

const app = { clientKey: "CK", clientSecret: "CS" };
const API = "https://open.tiktokapis.com/v2";
const UPLOAD = "https://open-upload.tiktokapis.com/video/?upload_id=U1";
const MB = 1024 * 1024;

const creator = (over: Record<string, unknown> = {}) => ({
  data: {
    creator_username: "me",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: true,
    stitch_disabled: false,
    max_video_post_duration_sec: 600,
    ...over,
  },
  error: { code: "ok" },
});
const ok = (data: unknown) => ({ data, error: { code: "ok", message: "" } });
const account = () => testAccount({ meta: { username: "me" } });
const post = (settings: Record<string, unknown> = { privacy_level: "SELF_ONLY" }, media = [video({ size: 5 * MB })]) => ({ id: "p1", content: "Caption #fyp", media, settings });

describe("tiktok", () => {
  it("builds the authorize URL", () => {
    const url = new URL(tiktok.authorize!(testContext(mockFetch([]).fetch, app, "tiktok"), { state: "S", codeVerifier: "V", codeChallenge: "CH" }) as string);
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("CK");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,user.info.profile,video.publish,video.upload");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/tiktok/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("S");
  });

  it("callback exchanges the code and loads the user", async () => {
    const m = mockFetch([
      ["POST https://open.tiktokapis.com/v2/oauth/token/", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 86400, refresh_expires_in: 31536000, open_id: "OID" })],
      ["GET https://open.tiktokapis.com/v2/user/info/", () => ok({ user: { open_id: "OID", display_name: "Me", username: "me", avatar_url: "https://a" } })],
    ]);
    const [acc] = await tiktok.callback!(testContext(m.fetch, app, "tiktok"), { code: "C", codeVerifier: "V", params: new URLSearchParams() });
    expect(m.requests[0].form).toMatchObject({ client_key: "CK", client_secret: "CS", code: "C", grant_type: "authorization_code", redirect_uri: "https://pf.example.com/oauth/tiktok/callback" });
    expect(m.requests[1].url).toContain("fields=open_id");
    expect(acc).toMatchObject({ externalId: "OID", name: "Me", username: "me", profileUrl: "https://www.tiktok.com/@me", credentials: { accessToken: "AT", refreshToken: "RT" } });
    expect(acc.expiresAt).toBeGreaterThan(Date.now());
    expect(acc.refreshExpiresAt).toBeGreaterThan(Date.now() + 364 * 86400_000);
  });

  it("refresh; a 200 with invalid_grant maps to auth", async () => {
    const m = mockFetch([["POST https://open.tiktokapis.com/v2/oauth/token/", () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 86400, refresh_expires_in: 86400 * 365 })]]);
    const u = await tiktok.refresh!(testContext(m.fetch, app), account());
    expect(u.refreshExpiresAt).toBeGreaterThan(Date.now() + 364 * 86400_000);
    expect(m.requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
    expect(u.credentials).toEqual({ accessToken: "AT2", refreshToken: "RT2" });

    const bad = mockFetch([["POST https://open.tiktokapis.com/v2/oauth/token/", () => ({ error: "invalid_grant", error_description: "expired" })]]);
    await expect(tiktok.refresh!(testContext(bad.fetch, app), account())).rejects.toMatchObject({ kind: "auth" });
  });

  it("plans chunks following TikTok's rules", () => {
    expect(chunkPlan(3 * MB)).toEqual({ chunkSize: 3 * MB, count: 1 });
    expect(chunkPlan(64 * MB)).toEqual({ chunkSize: 64 * MB, count: 1 });
    // 64-128MB: one 64MB "chunk" whose last (only) part carries the remainder.
    expect(chunkPlan(100 * MB)).toEqual({ chunkSize: 64 * MB, count: 1 });
    expect(chunkPlan(150 * MB)).toEqual({ chunkSize: 64 * MB, count: 2 });
    expect(chunkPlan(4096 * MB + 5)).toEqual({ chunkSize: 64 * MB, count: 64 });
  });

  it("direct-posts a video with chunked FILE_UPLOAD and polls the status", async () => {
    const size = 150 * MB + 7;
    const m = mockFetch([
      [`POST ${API}/post/publish/creator_info/query/`, () => creator()],
      [`POST ${API}/post/publish/video/init/`, () => ok({ publish_id: "v_pub_file~1", upload_url: UPLOAD })],
      ["PUT " + UPLOAD, (r) => new Response(null, { status: r.headers["content-range"].endsWith(`-${size - 1}/${size}`) ? 201 : 206 })],
      [`POST ${API}/post/publish/status/fetch/`, () => new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7412345678901234567]},"error":{"code":"ok"}}')],
    ]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    const res = await tiktok.publish(
      ctx,
      account(),
      post({ privacy_level: "PUBLIC_TO_EVERYONE", allowStitch: true, aiGenerated: true }, [video({ size })]),
    );
    expect(res.status).toBe("pending");
    const init = m.requests.find((r) => r.url.endsWith("/video/init/"))!;
    expect(init.json).toEqual({
      post_info: {
        title: "Caption #fyp",
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_comment: true,
        brand_content_toggle: false,
        brand_organic_toggle: false,
        disable_duet: true, // creator_info says duets are disabled
        disable_stitch: false,
        is_aigc: true,
      },
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: 64 * MB, total_chunk_count: 2 },
    });
    const puts = m.requests.filter((r) => r.method === "PUT").map((r) => r.headers["content-range"]);
    expect(puts).toEqual([`bytes 0-${64 * MB - 1}/${size}`, `bytes ${64 * MB}-${size - 1}/${size}`]);

    const state = (res as any).state;
    expect(state).toMatchObject({ phase: "status", publishId: "v_pub_file~1" });
    const done = await tiktok.checkStatus!(ctx, account(), state);
    expect(done).toEqual({
      status: "published",
      externalId: "7412345678901234567",
      url: "https://www.tiktok.com/@me/video/7412345678901234567",
      data: { publishId: "v_pub_file~1" },
    });
  });

  it("resumes an interrupted upload in checkStatus without a new init", async () => {
    const size = 200 * MB;
    let fail = true;
    const m = mockFetch([
      [`POST ${API}/post/publish/creator_info/query/`, () => creator()],
      [`POST ${API}/post/publish/video/init/`, () => ok({ publish_id: "v1", upload_url: UPLOAD })],
      [
        "PUT " + UPLOAD,
        (r) => {
          if (r.headers["content-range"].startsWith(`bytes ${64 * MB}-`) && fail) {
            fail = false;
            return new Response("oops", { status: 502 });
          }
          return new Response(null, { status: 206 });
        },
      ],
    ]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    const res = await tiktok.publish(ctx, account(), post({ privacy_level: "SELF_ONLY" }, [video({ size })]));
    expect(res).toMatchObject({ status: "pending", state: { phase: "upload", next: 1 } });
    const res2 = await tiktok.checkStatus!(ctx, account(), (res as any).state);
    expect(res2).toMatchObject({ status: "pending", state: { phase: "status", publishId: "v1" } });
    expect(m.requests.filter((r) => r.url.endsWith("/init/"))).toHaveLength(1);
    expect(m.requests.filter((r) => r.method === "PUT").map((r) => r.headers["content-range"])).toEqual([
      `bytes 0-${64 * MB - 1}/${size}`,
      `bytes ${64 * MB}-${128 * MB - 1}/${size}`,
      `bytes ${64 * MB}-${128 * MB - 1}/${size}`,
      `bytes ${128 * MB}-${size - 1}/${size}`,
    ]);
  });

  it("uploads a 2GB video in 64MB chunks within the per-call subrequest budget", async () => {
    const size = 2048 * MB;
    const m = mockFetch([
      [`POST ${API}/post/publish/creator_info/query/`, () => creator()],
      [`POST ${API}/post/publish/video/init/`, () => ok({ publish_id: "v2g", upload_url: UPLOAD })],
      ["PUT " + UPLOAD, () => new Response(null, { status: 206 })],
      [`POST ${API}/post/publish/status/fetch/`, () => ok({ status: "PROCESSING_UPLOAD" })],
    ]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    const ranges: number[][] = [];
    ctx.media.rangeStream = async (_v, offset, length) => (ranges.push([offset, length]), lazyStream(1));
    ctx.media.range = async () => {
      throw new Error("must not copy video bytes into memory");
    };
    const calls: number[] = [];
    let seen = 0;
    const track = () => (calls.push(m.requests.length - seen), (seen = m.requests.length));

    let res = await tiktok.publish(ctx, account(), post({ privacy_level: "SELF_ONLY" }, [video({ size })]));
    track();
    expect(res).toMatchObject({ status: "pending", state: { phase: "upload", next: 16 } });
    // Resume from serialized state, like the workflow does.
    while (res.status === "pending" && (res.state as any).phase === "upload") {
      res = await tiktok.checkStatus!(ctx, account(), JSON.parse(JSON.stringify(res.state)));
      track();
    }
    expect(res).toMatchObject({ status: "pending", state: { phase: "status", publishId: "v2g" } });
    expect(calls).toEqual([18, 16]); // creator_info + init + 16 PUTs, then 16 PUTs
    expect(Math.max(...calls)).toBeLessThanOrEqual(40);
    expect(m.requests.filter((r) => r.url.endsWith("/init/"))).toHaveLength(1);
    expect(ranges).toHaveLength(32);
    expect(ranges.every(([, len]) => len === 64 * MB)).toBe(true);
  });

  it("sends videos to the inbox with only source_info", async () => {
    const m = mockFetch([
      [`POST ${API}/post/publish/creator_info/query/`, () => creator()],
      [`POST ${API}/post/publish/inbox/video/init/`, () => ok({ publish_id: "v_inbox_1", upload_url: UPLOAD })],
      ["PUT " + UPLOAD, () => new Response(null, { status: 201 })],
      [`POST ${API}/post/publish/status/fetch/`, () => ok({ status: "SEND_TO_USER_INBOX" })],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await tiktok.publish(ctx, account(), post({ postMode: "inbox" }));
    const init = m.requests.find((r) => r.url.includes("/inbox/video/init/"))!;
    expect(init.json).toEqual({ source_info: { source: "FILE_UPLOAD", video_size: 5 * MB, chunk_size: 5 * MB, total_chunk_count: 1 } });
    const done = await tiktok.checkStatus!(ctx, account(), (res as any).state);
    expect(done).toMatchObject({ status: "published", externalId: "v_inbox_1", data: { inbox: true } });
  });

  it("posts photos via PULL_FROM_URL", async () => {
    const m = mockFetch([
      [`POST ${API}/post/publish/creator_info/query/`, () => creator()],
      [`POST ${API}/post/publish/content/init/`, () => ok({ publish_id: "p_pub_url~1" })],
      [`POST ${API}/post/publish/status/fetch/`, () => ok({ status: "PROCESSING_DOWNLOAD" })],
    ]);
    const ctx = testContext(m.fetch, app);
    const imgs = [image({ id: "a", url: "https://pf.example.com/m/a.jpg" }), image({ id: "b", url: "https://pf.example.com/m/b.jpg" })];
    const res = await tiktok.publish(ctx, account(), post({ privacy_level: "SELF_ONLY", title: "Title", autoAddMusic: true }, imgs));
    expect(m.requests[1].json).toEqual({
      post_info: {
        title: "Title",
        description: "Caption #fyp",
        privacy_level: "SELF_ONLY",
        disable_comment: true, // comments are opt-in
        brand_content_toggle: false,
        brand_organic_toggle: false,
        auto_add_music: true,
      },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: imgs.map((i) => i.url) },
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
    });
    const again = await tiktok.checkStatus!(ctx, account(), (res as any).state);
    expect(again.status).toBe("pending");
  });

  it("rejects a privacy level creator_info does not allow", async () => {
    const m = mockFetch([[`POST ${API}/post/publish/creator_info/query/`, () => creator()]]);
    await expect(tiktok.publish(testContext(m.fetch, app), account(), post({ privacy_level: "FOLLOWER_OF_CREATOR" }))).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(m.requests).toHaveLength(1);
  });

  it("FAILED status throws a readable invalid error", async () => {
    const m = mockFetch([[`POST ${API}/post/publish/status/fetch/`, () => ok({ status: "FAILED", fail_reason: "picture_size_check_failed" })]]);
    const err = await tiktok.checkStatus!(testContext(m.fetch, app), account(), { phase: "status", publishId: "p1", username: "me" }).catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(err.message).toContain("1080px");
  });

  it("privacy options come from creator_info", async () => {
    const m = mockFetch([[`POST ${API}/post/publish/creator_info/query/`, () => creator()]]);
    expect(await tiktok.options!(testContext(m.fetch, app), account(), "privacy_level", {})).toEqual([
      { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
      { value: "SELF_ONLY", label: "Only me" },
    ]);
  });

  it("maps 401 access_token_invalid to auth", async () => {
    const m = mockFetch([
      [`POST ${API}/post/publish/creator_info/query/`, () => json({ data: {}, error: { code: "access_token_invalid", message: "expired" } }, 401)],
    ]);
    await expect(tiktok.publish(testContext(m.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
  });

  it("validates media", () => {
    expect(tiktok.validate!(post({}, []))[0]).toContain("attach one video");
    expect(tiktok.validate!(post({}, [video(), image()]))).toContain("TikTok: a post is either one video or photos");
    expect(tiktok.validate!(post({}, [image({ mime: "image/png" })]))[0]).toContain("JPEG or WebP");
    expect(tiktok.validate!(post({}, [image({ width: 2000, height: 2000 })]))[0]).toContain("1080px");
    expect(tiktok.validate!(post())).toEqual([]);
  });
});

describe("tiktok content sharing guidelines", () => {
  it("has no default audience and opt-in interactions", () => {
    const privacy = tiktok.settingsFields.find((f) => f.key === "privacy_level")!;
    expect(privacy.default).toBeUndefined();
    expect(privacy.required).toBe(true);
    for (const key of ["allowComment", "allowDuet", "allowStitch", "commercialContent"]) {
      expect(tiktok.settingsFields.find((f) => f.key === key)?.default).toBe(false);
    }
    expect(tiktok.composerNotice).toContain("Music Usage Confirmation");
  });

  it("refuses to publish without a chosen audience", async () => {
    const m = mockFetch([[/creator_info/, () => creator()]]);
    await expect(tiktok.publish(testContext(m.fetch, app), account(), post({}))).rejects.toMatchObject({ kind: "invalid" });
  });

  it("requires a brand choice when commercial content is disclosed", () => {
    expect(tiktok.validate!(post({ privacy_level: "PUBLIC_TO_EVERYONE", commercialContent: true }))).toEqual([
      expect.stringContaining("You need to indicate if your content promotes yourself, a third party, or both."),
    ]);
  });
});

describe("tiktok error codes on non-2xx responses", () => {
  it("explains unaudited_client_can_only_post_to_private_accounts", async () => {
    const m = mockFetch([
      [/creator_info/, () => creator()],
      [
        /content\/init|video\/init/,
        () =>
          json(
            {
              error: {
                code: "unaudited_client_can_only_post_to_private_accounts",
                message: "Please review our integration guidelines at https://developers.tiktok.com/doc/content-sharing-guidelines/",
              },
            },
            403,
          ),
      ],
    ]);
    await expect(tiktok.publish(testContext(m.fetch, app), account(), post({ privacy_level: "SELF_ONLY" }))).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("Private account"),
    });
  });
});

describe("tiktok metrics", () => {
  const appOn = { ...app, analytics: "on" };
  const item = (externalId: string, data?: Record<string, unknown>) => ({ externalId, data, publishedAt: 0 });

  it("analytics scopes are only requested when turned on (TikTok rejects unapproved scopes)", () => {
    const url = new URL(tiktok.authorize!(testContext(mockFetch([]).fetch, appOn, "tiktok"), { state: "S", codeVerifier: "V", codeChallenge: "CH" }) as string);
    expect(url.searchParams.get("scope")).toBe("user.info.basic,user.info.profile,video.publish,video.upload,video.list,user.info.stats");
  });

  it("is not_supported without a request while analytics are off", async () => {
    const m = mockFetch([]);
    await expect(tiktok.postMetrics!(testContext(m.fetch, app), account(), [item("7400000000000000123")])).rejects.toMatchObject({ reason: "not_supported" });
    await expect(tiktok.accountMetrics!(testContext(m.fetch, app), account())).rejects.toMatchObject({ reason: "not_supported" });
    expect(m.requests).toHaveLength(0);
  });

  it("describes the metrics and their scopes", () => {
    expect(tiktok.metrics).toMatchObject({ batch: 20, scopes: ["video.list", "user.info.stats"], post: ["views", "likes", "comments", "shares"] });
  });

  it("queries the batch in one video/query call; publish ids are not sent and get null", async () => {
    const m = mockFetch([
      [
        `POST ${API}/video/query/`,
        // int64 ids as bare numbers must keep every digit
        () =>
          new Response(
            '{"data":{"videos":[{"id":7400000000000000123,"view_count":1000,"like_count":50,"comment_count":4,"share_count":3},{"id":"7400000000000000999","view_count":0,"like_count":0,"comment_count":0,"share_count":0}],"cursor":0,"has_more":false},"error":{"code":"ok","message":""}}',
          ),
      ],
    ]);
    const res = await tiktok.postMetrics!(testContext(m.fetch, appOn), account(), [
      item("7400000000000000123"),
      item("7400000000000000999"),
      item("7400000000000000555"),
      item("v_pub_file~v2-1.123"),
      item("p_pub_url~v2.456", { postId: "7400000000000000777" }),
    ]);
    expect(m.requests).toHaveLength(1);
    expect(new URL(m.requests[0].url).searchParams.get("fields")).toBe("id,view_count,like_count,comment_count,share_count");
    expect(m.requests[0].headers.authorization).toBe("Bearer AT");
    expect(m.requests[0].json).toEqual({ filters: { video_ids: ["7400000000000000123", "7400000000000000999", "7400000000000000555", "7400000000000000777"] } });
    expect(res).toEqual({
      "7400000000000000123": { views: 1000, likes: 50, comments: 4, shares: 3 },
      "7400000000000000999": { views: 0, likes: 0, comments: 0, shares: 0 },
      "7400000000000000555": null,
      "v_pub_file~v2-1.123": null,
      "p_pub_url~v2.456": null,
    });
  });

  it("makes no request when no item has a public post id", async () => {
    const m = mockFetch([]);
    expect(await tiktok.postMetrics!(testContext(m.fetch, appOn), account(), [item("v_pub_file~1")])).toEqual({ "v_pub_file~1": null });
    expect(m.requests).toHaveLength(0);
  });

  it("scope_not_authorized (401 or error code) means reconnect for analytics, not auth", async () => {
    const m401 = mockFetch([[`POST ${API}/video/query/`, () => json({ data: {}, error: { code: "scope_not_authorized", message: "The user did not authorize the scope required" } }, 401)]]);
    const err = await tiktok.postMetrics!(testContext(m401.fetch, appOn), account(), [item("7400000000000000123")]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
    const m200 = mockFetch([[`GET ${API}/user/info/`, () => ({ data: {}, error: { code: "scope_not_authorized", message: "" } })]]);
    await expect(tiktok.accountMetrics!(testContext(m200.fetch, appOn), account())).rejects.toMatchObject({ reason: "reconnect_required" });
  });

  it("an invalid token is still auth", async () => {
    const m = mockFetch([[`GET ${API}/user/info/`, () => json({ data: {}, error: { code: "access_token_invalid", message: "" } }, 401)]]);
    await expect(tiktok.accountMetrics!(testContext(m.fetch, appOn), account())).rejects.toMatchObject({ kind: "auth" });
  });

  it("account metrics from user/info stats", async () => {
    const m = mockFetch([
      [`GET ${API}/user/info/`, () => ok({ user: { follower_count: 1200, following_count: 15, likes_count: 98000, video_count: 42 } })],
    ]);
    expect(await tiktok.accountMetrics!(testContext(m.fetch, appOn), account())).toEqual({ followers: 1200, following: 15, posts: 42, extra: { total_likes: 98000 } });
    expect(new URL(m.requests[0].url).searchParams.get("fields")).toBe("follower_count,following_count,likes_count,video_count");
  });
});
