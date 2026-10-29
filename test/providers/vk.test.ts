import { describe, expect, it } from "vitest";
import { vk } from "../../worker/providers/vk";
import { image, json, mockFetch, noCopy, testAccount, testContext, video } from "../helpers";

const app = { clientId: "123" };
const account = () =>
  testAccount({ provider: "vk", externalId: "777", credentials: { accessToken: "AT", refreshToken: "RT", deviceId: "DEV" }, meta: { ownerId: "777" } });
const post = (over: any = {}) => ({ id: "p1", content: "Привет", media: [], settings: {}, ...over });
const ok = (response: unknown) => ({ response });

describe("vk oauth", () => {
  it("builds the VK ID authorize URL with PKCE", () => {
    const url = new URL(vk.authorize!(testContext(fetch, app, "vk"), { state: "S", codeVerifier: "v", codeChallenge: "CH" }) as string);
    expect(url.origin + url.pathname).toBe("https://id.vk.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "123",
      redirect_uri: "https://pf.example.com/oauth/vk/callback",
      state: "S",
      code_challenge: "CH",
      code_challenge_method: "S256",
      scope: "vkid.personal_info wall photos video",
    });
  });

  it("exchanges the code with device_id and verifier", async () => {
    const { fetch, requests } = mockFetch([
      ["POST https://id.vk.com/oauth2/auth", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600, user_id: 777 })],
      ["POST https://id.vk.com/oauth2/user_info", () => ({ user: { user_id: "777", first_name: "Ivan", last_name: "Petrov", avatar: "https://a" } })],
    ]);
    const [acc] = await vk.callback!(testContext(fetch, app, "vk"), {
      code: "C",
      codeVerifier: "VER",
      params: new URLSearchParams({ code: "C", device_id: "DEV", state: "S" }),
    });
    expect(requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "C", code_verifier: "VER", device_id: "DEV", client_id: "123" });
    expect(requests[1].form).toEqual({ client_id: "123", access_token: "AT" });
    expect(acc).toMatchObject({ externalId: "777", name: "Ivan Petrov", credentials: { accessToken: "AT", refreshToken: "RT", deviceId: "DEV" } });
    expect(acc.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes and stores the rotated refresh token", async () => {
    const { fetch, requests } = mockFetch([[/oauth2\/auth/, () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 })]]);
    const up = await vk.refresh!(testContext(fetch, app), account());
    expect(requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT", device_id: "DEV", client_id: "123" });
    expect(up.credentials).toEqual({ accessToken: "AT2", refreshToken: "RT2", deviceId: "DEV" });
  });

  it("maps invalid_grant to auth", async () => {
    const { fetch } = mockFetch([[/oauth2\/auth/, () => json({ error: "invalid_grant", error_description: "expired" }, 400)]]);
    await expect(vk.refresh!(testContext(fetch, app), account())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("vk publish", () => {
  it("posts text to the wall", async () => {
    const { fetch, requests } = mockFetch([["POST https://api.vk.com/method/wall.post", () => ok({ post_id: 55 })]]);
    const res = await vk.publish(testContext(fetch), account(), post({ settings: { closeComments: true } }));
    expect(res).toEqual({ status: "published", externalId: "55", url: "https://vk.com/wall777_55" });
    expect(requests[0].form).toMatchObject({ owner_id: "777", message: "Привет", close_comments: "1", guid: "p1", access_token: "AT", v: "5.199" });
    expect(requests[0].form!.attachments).toBeUndefined();
  });

  it("uploads photos and video, then attaches them", async () => {
    const { fetch, requests } = mockFetch([
      [/photos\.getWallUploadServer/, () => ok({ upload_url: "https://pu.vk.com/upload" })],
      ["POST https://pu.vk.com/upload", () => ({ server: 1, photo: '[{"x":1}]', hash: "h" })],
      [/photos\.saveWallPhoto/, () => ok([{ id: 9, owner_id: 777 }])],
      [/video\.save/, () => ok({ upload_url: "https://vu.vk.com/upload", video_id: 5, owner_id: 777, access_key: "k" })],
      ["POST https://vu.vk.com/upload", () => ({ size: 1000, video_id: 5 })],
      [/wall\.post/, () => ok({ post_id: 56 })],
    ]);
    await vk.publish(noCopy(testContext(fetch)), account(), post({ media: [image(), video({ size: 1000 })], settings: { link: "https://example.com" } }));
    expect(requests[1].formData!.get("photo")).toBeInstanceOf(Blob);
    expect((requests[1].formData!.get("photo") as File).size).toBe(image().size);
    expect(requests[2].form).toMatchObject({ server: "1", photo: '[{"x":1}]', hash: "h", user_id: "777" });
    expect(requests[3].form).toMatchObject({ name: "clip.mp4", wallpost: "0" });
    expect(requests[4].body).toContain('name="video_file"; filename="clip.mp4"');
    expect(requests[5].form!.attachments).toBe("photo777_9,video777_5_k,https://example.com");
  });

  it("maps VK API error codes", async () => {
    for (const [code, kind] of [
      [5, "auth"],
      [6, "rate_limit"],
      [100, "invalid"],
    ] as const) {
      const { fetch } = mockFetch([[/wall\.post/, () => ({ error: { error_code: code, error_msg: "err" } })]]);
      await expect(vk.publish(testContext(fetch), account(), post())).rejects.toMatchObject({ kind });
    }
    const { fetch } = mockFetch([[/wall\.post/, () => json({}, 401)]]);
    await expect(vk.publish(testContext(fetch), account(), post())).rejects.toMatchObject({ kind: "auth" });
  });

  it("comments on the root post", async () => {
    const { fetch, requests } = mockFetch([[/wall\.createComment/, () => ok({ comment_id: 8 })]]);
    const r = await vk.reply!(testContext(fetch), account(), { rootId: "55", parentId: "7" }, post({ id: "p1-r1", content: "c" }));
    expect(r).toEqual({ externalId: "8", url: "https://vk.com/wall777_55?reply=8" });
    expect(requests[0].form).toMatchObject({ owner_id: "777", post_id: "55", message: "c", guid: "p1-r1" });
  });
});
