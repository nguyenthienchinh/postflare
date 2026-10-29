import { describe, expect, it } from "vitest";
import { telegram, visibleLength } from "../../worker/providers/telegram";
import { streamingMultipart } from "../../worker/providers/multipart";
import { ProviderError } from "../../worker/providers/errors";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

const API = "https://api.telegram.org/botTOKEN";
const ok = (result: unknown) => ({ ok: true, result });
const account = (meta: Record<string, unknown> = { chatId: "-1001234", username: "mychan" }) =>
  testAccount({ provider: "telegram", externalId: "-1001234", credentials: { botToken: "TOKEN" }, meta });
const post = (over: Partial<Parameters<typeof telegram.publish>[2]> = {}) => ({ id: "p1", content: "Hello", media: [], settings: {}, ...over });

describe("telegram connect", () => {
  it("verifies the bot and chat, returns one account", async () => {
    const m = mockFetch([
      [`POST ${API}/getMe`, () => ok({ id: 42, username: "mybot" })],
      [`POST ${API}/getChatMember`, () => ok({ status: "administrator", can_post_messages: true })],
      [`POST ${API}/getChat`, () => ok({ id: -1001234, type: "channel", title: "My Channel", username: "mychan" })],
    ]);
    const accounts = await telegram.connect!(testContext(m.fetch), { botToken: "TOKEN", chat: "https://t.me/mychan" });
    expect(m.requests[1].json).toEqual({ chat_id: "@mychan" });
    expect(m.requests[2].json).toEqual({ chat_id: -1001234, user_id: 42 });
    expect(accounts).toEqual([
      expect.objectContaining({
        externalId: "-1001234",
        name: "My Channel",
        username: "mychan",
        profileUrl: "https://t.me/mychan",
        credentials: { botToken: "TOKEN" },
        meta: expect.objectContaining({ chatId: "-1001234", chatType: "channel", botUsername: "mybot" }),
      }),
    ]);
  });

  it("rejects a bot that is not a channel admin", async () => {
    const m = mockFetch([
      [`POST ${API}/getMe`, () => ok({ id: 42, username: "mybot" })],
      [`POST ${API}/getChatMember`, () => ok({ status: "member" })],
      [`POST ${API}/getChat`, () => ok({ id: -100, type: "channel", title: "C" })],
    ]);
    await expect(telegram.connect!(testContext(m.fetch), { botToken: "TOKEN", chat: "-100" })).rejects.toThrow(/administrator/);
  });

  it("maps 401 to auth without leaking the token", async () => {
    const m = mockFetch([[`POST ${API}/getMe`, () => json({ ok: false, error_code: 401, description: "Unauthorized" }, 401)]]);
    const err = await telegram.connect!(testContext(m.fetch), { botToken: "TOKEN", chat: "@x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain("TOKEN");
  });
});

describe("telegram publish", () => {
  it("sends text with settings", async () => {
    const m = mockFetch([[`POST ${API}/sendMessage`, () => ok({ message_id: 7, chat: { id: -1001234 } })]]);
    const res = await telegram.publish(
      testContext(m.fetch),
      account(),
      post({ settings: { parseMode: "HTML", disableNotification: true, disableLinkPreview: true } }),
    );
    expect(m.requests[0].json).toEqual({
      chat_id: "-1001234",
      text: "Hello",
      parse_mode: "HTML",
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    });
    expect(res).toEqual({ status: "published", externalId: "7", url: "https://t.me/mychan/7", data: { messageIds: [7] } });
  });

  it("uses t.me/c links for private channels and plain text without parse mode", async () => {
    const m = mockFetch([[`POST ${API}/sendMessage`, () => ok({ message_id: 9, chat: { id: -1001234 } })]]);
    const res = await telegram.publish(testContext(m.fetch), account({ chatId: "-1001234" }), post({ settings: { parseMode: "none" } }));
    expect(m.requests[0].json.parse_mode).toBeUndefined();
    expect(res).toMatchObject({ url: "https://t.me/c/1234/9" });
  });

  it("sends a photo by URL with caption", async () => {
    const m = mockFetch([[`POST ${API}/sendPhoto`, () => ok({ message_id: 8, chat: { id: 1 } })]]);
    await telegram.publish(testContext(m.fetch), account(), post({ media: [image()] }));
    expect(m.requests[0].json).toMatchObject({ photo: image().url, caption: "Hello" });
  });

  it("re-encodes a large photo and uploads it as multipart", async () => {
    const m = mockFetch([[`POST ${API}/sendPhoto`, () => ok({ message_id: 8, chat: { id: 1 } })]]);
    await telegram.publish(testContext(m.fetch), account(), post({ media: [image({ size: 8_000_000 })] }));
    const req = m.requests[0];
    expect(req.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(req.body).toContain('name="photo"\r\n\r\nattach://file0');
    expect(req.body).toContain('name="file0"; filename="photo.jpg"');
    expect(req.body).toContain('name="caption"\r\n\r\nHello');
  });

  it("sends a small video by URL and streams a 20-50MB video", async () => {
    const m = mockFetch([[`POST ${API}/sendVideo`, () => ok({ message_id: 3, chat: { id: 1 } })]]);
    await telegram.publish(testContext(m.fetch), account(), post({ media: [video()] }));
    expect(m.requests[0].json).toMatchObject({ video: video().url, supports_streaming: true, width: 1080, duration: 20 });

    const big = video({ size: 30_000_000 });
    await telegram.publish(testContext(m.fetch), account(), post({ media: [big] }));
    const req = m.requests[1];
    expect(req.body).toContain('name="video"\r\n\r\nattach://file0');
    expect(req.body).toContain('filename="clip.mp4"\r\nContent-Type: video/mp4');
    expect(req.body!.length).toBeGreaterThan(30_000_000);
  });

  it("rejects videos over 50MB", async () => {
    const m = mockFetch([]);
    const err = await telegram.publish(testContext(m.fetch), account(), post({ media: [video({ size: 60_000_000 })] })).catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(telegram.validate!(post({ media: [video({ size: 60_000_000 })] }))).toHaveLength(1);
  });

  it("sends a mixed media group and long text separately", async () => {
    const m = mockFetch([
      [`POST ${API}/sendMediaGroup`, () => ok([{ message_id: 10, chat: { id: 1 } }, { message_id: 11, chat: { id: 1 } }])],
      [`POST ${API}/sendMessage`, () => ok({ message_id: 12, chat: { id: 1 } })],
    ]);
    const long = "x".repeat(1500);
    const res = await telegram.publish(testContext(m.fetch), account(), post({ content: long, media: [image(), video()] }));
    expect(m.requests[0].json.media).toEqual([
      expect.objectContaining({ type: "photo", media: image().url }),
      expect.objectContaining({ type: "video", media: video().url }),
    ]);
    expect(m.requests[0].json.media[0].caption).toBeUndefined();
    expect(m.requests[1].json.text).toBe(long);
    expect(res).toMatchObject({ externalId: "10", data: { messageIds: [10, 11, 12] } });
  });

  it("puts the caption on the first album item when it fits", async () => {
    const m = mockFetch([[`POST ${API}/sendMediaGroup`, () => ok([{ message_id: 10, chat: { id: 1 } }])]]);
    await telegram.publish(testContext(m.fetch), account(), post({ media: [image(), image({ id: "b" })] }));
    expect(m.requests[0].json.media[0].caption).toBe("Hello");
    expect(m.requests).toHaveLength(1);
  });

  it("replies to the parent message", async () => {
    const m = mockFetch([[`POST ${API}/sendMessage`, () => ok({ message_id: 20, chat: { id: 1 } })]]);
    const res = await telegram.reply!(testContext(m.fetch), account(), { rootId: "7", parentId: "8" }, post({ content: "reply" }));
    expect(m.requests[0].json.reply_parameters).toEqual({ message_id: 8, allow_sending_without_reply: true });
    expect(res.externalId).toBe("20");
  });

  it("maps a kicked bot to auth and 429 to rate_limit", async () => {
    const kicked = mockFetch([
      [`POST ${API}/sendMessage`, () => json({ ok: false, error_code: 403, description: "Forbidden: bot was kicked from the channel chat" }, 403)],
    ]);
    await expect(telegram.publish(testContext(kicked.fetch), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const limited = mockFetch([[`POST ${API}/sendMessage`, () => json({ ok: false, error_code: 429, description: "Too Many Requests" }, 429)]]);
    await expect(telegram.publish(testContext(limited.fetch), account(), post())).rejects.toMatchObject({ kind: "rate_limit" });
  });
});

describe("helpers", () => {
  it("counts visible caption length for HTML", () => {
    expect(visibleLength("<b>hi</b> &amp;", "HTML")).toBe(4);
    expect(visibleLength("<b>hi</b>")).toBe(9);
  });

  it("multipart length matches the streamed bytes", async () => {
    const mp = streamingMultipart([
      { name: "a", value: "héllo" },
      { name: "f", filename: "x.bin", type: "application/octet-stream", size: 1000, open: () => new Blob([new Uint8Array(1000)]).stream() },
    ]);
    const buf = await new Response(mp.body).arrayBuffer();
    expect(buf.byteLength).toBe(mp.length);
  });
});
