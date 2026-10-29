import { describe, expect, it, vi } from "vitest";
import { counted } from "../../worker/providers/budget";
import { MetricsUnavailableError } from "../../worker/providers/errors";
import { mastodon } from "../../worker/providers/mastodon";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const I = "https://social.example";
const account = (meta: Record<string, unknown> = {}) =>
  testAccount({ provider: "mastodon", externalId: "1@social.example", credentials: { accessToken: "AT" }, meta: { instance: I, maxCharacters: 500, ...meta } });
const post = (over: any = {}) => ({ id: "p1", content: "Hello fediverse", media: [], settings: {}, ...over });

describe("mastodon connect", () => {
  it("verifies the token and stores the instance limits", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${I}/api/v1/accounts/verify_credentials`, () => ({ id: "42", username: "me", display_name: "Me", avatar: "https://a", url: `${I}/@me` })],
      [`GET ${I}/api/v2/instance`, () => ({ configuration: { statuses: { max_characters: 5000, max_media_attachments: 4 }, polls: { max_options: 4 } } })],
    ]);
    const [acc] = await mastodon.connect!(testContext(fetch), { instance: "social.example/", accessToken: " AT " });
    expect(requests[0].headers.authorization).toBe("Bearer AT");
    expect(acc).toMatchObject({
      externalId: "42@social.example",
      name: "Me",
      username: "@me@social.example",
      credentials: { accessToken: "AT" },
      meta: { instance: I, accountId: "42", maxCharacters: 5000 },
    });
  });

  it("maps 401 to auth", async () => {
    const { fetch } = mockFetch([[/verify_credentials/, () => json({ error: "The access token is invalid" }, 401)]]);
    await expect(mastodon.connect!(testContext(fetch), { instance: I, accessToken: "x" })).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("mastodon publish", () => {
  it("posts a status with settings and an idempotency key", async () => {
    const { fetch, requests } = mockFetch([[`POST ${I}/api/v1/statuses`, () => ({ id: "100", url: `${I}/@me/100` })]]);
    const res = await mastodon.publish(
      testContext(fetch),
      account(),
      post({ settings: { visibility: "unlisted", spoiler: "cw", language: "en", poll: true, pollOptions: "A\nB\n", pollExpiresIn: "3600", pollMultiple: true } }),
    );
    expect(res).toEqual({ status: "published", externalId: "100", url: `${I}/@me/100` });
    expect(requests[0].headers["idempotency-key"]).toBe("p1");
    expect(requests[0].json).toEqual({
      status: "Hello fediverse",
      visibility: "unlisted",
      spoiler_text: "cw",
      sensitive: true,
      language: "en",
      poll: { options: ["A", "B"], expires_in: 3600, multiple: true },
    });
  });

  it("enforces the instance character limit", async () => {
    const { fetch } = mockFetch([]);
    await expect(mastodon.publish(testContext(fetch), account({ maxCharacters: 10 }), post())).rejects.toMatchObject({ kind: "invalid" });
  });

  it("uploads images with alt text", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      [`POST ${I}/api/v2/media`, () => ({ id: `m${++n}`, url: "https://files/x.jpg" })],
      [`POST ${I}/api/v1/statuses`, () => ({ id: "101", url: `${I}/@me/101` })],
    ]);
    await mastodon.publish(testContext(fetch), account(), post({ media: [image({ size: 100 }), image({ size: 50, alt: null })], settings: { sensitive: true } }));
    const up = requests.filter((r) => r.url.endsWith("/api/v2/media"));
    expect(up).toHaveLength(2);
    expect(up[0].body).toContain('name="file"; filename="photo.jpg"');
    expect(up[0].body).toContain('name="description"\r\n\r\nalt text');
    expect(up[1].body).not.toContain('name="description"');
    const status = requests.find((r) => r.url.endsWith("/statuses"))!.json;
    expect(status.media_ids).toEqual(["m1", "m2"]);
    expect(status.sensitive).toBe(true);
  });

  it("returns pending while a video is processing, then posts", async () => {
    let ready = false;
    const { fetch, requests } = mockFetch([
      [`POST ${I}/api/v2/media`, () => json({ id: "v1", url: null }, 202)],
      [`GET ${I}/api/v1/media/v1`, () => (ready ? { id: "v1", url: "https://files/v.mp4" } : json({ id: "v1", url: null }, 206))],
      [`POST ${I}/api/v1/statuses`, () => ({ id: "102", url: `${I}/@me/102` })],
    ]);
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => (t += 30_000);
    let res;
    try {
      res = await mastodon.publish(testContext(fetch), account(), post({ media: [video({ size: 1000 })] }));
    } finally {
      Date.now = realNow;
    }
    expect(res).toMatchObject({ status: "pending", state: { processing: ["v1"], key: "p1" } });
    expect(requests.some((r) => r.url.endsWith("/statuses"))).toBe(false);
    const state = (res as any).state;
    expect(await mastodon.checkStatus!(testContext(fetch), account(), state)).toMatchObject({ status: "pending" });
    ready = true;
    expect(await mastodon.checkStatus!(testContext(fetch), account(), state)).toEqual({ status: "published", externalId: "102", url: `${I}/@me/102` });
    expect(requests.find((r) => r.url.endsWith("/statuses"))!.json.media_ids).toEqual(["v1"]);
  });

  it("rejects polls with media", async () => {
    const { fetch } = mockFetch([[/media/, () => ({ id: "m1", url: "u" })]]);
    await expect(
      mastodon.publish(testContext(fetch), account(), post({ media: [image()], settings: { poll: true, pollOptions: "a\nb" } })),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("replies with in_reply_to_id", async () => {
    const { fetch, requests } = mockFetch([[/statuses/, () => ({ id: "103", url: `${I}/@me/103` })]]);
    const r = await mastodon.reply!(testContext(fetch), account(), { rootId: "100", parentId: "102" }, post({ id: "p1-r2", settings: { visibility: "public", poll: true } }));
    expect(r).toEqual({ externalId: "103", url: `${I}/@me/103` });
    expect(requests[0].json).toEqual({ status: "Hello fediverse", visibility: "public", in_reply_to_id: "102" });
    expect(requests[0].headers["idempotency-key"]).toBe("p1-r2");
  });

  it("maps 401 / 422 / 429", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [422, "invalid"],
      [429, "rate_limit"],
    ] as const) {
      const { fetch } = mockFetch([[/statuses/, () => json({ error: "nope" }, status)]]);
      await expect(mastodon.publish(testContext(fetch), account(), post())).rejects.toMatchObject({ kind });
    }
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

describe("mastodon subrequest budget", () => {
  it("bounds reply processing polls by the subrequest budget", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      [`POST ${I}/api/v2/media`, () => json({ id: `m${++n}`, url: null }, 202)],
      [/\/api\/v1\/media\//, () => json({ url: null }, 206)],
    ]);
    const media = [image(), image({ id: "b" }), image({ id: "c" }), image({ id: "d" })];
    const err = await instantTimers(() => mastodon.reply!(testContext(fetch), account(), { rootId: "1", parentId: "1" }, post({ media }))).catch((e) => e);
    expect(err).toMatchObject({ kind: "transient" });
    expect(requests.length).toBeLessThanOrEqual(40);
  });
});

describe("mastodon metrics", () => {
  const status = (id: string, n: number) => ({ id, favourites_count: n, reblogs_count: 2, replies_count: 1, quotes_count: 0 });
  const items = (...ids: string[]) => ids.map((externalId) => ({ externalId, publishedAt: 0 }));

  it("declares a batch of 20 and the read scopes", () => {
    expect(mastodon.metrics).toMatchObject({ batch: 20, scopes: ["read:statuses", "read:accounts"] });
  });

  it("fetches the batch with one multi-get and maps the counts", async () => {
    const { fetch, requests } = mockFetch([[`GET ${I}/api/v1/statuses?`, () => [status("1", 5), status("2", 0)]]]);
    const res = await mastodon.postMetrics!(testContext(fetch), account(), items("1", "2", "3"));
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.getAll("id[]")).toEqual(["1", "2", "3"]);
    expect(requests[0].headers.authorization).toBe("Bearer AT");
    expect(res).toEqual({
      "1": { likes: 5, reposts: 2, replies: 1, quotes: 0 },
      "2": { likes: 0, reposts: 2, replies: 1, quotes: 0 },
      "3": null,
    });
  });

  it("falls back to one request per status on older servers, within the fetch budget", async () => {
    const { fetch, requests } = mockFetch([
      [`GET ${I}/api/v1/statuses?`, () => json({ error: "Record not found" }, 404)],
      [`GET ${I}/api/v1/statuses/1`, () => ({ id: "1", favourites_count: 3, reblogs_count: 1, replies_count: 0 })],
      [`GET ${I}/api/v1/statuses/2`, () => json({ error: "Record not found" }, 404)],
      [`GET ${I}/api/v1/statuses/`, () => status("x", 1)],
    ]);
    const res = await mastodon.postMetrics!(counted(testContext(fetch), 3), account(), items("1", "2", "3", "4"));
    expect(requests).toHaveLength(3);
    expect(res).toEqual({ "1": { likes: 3, reposts: 1, replies: 0 }, "2": null });
  });

  it("signals reconnect_required when the token lacks read scopes", async () => {
    const { fetch } = mockFetch([[/\/api\/v1\/statuses/, () => json({ error: "This action is outside the authorized scopes" }, 403)]]);
    const err = await mastodon.postMetrics!(testContext(fetch), account(), items("1")).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
  });

  it("reads account counts", async () => {
    const { fetch } = mockFetch([[`GET ${I}/api/v1/accounts/verify_credentials`, () => ({ id: "42", followers_count: 10, following_count: 4, statuses_count: 99 })]]);
    expect(await mastodon.accountMetrics!(testContext(fetch), account())).toEqual({ followers: 10, following: 4, posts: 99 });
  });
});
