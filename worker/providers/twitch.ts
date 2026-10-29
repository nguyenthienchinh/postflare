import { ProviderError } from "./errors";
import { checkedCommit, clientFields, expiresAt, oauthToken, requestJson, requireApp } from "./http";
import type { AccountRecord, Provider, ProviderContext, PublishPost } from "./types";

const HELIX = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const SCOPES = ["user:write:chat", "moderator:manage:announcements"];

const helix = (ctx: ProviderContext, account: AccountRecord | string) => ({
  token: typeof account === "string" ? account : String(account.credentials.accessToken ?? ""),
  headers: { "client-id": ctx.app.clientId ?? "" },
});

async function userInfo(ctx: ProviderContext, accessToken: string) {
  const res = await requestJson<{ data: Array<{ id: string; login: string; display_name: string; profile_image_url?: string }> }>(
    ctx,
    `${HELIX}/users`,
    helix(ctx, accessToken),
  );
  const user = res.data?.[0];
  if (!user) throw new ProviderError("Twitch did not return the user", "transient");
  return user;
}

/** Sends a chat message (optionally as a reply) or an announcement to the account's own channel. */
async function send(ctx: ProviderContext, account: AccountRecord, post: PublishPost, replyTo?: string) {
  const id = account.externalId;
  const message = post.content.trim();
  if (!message) throw new ProviderError("Twitch: message is empty", "invalid");
  const url = account.username ? `https://www.twitch.tv/${account.username}` : null;

  if (post.settings?.messageType === "announcement") {
    await requestJson(ctx, `${HELIX}/chat/announcements`, {
      ...helix(ctx, account),
      method: "POST",
      query: { broadcaster_id: id, moderator_id: id },
      json: { message, color: post.settings.announcementColor || "primary" },
      commit: true,
    });
    // Announcements return 204 without a message id.
    return { externalId: `announcement:${post.id}`, url, data: { announcement: true } };
  }

  // A dropped message (is_sent: false) was not posted: a refusal, not an ambiguous commit.
  const res = await checkedCommit(
    ctx,
    () =>
      requestJson<{ data: Array<{ message_id: string; is_sent: boolean; drop_reason?: { code: string; message: string } | null }> }>(
        ctx,
        `${HELIX}/chat/messages`,
        {
          ...helix(ctx, account),
          method: "POST",
          json: { broadcaster_id: id, sender_id: id, message, reply_parent_message_id: replyTo },
          commit: true,
        },
      ),
    (res) => {
      const sent = res.data?.[0];
      if (!sent?.is_sent) throw new ProviderError(`Twitch dropped the message: ${sent?.drop_reason?.message ?? "unknown reason"}`, "invalid");
    },
  );
  const sent = res.data[0];
  return { externalId: sent.message_id, url, data: {} };
}

export const twitch: Provider = {
  id: "twitch",
  name: "Twitch",
  color: "9146FF",
  icon: "twitch",
  category: "video",
  auth: "oauth2",
  docsUrl: "https://dev.twitch.tv/console/apps",
  setupNotes: [
    "1. Register an application at https://dev.twitch.tv/console/apps (category: Application Integration, client type: Confidential).",
    "2. Add the OAuth redirect URL `{{redirectUri}}`.",
    "3. Copy the Client ID and generate a Client Secret.",
    "Posts are sent as chat messages or announcements in your own channel.",
  ].join("\n"),
  appFields: clientFields(),
  credentialFields: [],
  settingsFields: [
    {
      key: "messageType",
      label: "Message type",
      type: "select",
      default: "message",
      options: [
        { value: "message", label: "Chat message" },
        { value: "announcement", label: "Announcement (highlighted)" },
      ],
    },
    {
      key: "announcementColor",
      label: "Announcement color",
      type: "select",
      default: "primary",
      options: ["primary", "blue", "green", "orange", "purple"].map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })),
      showIf: { key: "messageType", equals: "announcement" },
    },
  ],
  capabilities: {
    maxLength: 500,
    text: "required",
    media: { images: 0, videos: 0, mixed: false, required: false },
    thread: true,
    threadLabel: "Follow-up messages",
  },
  authorize(ctx, { state }) {
    const { clientId } = requireApp(ctx, "Twitch", "clientId", "clientSecret");
    const u = new URL("https://id.twitch.tv/oauth2/authorize");
    u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: ctx.redirectUri, scope: SCOPES.join(" "), state }).toString();
    return u.toString();
  },
  async callback(ctx, { code }) {
    const { clientId, clientSecret } = requireApp(ctx, "Twitch", "clientId", "clientSecret");
    const tok = await oauthToken(ctx, TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: ctx.redirectUri,
    });
    const user = await userInfo(ctx, tok.access_token);
    return [
      {
        externalId: user.id,
        name: user.display_name,
        username: user.login,
        avatarUrl: user.profile_image_url || null,
        profileUrl: `https://www.twitch.tv/${user.login}`,
        credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
        expiresAt: expiresAt(tok.expires_in),
      },
    ];
  },
  async refresh(ctx, account) {
    const { clientId, clientSecret } = requireApp(ctx, "Twitch", "clientId", "clientSecret");
    const tok = await oauthToken(ctx, TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: String(account.credentials.refreshToken ?? ""),
      client_id: clientId,
      client_secret: clientSecret,
    }).catch((err) => {
      // Twitch answers 400 "Invalid refresh token" when the grant was revoked.
      if (err instanceof ProviderError && err.status === 400) throw new ProviderError(err.message, "auth", err.status, err.body);
      throw err;
    });
    return {
      credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token ?? account.credentials.refreshToken },
      expiresAt: expiresAt(tok.expires_in),
    };
  },
  async publish(ctx, account, post) {
    return { status: "published", ...(await send(ctx, account, post)) };
  },
  async reply(ctx, account, target, post) {
    // Announcements have no message id to reply to.
    const replyTo = target.parentData?.announcement ? undefined : target.parentId;
    return send(ctx, account, post, replyTo);
  },
};
