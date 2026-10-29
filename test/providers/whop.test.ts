import { afterEach, describe, expect, it, vi } from "vitest";
import { whop } from "../../worker/providers/whop";
import { image, json, mockFetch, noCopy, testAccount, testContext, video } from "../helpers";

const APP = { clientId: "app_1" };
const B = "https://api.whop.com";
const account = testAccount({ provider: "whop", externalId: "user_1", credentials: { accessToken: "AT", refreshToken: "RT" } });
const post = (settings: Record<string, any> = {}, media: any[] = []) => ({ id: "p1", content: "Hello forum", media, settings: { company: "biz_1", experience: "exp_1", ...settings } });

afterEach(() => vi.useRealTimers());

describe("whop", () => {
  it("authorize uses PKCE and the forum scopes", async () => {
    const url = new URL(await whop.authorize!(testContext(mockFetch([]).fetch, APP, "whop"), { state: "S", codeVerifier: "v", codeChallenge: "CH" }));
    expect(url.origin + url.pathname).toBe(`${B}/oauth/authorize`);
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({
      response_type: "code",
      client_id: "app_1",
      redirect_uri: "https://pf.example.com/oauth/whop/callback",
      state: "S",
      code_challenge: "CH",
      code_challenge_method: "S256",
    });
    expect(q.scope.split(" ")).toEqual(expect.arrayContaining(["openid", "forum:post:create", "forum:read", "company:basic:read"]));
    expect(q.nonce).toBeTruthy();
  });

  it("callback exchanges the code and loads userinfo", async () => {
    const { fetch, requests } = mockFetch([
      [`POST ${B}/oauth/token`, () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      [`GET ${B}/oauth/userinfo`, () => ({ sub: "user_1", name: "Ada", preferred_username: "ada", picture: "https://img" })],
    ]);
    const [acc] = await whop.callback!(testContext(fetch, { ...APP, clientSecret: "sec" }, "whop"), { code: "C", codeVerifier: "V", params: new URLSearchParams() });
    expect(acc).toMatchObject({ externalId: "user_1", name: "Ada", username: "ada", avatarUrl: "https://img", credentials: { accessToken: "AT", refreshToken: "RT" } });
    expect(acc.expiresAt).toBeGreaterThan(Date.now());
    expect(requests[0].json).toEqual({
      grant_type: "authorization_code",
      code: "C",
      redirect_uri: "https://pf.example.com/oauth/whop/callback",
      code_verifier: "V",
      client_id: "app_1",
      client_secret: "sec",
    });
  });

  it("refreshes tokens", async () => {
    const { fetch, requests } = mockFetch([[`POST ${B}/oauth/token`, () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 7200 })]]);
    const upd = await whop.refresh!(testContext(fetch, APP), account);
    expect(upd.credentials).toEqual({ accessToken: "AT2", refreshToken: "RT2" });
    expect(requests[0].json).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT", client_id: "app_1" });
  });

  it("refresh with invalid_grant is an auth error", async () => {
    const { fetch } = mockFetch([[`POST ${B}/oauth/token`, () => json({ error: "invalid_grant" }, 400)]]);
    await expect(whop.refresh!(testContext(fetch, APP), account)).rejects.toMatchObject({ kind: "auth" });
  });

  it("publishes a text forum post", async () => {
    const { fetch, requests } = mockFetch([[`POST ${B}/api/v1/forum_posts`, () => ({ id: "post_1" })]]);
    const res = await whop.publish(testContext(fetch, APP), account, post({ title: "Hi" }));
    expect(res).toEqual({ status: "published", externalId: "post_1", url: "https://whop.com/experiences/exp_1/post_1", data: { experienceId: "exp_1" } });
    expect(requests[0].json).toEqual({ experience_id: "exp_1", content: "Hello forum", title: "Hi" });
    expect(requests[0].headers.authorization).toBe("Bearer AT");
  });

  it("uploads media by streaming and attaches ready files", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      [`POST ${B}/api/v1/files`, () => ({ id: `file_${++n}`, upload_url: `https://up.example.com/${n}`, upload_headers: { "x-amz-acl": "private" } })],
      ["PUT https://up.example.com/", () => new Response(null, { status: 200 })],
      [`GET ${B}/api/v1/files/`, () => ({ upload_status: "ready" })],
      [`POST ${B}/api/v1/forum_posts`, () => ({ id: "post_2" })],
    ]);
    const res = await whop.publish(testContext(fetch, APP), account, post({}, [image(), video()]));
    expect(res).toMatchObject({ status: "published", externalId: "post_2" });
    expect(requests[0].json).toEqual({ filename: "photo.jpg" });
    expect(requests[1]).toMatchObject({ method: "PUT", url: "https://up.example.com/1" });
    expect(requests[1].headers["x-amz-acl"]).toBe("private");
    expect(requests[1].body?.length).toBe(image().size);
    expect(requests.at(-1)!.json.attachments).toEqual([{ id: "file_1" }, { id: "file_2" }]);
  });

  it("returns pending while files process, then checkStatus creates the post once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let status = "pending";
    const { fetch, requests } = mockFetch([
      [`POST ${B}/api/v1/files`, () => ({ id: "file_1", upload_url: "https://up.example.com/1" })],
      ["PUT https://up.example.com/", () => new Response(null, { status: 200 })],
      [`GET ${B}/api/v1/files/file_1`, () => ({ upload_status: status })],
      [`POST ${B}/api/v1/forum_posts`, () => ({ id: "post_3" })],
    ]);
    const ctx = testContext(fetch, APP);
    const p = whop.publish(ctx, account, post({}, [video()]));
    let settled = false;
    p.finally(() => (settled = true));
    for (let i = 0; i < 20 && !settled; i++) await vi.advanceTimersByTimeAsync(3000);
    const res = await p;
    expect(res.status).toBe("pending");
    if (res.status !== "pending") return;
    expect(res.state).toMatchObject({ experienceId: "exp_1", fileIds: ["file_1"] });
    expect(requests.some((r) => r.url.endsWith("/forum_posts"))).toBe(false);

    expect((await whop.checkStatus!(ctx, account, res.state)).status).toBe("pending");
    status = "ready";
    expect(await whop.checkStatus!(ctx, account, res.state)).toMatchObject({ status: "published", externalId: "post_3" });
    expect(requests.filter((r) => r.url.endsWith("/forum_posts"))).toHaveLength(1);
  });

  it("checkStatus fails on a failed upload", async () => {
    const { fetch } = mockFetch([[`GET ${B}/api/v1/files/file_1`, () => ({ upload_status: "failed" })]]);
    await expect(whop.checkStatus!(testContext(fetch, APP), account, { experienceId: "e", content: "c", fileIds: ["file_1"] })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("replies to the previous item", async () => {
    const { fetch, requests } = mockFetch([[`POST ${B}/api/v1/forum_posts`, () => ({ id: "post_c" })]]);
    const r = await whop.reply!(testContext(fetch, APP), account, { rootId: "post_1", parentId: "post_b", rootData: { experienceId: "exp_1" } }, post());
    expect(r).toEqual({ externalId: "post_c", url: "https://whop.com/experiences/exp_1/post_1", urlIsPost: true, data: { experienceId: "exp_1" } });
    expect(requests[0].json).toEqual({ experience_id: "exp_1", content: "Hello forum", parent_id: "post_b" });
  });

  it("loads companies and forums", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${B}/api/v1/companies`, () => ({ data: [{ id: "biz_1", title: "Acme" }] })],
      [`GET ${B}/api/v1/forums`, () => ({ data: [{ id: "forum_1", experience: { id: "exp_1", name: "Community" } }] })],
    ]);
    const ctx = testContext(fetch, APP);
    expect(await whop.options!(ctx, account, "company", {})).toEqual([{ value: "biz_1", label: "Acme" }]);
    expect(await whop.options!(ctx, account, "experience", {})).toEqual([]);
    expect(await whop.options!(ctx, account, "experience", { company: "biz_1" })).toEqual([{ value: "exp_1", label: "Community" }]);
    expect(requests.at(-1)!.url).toContain("company_id=biz_1");
  });

  it("maps errors", async () => {
    const { fetch } = mockFetch([[`POST ${B}/api/v1/forum_posts`, () => json({ error: { message: "bad token" } }, 401)]]);
    await expect(whop.publish(testContext(fetch, APP), account, post())).rejects.toMatchObject({ kind: "auth" });
    await expect(whop.publish(testContext(fetch, APP), account, post({ experience: "" }))).rejects.toMatchObject({ kind: "invalid" });
  });
});

/** Runs `fn` with setTimeout firing immediately (skips the sleeps between polls). */
async function instantTimers<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => (cb(), 0)) as any);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe("whop subrequest budget", () => {
  it("bounds file processing polls by the subrequest budget", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      [`POST ${B}/api/v1/files`, () => ({ id: `file_${++n}`, upload_url: `https://up.example.com/${n}` })],
      ["PUT https://up.example.com/", () => new Response(null, { status: 200 })],
      [`GET ${B}/api/v1/files/`, () => ({ upload_status: "pending" })],
    ]);
    const media = [...Array.from({ length: 10 }, (_, i) => image({ id: `i${i}` })), video(), video({ id: "v2" })];
    const res = await instantTimers(() => whop.publish(noCopy(testContext(fetch, APP)), account, post({}, media)));
    expect(res.status).toBe("pending");
    expect(requests.length).toBeLessThanOrEqual(40);
    const before = requests.length;
    const err = await instantTimers(() => whop.reply!(testContext(fetch, APP), account, { rootId: "R", parentId: "R" }, post({}, media))).catch((e) => e);
    expect(err).toMatchObject({ kind: "transient" });
    expect(requests.length - before).toBeLessThanOrEqual(40);
  });
});
