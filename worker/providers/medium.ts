import { ProviderError } from "./errors";
import { requestJson, type RequestOptions } from "./http";
import type { AccountRecord, Provider, ProviderContext } from "./types";

const API = "https://api.medium.com/v1";

function mediumApi<T = any>(ctx: ProviderContext, tok: string, path: string, opts: RequestOptions = {}) {
  return requestJson<T>(ctx, `${API}${path}`, {
    ...opts,
    token: tok,
    headers: { accept: "application/json", "accept-charset": "utf-8" },
    // 6000-range codes are token problems (6000 invalid, 6001 expired, 6003 revoked).
    classify: (status, body) => {
      const code = Number(body?.errors?.[0]?.code);
      if (status === 401 || (code >= 6000 && code < 6010)) return "auth";
      return undefined;
    },
  });
}

const token = (account: AccountRecord) => String(account.credentials.accessToken);

export function mediumTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const tags = raw.map((t) => String(t).replace(/^#/, "").trim().slice(0, 25)).filter(Boolean);
  return [...new Set(tags)].slice(0, 5);
}

/**
 * Medium via a self-issued integration token (legacy API, write-only).
 * Analytics: not supported. The official API only has /me, /publications and post creation; story stats (views,
 * reads, claps, followers) are only on medium.com, and the API is closed to new integrations, so no metrics here.
 */
export const medium: Provider = {
  hotlinksMedia: true,
  id: "medium",
  name: "Medium",
  color: "000000",
  icon: "medium",
  category: "blog",
  auth: "credentials",
  appFields: [],
  credentialFields: [
    { key: "token", label: "Integration token", type: "password", required: true, help: "medium.com → Settings → Security and apps → Integration tokens." },
  ],
  settingsFields: [
    { key: "title", label: "Title", type: "text", required: true, maxLength: 100 },
    { key: "prependTitle", label: "Show the title as a heading in the post", type: "checkbox", default: true, help: "Medium does not render the title field inside the story itself." },
    { key: "tags", label: "Tags", type: "tags", help: "Up to 5 tags." },
    { key: "canonical", label: "Canonical URL", type: "url", help: "Original URL if this story was first published elsewhere." },
    { key: "publication", label: "Publication", type: "select", dynamicOptions: true, help: "Leave empty to publish on your profile." },
    {
      key: "publishStatus",
      label: "Visibility",
      type: "select",
      default: "public",
      options: [
        { value: "public", label: "Public" },
        { value: "unlisted", label: "Unlisted" },
        { value: "draft", label: "Draft" },
      ],
    },
    {
      key: "license",
      label: "License",
      type: "select",
      default: "all-rights-reserved",
      options: [
        { value: "all-rights-reserved", label: "All rights reserved" },
        { value: "cc-40-by", label: "CC BY 4.0" },
        { value: "cc-40-by-sa", label: "CC BY-SA 4.0" },
        { value: "cc-40-by-nd", label: "CC BY-ND 4.0" },
        { value: "cc-40-by-nc", label: "CC BY-NC 4.0" },
        { value: "cc-40-by-nc-nd", label: "CC BY-NC-ND 4.0" },
        { value: "cc-40-by-nc-sa", label: "CC BY-NC-SA 4.0" },
        { value: "cc-40-zero", label: "CC0" },
        { value: "public-domain", label: "Public domain" },
      ],
    },
    { key: "notifyFollowers", label: "Notify followers", type: "checkbox", default: true },
  ],
  capabilities: {
    maxLength: 100_000,
    text: "required",
    media: { images: 10, videos: 0, mixed: false, required: false },
    thread: false,
  },
  docsUrl: "https://github.com/Medium/medium-api-docs",
  setupNotes:
    "No developer app needed. Paste an **integration token** from medium.com → Settings → Security and apps → Integration tokens.\n\n" +
    "Note: Medium no longer issues new integration tokens and the API is no longer maintained; existing tokens keep working. " +
    "Attached images are inserted into the story as Markdown images (Medium imports them from their URL).",

  async connect(ctx, values) {
    const tok = values.token?.trim();
    if (!tok) throw new ProviderError("Integration token is required", "invalid");
    const { data: me } = await mediumApi(ctx, tok, "/me");
    return [
      {
        externalId: me.id,
        name: me.name || me.username,
        username: me.username,
        avatarUrl: me.imageUrl ?? null,
        profileUrl: me.url ?? `https://medium.com/@${me.username}`,
        credentials: { accessToken: tok },
      },
    ];
  },

  validate(post) {
    return post.settings.title?.trim() ? [] : ["Medium stories need a title"];
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    const title = String(s.title ?? "").trim();
    if (!title) throw new ProviderError("Medium stories need a title", "invalid");
    const images = post.media.filter((m) => m.kind === "image").map((m) => `![${m.alt ?? ""}](${m.url})`);
    const content = [s.prependTitle !== false ? `# ${title}` : "", post.content, ...images].filter(Boolean).join("\n\n");
    const tags = mediumTags(s.tags);
    const path = s.publication ? `/publications/${encodeURIComponent(s.publication)}/posts` : `/users/${encodeURIComponent(account.externalId)}/posts`;
    const { data } = await mediumApi(ctx, token(account), path, {
      method: "POST",
      json: {
        title,
        contentFormat: "markdown",
        content,
        publishStatus: ["public", "draft", "unlisted"].includes(s.publishStatus) ? s.publishStatus : "public",
        ...(tags.length ? { tags } : {}),
        ...(s.canonical ? { canonicalUrl: String(s.canonical) } : {}),
        ...(s.license ? { license: s.license } : {}),
        ...(s.notifyFollowers === false ? { notifyFollowers: false } : {}),
      },
      commit: true,
    });
    return { status: "published", externalId: data.id, url: data.url ?? null };
  },

  async options(ctx, account, key) {
    if (key !== "publication") return [];
    const { data } = await mediumApi(ctx, token(account), `/users/${encodeURIComponent(account.externalId)}/publications`);
    return (data ?? []).map((p: any) => ({ value: p.id, label: p.name }));
  },
};
