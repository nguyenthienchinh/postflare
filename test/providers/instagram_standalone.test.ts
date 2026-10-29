import { describe, expect, it } from "vitest";
import { counted } from "../../worker/providers/budget";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { instagramStandalone } from "../../worker/providers/instagram_standalone";
import { IG_GRAPH } from "../../worker/providers/meta-shared";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const mf = (routes: Array<[string | RegExp, unknown]>) =>
  mockFetch(routes.map(([k, h]) => [k, typeof h === "function" ? (h as any) : () => (h instanceof Response ? h.clone() : h)]));
const APP = { clientId: "IGAPP", clientSecret: "IGSECRET" };
const acc = () => testAccount({ provider: "instagram_standalone", externalId: "1784", username: "brand", credentials: { accessToken: "LONG" } });
const post = (over: Record<string, any> = {}) => ({ id: "p1", content: "Hi", media: [image()], settings: {}, ...over });

describe("instagram (instagram login)", () => {
  it("builds the authorize URL", async () => {
    const url = new URL(await instagramStandalone.authorize!(testContext(mf([]).fetch, APP, "instagram_standalone"), { state: "S", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("IGAPP");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/instagram_standalone/callback");
    expect(url.searchParams.get("state")).toBe("S");
    // force_reauth would sign the browser out of instagram.com: never part of the default connect link.
    expect(url.searchParams.has("force_reauth")).toBe(false);
  });

  it("forces the Instagram login only when the user asks for a different account", async () => {
    expect(instagramStandalone.switchAccount?.note).toMatch(/signs you out of instagram\.com/);
    const url = new URL(
      await instagramStandalone.authorize!(testContext(mf([]).fetch, APP, "instagram_standalone"), { state: "S", codeVerifier: "v", codeChallenge: "c", switchAccount: true }),
    );
    expect(url.searchParams.get("force_reauth")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe("IGAPP");
  });

  it("exchanges the code for a long-lived token and returns the account", async () => {
    const m = mf([
      ["POST https://api.instagram.com/oauth/access_token", { data: [{ access_token: "SHORT", user_id: "1", permissions: "x" }] }],
      ["GET https://graph.instagram.com/access_token", { access_token: "LONG", token_type: "bearer", expires_in: 5184000 }],
      [`GET ${IG_GRAPH}/me`, { user_id: "1784", username: "brand", name: "Brand", profile_picture_url: "https://pic", account_type: "BUSINESS" }],
    ]);
    const before = Date.now();
    const [a] = await instagramStandalone.callback!(testContext(m.fetch, APP, "instagram_standalone"), { code: "CODE#_", codeVerifier: "v", params: new URLSearchParams() });
    expect(a).toMatchObject({ externalId: "1784", name: "Brand", username: "brand", avatarUrl: "https://pic", credentials: { accessToken: "LONG" } });
    // App-scoped user id from the token response (no `id` in /me here): matched by Meta's data deletion callback.
    expect(a.meta).toEqual({ accountType: "BUSINESS", metaUserId: "1" });
    expect(a.expiresAt).toBeGreaterThanOrEqual(before + 5184000 * 1000);
    expect(m.requests[0].form).toMatchObject({ client_id: "IGAPP", client_secret: "IGSECRET", grant_type: "authorization_code", code: "CODE" });
    expect(new URL(m.requests[1].url).searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(new URL(m.requests[1].url).searchParams.get("access_token")).toBe("SHORT");
  });

  it("refreshes the token", async () => {
    const m = mf([["GET https://graph.instagram.com/refresh_access_token", { access_token: "NEW", expires_in: 5184000 }]]);
    const r = await instagramStandalone.refresh!(testContext(m.fetch, APP), acc());
    expect(r.credentials.accessToken).toBe("NEW");
    expect(r.expiresAt).toBeGreaterThan(Date.now());
    const u = new URL(m.requests[0].url);
    expect(u.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(u.searchParams.get("access_token")).toBe("LONG");
  });

  it("maps a failed refresh with code 190 to auth", async () => {
    const m = mf([["GET https://graph.instagram.com/refresh_access_token", json({ error: { message: "expired", type: "OAuthException", code: 190 } }, 400)]]);
    await expect(instagramStandalone.refresh!(testContext(m.fetch, APP), acc())).rejects.toMatchObject({ kind: "auth" });
  });

  it("publishes through graph.instagram.com without double publishing", async () => {
    let status = "IN_PROGRESS";
    const m = mf([
      [`POST ${IG_GRAPH}/1784/media_publish`, { id: "MEDIA1" }],
      [`POST ${IG_GRAPH}/1784/media`, { id: "CONT1" }],
      [`GET ${IG_GRAPH}/CONT1`, () => ({ status_code: status })],
      [`GET ${IG_GRAPH}/MEDIA1`, { permalink: "https://www.instagram.com/reel/x/" }],
    ]);
    const ctx = testContext(m.fetch);
    const res = await instagramStandalone.publish(ctx, acc(), post({ media: [video()] }));
    expect(res).toMatchObject({ status: "pending", state: { host: IG_GRAPH, containers: ["CONT1"] } });
    expect(m.requests[0].form).toMatchObject({ media_type: "REELS", video_url: video().url, caption: "Hi" });
    const state = (res as any).state;
    expect(await instagramStandalone.checkStatus!(ctx, acc(), state)).toMatchObject({ status: "pending" });
    status = "FINISHED";
    expect(await instagramStandalone.checkStatus!(ctx, acc(), state)).toMatchObject({ status: "published", externalId: "MEDIA1", url: "https://www.instagram.com/reel/x/" });
    status = "PUBLISHED";
    expect(await instagramStandalone.checkStatus!(ctx, acc(), state)).toMatchObject({ status: "published" });
    expect(m.requests.filter((r) => r.url.includes("media_publish"))).toHaveLength(1);
  });

  it("comments on the root media", async () => {
    const m = mf([
      [`POST ${IG_GRAPH}/MEDIA1/comments`, { id: "CM" }],
      [`GET ${IG_GRAPH}/MEDIA1`, json({ error: { message: "nope", code: 100 } }, 400)],
    ]);
    const r = await instagramStandalone.reply!(testContext(m.fetch), acc(), { rootId: "MEDIA1", parentId: "MEDIA1" }, post({ content: "first", media: [] }));
    expect(r).toEqual({ externalId: "CM", url: null, urlIsPost: true });
  });

  it("maps 401 to auth", async () => {
    const m = mf([[`POST ${IG_GRAPH}/1784/media`, json({ error: { message: "bad" } }, 401)]]);
    await expect(instagramStandalone.publish(testContext(m.fetch), acc(), post())).rejects.toMatchObject({ kind: "auth" });
  });
});

const insights = (v: Record<string, number>) => ({ data: Object.entries(v).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }] })) });
const item = (externalId: string, data?: Record<string, unknown>) => ({ externalId, data, publishedAt: 0 });
const pro = () => ({ ...acc(), meta: { accountType: "BUSINESS" } });

describe("instagram (instagram login) metrics", () => {
  it("declares the insights permission", () => {
    expect(instagramStandalone.metrics?.scopes).toEqual(["instagram_business_manage_insights"]);
    expect(instagramStandalone.setupNotes).toContain("instagram_business_manage_insights");
  });

  it("reads one media per request and maps the keys", async () => {
    const m = mf([[new RegExp(`^${IG_GRAPH.replace(/\./g, "\\.")}/M\\d/insights`), insights({ views: 10, reach: 8, saved: 1, likes: 2, comments: 0, shares: 0, total_interactions: 3 })]]);
    const res = await instagramStandalone.postMetrics!(testContext(m.fetch, APP), pro(), [item("M1"), item("M2")]);
    expect(m.requests).toHaveLength(2);
    const u = new URL(m.requests[0].url);
    expect(u.pathname).toMatch(/\/M1\/insights$/);
    expect(u.searchParams.get("metric")).toBe("views,reach,saved,shares,total_interactions,likes,comments,profile_visits,follows");
    expect(u.searchParams.get("access_token")).toBe("LONG");
    expect(res.M1).toEqual({ views: 10, reach: 8, saves: 1, likes: 2, comments: 0, shares: 0, extra: { total_interactions: 3 } });
  });

  it("reads watch time of reels and the profile visits and follows of posts; retries without them when a media rejects them", async () => {
    const m = mf([
      [/\/R1\/insights/, insights({ views: 1000, reach: 700, likes: 50, comments: 4, saved: 3, shares: 2, total_interactions: 59, ig_reels_avg_watch_time: 6420, ig_reels_video_view_total_time: 6_420_000 })],
      [/\/P1\/insights/, insights({ views: 300, reach: 200, likes: 20, comments: 1, saved: 0, shares: 0, total_interactions: 21, profile_visits: 9, follows: 2 })],
      [/\/OLD\/insights\?.*follows/, json({ error: { message: "(#100) The Media Insights API does not support the follows metric for this media product type.", code: 100 } }, 400)],
      [/\/OLD\/insights/, insights({ views: 40 })],
    ]);
    const res = await instagramStandalone.postMetrics!(testContext(m.fetch, APP), pro(), [item("R1", { creationId: "C", reel: true }), item("P1"), item("OLD")]);
    expect(new URL(m.requests[0].url).searchParams.get("metric")).toBe("views,reach,saved,shares,total_interactions,likes,comments,ig_reels_avg_watch_time,ig_reels_video_view_total_time");
    expect(res.R1).toEqual({ views: 1000, reach: 700, likes: 50, comments: 4, saves: 3, shares: 2, avgViewDurationSeconds: 6.4, watchTimeMinutes: 107, extra: { total_interactions: 59 } });
    expect(res.P1).toMatchObject({ views: 300, extra: { total_interactions: 21, profile_visits: 9, follows: 2 } });
    expect(res.OLD).toEqual({ views: 40 });
    expect(m.requests).toHaveLength(4);
    expect(new URL(m.requests[3].url).searchParams.get("metric")).toBe("views,reach,saved,shares,total_interactions,likes,comments");
  });

  it("stops at the fetch budget and leaves the rest out", async () => {
    const m = mf([[/\/insights/, insights({ views: 1 })]]);
    const res = await instagramStandalone.postMetrics!(counted(testContext(m.fetch, APP), 2), pro(), [item("M1"), item("M2"), item("M3")]);
    expect(m.requests).toHaveLength(2);
    expect(Object.keys(res)).toEqual(["M1", "M2"]);
  });

  it("returns null for deleted media", async () => {
    const m = mf([[/\/insights/, json({ error: { message: "Object with ID 'M1' does not exist", code: 100, error_subcode: 33 } }, 400)]]);
    expect(await instagramStandalone.postMetrics!(testContext(m.fetch, APP), pro(), [item("M1")])).toEqual({ M1: null });
  });

  it("signals reconnect_required on a permission error", async () => {
    const m = mf([[/\/insights/, json({ error: { message: "(#200) Requires instagram_business_manage_insights permission", code: 200 } }, 403)]]);
    const err = await instagramStandalone.postMetrics!(testContext(m.fetch, APP), pro(), [item("M1")]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
  });

  it("reports personal accounts as not supported", async () => {
    const m = mf([]);
    const personal = { ...acc(), meta: { accountType: "PERSONAL" } };
    const err = await instagramStandalone.postMetrics!(testContext(m.fetch, APP), personal, [item("M1")]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("not_supported");
    await expect(instagramStandalone.accountMetrics!(testContext(m.fetch, APP), personal)).rejects.toMatchObject({ reason: "not_supported" });
    expect(m.requests).toHaveLength(0);
  });

  it("reads account metrics", async () => {
    const m = mf([[`GET ${IG_GRAPH}/1784`, { followers_count: 10, follows_count: 2, media_count: 3 }]]);
    expect(await instagramStandalone.accountMetrics!(testContext(m.fetch, APP), pro())).toEqual({ followers: 10, following: 2, posts: 3 });
  });
});
