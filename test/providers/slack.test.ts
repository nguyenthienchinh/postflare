import { afterEach, describe, expect, it, vi } from "vitest";
import { slack } from "../../worker/providers/slack";
import { image, mockFetch, testAccount, testContext, video } from "../helpers";

const API = "https://slack.com/api";
const app = { clientId: "CID", clientSecret: "SEC" };
const account = (over = {}) => testAccount({ provider: "slack", externalId: "T1", credentials: { accessToken: "xoxb" }, ...over });
const post = (over: Record<string, any> = {}) => ({ id: "p1", content: "Hello", media: [], settings: { channel: "C1" }, ...over });
const permalinkRoute: [string, () => unknown] = [`GET ${API}/chat.getPermalink`, () => ({ ok: true, permalink: "https://ws.slack.com/archives/C1/p1" })];

afterEach(() => vi.useRealTimers());

describe("slack oauth", () => {
  it("builds the authorize URL with bot scopes", () => {
    const url = new URL(slack.authorize!(testContext(mockFetch([]).fetch, app, "slack"), { state: "S", codeVerifier: "", codeChallenge: "" }) as string);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("CID");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/slack/callback");
    expect(url.searchParams.get("state")).toBe("S");
    expect(url.searchParams.get("scope")!.split(",")).toEqual(
      expect.arrayContaining(["chat:write", "chat:write.public", "channels:read", "groups:read", "files:write"]),
    );
  });

  it("exchanges the code and returns the workspace", async () => {
    const m = mockFetch([
      [`POST ${API}/oauth.v2.access`, () => ({ ok: true, access_token: "xoxb-1", team: { id: "T1", name: "Acme" }, bot_user_id: "U1" })],
      [`POST ${API}/auth.test`, () => ({ ok: true, url: "https://acme.slack.com/" })],
    ]);
    const [acc] = await slack.callback!(testContext(m.fetch, app, "slack"), { code: "C", codeVerifier: "", params: new URLSearchParams() });
    expect(m.requests[0].form).toMatchObject({ code: "C", client_id: "CID", client_secret: "SEC" });
    expect(acc).toMatchObject({ externalId: "T1", name: "Acme", username: "acme", profileUrl: "https://acme.slack.com/", expiresAt: null });
    expect(acc.credentials.accessToken).toBe("xoxb-1");
  });

  it("refreshes rotating tokens and maps invalid refresh to auth", async () => {
    const m = mockFetch([[`POST ${API}/oauth.v2.access`, () => ({ ok: true, access_token: "new", refresh_token: "r2", expires_in: 43200 })]]);
    const up = await slack.refresh!(testContext(m.fetch, app), account({ credentials: { accessToken: "old", refreshToken: "r1" } }));
    expect(m.requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1" });
    expect(up.credentials).toEqual({ accessToken: "new", refreshToken: "r2" });
    expect(up.expiresAt).toBeGreaterThan(Date.now());

    const bad = mockFetch([[`POST ${API}/oauth.v2.access`, () => ({ ok: false, error: "invalid_refresh_token" })]]);
    await expect(slack.refresh!(testContext(bad.fetch, app), account({ credentials: { refreshToken: "r1" } }))).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("slack options", () => {
  it("lists channels with pagination", async () => {
    let page = 0;
    const m = mockFetch([
      [
        `GET ${API}/conversations.list`,
        () =>
          page++ === 0
            ? { ok: true, channels: [{ id: "C2", name: "random" }], response_metadata: { next_cursor: "n" } }
            : { ok: true, channels: [{ id: "C1", name: "general" }, { id: "G1", name: "team", is_private: true }], response_metadata: { next_cursor: "" } },
      ],
    ]);
    expect(await slack.options!(testContext(m.fetch, app), account(), "channel", {})).toEqual([
      { value: "C1", label: "#general" },
      { value: "C2", label: "#random" },
      { value: "G1", label: "#team (private)" },
    ]);
    expect(new URL(m.requests[1].url).searchParams.get("cursor")).toBe("n");
    expect(m.requests[0].headers.authorization).toBe("Bearer xoxb");
  });
});

describe("slack publish", () => {
  it("posts a text message with permalink", async () => {
    const m = mockFetch([[`POST ${API}/chat.postMessage`, () => ({ ok: true, ts: "111.222", channel: "C1" })], permalinkRoute]);
    const res = await slack.publish(testContext(m.fetch, app), account(), post({ settings: { channel: "C1", unfurlLinks: false } }));
    expect(m.requests[0].form).toMatchObject({ channel: "C1", text: "Hello", unfurl_links: "false" });
    expect(res).toEqual({ status: "published", externalId: "111.222", url: "https://ws.slack.com/archives/C1/p1", data: { channel: "C1" } });
  });

  it("uploads image and video files and finds the message ts", async () => {
    let n = 0;
    const m = mockFetch([
      [`POST ${API}/conversations.join`, () => ({ ok: true })],
      [`POST ${API}/files.getUploadURLExternal`, () => ({ ok: true, upload_url: `https://files.slack.com/upload/v1/${++n}`, file_id: `F${n}` })],
      ["POST https://files.slack.com/upload/", () => new Response("OK - 1")],
      [`POST ${API}/files.completeUploadExternal`, () => ({ ok: true, files: [{ id: "F1", shares: { public: { C1: [{ ts: "333.444" }] } } }] })],
      permalinkRoute,
    ]);
    const res = await slack.publish(testContext(m.fetch, app), account(), post({ media: [image(), video({ size: 1000 })] }));
    const get = m.requests.filter((r) => r.url.includes("getUploadURLExternal"));
    expect(get[0].form).toMatchObject({ filename: "photo.jpg", length: "200000", alt_txt: "alt text" });
    const uploads = m.requests.filter((r) => r.url.startsWith("https://files.slack.com/"));
    expect(uploads.map((u) => u.body!.length)).toEqual([200_000, 1000]);
    const complete = m.requests.find((r) => r.url.includes("completeUploadExternal"))!;
    expect(complete.form).toMatchObject({ channel_id: "C1", initial_comment: "Hello" });
    expect(JSON.parse(complete.form!.files)).toEqual([
      { id: "F1", title: "photo.jpg" },
      { id: "F2", title: "clip.mp4" },
    ]);
    expect(res).toMatchObject({ status: "published", externalId: "333.444" });
  });

  it("returns pending when the share is not visible yet, then resolves in checkStatus", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let shared = false;
    const m = mockFetch([
      [`POST ${API}/conversations.join`, () => ({ ok: true })],
      [`POST ${API}/files.getUploadURLExternal`, () => ({ ok: true, upload_url: "https://files.slack.com/upload/v1/x", file_id: "F1" })],
      ["POST https://files.slack.com/upload/", () => new Response("OK")],
      [`POST ${API}/files.completeUploadExternal`, () => ({ ok: true, files: [{ id: "F1" }] })],
      [`GET ${API}/files.info`, () => ({ ok: true, file: shared ? { shares: { private: { C1: [{ ts: "9.9" }] } } } : {} })],
      permalinkRoute,
    ]);
    const ctx = testContext(m.fetch, app);
    const pending = slack.publish(ctx, account(), post({ media: [image()] }));
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;
    expect(res).toEqual({ status: "pending", state: { fileId: "F1", channel: "C1" }, retryAfterSeconds: 5 });
    shared = true;
    const done = await slack.checkStatus!(ctx, account(), (res as any).state);
    expect(done).toMatchObject({ status: "published", externalId: "9.9" });
    expect(m.requests.filter((r) => r.url.includes("completeUploadExternal"))).toHaveLength(1);
  });

  it("replies in the root thread", async () => {
    const m = mockFetch([[`POST ${API}/chat.postMessage`, () => ({ ok: true, ts: "5.5", channel: "C1" })], permalinkRoute]);
    const res = await slack.reply!(testContext(m.fetch, app), account(), { rootId: "1.1", parentId: "2.2" }, post({ content: "r" }));
    expect(m.requests[0].form).toMatchObject({ thread_ts: "1.1" });
    expect(res.externalId).toBe("5.5");
  });

  it("maps Slack auth errors and HTTP 401 to auth", async () => {
    const revoked = mockFetch([[`POST ${API}/chat.postMessage`, () => ({ ok: false, error: "token_revoked" })]]);
    await expect(slack.publish(testContext(revoked.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const unauth = mockFetch([[`POST ${API}/chat.postMessage`, () => new Response("", { status: 401 })]]);
    await expect(slack.publish(testContext(unauth.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const missing = mockFetch([[`POST ${API}/chat.postMessage`, () => ({ ok: false, error: "channel_not_found" })]]);
    await expect(slack.publish(testContext(missing.fetch, app), account(), post())).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("slack subrequest budget", () => {
  it("rejects more than 10 files per message", async () => {
    const m = mockFetch([]);
    const media = Array.from({ length: 11 }, (_, i) => image({ id: `i${i}` }));
    expect(slack.validate!(post({ media }))).toHaveLength(1);
    await expect(slack.publish(testContext(m.fetch, app), account(), post({ media }))).rejects.toMatchObject({ kind: "invalid" });
    expect(m.requests).toHaveLength(0);
  });
});
