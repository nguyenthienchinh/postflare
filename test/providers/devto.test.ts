import { describe, expect, it } from "vitest";
import { counted } from "../../worker/providers/budget";
import { devto, devtoTags } from "../../worker/providers/devto";
import { ProviderError } from "../../worker/providers/errors";
import { image, json, mockFetch, testAccount, testContext } from "../helpers";

const account = testAccount({ provider: "devto", externalId: "42", credentials: { apiKey: "KEY" } });
const post = (settings: Record<string, any> = {}, media = [] as ReturnType<typeof image>[]) => ({
  id: "p1",
  content: "# Hello\n\nBody",
  media,
  settings: { title: "My article", ...settings },
});

describe("devto", () => {
  it("connect verifies the API key", async () => {
    const { fetch, requests } = mockFetch([
      ["GET https://dev.to/api/users/me", () => ({ id: 42, name: "Ada", username: "ada", profile_image: "https://img/a.png" })],
    ]);
    const [acc] = await devto.connect!(testContext(fetch), { apiKey: " KEY " });
    expect(acc).toMatchObject({ externalId: "42", name: "Ada", username: "ada", profileUrl: "https://dev.to/ada", credentials: { apiKey: "KEY" } });
    expect(requests[0].headers["api-key"]).toBe("KEY");
  });

  it("publishes an article with all settings", async () => {
    const { fetch, requests } = mockFetch([["POST https://dev.to/api/articles", () => ({ id: 7, url: "https://dev.to/ada/my-article-1" })]]);
    const res = await devto.publish(
      testContext(fetch),
      account,
      post({ tags: ["JavaScript", "web-dev", "a", "b", "c"], canonical: "https://blog/x", series: "S1", organization: "9", published: false, description: "d" }),
    );
    expect(res).toEqual({ status: "published", externalId: "7", url: "https://dev.to/ada/my-article-1" });
    expect(requests[0].json.article).toEqual({
      title: "My article",
      body_markdown: "# Hello\n\nBody",
      published: false,
      tags: ["javascript", "webdev", "a", "b"],
      canonical_url: "https://blog/x",
      series: "S1",
      description: "d",
      organization_id: 9,
    });
  });

  it("uses the first image as cover and inlines the rest", async () => {
    const { fetch, requests } = mockFetch([["POST https://dev.to/api/articles", () => ({ id: 8, url: "u" })]]);
    await devto.publish(testContext(fetch), account, post({}, [image(), image({ id: "i2", url: "https://pf/i2.png", alt: "two" })]));
    const a = requests[0].json.article;
    expect(a.main_image).toBe(image().url);
    expect(a.body_markdown).toBe("# Hello\n\nBody\n\n![two](https://pf/i2.png)");
    expect(a.published).toBe(true);
  });

  it("requires a title", async () => {
    const { fetch } = mockFetch([]);
    expect(devto.validate!(post({ title: "" }))).toHaveLength(1);
    await expect(devto.publish(testContext(fetch), account, post({ title: " " }))).rejects.toMatchObject({ kind: "invalid" });
  });

  it("lists organizations from the user's articles", async () => {
    const { fetch } = mockFetch([
      ["GET https://dev.to/api/articles/me/all", () => [{ organization: { username: "acme" } }, { organization: { username: "acme" } }, {}]],
      ["GET https://dev.to/api/organizations/acme", () => ({ id: 5, name: "Acme", username: "acme" })],
    ]);
    expect(await devto.options!(testContext(fetch), account, "organization", {})).toEqual([{ value: "5", label: "Acme" }]);
  });

  it("maps errors", async () => {
    const { fetch } = mockFetch([
      ["GET https://dev.to/api/users/me", () => json({ error: "unauthorized", status: 401 }, 401)],
      ["POST https://dev.to/api/articles", () => json({ error: "Canonical url has already been taken", status: 422 }, 422)],
    ]);
    const err = await devto.connect!(testContext(fetch), { apiKey: "bad" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");
    await expect(devto.publish(testContext(fetch), account, post())).rejects.toMatchObject({ kind: "invalid" });
  });

  it("normalizes tags", () => {
    expect(devtoTags("React, Node.js ,react")).toEqual(["react", "nodejs"]);
  });
});

describe("devto metrics", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const art = (id: number, daysAgo: number, extra: Record<string, any> = {}) => ({
    id,
    published_at: new Date(now - daysAgo * 86400_000).toISOString(),
    page_views_count: id * 10,
    public_reactions_count: id,
    comments_count: 1,
    ...extra,
  });
  const page = (from: number, n: number, daysAgo: number) => Array.from({ length: n }, (_, i) => art(from + i, daysAgo));

  it("covers a batch with one request and maps the stats", async () => {
    const { fetch, requests } = mockFetch([["GET https://dev.to/api/articles/me/published", () => [art(7, 1), art(5, 2, { page_views_count: 0 })]]]);
    const res = await devto.postMetrics!(testContext(fetch), account, [
      { externalId: "7", publishedAt: now - 86400_000 },
      { externalId: "5", publishedAt: now - 2 * 86400_000 },
      { externalId: "99", publishedAt: now },
    ]);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.get("per_page")).toBe("30");
    expect(requests[0].headers["api-key"]).toBe("KEY");
    expect(res).toEqual({ "7": { views: 70, likes: 7, comments: 1 }, "5": { views: 0, likes: 5, comments: 1 }, "99": null });
  });

  it("pages back until the ids are found", async () => {
    const { fetch, requests } = mockFetch([
      ["GET https://dev.to/api/articles/me/published?per_page=30&page=1", () => page(1000, 30, 1)],
      ["GET https://dev.to/api/articles/me/published?per_page=30&page=2", () => [art(42, 40), ...page(2000, 29, 41)]],
    ]);
    const res = await devto.postMetrics!(testContext(fetch), account, [{ externalId: "42", publishedAt: now - 40 * 86400_000 }]);
    expect(requests).toHaveLength(2);
    expect(res).toEqual({ "42": { views: 420, likes: 42, comments: 1 } });
  });

  it("stops paging past the oldest publish date (rest → null)", async () => {
    const { fetch, requests } = mockFetch([["GET https://dev.to/api/articles/me/published", () => page(1000, 30, 30)]]);
    const res = await devto.postMetrics!(testContext(fetch), account, [{ externalId: "1", publishedAt: now }]);
    expect(requests).toHaveLength(1);
    expect(res).toEqual({ "1": null });
  });

  it("leaves unfound ids out when the budget runs out", async () => {
    const { fetch, requests } = mockFetch([["GET https://dev.to/api/articles/me/published", () => page(1000, 30, 0)]]);
    const res = await devto.postMetrics!(counted(testContext(fetch), 2), account, [{ externalId: "1", publishedAt: now - 365 * 86400_000 }]);
    expect(requests).toHaveLength(2);
    expect(res).toEqual({});
  });

  it("does not offer account metrics", () => {
    expect(devto.accountMetrics).toBeUndefined();
    expect(devto.metrics).toMatchObject({ post: ["views", "likes", "comments"], account: [] });
  });
});
