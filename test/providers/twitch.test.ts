import { describe, expect, it } from "vitest";
import { twitch } from "../../worker/providers/twitch";
import { json, mockFetch, testAccount, testContext } from "../helpers";

const app = { clientId: "CID", clientSecret: "SEC" };
const account = () => testAccount({ provider: "twitch", externalId: "U1", username: "streamer" });
const post = (settings: Record<string, unknown> = {}) => ({ id: "p1", content: "Going live!", media: [], settings });
const sent = { data: [{ message_id: "m1", is_sent: true, drop_reason: null }] };

describe("twitch oauth", () => {
  it("builds the authorize URL", () => {
    const url = new URL(twitch.authorize!(testContext(mockFetch([]).fetch, app, "twitch"), { state: "S", codeVerifier: "", codeChallenge: "" }) as string);
    expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "CID",
      redirect_uri: "https://pf.example.com/oauth/twitch/callback",
      scope: "user:write:chat moderator:manage:announcements",
      state: "S",
    });
  });

  it("exchanges the code and loads the user", async () => {
    const m = mockFetch([
      ["POST https://id.twitch.tv/oauth2/token", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 14000 })],
      ["GET https://api.twitch.tv/helix/users", () => ({ data: [{ id: "U1", login: "streamer", display_name: "Streamer", profile_image_url: "https://img/x.png" }] })],
    ]);
    const [acc] = await twitch.callback!(testContext(m.fetch, app, "twitch"), { code: "C", codeVerifier: "", params: new URLSearchParams() });
    expect(m.requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "C", client_id: "CID", client_secret: "SEC" });
    expect(m.requests[1].headers["client-id"]).toBe("CID");
    expect(m.requests[1].headers.authorization).toBe("Bearer AT");
    expect(acc).toMatchObject({
      externalId: "U1",
      name: "Streamer",
      username: "streamer",
      profileUrl: "https://www.twitch.tv/streamer",
      credentials: { accessToken: "AT", refreshToken: "RT" },
    });
    expect(acc.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes and maps an invalid refresh token to auth", async () => {
    const m = mockFetch([["POST https://id.twitch.tv/oauth2/token", () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 100 })]]);
    const up = await twitch.refresh!(testContext(m.fetch, app), account());
    expect(m.requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
    expect(up.credentials).toEqual({ accessToken: "AT2", refreshToken: "RT2" });

    const bad = mockFetch([["POST https://id.twitch.tv/oauth2/token", () => json({ status: 400, message: "Invalid refresh token" }, 400)]]);
    await expect(twitch.refresh!(testContext(bad.fetch, app), account())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("twitch publish", () => {
  it("sends a chat message", async () => {
    const m = mockFetch([["POST https://api.twitch.tv/helix/chat/messages", () => sent]]);
    const res = await twitch.publish(testContext(m.fetch, app), account(), post());
    expect(m.requests[0].json).toEqual({ broadcaster_id: "U1", sender_id: "U1", message: "Going live!" });
    expect(res).toEqual({ status: "published", externalId: "m1", url: "https://www.twitch.tv/streamer", data: {} });
  });

  it("sends an announcement with color", async () => {
    const m = mockFetch([["POST https://api.twitch.tv/helix/chat/announcements", () => new Response(null, { status: 204 })]]);
    const res = await twitch.publish(testContext(m.fetch, app), account(), post({ messageType: "announcement", announcementColor: "purple" }));
    const u = new URL(m.requests[0].url);
    expect(u.searchParams.get("broadcaster_id")).toBe("U1");
    expect(u.searchParams.get("moderator_id")).toBe("U1");
    expect(m.requests[0].json).toEqual({ message: "Going live!", color: "purple" });
    expect(res).toMatchObject({ status: "published", externalId: "announcement:p1", data: { announcement: true } });
  });

  it("rejects dropped messages", async () => {
    const m = mockFetch([
      ["POST https://api.twitch.tv/helix/chat/messages", () => ({ data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_duplicate", message: "Duplicate" } }] })],
    ]);
    await expect(twitch.publish(testContext(m.fetch, app), account(), post())).rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining("Duplicate") });
  });

  it("replies to the parent message, but not to announcements", async () => {
    const m = mockFetch([["POST https://api.twitch.tv/helix/chat/messages", () => sent]]);
    await twitch.reply!(testContext(m.fetch, app), account(), { rootId: "m0", parentId: "m0" }, post());
    expect(m.requests[0].json.reply_parent_message_id).toBe("m0");
    await twitch.reply!(testContext(m.fetch, app), account(), { rootId: "a", parentId: "a", parentData: { announcement: true } }, post());
    expect(m.requests[1].json.reply_parent_message_id).toBeUndefined();
  });

  it("maps 401 to auth", async () => {
    const m = mockFetch([["POST https://api.twitch.tv/helix/chat/messages", () => json({ message: "Invalid OAuth token" }, 401)]]);
    await expect(twitch.publish(testContext(m.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
  });
});
