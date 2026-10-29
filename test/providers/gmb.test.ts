import { describe, expect, it } from "vitest";
import { gmb, localPostBody, splitDateTime } from "../../worker/providers/gmb";
import { image, json, mockFetch, testAccount, testContext } from "../helpers";

const app = { clientId: "CID", clientSecret: "SECRET" };
const LOC = "accounts/111/locations/222";
const account = () => testAccount({ externalId: LOC, meta: { mapsUri: "https://maps.google.com/?cid=1" } });
const post = (settings: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id: "p1",
  content: "We are open on Sunday!",
  media: [],
  settings,
  ...over,
});

describe("gmb", () => {
  it("builds the Google authorize URL with business.manage", () => {
    const url = new URL(gmb.authorize!(testContext(mockFetch([]).fetch, app, "gmb"), { state: "S", codeVerifier: "V", codeChallenge: "CH" }) as string);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/business.manage");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/gmb/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("S");
  });

  it("callback returns one account per location across accounts and pages", async () => {
    const m = mockFetch([
      ["POST https://oauth2.googleapis.com/token", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      [/accounts\?pageToken=P2/, () => ({ accounts: [{ name: "accounts/2", accountName: "Second" }] })],
      ["GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts", () => ({ accounts: [{ name: "accounts/1", accountName: "First" }], nextPageToken: "P2" })],
      [
        "GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/1/locations",
        () => ({
          locations: [
            { name: "locations/10", title: "Cafe A", storefrontAddress: { locality: "Berlin" }, metadata: { mapsUri: "https://maps/a" } },
          ],
        }),
      ],
      ["GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/2/locations", () => ({ locations: [{ name: "locations/20", title: "Shop B" }] })],
    ]);
    const accounts = await gmb.callback!(testContext(m.fetch, app, "gmb"), { code: "C", codeVerifier: "V", params: new URLSearchParams() });
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({
      externalId: "accounts/1/locations/10",
      name: "Cafe A",
      username: "Berlin",
      profileUrl: "https://maps/a",
      credentials: { accessToken: "AT", refreshToken: "RT" },
      meta: { accountName: "accounts/1", locationName: "locations/10" },
    });
    expect(accounts[1].externalId).toBe("accounts/2/locations/20");
    const locReq = m.requests.find((r) => r.url.includes("accounts/1/locations"))!;
    expect(locReq.url).toContain("readMask=name%2Ctitle%2CstorefrontAddress%2Cmetadata");
  });

  it("refreshes tokens", async () => {
    const m = mockFetch([["POST https://oauth2.googleapis.com/token", () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 })]]);
    const u = await gmb.refresh!(testContext(m.fetch, app), account());
    expect(u.credentials).toEqual({ accessToken: "AT2", refreshToken: "RT2" });
  });

  it("publishes a standard update with button and photo", async () => {
    const m = mockFetch([[`POST https://mybusiness.googleapis.com/v4/${LOC}/localPosts`, () => ({ name: `${LOC}/localPosts/9`, searchUrl: "https://local.google.com/p/9", state: "LIVE" })]]);
    const res = await gmb.publish(
      testContext(m.fetch, app),
      account(),
      post({ callToAction: "LEARN_MORE", callToActionUrl: "https://example.com" }, { media: [image()] }),
    );
    expect(res).toEqual({ status: "published", externalId: `${LOC}/localPosts/9`, url: "https://local.google.com/p/9" });
    expect(m.requests[0].headers.authorization).toBe("Bearer AT");
    expect(m.requests[0].json).toEqual({
      languageCode: "en",
      topicType: "STANDARD",
      summary: "We are open on Sunday!",
      media: [{ mediaFormat: "PHOTO", sourceUrl: image().url }],
      callToAction: { actionType: "LEARN_MORE", url: "https://example.com" },
    });
  });

  it("builds event and offer bodies", () => {
    const ev = localPostBody(post({ postType: "EVENT", eventTitle: "Party", eventStart: "2030-05-01T18:00", eventEnd: "2030-05-01T23:30", callToAction: "CALL" }));
    expect(ev).toMatchObject({
      topicType: "EVENT",
      callToAction: { actionType: "CALL" },
      event: {
        title: "Party",
        schedule: {
          startDate: { year: 2030, month: 5, day: 1 },
          startTime: { hours: 18, minutes: 0 },
          endDate: { year: 2030, month: 5, day: 1 },
          endTime: { hours: 23, minutes: 30 },
        },
      },
    });
    const of = localPostBody(
      post({ postType: "OFFER", offerTitle: "20% off", offerStart: "2030-05-01", offerEnd: "2030-05-31", offerCouponCode: "SAVE20", offerRedeemUrl: "https://x.com", offerTerms: "T&C" }),
    );
    expect(of).toMatchObject({
      topicType: "OFFER",
      event: { title: "20% off", schedule: { startDate: { year: 2030, month: 5, day: 1 }, endDate: { year: 2030, month: 5, day: 31 } } },
      offer: { couponCode: "SAVE20", redeemOnlineUrl: "https://x.com", termsConditions: "T&C" },
    });
    expect((of.event as any).schedule.startTime).toBeUndefined();
    expect(of.callToAction).toBeUndefined();
    expect(splitDateTime(Date.UTC(2030, 0, 2, 3, 4))).toEqual({ date: { year: 2030, month: 1, day: 2 }, time: { hours: 3, minutes: 4 } });
  });

  it("rejected posts are invalid", async () => {
    const m = mockFetch([[`POST https://mybusiness.googleapis.com/v4/${LOC}/localPosts`, () => ({ name: "x", state: "REJECTED" })]]);
    await expect(gmb.publish(testContext(m.fetch, app), account(), post())).rejects.toMatchObject({ kind: "invalid" });
  });

  it("maps 401 / UNAUTHENTICATED to auth", async () => {
    const m = mockFetch([
      [`POST https://mybusiness.googleapis.com/v4/${LOC}/localPosts`, () => json({ error: { code: 401, status: "UNAUTHENTICATED", message: "bad" } }, 401)],
    ]);
    await expect(gmb.publish(testContext(m.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
  });

  it("validates", () => {
    expect(gmb.validate!(post({}, { content: "" }))).toContain("Google Business Profile: an update needs text or a photo");
    expect(gmb.validate!(post({}, { media: [image({ mime: "image/webp" })] }))).toContain("Google Business Profile: the photo must be JPEG or PNG");
    expect(gmb.validate!(post({ callToAction: "BOOK" }))).toContain("Google Business Profile: the button needs a URL");
    expect(gmb.validate!(post())).toEqual([]);
    expect(gmb.capabilities.media.videos).toBe(0);
  });
});
