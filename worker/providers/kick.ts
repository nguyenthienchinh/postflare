import { ProviderError } from "./errors";
import { checkedCommit, clientFields, expiresAt, oauthToken, requestJson, requireApp } from "./http";
import type { AccountRecord, Provider, ProviderContext, PublishPost } from "./types";

const API = "https://api.kick.com/public/v1";
const TOKEN_URL = "https://id.kick.com/oauth/token";
const SCOPES = ["user:read", "channel:read", "chat:write"];

async function profile(ctx: ProviderContext, token: string) {
  const users = await requestJson<{ data: Array<{ user_id: number; name: string; profile_picture?: string }> }>(ctx, `${API}/users`, { token });
  const user = users.data?.[0];
  if (!user) throw new ProviderError("Kick did not return the user", "transient");
  // The channel slug is the public URL (https://kick.com/<slug>); it can differ from the display name.
  const channels = await requestJson<{ data: Array<{ slug: string }> }>(ctx, `${API}/channels`, { token }).catch(() => ({ data: [] as Array<{ slug: string }> }));
  return { user, slug: channels.data?.[0]?.slug ?? user.name.toLowerCase() };
}

async function send(ctx: ProviderContext, account: AccountRecord, post: PublishPost, replyTo?: string) {
  const content = post.content.trim();
  if (!content) throw new ProviderError("Kick: message is empty", "invalid");
  // is_sent: false = not posted: a refusal, not an ambiguous commit.
  const res = await checkedCommit(
    ctx,
    () =>
      requestJson<{ data?: { is_sent: boolean; message_id: string } }>(ctx, `${API}/chat`, {
        method: "POST",
        token: String(account.credentials.accessToken ?? ""),
        json: { type: "user", content, broadcaster_user_id: Number(account.externalId), reply_to_message_id: replyTo },
        commit: true,
      }),
    (res) => {
      if (!res?.data?.is_sent) throw new ProviderError("Kick did not send the message", "invalid", 200, res);
    },
  );
  const slug = account.meta.slug ?? account.username;
  return { externalId: res.data!.message_id, url: slug ? `https://kick.com/${slug}` : null };
}

export const kick: Provider = {
  id: "kick",
  name: "Kick",
  color: "53FC18",
  icon: "kick",
  category: "video",
  auth: "oauth2",
  docsUrl: "https://kick.com/settings/developer",
  setupNotes: [
    "1. Enable 2FA on your Kick account, then create an app in **Settings > Developer** (https://kick.com/settings/developer).",
    "2. Set the redirect URL to `{{redirectUri}}` and enable the scopes `user:read`, `channel:read`, `chat:write`.",
    "3. Copy the Client ID and Client Secret.",
    "Posts are sent as chat messages in your own channel.",
  ].join("\n"),
  appFields: clientFields(),
  credentialFields: [],
  settingsFields: [],
  capabilities: {
    maxLength: 500,
    text: "required",
    media: { images: 0, videos: 0, mixed: false, required: false },
    thread: true,
    threadLabel: "Follow-up messages",
  },
  authorize(ctx, { state, codeChallenge }) {
    const { clientId } = requireApp(ctx, "Kick", "clientId", "clientSecret");
    const u = new URL("https://id.kick.com/oauth/authorize");
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: ctx.redirectUri,
      scope: SCOPES.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  },
  async callback(ctx, { code, codeVerifier }) {
    const { clientId, clientSecret } = requireApp(ctx, "Kick", "clientId", "clientSecret");
    const tok = await oauthToken(ctx, TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: ctx.redirectUri,
    });
    const { user, slug } = await profile(ctx, tok.access_token);
    return [
      {
        externalId: String(user.user_id),
        name: user.name,
        username: slug,
        avatarUrl: user.profile_picture || null,
        profileUrl: `https://kick.com/${slug}`,
        credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
        expiresAt: expiresAt(tok.expires_in),
        meta: { slug },
      },
    ];
  },
  async refresh(ctx, account) {
    const { clientId, clientSecret } = requireApp(ctx, "Kick", "clientId", "clientSecret");
    const tok = await oauthToken(ctx, TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: String(account.credentials.refreshToken ?? ""),
      client_id: clientId,
      client_secret: clientSecret,
    }).catch((err) => {
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
    return send(ctx, account, post, target.parentId);
  },
};
