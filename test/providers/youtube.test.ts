import { describe, expect, it } from "vitest";
import { youtube } from "../../worker/providers/youtube";
import { counted } from "../../worker/providers/budget";
import { MetricsUnavailableError, ProviderError } from "../../worker/providers/errors";
import { hollowMedia, image, json, lazyStream, mockFetch, testAccount, testContext, video } from "../helpers";

const app = { clientId: "CID", clientSecret: "SECRET" };
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=XYZ";
const MiB = 1024 * 1024;

const post = (over: Partial<Parameters<typeof youtube.publish>[2]> = {}) => ({
  id: "p1",
  content: "Description here",
  media: [video({ size: 5 * MiB })],
  settings: { title: "My video", privacy: "public", category: "22", tags: ["a", "b c"], notifySubscribers: false },
  ...over,
});

const sessionRoute: [string, any] = [
  "POST https://www.googleapis.com/upload/youtube/v3/videos",
  () => new Response(null, { status: 200, headers: { location: SESSION } }),
];

/** Fake resumable session: acknowledges chunks; replies 201 with the video once all bytes arrived. */
function fakeSession(total: number, opts: { keepLess?: number } = {}) {
  let received = 0;
  return (req: { headers: Record<string, string> }) => {
    const cr = req.headers["content-range"];
    const probe = cr.match(/^bytes \*\/(\d+)$/);
    if (!probe) {
      const [, start, end] = cr.match(/^bytes (\d+)-(\d+)\/\d+$/)!.map(Number);
      expect(start).toBe(received);
      received = end + 1 - (opts.keepLess ?? 0);
      opts.keepLess = 0;
    }
    if (received >= total) return json({ id: "VID123" }, 201);
    return new Response(null, { status: 308, headers: received ? { range: `bytes=0-${received - 1}` } : {} });
  };
}

describe("youtube", () => {
  it("builds the Google authorize URL", () => {
    const ctx = testContext(mockFetch([]).fetch, app, "youtube");
    const url = new URL(youtube.authorize!(ctx, { state: "S", codeVerifier: "V", codeChallenge: "CH" }) as string);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe("CID");
    expect(q.get("redirect_uri")).toBe("https://pf.example.com/oauth/youtube/callback");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge")).toBe("CH");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope")).toContain("youtube.upload");
    expect(q.get("scope")).toContain("youtube.force-ssl");
  });

  it("callback returns one account per channel", async () => {
    const m = mockFetch([
      ["POST https://oauth2.googleapis.com/token", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      [
        "GET https://www.googleapis.com/youtube/v3/channels",
        () => ({
          items: [
            { id: "UC1", snippet: { title: "Main", customUrl: "@main", country: "DE", thumbnails: { default: { url: "https://x/a.jpg" } } } },
            { id: "UC2", snippet: { title: "Brand" } },
          ],
        }),
      ],
    ]);
    const ctx = testContext(m.fetch, app, "youtube");
    const accounts = await youtube.callback!(ctx, { code: "C", codeVerifier: "V", params: new URLSearchParams() });
    expect(m.requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "C", code_verifier: "V", client_secret: "SECRET" });
    expect(m.requests[1].url).toContain("mine=true");
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({
      externalId: "UC1",
      name: "Main",
      username: "@main",
      profileUrl: "https://www.youtube.com/@main",
      credentials: { accessToken: "AT", refreshToken: "RT" },
      meta: { channelId: "UC1", country: "DE" },
    });
    expect(accounts[0].expiresAt).toBeGreaterThan(Date.now());
    expect(accounts[1].profileUrl).toBe("https://www.youtube.com/channel/UC2");
  });

  it("refresh keeps the refresh token when Google does not rotate it", async () => {
    const m = mockFetch([["POST https://oauth2.googleapis.com/token", () => ({ access_token: "AT2", expires_in: 3600 })]]);
    const update = await youtube.refresh!(testContext(m.fetch, app), testAccount());
    expect(m.requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
    expect(update.credentials).toEqual({ accessToken: "AT2" });
  });

  it("refresh with a revoked token maps to auth", async () => {
    const m = mockFetch([["POST https://oauth2.googleapis.com/token", () => json({ error: "invalid_grant" }, 400)]]);
    await expect(youtube.refresh!(testContext(m.fetch, app), testAccount())).rejects.toMatchObject({ kind: "auth" });
  });

  it("uploads a small video in one chunk and sets metadata", async () => {
    const m = mockFetch([sessionRoute, ["PUT " + SESSION, fakeSession(5 * MiB)]]);
    const res = await youtube.publish(testContext(m.fetch, app), testAccount(), post());
    expect(res).toEqual({ status: "published", externalId: "VID123", url: "https://www.youtube.com/watch?v=VID123" });
    const init = m.requests[0];
    expect(init.url).toContain("uploadType=resumable");
    expect(init.url).toContain("notifySubscribers=false");
    expect(init.headers["x-upload-content-length"]).toBe(String(5 * MiB));
    expect(init.headers.authorization).toBe("Bearer AT");
    expect(init.json).toMatchObject({
      snippet: { title: "My video", description: "Description here", tags: ["a", "b c"], categoryId: "22" },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    });
    const put = m.requests[1];
    expect(put.headers["content-range"]).toBe(`bytes 0-${5 * MiB - 1}/${5 * MiB}`);
  });

  it("streams 32MiB chunks from R2 following the server's Range offsets", async () => {
    const total = 70 * MiB + 123;
    // The server keeps 1 byte less of the first chunk: the next chunk must restart from its reported offset.
    const m = mockFetch([sessionRoute, ["PUT " + SESSION, fakeSession(total, { keepLess: 1 })]]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    const ranges: Array<[number, number]> = [];
    ctx.media.rangeStream = async (_item, offset, length) => (ranges.push([offset, length]), lazyStream(1));
    ctx.media.range = async () => {
      throw new Error("must not copy video bytes into memory");
    };
    const res = await youtube.publish(ctx, testAccount(), post({ media: [video({ size: total })] }));
    expect(res).toMatchObject({ status: "published", externalId: "VID123" });
    const puts = m.requests.filter((r) => r.method === "PUT").map((r) => r.headers["content-range"]);
    expect(puts).toEqual([
      `bytes 0-${32 * MiB - 1}/${total}`,
      `bytes ${32 * MiB - 1}-${64 * MiB - 2}/${total}`,
      `bytes ${64 * MiB - 1}-${total - 1}/${total}`,
    ]);
    expect(ranges).toEqual([
      [0, 32 * MiB],
      [32 * MiB - 1, 32 * MiB],
      [64 * MiB - 1, total - (64 * MiB - 1)],
    ]);
    // Non-final chunks are multiples of 256KiB (and of Google's recommended 8MiB).
    expect((32 * MiB) % (8 * MiB)).toBe(0);
  });

  it("uploads a 2GB+ video within the per-call subrequest budget and resumes without a new session", async () => {
    const total = 2048 * MiB + 5 * MiB;
    const m = mockFetch([sessionRoute, ["PUT " + SESSION, fakeSession(total)]]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    let res = await youtube.publish(ctx, testAccount(), post({ media: [video({ size: total })] }));
    expect(res.status).toBe("pending");
    const calls = [m.requests.length];
    expect(calls[0]).toBe(25); // session + 24 PUTs of 32MiB
    expect((res as any).state.uploadUrl).toBe(SESSION);
    let seen = m.requests.length;
    while (res.status === "pending") {
      res = await youtube.checkStatus!(ctx, testAccount(), JSON.parse(JSON.stringify((res as any).state)));
      const call = m.requests.slice(seen);
      // Every resumed call first asks the session where it stands.
      expect(call[0].headers["content-range"]).toBe(`bytes */${total}`);
      calls.push(call.length);
      seen = m.requests.length;
    }
    expect(res).toMatchObject({ status: "published", externalId: "VID123" });
    // 65 chunks: 24 + 24 + 17 PUTs over three calls, each well under the subrequest budget.
    expect(calls).toEqual([25, 25, 18]);
    expect(Math.max(...calls)).toBeLessThanOrEqual(40);
    const puts = m.requests.filter((r) => r.method === "PUT" && !r.headers["content-range"].startsWith("bytes */"));
    expect(puts.at(-1)!.headers["content-range"]).toBe(`bytes ${2048 * MiB}-${total - 1}/${total}`);
    // Only one session was ever created.
    expect(m.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("checkStatus returns the video when the session already completed", async () => {
    const m = mockFetch([["PUT " + SESSION, () => json({ id: "VIDDONE" }, 200)]]);
    const res = await youtube.checkStatus!(testContext(m.fetch, app), testAccount(), {
      uploadUrl: SESSION,
      video: video(),
      thumbnail: null,
      playlistId: null,
    });
    expect(res).toMatchObject({ status: "published", externalId: "VIDDONE" });
    expect(m.requests).toHaveLength(1);
  });

  it("returns pending (not an error) when a chunk hits a 5xx", async () => {
    const m = mockFetch([sessionRoute, ["PUT " + SESSION, () => json({ error: { message: "backend" } }, 503)]]);
    const res = await youtube.publish(testContext(m.fetch, app), testAccount(), post());
    expect(res.status).toBe("pending");
  });

  it("sets the attached image as thumbnail, adds to playlist and forces private with publishAt", async () => {
    const m = mockFetch([
      sessionRoute,
      ["PUT " + SESSION, fakeSession(5 * MiB)],
      ["POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set", () => ({ items: [] })],
      ["POST https://www.googleapis.com/youtube/v3/playlistItems", () => ({ id: "PI" })],
    ]);
    const res = await youtube.publish(
      testContext(m.fetch, app),
      testAccount(),
      post({
        media: [video({ size: 5 * MiB }), image({ mime: "image/png", size: 3_000_000 })],
        settings: { title: "T", privacy: "public", playlist: "PL1", publishAt: "2030-01-01T10:00:00.000Z", shorts: true },
      }),
    );
    expect(res.status).toBe("published");
    expect(m.requests[0].json.status).toMatchObject({ privacyStatus: "private", publishAt: "2030-01-01T10:00:00.000Z" });
    expect(m.requests[0].json.snippet.title).toBe("T #Shorts");
    const thumb = m.requests.find((r) => r.url.includes("thumbnails/set"))!;
    expect(thumb.url).toContain("videoId=VID123");
    expect(thumb.headers["content-type"]).toBe("image/jpeg"); // re-encoded: >2MB PNG
    const pl = m.requests.find((r) => r.url.includes("playlistItems"))!;
    expect(pl.json).toEqual({ snippet: { playlistId: "PL1", resourceId: { kind: "youtube#video", videoId: "VID123" } } });
  });

  it("a failed thumbnail only warns", async () => {
    const m = mockFetch([
      sessionRoute,
      ["PUT " + SESSION, fakeSession(5 * MiB)],
      ["POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set", () => json({ error: { message: "nope" } }, 403)],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await youtube.publish(ctx, testAccount(), post({ media: [video({ size: 5 * MiB }), image()] }));
    expect(res.status).toBe("published");
    expect(ctx.logs.some((l) => l.startsWith("warn") && l.includes("thumbnail"))).toBe(true);
  });

  it("posts the first comment on the root video", async () => {
    const m = mockFetch([["POST https://www.googleapis.com/youtube/v3/commentThreads", () => ({ id: "CMT1" })]]);
    const r = await youtube.reply!(testContext(m.fetch, app), testAccount(), { rootId: "VID123", parentId: "VID123" }, {
      id: "p1-r1",
      content: "First!",
      media: [],
      settings: {},
    });
    expect(r).toEqual({ externalId: "CMT1", url: "https://www.youtube.com/watch?v=VID123&lc=CMT1" });
    expect(m.requests[0].json).toEqual({ snippet: { videoId: "VID123", topLevelComment: { snippet: { textOriginal: "First!" } } } });
  });

  it("loads categories and playlists", async () => {
    const m = mockFetch([
      [
        "GET https://www.googleapis.com/youtube/v3/videoCategories",
        () => ({ items: [{ id: "22", snippet: { title: "People & Blogs", assignable: true } }, { id: "18", snippet: { title: "Short Movies", assignable: false } }] }),
      ],
      [/playlists\?.*pageToken=N2/, () => ({ items: [{ id: "PL2", snippet: { title: "Two" } }] })],
      ["GET https://www.googleapis.com/youtube/v3/playlists", () => ({ items: [{ id: "PL1", snippet: { title: "One" } }], nextPageToken: "N2" })],
    ]);
    const ctx = testContext(m.fetch, app);
    const acc = testAccount({ meta: { country: "DE" } });
    expect(await youtube.options!(ctx, acc, "category", {})).toEqual([{ value: "22", label: "People & Blogs" }]);
    expect(m.requests[0].url).toContain("regionCode=DE");
    expect(await youtube.options!(ctx, acc, "playlist", {})).toEqual([
      { value: "", label: "None" },
      { value: "PL1", label: "One" },
      { value: "PL2", label: "Two" },
    ]);
  });

  it("maps 401 to auth and quota errors to readable invalid errors", async () => {
    const m401 = mockFetch([["POST https://www.googleapis.com/upload/youtube/v3/videos", () => json({ error: { message: "Invalid Credentials" } }, 401)]]);
    await expect(youtube.publish(testContext(m401.fetch, app), testAccount(), post())).rejects.toMatchObject({ kind: "auth" });

    const mq = mockFetch([
      [
        "POST https://www.googleapis.com/upload/youtube/v3/videos",
        () => json({ error: { code: 403, message: "quota", errors: [{ reason: "uploadLimitExceeded" }] } }, 403),
      ],
    ]);
    const err = await youtube.publish(testContext(mq.fetch, app), testAccount(), post()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("invalid");
    expect(err.message).toContain("daily YouTube upload limit");
  });

  it("validates media and description", () => {
    expect(youtube.validate!(post({ media: [image()] }))).toContain("YouTube: attach exactly one video");
    expect(youtube.validate!(post({ content: "a <b>" }))).toContain("YouTube: the description cannot contain < or >");
    expect(youtube.validate!(post())).toEqual([]);
  });
});

describe("youtube metrics", () => {
  const API = "https://www.googleapis.com/youtube/v3";
  const acc = () => testAccount({ externalId: "UC1", meta: { channelId: "UC1" } });
  // Fresh posts by default: YouTube Analytics is only asked for snapshots ≥ 24h after publishing.
  const item = (externalId: string, publishedAt = Date.now() - 60 * 60 * 1000) => ({ externalId, publishedAt });

  it("requests youtube.readonly + yt-analytics.readonly and describes the metrics", () => {
    const url = new URL(youtube.authorize!(testContext(mockFetch([]).fetch, app, "youtube"), { state: "S", codeVerifier: "V", codeChallenge: "C" }) as string);
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/youtube.readonly");
    expect(scopes).toContain("https://www.googleapis.com/auth/yt-analytics.readonly");
    for (const s of youtube.metrics!.scopes!) expect(scopes).toContain(s);
    expect(youtube.metrics).toMatchObject({
      batch: 50,
      post: ["views", "likes", "comments", "shares", "watchTimeMinutes", "avgViewDurationSeconds", "avgViewPercentage"],
      account: ["followers", "posts"],
    });
  });

  it("fetches a batch in one videos.list call; missing videos are null", async () => {
    const m = mockFetch([
      [
        `GET ${API}/videos`,
        () => ({
          items: [
            { id: "A", statistics: { viewCount: "100", likeCount: "7", commentCount: "2", favoriteCount: "0" } },
            // likes hidden by the owner: likeCount absent
            { id: "B", statistics: { viewCount: "5", commentCount: "0", favoriteCount: "0" } },
          ],
        }),
      ],
    ]);
    const ids = Array.from({ length: 50 }, (_, i) => (i === 0 ? "A" : i === 1 ? "B" : `X${i}`));
    const res = await youtube.postMetrics!(testContext(m.fetch, app), acc(), ids.map((id) => item(id)));
    expect(m.requests).toHaveLength(1);
    const q = new URL(m.requests[0].url).searchParams;
    expect(q.get("part")).toBe("statistics");
    expect(q.get("id")).toBe(ids.join(","));
    expect(m.requests[0].headers.authorization).toBe("Bearer AT");
    expect(res.A).toEqual({ views: 100, likes: 7, comments: 2, extra: { favorites: 0 } });
    expect(res.B).toEqual({ views: 5, comments: 0, extra: { favorites: 0 } });
    expect(res.X2).toBeNull();
    expect(Object.keys(res)).toHaveLength(50);
  });

  it("a 403 scope error means reconnect for analytics, not auth", async () => {
    const m = mockFetch([
      [
        `GET ${API}/videos`,
        () => json({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403),
      ],
      [`GET ${API}/channels`, () => json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403)],
    ]);
    const err = await youtube.postMetrics!(testContext(m.fetch, app), acc(), [item("A")]).catch((e) => e);
    expect(err).toBeInstanceOf(MetricsUnavailableError);
    expect(err.reason).toBe("reconnect_required");
    await expect(youtube.accountMetrics!(testContext(m.fetch, app), acc())).rejects.toMatchObject({ reason: "reconnect_required" });
  });

  it("quota errors stay ProviderErrors", async () => {
    const m = mockFetch([[`GET ${API}/videos`, () => json({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, 403)]]);
    const err = await youtube.postMetrics!(testContext(m.fetch, app), acc(), [item("A")]).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/quota/);
  });

  it("account metrics from channels.list; hidden subscriber counts are left out", async () => {
    const m = mockFetch([
      [`GET ${API}/channels`, () => ({ items: [{ id: "UC1", statistics: { viewCount: "9000", subscriberCount: "120", hiddenSubscriberCount: false, videoCount: "33" } }] })],
    ]);
    expect(await youtube.accountMetrics!(testContext(m.fetch, app), acc())).toEqual({ followers: 120, posts: 33, extra: { channel_views: 9000 } });
    const q = new URL(m.requests[0].url).searchParams;
    expect(q.get("id")).toBe("UC1");
    expect(q.get("part")).toBe("statistics");

    const hidden = mockFetch([[`GET ${API}/channels`, () => ({ items: [{ id: "UC1", statistics: { viewCount: "1", subscriberCount: "0", hiddenSubscriberCount: true, videoCount: "2" } }] })]]);
    expect(await youtube.accountMetrics!(testContext(hidden.fetch, app), acc())).toEqual({ posts: 2, extra: { channel_views: 1 } });
  });
});

describe("youtube extras (languages, captions, playlists, translations)", () => {
  const API = "https://www.googleapis.com/youtube/v3";
  const CAPTIONS = "https://www.googleapis.com/upload/youtube/v3/captions";
  const SRT = "1\n00:00:00,000 --> 00:00:02,500\nHello!\n\n2\n00:00:02,500 --> 00:00:04,000\nBye\n";
  const VTT = "WEBVTT\n\n00:00.000 --> 00:02.500\nHello!\n";
  /** A fresh fake session per call (it keeps the received byte count). */
  const upload = (): Array<[string, any]> => [sessionRoute, ["PUT " + SESSION, fakeSession(5 * MiB)]];

  it("describes the thumbnail everywhere an agent looks", () => {
    expect(youtube.capabilities.mediaNote).toMatch(/custom thumbnail/);
    expect(youtube.capabilities.mediaNote).toMatch(/verified channel/);
    expect(youtube.setupNotes).toMatch(/custom thumbnail/);
    expect(youtube.setupNotes).toMatch(/YouTube Analytics API/);
  });

  it("sets the video and audio language; `language` alone sets both", async () => {
    const both = mockFetch(upload());
    await youtube.publish(testContext(both.fetch, app), testAccount(), post({ settings: { title: "T", language: "en", audioLanguage: "tr" } }));
    expect(both.requests[0].json.snippet).toMatchObject({ defaultLanguage: "en", defaultAudioLanguage: "tr" });

    const legacy = mockFetch(upload());
    await youtube.publish(testContext(legacy.fetch, app), testAccount(), post({ settings: { title: "T", language: "de" } }));
    expect(legacy.requests[0].json.snippet).toMatchObject({ defaultLanguage: "de", defaultAudioLanguage: "de" });

    const audioOnly = mockFetch(upload());
    await youtube.publish(testContext(audioOnly.fetch, app), testAccount(), post({ settings: { title: "T", audioLanguage: "ja" } }));
    expect(audioOnly.requests[0].json.snippet.defaultLanguage).toBeUndefined();
    expect(audioOnly.requests[0].json.snippet.defaultAudioLanguage).toBe("ja");
  });

  it("sends translations with part=localizations", async () => {
    const m = mockFetch(upload());
    await youtube.publish(
      testContext(m.fetch, app),
      testAccount(),
      post({ settings: { title: "T", language: "en", localizations: "# comment\nde | Mein Video | Zeile 1\\nZeile 2\nes | Mi video\n" } }),
    );
    expect(new URL(m.requests[0].url).searchParams.get("part")).toBe("snippet,status,localizations");
    expect(m.requests[0].json.localizations).toEqual({ de: { title: "Mein Video", description: "Zeile 1\nZeile 2" }, es: { title: "Mi video" } });
    // Without translations the part stays as before.
    const plain = mockFetch(upload());
    await youtube.publish(testContext(plain.fetch, app), testAccount(), post());
    expect(new URL(plain.requests[0].url).searchParams.get("part")).toBe("snippet,status");
    expect(plain.requests[0].json.localizations).toBeUndefined();
  });

  it("validates languages, translations and captions", () => {
    const v = (settings: Record<string, unknown>) => youtube.validate!(post({ settings: { title: "T", ...settings } }));
    expect(v({ language: "en", audioLanguage: "pt-BR", captions: SRT })).toEqual([]);
    expect(v({ captions: VTT, captionsLanguage: "en" })).toEqual([]);
    expect(v({ language: "english!" })).toContain('YouTube: "english!" is not a language code (e.g. en, pt-BR)');
    expect(v({ localizations: "de | Titel" })).toContain("YouTube: translations need the video language (the language of the main title and description)");
    expect(v({ language: "en", localizations: "de" }).join()).toMatch(/line 1: a title is required/);
    expect(v({ language: "en", localizations: "de | A\nde | B" }).join()).toMatch(/line 2: de appears twice/);
    expect(v({ language: "en", captions: "just some text" }).join()).toMatch(/SubRip/);
    expect(v({ captions: SRT }).join()).toMatch(/captions language/);
  });

  it("inserts captions as a multipart upload after the video", async () => {
    const m = mockFetch([...upload(), ["POST " + CAPTIONS, () => ({ id: "CAP1" })]]);
    const ctx = testContext(m.fetch, app);
    const res = await youtube.publish(ctx, testAccount(), post({ settings: { title: "T", language: "en", audioLanguage: "tr", captions: "﻿" + SRT, captionsName: "Türkçe" } }));
    expect(res.status).toBe("published");
    const cap = m.requests.find((r) => r.url.startsWith(CAPTIONS))!;
    const q = new URL(cap.url).searchParams;
    expect(q.get("uploadType")).toBe("multipart");
    expect(q.get("part")).toBe("snippet");
    expect(cap.headers.authorization).toBe("Bearer AT");
    const boundary = cap.headers["content-type"].match(/^multipart\/related; boundary=(\S+)$/)![1];
    const parts = cap.body!.split(`--${boundary}`);
    expect(parts.at(-1)).toBe("--\r\n");
    const [metaHead, metaBody] = parts[1].split("\r\n\r\n");
    expect(metaHead).toContain("application/json");
    // Captions language defaults to the audio language.
    expect(JSON.parse(metaBody)).toEqual({ snippet: { videoId: "VID123", language: "tr", name: "Türkçe", isDraft: false } });
    const [mediaHead, ...mediaBody] = parts[2].split("\r\n\r\n");
    expect(mediaHead).toContain("application/octet-stream");
    expect(mediaBody.join("\r\n\r\n")).toBe(SRT + "\r\n");
  });

  it("a failed captions insert only warns", async () => {
    const m = mockFetch([...upload(), ["POST " + CAPTIONS, () => json({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, 403)]]);
    const ctx = testContext(m.fetch, app);
    const res = await youtube.publish(ctx, testAccount(), post({ settings: { title: "T", captions: VTT, captionsLanguage: "en" } }));
    expect(res).toMatchObject({ status: "published", externalId: "VID123" });
    expect(ctx.logs.some((l) => l.startsWith("warn") && l.includes("captions (en) failed"))).toBe(true);
    // Default track name.
    expect(m.requests.find((r) => r.url.startsWith(CAPTIONS))!.body).toContain('"name":"Subtitles"');
  });

  it("still sets the thumbnail next to captions and playlists, and keeps the extras in a pending state", async () => {
    const total = 2048 * MiB + 5 * MiB;
    const m = mockFetch([
      sessionRoute,
      ["PUT " + SESSION, fakeSession(total)],
      ["POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set", () => ({ items: [] })],
      ["POST " + CAPTIONS, () => ({ id: "CAP1" })],
      [`GET ${API}/playlists`, () => ({ items: [] })],
      [`POST ${API}/playlists`, () => ({ id: "PLNEW" })],
      [`POST ${API}/playlistItems`, () => ({ id: "PI" })],
    ]);
    const ctx = hollowMedia(testContext(m.fetch, app));
    const first = await youtube.publish(
      ctx,
      testAccount(),
      post({
        media: [video({ size: total }), image({ mime: "image/jpeg", size: 200_000 })],
        settings: { title: "T", privacy: "unlisted", captions: SRT, language: "en", newPlaylist: "Devlog" },
      }),
    );
    expect(first.status).toBe("pending");
    const state = JSON.parse(JSON.stringify((first as any).state));
    expect(state.captions).toEqual({ text: SRT, language: "en", name: "Subtitles" });
    expect(state.newPlaylist).toEqual({ title: "Devlog", privacy: "unlisted" });
    let before = m.requests.length;
    let done = await youtube.checkStatus!(ctx, testAccount(), state);
    while (done.status === "pending") {
      expect(m.requests.length - before).toBeLessThanOrEqual(40);
      before = m.requests.length;
      done = await youtube.checkStatus!(ctx, testAccount(), JSON.parse(JSON.stringify((done as any).state)));
    }
    expect(done).toMatchObject({ status: "published", externalId: "VID123" });
    // The last call: the remaining chunks plus every extra, still inside the budget.
    const after = m.requests.slice(before);
    expect(after.length).toBeLessThanOrEqual(40);
    const thumb = after.find((r) => r.url.includes("thumbnails/set"))!;
    expect(thumb.url).toContain("videoId=VID123");
    expect(thumb.headers["content-type"]).toBe("image/jpeg");
    expect(after.some((r) => r.url.startsWith(CAPTIONS))).toBe(true);
    expect(after.find((r) => r.method === "POST" && r.url.startsWith(`${API}/playlists`))!.json).toEqual({
      snippet: { title: "Devlog" },
      status: { privacyStatus: "unlisted" },
    });
    expect(after.find((r) => r.url.includes("playlistItems"))!.json.snippet.playlistId).toBe("PLNEW");
  });

  it("creates a new playlist (scheduled videos default to public) and adds the video to it and the selected one", async () => {
    const m = mockFetch([
      ...upload(),
      [`GET ${API}/playlists`, () => ({ items: [{ id: "PL1", snippet: { title: "Other" } }] })],
      [`POST ${API}/playlists`, () => ({ id: "PLNEW" })],
      [`POST ${API}/playlistItems`, () => ({ id: "PI" })],
    ]);
    const ctx = testContext(m.fetch, app);
    await youtube.publish(ctx, testAccount(), post({ settings: { title: "T", playlist: "PL1", newPlaylist: " Season 2 ", publishAt: "2030-01-01T10:00:00.000Z" } }));
    const create = m.requests.find((r) => r.method === "POST" && r.url.startsWith(`${API}/playlists`))!;
    expect(new URL(create.url).searchParams.get("part")).toBe("snippet,status");
    expect(create.json).toEqual({ snippet: { title: "Season 2" }, status: { privacyStatus: "public" } });
    const items = m.requests.filter((r) => r.url.includes("playlistItems")).map((r) => r.json.snippet.playlistId);
    expect(items).toEqual(["PL1", "PLNEW"]);
  });

  it("reuses a playlist with the same title (case-insensitive) and pages at most 3 times", async () => {
    const reuse = mockFetch([
      ...upload(),
      [/playlists\?.*pageToken=P2/, () => ({ items: [{ id: "PLSEASON", snippet: { title: "season 2" } }], nextPageToken: "P3" })],
      [`GET ${API}/playlists`, () => ({ items: [{ id: "PL1", snippet: { title: "Other" } }], nextPageToken: "P2" })],
      [`POST ${API}/playlistItems`, () => ({ id: "PI" })],
    ]);
    await youtube.publish(testContext(reuse.fetch, app), testAccount(), post({ settings: { title: "T", playlist: "PLSEASON", newPlaylist: "Season 2", newPlaylistPrivacy: "private" } }));
    expect(reuse.requests.some((r) => r.method === "POST" && r.url.startsWith(`${API}/playlists`))).toBe(false);
    // Same playlist selected and found by title: added once.
    expect(reuse.requests.filter((r) => r.url.includes("playlistItems")).map((r) => r.json.snippet.playlistId)).toEqual(["PLSEASON"]);

    let pages = 0;
    const many = mockFetch([
      ...upload(),
      [`GET ${API}/playlists`, () => ({ items: [{ id: `PL${++pages}`, snippet: { title: "x" } }], nextPageToken: `N${pages}` })],
      [`POST ${API}/playlists`, () => ({ id: "PLNEW" })],
      [`POST ${API}/playlistItems`, () => ({ id: "PI" })],
    ]);
    await youtube.publish(testContext(many.fetch, app), testAccount(), post({ settings: { title: "T", newPlaylist: "New", newPlaylistPrivacy: "private" } }));
    expect(pages).toBe(3);
    expect(many.requests.find((r) => r.method === "POST" && r.url.startsWith(`${API}/playlists`))!.json.status).toEqual({ privacyStatus: "private" });
  });

  it("a failed playlist creation only warns", async () => {
    const m = mockFetch([
      ...upload(),
      [`GET ${API}/playlists`, () => ({ items: [] })],
      [`POST ${API}/playlists`, () => json({ error: { code: 400, errors: [{ reason: "maxPlaylistExceeded" }] } }, 400)],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await youtube.publish(ctx, testAccount(), post({ settings: { title: "T", newPlaylist: "X" } }));
    expect(res.status).toBe("published");
    expect(ctx.logs.some((l) => l.startsWith("warn") && l.includes('creating the playlist "X" failed'))).toBe(true);
    expect(m.requests.some((r) => r.url.includes("playlistItems"))).toBe(false);
  });

  it("resumes states saved by older releases (no captions / newPlaylist keys)", async () => {
    const m = mockFetch([["PUT " + SESSION, () => json({ id: "VIDOLD" }, 200)]]);
    const res = await youtube.checkStatus!(testContext(m.fetch, app), testAccount(), { uploadUrl: SESSION, video: video(), thumbnail: null, playlistId: null });
    expect(res).toMatchObject({ status: "published", externalId: "VIDOLD" });
    expect(m.requests).toHaveLength(1);
  });
});

describe("youtube analytics (YouTube Analytics API)", () => {
  const API = "https://www.googleapis.com/youtube/v3";
  const REPORTS = "https://youtubeanalytics.googleapis.com/v2/reports";
  const DAY = 24 * 60 * 60 * 1000;
  const acc = () => testAccount({ externalId: "UC1", meta: { channelId: "UC1" } });
  const stats = (ids: string[]) => () => ({ items: ids.map((id) => ({ id, statistics: { viewCount: "100", likeCount: "5", commentCount: "1" } })) });
  const table = (headers: string[], rows: unknown[][]) => ({ kind: "youtubeAnalytics#resultTable", columnHeaders: headers.map((name) => ({ name })), rows });
  const curve = Array.from({ length: 100 }, (_, i) => [(i + 1) / 100, Math.round((1 - i / 200) * 10000) / 10000]);
  /** Routes the reports by their metrics/dimensions. */
  const reports = (opts: { basic?: unknown; traffic?: unknown; retention?: unknown } = {}) =>
    [
      REPORTS,
      (req: { url: string }) => {
        const q = new URL(req.url).searchParams;
        if (q.get("dimensions")?.includes("elapsedVideoTimeRatio")) return opts.retention ?? table(["elapsedVideoTimeRatio", "audienceWatchRatio"], curve);
        if (q.get("dimensions")?.includes("insightTrafficSourceType")) return opts.traffic ?? table(["insightTrafficSourceType", "views"], []);
        return opts.basic ?? table([], []);
      },
    ] as [string, any];

  it("skips YouTube Analytics for snapshots younger than 24h", async () => {
    const m = mockFetch([[`GET ${API}/videos`, stats(["A"])], reports()]);
    const res = await youtube.postMetrics!(testContext(m.fetch, app), acc(), [{ externalId: "A", publishedAt: Date.now() - 3 * 60 * 60 * 1000 }]);
    expect(m.requests).toHaveLength(1);
    expect(res.A).toEqual({ views: 100, likes: 5, comments: 1 });
  });

  it("batches the watch-time report for the 24h+ videos of the call", async () => {
    const now = Date.now();
    const m = mockFetch([
      [`GET ${API}/videos`, stats(["A", "B", "C"])],
      reports({
        basic: table(
          ["video", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "shares", "subscribersGained"],
          [
            ["A", 420.4, 73.26, 41.234, 3, 2],
            ["B", 10, 12, 8.5, 0, 0],
          ],
        ),
      }),
    ]);
    const items = [
      { externalId: "A", publishedAt: now - 3 * DAY },
      { externalId: "B", publishedAt: now - 2 * DAY },
      { externalId: "C", publishedAt: now - 2 * 60 * 60 * 1000 }, // too fresh
      { externalId: "GONE", publishedAt: now - 3 * DAY }, // deleted: not asked
    ];
    const res = await youtube.postMetrics!(testContext(m.fetch, app), acc(), items);
    expect(m.requests).toHaveLength(2);
    const r = m.requests[1];
    expect(r.headers.authorization).toBe("Bearer AT");
    const q = new URL(r.url).searchParams;
    expect(q.get("ids")).toBe("channel==UC1");
    expect(q.get("filters")).toBe("video==A,B");
    expect(q.get("dimensions")).toBe("video");
    expect(q.get("metrics")).toBe("estimatedMinutesWatched,averageViewDuration,averageViewPercentage,shares,subscribersGained");
    expect(q.get("startDate")).toBe(new Date(now - 4 * DAY).toISOString().slice(0, 10));
    expect(q.get("endDate")).toBe(new Date(now).toISOString().slice(0, 10));
    expect(res.A).toEqual({
      views: 100,
      likes: 5,
      comments: 1,
      shares: 3,
      watchTimeMinutes: 420,
      avgViewDurationSeconds: 73.3,
      avgViewPercentage: 41.23,
      extra: { subscribers_gained: 2 },
    });
    expect(res.B).toMatchObject({ watchTimeMinutes: 10, avgViewPercentage: 8.5, shares: 0 });
    expect(res.C).toEqual({ views: 100, likes: 5, comments: 1 });
    expect(res.GONE).toBeNull();
  });

  it("one video: no video dimension; missing rows (data lag) leave the keys out", async () => {
    const m = mockFetch([[`GET ${API}/videos`, stats(["A"])], [REPORTS, () => ({ kind: "youtubeAnalytics#resultTable", columnHeaders: [{ name: "estimatedMinutesWatched" }] })]]);
    const res = await youtube.postMetrics!(testContext(m.fetch, app), acc(), [{ externalId: "A", publishedAt: Date.now() - 2 * DAY }]);
    const q = new URL(m.requests[1].url).searchParams;
    expect(q.get("filters")).toBe("video==A");
    expect(q.get("dimensions")).toBeNull();
    expect(res.A).toEqual({ views: 100, likes: 5, comments: 1 });
  });

  it("adds the retention curve and traffic sources for 7d-37d snapshots", async () => {
    const now = Date.now();
    const m = mockFetch([
      [`GET ${API}/videos`, stats(["A", "B", "OLD"])],
      reports({
        basic: table(["video", "estimatedMinutesWatched"], [["A", 5], ["B", 6], ["OLD", 7]]),
        traffic: table(
          ["video", "insightTrafficSourceType", "views"],
          [
            ["A", "YT_SEARCH", 10],
            ["A", "RELATED_VIDEO", 40],
            ["A", "EXT_URL", 0],
            ["B", "SHORTS", 9],
          ],
        ),
      }),
    ]);
    const res = await youtube.postMetrics!(testContext(m.fetch, app), acc(), [
      { externalId: "A", publishedAt: now - 7 * DAY - 60_000 },
      { externalId: "B", publishedAt: now - 30 * DAY },
      { externalId: "OLD", publishedAt: now - 44 * DAY },
    ]);
    // videos.list + basic report + one traffic report for A,B + one retention request per video (A, B)
    expect(m.requests).toHaveLength(5);
    const traffic = new URL(m.requests[2].url).searchParams;
    expect(traffic.get("dimensions")).toBe("video,insightTrafficSourceType");
    expect(traffic.get("filters")).toBe("video==A,B");
    expect(traffic.get("metrics")).toBe("views");
    const retention = m.requests.slice(3).map((r) => new URL(r.url).searchParams);
    expect(retention.map((q) => q.get("filters"))).toEqual(["video==A", "video==B"]);
    expect(retention[0].get("dimensions")).toBe("elapsedVideoTimeRatio");
    expect(retention[0].get("metrics")).toBe("audienceWatchRatio");
    expect(res.A!.details).toEqual({
      trafficSources: [
        { source: "RELATED_VIDEO", views: 40 },
        { source: "YT_SEARCH", views: 10 },
      ],
      retention: curve,
    });
    expect(res.A!.details!.retention).toHaveLength(100);
    expect(res.B!.details!.trafficSources).toEqual([{ source: "SHORTS", views: 9 }]);
    expect(res.OLD).toEqual({ views: 100, likes: 5, comments: 1, watchTimeMinutes: 7 });
  });

  it("stays within the fetch budget: retention requests stop when the counted context runs out", async () => {
    const now = Date.now();
    const ids = Array.from({ length: 12 }, (_, i) => `V${i}`);
    const m = mockFetch([[`GET ${API}/videos`, stats(ids)], reports()]);
    const items = ids.map((id) => ({ externalId: id, publishedAt: now - 8 * DAY }));
    const full = await youtube.postMetrics!(testContext(m.fetch, app), acc(), items);
    // 1 + basic + traffic + at most MAX_RETENTION (10) curves
    expect(m.requests).toHaveLength(13);
    expect(Object.values(full).filter((v) => v?.details?.retention).length).toBe(10);

    const tight = mockFetch([[`GET ${API}/videos`, stats(ids)], reports()]);
    const res = await youtube.postMetrics!(counted(testContext(tight.fetch, app), 5), acc(), items);
    expect(tight.requests).toHaveLength(5);
    expect(Object.keys(res)).toHaveLength(12);
    expect(Object.values(res).filter((v) => v?.details?.retention).length).toBe(2);
  });

  it("an account without yt-analytics.readonly keeps its Data API numbers and is told to reconnect", async () => {
    const m = mockFetch([
      [`GET ${API}/videos`, stats(["A"])],
      [REPORTS, () => json({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403)],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await youtube.postMetrics!(ctx, acc(), [{ externalId: "A", publishedAt: Date.now() - 2 * DAY }]);
    expect(res.A).toEqual({ views: 100, likes: 5, comments: 1 });
    expect(ctx.logs.some((l) => l.startsWith("warn") && l.includes("yt-analytics.readonly") && l.includes("reconnect"))).toBe(true);
  });

  it("other Analytics failures (API not enabled, outage) keep the Data API numbers", async () => {
    const m = mockFetch([
      [`GET ${API}/videos`, stats(["A"])],
      [
        REPORTS,
        () =>
          json({ error: { code: 403, message: "YouTube Analytics API has not been used in project 1", status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }], details: [{ reason: "SERVICE_DISABLED" }] } }, 403),
      ],
    ]);
    const ctx = testContext(m.fetch, app);
    const res = await youtube.postMetrics!(ctx, acc(), [{ externalId: "A", publishedAt: Date.now() - 8 * DAY }]);
    expect(res.A).toEqual({ views: 100, likes: 5, comments: 1 });
    expect(m.requests).toHaveLength(2); // stopped after the first failed report
    expect(ctx.logs.some((l) => l.startsWith("warn") && l.includes("YouTube Analytics unavailable"))).toBe(true);

    const down = mockFetch([[`GET ${API}/videos`, stats(["A"])], [REPORTS, () => json({ error: { code: 503, message: "backend" } }, 503)]]);
    const res2 = await youtube.postMetrics!(testContext(down.fetch, app), acc(), [{ externalId: "A", publishedAt: Date.now() - 2 * DAY }]);
    expect(res2.A).toEqual({ views: 100, likes: 5, comments: 1 });
  });
});
