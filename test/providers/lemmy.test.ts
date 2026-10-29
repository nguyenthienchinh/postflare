import { describe, expect, it } from "vitest";
import { counted } from "../../worker/providers/budget";
import { lemmy } from "../../worker/providers/lemmy";
import { image, json, mockFetch, noCopy, testAccount, testContext } from "../helpers";

const I = "https://lemmy.example";
const account = () =>
  testAccount({
    provider: "lemmy",
    externalId: "5@lemmy.example",
    credentials: { accessToken: "JWT", username: "me", password: "pw" },
    meta: { instance: I, personId: 5 },
  });
const post = (over: any = {}) => ({ id: "p1", content: "Body text", media: [], settings: { title: "A title", community: "12" }, ...over });

describe("lemmy connect / refresh", () => {
  it("logs in and loads the user", async () => {
    const { fetch, requests } = mockFetch([
      [`POST ${I}/api/v3/user/login`, () => ({ jwt: "JWT" })],
      [`GET ${I}/api/v3/site`, () => ({ my_user: { local_user_view: { person: { id: 5, name: "me", display_name: "Me", actor_id: `${I}/u/me` } } } })],
    ]);
    const [acc] = await lemmy.connect!(testContext(fetch), { instance: "lemmy.example", username: " me ", password: "pw" });
    expect(requests[0].json).toEqual({ username_or_email: "me", password: "pw" });
    expect(requests[1].headers.authorization).toBe("Bearer JWT");
    expect(acc).toMatchObject({
      externalId: "5@lemmy.example",
      name: "Me",
      username: "me@lemmy.example",
      credentials: { accessToken: "JWT", username: "me", password: "pw" },
      meta: { instance: I },
    });
    expect(acc.expiresAt).toBeGreaterThan(Date.now());
  });

  it("maps a wrong password to auth", async () => {
    const { fetch } = mockFetch([[/user\/login/, () => json({ error: "incorrect_login" }, 400)]]);
    await expect(lemmy.connect!(testContext(fetch), { instance: I, username: "me", password: "x" })).rejects.toMatchObject({ kind: "auth" });
  });

  it("refreshes by logging in again", async () => {
    const { fetch } = mockFetch([[/user\/login/, () => ({ jwt: "JWT2" })]]);
    const up = await lemmy.refresh!(testContext(fetch), account());
    expect(up.credentials).toEqual({ accessToken: "JWT2", username: "me", password: "pw" });
  });
});

describe("lemmy options", () => {
  it("lists subscribed communities", async () => {
    const { fetch, requests } = mockFetch([
      [
        `GET ${I}/api/v3/community/list`,
        () => ({ communities: [{ community: { id: 12, name: "tech", title: "Technology", actor_id: "https://lemmy.world/c/tech" } }] }),
      ],
    ]);
    expect(await lemmy.options!(testContext(fetch), account(), "community", {})).toEqual([{ value: "12", label: "Technology (tech@lemmy.world)" }]);
    expect(new URL(requests[0].url).searchParams.get("type_")).toBe("Subscribed");
  });
});

describe("lemmy publish", () => {
  it("creates a post", async () => {
    const { fetch, requests } = mockFetch([[`POST ${I}/api/v3/post`, () => ({ post_view: { post: { id: 99 } } })]]);
    const res = await lemmy.publish(testContext(fetch), account(), post({ settings: { title: "A title", community: "12", url: "example.com/x", nsfw: true } }));
    expect(res).toEqual({ status: "published", externalId: "99", url: `${I}/post/99` });
    expect(requests[0].json).toEqual({ name: "A title", community_id: 12, nsfw: true, body: "Body text", url: "https://example.com/x" });
  });

  it("resolves a community by name and uploads the image to pict-rs", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${I}/api/v3/community?name=memes%40lemmy.ml`, () => ({ community_view: { community: { id: 7 } } })],
      [`POST ${I}/pictrs/image`, () => ({ msg: "ok", files: [{ file: "abc.jpg", delete_token: "d" }] })],
      [`POST ${I}/api/v3/post`, () => ({ post_view: { post: { id: 100 } } })],
    ]);
    await lemmy.publish(noCopy(testContext(fetch)), account(), post({ content: "", media: [image()], settings: { title: "T", communityName: "!memes@lemmy.ml" } }));
    expect(requests[1].formData!.get("images[]")).toBeInstanceOf(Blob);
    // Streamed from R2 into the multipart body.
    expect((requests[1].formData!.get("images[]") as File).size).toBe(image().size);
    expect(requests[1].headers.authorization).toBe("Bearer JWT");
    expect(requests[2].json).toEqual({ name: "T", community_id: 7, nsfw: false, url: `${I}/pictrs/image/abc.jpg` });
  });

  it("re-logs in once when the session was revoked", async () => {
    let first = true;
    const { fetch, requests } = mockFetch([
      [`POST ${I}/api/v3/post`, () => (first ? ((first = false), json({ error: "not_logged_in" }, 400)) : { post_view: { post: { id: 1 } } })],
      [/user\/login/, () => ({ jwt: "NEW" })],
    ]);
    await lemmy.publish(testContext(fetch), account(), post());
    expect(requests[2].headers.authorization).toBe("Bearer NEW");
  });

  it("maps 401 to auth when re-login fails and validates title/community", async () => {
    const { fetch } = mockFetch([
      [/api\/v3\/post/, () => json({ error: "not_logged_in" }, 401)],
      [/user\/login/, () => json({ error: "incorrect_login" }, 401)],
    ]);
    await expect(lemmy.publish(testContext(fetch), account(), post())).rejects.toMatchObject({ kind: "auth" });
    expect(lemmy.validate!(post({ settings: {} }))).toEqual(["Lemmy posts need a title", "Choose a Lemmy community"]);
  });

  it("comments on the post", async () => {
    const { fetch, requests } = mockFetch([[`POST ${I}/api/v3/comment`, () => ({ comment_view: { comment: { id: 3 } } })]]);
    const r = await lemmy.reply!(testContext(fetch), account(), { rootId: "99", parentId: "99" }, post({ content: "nice" }));
    expect(r).toEqual({ externalId: "3", url: `${I}/comment/3` });
    expect(requests[0].json).toEqual({ post_id: 99, content: "nice" });
  });
});

describe("lemmy metrics", () => {
  const items = (...ids: string[]) => ids.map((externalId) => ({ externalId, publishedAt: Date.now() }));
  const view = (id: number, over: any = {}) => ({
    post_view: { post: { id, deleted: false, removed: false, ...over }, counts: { post_id: id, score: 8, upvotes: 10, downvotes: 2, comments: 4 } },
  });

  it("maps counts per post; missing and deleted → null", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${I}/api/v3/post?id=404`, () => json({ error: "couldnt_find_post" }, 404)],
      [`GET ${I}/api/v3/post?id=400`, () => json({ error: "couldnt_find_post" }, 400)],
      [`GET ${I}/api/v3/post?id=9`, () => view(9, { deleted: true })],
      [`GET ${I}/api/v3/post?id=`, () => view(1)],
    ]);
    const res = await lemmy.postMetrics!(testContext(fetch), account(), items("1", "404", "400", "9"));
    expect(res).toEqual({ "1": { likes: 10, comments: 4, extra: { score: 8, downvotes: 2 } }, "404": null, "400": null, "9": null });
    expect(requests[0].headers.authorization).toBe("Bearer JWT");
  });

  it("stops at the fetch budget", async () => {
    const { fetch, requests } = mockFetch([[`GET ${I}/api/v3/post`, () => view(1)]]);
    const res = await lemmy.postMetrics!(counted(testContext(fetch), 2), account(), items("1", "2", "3"));
    expect(requests).toHaveLength(2);
    expect(Object.keys(res)).toEqual(["1", "2"]);
  });

  it("reads the post count of the account", async () => {
    const { fetch, requests } = mockFetch([[`GET ${I}/api/v3/user`, () => ({ person_view: { counts: { person_id: 5, post_count: 17, comment_count: 30 } }, posts: [], comments: [] })]]);
    expect(await lemmy.accountMetrics!(testContext(fetch), account())).toEqual({ posts: 17, extra: { comment_count: 30 } });
    expect(new URL(requests[0].url).searchParams.get("person_id")).toBe("5");
  });
});
