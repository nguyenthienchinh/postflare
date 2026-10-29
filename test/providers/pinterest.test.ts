import { afterEach, describe, expect, it, vi } from "vitest";
import { counted } from "../../worker/providers/budget";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { pinterest } from "../../worker/providers/pinterest";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const app = { clientId: "cid", clientSecret: "csecret" };
const account = testAccount({ provider: "pinterest" });
const post = (over: Partial<Parameters<typeof pinterest.publish>[2]> = {}) => ({
  id: "p1",
  content: "Nice pin",
  media: [image()],
  settings: { board: "123" },
  ...over,
});

describe("pinterest oauth", () => {
  it("builds the authorize URL", async () => {
    const url = new URL(await pinterest.authorize!(testContext(mockFetch([]).fetch, app, "pinterest"), { state: "st", codeVerifier: "", codeChallenge: "" }));
    expect(url.origin + url.pathname).toBe("https://www.pinterest.com/oauth/");
    expect(url.searchParams.get("scope")).toBe("boards:read,boards:write,pins:read,pins:write,user_accounts:read");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/pinterest/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("exchanges the code with basic auth", async () => {
    const m = mockFetch([
      ["POST https://api.pinterest.com/v5/oauth/token", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 2592000 })],
      ["GET https://api.pinterest.com/v5/user_account", () => ({ id: "u1", username: "maker", profile_image: "https://img" })],
    ]);
    const [acc] = await pinterest.callback!(testContext(m.fetch, app), { code: "c", codeVerifier: "", params: new URLSearchParams() });
    expect(acc).toMatchObject({ externalId: "u1", username: "maker", credentials: { accessToken: "AT", refreshToken: "RT" } });
    expect(m.requests[0].headers.authorization).toBe(`Basic ${btoa("cid:csecret")}`);
    expect(m.requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "c" });
  });

  it("refreshes and keeps the refresh token when not rotated", async () => {
    const m = mockFetch([["POST https://api.pinterest.com/v5/oauth/token", () => ({ access_token: "AT2", expires_in: 100 })]]);
    const upd = await pinterest.refresh!(testContext(m.fetch, app), account);
    expect(upd.credentials).toMatchObject({ accessToken: "AT2", refreshToken: "RT" });
    expect(m.requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
  });

  it("uses the sandbox API when configured", async () => {
    const m = mockFetch([["POST https://api-sandbox.pinterest.com/v5/pins", () => ({ id: "9" })]]);
    await pinterest.publish(testContext(m.fetch, { ...app, sandbox: "true" }), account, post());
    expect(m.requests[0].url).toBe("https://api-sandbox.pinterest.com/v5/pins");
  });
});

describe("pinterest options", () => {
  it("lists boards across pages and board sections", async () => {
    const m = mockFetch([
      [/\/v5\/boards\?.*bookmark=b2/, () => ({ items: [{ id: "2", name: "Second", privacy: "SECRET" }], bookmark: null })],
      ["GET https://api.pinterest.com/v5/boards/1/sections", () => ({ items: [{ id: "s1", name: "Ideas" }] })],
      ["GET https://api.pinterest.com/v5/boards", () => ({ items: [{ id: "1", name: "First" }], bookmark: "b2" })],
    ]);
    const ctx = testContext(m.fetch, app);
    expect(await pinterest.options!(ctx, account, "board", {})).toEqual([
      { value: "1", label: "First" },
      { value: "2", label: "Second (secret)" },
    ]);
    expect(await pinterest.options!(ctx, account, "boardSection", { board: "1" })).toEqual([{ value: "s1", label: "Ideas" }]);
    expect(await pinterest.options!(ctx, account, "boardSection", {})).toEqual([]);
  });
});

describe("pinterest publish", () => {
  it("creates an image pin with settings", async () => {
    const m = mockFetch([["POST https://api.pinterest.com/v5/pins", () => json({ id: "77" }, 201)]]);
    const res = await pinterest.publish(
      testContext(m.fetch, app),
      account,
      post({ settings: { board: "123", boardSection: "s1", title: "T", link: "https://example.com", dominantColor: "6E7874" } }),
    );
    expect(res).toEqual({ status: "published", externalId: "77", url: "https://www.pinterest.com/pin/77/" });
    expect(m.requests[0].json).toEqual({
      board_id: "123",
      board_section_id: "s1",
      title: "T",
      description: "Nice pin",
      link: "https://example.com",
      alt_text: "alt text",
      dominant_color: "#6E7874",
      media_source: { source_type: "image_url", url: image().url },
    });
  });

  it("creates a carousel from multiple images", async () => {
    const m = mockFetch([["POST https://api.pinterest.com/v5/pins", () => ({ id: "78" })]]);
    const imgs = [image(), image({ id: "b", url: "https://pf.example.com/m/b.jpg" })];
    await pinterest.publish(testContext(m.fetch, app), account, post({ media: imgs }));
    expect(m.requests[0].json.media_source).toEqual({
      source_type: "multiple_image_urls",
      items: [{ url: imgs[0].url }, { url: imgs[1].url }],
    });
  });

  it("uploads a video to S3 with the form fields, then pins once processed", async () => {
    let status = "processing";
    const m = mockFetch([
      [
        "POST https://api.pinterest.com/v5/media",
        () => ({ media_id: "m1", upload_url: "https://pinterest-media-upload.s3.amazonaws.com/", upload_parameters: { key: "uploads/x.mp4", policy: "pol", "x-amz-signature": "sig" } }),
      ],
      ["POST https://pinterest-media-upload.s3.amazonaws.com/", () => new Response(null, { status: 204 })],
      ["GET https://api.pinterest.com/v5/media/m1", () => ({ media_id: "m1", status })],
      ["POST https://api.pinterest.com/v5/pins", () => ({ id: "79" })],
    ]);
    const ctx = testContext(m.fetch, app);
    const vid = video({ size: 50_000 });
    const res = await pinterest.publish(ctx, account, post({ media: [vid, image()] }));
    expect(res.status).toBe("pending");
    const s3 = m.requests[1];
    expect(s3.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(s3.body).toContain('name="key"\r\n\r\nuploads/x.mp4');
    expect(s3.body).toContain('name="x-amz-signature"\r\n\r\nsig');
    expect(s3.body).toContain('name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4');
    expect(s3.body!.indexOf('name="policy"')).toBeLessThan(s3.body!.indexOf('name="file"'));
    expect(m.requests.some((r) => r.url.endsWith("/pins"))).toBe(false);

    const state = (res as any).state;
    expect(await pinterest.checkStatus!(ctx, account, state)).toMatchObject({ status: "pending" });
    status = "succeeded";
    expect(await pinterest.checkStatus!(ctx, account, state)).toMatchObject({ status: "published", externalId: "79" });
    expect(m.requests.at(-1)!.json.media_source).toEqual({ source_type: "video_id", media_id: "m1", cover_image_url: image().url });
  });

  it("uses a key frame cover without an image and fails on failed processing", async () => {
    const m = mockFetch([
      ["POST https://api.pinterest.com/v5/media", () => ({ media_id: "m2", upload_url: "https://s3.example/", upload_parameters: {} })],
      ["POST https://s3.example/", () => new Response(null, { status: 204 })],
      ["GET https://api.pinterest.com/v5/media/m2", () => ({ status: "failed" })],
    ]);
    const ctx = testContext(m.fetch, app);
    const res: any = await pinterest.publish(ctx, account, post({ media: [video({ size: 10 })] }));
    expect(res.state.draft.media_source).toEqual({ source_type: "video_id", media_id: "m2", cover_image_key_frame_time: 0 });
    await expect(pinterest.checkStatus!(ctx, account, res.state)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("validates", () => {
    expect(pinterest.validate!(post({ settings: {} }))).toContain('Pinterest: "Board" is required');
    expect(pinterest.validate!(post({ media: [video(), image(), image()] }))).toHaveLength(1);
    expect(pinterest.validate!(post({ media: [image(), image({ width: 500 })] }))).toHaveLength(1);
    expect(pinterest.validate!(post())).toEqual([]);
  });

  it("maps 401 to auth", async () => {
    const m = mockFetch([["POST https://api.pinterest.com/v5/pins", () => json({ code: 2, message: "Authentication failed." }, 401)]]);
    await expect(pinterest.publish(testContext(m.fetch, app), account, post())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("pinterest metrics", () => {
  const NOW = Date.UTC(2026, 9, 12, 12);
  afterEach(() => vi.useRealTimers());
  const analytics = (summary: Record<string, number>) => ({ all: { summary_metrics: summary, daily_metrics: [] } });

  it("declares per-pin metrics with a small batch", () => {
    expect(pinterest.metrics).toMatchObject({ batch: 10, account: ["followers", "following", "posts"] });
  });

  it("fetches each pin's analytics since publishing and maps the totals", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const m = mockFetch([
      ["GET https://api.pinterest.com/v5/pins/1/analytics", () => analytics({ IMPRESSION: 100, SAVE: 4, PIN_CLICK: 7, OUTBOUND_CLICK: 3, TOTAL_COMMENTS: 1, TOTAL_REACTIONS: 2 })],
      [
        "GET https://api.pinterest.com/v5/pins/2/analytics",
        () => ({
          all: {
            daily_metrics: [
              { data_status: "READY", date: "2026-10-01", metrics: { IMPRESSION: 5, SAVE: 1 } },
              { data_status: "READY", date: "2026-10-02", metrics: { IMPRESSION: 6, PIN_CLICK: 2 } },
              { data_status: "PROCESSING", date: "2026-10-03", metrics: { IMPRESSION: 99 } },
            ],
          },
        }),
      ],
      ["GET https://api.pinterest.com/v5/pins/3/analytics", () => json({ code: 50, message: "Pin not found." }, 404)],
    ]);
    const res = await pinterest.postMetrics!(testContext(m.fetch, app), account, [
      { externalId: "1", publishedAt: NOW - 3 * 86_400_000 },
      { externalId: "2", publishedAt: NOW - 200 * 86_400_000 },
      { externalId: "3", publishedAt: NOW },
    ]);
    expect(res["1"]).toEqual({ impressions: 100, saves: 4, clicks: 10, likes: 2, comments: 1, extra: { outbound_clicks: 3, pin_clicks: 7 } });
    expect(res["2"]).toEqual({ impressions: 11, saves: 1, clicks: 2, extra: { pin_clicks: 2 } });
    expect(res["3"]).toBeNull();
    const q = (i: number) => new URL(m.requests.find((r) => r.url.includes(`/pins/${i}/`))!.url).searchParams;
    expect(q(1).get("start_date")).toBe("2026-10-09");
    expect(q(1).get("end_date")).toBe("2026-10-12");
    expect(q(1).get("metric_types")).toContain("IMPRESSION");
    // Older than 90 days: clamped to the oldest allowed day.
    expect(q(2).get("start_date")).toBe("2026-07-15");
  });

  it("stops at the fetch budget and leaves the rest out", async () => {
    const m = mockFetch([[/\/v5\/pins\/\w+\/analytics/, () => analytics({ IMPRESSION: 1 })]]);
    const items = ["a", "b", "c", "d"].map((externalId) => ({ externalId, publishedAt: Date.now() }));
    const res = await pinterest.postMetrics!(counted(testContext(m.fetch, app), 2), account, items);
    expect(m.requests).toHaveLength(2);
    expect(Object.keys(res)).toEqual(["a", "b"]);
  });

  it("signals reconnect_required when a scope is missing", async () => {
    const m = mockFetch([[/analytics/, () => json({ code: 403, message: "Not authorized to access the requested scope: pins:read" }, 403)]]);
    const err = await pinterest.postMetrics!(testContext(m.fetch, app), account, [{ externalId: "1", publishedAt: Date.now() }]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
  });

  it("reads account metrics", async () => {
    const m = mockFetch([["GET https://api.pinterest.com/v5/user_account", () => ({ username: "maker", follower_count: 50, following_count: 3, pin_count: 12, monthly_views: 900 })]]);
    expect(await pinterest.accountMetrics!(testContext(m.fetch, app), account)).toEqual({ followers: 50, following: 3, posts: 12, extra: { monthly_views: 900 } });
  });
});
