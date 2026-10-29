import { ProviderError } from "./errors";
import { oauthToken, requestJson, requireApp, type RequestOptions } from "./http";
import { streamBody, streamingMultipart, type MultipartPart } from "./multipart";
import type { AccountRecord, MediaItem, Provider, ProviderContext, PublishPost } from "./types";

const API = "https://discord.com/api/v10";
const MB = 1024 * 1024;
// VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, ATTACH_FILES, READ_MESSAGE_HISTORY, MENTION_EVERYONE,
// CREATE_PUBLIC_THREADS, SEND_MESSAGES_IN_THREADS.
const PERMISSIONS = "309237894144";
const TEXT = 0;
const ANNOUNCEMENT = 5;
const FORUM = 15;
const MEDIA = 16;
const SUPPRESS_EMBEDS = 1 << 2;
const SUPPRESS_NOTIFICATIONS = 1 << 12;

/** Per-file upload limit by server boost tier (non-boosted servers: 10MiB). */
const uploadLimit = (tier: number) => (tier >= 3 ? 100 * MB : tier === 2 ? 50 * MB : 10 * MB);

const classify: RequestOptions["classify"] = (status, body) => {
  // Unknown guild: the bot was removed from the server.
  if (status === 401 || body?.code === 10004) return "auth";
  return undefined;
};

function bot(ctx: ProviderContext, init: RequestOptions = {}): RequestOptions {
  const { botToken } = requireApp(ctx, "Discord", "botToken");
  return { ...init, classify, headers: { ...(init.headers as Record<string, string>), authorization: `Bot ${botToken}` } };
}

/**
 * Sends a message (or creates a forum post) with attachments streamed from R2.
 * Files over the server's upload limit are linked instead (images as embeds, videos as links that Discord unfurls).
 */
async function sendMessage(
  ctx: ProviderContext,
  account: AccountRecord,
  post: PublishPost,
  target: { channelId: string; forum?: { name: string }; replyTo?: string },
): Promise<{ id: string; channel_id: string }> {
  const s = post.settings ?? {};
  let limit = uploadLimit(0);
  if (post.media.some((m) => m.size > limit)) {
    const guild = await requestJson<{ premium_tier?: number }>(ctx, `${API}/guilds/${account.externalId}`, bot(ctx));
    limit = uploadLimit(guild.premium_tier ?? 0);
  }
  const uploads = post.media.filter((m) => m.size <= limit);
  const linked = post.media.filter((m) => m.size > limit);
  const embeds = linked.filter((m) => m.kind === "image").map((m) => ({ image: { url: m.url } }));
  const links = linked.filter((m) => m.kind === "video").map((m) => m.url);
  const content = [post.content.trim(), ...links].filter(Boolean).join("\n");
  if (!content && !uploads.length && !embeds.length) throw new ProviderError("Discord: nothing to send", "invalid");

  let flags = 0;
  if (s.silent) flags |= SUPPRESS_NOTIFICATIONS;
  if (s.suppressEmbeds && !embeds.length) flags |= SUPPRESS_EMBEDS;
  const message: Record<string, unknown> = {
    content: content || undefined,
    embeds: embeds.length ? embeds : undefined,
    flags: flags || undefined,
    attachments: uploads.length
      ? uploads.map((m, i) => ({ id: i, filename: m.filename, description: m.alt ? m.alt.slice(0, 1024) : undefined }))
      : undefined,
    message_reference: target.replyTo ? { message_id: target.replyTo, fail_if_not_exists: false } : undefined,
  };
  const forum = target.forum;
  const payload = forum ? { name: forum.name.slice(0, 100), message } : message;
  const url = forum ? `${API}/channels/${target.channelId}/threads` : `${API}/channels/${target.channelId}/messages`;

  let init: RequestOptions;
  if (uploads.length) {
    const files: MultipartPart[] = uploads.map((m: MediaItem, i) => ({
      name: `files[${i}]`,
      filename: m.filename,
      type: m.mime,
      size: m.size,
      open: () => ctx.media.stream(m),
    }));
    const mp = streamingMultipart([{ name: "payload_json", value: JSON.stringify(payload) }, ...files]);
    init = streamBody(mp.body, mp.contentType);
  } else {
    init = { method: "POST", json: payload };
  }
  const res = await requestJson<{ id: string; channel_id?: string }>(ctx, url, bot(ctx, { ...init, commit: true }));
  // A forum post returns the new thread; its starter message has the same id as the thread.
  return forum ? { id: res.id, channel_id: res.id } : { id: res.id, channel_id: res.channel_id ?? target.channelId };
}

const messageUrl = (guildId: string, channelId: string, messageId?: string) =>
  `https://discord.com/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ""}`;

export const discord: Provider = {
  hotlinksMedia: true,
  id: "discord",
  name: "Discord",
  color: "5865F2",
  icon: "discord",
  category: "community",
  auth: "oauth2",
  docsUrl: "https://discord.com/developers/applications",
  setupNotes: [
    "1. Create an application at https://discord.com/developers/applications.",
    "2. **OAuth2**: copy the Client ID and Client Secret, and add the redirect `{{redirectUri}}`.",
    "3. **Bot**: reset/copy the bot token. Privileged intents are not needed.",
    "4. Connecting an account installs the bot in a server you manage; posts are sent by the bot.",
  ].join("\n"),
  appFields: [
    { key: "clientId", label: "Client ID", type: "text", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    { key: "botToken", label: "Bot token", type: "password", required: true },
  ],
  credentialFields: [],
  settingsFields: [
    {
      key: "postType",
      label: "Post as",
      type: "select",
      default: "message",
      options: [
        { value: "message", label: "Message in a text or announcement channel" },
        { value: "forum", label: "New post in a forum or media channel" },
      ],
    },
    { key: "channel", label: "Channel", type: "select", required: true, dynamicOptions: true },
    { key: "threadName", label: "Post title", type: "text", required: true, maxLength: 100, showIf: { key: "postType", equals: "forum" } },
    {
      key: "crosspost",
      label: "Publish to following servers",
      type: "checkbox",
      default: false,
      help: "Announcement channels only.",
      showIf: { key: "postType", equals: "message" },
    },
    { key: "silent", label: "Send silently (no push notification)", type: "checkbox", default: false },
    { key: "suppressEmbeds", label: "Hide link previews", type: "checkbox", default: false },
  ],
  capabilities: {
    maxLength: 2000,
    text: "optional",
    media: { images: 10, videos: 10, mixed: true, required: false },
    thread: true,
    threadLabel: "Replies",
  },
  authorize(ctx, { state }) {
    const { clientId } = requireApp(ctx, "Discord", "clientId", "clientSecret", "botToken");
    const u = new URL("https://discord.com/oauth2/authorize");
    u.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: ctx.redirectUri,
      scope: "bot guilds",
      permissions: PERMISSIONS,
      integration_type: "0",
      state,
    }).toString();
    return u.toString();
  },
  async callback(ctx, { code, params }) {
    const { clientId, clientSecret } = requireApp(ctx, "Discord", "clientId", "clientSecret", "botToken");
    const token = await oauthToken(
      ctx,
      `${API}/oauth2/token`,
      { grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri },
      { basicAuth: { id: clientId, secret: clientSecret } },
    );
    const guildId = token.guild?.id ?? params.get("guild_id");
    if (!guildId) throw new ProviderError("Discord did not return a server: pick a server when installing the bot", "invalid");
    // Confirms the configured bot token belongs to this app and the bot is in the server.
    const guild = await requestJson<{ id: string; name: string; icon: string | null }>(ctx, `${API}/guilds/${guildId}`, bot(ctx)).catch(
      (err) => {
        if (err instanceof ProviderError && err.kind === "auth") throw new ProviderError("Discord rejected the bot token: check it on the Platforms page", "invalid");
        throw err;
      },
    );
    return [
      {
        externalId: guild.id,
        name: guild.name,
        avatarUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png` : null,
        profileUrl: `https://discord.com/channels/${guild.id}`,
        // Posting uses the app's bot token; the user token is not needed after install.
        credentials: {},
        expiresAt: null,
        meta: { guildId: guild.id },
      },
    ];
  },
  async options(ctx, account, key, settings) {
    if (key !== "channel") return [];
    const channels = await requestJson<Array<{ id: string; name: string; type: number; position: number }>>(
      ctx,
      `${API}/guilds/${account.externalId}/channels`,
      bot(ctx),
    );
    const types = settings.postType === "forum" ? [FORUM, MEDIA] : [TEXT, ANNOUNCEMENT];
    const suffix: Record<number, string> = { [ANNOUNCEMENT]: " (announcement)", [FORUM]: " (forum)", [MEDIA]: " (media)" };
    return channels
      .filter((c) => types.includes(c.type))
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ value: c.id, label: `#${c.name}${suffix[c.type] ?? ""}` }));
  },
  async publish(ctx, account, post) {
    const s = post.settings ?? {};
    const channelId = String(s.channel ?? "");
    if (!channelId) throw new ProviderError("Discord: choose a channel", "invalid");
    const forum = s.postType === "forum";
    if (forum && !String(s.threadName ?? "").trim()) throw new ProviderError("Discord: forum posts need a title", "invalid");
    const msg = await sendMessage(ctx, account, post, { channelId, forum: forum ? { name: String(s.threadName) } : undefined });
    if (!forum && s.crosspost) {
      await requestJson(ctx, `${API}/channels/${channelId}/messages/${msg.id}/crosspost`, bot(ctx, { method: "POST" })).catch((err) =>
        ctx.log("warn", `Discord crosspost failed (announcement channels only): ${(err as Error).message}`),
      );
    }
    return {
      status: "published",
      externalId: msg.id,
      url: forum ? messageUrl(account.externalId, msg.channel_id) : messageUrl(account.externalId, msg.channel_id, msg.id),
      data: { channelId: msg.channel_id },
    };
  },
  async reply(ctx, account, target, post) {
    // Forum posts: replies go inside the thread (its id is the root's channelId).
    const channelId = String(target.parentData?.channelId ?? target.rootData?.channelId ?? post.settings?.channel ?? "");
    const msg = await sendMessage(ctx, account, post, { channelId, replyTo: target.parentId });
    return { externalId: msg.id, url: messageUrl(account.externalId, msg.channel_id, msg.id), data: { channelId: msg.channel_id } };
  },
};
