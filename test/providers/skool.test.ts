import { describe, expect, it } from "vitest";
import { skool } from "../../worker/providers/skool";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const API = "https://api2.skool.com";
const account = testAccount({ provider: "skool", externalId: "u1", credentials: { auth_token: "AT", client_id: "CID" } });
const post = (settings: Record<string, any> = {}, media: any[] = []) => ({ id: "p1", content: "Hello community", media, settings: { group: "g1", title: "Title", ...settings } });

describe("skool", () => {
  it("connect verifies the cookies", async () => {
    const { fetch, requests } = mockFetch([[`GET ${API}/self`, () => ({ id: "u1", name: "ada-l", first_name: "Ada", last_name: "L", metadata: { picture_profile: "https://img" } })]]);
    const [acc] = await skool.connect!(testContext(fetch), { auth_token: "AT", client_id: "CID" });
    expect(acc).toMatchObject({ externalId: "u1", name: "Ada L", username: "ada-l", avatarUrl: "https://img", credentials: { auth_token: "AT", client_id: "CID" } });
    expect(requests[0].headers.cookie).toBe("auth_token=AT; client_id=CID");
  });

  it("connect requires both cookies", async () => {
    await expect(skool.connect!(testContext(mockFetch([]).fetch), { auth_token: "AT", client_id: "" })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("publishes a text post", async () => {
    const { fetch, requests } = mockFetch([
      [`POST ${API}/posts`, () => ({ id: "post1", name: "hello-community" })],
      [`GET ${API}/groups/g1`, () => ({ id: "g1", name: "my-group" })],
    ]);
    const res = await skool.publish(testContext(fetch), account, post({ label: "lab1" }));
    expect(res).toEqual({
      status: "published",
      externalId: "post1",
      url: "https://www.skool.com/my-group/hello-community",
      data: { group: "g1", slug: "my-group", name: "hello-community" },
    });
    expect(requests[0].url).toBe(`${API}/posts?follow=true`);
    expect(requests[0].json).toEqual({
      post_type: "generic",
      group_id: "g1",
      metadata: { title: "Title", content: "Hello community", attachments: "", labels: "lab1", action: 0, video_ids: "" },
    });
  });

  it("uploads media to the signed URL by streaming", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      [`POST ${API}/files`, () => ({ write_url: `https://s3.example.com/up/${++n}`, content_type: "image/jpeg", acl: "public-read", file: { id: `f${n}` } })],
      ["PUT https://s3.example.com/up/", () => new Response(null, { status: 200 })],
      [`POST ${API}/posts`, () => ({ id: "post2", name: "n" })],
      [`GET ${API}/groups/g1`, () => json({}, 404)],
    ]);
    const res = await skool.publish(testContext(fetch), account, post({ label: "none" }, [image(), video()]));
    expect(res).toMatchObject({ externalId: "post2", url: null });
    expect(requests[0].json).toMatchObject({ file_name: "photo.jpg", content_type: "image/jpeg", content_length: image().size, owner_id: "u1" });
    expect(requests[1]).toMatchObject({ method: "PUT", url: "https://s3.example.com/up/1" });
    expect(requests[1].headers).toMatchObject({ "x-amz-acl": "public-read", "content-type": "image/jpeg" });
    expect(requests[1].body?.length).toBe(image().size);
    expect(requests[2].json).toMatchObject({ content_type: "video/mp4", content_length: video().size });
    const body = requests.find((r) => r.url.startsWith(`${API}/posts`))!.json;
    expect(body.metadata.attachments).toBe("f1,f2");
    expect(body.metadata.labels).toBeUndefined();
  });

  it("replies as a comment chain", async () => {
    const { fetch, requests } = mockFetch([[`POST ${API}/posts`, () => ({ id: "c2", name: "x" })]]);
    const r = await skool.reply!(testContext(fetch), account, { rootId: "post1", parentId: "c1", rootData: { group: "g1", slug: "my-group", name: "hello" } }, post());
    expect(r).toEqual({ externalId: "c2", url: "https://www.skool.com/my-group/hello", urlIsPost: true });
    expect(requests[0].json).toMatchObject({ post_type: "comment", group_id: "g1", root_id: "post1", parent_id: "c1", metadata: { title: "", content: "Hello community" } });
  });

  it("loads groups and labels", async () => {
    const { fetch } = mockFetch([
      [`GET ${API}/users/u1/groups`, () => ({ groups: [{ id: "g1", name: "my-group", metadata: { display_name: "My Group" } }] })],
      [`GET ${API}/groups/g1`, () => ({ metadata: { labels: "l1,l2" } })],
      [`GET ${API}/groups/g2`, () => ({ metadata: {} })],
      [`GET ${API}/labels/l1`, () => ({ id: "l1", metadata: { display_name: "General" } })],
      [`GET ${API}/labels/l2`, () => ({ id: "l2", metadata: { display_name: "Wins" } })],
    ]);
    const ctx = testContext(fetch);
    expect(await skool.options!(ctx, account, "group", {})).toEqual([{ value: "g1", label: "My Group" }]);
    expect(await skool.options!(ctx, account, "label", { group: "g1" })).toEqual([
      { value: "l1", label: "General" },
      { value: "l2", label: "Wins" },
    ]);
    expect(await skool.options!(ctx, account, "label", { group: "g2" })).toEqual([{ value: "none", label: "Default" }]);
    expect(await skool.options!(ctx, account, "label", {})).toEqual([{ value: "none", label: "Default" }]);
  });

  it("maps errors", async () => {
    const { fetch } = mockFetch([
      [`GET ${API}/self`, () => json({ error: "unauthorized" }, 401)],
      [`POST ${API}/posts`, () => json({ error: "must be admin or level 3" }, 403)],
    ]);
    await expect(skool.connect!(testContext(fetch), { auth_token: "a", client_id: "b" })).rejects.toMatchObject({ kind: "auth" });
    await expect(skool.publish(testContext(fetch), account, post())).rejects.toMatchObject({ kind: "invalid" });
    expect(skool.validate!({ id: "x", content: "", media: [], settings: {} })).toHaveLength(2);
  });
});
