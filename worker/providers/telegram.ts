import { ProviderError } from "./errors";
import { checkedCommit, requestJson, type RequestOptions } from "./http";
import { streamBody, streamingMultipart, type MultipartPart } from "./multipart";
import type { AccountRecord, MediaItem, Provider, ProviderContext, PublishPost } from "./types";

/*
 * Telegram Bot API. Media is passed by public URL when Telegram can pull it (photos <= 5MB, other files <= 20MB);
 * bigger files are streamed as multipart uploads (bots may upload photos up to 10MB and other files up to 50MB).
 * Larger photos are re-encoded below the limit; videos over 50MB cannot be sent by a bot.
 */

const API = "https://api.telegram.org";
const MB = 1024 * 1024;
const PHOTO_URL_LIMIT = 5 * MB;
const FILE_URL_LIMIT = 20 * MB;
const UPLOAD_LIMIT = 50 * MB;
const CAPTION_LIMIT = 1024;

// ---- Telegram ----

interface TgMessage {
  message_id: number;
  chat: { id: number; username?: string };
}

type Payload = Record<string, unknown>;

async function call<T>(ctx: ProviderContext, token: string, method: string, payload: Payload, files: MultipartPart[] = []): Promise<T> {
  const url = `${API}/bot${token}/${method}`;
  // send* methods post a message: each is a commit (docs/provider-brief.md "Commit semantics").
  const commit = method.startsWith("send");
  const classify: RequestOptions["classify"] = (status, body) => {
    const d = String(body?.description ?? "");
    if (status === 401 || /bot was kicked|bot is not a member|have no rights|not enough rights|chat_write_forbidden/i.test(d)) return "auth";
    if (status === 429) return "rate_limit";
    return undefined;
  };
  let opts: RequestOptions;
  if (files.length) {
    const fields: MultipartPart[] = Object.entries(payload)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([name, v]) => ({ name, value: typeof v === "string" ? v : JSON.stringify(v) }));
    const mp = streamingMultipart([...fields, ...files]);
    opts = { ...streamBody(mp.body, mp.contentType), classify, commit };
  } else {
    opts = { method: "POST", json: payload, classify, commit };
  }
  try {
    const res = await checkedCommit(
      ctx,
      () => requestJson<{ ok: boolean; result: T; description?: string }>(ctx, url, opts),
      (res) => {
        if (!res?.ok) throw new ProviderError(`Telegram: ${res?.description ?? "request failed"}`, "invalid");
      },
    );
    return res.result;
  } catch (err) {
    // Re-throw with Telegram's own description (and never the URL, which contains the bot token).
    if (err instanceof ProviderError && (err.body as any)?.description)
      throw new ProviderError(`Telegram ${method}: ${(err.body as any).description}`, err.kind, err.status, err.body);
    throw err;
  }
}

/** Length Telegram counts for a caption (after entity parsing). Over-estimates for MarkdownV2, which is safe. */
export function visibleLength(text: string, parseMode?: string): number {
  if (parseMode !== "HTML") return text.length;
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/gi, "_").length;
}

export function messageUrl(meta: Record<string, unknown>, chatId: string, messageId: number | string): string | null {
  if (meta.username) return `https://t.me/${meta.username}/${messageId}`;
  // Private supergroups/channels: link works for members only.
  if (chatId.startsWith("-100")) return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
  return null;
}

/** A media reference: either the public URL or an attached multipart part. */
async function inputFile(ctx: ProviderContext, item: MediaItem, index: number): Promise<{ ref: string; part?: MultipartPart }> {
  const attach = (part: Omit<Extract<MultipartPart, { open: unknown }>, "name">) => ({
    ref: `attach://file${index}`,
    part: { name: `file${index}`, ...part } as MultipartPart,
  });
  if (item.kind === "image" && item.mime !== "image/gif") {
    const tooBig = (item.width ?? 0) + (item.height ?? 0) > 10_000 || item.size > PHOTO_URL_LIMIT;
    if (!tooBig) return { ref: item.url };
    const blob = await ctx.media.image(item, { maxWidth: 2560, maxHeight: 2560, format: "image/jpeg", quality: 85 });
    return attach({ filename: item.filename.replace(/\.[^.]+$/, "") + ".jpg", type: "image/jpeg", size: blob.size, open: () => blob.stream() });
  }
  if (item.size <= FILE_URL_LIMIT) return { ref: item.url };
  if (item.size > UPLOAD_LIMIT) throw new ProviderError(`${item.filename} is larger than 50MB, the Telegram bot upload limit`, "invalid");
  return attach({ filename: item.filename, type: item.mime, size: item.size, open: () => ctx.media.stream(item) });
}

function videoExtras(item: MediaItem): Payload {
  return {
    supports_streaming: true,
    width: item.width ?? undefined,
    height: item.height ?? undefined,
    duration: item.duration ? Math.round(item.duration) : undefined,
  };
}

async function send(ctx: ProviderContext, account: AccountRecord, post: PublishPost, replyTo?: string) {
  const token = String(account.credentials.botToken ?? "");
  const chatId = String(account.meta.chatId ?? account.externalId);
  const s = post.settings ?? {};
  const parseMode = s.parseMode && s.parseMode !== "none" ? String(s.parseMode) : undefined;
  const common: Payload = {
    chat_id: chatId,
    message_thread_id: s.topicId ? Number(s.topicId) : undefined,
    disable_notification: s.disableNotification ? true : undefined,
    protect_content: s.protectContent ? true : undefined,
    reply_parameters: replyTo ? { message_id: Number(replyTo), allow_sending_without_reply: true } : undefined,
  };
  const text = post.content.trim() ? post.content : "";
  const sendText = () =>
    call<TgMessage>(ctx, token, "sendMessage", {
      ...common,
      text,
      parse_mode: parseMode,
      link_preview_options: s.disableLinkPreview ? { is_disabled: true } : undefined,
    });

  const messages: TgMessage[] = [];
  if (!post.media.length) {
    if (!text) throw new ProviderError("Telegram: nothing to send", "invalid");
    messages.push(await sendText());
  } else {
    const captionFits = visibleLength(text, parseMode) <= CAPTION_LIMIT;
    const caption = text && captionFits ? { caption: text, parse_mode: parseMode } : {};
    const spoiler = s.hasSpoiler ? true : undefined;
    const inputs = await Promise.all(post.media.map((m, i) => inputFile(ctx, m, i)));
    const parts = inputs.flatMap((i) => (i.part ? [i.part] : []));
    if (post.media.length === 1) {
      const item = post.media[0];
      const ref = inputs[0].ref;
      const [method, field] =
        item.kind === "video" ? ["sendVideo", "video"] : item.mime === "image/gif" ? ["sendAnimation", "animation"] : ["sendPhoto", "photo"];
      const extras = item.kind === "video" ? videoExtras(item) : {};
      messages.push(await call<TgMessage>(ctx, token, method, { ...common, ...caption, ...extras, has_spoiler: spoiler, [field]: ref }, parts));
    } else {
      // Albums accept photos and videos only; GIFs are sent as photos.
      const media = post.media.map((m, i) => ({
        type: m.kind === "video" ? "video" : "photo",
        media: inputs[i].ref,
        has_spoiler: spoiler,
        ...(m.kind === "video" ? videoExtras(m) : {}),
        ...(i === 0 ? caption : {}),
      }));
      messages.push(...(await call<TgMessage[]>(ctx, token, "sendMediaGroup", { ...common, media }, parts)));
    }
    // Captions are limited to 1024 characters: send the text as its own message right after the media.
    if (text && !captionFits) messages.push(await sendText());
  }
  const first = messages[0];
  return {
    externalId: String(first.message_id),
    url: messageUrl(account.meta, chatId, first.message_id),
    data: { messageIds: messages.map((m) => m.message_id) },
  };
}

function normalizeChat(input: string): string {
  const v = input.trim().replace(/^https?:\/\/(www\.)?(t|telegram)\.me\//i, "").replace(/\/$/, "");
  if (/^-?\d+$/.test(v)) return v;
  return v.startsWith("@") ? v : `@${v}`;
}

export const telegram: Provider = {
  id: "telegram",
  name: "Telegram",
  color: "26A5E4",
  icon: "telegram",
  category: "messaging",
  auth: "credentials",
  appFields: [],
  credentialFields: [
    {
      key: "botToken",
      label: "Bot token",
      type: "password",
      required: true,
      placeholder: "123456789:AA...",
      help: "Create a bot with @BotFather (/newbot) and paste the token it gives you.",
    },
    {
      key: "chat",
      label: "Channel or chat",
      type: "text",
      required: true,
      placeholder: "@mychannel or -1001234567890",
      help: "Public channel/group @username, or the numeric chat id for private ones. Add the bot as an administrator with permission to post messages.",
    },
  ],
  settingsFields: [
    {
      key: "parseMode",
      label: "Formatting",
      type: "select",
      default: "none",
      options: [
        { value: "none", label: "Plain text" },
        { value: "HTML", label: "HTML (<b>, <i>, <a href>, <code>...)" },
        { value: "MarkdownV2", label: "MarkdownV2" },
      ],
      help: "With HTML or MarkdownV2 the text must be valid markup for Telegram (escape <, >, & in HTML).",
    },
    { key: "disableNotification", label: "Send silently (no notification)", type: "checkbox", default: false },
    { key: "disableLinkPreview", label: "Disable link preview", type: "checkbox", default: false },
    { key: "protectContent", label: "Protect content (no forwarding or saving)", type: "checkbox", default: false },
    { key: "hasSpoiler", label: "Hide media under a spoiler", type: "checkbox", default: false },
    { key: "topicId", label: "Topic id", type: "text", placeholder: "Forum topic (message thread) id, optional" },
  ],
  capabilities: {
    maxLength: 4096,
    text: "optional",
    media: { images: 10, videos: 10, mixed: true, required: false },
    thread: true,
    threadLabel: "Replies",
  },
  async connect(ctx, values) {
    const token = values.botToken?.trim();
    if (!token || !values.chat?.trim()) throw new ProviderError("Bot token and chat are required", "invalid");
    const bot = await call<{ id: number; username: string }>(ctx, token, "getMe", {});
    const chat = await call<{ id: number; type: string; title?: string; first_name?: string; username?: string }>(ctx, token, "getChat", {
      chat_id: normalizeChat(values.chat),
    });
    if (chat.type !== "private") {
      const member = await call<{ status: string; can_post_messages?: boolean; can_send_messages?: boolean }>(ctx, token, "getChatMember", {
        chat_id: chat.id,
        user_id: bot.id,
      });
      const admin = member.status === "administrator" || member.status === "creator";
      if (chat.type === "channel" && (!admin || member.can_post_messages === false))
        throw new ProviderError(`@${bot.username} must be an administrator of the channel with permission to post messages`, "invalid");
      if (["left", "kicked"].includes(member.status) || (member.status === "restricted" && member.can_send_messages === false))
        throw new ProviderError(`@${bot.username} cannot send messages in this chat`, "invalid");
    }
    return [
      {
        externalId: String(chat.id),
        name: chat.title ?? chat.first_name ?? chat.username ?? String(chat.id),
        username: chat.username ?? null,
        avatarUrl: null,
        profileUrl: chat.username ? `https://t.me/${chat.username}` : null,
        credentials: { botToken: token },
        meta: { chatId: String(chat.id), chatType: chat.type, username: chat.username ?? null, botId: bot.id, botUsername: bot.username },
      },
    ];
  },
  validate(post) {
    const errors: string[] = [];
    if (!post.content.trim() && !post.media.length) errors.push("Telegram: add text or media");
    for (const m of post.media) {
      if (m.kind === "video" && m.size > UPLOAD_LIMIT) errors.push(`Telegram: ${m.filename} is larger than 50MB (bot upload limit)`);
      if (m.mime === "image/gif" && m.size > UPLOAD_LIMIT) errors.push(`Telegram: ${m.filename} is larger than 50MB`);
    }
    return errors;
  },
  async publish(ctx, account, post) {
    return { status: "published", ...(await send(ctx, account, post)) };
  },
  async reply(ctx, account, target, post) {
    return send(ctx, account, post, target.parentId);
  },
};
