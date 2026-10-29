import { describe, expect, it } from "vitest";
import { linkedin } from "../../worker/providers/linkedin";
import { LINKEDIN_VERSION, littleText } from "../../worker/providers/linkedin-shared";
import { hollowMedia, image, json, lazyStream, mockFetch, testAccount, testContext, video } from "../helpers";

const app = { clientId: "cid", clientSecret: "csecret" };
const account = testAccount({ provider: "linkedin", externalId: "abc", meta: { personUrn: "urn:li:person:abc" }, expiresAt: Date.now() + 1e9 });
const post = (over: Partial<Parameters<typeof linkedin.publish>[2]> = {}) => ({ id: "p1", content: "Hello", media: [], settings: {}, ...over });
const created = (urn = "urn:li:share:1") => new Response(null, { status: 201, headers: { "x-restli-id": urn } });

describe("linkedin oauth", () => {
  it("builds the authorize URL", async () => {
    const ctx = testContext(mockFetch([]).fetch, app, "linkedin");
    const url = new URL(await linkedin.authorize!(ctx, { state: "st", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/linkedin/callback");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("exchanges the code and reads userinfo", async () => {
    const m = mockFetch([
      ["POST https://www.linkedin.com/oauth/v2/accessToken", () => ({ access_token: "AT", expires_in: 5184000, refresh_token: "RT", refresh_token_expires_in: 31536000 })],
      ["GET https://api.linkedin.com/v2/userinfo", () => ({ sub: "abc", name: "Ada L", picture: "https://pic" })],
    ]);
    const [acc] = await linkedin.callback!(testContext(m.fetch, app), { code: "c", codeVerifier: "", params: new URLSearchParams() });
    expect(acc).toMatchObject({
      externalId: "abc",
      name: "Ada L",
      avatarUrl: "https://pic",
      credentials: { accessToken: "AT", refreshToken: "RT" },
      meta: { personUrn: "urn:li:person:abc" },
    });
    expect(acc.refreshExpiresAt).toBeGreaterThan(Date.now() + 364 * 86400_000);
    expect(m.requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "c", client_id: "cid", client_secret: "csecret" });
  });

  it("refreshes when a refresh token exists", async () => {
    const m = mockFetch([["POST https://www.linkedin.com/oauth/v2/accessToken", () => ({ access_token: "AT2", expires_in: 100 })]]);
    const upd = await linkedin.refresh!(testContext(m.fetch, app), account);
    expect(upd.credentials).toMatchObject({ accessToken: "AT2", refreshToken: "RT" });
    expect(m.requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
  });

  it("keeps a valid token without refresh token, asks to reconnect once expired", async () => {
    const m = mockFetch([]);
    const noRt = { ...account, credentials: { accessToken: "AT" } };
    await expect(linkedin.refresh!(testContext(m.fetch, app), noRt)).resolves.toMatchObject({ credentials: { accessToken: "AT" } });
    await expect(linkedin.refresh!(testContext(m.fetch, app), { ...noRt, expiresAt: Date.now() - 1 })).rejects.toMatchObject({ kind: "auth" });
    expect(m.requests).toHaveLength(0);
  });
});

describe("linkedin publish", () => {
  it("posts text with versioned headers and little-text escaping", async () => {
    const m = mockFetch([["POST https://api.linkedin.com/rest/posts", () => created("urn:li:share:7")]]);
    const res = await linkedin.publish(
      testContext(m.fetch, app),
      account,
      post({ content: "Hi (there) #launch", settings: { visibility: "CONNECTIONS", disableReshare: true } }),
    );
    expect(res).toEqual({ status: "published", externalId: "urn:li:share:7", url: "https://www.linkedin.com/feed/update/urn:li:share:7/" });
    const r = m.requests[0];
    expect(r.headers["linkedin-version"]).toBe(LINKEDIN_VERSION);
    expect(r.headers["x-restli-protocol-version"]).toBe("2.0.0");
    expect(r.headers.authorization).toBe("Bearer AT");
    expect(r.json).toMatchObject({
      author: "urn:li:person:abc",
      commentary: "Hi \\(there\\) {hashtag|\\#|launch}",
      visibility: "CONNECTIONS",
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: true,
    });
    expect(r.json.content).toBeUndefined();
  });

  it("escapes text but keeps mentions", () => {
    expect(littleText("@[Acme](urn:li:organization:5) rocks_ #a_b")).toBe("@[Acme](urn:li:organization:5) rocks\\_ {hashtag|\\#|a_b}");
  });

  it("uploads a single image with alt text", async () => {
    const m = mockFetch([
      ["POST https://api.linkedin.com/rest/images?action=initializeUpload", () => ({ value: { uploadUrl: "https://upload.li/img1", image: "urn:li:image:1" } })],
      ["PUT https://upload.li/img1", () => new Response(null, { status: 201 })],
      ["POST https://api.linkedin.com/rest/posts", () => created()],
    ]);
    await linkedin.publish(testContext(m.fetch, app), account, post({ media: [image()] }));
    expect(m.requests[0].json).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc" } });
    expect(m.requests[1].method).toBe("PUT");
    expect(m.requests[2].json.content).toEqual({ media: { id: "urn:li:image:1", altText: "alt text" } });
  });

  it("creates multi-image posts", async () => {
    let n = 0;
    const m = mockFetch([
      ["POST https://api.linkedin.com/rest/images?action=initializeUpload", () => ({ value: { uploadUrl: `https://upload.li/${++n}`, image: `urn:li:image:${n}` } })],
      ["PUT https://upload.li/", () => new Response(null, { status: 201 })],
      ["POST https://api.linkedin.com/rest/posts", () => created()],
    ]);
    await linkedin.publish(testContext(m.fetch, app), account, post({ media: [image(), image({ alt: null, mime: "image/webp" })] }));
    expect(m.requests.at(-1)!.json.content).toEqual({
      multiImage: { images: [{ id: "urn:li:image:1", altText: "alt text" }, { id: "urn:li:image:2" }] },
    });
  });

  it("uploads video in parts, finalizes with ETags, then waits for processing", async () => {
    let status = "PROCESSING";
    const size = 10_000_000;
    const m = mockFetch([
      [
        "POST https://api.linkedin.com/rest/videos?action=initializeUpload",
        () => ({
          value: {
            video: "urn:li:video:9",
            uploadToken: "tok",
            uploadInstructions: [
              { uploadUrl: "https://up.li/p1", firstByte: 0, lastByte: 4194303 },
              { uploadUrl: "https://up.li/p2", firstByte: 4194304, lastByte: 8388607 },
              { uploadUrl: "https://up.li/p3", firstByte: 8388608, lastByte: size - 1 },
            ],
          },
        }),
      ],
      [/^https:\/\/up\.li\/p\d$/, (r) => new Response(null, { headers: { etag: `etag-${r.url.slice(-1)}` } })],
      ["POST https://api.linkedin.com/rest/videos?action=finalizeUpload", () => new Response(null, { status: 200 })],
      ["GET https://api.linkedin.com/rest/videos/", () => ({ status })],
      ["POST https://api.linkedin.com/rest/posts", () => created("urn:li:ugcPost:3")],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await linkedin.publish(ctx, account, post({ media: [video({ size })], settings: { mediaTitle: "Demo" } }));
    expect(res.status).toBe("pending");
    expect(m.requests[0].json.initializeUploadRequest).toMatchObject({ owner: "urn:li:person:abc", fileSizeBytes: size });
    const puts = m.requests.filter((r) => r.method === "PUT");
    expect(puts.map((p) => p.body?.length)).toEqual([4194304, 4194304, size - 8388608]);
    expect(m.requests.find((r) => r.url.includes("finalizeUpload"))!.json).toEqual({
      finalizeUploadRequest: { video: "urn:li:video:9", uploadToken: "tok", uploadedPartIds: ["etag-1", "etag-2", "etag-3"] },
    });
    expect(m.requests.some((r) => r.url.endsWith("/rest/posts"))).toBe(false);

    const state = (res as any).state;
    expect((await linkedin.checkStatus!(ctx, account, state)).status).toBe("pending");
    expect(m.requests.at(-1)!.url).toBe("https://api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3A9");
    status = "AVAILABLE";
    const done = await linkedin.checkStatus!(ctx, account, state);
    expect(done).toMatchObject({ status: "published", externalId: "urn:li:ugcPost:3" });
    expect(m.requests.at(-1)!.json.content).toEqual({ media: { id: "urn:li:video:9", title: "Demo" } });
  });

  it("uploads a 2GB video over several calls within the subrequest budget, resuming from state", async () => {
    const PART = 4 * 1024 * 1024;
    const size = 2048 * 1024 * 1024;
    const count = size / PART; // 512 parts dictated by LinkedIn
    const m = mockFetch([
      [
        "POST https://api.linkedin.com/rest/videos?action=initializeUpload",
        () => ({
          value: {
            video: "urn:li:video:big",
            uploadToken: "tok",
            uploadInstructions: Array.from({ length: count }, (_, i) => ({
              uploadUrl: `https://up.li/part/${i}`,
              firstByte: i * PART,
              lastByte: (i + 1) * PART - 1,
            })),
          },
        }),
      ],
      ["PUT https://up.li/part/", (r) => new Response(null, { headers: { etag: `e${r.url.split("/").pop()}` } })],
      ["POST https://api.linkedin.com/rest/videos?action=finalizeUpload", () => new Response(null, { status: 200 })],
    ]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    const ranges: number[][] = [];
    ctx.media.rangeStream = async (_v, offset, length) => (ranges.push([offset, length]), lazyStream(1));
    ctx.media.range = async () => {
      throw new Error("must not copy video bytes into memory");
    };
    const calls: number[] = [];
    let seen = 0;
    const track = () => (calls.push(m.requests.length - seen), (seen = m.requests.length));
    let res = await linkedin.publish(ctx, account, post({ media: [video({ size })] }));
    track();
    while (res.status === "pending" && (res.state as any).phase === "upload") {
      res = await linkedin.checkStatus!(ctx, account, JSON.parse(JSON.stringify(res.state)));
      track();
    }
    expect(res).toMatchObject({ status: "pending", state: { draft: { media: [{ urn: "urn:li:video:big" }] } } });
    expect(Math.max(...calls)).toBeLessThanOrEqual(40);
    expect(m.requests.filter((r) => r.url.includes("initializeUpload"))).toHaveLength(1);
    expect(ranges).toHaveLength(count);
    expect(ranges.every(([offset, len], i) => offset === i * PART && len === PART)).toBe(true);
    const fin = m.requests.find((r) => r.url.includes("finalizeUpload"))!;
    expect(fin.json.finalizeUploadRequest.uploadedPartIds).toEqual(Array.from({ length: count }, (_, i) => `e${i}`));
  });

  it("resumes after a failed part without re-initializing the upload", async () => {
    let fail = true;
    const m = mockFetch([
      [
        "POST https://api.linkedin.com/rest/videos?action=initializeUpload",
        () => ({
          value: {
            video: "urn:li:video:9",
            uploadInstructions: [
              { uploadUrl: "https://up.li/p1", firstByte: 0, lastByte: 9 },
              { uploadUrl: "https://up.li/p2", firstByte: 10, lastByte: 19 },
            ],
          },
        }),
      ],
      [
        /^https:\/\/up\.li\/p\d$/,
        (r) => {
          if (r.url.endsWith("p2") && fail) {
            fail = false;
            return new Response("busy", { status: 503 });
          }
          return new Response(null, { headers: { etag: `etag-${r.url.slice(-1)}` } });
        },
      ],
      ["POST https://api.linkedin.com/rest/videos?action=finalizeUpload", () => new Response(null, { status: 200 })],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await linkedin.publish(ctx, account, post({ media: [video({ size: 20 })] }));
    expect(res).toMatchObject({ status: "pending", state: { phase: "upload", upload: { etags: ["etag-1"] } } });
    const next = await linkedin.checkStatus!(ctx, account, (res as any).state);
    expect(next).toMatchObject({ status: "pending", state: { draft: { media: [{ urn: "urn:li:video:9" }] } } });
    expect(m.requests.filter((r) => r.url.includes("initializeUpload"))).toHaveLength(1);
    expect(m.requests.find((r) => r.url.includes("finalizeUpload"))!.json.finalizeUploadRequest.uploadedPartIds).toEqual(["etag-1", "etag-2"]);
  });

  it("splits 20 images over two calls to stay within the subrequest budget", async () => {
    let n = 0;
    const m = mockFetch([
      ["POST https://api.linkedin.com/rest/images?action=initializeUpload", () => ({ value: { uploadUrl: `https://upload.li/${++n}`, image: `urn:li:image:${n}` } })],
      ["PUT https://upload.li/", () => new Response(null, { status: 201 })],
      ["POST https://api.linkedin.com/rest/posts", () => created()],
    ]);
    const ctx = testContext(m.fetch, app);
    const images = Array.from({ length: 20 }, (_, i) => image({ id: `img${i}`, size: 1000 }));
    const res = await linkedin.publish(ctx, account, post({ media: images }));
    expect(res.status).toBe("pending");
    const first = m.requests.length;
    expect(first).toBeLessThanOrEqual(40);
    const done = await linkedin.checkStatus!(ctx, account, JSON.parse(JSON.stringify((res as any).state)));
    expect(done).toMatchObject({ status: "published" });
    expect(m.requests.length - first).toBeLessThanOrEqual(40);
    expect(m.requests.at(-1)!.json.content.multiImage.images).toHaveLength(20);
  });

  it("fails when video processing fails", async () => {
    const m = mockFetch([["GET https://api.linkedin.com/rest/videos/", () => ({ status: "PROCESSING_FAILED", processingFailureReason: "codec" })]]);
    const state = { draft: { author: "a", text: "", media: [{ urn: "urn:li:video:1", alt: null }], video: true, visibility: "PUBLIC", title: null, disableReshare: false } };
    await expect(linkedin.checkStatus!(testContext(m.fetch, app), account, state)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("validates video exclusivity", () => {
    expect(linkedin.validate!(post({ media: [video(), image()] }))).toHaveLength(1);
  });

  it("maps 401 and revoked tokens to auth", async () => {
    const m = mockFetch([["POST https://api.linkedin.com/rest/posts", () => json({ message: "Invalid access token", status: 401 }, 401)]]);
    await expect(linkedin.publish(testContext(m.fetch, app), account, post())).rejects.toMatchObject({ kind: "auth" });
    const m2 = mockFetch([["POST https://api.linkedin.com/rest/posts", () => json({ serviceErrorCode: 65601, code: "REVOKED_ACCESS_TOKEN" }, 403)]]);
    await expect(linkedin.publish(testContext(m2.fetch, app), account, post())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("linkedin comments", () => {
  it("comments on the root post", async () => {
    const m = mockFetch([
      ["POST https://api.linkedin.com/rest/socialActions/", () => json({ $URN: "urn:li:comment:(urn:li:share:1,55)", id: "55" }, 201)],
    ]);
    const r = await linkedin.reply!(testContext(m.fetch, app), account, { rootId: "urn:li:share:1", parentId: "urn:li:comment:x" }, post({ content: "First!" }));
    expect(r.externalId).toBe("urn:li:comment:(urn:li:share:1,55)");
    // No documented public link to one comment: the post's, flagged so the log does not call it the comment's.
    expect(r).toMatchObject({ url: "https://www.linkedin.com/feed/update/urn:li:share:1/", urlIsPost: true });
    expect(m.requests[0].url).toBe("https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A1/comments");
    expect(m.requests[0].json).toEqual({ actor: "urn:li:person:abc", object: "urn:li:share:1", message: { text: "First!" } });
  });
});
