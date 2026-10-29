import { describe, expect, it } from "vitest";
import { tiktokBusiness } from "../../worker/providers/tiktok_business";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const app = { clientKey: "APPID", clientSecret: "SEC" };
const API = "https://business-api.tiktok.com/open_api/v1.3";
const ok = (data: unknown) => ({ code: 0, message: "OK", request_id: "r", data });
const account = () => testAccount({ externalId: "BID", meta: { username: "brand" } });
const post = (settings: Record<string, unknown> = {}, media = [video()]) => ({ id: "p1", content: "Hello", media, settings });

describe("tiktok_business", () => {
  it("builds the authorize URL", () => {
    const url = new URL(
      tiktokBusiness.authorize!(testContext(mockFetch([]).fetch, app, "tiktok_business"), { state: "S", codeVerifier: "V", codeChallenge: "C" }) as string,
    );
    expect(url.searchParams.get("client_key")).toBe("APPID");
    expect(url.searchParams.get("disable_auto_auth")).toBe("1");
    expect(url.searchParams.get("scope")).toContain("video.publish");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/tiktok_business/callback");
  });

  it("callback exchanges the auth code and loads the business profile", async () => {
    const m = mockFetch([
      [`POST ${API}/tt_user/oauth2/token/`, () => ok({ access_token: "AT", refresh_token: "RT", open_id: "BID", expires_in: 86400 })],
      [`GET ${API}/business/get/`, () => ok({ username: "brand", display_name: "Brand", profile_image: "https://img" })],
    ]);
    const [acc] = await tiktokBusiness.callback!(testContext(m.fetch, app, "tiktok_business"), { code: "CODE", codeVerifier: "", params: new URLSearchParams() });
    expect(m.requests[0].json).toEqual({
      client_id: "APPID",
      client_secret: "SEC",
      grant_type: "authorization_code",
      auth_code: "CODE",
      redirect_uri: "https://pf.example.com/oauth/tiktok_business/callback",
    });
    expect(m.requests[1].headers["access-token"]).toBe("AT");
    expect(m.requests[1].url).toContain("business_id=BID");
    expect(acc).toMatchObject({ externalId: "BID", name: "Brand", username: "brand", avatarUrl: "https://img", credentials: { accessToken: "AT", refreshToken: "RT" } });
  });

  it("refresh; a non-zero code maps to auth", async () => {
    const m = mockFetch([[`POST ${API}/tt_user/oauth2/refresh_token/`, () => ok({ access_token: "AT2", refresh_token: "RT2", open_id: "BID" })]]);
    const u = await tiktokBusiness.refresh!(testContext(m.fetch, app), account());
    expect(u.credentials).toEqual({ accessToken: "AT2", refreshToken: "RT2" });
    const bad = mockFetch([[`POST ${API}/tt_user/oauth2/refresh_token/`, () => ({ code: 40001, message: "refresh token invalid" })]]);
    await expect(tiktokBusiness.refresh!(testContext(bad.fetch, app), account())).rejects.toMatchObject({ kind: "auth" });
  });

  it("publishes a video by URL with music and location, then polls status", async () => {
    const m = mockFetch([
      [`POST ${API}/business/video/publish/`, () => ok({ share_id: "v_pub_url~9" })],
      [`GET ${API}/business/publish/status/`, () => new Response('{"code":0,"data":{"status":"PUBLISH_COMPLETE","post_ids":["7400000000000000001"]}}')],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await tiktokBusiness.publish(ctx, account(), post({ allowComment: true, allowStitch: true, music: "M1", musicVolume: 30, location: "L1|Berlin Mitte" }));
    expect(res).toEqual({ status: "pending", state: { publishId: "v_pub_url~9" }, retryAfterSeconds: 15 });
    expect(m.requests[0].headers["access-token"]).toBe("AT");
    expect(m.requests[0].json).toEqual({
      business_id: "BID",
      video_url: video().url,
      post_info: {
        caption: "Hello",
        is_brand_organic: false,
        is_branded_content: false,
        disable_comment: false,
        disable_duet: true,
        disable_stitch: false,
        is_ai_generated: false,
        location_id: "L1",
        location_name: "Berlin Mitte",
        music_sound_info: { music_sound_id: "M1", music_sound_volume: 30, video_original_sound_volume: 50 },
      },
    });
    const done = await tiktokBusiness.checkStatus!(ctx, account(), { publishId: "v_pub_url~9" });
    expect(m.requests[1].url).toContain("publish_id=v_pub_url");
    expect(done).toMatchObject({ status: "published", externalId: "7400000000000000001", url: "https://www.tiktok.com/@brand/video/7400000000000000001" });
  });

  it("publishes photos (draft mode keeps only caption fields)", async () => {
    const m = mockFetch([[`POST ${API}/business/photo/publish/`, () => ok({ share_id: "p_pub_url~1" })]]);
    await tiktokBusiness.publish(testContext(m.fetch, app), account(), post({ postMode: "inbox", title: "T", privacy_level: "SELF_ONLY" }, [image()]));
    expect(m.requests[0].json).toEqual({
      business_id: "BID",
      photo_images: [image().url],
      photo_cover_index: 0,
      post_info: { title: "T", caption: "Hello", is_brand_organic: false, is_branded_content: false, is_draft: true },
    });
  });

  it("status FAILED and pending", async () => {
    const m = mockFetch([[`GET ${API}/business/publish/status/`, () => ok({ status: "FAILED", reason: "url_ownership_unverified" })]]);
    const err = await tiktokBusiness.checkStatus!(testContext(m.fetch, app), account(), { publishId: "x" }).catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(err.message).toContain("verified URL property");
    const p = mockFetch([[`GET ${API}/business/publish/status/`, () => ok({ status: "PROCESSING_DOWNLOAD" })]]);
    expect((await tiktokBusiness.checkStatus!(testContext(p.fetch, app), account(), { publishId: "x" })).status).toBe("pending");
  });

  it("loads music and location options", async () => {
    const m = mockFetch([
      [`GET ${API}/discovery/cml/trending_list/`, () => ok({ list: [{ commercial_music_name: "Song", artist: "Art", trending_song_clip: { song_clip_id: "S1" } }] })],
      [`GET ${API}/business/publish/location/`, () => ok({ locations: [{ location_id: "L1", location_name: "Cafe", location_address: "Main St" }] })],
    ]);
    const ctx = testContext(m.fetch, app);
    expect(await tiktokBusiness.options!(ctx, account(), "music", {})).toEqual([
      { value: "", label: "None" },
      { value: "S1", label: "Song - Art" },
    ]);
    expect(await tiktokBusiness.options!(ctx, account(), "location", { locationQuery: "cafe" })).toEqual([
      { value: "", label: "None" },
      { value: "L1|Cafe", label: "Cafe, Main St" },
    ]);
    expect(m.requests[1].url).toContain("search_query=cafe");
    expect((await tiktokBusiness.options!(ctx, account(), "location", {}))[0].value).toBe("");
  });

  it("maps token errors (HTTP 200 envelope and 401) to auth", async () => {
    const m = mockFetch([[`POST ${API}/business/video/publish/`, () => ({ code: 40105, message: "Access token is incorrect or has been revoked." })]]);
    await expect(tiktokBusiness.publish(testContext(m.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const m401 = mockFetch([[`POST ${API}/business/video/publish/`, () => json({ message: "unauthorized" }, 401)]]);
    await expect(tiktokBusiness.publish(testContext(m401.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("tiktok_business metrics", () => {
  const item = (externalId: string) => ({ externalId, publishedAt: 0 });

  it("requests the analytics scopes", () => {
    const url = new URL(
      tiktokBusiness.authorize!(testContext(mockFetch([]).fetch, app, "tiktok_business"), { state: "S", codeVerifier: "V", codeChallenge: "C" }) as string,
    );
    expect(url.searchParams.get("scope")!.split(",")).toEqual(expect.arrayContaining(["video.list", "user.info.stats"]));
    expect(tiktokBusiness.metrics).toMatchObject({ batch: 20, account: ["followers"] });
  });

  it("filters video/list by the batch's post ids in one call", async () => {
    const m = mockFetch([
      [
        `GET ${API}/business/video/list/`,
        () =>
          new Response(
            '{"code":0,"message":"OK","request_id":"r","data":{"videos":[{"item_id":7400000000000000123,"video_views":900,"likes":30,"comments":2,"shares":1,"reach":700}],"cursor":0,"has_more":false}}',
          ),
      ],
    ]);
    const res = await tiktokBusiness.postMetrics!(testContext(m.fetch, app), account(), [item("7400000000000000123"), item("7400000000000000456"), item("v_pub_url~9")]);
    expect(m.requests).toHaveLength(1);
    const q = new URL(m.requests[0].url).searchParams;
    expect(m.requests[0].headers["access-token"]).toBe("AT");
    expect(q.get("business_id")).toBe("BID");
    expect(JSON.parse(q.get("filters")!)).toEqual({ video_ids: ["7400000000000000123", "7400000000000000456"] });
    expect(JSON.parse(q.get("fields")!)).toEqual(["item_id", "video_views", "likes", "comments", "shares", "reach"]);
    expect(res).toEqual({
      "7400000000000000123": { views: 900, likes: 30, comments: 2, shares: 1, reach: 700 },
      "7400000000000000456": null,
      "v_pub_url~9": null,
    });
  });

  it("a scope error means reconnect for analytics", async () => {
    const m = mockFetch([[`GET ${API}/business/get/`, () => ({ code: 40001, message: "scope_not_authorized: user.info.stats" })]]);
    await expect(tiktokBusiness.accountMetrics!(testContext(m.fetch, app), account())).rejects.toBeInstanceOf(MetricsUnavailableError);
  });

  it("account followers from business/get", async () => {
    const m = mockFetch([[`GET ${API}/business/get/`, () => ok({ followers_count: 5400 })]]);
    expect(await tiktokBusiness.accountMetrics!(testContext(m.fetch, app), account())).toEqual({ followers: 5400 });
    expect(JSON.parse(new URL(m.requests[0].url).searchParams.get("fields")!)).toEqual(["followers_count"]);
  });
});
