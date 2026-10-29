import { ProviderError } from "./errors";
import { request, requestJson, type RequestOptions } from "./http";
import { mediaBody } from "./multipart";
import type { AccountRecord, MediaItem, Provider, ProviderContext } from "./types";

const API = "https://api2.skool.com";

const cookie = (c: Record<string, unknown>) => `auth_token=${c.auth_token}; client_id=${c.client_id}`;

/** Skool has no public API: this uses the web app's API with the browser session cookies (as Postiz does). */
function skoolApi<T = any>(ctx: ProviderContext, cookies: string, path: string, opts: RequestOptions = {}) {
  return requestJson<T>(ctx, `${API}${path}`, {
    ...opts,
    headers: { cookie: cookies, origin: "https://www.skool.com", referer: "https://www.skool.com/", ...(opts.headers as Record<string, string>) },
    classify: (status, body) => {
      const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
      if (status === 401) return "auth";
      if (/must be admin or level|cannot post to this label/.test(text)) return "invalid";
      return undefined;
    },
  });
}

const cookiesOf = (account: AccountRecord) => cookie(account.credentials);

/** Creates a file record, then streams the bytes to the signed S3 URL. Returns the file id. */
async function uploadFile(ctx: ProviderContext, account: AccountRecord, item: MediaItem): Promise<string> {
  const rec = await skoolApi(ctx, cookiesOf(account), "/files", {
    method: "POST",
    json: {
      file_name: item.filename || (item.kind === "video" ? "video.mp4" : "image.jpg"),
      content_type: item.mime,
      content_length: item.size,
      content_disposition: "",
      ref: "",
      owner_id: account.externalId,
      large_thumbnail: false,
    },
  });
  if (!rec?.write_url || !rec?.file?.id) throw new ProviderError("Skool did not return an upload URL", "transient");
  await request(ctx, rec.write_url, {
    method: "PUT",
    headers: {
      "content-type": rec.content_type || item.mime,
      ...(rec.acl ? { "x-amz-acl": rec.acl } : {}),
    },
    // Fixed-length stream straight from R2: zero-copy, and sends Content-Length.
    body: await mediaBody(ctx, item),
    ...({ duplex: "half" } as object),
  });
  return String(rec.file.id);
}

async function attachments(ctx: ProviderContext, account: AccountRecord, media: MediaItem[]): Promise<string> {
  const ids: string[] = [];
  for (const m of media) ids.push(await uploadFile(ctx, account, m));
  return ids.join(",");
}

async function groupSlug(ctx: ProviderContext, account: AccountRecord, groupId: string): Promise<string | null> {
  const g = await skoolApi(ctx, cookiesOf(account), `/groups/${encodeURIComponent(groupId)}`).catch(() => null);
  return g?.name ?? null;
}

export const skool: Provider = {
  id: "skool",
  name: "Skool",
  color: "F8D24B",
  category: "community",
  auth: "credentials",
  status: "experimental",
  statusNote: "Uses Skool's unofficial, cookie-based API; may break and may conflict with Skool's terms",
  appFields: [],
  credentialFields: [
    { key: "auth_token", label: "auth_token cookie", type: "password", required: true },
    { key: "client_id", label: "client_id cookie", type: "password", required: true },
  ],
  settingsFields: [
    { key: "group", label: "Community", type: "select", dynamicOptions: true, required: true },
    { key: "label", label: "Category", type: "select", dynamicOptions: true, default: "none", help: "Community category (label) for the post." },
    { key: "title", label: "Title", type: "text", required: true, maxLength: 300 },
  ],
  capabilities: {
    maxLength: 5000,
    text: "required",
    media: { images: 10, videos: 1, mixed: true, required: false },
    thread: true,
    threadLabel: "Comments",
  },
  docsUrl: "https://www.skool.com",
  setupNotes:
    "**Unofficial API, may break.** Skool has no public API; Postflare uses the web app's internal API with your session cookies.\n\n" +
    "1. Log in on www.skool.com in your browser.\n" +
    "2. Open DevTools → Application → Cookies → `https://www.skool.com` and copy the `auth_token` and `client_id` values.\n" +
    "3. Paste them when connecting. Reconnect when Skool logs the session out.",

  async connect(ctx, values) {
    const creds = { auth_token: values.auth_token?.trim(), client_id: values.client_id?.trim() };
    if (!creds.auth_token || !creds.client_id) throw new ProviderError("Both the auth_token and client_id cookies are required", "invalid");
    const me = await skoolApi(ctx, cookie(creds), "/self");
    if (!me?.id) throw new ProviderError("Skool rejected the cookies", "auth");
    return [
      {
        externalId: String(me.id),
        name: [me.first_name, me.last_name].filter(Boolean).join(" ") || me.name,
        username: me.name ?? null,
        avatarUrl: me.metadata?.picture_profile || null,
        profileUrl: me.name ? `https://www.skool.com/@${me.name}` : null,
        credentials: creds,
      },
    ];
  },

  validate(post) {
    const errors: string[] = [];
    if (!post.settings.group) errors.push("Choose a Skool community");
    if (!post.settings.title?.trim()) errors.push("Skool posts need a title");
    return errors;
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    if (!s.group) throw new ProviderError("Choose a Skool community", "invalid");
    if (!s.title?.trim()) throw new ProviderError("Skool posts need a title", "invalid");
    const files = await attachments(ctx, account, post.media);
    const res = await skoolApi(ctx, cookiesOf(account), "/posts", {
      method: "POST",
      query: { follow: "true" },
      json: {
        post_type: "generic",
        group_id: s.group,
        metadata: {
          title: String(s.title).trim(),
          content: post.content,
          attachments: files,
          ...(s.label && s.label !== "none" ? { labels: s.label } : {}),
          action: 0,
          video_ids: "",
        },
      },
      commit: true,
    });
    const slug = await groupSlug(ctx, account, s.group);
    return {
      status: "published",
      externalId: String(res.id),
      url: slug && res.name ? `https://www.skool.com/${slug}/${res.name}` : null,
      data: { group: s.group, slug, name: res.name },
    };
  },

  async reply(ctx, account, target, post) {
    const group = String(target.rootData?.group ?? post.settings.group);
    const files = await attachments(ctx, account, post.media);
    const res = await skoolApi(ctx, cookiesOf(account), "/posts", {
      method: "POST",
      query: { follow: "true" },
      json: {
        post_type: "comment",
        group_id: group,
        root_id: target.rootId,
        parent_id: target.parentId,
        metadata: { title: "", content: post.content, attachments: files, action: 0, video_ids: "" },
      },
      commit: true,
    });
    const slug = target.rootData?.slug;
    const name = target.rootData?.name;
    return { externalId: String(res.id), url: slug && name ? `https://www.skool.com/${slug}/${name}` : null, urlIsPost: true };
  },

  async options(ctx, account, key, settings) {
    const c = cookiesOf(account);
    if (key === "group") {
      const { groups } = await skoolApi(ctx, c, `/users/${encodeURIComponent(account.externalId)}/groups`, { query: { offset: 0, limit: 30 } });
      return (groups ?? []).map((g: any) => ({ value: String(g.id), label: g.metadata?.display_name || g.name }));
    }
    if (key === "label") {
      const fallback = [{ value: "none", label: "Default" }];
      if (!settings.group) return fallback;
      const group = await skoolApi(ctx, c, `/groups/${encodeURIComponent(String(settings.group))}`);
      const ids = String(group?.metadata?.labels ?? "").split(",").filter(Boolean);
      if (!ids.length) return fallback;
      const labels = await Promise.all(ids.map((id) => skoolApi(ctx, c, `/labels/${encodeURIComponent(id)}`).catch(() => null)));
      return labels.filter((l) => l?.id).map((l: any) => ({ value: String(l.id), label: l.metadata?.display_name || String(l.id) }));
    }
    return [];
  },
};
