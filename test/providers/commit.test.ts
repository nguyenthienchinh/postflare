import { describe, expect, it } from "vitest";
import { ProviderError } from "../../worker/providers/errors";
import { checkedCommit, commitCall, request } from "../../worker/providers/http";
import { FB_GRAPH, THREADS_GRAPH } from "../../worker/providers/meta-shared";
import type { CommitState, PublishPost } from "../../worker/providers/types";
import { devto } from "../../worker/providers/devto";
import { discord } from "../../worker/providers/discord";
import { facebook } from "../../worker/providers/facebook";
import { instagram } from "../../worker/providers/instagram";
import { linkedin } from "../../worker/providers/linkedin";
import { mastodon } from "../../worker/providers/mastodon";
import { pinterest } from "../../worker/providers/pinterest";
import { reddit } from "../../worker/providers/reddit";
import { slack } from "../../worker/providers/slack";
import { telegram } from "../../worker/providers/telegram";
import { threads } from "../../worker/providers/threads";
import { tiktok } from "../../worker/providers/tiktok";
import { tumblr } from "../../worker/providers/tumblr";
import { x } from "../../worker/providers/x";
import { youtube } from "../../worker/providers/youtube";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

// Commit semantics (docs/provider-brief.md): the request that creates the post is marked, and a failure after it may
// have reached the platform is "ambiguous" (never retried), while failures before it keep their retryable kinds.

type Route = Parameters<typeof mockFetch>[0][number];

/** testContext with a fresh CommitState, as the publishing workflow passes it. */
function ctxWith(routes: Route[], app: Record<string, string> = {}) {
  const m = mockFetch(routes);
  const ctx = testContext(m.fetch, app);
  const commit: CommitState = { sent: false, accepted: false };
  ctx.commit = commit;
  return { ctx, commit, requests: m.requests };
}

const netError = (): never => {
  throw new TypeError("fetch failed");
};

const post = (over: Partial<PublishPost> = {}): PublishPost => ({ id: "p1", content: "Hello", media: [], settings: {}, ...over });

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  const err = await p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

async function expectAmbiguous(p: Promise<unknown>, commit: CommitState) {
  const err = await failure(p);
  expect(err.kind).toBe("ambiguous");
  expect(commit.sent).toBe(true);
  expect(commit.accepted).toBe(false);
}

async function expectNotSent(p: Promise<unknown>, commit: CommitState, kind: ProviderError["kind"]) {
  const err = await failure(p);
  expect(err.kind).toBe(kind);
  expect(commit.sent).toBe(false);
}

describe("http request with commit", () => {
  const URL_ = "https://api.example.com/posts";

  it("network error on a commit request is ambiguous and marks it sent", async () => {
    const { ctx, commit } = ctxWith([[URL_, netError]]);
    await expectAmbiguous(request(ctx, URL_, { method: "POST", commit: true }), commit);
  });

  it("5xx and 408 on a commit request are ambiguous", async () => {
    for (const status of [500, 503, 408]) {
      const { ctx, commit } = ctxWith([[URL_, () => json({ message: "boom" }, status)]]);
      await expectAmbiguous(request(ctx, URL_, { method: "POST", commit: true }), commit);
    }
  });

  it("a classifier's transient stays ambiguous on a commit", async () => {
    const { ctx, commit } = ctxWith([[URL_, () => json({ error: "is_transient" }, 500)]]);
    await expectAmbiguous(request(ctx, URL_, { method: "POST", commit: true, classify: () => "transient" }), commit);
  });

  it("429 on a commit request is rate_limit, 400 invalid, 401 auth", async () => {
    for (const [status, kind] of [
      [429, "rate_limit"],
      [400, "invalid"],
      [401, "auth"],
    ] as const) {
      const { ctx, commit } = ctxWith([[URL_, () => json({}, status)]]);
      const err = await failure(request(ctx, URL_, { method: "POST", commit: true }));
      expect(err.kind).toBe(kind);
      expect(commit).toEqual({ sent: true, accepted: false });
    }
  });

  it("2xx marks the commit accepted", async () => {
    const { ctx, commit } = ctxWith([[URL_, () => ({ id: 1 })]]);
    await request(ctx, URL_, { method: "POST", commit: true });
    expect(commit).toEqual({ sent: true, accepted: true });
  });

  it("non-commit network errors and 5xx stay transient and leave the commit untouched", async () => {
    const { ctx, commit } = ctxWith([[URL_, netError]]);
    await expectNotSent(request(ctx, URL_), commit, "transient");
    const { ctx: c2, commit: k2 } = ctxWith([[URL_, () => json({}, 502)]]);
    await expectNotSent(request(c2, URL_), k2, "transient");
    await request(testContext(mockFetch([[URL_, () => ({})]]).fetch), URL_, { commit: true }); // no CommitState: fine
  });
});

describe("commitCall / checkedCommit", () => {
  it("marks sent and accepted around a successful call", async () => {
    const { ctx, commit } = ctxWith([]);
    expect(await commitCall(ctx, async () => 42)).toBe(42);
    expect(commit).toEqual({ sent: true, accepted: true });
  });

  it("turns unknown and transient errors into ambiguous", async () => {
    for (const thrown of [new Error("socket closed"), new ProviderError("5xx", "transient")]) {
      const { ctx, commit } = ctxWith([]);
      await expectAmbiguous(
        commitCall(ctx, async () => {
          throw thrown;
        }),
        commit,
      );
    }
  });

  it("passes definite refusals through", async () => {
    for (const kind of ["invalid", "auth", "rate_limit"] as const) {
      const { ctx, commit } = ctxWith([]);
      const err = await failure(
        commitCall(ctx, async () => {
          throw new ProviderError("no", kind);
        }),
      );
      expect(err.kind).toBe(kind);
      expect(commit).toEqual({ sent: true, accepted: false });
    }
  });

  it("checkedCommit undoes `accepted` when a 2xx body is a refusal, keeping an earlier commit's", async () => {
    const URL_ = "https://api.example.com/x";
    const { ctx, commit } = ctxWith([[URL_, () => ({ ok: false })]]);
    const send = () => request(ctx, URL_, { method: "POST", commit: true }).then((r) => r.json<any>());
    const refuse = (b: any) => {
      if (!b.ok) throw new ProviderError("refused", "invalid");
    };
    await failure(checkedCommit(ctx, send, refuse));
    expect(commit).toEqual({ sent: true, accepted: false });
    commit.accepted = true; // an earlier commit of the same call succeeded
    await failure(checkedCommit(ctx, send, refuse));
    expect(commit.accepted).toBe(true);
  });
});

describe("providers: network error on the create call is ambiguous, failures before it are not", () => {
  it("X: POST /2/tweets", async () => {
    const acc = testAccount({ provider: "x", username: "jack" });
    const a = ctxWith([["POST https://api.x.com/2/tweets", netError]]);
    await expectAmbiguous(x.publish(a.ctx, acc, post()), a.commit);
    const b = ctxWith([[/media\/upload/, () => json({}, 503)]]);
    await expectNotSent(x.publish(b.ctx, acc, post({ media: [image()] })), b.commit, "transient");
    const c = ctxWith([["POST https://api.x.com/2/tweets", netError]]);
    await expectAmbiguous(x.reply!(c.ctx, acc, { rootId: "1", parentId: "1" }, post()), c.commit);
  });

  it("Threads: threads_publish (container creation is not a commit)", async () => {
    const acc = testAccount({ provider: "threads", externalId: "U1", username: "me", credentials: { accessToken: "T" } });
    const a = ctxWith([
      [`POST ${THREADS_GRAPH}/U1/threads_publish`, netError],
      [`POST ${THREADS_GRAPH}/U1/threads`, () => ({ id: "C1" })],
      [`GET ${THREADS_GRAPH}/C1`, () => ({ status: "FINISHED" })],
    ]);
    await expectAmbiguous(threads.publish(a.ctx, acc, post()), a.commit);
    const b = ctxWith([[`POST ${THREADS_GRAPH}/U1/threads`, () => json({}, 500)]]);
    await expectNotSent(threads.publish(b.ctx, acc, post()), b.commit, "transient");
  });

  it("Instagram: media_publish in checkStatus; a 200 error body is a plain refusal", async () => {
    const acc = testAccount({ provider: "instagram", externalId: "IG1", username: "brand", credentials: { accessToken: "PT" } });
    const state = { host: FB_GRAPH, kind: "single", containers: ["C1"], published: [], mediaIds: [] };
    const a = ctxWith([
      [`GET ${FB_GRAPH}/C1`, () => ({ status_code: "FINISHED" })],
      [`POST ${FB_GRAPH}/IG1/media_publish`, netError],
    ]);
    await expectAmbiguous(instagram.checkStatus!(a.ctx, acc, state), a.commit);
    const b = ctxWith([
      [`GET ${FB_GRAPH}/C1`, () => ({ status_code: "FINISHED" })],
      [`POST ${FB_GRAPH}/IG1/media_publish`, () => ({ error: { message: "Media ID is not available", code: 9007 } })],
    ]);
    const err = await failure(instagram.checkStatus!(b.ctx, acc, state));
    expect(err.kind).toBe("invalid");
    expect(b.commit).toEqual({ sent: true, accepted: false });
    const c = ctxWith([[`GET ${FB_GRAPH}/C1`, () => json({}, 500)]]);
    await expectNotSent(instagram.checkStatus!(c.ctx, acc, state), c.commit, "transient");
  });

  it("Facebook: feed post; photo uploads before it are not commits; no preset fallback after an ambiguous failure", async () => {
    const page = testAccount({ provider: "facebook", externalId: "PAGE1", credentials: { accessToken: "PT" } });
    const a = ctxWith([[`POST ${FB_GRAPH}/PAGE1/feed`, netError]]);
    await expectAmbiguous(facebook.publish(a.ctx, page, post({ settings: { text_format_preset_id: "123" } })), a.commit);
    expect(a.requests.filter((r) => r.url.includes("/feed"))).toHaveLength(1);
    const b = ctxWith([[`POST ${FB_GRAPH}/PAGE1/photos`, () => json({}, 500)]]);
    await expectNotSent(facebook.publish(b.ctx, page, post({ media: [image(), image({ id: "i2" })] })), b.commit, "transient");
  });

  it("LinkedIn: POST /rest/posts; image upload init is not a commit", async () => {
    const acc = testAccount({ provider: "linkedin", externalId: "abc", meta: { personUrn: "urn:li:person:abc" } });
    const a = ctxWith([["POST https://api.linkedin.com/rest/posts", netError]]);
    await expectAmbiguous(linkedin.publish(a.ctx, acc, post()), a.commit);
    const b = ctxWith([[/images\?action=initializeUpload/, () => json({}, 503)]]);
    await expectNotSent(linkedin.publish(b.ctx, acc, post({ media: [image()] })), b.commit, "transient");
    const c = ctxWith([[/socialActions/, () => json({}, 502)]]);
    await expectAmbiguous(linkedin.reply!(c.ctx, acc, { rootId: "urn:li:share:1", parentId: "urn:li:share:1" }, post()), c.commit);
  });

  it("TikTok: photo init and the last video chunk are commits; the video init is not", async () => {
    const API = "https://open.tiktokapis.com/v2";
    const UPLOAD = "https://open-upload.tiktokapis.com/video/?upload_id=U1";
    const app = { clientKey: "CK", clientSecret: "CS" };
    const creator = [`POST ${API}/post/publish/creator_info/query/`, () => ({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } })] as Route;
    const acc = testAccount({ meta: { username: "me" } });
    const settings = { privacy_level: "SELF_ONLY" };

    const a = ctxWith([creator, [`POST ${API}/post/publish/content/init/`, netError]], app);
    await expectAmbiguous(tiktok.publish(a.ctx, acc, post({ settings, media: [image({ width: 1080, height: 1080 })] })), a.commit);

    const b = ctxWith([creator, [`POST ${API}/post/publish/video/init/`, () => json({}, 503)]], app);
    await expectNotSent(tiktok.publish(b.ctx, acc, post({ settings, media: [video({ size: 5_000_000 })] })), b.commit, "transient");

    const c = ctxWith(
      [creator, [`POST ${API}/post/publish/video/init/`, () => ({ data: { publish_id: "v1", upload_url: UPLOAD }, error: { code: "ok" } })], ["PUT " + UPLOAD, netError]],
      app,
    );
    await expectAmbiguous(tiktok.publish(c.ctx, acc, post({ settings, media: [video({ size: 5_000_000 })] })), c.commit);

    // A 5xx with TikTok's "internal_error" code on a commit stays ambiguous.
    const d = ctxWith([creator, [`POST ${API}/post/publish/content/init/`, () => json({ error: { code: "internal_error" } }, 500)]], app);
    await expectAmbiguous(tiktok.publish(d.ctx, acc, post({ settings, media: [image({ width: 1080, height: 1080 })] })), d.commit);
  });

  it("YouTube: the resumable session is retry-safe (pending, not ambiguous); comments are commits", async () => {
    const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=XYZ";
    const yt = post({ media: [video({ size: 1000 })], settings: { title: "T", privacy: "public" } });
    let created = false;
    const a = ctxWith([
      ["POST https://www.googleapis.com/upload/youtube/v3/videos", () => new Response(null, { status: 200, headers: { location: SESSION } })],
      [
        "PUT " + SESSION,
        (r) => {
          if (r.headers["content-range"].startsWith("bytes */")) return created ? json({ id: "VID" }, 201) : new Response(null, { status: 308 });
          created = true; // the bytes arrived and YouTube created the video, but the answer was lost
          throw new TypeError("connection reset");
        },
      ],
    ]);
    const res = await youtube.publish(a.ctx, testAccount(), yt);
    expect(res.status).toBe("pending");
    expect(a.commit).toEqual({ sent: false, accepted: false });
    // The resume probes the same session and finds the video: published once, and marked accepted.
    const done = await youtube.checkStatus!(a.ctx, testAccount(), (res as any).state);
    expect(done).toMatchObject({ status: "published", externalId: "VID" });
    expect(a.commit.accepted).toBe(true);
    expect(a.requests.filter((r) => r.method === "POST" && r.url.includes("/upload/"))).toHaveLength(1);

    const c = ctxWith([["POST https://www.googleapis.com/youtube/v3/commentThreads", netError]]);
    await expectAmbiguous(youtube.reply!(c.ctx, testAccount(), { rootId: "VID", parentId: "VID" }, post()), c.commit);
  });

  it("Telegram: send* calls; ok:false is a refusal; nothing to send is not sent", async () => {
    const acc = testAccount({ provider: "telegram", externalId: "-1001", credentials: { botToken: "TOKEN" }, meta: { chatId: "-1001" } });
    const a = ctxWith([[/sendMessage/, netError]]);
    await expectAmbiguous(telegram.publish(a.ctx, acc, post()), a.commit);
    const b = ctxWith([[/sendMessage/, () => ({ ok: false, description: "Bad Request: chat not found" })]]);
    expect((await failure(telegram.publish(b.ctx, acc, post()))).kind).toBe("invalid");
    expect(b.commit.accepted).toBe(false);
    const c = ctxWith([]);
    await expectNotSent(telegram.publish(c.ctx, acc, post({ content: "  " })), c.commit, "invalid");
    // Caption too long: media group accepted, then the separate text message fails → ambiguous after acceptance.
    const d = ctxWith([
      [/sendPhoto/, () => ({ ok: true, result: { message_id: 1, chat: { id: -1001 } } })],
      [/sendMessage/, () => json({ ok: false }, 502)],
    ]);
    const err = await failure(telegram.publish(d.ctx, acc, post({ content: "x".repeat(2000), media: [image()] })));
    expect(err.kind).toBe("ambiguous");
    expect(d.commit.accepted).toBe(true);
  });

  it("Discord: channel message", async () => {
    const app = { clientId: "C", clientSecret: "S", botToken: "BOT" };
    const acc = testAccount({ provider: "discord", externalId: "G1", credentials: {}, meta: { guildId: "G1" } });
    const p = post({ settings: { channel: "C1", postType: "message" } });
    const a = ctxWith([["POST https://discord.com/api/v10/channels/C1/messages", netError]], app);
    await expectAmbiguous(discord.publish(a.ctx, acc, p), a.commit);
    const b = ctxWith([[/\/guilds\/G1/, () => json({}, 503)]], app);
    await expectNotSent(discord.publish(b.ctx, acc, { ...p, media: [video({ size: 60_000_000 })] }), b.commit, "transient");
  });

  it("Slack: chat.postMessage / files.completeUploadExternal", async () => {
    const acc = testAccount({ provider: "slack", externalId: "T1", credentials: { accessToken: "xoxb" } });
    const p = post({ settings: { channel: "C1" } });
    const a = ctxWith([[/chat\.postMessage/, netError]]);
    await expectAmbiguous(slack.publish(a.ctx, acc, p), a.commit);
    const b = ctxWith([[/chat\.postMessage/, () => ({ ok: false, error: "channel_not_found" })]]);
    expect((await failure(slack.publish(b.ctx, acc, p))).kind).toBe("invalid");
    expect(b.commit.accepted).toBe(false);
    const c = ctxWith([[/chat\.postMessage/, () => ({ ok: false, error: "internal_error" })]]);
    expect((await failure(slack.publish(c.ctx, acc, p))).kind).toBe("ambiguous");
    const d = ctxWith([
      [/conversations\.join/, () => ({ ok: true })],
      [/files\.getUploadURLExternal/, () => json({}, 500)],
    ]);
    await expectNotSent(slack.publish(d.ctx, acc, { ...p, media: [image()] }), d.commit, "transient");
    const e = ctxWith([
      [/conversations\.join/, () => ({ ok: true })],
      [/files\.getUploadURLExternal/, () => ({ ok: true, upload_url: "https://files.slack.com/up/1", file_id: "F1" })],
      ["POST https://files.slack.com/up/1", () => new Response("OK")],
      [/files\.completeUploadExternal/, netError],
    ]);
    await expectAmbiguous(slack.publish(e.ctx, acc, { ...p, media: [image()] }), e.commit);
  });

  it("DEV: POST /articles", async () => {
    const acc = testAccount({ provider: "devto", externalId: "42", credentials: { apiKey: "KEY" } });
    const a = ctxWith([["POST https://dev.to/api/articles", netError]]);
    await expectAmbiguous(devto.publish(a.ctx, acc, post({ settings: { title: "T" } })), a.commit);
    const b = ctxWith([]);
    await expectNotSent(devto.publish(b.ctx, acc, post()), b.commit, "invalid");
  });

  it("Reddit: /api/submit; json.errors on a 200 is a refusal; media lease is not a commit", async () => {
    const acc = testAccount({ provider: "reddit", username: "spez" });
    const settings = { subreddit: "test", title: "Hi", kind: "self" };
    const a = ctxWith([[/\/api\/submit/, netError]]);
    await expectAmbiguous(reddit.publish(a.ctx, acc, post({ settings })), a.commit);
    const b = ctxWith([[/\/api\/submit/, () => ({ json: { errors: [["RATELIMIT", "you are doing that too much", "ratelimit"]] } })]]);
    expect((await failure(reddit.publish(b.ctx, acc, post({ settings })))).kind).toBe("rate_limit");
    expect(b.commit.accepted).toBe(false);
    const c = ctxWith([[/media\/asset\.json/, () => json({}, 503)]]);
    await expectNotSent(reddit.publish(c.ctx, acc, post({ settings: { ...settings, kind: "media" }, media: [image()] })), c.commit, "transient");
  });

  it("Pinterest: POST /pins; video registration is not a commit", async () => {
    const acc = testAccount({ provider: "pinterest" });
    const a = ctxWith([["POST https://api.pinterest.com/v5/pins", netError]]);
    await expectAmbiguous(pinterest.publish(a.ctx, acc, post({ settings: { board: "B1" }, media: [image()] })), a.commit);
    const b = ctxWith([["POST https://api.pinterest.com/v5/media", () => json({}, 503)]]);
    await expectNotSent(pinterest.publish(b.ctx, acc, post({ settings: { board: "B1" }, media: [video()] })), b.commit, "transient");
  });

  it("Tumblr: POST /posts; a 4xx media processing error is retryable, not ambiguous", async () => {
    const acc = testAccount({ provider: "tumblr", username: "blog", meta: { blog: "blog" } });
    const a = ctxWith([[/\/posts$/, netError]]);
    await expectAmbiguous(tumblr.publish(a.ctx, acc, post()), a.commit);
    const b = ctxWith([[/\/posts$/, () => json({ errors: [{ code: 8006, detail: "upload error" }] }, 400)]]);
    expect((await failure(tumblr.publish(b.ctx, acc, post()))).kind).toBe("transient");
  });

  it("Mastodon: the create is deduplicated by Idempotency-Key, so it stays retryable", async () => {
    const I = "https://social.example";
    const acc = testAccount({ provider: "mastodon", credentials: { accessToken: "AT" }, meta: { instance: I, maxCharacters: 500 } });
    const a = ctxWith([[`POST ${I}/api/v1/statuses`, netError]]);
    await expectNotSent(mastodon.publish(a.ctx, acc, post()), a.commit, "transient");
    expect(a.requests[0].headers["idempotency-key"]).toBe("p1");
  });
});
