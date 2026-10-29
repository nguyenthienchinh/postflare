import { describe, expect, it } from "vitest";
import { discord } from "../../worker/providers/discord";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const API = "https://discord.com/api/v10";
const app = { clientId: "CID", clientSecret: "SEC", botToken: "BOT" };
const account = () => testAccount({ provider: "discord", externalId: "G1", credentials: {}, meta: { guildId: "G1" } });
const post = (over: Record<string, any> = {}) => ({ id: "p1", content: "Hello", media: [], settings: { channel: "C1", postType: "message" }, ...over });

describe("discord oauth", () => {
  it("builds the bot install URL", async () => {
    const url = new URL(await discord.authorize!(testContext(mockFetch([]).fetch, app, "discord"), { state: "S", codeVerifier: "v", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "CID",
      scope: "bot guilds",
      response_type: "code",
      redirect_uri: "https://pf.example.com/oauth/discord/callback",
      state: "S",
      integration_type: "0",
    });
    expect(BigInt(url.searchParams.get("permissions")!) & (1n << 15n)).toBeTruthy();
  });

  it("exchanges the code and returns the guild", async () => {
    const m = mockFetch([
      [`POST ${API}/oauth2/token`, () => ({ access_token: "AT", guild: { id: "G1", name: "Guild" } })],
      [`GET ${API}/guilds/G1`, () => ({ id: "G1", name: "My Guild", icon: "abc" })],
    ]);
    const accounts = await discord.callback!(testContext(m.fetch, app, "discord"), { code: "CODE", codeVerifier: "", params: new URLSearchParams() });
    expect(m.requests[0].headers.authorization).toBe(`Basic ${btoa("CID:SEC")}`);
    expect(m.requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "CODE" });
    expect(m.requests[1].headers.authorization).toBe("Bot BOT");
    expect(accounts).toEqual([
      expect.objectContaining({ externalId: "G1", name: "My Guild", avatarUrl: "https://cdn.discordapp.com/icons/G1/abc.png" }),
    ]);
  });

  it("requires app configuration", () => {
    expect(() => discord.authorize!(testContext(mockFetch([]).fetch, {}), { state: "", codeVerifier: "", codeChallenge: "" })).toThrow(/not configured/);
  });
});

describe("discord options", () => {
  it("lists channels by post type", async () => {
    const m = mockFetch([
      [
        `GET ${API}/guilds/G1/channels`,
        () => [
          { id: "1", name: "general", type: 0, position: 2 },
          { id: "2", name: "news", type: 5, position: 1 },
          { id: "3", name: "voice", type: 2, position: 0 },
          { id: "4", name: "help", type: 15, position: 3 },
        ],
      ],
    ]);
    const ctx = testContext(m.fetch, app);
    expect(await discord.options!(ctx, account(), "channel", { postType: "message" })).toEqual([
      { value: "2", label: "#news (announcement)" },
      { value: "1", label: "#general" },
    ]);
    expect(await discord.options!(ctx, account(), "channel", { postType: "forum" })).toEqual([{ value: "4", label: "#help (forum)" }]);
  });
});

describe("discord publish", () => {
  it("posts a text message", async () => {
    const m = mockFetch([[`POST ${API}/channels/C1/messages`, () => ({ id: "M1", channel_id: "C1" })]]);
    const res = await discord.publish(testContext(m.fetch, app), account(), post({ settings: { channel: "C1", silent: true } }));
    expect(m.requests[0].json).toEqual({ content: "Hello", flags: 1 << 12 });
    expect(res).toEqual({ status: "published", externalId: "M1", url: "https://discord.com/channels/G1/C1/M1", data: { channelId: "C1" } });
  });

  it("streams attachments as multipart and crossposts", async () => {
    const m = mockFetch([
      [`POST ${API}/channels/C1/messages/M1/crosspost`, () => ({})],
      [`POST ${API}/channels/C1/messages`, () => ({ id: "M1", channel_id: "C1" })],
    ]);
    await discord.publish(testContext(m.fetch, app), account(), post({ media: [image(), video({ size: 3_000_000 })], settings: { channel: "C1", crosspost: true } }));
    const req = m.requests[0];
    expect(req.headers["content-type"]).toMatch(/^multipart\/form-data/);
    expect(req.headers.authorization).toBe("Bot BOT");
    expect(req.body).toContain('name="files[0]"; filename="photo.jpg"');
    expect(req.body).toContain('name="files[1]"; filename="clip.mp4"');
    const payload = JSON.parse(req.body!.match(/name="payload_json"\r\n\r\n(.*?)\r\n/)![1]);
    expect(payload.attachments).toEqual([
      { id: 0, filename: "photo.jpg", description: "alt text" },
      { id: 1, filename: "clip.mp4" },
    ]);
    expect(m.requests[1].url).toBe(`${API}/channels/C1/messages/M1/crosspost`);
  });

  it("links files over the server upload limit", async () => {
    const m = mockFetch([
      [`GET ${API}/guilds/G1`, () => ({ premium_tier: 0 })],
      [`POST ${API}/channels/C1/messages`, () => ({ id: "M1", channel_id: "C1" })],
    ]);
    const big = video({ size: 30_000_000 });
    const bigImg = image({ size: 12_000_000 });
    await discord.publish(testContext(m.fetch, app), account(), post({ media: [big, bigImg] }));
    expect(m.requests[1].json).toEqual({ content: `Hello\n${big.url}`, embeds: [{ image: { url: bigImg.url } }] });
  });

  it("creates a forum post", async () => {
    const m = mockFetch([[`POST ${API}/channels/F1/threads`, () => ({ id: "T1", type: 11 })]]);
    const res = await discord.publish(
      testContext(m.fetch, app),
      account(),
      post({ settings: { channel: "F1", postType: "forum", threadName: "Title" } }),
    );
    expect(m.requests[0].json).toEqual({ name: "Title", message: { content: "Hello" } });
    expect(res).toMatchObject({ externalId: "T1", url: "https://discord.com/channels/G1/T1", data: { channelId: "T1" } });
  });

  it("replies with a message reference inside the thread", async () => {
    const m = mockFetch([[`POST ${API}/channels/T1/messages`, () => ({ id: "M2", channel_id: "T1" })]]);
    const res = await discord.reply!(
      testContext(m.fetch, app),
      account(),
      { rootId: "T1", parentId: "T1", rootData: { channelId: "T1" }, parentData: { channelId: "T1" } },
      post({ content: "more" }),
    );
    expect(m.requests[0].json.message_reference).toEqual({ message_id: "T1", fail_if_not_exists: false });
    expect(res.url).toBe("https://discord.com/channels/G1/T1/M2");
  });

  it("maps 401 to auth and missing permissions to invalid", async () => {
    const unauth = mockFetch([[`POST ${API}/channels/C1/messages`, () => json({ message: "401: Unauthorized", code: 0 }, 401)]]);
    await expect(discord.publish(testContext(unauth.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const denied = mockFetch([[`POST ${API}/channels/C1/messages`, () => json({ message: "Missing Permissions", code: 50013 }, 403)]]);
    await expect(discord.publish(testContext(denied.fetch, app), account(), post())).rejects.toMatchObject({ kind: "invalid" });
  });
});
