import { describe, expect, it } from "vitest";
import { counted } from "../../worker/providers/budget";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { instagram } from "../../worker/providers/instagram";
import { FB_GRAPH } from "../../worker/providers/meta-shared";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const mf = (routes: Array<[string | RegExp, unknown]>) =>
  mockFetch(routes.map(([k, h]) => [k, typeof h === "function" ? (h as any) : () => (h instanceof Response ? h.clone() : h)]));
const APP = { clientId: "APPID", clientSecret: "SECRET" };
const acc = () => testAccount({ provider: "instagram", externalId: "IG1", username: "brand", credentials: { accessToken: "PT" } });
const post = (over: Record<string, any> = {}) => ({ id: "p1", content: "Caption #tag", media: [image()], settings: {}, ...over });

/** Container mock: each POST /media returns C1, C2...; statuses are read from `statuses`. */
function igMock(statuses: Record<string, string>, extra: Array<[string | RegExp, unknown]> = []) {
  let n = 0;
  return mf([
    [`POST ${FB_GRAPH}/IG1/media_publish`, (r: any) => ({ id: `M_${r.form.creation_id}` })],
    [`POST ${FB_GRAPH}/IG1/media`, (r: any) => ({ id: r.form.media_type === "CAROUSEL" ? "PARENT" : `C${++n}` })],
    ...extra,
    [
      new RegExp(`^${FB_GRAPH.replace(/\./g, "\\.")}/(C\\d+|PARENT)\\?`),
      (r: any) => ({ status_code: statuses[new URL(r.url).pathname.split("/").pop()!] ?? "FINISHED" }),
    ],
    [new RegExp(`^${FB_GRAPH.replace(/\./g, "\\.")}/M_`), (r: any) => ({ permalink: `https://www.instagram.com/p/${new URL(r.url).pathname.split("/").pop()}/` })],
  ]);
}

describe("instagram (facebook login)", () => {
  it("builds the authorize URL", async () => {
    const url = new URL(await instagram.authorize!(testContext(mf([]).fetch, APP, "instagram"), { state: "S", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("scope")).toContain("instagram_content_publish");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/instagram/callback");
    expect(url.searchParams.get("state")).toBe("S");
    for (const k of ["force_reauth", "auth_type"]) expect(url.searchParams.has(k)).toBe(false);
  });

  it("returns one account per linked Instagram account", async () => {
    const m = mf([
      [/oauth\/access_token/, { access_token: "TOKEN" }],
      [
        `GET ${FB_GRAPH}/me/accounts`,
        {
          data: [
            { id: "PG1", name: "Page", access_token: "PT1", instagram_business_account: { id: "IG1", username: "brand", name: "Brand", profile_picture_url: "https://pic" } },
            { id: "PG2", name: "No IG", access_token: "PT2" },
          ],
        },
      ],
      [`GET ${FB_GRAPH}/me/businesses`, { data: [] }],
      [`GET ${FB_GRAPH}/me?`, { id: "FBUSER" }],
    ]);
    const accounts = await instagram.callback!(testContext(m.fetch, APP, "instagram"), { code: "C", codeVerifier: "v", params: new URLSearchParams() });
    expect(accounts).toEqual([
      {
        externalId: "IG1",
        name: "Brand",
        username: "brand",
        avatarUrl: "https://pic",
        profileUrl: "https://www.instagram.com/brand/",
        credentials: { accessToken: "PT1" },
        expiresAt: null,
        // The Facebook user who logged in: matched by Meta's data deletion callback.
        meta: { pageId: "PG1", pageName: "Page", metaUserId: "FBUSER" },
      },
    ]);
    expect(new URL(m.requests[2].url).searchParams.get("fields")).toContain("instagram_business_account{");
  });

  it("errors when no Instagram account is linked", async () => {
    const m = mf([
      [/oauth\/access_token/, { access_token: "TOKEN" }],
      [`GET ${FB_GRAPH}/me/accounts`, { data: [{ id: "PG2", name: "No IG", access_token: "PT2" }] }],
      [`GET ${FB_GRAPH}/me/businesses`, { data: [] }],
    ]);
    await expect(instagram.callback!(testContext(m.fetch, APP), { code: "C", codeVerifier: "v", params: new URLSearchParams() })).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("publishes a single image via container → pending → media_publish", async () => {
    const statuses: Record<string, string> = { C1: "IN_PROGRESS" };
    const m = igMock(statuses);
    const ctx = testContext(m.fetch);
    const res = await instagram.publish(ctx, acc(), post({ settings: { collaborators: ["@friend"] } }));
    expect(res).toMatchObject({ status: "pending", state: { kind: "single", containers: ["C1"] } });
    expect(m.requests[0].form).toMatchObject({ image_url: image().url, caption: "Caption #tag", alt_text: "alt text", collaborators: '["friend"]' });
    expect(new URL(m.requests[0].url).searchParams.get("access_token")).toBe("PT");

    const state = (res as any).state;
    expect(await instagram.checkStatus!(ctx, acc(), state)).toMatchObject({ status: "pending" });
    statuses.C1 = "FINISHED";
    expect(await instagram.checkStatus!(ctx, acc(), state)).toEqual({
      status: "published",
      externalId: "M_C1",
      url: "https://www.instagram.com/p/M_C1/",
      data: { creationId: "C1" },
    });
    // A retry after the publish went through must not publish again.
    statuses.C1 = "PUBLISHED";
    expect(await instagram.checkStatus!(ctx, acc(), state)).toMatchObject({ status: "published", externalId: "C1" });
    expect(m.requests.filter((r) => r.url.includes("media_publish"))).toHaveLength(1);
  });

  it("publishes a single video as a Reel with reel options", async () => {
    const m = igMock({});
    const res = await instagram.publish(
      testContext(m.fetch),
      acc(),
      post({ media: [video()], settings: { share_to_feed: false, thumb_offset: 1500, is_trial_reel: true, graduation_strategy: "SS_PERFORMANCE" } }),
    );
    expect(res).toMatchObject({ status: "pending", retryAfterSeconds: 30 });
    expect(m.requests[0].form).toMatchObject({
      video_url: video().url,
      media_type: "REELS",
      caption: "Caption #tag",
      share_to_feed: "false",
      thumb_offset: "1500",
      trial_params: '{"graduation_strategy":"SS_PERFORMANCE"}',
    });
  });

  it("publishes a mixed carousel: children → parent → publish", async () => {
    const statuses: Record<string, string> = { C2: "IN_PROGRESS" };
    const m = igMock(statuses);
    const ctx = testContext(m.fetch);
    const res = await instagram.publish(ctx, acc(), post({ media: [image(), video()], settings: { collaborators: ["a", "b"] } }));
    expect(m.requests[0].form).toMatchObject({ image_url: image().url, is_carousel_item: "true" });
    expect(m.requests[0].form!.caption).toBeUndefined();
    expect(m.requests[1].form).toMatchObject({ video_url: video().url, is_carousel_item: "true", media_type: "VIDEO" });

    let r = await instagram.checkStatus!(ctx, acc(), (res as any).state);
    expect(r).toMatchObject({ status: "pending" });
    expect((r as any).state.carouselId).toBeUndefined();
    statuses.C2 = "FINISHED";
    r = await instagram.checkStatus!(ctx, acc(), (r as any).state);
    expect(r).toMatchObject({ status: "pending", state: { carouselId: "PARENT" } });
    const parent = m.requests.find((x) => x.form?.media_type === "CAROUSEL")!;
    expect(parent.form).toMatchObject({ children: "C1,C2", caption: "Caption #tag", collaborators: '["a","b"]' });
    r = await instagram.checkStatus!(ctx, acc(), (r as any).state);
    expect(r).toMatchObject({ status: "published", externalId: "M_PARENT" });
  });

  it("publishes stories in order and skips already published ones", async () => {
    const statuses: Record<string, string> = { C1: "PUBLISHED", C2: "FINISHED", C3: "IN_PROGRESS" };
    const m = igMock(statuses);
    const ctx = testContext(m.fetch);
    const res = await instagram.publish(ctx, acc(), post({ media: [image(), image(), video()], settings: { post_type: "story", collaborators: ["x"] } }));
    expect(m.requests.slice(0, 3).map((r) => r.form!.media_type)).toEqual(["STORIES", "STORIES", "STORIES"]);
    expect(m.requests[0].form!.collaborators).toBeUndefined();
    expect(m.requests[0].form!.caption).toBeUndefined();
    let r = await instagram.checkStatus!(ctx, acc(), (res as any).state);
    expect(r).toMatchObject({ status: "pending", state: { published: ["C1", "C2"], mediaIds: ["M_C2"] } });
    statuses.C3 = "FINISHED";
    r = await instagram.checkStatus!(ctx, acc(), (r as any).state);
    expect(r).toMatchObject({ status: "published", externalId: "M_C3", url: "https://www.instagram.com/stories/brand/" });
    expect(m.requests.filter((x) => x.url.includes("media_publish")).map((x) => x.form!.creation_id)).toEqual(["C2", "C3"]);
  });

  it("fails clearly on container errors and non-JPEG images", async () => {
    const m = mf([[new RegExp("/C9\\?"), { status_code: "ERROR", status: "Error: 2207026" }]]);
    await expect(instagram.checkStatus!(testContext(m.fetch), acc(), { host: FB_GRAPH, kind: "single", containers: ["C9"] })).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(instagram.publish(testContext(mf([]).fetch), acc(), post({ media: [image({ mime: "image/png", filename: "a.png" })] }))).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("JPEG"),
    });
    expect(instagram.validate!(post({ media: [image({ mime: "image/webp", filename: "a.webp" })] }))[0]).toMatch(/JPEG/);
    expect(instagram.validate!(post({ settings: { is_trial_reel: true } }))).toContain("A Trial Reel must be a single video");
  });

  it("comments on the root media", async () => {
    const m = mf([
      [`POST ${FB_GRAPH}/M1/comments`, { id: "CM1" }],
      [`GET ${FB_GRAPH}/M1`, { permalink: "https://www.instagram.com/p/abc/" }],
    ]);
    const r = await instagram.reply!(testContext(m.fetch), acc(), { rootId: "M1", parentId: "M1" }, post({ content: "link in bio", media: [] }));
    expect(r).toEqual({ externalId: "CM1", url: "https://www.instagram.com/p/abc/", urlIsPost: true }); // comments have no permalink
    expect(m.requests[0].form).toMatchObject({ message: "link in bio" });
  });

  it("maps an expired token to auth", async () => {
    const m = mf([[`POST ${FB_GRAPH}/IG1/media`, json({ error: { message: "Session has expired", type: "OAuthException", code: 190, error_subcode: 463 } }, 400)]]);
    await expect(instagram.publish(testContext(m.fetch), acc(), post())).rejects.toMatchObject({ kind: "auth" });
    const m401 = mf([[`POST ${FB_GRAPH}/IG1/media`, json({}, 401)]]);
    await expect(instagram.publish(testContext(m401.fetch), acc(), post())).rejects.toMatchObject({ kind: "auth" });
    const rl = mf([[`POST ${FB_GRAPH}/IG1/media`, json({ error: { message: "limit", code: 4 } }, 400)]]);
    await expect(instagram.publish(testContext(rl.fetch), acc(), post())).rejects.toMatchObject({ kind: "rate_limit" });
  });
});

/** Graph Batch API mock: answers each sub-request with `reply(relative_url)` ([code, body]). */
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
const insights = (v: Record<string, number>) => ({ data: Object.entries(v).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }] })) });
const item = (externalId: string, data?: Record<string, unknown>) => ({ externalId, data, publishedAt: 0 });

describe("instagram metrics", () => {
  it("requests the insights permission", async () => {
    const url = new URL(await instagram.authorize!(testContext(mf([]).fetch, APP, "instagram"), { state: "S", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.searchParams.get("scope")).toContain("instagram_manage_insights");
    expect(instagram.metrics?.scopes).toEqual(["instagram_manage_insights"]);
    expect(instagram.setupNotes).toContain("instagram_manage_insights");
  });

  it("batches feed posts and story frames into one request and maps the keys", async () => {
    const m = batchMock((u) =>
      u.startsWith("M1/")
        ? [200, insights({ views: 900, reach: 500, saved: 7, shares: 3, total_interactions: 60, likes: 40, comments: 10 })]
        : u.startsWith("S1/")
          ? [200, insights({ views: 100, reach: 80, replies: 2, shares: 1, total_interactions: 3 })]
          : [200, insights({ views: 50, reach: 90, replies: 1, shares: 0, total_interactions: 1 })],
    );
    const res = await instagram.postMetrics!(testContext(m.fetch, APP), acc(), [item("M1", { creationId: "C1" }), item("S2", { mediaIds: ["S1", "S2"] })]);
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0].form!.access_token).toBe("PT");
    const batch = JSON.parse(m.requests[0].form!.batch);
    expect(batch.map((b: any) => b.relative_url)).toEqual([
      "M1/insights?metric=views,reach,saved,shares,total_interactions,likes,comments,profile_visits,follows",
      "S1/insights?metric=views,reach,replies,shares,total_interactions",
      "S2/insights?metric=views,reach,replies,shares,total_interactions",
    ]);
    expect(res.M1).toEqual({ views: 900, reach: 500, saves: 7, shares: 3, likes: 40, comments: 10, extra: { total_interactions: 60 } });
    // Story frames: counts summed, reach is the largest frame's.
    expect(res.S2).toEqual({ views: 150, reach: 90, replies: 3, shares: 1, extra: { total_interactions: 4 } });
  });

  it("returns null for deleted media and leaves timed-out sub-requests out", async () => {
    const m = batchMock((u) =>
      u.startsWith("GONE/")
        ? [400, { error: { message: "Unsupported get request. Object with ID 'GONE' does not exist, cannot be loaded due to missing permissions", code: 100, error_subcode: 33 } }]
        : u.startsWith("SLOW/")
          ? null
          : [200, insights({ views: 1 })],
    );
    const res = await instagram.postMetrics!(testContext(m.fetch, APP), acc(), [item("GONE"), item("SLOW"), item("OK")]);
    expect(res).toEqual({ GONE: null, OK: { views: 1 } });
  });

  it("signals reconnect_required when the insights permission is missing", async () => {
    const m = batchMock(() => [403, { error: { message: "(#10) Application does not have permission for this action", type: "OAuthException", code: 10 } }]);
    const err = await instagram.postMetrics!(testContext(m.fetch, APP), acc(), [item("M1")]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
  });

  it("stops when the fetch budget is used up", async () => {
    const m = mf([]);
    const res = await instagram.postMetrics!(counted(testContext(m.fetch, APP), 0), acc(), [item("M1")]);
    expect(res).toEqual({});
    expect(m.requests).toHaveLength(0);
  });

  it("reads account metrics from the IG user node", async () => {
    const m = mf([[`GET ${FB_GRAPH}/IG1`, { followers_count: 1200, follows_count: 80, media_count: 45, id: "IG1" }]]);
    expect(await instagram.accountMetrics!(testContext(m.fetch, APP), acc())).toEqual({ followers: 1200, following: 80, posts: 45 });
    const u = new URL(m.requests[0].url);
    expect(u.searchParams.get("fields")).toBe("followers_count,follows_count,media_count");
    expect(u.searchParams.get("access_token")).toBe("PT");
  });
});
