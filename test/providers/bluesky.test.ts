import { describe, expect, it, vi } from "vitest";
import { bluesky, detectFacets, graphemeLength, jwtExpiry, makeTid, postTid } from "../../worker/providers/bluesky";
import { ProviderError } from "../../worker/providers/errors";
import { image, json, mockFetch, noCopy, testAccount, testContext, video } from "../helpers";

const PDS = "https://pds.example.com";
const jwt = (exp: number) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.y`;
const EXP = 2_000_000_000;

const account = () =>
  testAccount({
    provider: "bluesky",
    externalId: "did:plc:me",
    username: "me.bsky.social",
    credentials: { accessJwt: "AJ", refreshJwt: "RJ", identifier: "me.bsky.social", password: "app-pw" },
    meta: { pds: PDS, service: "https://bsky.social" },
  });

const post = (over: Partial<Parameters<typeof bluesky.publish>[2]> = {}) => ({
  id: "p1",
  content: "hello",
  media: [],
  settings: {},
  ...over,
});

describe("bluesky rich text", () => {
  it("computes UTF-8 byte offsets for links, mentions and tags", () => {
    const text = "héllo 👋 @alice.bsky.social see https://example.com/a?b=1. #tag!";
    const f = detectFacets(text);
    const enc = new TextEncoder().encode(text);
    const slice = (s: number, e: number) => new TextDecoder().decode(enc.slice(s, e));
    expect(f.map((x) => x.type)).toEqual(["mention", "link", "tag"]);
    expect(slice(f[0].start, f[0].end)).toBe("@alice.bsky.social");
    expect(slice(f[1].start, f[1].end)).toBe("https://example.com/a?b=1");
    expect(slice(f[2].start, f[2].end)).toBe("#tag");
  });

  it("ignores emails and numeric tags", () => {
    expect(detectFacets("mail me@example.com #123")).toEqual([]);
  });

  it("counts graphemes", () => {
    expect(graphemeLength("👨‍👩‍👧 ok")).toBe(4);
  });

  it("makes 13-char TIDs and reads JWT expiry", () => {
    expect(makeTid()).toMatch(/^[2-7a-z]{13}$/);
    expect(jwtExpiry(jwt(EXP))).toBe(EXP * 1000);
  });
});

describe("bluesky connect / refresh", () => {
  it("creates a session and uses the PDS from the DID document", async () => {
    const { fetch, requests } = mockFetch([
      [
        "POST https://bsky.social/xrpc/com.atproto.server.createSession",
        () => ({
          did: "did:plc:me",
          handle: "me.bsky.social",
          accessJwt: jwt(EXP),
          refreshJwt: "RJ",
          didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] },
        }),
      ],
      [`GET ${PDS}/xrpc/app.bsky.actor.getProfile`, () => ({ displayName: "Me", avatar: "https://cdn/a.jpg" })],
    ]);
    const [acc] = await bluesky.connect!(testContext(fetch), { identifier: "@me.bsky.social", password: "app-pw", service: "" });
    expect(requests[0].json).toEqual({ identifier: "me.bsky.social", password: "app-pw" });
    expect(acc.externalId).toBe("did:plc:me");
    expect(acc.name).toBe("Me");
    expect(acc.meta).toEqual({ pds: PDS, service: "https://bsky.social" });
    expect(acc.expiresAt).toBe(EXP * 1000);
    expect(acc.credentials.refreshJwt).toBe("RJ");
  });

  it("maps a bad password to auth", async () => {
    const { fetch } = mockFetch([[/createSession/, () => json({ error: "AuthenticationRequired", message: "Invalid identifier or password" }, 401)]]);
    await expect(bluesky.connect!(testContext(fetch), { identifier: "a", password: "b" })).rejects.toMatchObject({ kind: "auth" });
  });

  it("refreshes the session", async () => {
    const { fetch, requests } = mockFetch([
      [`POST ${PDS}/xrpc/com.atproto.server.refreshSession`, () => ({ accessJwt: jwt(EXP), refreshJwt: "RJ2", did: "did:plc:me" })],
    ]);
    const up = await bluesky.refresh!(testContext(fetch), account());
    expect(requests[0].headers.authorization).toBe("Bearer RJ");
    expect(up.credentials.refreshJwt).toBe("RJ2");
    expect(up.credentials.password).toBe("app-pw");
    expect(up.expiresAt).toBe(EXP * 1000);
  });

  it("falls back to a new login when the refresh token expired", async () => {
    const { fetch } = mockFetch([
      [/refreshSession/, () => json({ error: "ExpiredToken", message: "Token has expired" }, 400)],
      ["POST https://bsky.social/xrpc/com.atproto.server.createSession", () => ({ accessJwt: jwt(EXP), refreshJwt: "RJ3", did: "did:plc:me" })],
    ]);
    const up = await bluesky.refresh!(testContext(fetch), account());
    expect(up.credentials.refreshJwt).toBe("RJ3");
  });
});

describe("bluesky publish", () => {
  it("posts text with facets, resolved mentions and a link card", async () => {
    const { fetch, requests } = mockFetch([
      [/resolveHandle\?handle=bob\.bsky\.social/, () => ({ did: "did:plc:bob" })],
      [/resolveHandle/, () => json({ error: "InvalidRequest", message: "Unable to resolve handle" }, 400)],
      [
        "GET https://example.com/page",
        () =>
          new Response(
            `<html><head><meta property="og:title" content="Example &amp; Co"><meta name="description" content="Desc"><meta property="og:image" content="/img.png"></head></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
      ],
      ["GET https://example.com/img.png", () => new Response(new Uint8Array(10), { headers: { "content-type": "image/png" } })],
      [`POST ${PDS}/xrpc/com.atproto.repo.uploadBlob`, () => ({ blob: { ref: "thumb" } })],
      [`POST ${PDS}/xrpc/com.atproto.repo.createRecord`, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/3abc", cid: "bafy1" })],
    ]);
    const res = await bluesky.publish(
      testContext(fetch),
      account(),
      post({ content: "hi @bob.bsky.social @ghost.example #news https://example.com/page", settings: { lang: "en", label: "none" } }),
    );
    expect(res).toEqual({
      status: "published",
      externalId: "at://did:plc:me/app.bsky.feed.post/3abc",
      url: "https://bsky.app/profile/me.bsky.social/post/3abc",
      data: { uri: "at://did:plc:me/app.bsky.feed.post/3abc", cid: "bafy1" },
    });
    const create = requests.find((r) => r.url.includes("createRecord"))!;
    expect(create.headers.authorization).toBe("Bearer AJ");
    expect(create.json.repo).toBe("did:plc:me");
    expect(create.json.rkey).toMatch(/^[2-7a-z]{13}$/);
    const rec = create.json.record;
    expect(rec.langs).toEqual(["en"]);
    expect(rec.labels).toBeUndefined();
    expect(rec.facets.map((f: any) => f.features[0].$type)).toEqual([
      "app.bsky.richtext.facet#mention",
      "app.bsky.richtext.facet#tag",
      "app.bsky.richtext.facet#link",
    ]);
    expect(rec.facets[0].features[0].did).toBe("did:plc:bob");
    expect(rec.embed).toEqual({
      $type: "app.bsky.embed.external",
      external: { uri: "https://example.com/page", title: "Example & Co", description: "Desc", thumb: { ref: "thumb" } },
    });
  });

  it("uploads images, re-encoding ones over 1MB", async () => {
    const { fetch, requests } = mockFetch([
      [`POST ${PDS}/xrpc/com.atproto.repo.uploadBlob`, (r) => ({ blob: { mime: r.headers["content-type"] } })],
      [/createRecord/, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/3img", cid: "c" })],
    ]);
    const ctx = testContext(fetch);
    const calls: any[] = [];
    const orig = ctx.media.image;
    ctx.media.image = async (item, opts) => (calls.push(opts), orig(item, opts));
    await bluesky.publish(
      ctx,
      account(),
      post({
        content: "pics https://example.com",
        media: [image(), image({ id: "big", size: 3_000_000, mime: "image/heic", width: 4000, height: 3000, alt: null })],
        settings: { label: "porn" },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].format).toBe("image/jpeg");
    const rec = requests.find((r) => r.url.includes("createRecord"))!.json.record;
    expect(rec.labels.values).toEqual([{ val: "porn" }]);
    expect(rec.embed.$type).toBe("app.bsky.embed.images");
    expect(rec.embed.images).toEqual([
      { image: { mime: "image/jpeg" }, alt: "alt text", aspectRatio: { width: 1080, height: 1080 } },
      { image: { mime: "image/jpeg" }, alt: "", aspectRatio: { width: 4000, height: 3000 } },
    ]);
    // media present: no link card fetch
    expect(requests.some((r) => r.url.startsWith("https://example.com"))).toBe(false);
  });

  it("uploads video via the video service and goes pending while processing", async () => {
    let polls = 0;
    const { fetch, requests } = mockFetch([
      [`GET ${PDS}/xrpc/com.atproto.server.getServiceAuth`, () => ({ token: "SVC" })],
      ["POST https://video.bsky.app/xrpc/app.bsky.video.uploadVideo", () => ({ jobId: "job1", state: "JOB_STATE_CREATED" })],
      [
        "GET https://video.bsky.app/xrpc/app.bsky.video.getJobStatus",
        () =>
          ++polls < 9
            ? { jobStatus: { jobId: "job1", state: "JOB_STATE_ENCODING" } }
            : { jobStatus: { jobId: "job1", state: "JOB_STATE_COMPLETED", blob: { ref: "vid" } } },
      ],
      [/createRecord/, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/3vid", cid: "cv" })],
    ]);
    const ctx = testContext(fetch);
    // Skip the 3s waits between polls.
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => (fn(), 0)) as any);
    let res;
    try {
      res = await bluesky.publish(ctx, account(), post({ media: [video()] }));
    } finally {
      timer.mockRestore();
    }
    expect(res.status).toBe("pending");
    // The inline wait is bounded by a poll count (subrequests), not only by time.
    expect(polls).toBe(7);
    expect(requests.length).toBeLessThanOrEqual(40);
    const auth = requests.find((r) => r.url.includes("getServiceAuth"))!;
    const q = new URL(auth.url).searchParams;
    expect(q.get("aud")).toBe("did:web:pds.example.com");
    expect(q.get("lxm")).toBe("com.atproto.repo.uploadBlob");
    const up = requests.find((r) => r.url.includes("uploadVideo"))!;
    expect(up.headers.authorization).toBe("Bearer SVC");
    expect(new URL(up.url).searchParams.get("did")).toBe("did:plc:me");
    expect(up.body!.length).toBe(video().size);
    expect(requests.some((r) => r.url.includes("createRecord"))).toBe(false);

    const state = (res as any).state;
    const again = await bluesky.checkStatus!(ctx, account(), state);
    expect(again.status).toBe("pending");
    const done = await bluesky.checkStatus!(ctx, account(), state);
    expect(done).toMatchObject({ status: "published", url: "https://bsky.app/profile/me.bsky.social/post/3vid" });
    const rec = requests.find((r) => r.url.includes("createRecord"))!.json;
    expect(rec.rkey).toBe(state.rkey);
    expect(rec.record.embed).toEqual({ $type: "app.bsky.embed.video", video: { ref: "vid" }, aspectRatio: { width: 1080, height: 1920 } });
  });

  it("returns the existing record when a retried create finds it", async () => {
    const { fetch } = mockFetch([
      [/createRecord/, () => json({ error: "InvalidRequest", message: "Record already exists" }, 400)],
      [/getRecord/, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/3old", cid: "c0", value: {} })],
      [/getJobStatus/, () => ({ jobStatus: { state: "JOB_STATE_COMPLETED", blob: { ref: "v" } } })],
    ]);
    const res = await bluesky.checkStatus!(testContext(fetch), account(), {
      jobId: "j",
      rkey: "3old",
      record: { text: "x" },
      video: { alt: null, width: null, height: null },
    });
    expect(res).toMatchObject({ status: "published", externalId: "at://did:plc:me/app.bsky.feed.post/3old" });
  });

  it("fails on a failed video job", async () => {
    const { fetch } = mockFetch([[/getJobStatus/, () => ({ jobStatus: { state: "JOB_STATE_FAILED", error: "bad codec" } })]]);
    await expect(bluesky.checkStatus!(testContext(fetch), account(), { jobId: "j" })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("replies with root and parent refs", async () => {
    const { fetch, requests } = mockFetch([[/createRecord/, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/3r2", cid: "c2" })]]);
    const r = await bluesky.reply!(
      testContext(fetch),
      account(),
      {
        rootId: "at://root",
        parentId: "at://parent",
        rootData: { uri: "at://root", cid: "cr" },
        parentData: { uri: "at://parent", cid: "cp" },
      },
      post({ content: "second" }),
    );
    expect(requests[0].json.record.reply).toEqual({ root: { uri: "at://root", cid: "cr" }, parent: { uri: "at://parent", cid: "cp" } });
    expect(r).toEqual({ externalId: "at://did:plc:me/app.bsky.feed.post/3r2", url: "https://bsky.app/profile/me.bsky.social/post/3r2", data: { uri: "at://did:plc:me/app.bsky.feed.post/3r2", cid: "c2" } });
  });

  it("maps expired tokens to auth", async () => {
    const { fetch } = mockFetch([[/createRecord/, () => json({ error: "ExpiredToken", message: "Token has expired" }, 400)]]);
    const err = await bluesky.publish(testContext(fetch), account(), post()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");
    const { fetch: f401 } = mockFetch([[/createRecord/, () => json({ error: "AuthMissing" }, 401)]]);
    await expect(bluesky.publish(testContext(f401), account(), post())).rejects.toMatchObject({ kind: "auth" });
  });

  it("validates length", () => {
    expect(bluesky.validate!(post({ content: "a".repeat(301) }))).toHaveLength(1);
    expect(bluesky.validate!(post({ content: "a".repeat(300) }))).toEqual([]);
  });
});

describe("bluesky subrequest budget", () => {
  it("caps handle lookups (one fetch each) at 10", async () => {
    const { fetch, requests } = mockFetch([
      [/resolveHandle/, () => ({ did: "did:plc:x" })],
      [/createRecord/, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/3m", cid: "c" })],
    ]);
    const content = Array.from({ length: 15 }, (_, i) => `@u${i}.bsky.social`).join(" ");
    await bluesky.publish(testContext(fetch), account(), post({ content, settings: { linkCard: false } }));
    expect(requests.filter((r) => r.url.includes("resolveHandle"))).toHaveLength(10);
  });

  it("streams images within the limits instead of copying them", async () => {
    const { fetch, requests } = mockFetch([
      [`POST ${PDS}/xrpc/com.atproto.repo.uploadBlob`, () => ({ blob: { ref: "b" } })],
      [/createRecord/, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/3i", cid: "c" })],
    ]);
    await bluesky.publish(noCopy(testContext(fetch)), account(), post({ media: [image({ size: 500_000 })] }));
    const up = requests.find((r) => r.url.includes("uploadBlob"))!;
    expect(up.bodySize).toBe(500_000);
    expect(up.headers["content-type"]).toBe("image/jpeg");
  });
});

describe("bluesky metrics", () => {
  const uri = (k: string) => `at://did:plc:me/app.bsky.feed.post/${k}`;

  it("declares a batch of 25", () => {
    expect(bluesky.metrics).toMatchObject({ batch: 25, account: ["followers", "following", "posts"] });
  });

  it("fetches the batch in one getPosts request and maps the counts", async () => {
    const { fetch, requests } = mockFetch([
      [
        `GET ${PDS}/xrpc/app.bsky.feed.getPosts`,
        () => ({
          posts: [
            { uri: uri("a"), likeCount: 10, repostCount: 2, replyCount: 3, quoteCount: 1, bookmarkCount: 4 },
            { uri: uri("b"), likeCount: 0, repostCount: 0, replyCount: 0, quoteCount: 0 },
          ],
        }),
      ],
    ]);
    const res = await bluesky.postMetrics!(testContext(fetch), account(), [
      { externalId: uri("a"), data: { uri: uri("a"), cid: "c" }, publishedAt: 0 },
      { externalId: uri("b"), publishedAt: 0 },
      { externalId: uri("gone"), publishedAt: 0 },
    ]);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.getAll("uris")).toEqual([uri("a"), uri("b"), uri("gone")]);
    expect(requests[0].headers.authorization).toBe("Bearer AJ");
    expect(res).toEqual({
      [uri("a")]: { likes: 10, reposts: 2, replies: 3, quotes: 1, saves: 4 },
      [uri("b")]: { likes: 0, reposts: 0, replies: 0, quotes: 0 },
      [uri("gone")]: null,
    });
  });

  it("maps an expired session to auth", async () => {
    const { fetch } = mockFetch([[/getPosts/, () => json({ error: "ExpiredToken", message: "Token has expired" }, 400)]]);
    await expect(bluesky.postMetrics!(testContext(fetch), account(), [{ externalId: uri("a"), publishedAt: 0 }])).rejects.toMatchObject({ kind: "auth" });
  });

  it("reads profile counts", async () => {
    const { fetch, requests } = mockFetch([[`GET ${PDS}/xrpc/app.bsky.actor.getProfile`, () => ({ followersCount: 7, followsCount: 3, postsCount: 20 })]]);
    expect(await bluesky.accountMetrics!(testContext(fetch), account())).toEqual({ followers: 7, following: 3, posts: 20 });
    expect(new URL(requests[0].url).searchParams.get("actor")).toBe("did:plc:me");
  });
});

describe("bluesky deterministic record keys", () => {
  const TID = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
  const created = Date.UTC(2026, 9, 1, 12, 0, 0);
  const rkeyOf = async (p: ReturnType<typeof post>, reply = false) => {
    const { fetch, requests } = mockFetch([[/createRecord/, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/x", cid: "c" })]]);
    const target = { rootId: "at://root", parentId: "at://root", rootData: { uri: "at://root", cid: "cr" }, parentData: { uri: "at://root", cid: "cr" } };
    if (reply) await bluesky.reply!(testContext(fetch), account(), target, p);
    else await bluesky.publish(testContext(fetch), account(), { ...p, settings: { linkCard: false } });
    return requests.find((r) => r.url.includes("createRecord"))!.json.rkey as string;
  };

  it("uses the same valid TID for the same post across publish calls", async () => {
    const p = post({ id: "post_1", createdAt: created, scheduledAt: created + 3_600_000 });
    const a = await rkeyOf(p);
    const b = await rkeyOf(p);
    expect(a).toMatch(TID);
    expect(b).toBe(a);
    expect(postTid(p)).toBe(a);
    // A user retry changes scheduledAt, never createdAt: still the same key.
    expect(postTid({ ...p, scheduledAt: created + 7_200_000 })).toBe(a);
  });

  it("gives the root and each reply their own key", async () => {
    const root = await rkeyOf(post({ id: "post_1", createdAt: created }));
    const r1 = await rkeyOf(post({ id: "post_1-r1", createdAt: created }), true);
    const r2 = postTid({ id: "post_1-r2", createdAt: created });
    expect(new Set([root, r1, r2]).size).toBe(3);
    for (const k of [root, r1, r2]) expect(k).toMatch(TID);
  });

  it("returns the existing record when a retried create hits the reference PDS's 500 for a taken key", async () => {
    const p = post({ id: "post_1", createdAt: created, settings: { linkCard: false } });
    const rkey = postTid(p);
    const { fetch, requests } = mockFetch([
      [/createRecord/, () => json({ error: "InternalServerError", message: "Internal Server Error" }, 500)],
      [/getRecord/, () => ({ uri: `at://did:plc:me/app.bsky.feed.post/${rkey}`, cid: "c0", value: {} })],
    ]);
    const res = await bluesky.publish(testContext(fetch), account(), p);
    expect(res).toMatchObject({ status: "published", externalId: `at://did:plc:me/app.bsky.feed.post/${rkey}`, data: { cid: "c0" } });
    expect(new URL(requests.find((r) => r.url.includes("getRecord"))!.url).searchParams.get("rkey")).toBe(rkey);
  });

  it("finds a record created by a create whose answer was lost; rethrows when there is none", async () => {
    const p = post({ id: "post_1", createdAt: created, settings: { linkCard: false } });
    const lost = mockFetch([
      [
        /createRecord/,
        () => {
          throw new TypeError("connection reset");
        },
      ],
      [/getRecord/, () => ({ uri: "at://did:plc:me/app.bsky.feed.post/k", cid: "c1" })],
    ]);
    expect(await bluesky.publish(testContext(lost.fetch), account(), p)).toMatchObject({ status: "published", data: { cid: "c1" } });
    const none = mockFetch([
      [
        /createRecord/,
        () => {
          throw new TypeError("connection reset");
        },
      ],
      [/getRecord/, () => json({ error: "RecordNotFound", message: "Could not locate record" }, 400)],
    ]);
    // Retry-safe thanks to the deterministic key: transient (retried), not ambiguous.
    await expect(bluesky.publish(testContext(none.fetch), account(), p)).rejects.toMatchObject({ kind: "transient" });
  });

  it("reports the refresh JWT expiry", async () => {
    const { fetch } = mockFetch([[/refreshSession/, () => ({ accessJwt: jwt(EXP), refreshJwt: jwt(EXP + 86400 * 60), did: "did:plc:me" })]]);
    const up = await bluesky.refresh!(testContext(fetch), account());
    expect(up.refreshExpiresAt).toBe((EXP + 86400 * 60) * 1000);
  });
});
