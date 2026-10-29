import { ProviderError } from "./errors";
import { requestJson, type RequestOptions } from "./http";
import type { AccountRecord, MediaItem, Provider, ProviderContext } from "./types";

/** Basic auth works for both API users (v4+: username + API token) and legacy admin logins. */
function api(ctx: ProviderContext, creds: { url: string; username: string; token: string }, path: string, init: RequestOptions = {}) {
  return requestJson<any>(ctx, `${creds.url}/api${path}`, {
    ...init,
    headers: { accept: "application/json", authorization: `Basic ${btoa(`${creds.username}:${creds.token}`)}`, ...(init.headers as Record<string, string>) },
  });
}

const creds = (account: AccountRecord) => ({
  url: String(account.credentials.url),
  username: String(account.credentials.username),
  token: String(account.credentials.token),
});

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const looksLikeHtml = (s: string) => /<\/?(p|div|br|hr|h[1-6]|a|img|ul|ol|li|table|tr|td|strong|em|b|i|u|span|blockquote|pre|code|section|style)\b[^<>]*>/i.test(s);

/** Plain text becomes paragraphs; HTML is kept as written. */
function toHtml(content: string): string {
  if (looksLikeHtml(content)) return content;
  return content
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Inbox preview text, hidden in the body (padding stops clients from pulling body text into the preview). */
const preheader = (text: string) =>
  `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(text)}${"&#8203;&zwnj;&nbsp;".repeat(80)}</div>\n`;

function buildBody(content: string, media: MediaItem[], contentType: string, preview?: string) {
  const images = media.filter((m) => m.kind === "image");
  if (contentType === "markdown") {
    const md = images.map((m) => `![${(m.alt ?? "").replace(/[[\]]/g, "")}](${m.url})`).join("\n\n");
    return [preview ? preheader(preview) : "", content.trim(), md].filter(Boolean).join("\n\n");
  }
  const imgs = images
    .map((m) => `<p><img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.alt ?? "")}" style="max-width:100%;height:auto"></p>`)
    .join("\n");
  return [preview ? preheader(preview) : "", toHtml(content), imgs].filter(Boolean).join("\n");
}

function slug(s: string) {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "campaign"
  );
}

export const listmonk: Provider = {
  hotlinksMedia: true,
  id: "listmonk",
  name: "Listmonk",
  color: "0055D4",
  icon: "listmonk",
  category: "newsletter",
  auth: "credentials",
  appFields: [],
  docsUrl: "https://listmonk.app/docs/apis/apis/",
  credentialFields: [
    { key: "url", label: "Instance URL", type: "url", required: true, placeholder: "https://lists.example.com" },
    { key: "username", label: "API username", type: "text", required: true, help: "Admin > Users > New API user (listmonk v4+), or an admin login on older versions." },
    {
      key: "token",
      label: "API token",
      type: "password",
      required: true,
      help: "The API user needs permissions for lists, templates and campaigns (get + manage + send).",
    },
  ],
  settingsFields: [
    { key: "subject", label: "Subject", type: "text", required: true, maxLength: 500 },
    { key: "preview", label: "Preview text", type: "text", maxLength: 200, help: "Shown next to the subject in inboxes." },
    { key: "list", label: "List", type: "select", required: true, dynamicOptions: true },
    { key: "extraLists", label: "Additional list IDs", type: "tags", help: "Optional: send to more lists (numeric ids)." },
    { key: "template", label: "Template", type: "select", dynamicOptions: true, default: "" },
    {
      key: "contentType",
      label: "Content format",
      type: "select",
      default: "html",
      options: [
        { value: "html", label: "HTML (plain text is converted to paragraphs)" },
        { value: "markdown", label: "Markdown" },
      ],
    },
    {
      key: "sendMode",
      label: "When published",
      type: "select",
      default: "send",
      options: [
        { value: "send", label: "Send the campaign now" },
        { value: "draft", label: "Create a draft campaign" },
      ],
    },
    { key: "fromEmail", label: "From address", type: "text", placeholder: "Newsletter <news@example.com>", help: "Defaults to the instance setting." },
  ],
  capabilities: {
    maxLength: 1_000_000,
    text: "required",
    media: { images: 20, videos: 0, mixed: false, required: false },
    thread: false,
  },
  async connect(ctx, values) {
    let url: URL;
    try {
      url = new URL(values.url.trim());
    } catch {
      throw new ProviderError("Enter the full instance URL, e.g. https://lists.example.com", "invalid");
    }
    const c = { url: url.origin + url.pathname.replace(/\/+$/, ""), username: values.username.trim(), token: values.token.trim() };
    await api(ctx, c, "/lists", { query: { per_page: 1 } });
    const settings = await api(ctx, c, "/settings").catch(() => null);
    const siteName: string | undefined = settings?.data?.["app.site_name"];
    return [
      {
        externalId: c.url,
        name: siteName || url.host,
        username: url.host,
        avatarUrl: settings?.data?.["app.logo_url"] || null,
        profileUrl: `${c.url}/admin`,
        credentials: c,
      },
    ];
  },
  async options(ctx, account, key) {
    if (key === "list") {
      const res = await api(ctx, creds(account), "/lists", { query: { per_page: "all" } });
      return (res.data?.results ?? []).map((l: any) => ({
        value: String(l.id),
        label: `${l.name}${l.subscriber_count != null ? ` (${l.subscriber_count})` : ""}`,
      }));
    }
    if (key === "template") {
      const res = await api(ctx, creds(account), "/templates");
      const templates = (res.data ?? []).filter((t: any) => !t.type || t.type.startsWith("campaign"));
      return [{ value: "", label: "Default template" }, ...templates.map((t: any) => ({ value: String(t.id), label: t.name }))];
    }
    return [];
  },
  validate(post) {
    const s = post.settings ?? {};
    const extra = Array.isArray(s.extraLists) ? s.extraLists : [];
    return extra.filter((v: unknown) => !/^\d+$/.test(String(v).trim())).map((v: unknown) => `Listmonk: "${v}" is not a list id`);
  },
  async publish(ctx, account, post) {
    const c = creds(account);
    const s = post.settings ?? {};
    const subject = String(s.subject ?? "").trim();
    if (!subject) throw new ProviderError("Listmonk: subject is required", "invalid");
    const lists = [s.list, ...(Array.isArray(s.extraLists) ? s.extraLists : [])]
      .map((v) => Number(String(v ?? "").trim()))
      .filter((n, i, all) => Number.isInteger(n) && n > 0 && all.indexOf(n) === i);
    if (!lists.length) throw new ProviderError("Listmonk: choose a list", "invalid");
    const contentType = s.contentType === "markdown" ? "markdown" : "html";
    const template = Number(s.template);

    const name = `${slug(subject)}-${post.id}`.slice(0, 200);
    // A retried publish must not create (and send) a second campaign: reuse the one named after this post. This
    // lookup is what makes the create and the send safe to retry, so they are not marked `commit: true`; a failed
    // lookup must fail the step (it is retried) rather than risk a second campaign.
    const existing = await api(ctx, c, "/campaigns", { query: { query: name, per_page: 20 } }).then(
      (r) => (r?.data?.results ?? []).find((x: any) => x.name === name) as { id: number; uuid: string; status: string } | undefined,
    );
    const campaign =
      existing ??
      ((
        await api(ctx, c, "/campaigns", {
          method: "POST",
          json: {
            name,
            subject,
            lists,
            type: "regular",
            messenger: "email",
            content_type: contentType,
            body: buildBody(post.content, post.media, contentType, s.preview ? String(s.preview) : undefined),
            from_email: s.fromEmail ? String(s.fromEmail) : undefined,
            template_id: template > 0 ? template : undefined,
          },
        })
      ).data as { id: number; uuid: string; status: string });
    if (s.sendMode !== "draft" && (campaign.status ?? "draft") === "draft")
      await api(ctx, c, `/campaigns/${campaign.id}/status`, { method: "PUT", json: { status: "running" } });
    return {
      status: "published",
      externalId: String(campaign.id),
      url: `${c.url}/admin/campaigns/${campaign.id}`,
      data: { uuid: campaign.uuid },
    };
  },
};
