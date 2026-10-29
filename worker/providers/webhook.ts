import { ProviderError } from "./errors";
import { request } from "./http";
import type { Provider } from "./types";

/** Generic outgoing webhook: POSTs the post as JSON to any URL (Zapier, Make, n8n, your own backend...). */
export const webhook: Provider = {
  hotlinksMedia: true,
  id: "webhook",
  name: "Webhook",
  color: "6B7280",
  category: "messaging",
  auth: "credentials",
  status: "verified",
  appFields: [],
  credentialFields: [
    { key: "name", label: "Name", type: "text", required: true, placeholder: "My automation" },
    { key: "url", label: "Webhook URL", type: "url", required: true, placeholder: "https://hooks.example.com/..." },
    { key: "secret", label: "Secret header value", type: "password", help: "Sent as the X-Postflare-Secret header." },
  ],
  settingsFields: [],
  capabilities: {
    maxLength: 100_000,
    text: "optional",
    media: { images: 20, videos: 20, mixed: true, required: false },
    thread: false,
  },
  async connect(_ctx, values) {
    let url: URL;
    try {
      url = new URL(values.url?.trim());
    } catch {
      throw new ProviderError("Enter a valid webhook URL", "invalid");
    }
    if (url.protocol !== "https:") throw new ProviderError("Webhook URL must use https", "invalid");
    return [
      {
        externalId: url.toString(),
        name: values.name || url.host,
        username: url.host,
        credentials: { url: url.toString(), secret: values.secret || undefined },
      },
    ];
  },
  async publish(ctx, account, post) {
    const res = await request(ctx, account.credentials.url as string, {
      method: "POST",
      headers: {
        // Retries resend the same post: receivers can dedupe on this key. That is why this request is not marked
        // `commit: true` and stays retryable (docs/provider-brief.md "Commit semantics").
        "idempotency-key": post.id,
        ...(account.credentials.secret ? { "x-postflare-secret": String(account.credentials.secret) } : {}),
      },
      json: {
        id: post.id,
        content: post.content,
        settings: post.settings,
        media: post.media.map((m) => ({ url: m.url, type: m.kind, mime: m.mime, filename: m.filename, alt: m.alt })),
      },
    });
    const body = await res.json<{ id?: string; url?: string }>().catch(() => ({}) as { id?: string; url?: string });
    return { status: "published", externalId: body.id ?? post.id, url: body.url ?? null };
  },
};
