import { describe, expect, it } from "vitest";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { linkedinPage } from "../../worker/providers/linkedin_page";
import { json, mockFetch, testAccount, testContext } from "../helpers";

const app = { clientId: "cid", clientSecret: "csecret" };
const account = testAccount({ provider: "linkedin_page", externalId: "42", meta: { organizationUrn: "urn:li:organization:42" } });

describe("linkedin_page", () => {
  it("requests organization scopes", async () => {
    const url = new URL(await linkedinPage.authorize!(testContext(mockFetch([]).fetch, app, "linkedin_page"), { state: "s", codeVerifier: "", codeChallenge: "" }));
    expect(url.searchParams.get("scope")).toBe("rw_organization_admin w_organization_social r_organization_social");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/linkedin_page/callback");
  });

  it("returns one account per administered organization", async () => {
    const m = mockFetch([
      ["POST https://www.linkedin.com/oauth/v2/accessToken", () => ({ access_token: "AT", expires_in: 5184000 })],
      [
        "GET https://api.linkedin.com/rest/organizationAcls",
        () => ({
          elements: [
            { organization: "urn:li:organization:42", role: "ADMINISTRATOR", state: "APPROVED" },
            { organization: "urn:li:organization:43", role: "CONTENT_ADMINISTRATOR", state: "APPROVED" },
            { organization: "urn:li:organization:44", role: "ANALYST", state: "APPROVED" },
          ],
        }),
      ],
      ["GET https://api.linkedin.com/rest/organizations/42", () => ({ id: 42, localizedName: "Acme", vanityName: "acme" })],
      ["GET https://api.linkedin.com/rest/organizations/43", () => ({ id: 43, localizedName: "Beta" })],
    ]);
    const accounts = await linkedinPage.callback!(testContext(m.fetch, app), { code: "c", codeVerifier: "", params: new URLSearchParams() });
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({
      externalId: "42",
      name: "Acme",
      username: "acme",
      profileUrl: "https://www.linkedin.com/company/acme/",
      credentials: { accessToken: "AT" },
      meta: { organizationUrn: "urn:li:organization:42" },
    });
    expect(accounts[1]).toMatchObject({ externalId: "43", name: "Beta" });
    expect(m.requests[1].url).toContain("q=roleAssignee");
    expect(m.requests[1].headers["linkedin-version"]).toMatch(/^\d{6}$/);
  });

  it("errors when the user administers no page", async () => {
    const m = mockFetch([
      ["POST https://www.linkedin.com/oauth/v2/accessToken", () => ({ access_token: "AT" })],
      ["GET https://api.linkedin.com/rest/organizationAcls", () => ({ elements: [] })],
    ]);
    await expect(linkedinPage.callback!(testContext(m.fetch, app), { code: "c", codeVerifier: "", params: new URLSearchParams() })).rejects.toThrow(
      /not an administrator/,
    );
  });

  it("publishes as the organization (always PUBLIC)", async () => {
    const m = mockFetch([["POST https://api.linkedin.com/rest/posts", () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:9" } })]]);
    const res = await linkedinPage.publish(testContext(m.fetch, app), account, { id: "p", content: "Hi", media: [], settings: { visibility: "CONNECTIONS" } });
    expect(res).toMatchObject({ status: "published", externalId: "urn:li:share:9" });
    expect(m.requests[0].json).toMatchObject({ author: "urn:li:organization:42", visibility: "PUBLIC" });
    expect(linkedinPage.settingsFields.some((f) => f.key === "visibility")).toBe(false);
  });

  it("comments as the organization", async () => {
    const m = mockFetch([["POST https://api.linkedin.com/rest/socialActions/", () => new Response(null, { status: 201, headers: { "x-restli-id": "c1" } })]]);
    const r = await linkedinPage.reply!(testContext(m.fetch, app), account, { rootId: "urn:li:share:9", parentId: "urn:li:share:9" }, { id: "r", content: "c", media: [], settings: {} });
    expect(r.externalId).toBe("c1");
    expect(m.requests[0].json.actor).toBe("urn:li:organization:42");
  });

  it("maps 401 to auth", async () => {
    const m = mockFetch([["POST https://api.linkedin.com/rest/posts", () => json({ message: "expired" }, 401)]]);
    await expect(linkedinPage.publish(testContext(m.fetch, app), account, { id: "p", content: "Hi", media: [], settings: {} })).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("linkedin_page metrics", () => {
  const stats = (key: "share" | "ugcPost", urn: string, n: number) => ({
    [key]: urn,
    organizationalEntity: "urn:li:organization:42",
    totalShareStatistics: { impressionCount: n * 10, uniqueImpressionsCount: n * 8, clickCount: n, likeCount: n + 1, commentCount: 2, shareCount: 0, engagement: 0.05 },
  });
  const items = ["urn:li:share:1", "urn:li:share:2", "urn:li:ugcPost:3", "urn:li:share:9"].map((externalId) => ({ externalId, publishedAt: 0 }));

  it("declares its metrics and scopes", () => {
    expect(linkedinPage.metrics).toMatchObject({ batch: 20, account: ["followers"] });
    expect(linkedinPage.metrics!.post).toContain("impressions");
  });

  it("fetches shares and ugcPosts in one request each and maps the totals", async () => {
    const m = mockFetch([
      [/shares=List/, () => ({ elements: [stats("share", "urn:li:share:1", 5), stats("share", "urn:li:share:2", 1)] })],
      [/ugcPosts=List/, () => ({ elements: [stats("ugcPost", "urn:li:ugcPost:3", 3)] })],
    ]);
    const res = await linkedinPage.postMetrics!(testContext(m.fetch, app), account, items);
    expect(m.requests).toHaveLength(2);
    expect(m.requests[0].url).toContain("q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A42");
    expect(m.requests[0].url).toContain("shares=List(urn%3Ali%3Ashare%3A1,urn%3Ali%3Ashare%3A2,urn%3Ali%3Ashare%3A9)");
    expect(m.requests[1].url).toContain("ugcPosts=List(urn%3Ali%3AugcPost%3A3)");
    expect(m.requests[0].headers["linkedin-version"]).toMatch(/^\d{6}$/);
    expect(m.requests[0].headers["x-restli-protocol-version"]).toBe("2.0.0");
    expect(res["urn:li:share:1"]).toEqual({ impressions: 50, reach: 40, clicks: 5, likes: 6, comments: 2, shares: 0 });
    expect(res["urn:li:ugcPost:3"]).toMatchObject({ impressions: 30 });
    expect(res["urn:li:share:9"]).toBeNull();
  });

  it("skips the ugcPosts request when there are none", async () => {
    const m = mockFetch([[/shares=List/, () => ({ elements: [] })]]);
    const res = await linkedinPage.postMetrics!(testContext(m.fetch, app), account, [{ externalId: "urn:li:share:1", publishedAt: 0 }]);
    expect(m.requests).toHaveLength(1);
    expect(res).toEqual({ "urn:li:share:1": null });
  });

  it("signals reconnect_required on ACCESS_DENIED", async () => {
    const m = mockFetch([[/organizationalEntityShareStatistics/, () => json({ serviceErrorCode: 100, code: "ACCESS_DENIED", message: "Not enough permissions" }, 403)]]);
    const err = await linkedinPage.postMetrics!(testContext(m.fetch, app), account, items).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
  });

  it("keeps revoked tokens as auth errors", async () => {
    const m = mockFetch([[/networkSizes/, () => json({ code: "REVOKED_ACCESS_TOKEN", message: "revoked" }, 403)]]);
    await expect(linkedinPage.accountMetrics!(testContext(m.fetch, app), account)).rejects.toMatchObject({ kind: "auth" });
  });

  it("reads the follower count", async () => {
    const m = mockFetch([["GET https://api.linkedin.com/rest/networkSizes/", () => ({ firstDegreeSize: 1234 })]]);
    expect(await linkedinPage.accountMetrics!(testContext(m.fetch, app), account)).toEqual({ followers: 1234 });
    expect(m.requests[0].url).toBe("https://api.linkedin.com/rest/networkSizes/urn%3Ali%3Aorganization%3A42?edgeType=COMPANY_FOLLOWED_BY_MEMBER");
  });
});
