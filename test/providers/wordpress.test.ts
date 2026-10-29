import { describe, expect, it } from "vitest";
import { slugify, toHtml, wordpress, wpUrl } from "../../worker/providers/wordpress";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const SITE = "https://blog.example.com";
const account = testAccount({
  provider: "wordpress",
  externalId: `${SITE}#1`,
  credentials: { siteUrl: SITE, username: "admin", password: "abcd efgh" },
  meta: { apiBase: `${SITE}/wp-json`, userId: 1 },
});
const post = (settings: Record<string, any> = {}, media: any[] = []) => ({ id: "p1", content: "Hello **world**\nline two\n\nSecond para", media, settings: { title: "Hello World!", ...settings } });

describe("wordpress", () => {
  it("connect verifies credentials with basic auth", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${SITE}/wp-json/wp/v2/users/me`, () => ({ id: 1, name: "Admin", slug: "admin", avatar_urls: { "24": "s", "96": "big" } })],
      [`GET ${SITE}/wp-json/`, () => ({ name: "My Blog", url: SITE })],
    ]);
    const [acc] = await wordpress.connect!(testContext(fetch), { siteUrl: `${SITE}/`, username: "admin", password: "abcd efgh" });
    expect(acc).toMatchObject({
      externalId: `${SITE}#1`,
      name: "My Blog",
      username: "admin",
      avatarUrl: "big",
      credentials: { siteUrl: SITE, username: "admin", password: "abcd efgh" },
      meta: { apiBase: `${SITE}/wp-json` },
    });
    expect(requests[0].headers.authorization).toBe(`Basic ${btoa("admin:abcd efgh")}`);
    expect(requests[0].url).toContain("context=edit");
  });

  it("falls back to ?rest_route= when /wp-json is missing", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${SITE}/wp-json`, () => json({ code: "rest_no_route" }, 404)],
      [/rest_route=%2Fwp%2Fv2%2Fusers%2Fme/, () => ({ id: 2, name: "B", slug: "b" })],
      [/rest_route=(%2F|\/)$/, () => ({ name: "Plain" })],
    ]);
    const [acc] = await wordpress.connect!(testContext(fetch), { siteUrl: SITE, username: "b", password: "p" });
    expect(acc.meta).toMatchObject({ apiBase: `${SITE}/?rest_route=` });
    expect(acc.name).toBe("Plain");
    expect(requests[1].url).toContain("context=edit");
  });

  it("rejects non-https sites", async () => {
    const { fetch } = mockFetch([]);
    await expect(wordpress.connect!(testContext(fetch), { siteUrl: "http://x.com", username: "a", password: "b" })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("publishes a text post as HTML", async () => {
    const { fetch, requests } = mockFetch([[`POST ${SITE}/wp-json/wp/v2/posts`, () => json({ id: 10, link: `${SITE}/hello-world` }, 201)]]);
    const res = await wordpress.publish(testContext(fetch), account, post({ status: "draft", excerpt: "ex" }));
    expect(res).toEqual({ status: "published", externalId: "10", url: `${SITE}/hello-world` });
    expect(requests[0].json).toEqual({
      title: "Hello World!",
      content: "<p>Hello <strong>world</strong><br>\nline two</p>\n\n<p>Second para</p>",
      status: "draft",
      slug: "hello-world",
      excerpt: "ex",
    });
  });

  it("uploads featured image and inline media by streaming, resolves terms", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      [`POST ${SITE}/wp-json/wp/v2/media/`, () => ({ id: 1 })],
      [`POST ${SITE}/wp-json/wp/v2/media`, () => json({ id: ++n + 100, source_url: `${SITE}/up/${n}` }, 201)],
      [`GET ${SITE}/wp-json/wp/v2/tags`, () => [{ id: 5, name: "News", slug: "news" }]],
      [`POST ${SITE}/wp-json/wp/v2/tags`, () => json({ code: "term_exists", data: { status: 400, term_id: 77 } }, 400)],
      [`GET ${SITE}/wp-json/wp/v2/categories`, () => []],
      [`POST ${SITE}/wp-json/wp/v2/categories`, () => json({ id: 9 }, 201)],
      [`POST ${SITE}/wp-json/wp/v2/posts`, () => ({ id: 11, link: "l" })],
    ]);
    await wordpress.publish(
      testContext(fetch),
      account,
      post({ categories: ["3", "Tech"], tags: ["news", "Other"], sticky: true, commentStatus: "closed" }, [image(), image({ id: "i2", alt: null, filename: "b.png", mime: "image/png" }), video()]),
    );
    const uploads = requests.filter((r) => r.url.split("?")[0] === `${SITE}/wp-json/wp/v2/media`);
    expect(uploads).toHaveLength(3);
    expect(uploads[0].headers["content-disposition"]).toBe('attachment; filename="photo.jpg"');
    expect(uploads[0].headers["content-type"]).toBe("image/jpeg");
    expect(uploads[0].body?.length).toBe(image().size);
    // alt text is sent with the upload itself (no second request)
    expect(new URL(uploads[0].url).searchParams.get("alt_text")).toBe("alt text");
    expect(new URL(uploads[1].url).searchParams.has("alt_text")).toBe(false);
    expect(requests.some((r) => r.url.startsWith(`${SITE}/wp-json/wp/v2/media/`))).toBe(false);
    const body = requests.at(-1)!.json;
    expect(body.featured_media).toBe(101);
    expect(body.content).toContain(`<img src="${SITE}/up/2" alt=""/>`);
    expect(body.content).toContain(`<video controls src="${SITE}/up/3"></video>`);
    expect(body.categories).toEqual([3, 9]);
    expect(body.tags).toEqual([5, 77]);
    expect(body.sticky).toBe(true);
    expect(body.comment_status).toBe("closed");
  });

  it("spreads many uploads and new terms over calls within the subrequest budget", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      [`POST ${SITE}/wp-json/wp/v2/media`, () => json({ id: ++n + 100, source_url: `${SITE}/up/${n}` }, 201)],
      [`GET ${SITE}/wp-json/wp/v2/tags`, () => []],
      [`POST ${SITE}/wp-json/wp/v2/tags`, (r) => json({ id: 500 + Number(r.json.name.slice(1)) }, 201)],
      [`POST ${SITE}/wp-json/wp/v2/posts`, () => ({ id: 11, link: "l" })],
    ]);
    const ctx = testContext(fetch);
    const media = [...Array.from({ length: 20 }, (_, i) => image({ id: `i${i}`, size: 100 })), ...Array.from({ length: 5 }, (_, i) => video({ id: `v${i}`, size: 100 }))];
    const tags = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const calls: number[] = [];
    let seen = 0;
    const track = () => (calls.push(requests.length - seen), (seen = requests.length));
    let res = await wordpress.publish(ctx, account, post({ tags }, media));
    track();
    while (res.status === "pending") {
      res = await wordpress.checkStatus!(ctx, account, JSON.parse(JSON.stringify(res.state)));
      track();
    }
    expect(res).toMatchObject({ status: "published", externalId: "11" });
    expect(Math.max(...calls)).toBeLessThanOrEqual(40);
    expect(requests.filter((r) => r.url.split("?")[0] === `${SITE}/wp-json/wp/v2/media`)).toHaveLength(25);
    const body = requests.at(-1)!.json;
    expect(body.featured_media).toBe(101);
    expect(body.tags).toHaveLength(10);
    expect(body.content.match(/<figure/g)).toHaveLength(24);
  });

  it("publishes pages without taxonomies", async () => {
    const { fetch, requests } = mockFetch([[`POST ${SITE}/wp-json/wp/v2/pages`, () => ({ id: 12, link: "l" })]]);
    await wordpress.publish(testContext(fetch), account, post({ postType: "pages", categories: ["1"], featuredFromFirstImage: false }));
    expect(requests).toHaveLength(1);
    expect(requests[0].json.categories).toBeUndefined();
  });

  it("loads options", async () => {
    const { fetch } = mockFetch([
      [`GET ${SITE}/wp-json/wp/v2/types`, () => ({ post: { name: "Posts", rest_base: "posts" }, page: { name: "Pages", rest_base: "pages" }, attachment: { name: "Media", rest_base: "media" }, wp_block: { name: "B", rest_base: "blocks" } })],
      [`GET ${SITE}/wp-json/wp/v2/categories`, () => [{ id: 1, name: "Uncategorized" }]],
    ]);
    const ctx = testContext(fetch);
    expect(await wordpress.options!(ctx, account, "postType", {})).toEqual([
      { value: "posts", label: "Posts" },
      { value: "pages", label: "Pages" },
    ]);
    expect(await wordpress.options!(ctx, account, "categories", {})).toEqual([{ value: "1", label: "Uncategorized" }]);
  });

  it("maps errors", async () => {
    const { fetch } = mockFetch([
      [`GET ${SITE}/wp-json/wp/v2/users/me`, () => json({ code: "incorrect_password", message: "bad" }, 401)],
      [`POST ${SITE}/wp-json/wp/v2/posts`, () => json({ code: "rest_cannot_create", message: "no" }, 401)],
    ]);
    await expect(wordpress.connect!(testContext(fetch), { siteUrl: SITE, username: "a", password: "b" })).rejects.toMatchObject({ kind: "auth" });
    await expect(wordpress.publish(testContext(fetch), account, post())).rejects.toMatchObject({ kind: "invalid" });
  });

  it("converts text helpers", () => {
    expect(toHtml("<p>already</p>")).toBe("<p>already</p>");
    expect(toHtml("## Head\n\n- a\n- b\n\n1. x\n2. y\n\nsee https://x.com & [l](https://y.com)")).toBe(
      '<h2>Head</h2>\n\n<ul><li>a</li><li>b</li></ul>\n\n<ol><li>x</li><li>y</li></ol>\n\n<p>see <a href="https://x.com">https://x.com</a> &amp; <a href="https://y.com">l</a></p>',
    );
    expect(slugify("Ça va? Très bien!")).toBe("ca-va-tres-bien");
    expect(wpUrl("https://s/?rest_route=", "/wp/v2/posts?x=1")).toBe("https://s/?rest_route=/wp/v2/posts&x=1");
  });
});
