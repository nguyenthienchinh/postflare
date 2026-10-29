import { describe, expect, it } from "vitest";
import { medium, mediumTags } from "../../worker/providers/medium";
import { image, json, mockFetch, testAccount, testContext } from "../helpers";

const account = testAccount({ provider: "medium", externalId: "u1", credentials: { accessToken: "TOK" } });
const post = (settings: Record<string, any> = {}, media: any[] = []) => ({ id: "p1", content: "Story body", media, settings: { title: "Title", ...settings } });

describe("medium", () => {
  it("connect calls /v1/me", async () => {
    const { fetch, requests } = mockFetch([
      ["GET https://api.medium.com/v1/me", () => ({ data: { id: "u1", username: "ada", name: "Ada", url: "https://medium.com/@ada", imageUrl: "https://img" } })],
    ]);
    const [acc] = await medium.connect!(testContext(fetch), { token: "TOK" });
    expect(acc).toMatchObject({ externalId: "u1", name: "Ada", username: "ada", avatarUrl: "https://img", credentials: { accessToken: "TOK" } });
    expect(requests[0].headers.authorization).toBe("Bearer TOK");
  });

  it("publishes to the user profile with title heading and images", async () => {
    const { fetch, requests } = mockFetch([["POST https://api.medium.com/v1/users/u1/posts", () => json({ data: { id: "m1", url: "https://medium.com/@ada/m1" } }, 201)]]);
    const res = await medium.publish(
      testContext(fetch),
      account,
      post({ tags: ["a", "b", "c", "d", "e", "f"], canonical: "https://blog/x", publishStatus: "unlisted", license: "cc-40-by", notifyFollowers: false }, [image()]),
    );
    expect(res).toEqual({ status: "published", externalId: "m1", url: "https://medium.com/@ada/m1" });
    expect(requests[0].json).toEqual({
      title: "Title",
      contentFormat: "markdown",
      content: `# Title\n\nStory body\n\n![alt text](${image().url})`,
      publishStatus: "unlisted",
      tags: ["a", "b", "c", "d", "e"],
      canonicalUrl: "https://blog/x",
      license: "cc-40-by",
      notifyFollowers: false,
    });
  });

  it("publishes to a publication as draft without title heading", async () => {
    const { fetch, requests } = mockFetch([["POST https://api.medium.com/v1/publications/pub1/posts", () => ({ data: { id: "m2", url: "u" } })]]);
    await medium.publish(testContext(fetch), account, post({ publication: "pub1", publishStatus: "draft", prependTitle: false }));
    expect(requests[0].json).toMatchObject({ content: "Story body", publishStatus: "draft" });
  });

  it("lists publications", async () => {
    const { fetch } = mockFetch([["GET https://api.medium.com/v1/users/u1/publications", () => ({ data: [{ id: "pub1", name: "Pub" }] })]]);
    expect(await medium.options!(testContext(fetch), account, "publication", {})).toEqual([{ value: "pub1", label: "Pub" }]);
  });

  it("maps 401 and token error codes to auth", async () => {
    const { fetch } = mockFetch([
      ["GET https://api.medium.com/v1/me", () => json({ errors: [{ message: "Token was invalid.", code: 6003 }] }, 401)],
      ["POST https://api.medium.com/v1/users/u1/posts", () => json({ errors: [{ message: "Token expired", code: 6001 }] }, 400)],
    ]);
    await expect(medium.connect!(testContext(fetch), { token: "x" })).rejects.toMatchObject({ kind: "auth" });
    await expect(medium.publish(testContext(fetch), account, post())).rejects.toMatchObject({ kind: "auth" });
  });

  it("requires a title and limits tags", () => {
    expect(medium.validate!(post({ title: "" }))).toHaveLength(1);
    expect(mediumTags("#one, two")).toEqual(["one", "two"]);
  });
});
