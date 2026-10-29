import { describe, expect, it, vi } from "vitest";
import { counted } from "../../worker/providers/budget";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { threads } from "../../worker/providers/threads";
import { THREADS_GRAPH } from "../../worker/providers/meta-shared";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const mf = (routes: Array<[string | RegExp, unknown]>) =>
  mockFetch(routes.map(([k, h]) => [k, typeof h === "function" ? (h as any) : () => (h instanceof Response ? h.clone() : h)]));
const APP = { clientId: "THAPP", clientSecret: "THSECRET" };
const acc = () => testAccount({ provider: "threads", externalId: "U1", username: "me", credentials: { accessToken: "LONG" } });
const post = (over: Record<string, any> = {}) => ({ id: "p1", content: "Hello threads", media: [], settings: {}, ...over });

/** Containers C1, C2...; CAROUSEL parent is "PARENT"; statuses default to FINISHED. */
function thMock(statuses: Record<string, string> = {}) {
  let n = 0;
  return mf([
    [`POST ${THREADS_GRAPH}/U1/threads_publish`, (r: any) => ({ id: `T_${r.form.creation_id}` })],
    [`POST ${THREADS_GRAPH}/U1/threads`, (r: any) => ({ id: r.form.media_type === "CAROUSEL" ? "PARENT" : `C${++n}` })],
    [/\/T_[A-Z0-9]+\?/, (r: any) => ({ permalink: `https://www.threads.net/@me/post/${new URL(r.url).pathname.split("/").pop()}` })],
    [/\/(C\d+|PARENT)\?/, (r: any) => ({ status: statuses[new URL(r.url).pathname.split("/").pop()!] ?? "FINISHED" })],
  ]);
}

describe("threads", () => {
  it("builds the authorize URL", async () => {
    const url = new URL(await threads.authorize!(testContext(mf([]).fetch, APP, "threads"), { state: "S", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://www.threads.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("THAPP");
    expect(url.searchParams.get("scope")).toBe("threads_basic,threads_content_publish,threads_manage_replies,threads_manage_insights");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pf.example.com/oauth/threads/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("S");
    // Nothing that forces a new login (it would end the user's session on the platform's website).
    for (const k of ["force_reauth", "auth_type"]) expect(url.searchParams.has(k)).toBe(false);
  });

  it("exchanges the code for a long-lived token", async () => {
    const m = mf([
      ["POST https://graph.threads.net/oauth/access_token", { access_token: "SHORT", user_id: "U1" }],
      ["GET https://graph.threads.net/access_token", { access_token: "LONG", expires_in: 5184000 }],
      [`GET ${THREADS_GRAPH}/me`, { id: "U1", username: "me", name: "Me", threads_profile_picture_url: "https://pic" }],
    ]);
    const [a] = await threads.callback!(testContext(m.fetch, APP, "threads"), { code: "CODE#_", codeVerifier: "v", params: new URLSearchParams() });
    expect(a).toMatchObject({ externalId: "U1", name: "Me", username: "me", avatarUrl: "https://pic", profileUrl: "https://www.threads.net/@me", credentials: { accessToken: "LONG" } });
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(m.requests[0].form).toMatchObject({ client_id: "THAPP", client_secret: "THSECRET", code: "CODE", grant_type: "authorization_code", redirect_uri: "https://pf.example.com/oauth/threads/callback" });
    const ex = new URL(m.requests[1].url).searchParams;
    expect(ex.get("grant_type")).toBe("th_exchange_token");
    expect(ex.get("access_token")).toBe("SHORT");
  });

  it("refreshes the token", async () => {
    const m = mf([["GET https://graph.threads.net/refresh_access_token", { access_token: "NEW", expires_in: 5184000 }]]);
    const r = await threads.refresh!(testContext(m.fetch, APP), acc());
    expect(r.credentials.accessToken).toBe("NEW");
    expect(new URL(m.requests[0].url).searchParams.get("grant_type")).toBe("th_refresh_token");
  });

  it("publishes a text post immediately with settings", async () => {
    const m = thMock();
    const res = await threads.publish(
      testContext(m.fetch),
      acc(),
      post({ settings: { reply_control: "followers_only", topic_tag: "#dev", link_attachment: "https://example.com" } }),
    );
    expect(res).toEqual({ status: "published", externalId: "T_C1", url: "https://www.threads.net/@me/post/T_C1" });
    expect(m.requests[0].form).toEqual({
      media_type: "TEXT",
      text: "Hello threads",
      reply_control: "followers_only",
      topic_tag: "dev",
      link_attachment: "https://example.com",
    });
    expect(new URL(m.requests[0].url).searchParams.get("access_token")).toBe("LONG");
  });

  it("returns pending for a text container still processing", async () => {
    const m = thMock({ C1: "IN_PROGRESS" });
    expect(await threads.publish(testContext(m.fetch), acc(), post())).toMatchObject({ status: "pending", state: { step: "container", containerId: "C1" } });
  });

  it("publishes a video via pending → checkStatus, never twice", async () => {
    const statuses: Record<string, string> = { C1: "IN_PROGRESS" };
    const m = thMock(statuses);
    const ctx = testContext(m.fetch);
    const res = await threads.publish(ctx, acc(), post({ media: [video()] }));
    expect(res).toMatchObject({ status: "pending", retryAfterSeconds: 30 });
    expect(m.requests[0].form).toMatchObject({ media_type: "VIDEO", video_url: video().url, text: "Hello threads" });
    const state = (res as any).state;
    expect(await threads.checkStatus!(ctx, acc(), state)).toMatchObject({ status: "pending" });
    statuses.C1 = "FINISHED";
    expect(await threads.checkStatus!(ctx, acc(), state)).toMatchObject({ status: "published", externalId: "T_C1" });
    statuses.C1 = "PUBLISHED";
    expect(await threads.checkStatus!(ctx, acc(), state)).toMatchObject({ status: "published", externalId: "C1" });
    expect(m.requests.filter((r) => r.url.includes("threads_publish"))).toHaveLength(1);
  });

  it("publishes a carousel: children → parent → publish", async () => {
    const statuses: Record<string, string> = { C2: "IN_PROGRESS", PARENT: "IN_PROGRESS" };
    const m = thMock(statuses);
    const ctx = testContext(m.fetch);
    const res = await threads.publish(ctx, acc(), post({ media: [image(), image({ mime: "image/png" }), video()], settings: { reply_control: "mentioned_only" } }));
    expect(res).toMatchObject({ status: "pending", state: { step: "children", childIds: ["C1", "C2", "C3"] } });
    expect(m.requests[0].form).toMatchObject({ media_type: "IMAGE", image_url: image().url, is_carousel_item: "true", alt_text: "alt text" });
    expect(m.requests[0].form!.text).toBeUndefined();
    let r = await threads.checkStatus!(ctx, acc(), (res as any).state);
    expect(r).toMatchObject({ status: "pending", state: { step: "children" } });
    statuses.C2 = "FINISHED";
    r = await threads.checkStatus!(ctx, acc(), (r as any).state);
    expect(r).toMatchObject({ status: "pending", state: { step: "container", containerId: "PARENT" } });
    expect(m.requests.find((x) => x.form?.media_type === "CAROUSEL")!.form).toMatchObject({ children: "C1,C2,C3", text: "Hello threads", reply_control: "mentioned_only" });
    statuses.PARENT = "FINISHED";
    r = await threads.checkStatus!(ctx, acc(), (r as any).state);
    expect(r).toMatchObject({ status: "published", externalId: "T_PARENT" });
  });

  it("rejects unsupported image formats", async () => {
    await expect(threads.publish(testContext(mf([]).fetch), acc(), post({ media: [image({ mime: "image/webp", filename: "a.webp" })] }))).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("replies to the parent in the chain", async () => {
    const m = thMock();
    const r = await threads.reply!(testContext(m.fetch), acc(), { rootId: "ROOT", parentId: "PREV" }, post({ content: "2/2", media: [image()] }));
    expect(r).toEqual({ externalId: "T_C1", url: "https://www.threads.net/@me/post/T_C1" });
    expect(m.requests[0].form).toMatchObject({ reply_to_id: "PREV", media_type: "IMAGE", text: "2/2" });
  });

  it("surfaces container errors as invalid", async () => {
    const m = mf([[/\/C1\?/, { status: "ERROR", error_message: "MEDIA_FETCH_FAILED" }]]);
    await expect(threads.checkStatus!(testContext(m.fetch), acc(), { step: "container", containerId: "C1" })).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("MEDIA_FETCH_FAILED"),
    });
  });

  it("maps auth errors", async () => {
    const m = mf([[`POST ${THREADS_GRAPH}/U1/threads`, json({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, 400)]]);
    await expect(threads.publish(testContext(m.fetch), acc(), post())).rejects.toMatchObject({ kind: "auth" });
    const m401 = mf([[`POST ${THREADS_GRAPH}/U1/threads`, json({}, 401)]]);
    await expect(threads.publish(testContext(m401.fetch), acc(), post())).rejects.toMatchObject({ kind: "auth" });
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

describe("threads subrequest budget", () => {
  it("bounds reply polling by the subrequest budget", async () => {
    const statuses = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`C${i + 1}`, "IN_PROGRESS"]));
    const m = thMock(statuses);
    const media = Array.from({ length: 18 }, (_, i) => image({ id: `i${i}` }));
    const err = await instantTimers(() => threads.reply!(testContext(m.fetch), acc(), { rootId: "R", parentId: "R" }, post({ media }))).catch((e) => e);
    expect(err).toMatchObject({ kind: "transient" });
    expect(m.requests.length).toBeLessThanOrEqual(40);
  });

  it("a full 18-item reply carousel fits in one call", async () => {
    const m = thMock();
    const media = Array.from({ length: 18 }, (_, i) => image({ id: `i${i}` }));
    const r = await threads.reply!(testContext(m.fetch), acc(), { rootId: "R", parentId: "R" }, post({ media }));
    expect(r.externalId).toBe("T_PARENT");
    expect(m.requests.length).toBeLessThanOrEqual(40);
  });

  it("rejects reply carousels too big for one call", async () => {
    const m = thMock();
    const media = Array.from({ length: 19 }, (_, i) => image({ id: `i${i}` }));
    await expect(threads.reply!(testContext(m.fetch), acc(), { rootId: "R", parentId: "R" }, post({ media }))).rejects.toMatchObject({ kind: "invalid" });
    expect(m.requests).toHaveLength(0);
  });
});

describe("threads metrics", () => {
  const item = (externalId: string) => ({ externalId, publishedAt: 0 });
  const ins = (v: Record<string, number>) => ({ data: Object.entries(v).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }], id: `x/insights/${name}/lifetime` })) });

  it("requests threads_manage_insights", async () => {
    expect(threads.metrics?.scopes).toEqual(["threads_manage_insights"]);
    expect(threads.setupNotes).toContain("threads_manage_insights");
  });

  it("reads insights per post and maps the keys", async () => {
    const m = mf([[/\/T\d\/insights/, ins({ views: 400, likes: 20, replies: 3, reposts: 2, quotes: 1, shares: 5 })]]);
    const res = await threads.postMetrics!(testContext(m.fetch, APP), acc(), [item("T1"), item("T2")]);
    expect(m.requests).toHaveLength(2);
    const u = new URL(m.requests[0].url);
    expect(u.origin + u.pathname).toBe(`${THREADS_GRAPH}/T1/insights`);
    expect(u.searchParams.get("metric")).toBe("views,likes,replies,reposts,quotes,shares");
    expect(res.T1).toEqual({ views: 400, likes: 20, replies: 3, reposts: 2, quotes: 1, shares: 5 });
  });

  it("stops at the fetch budget", async () => {
    const m = mf([[/\/insights/, ins({ views: 1 })]]);
    const res = await threads.postMetrics!(counted(testContext(m.fetch, APP), 2), acc(), [item("T1"), item("T2"), item("T3")]);
    expect(m.requests).toHaveLength(2);
    expect(res).toEqual({ T1: { views: 1 }, T2: { views: 1 } });
  });

  it("returns null for deleted posts", async () => {
    const m = mf([[/\/insights/, json({ error: { message: "Object with ID 'T1' does not exist", code: 100, error_subcode: 33 } }, 400)]]);
    expect(await threads.postMetrics!(testContext(m.fetch, APP), acc(), [item("T1")])).toEqual({ T1: null });
  });

  it("signals reconnect_required on a permission error", async () => {
    const m = mf([[/insights/, json({ error: { message: "(#10) Application does not have permission for this action", code: 10 } }, 403)]]);
    const err = await threads.postMetrics!(testContext(m.fetch, APP), acc(), [item("T1")]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
    await expect(threads.accountMetrics!(testContext(m.fetch, APP), acc())).rejects.toMatchObject({ reason: "reconnect_required" });
  });

  it("reads followers from threads_insights", async () => {
    const m = mf([[`GET ${THREADS_GRAPH}/U1/threads_insights`, { data: [{ name: "followers_count", period: "day", total_value: { value: 321 } }] }]]);
    expect(await threads.accountMetrics!(testContext(m.fetch, APP), acc())).toEqual({ followers: 321 });
    expect(new URL(m.requests[0].url).searchParams.get("metric")).toBe("followers_count");
  });
});
