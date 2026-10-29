import { fetchesLeft } from "./budget";
import { ProviderError } from "./errors";
import { requestJson, type RequestOptions } from "./http";
import type { AccountRecord, MediaItem, PostMetricsResult, Provider, ProviderContext } from "./types";

const API = "https://dev.to/api";

function devApi<T = any>(ctx: ProviderContext, apiKey: string, path: string, opts: RequestOptions = {}) {
  return requestJson<T>(ctx, `${API}${path}`, {
    ...opts,
    headers: { "api-key": apiKey, accept: "application/vnd.forem.api-v1+json", ...(opts.headers as Record<string, string>) },
  });
}

const key = (account: AccountRecord) => String(account.credentials.apiKey ?? account.credentials.accessToken);

/** DEV tags: lowercase alphanumerics only, max 4. */
export function devtoTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const tags = raw.map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
  return [...new Set(tags)].slice(0, 4);
}

/** Articles per page when reading stats (the list includes article bodies, so keep pages small for CPU). */
const STATS_PAGE = 30;
/** Keep paging this far past the oldest requested article's publish date before calling the rest missing. */
const STATS_SLACK_MS = 7 * 24 * 3600 * 1000;

const mdImage = (m: MediaItem) => `![${(m.alt ?? "").replace(/[[\]]/g, "")}](${m.url})`;

/** DEV.to (Forem) articles via the API key from Settings > Extensions. */
export const devto: Provider = {
  hotlinksMedia: true,
  id: "devto",
  name: "DEV",
  color: "0A0A0A",
  icon: "devdotto",
  category: "blog",
  auth: "credentials",
  appFields: [],
  credentialFields: [
    { key: "apiKey", label: "API key", type: "password", required: true, help: "Create one at dev.to → Settings → Extensions → DEV Community API Keys." },
  ],
  settingsFields: [
    { key: "title", label: "Title", type: "text", required: true, maxLength: 250 },
    { key: "description", label: "Description", type: "textarea", help: "Short summary shown in feeds and social previews." },
    { key: "tags", label: "Tags", type: "tags", help: "Up to 4 tags (letters and numbers only)." },
    { key: "canonical", label: "Canonical URL", type: "url", placeholder: "https://myblog.com/original-post" },
    { key: "series", label: "Series", type: "text", help: "Articles with the same series name are grouped together." },
    { key: "organization", label: "Organization", type: "select", dynamicOptions: true, help: "Publish under an organization you belong to." },
    { key: "coverFromFirstImage", label: "Use the first image as cover image", type: "checkbox", default: true },
    { key: "published", label: "Publish immediately (unchecked = save as draft)", type: "checkbox", default: true },
  ],
  capabilities: {
    maxLength: 100_000,
    text: "required",
    media: { images: 10, videos: 0, mixed: false, required: false },
    thread: false,
  },
  docsUrl: "https://dev.to/settings/extensions",
  setupNotes: "No developer app needed. Generate an API key on dev.to under **Settings → Extensions → DEV Community API Keys** and paste it when connecting.",

  async connect(ctx, values) {
    const apiKey = values.apiKey?.trim();
    if (!apiKey) throw new ProviderError("API key is required", "invalid");
    const me = await devApi(ctx, apiKey, "/users/me");
    return [
      {
        externalId: String(me.id),
        name: me.name || me.username,
        username: me.username,
        avatarUrl: me.profile_image ?? null,
        profileUrl: `https://dev.to/${me.username}`,
        credentials: { apiKey },
      },
    ];
  },

  validate(post) {
    return post.settings.title?.trim() ? [] : ["DEV articles need a title"];
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    const title = String(s.title ?? "").trim();
    if (!title) throw new ProviderError("DEV articles need a title", "invalid");
    const images = post.media.filter((m) => m.kind === "image");
    const useCover = s.coverFromFirstImage !== false && images.length > 0;
    const inline = useCover ? images.slice(1) : images;
    const body = [post.content, ...inline.map(mdImage)].filter(Boolean).join("\n\n");
    const tags = devtoTags(s.tags);
    const article: Record<string, unknown> = {
      title,
      body_markdown: body,
      published: s.published !== false,
      ...(tags.length ? { tags } : {}),
      ...(useCover ? { main_image: images[0].url } : {}),
      ...(s.canonical ? { canonical_url: String(s.canonical) } : {}),
      ...(s.series ? { series: String(s.series) } : {}),
      ...(s.description ? { description: String(s.description) } : {}),
      ...(s.organization ? { organization_id: Number(s.organization) } : {}),
    };
    const res = await devApi(ctx, key(account), "/articles", { method: "POST", json: { article }, commit: true });
    return { status: "published", externalId: String(res.id), url: res.url ?? null };
  },

  async options(ctx, account, k) {
    if (k !== "organization") return [];
    // The API has no "my organizations" endpoint: derive them from the user's articles (as Postiz does).
    const articles = await devApi<any[]>(ctx, key(account), "/articles/me/all", { query: { per_page: 1000 } });
    const usernames = [...new Set((articles ?? []).map((a) => a?.organization?.username).filter(Boolean))] as string[];
    const orgs = await Promise.all(usernames.map((u) => devApi(ctx, key(account), `/organizations/${encodeURIComponent(u)}`).catch(() => null)));
    return orgs.filter((o) => o?.id).map((o) => ({ value: String(o.id), label: o.name || o.username }));
  },

  // Stats of own articles only come from `/articles/me/published` (page_views_count is not in the public article).
  metrics: { post: ["views", "likes", "comments"], account: [], batch: STATS_PAGE },

  async postMetrics(ctx, account, items) {
    const want = new Set(items.map((it) => it.externalId));
    const out: PostMetricsResult = {};
    // Newest first: page back until every id is found or the page is older than the oldest requested article.
    const oldest = Math.min(...items.map((it) => it.publishedAt)) - STATS_SLACK_MS;
    for (let page = 1; want.size && fetchesLeft(ctx) > 0; page++) {
      const list = await devApi<any[]>(ctx, key(account), "/articles/me/published", { query: { per_page: STATS_PAGE, page } });
      for (const a of list ?? []) {
        const id = String(a?.id);
        if (!want.delete(id)) continue;
        out[id] = { views: a.page_views_count ?? 0, likes: a.public_reactions_count ?? a.positive_reactions_count ?? 0, comments: a.comments_count ?? 0 };
      }
      const last = list?.[list.length - 1];
      const lastAt = Date.parse(last?.published_at ?? "");
      if (!list || list.length < STATS_PAGE || (lastAt && lastAt < oldest)) {
        // Reached the end (or past the dates we look for): the rest is unpublished or deleted.
        for (const id of want) out[id] = null;
        break;
      }
    }
    return out;
  },
};
