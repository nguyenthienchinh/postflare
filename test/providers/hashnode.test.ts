import { describe, expect, it } from "vitest";
import { hashnode, tagSlug } from "../../worker/providers/hashnode";
import { image, json, mockFetch, testAccount, testContext, type RecordedRequest } from "../helpers";

const GQL = "POST https://gql.hashnode.com";
const account = testAccount({ provider: "hashnode", externalId: "pub1", credentials: { accessToken: "PAT" }, meta: { publicationId: "pub1" } });
const post = (settings: Record<string, any> = {}, media: any[] = []) => ({ id: "p1", content: "Body", media, settings: { title: "My title", ...settings } });

/** Routes GraphQL calls by operation. */
function gqlRouter(handlers: Record<string, (r: RecordedRequest) => unknown>) {
  return (r: RecordedRequest) => {
    const q: string = r.json.query;
    for (const [k, h] of Object.entries(handlers)) if (q.includes(k)) return h(r);
    return json({ errors: [{ message: `unexpected ${q}` }] });
  };
}

describe("hashnode", () => {
  it("connect returns one account per publication", async () => {
    const { fetch, requests } = mockFetch([
      [
        GQL,
        () => ({
          data: {
            me: {
              id: "u1",
              username: "ada",
              name: "Ada",
              profilePicture: "https://img",
              publications: { edges: [{ node: { id: "pub1", title: "Blog A", url: "https://a.hashnode.dev" } }, { node: { id: "pub2", title: "Blog B", url: "https://b.dev" } }] },
            },
          },
        }),
      ],
    ]);
    const accounts = await hashnode.connect!(testContext(fetch), { token: "PAT" });
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ externalId: "pub1", name: "Blog A", username: "ada", profileUrl: "https://a.hashnode.dev", credentials: { accessToken: "PAT" }, meta: { publicationId: "pub1", userId: "u1" } });
    expect(requests[0].headers.authorization).toBe("PAT");
  });

  it("publishes with resolved tags, cover and canonical url", async () => {
    const { fetch, requests } = mockFetch([
      [
        GQL,
        gqlRouter({
          "tag(slug": () => ({ data: { t0: { id: "tagJS", slug: "javascript", name: "JavaScript" }, t1: null } }),
          publishPost: () => ({ data: { publishPost: { post: { id: "post1", url: "https://a.hashnode.dev/my-title" } } } }),
        }),
      ],
    ]);
    const res = await hashnode.publish(
      testContext(fetch),
      account,
      post({ subtitle: "Sub", tags: ["JavaScript", "My New Tag"], canonical: "https://orig/x", series: "s1", slug: "custom", enableTableOfContent: true }, [image(), image({ url: "https://pf/2.jpg", alt: "" })]),
    );
    expect(res).toEqual({ status: "published", externalId: "post1", url: "https://a.hashnode.dev/my-title" });
    expect(requests[0].json.query).toContain('t0: tag(slug: "javascript")');
    expect(requests[0].json.query).toContain('t1: tag(slug: "my-new-tag")');
    const input = requests[1].json.variables.input;
    expect(input).toEqual({
      title: "My title",
      publicationId: "pub1",
      contentMarkdown: "Body\n\n![](https://pf/2.jpg)",
      tags: [{ id: "tagJS" }, { slug: "my-new-tag", name: "My New Tag" }],
      subtitle: "Sub",
      slug: "custom",
      seriesId: "s1",
      coverImageOptions: { coverImageURL: image().url },
      originalArticleURL: "https://orig/x",
      settings: { enableTableOfContent: true, delisted: false, slugOverridden: true },
    });
  });

  it("saves drafts with createDraft", async () => {
    const { fetch, requests } = mockFetch([[GQL, gqlRouter({ createDraft: () => ({ data: { createDraft: { draft: { id: "d1" } } } }) })]]);
    const res = await hashnode.publish(testContext(fetch), account, post({ status: "draft" }));
    expect(res).toMatchObject({ status: "published", externalId: "d1" });
    expect(requests[0].json.query).toContain("CreateDraftInput");
    expect(requests[0].json.variables.input.tags).toEqual([]);
  });

  it("lists series", async () => {
    const { fetch, requests } = mockFetch([[GQL, () => ({ data: { publication: { seriesList: { edges: [{ node: { id: "s1", name: "Series" } }] } } } })]]);
    expect(await hashnode.options!(testContext(fetch), account, "series", {})).toEqual([{ value: "s1", label: "Series" }]);
    expect(requests[0].json.variables).toEqual({ id: "pub1" });
  });

  it("maps GraphQL errors", async () => {
    const { fetch } = mockFetch([
      [GQL, gqlRouter({ "me {": () => ({ errors: [{ message: "Invalid token", extensions: { code: "UNAUTHENTICATED" } }] }), publishPost: () => ({ errors: [{ message: "Bad input", extensions: { code: "BAD_USER_INPUT" } }] }) })],
    ]);
    await expect(hashnode.connect!(testContext(fetch), { token: "x" })).rejects.toMatchObject({ kind: "auth" });
    await expect(hashnode.publish(testContext(fetch), account, post())).rejects.toMatchObject({ kind: "invalid", message: "Hashnode: Bad input" });
  });

  it("maps HTTP 401 to auth", async () => {
    const { fetch } = mockFetch([[GQL, () => json({ errors: [{ message: "nope" }] }, 401)]]);
    await expect(hashnode.publish(testContext(fetch), account, post())).rejects.toMatchObject({ kind: "auth" });
  });

  it("slugifies tags", () => {
    expect(tagSlug("Web Development!")).toBe("web-development");
    expect(hashnode.validate!(post({ title: "" }))).toHaveLength(1);
  });
});

describe("hashnode metrics", () => {
  const items = (...ids: string[]) => ids.map((externalId) => ({ externalId, publishedAt: Date.now() }));

  it("fetches a batch in one aliased query and maps the counts", async () => {
    const { fetch, requests } = mockFetch([
      [
        GQL,
        () => ({
          data: {
            p0: { id: "a", views: 120, reactionCount: 9, responseCount: 3, replyCount: 2 },
            p1: null,
          },
        }),
      ],
    ]);
    const res = await hashnode.postMetrics!(testContext(fetch), account, items("a", "draft1"));
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe("PAT");
    expect(requests[0].json.query).toContain(`p0: post(id: "a")`);
    expect(requests[0].json.query).toContain(`p1: post(id: "draft1")`);
    expect(res).toEqual({ a: { views: 120, likes: 9, comments: 5 }, draft1: null });
  });

  it("keeps partial data when one post errors", async () => {
    const { fetch } = mockFetch([
      [GQL, () => ({ data: { p0: { views: 1, reactionCount: 0, responseCount: 0, replyCount: 0 }, p1: null }, errors: [{ message: "Post not found", path: ["p1"], extensions: { code: "NOT_FOUND" } }] })],
    ]);
    expect(await hashnode.postMetrics!(testContext(fetch), account, items("a", "gone"))).toEqual({ a: { views: 1, likes: 0, comments: 0 }, gone: null });
  });

  it("caps the batch at 20 posts", async () => {
    const { fetch, requests } = mockFetch([[GQL, () => ({ data: {} })]]);
    const ids = Array.from({ length: 25 }, (_, i) => `id${i}`);
    const res = await hashnode.postMetrics!(testContext(fetch), account, items(...ids));
    expect(requests).toHaveLength(1);
    expect(Object.keys(res)).toHaveLength(20);
    expect(hashnode.metrics?.batch).toBe(20);
  });

  it("reads followers, following and posts", async () => {
    const { fetch, requests } = mockFetch([
      [GQL, () => ({ data: { me: { followersCount: 50, followingsCount: 4 }, publication: { posts: { totalDocuments: 12 } } } })],
    ]);
    expect(await hashnode.accountMetrics!(testContext(fetch), account)).toEqual({ followers: 50, following: 4, posts: 12 });
    expect(requests[0].json.variables).toEqual({ id: "pub1" });
  });
});
