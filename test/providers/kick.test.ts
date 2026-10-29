import { describe, expect, it } from "vitest";
import { kick } from "../../worker/providers/kick";
import { json, mockFetch, testAccount, testContext } from "../helpers";

const app = { clientId: "CID", clientSecret: "SEC" };
const account = () => testAccount({ provider: "kick", externalId: "123", username: "streamer", meta: { slug: "streamer" } });
const post = () => ({ id: "p1", content: "Hello chat", media: [], settings: {} });

describe("kick oauth", () => {
  it("builds the authorize URL with PKCE", () => {
    const url = new URL(kick.authorize!(testContext(mockFetch([]).fetch, app, "kick"), { state: "S", codeVerifier: "V", codeChallenge: "CH" }) as string);
    expect(url.origin + url.pathname).toBe("https://id.kick.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "CID",
      redirect_uri: "https://pf.example.com/oauth/kick/callback",
      scope: "user:read channel:read chat:write",
      state: "S",
      code_challenge: "CH",
      code_challenge_method: "S256",
    });
  });

  it("exchanges the code with the verifier and loads the channel", async () => {
    const m = mockFetch([
      ["POST https://id.kick.com/oauth/token", () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      ["GET https://api.kick.com/public/v1/users", () => ({ data: [{ user_id: 123, name: "Streamer", profile_picture: "https://p/x.png" }] })],
      ["GET https://api.kick.com/public/v1/channels", () => ({ data: [{ slug: "streamer-tv" }] })],
    ]);
    const [acc] = await kick.callback!(testContext(m.fetch, app, "kick"), { code: "C", codeVerifier: "V", params: new URLSearchParams() });
    expect(m.requests[0].form).toMatchObject({ grant_type: "authorization_code", code: "C", code_verifier: "V", client_id: "CID", client_secret: "SEC" });
    expect(acc).toMatchObject({
      externalId: "123",
      name: "Streamer",
      username: "streamer-tv",
      profileUrl: "https://kick.com/streamer-tv",
      avatarUrl: "https://p/x.png",
      credentials: { accessToken: "AT", refreshToken: "RT" },
    });
  });

  it("refreshes tokens", async () => {
    const m = mockFetch([["POST https://id.kick.com/oauth/token", () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 })]]);
    const up = await kick.refresh!(testContext(m.fetch, app), account());
    expect(m.requests[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
    expect(up.credentials).toEqual({ accessToken: "AT2", refreshToken: "RT2" });
    const bad = mockFetch([["POST https://id.kick.com/oauth/token", () => json({ error: "invalid_grant" }, 400)]]);
    await expect(kick.refresh!(testContext(bad.fetch, app), account())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("kick publish", () => {
  it("sends a chat message", async () => {
    const m = mockFetch([["POST https://api.kick.com/public/v1/chat", () => ({ data: { is_sent: true, message_id: "msg1" }, message: "OK" })]]);
    const res = await kick.publish(testContext(m.fetch, app), account(), post());
    expect(m.requests[0].json).toEqual({ type: "user", content: "Hello chat", broadcaster_user_id: 123 });
    expect(m.requests[0].headers.authorization).toBe("Bearer AT");
    expect(res).toEqual({ status: "published", externalId: "msg1", url: "https://kick.com/streamer" });
  });

  it("replies to the parent message", async () => {
    const m = mockFetch([["POST https://api.kick.com/public/v1/chat", () => ({ data: { is_sent: true, message_id: "msg2" } })]]);
    const res = await kick.reply!(testContext(m.fetch, app), account(), { rootId: "msg1", parentId: "msg1" }, post());
    expect(m.requests[0].json.reply_to_message_id).toBe("msg1");
    expect(res.externalId).toBe("msg2");
  });

  it("maps errors", async () => {
    const unauth = mockFetch([["POST https://api.kick.com/public/v1/chat", () => json({ message: "Unauthorized" }, 401)]]);
    await expect(kick.publish(testContext(unauth.fetch, app), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const notSent = mockFetch([["POST https://api.kick.com/public/v1/chat", () => ({ data: { is_sent: false } })]]);
    await expect(kick.publish(testContext(notSent.fetch, app), account(), post())).rejects.toMatchObject({ kind: "invalid" });
  });
});
