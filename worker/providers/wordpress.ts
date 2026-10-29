import { ProviderError } from "./errors";
import { counted, type CountedContext } from "./budget";
import { requestJson, withQuery, type RequestOptions } from "./http";
import { mediaBody } from "./multipart";
import type { AccountRecord, MediaItem, Provider, ProviderContext, PublishPost, PublishResult } from "./types";

interface Site {
  /** "https://site.com/wp-json" or "https://site.com/?rest_route=" (sites without pretty permalinks). */
  apiBase: string;
  auth: string;
}

/** Builds a REST URL for either base style. */
export function wpUrl(apiBase: string, path: string): string {
  if (apiBase.endsWith("rest_route=")) {
    const [p, q] = path.split("?");
    return `${apiBase}${p}${q ? `&${q}` : ""}`;
  }
  return `${apiBase}${path}`;
}

function basic(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

function site(account: AccountRecord): Site {
  const c = account.credentials;
  return { apiBase: String(account.meta.apiBase ?? `${c.siteUrl}/wp-json`), auth: basic(String(c.username), String(c.password)) };
}

function wp<T = any>(ctx: ProviderContext, s: Site, path: string, opts: RequestOptions = {}) {
  return requestJson<T>(ctx, withQuery(wpUrl(s.apiBase, path), opts.query), {
    ...opts,
    query: undefined,
    headers: { authorization: s.auth, accept: "application/json", ...(opts.headers as Record<string, string>) },
    classify: (status, body) => {
      const code = body?.code;
      // WP answers 401 both for bad credentials and for "logged in but not allowed".
      if (typeof code === "string" && code.startsWith("rest_cannot")) return "invalid";
      if (status === 401 || code === "invalid_username" || code === "incorrect_password" || code === "rest_not_logged_in") return "auth";
      return undefined;
    },
  });
}

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(t: string): string {
  return escapeHtml(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
}

/**
 * Minimal Markdown-ish text → HTML: paragraphs, line breaks, #-headings, lists, bold/italic/code/links.
 * Content that already looks like HTML is passed through untouched.
 */
export function toHtml(text: string): string {
  if (/<\/?(p|div|h[1-6]|ul|ol|li|img|br|figure|blockquote|a|strong|em)\b[^>]*>/i.test(text)) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const h = block.match(/^(#{1,6})\s+(.+)$/);
      if (h && !block.includes("\n")) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
      if (lines.every((l) => l.startsWith(">"))) return `<blockquote><p>${lines.map((l) => inline(l.replace(/^>\s?/, ""))).join("<br>")}</p></blockquote>`;
      return `<p>${lines.map(inline).join("<br>\n")}</p>`;
    })
    .join("\n\n");
}

export function slugify(t: string): string {
  return t
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 190);
}

/** Streams a file into the media library (one request: alt text goes in the query, which WordPress reads too). */
async function upload(ctx: ProviderContext, s: Site, item: MediaItem): Promise<{ id: number; source_url: string }> {
  const filename = item.filename.replace(/["\\\r\n]/g, "_") || (item.kind === "video" ? "video.mp4" : "image.jpg");
  return wp(ctx, s, "/wp/v2/media", {
    method: "POST",
    query: { alt_text: item.alt || undefined },
    headers: {
      "content-type": item.mime,
      "content-disposition": `attachment; filename="${filename}"`,
    },
    // Fixed-length stream straight from R2: zero-copy, and sends Content-Length.
    body: await mediaBody(ctx, item),
    // Needed by Node/undici for streamed bodies; ignored by Workers.
    ...({ duplex: "half" } as object),
  });
}

function mediaHtml(m: MediaItem, src: string): string {
  if (m.kind === "video") return `<figure class="wp-block-video"><video controls src="${escapeHtml(src)}"></video></figure>`;
  return `<figure class="wp-block-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(m.alt ?? "")}"/></figure>`;
}

/** Category/tag values: numeric ids pass through; names are looked up and created when missing. */
const termValues = (input: unknown) =>
  (Array.isArray(input) ? input : typeof input === "string" && input ? input.split(",") : []).map((v) => String(v).trim()).filter(Boolean);
/** Names (not ids) cost up to two fetches each: lookup + create. */
const termNames = (input: unknown) => termValues(input).filter((v) => !/^\d+$/.test(v)).length;

async function termIds(ctx: CountedContext, s: Site, taxonomy: "categories" | "tags", input: unknown): Promise<number[]> {
  const ids: number[] = [];
  for (const v of termValues(input)) {
    if (/^\d+$/.test(v)) {
      ids.push(Number(v));
      continue;
    }
    // Keep one fetch for creating the post.
    if (ctx.left() < 3) {
      ctx.log("warn", `WordPress: too many new categories/tags for one request, skipped "${v}"`);
      continue;
    }
    const found = await wp<any[]>(ctx, s, `/wp/v2/${taxonomy}`, { query: { search: v, per_page: 100 } }).catch(() => []);
    const match = (found ?? []).find((t) => t.name?.toLowerCase() === v.toLowerCase() || t.slug === slugify(v));
    if (match) {
      ids.push(match.id);
      continue;
    }
    try {
      const created = await wp(ctx, s, `/wp/v2/${taxonomy}`, { method: "POST", json: { name: v } });
      ids.push(created.id);
    } catch (err) {
      // term_exists carries the existing id; otherwise skip the term (no permission to create it).
      const existing = (err as ProviderError).body as any;
      if (existing?.data?.term_id) ids.push(existing.data.term_id);
      else ctx.log("warn", `WordPress: could not create ${taxonomy === "tags" ? "tag" : "category"} "${v}": ${(err as Error).message}`);
    }
  }
  return [...new Set(ids)];
}

/** Publish progress: uploads continue in checkStatus when one call's subrequest budget runs out. */
interface WpState {
  [key: string]: unknown;
  post: PublishPost;
  title: string;
  type: string;
  /** Media still to upload. */
  queue: Array<{ item: MediaItem; featured?: boolean }>;
  featured?: number;
  blocks: string[];
}

async function advancePost(ctx: CountedContext, account: AccountRecord, state: WpState): Promise<PublishResult> {
  const s = site(account);
  const st = state.post.settings;
  const { title, type } = state;
  const pending = (): PublishResult => ({ status: "pending", state, retryAfterSeconds: 5 });
  // One fetch per upload; one kept for the post.
  while (state.queue.length) {
    if (ctx.left() < 2) return pending();
    const { item, featured } = state.queue[0];
    const media = await upload(ctx, s, item);
    if (featured) state.featured = media.id;
    else state.blocks.push(mediaHtml(item, media.source_url));
    state.queue.shift();
  }
  const isPost = type === "posts";
  // New terms need a lookup and maybe a create each: start them with a fresh budget when they do not fit.
  const termCost = isPost ? 2 * (termNames(st.categories) + termNames(st.tags)) : 0;
  if (termCost + 1 > ctx.left() && ctx.used > 0) return pending();
  const categories = isPost ? await termIds(ctx, s, "categories", st.categories) : [];
  const tags = isPost ? await termIds(ctx, s, "tags", st.tags) : [];
  const res = await wp(ctx, s, `/wp/v2/${type}`, {
    method: "POST",
    json: {
      title,
      content: [toHtml(state.post.content), ...state.blocks].filter(Boolean).join("\n\n"),
      status: ["publish", "draft", "pending", "private"].includes(st.status) ? st.status : "publish",
      slug: st.slug ? slugify(String(st.slug)) : slugify(title),
      ...(st.excerpt ? { excerpt: String(st.excerpt) } : {}),
      ...(state.featured ? { featured_media: state.featured } : {}),
      ...(categories.length ? { categories } : {}),
      ...(tags.length ? { tags } : {}),
      ...(isPost && st.sticky ? { sticky: true } : {}),
      ...(st.commentStatus ? { comment_status: st.commentStatus } : {}),
    },
    // Creating the post is the commit; media uploads above are invisible until it references them.
    commit: true,
  });
  return { status: "published", externalId: String(res.id), url: res.link ?? null };
}

/** Self-hosted WordPress (and any site with the REST API + Application Passwords). */
export const wordpress: Provider = {
  id: "wordpress",
  name: "WordPress",
  color: "21759B",
  icon: "wordpress",
  category: "blog",
  auth: "credentials",
  appFields: [],
  credentialFields: [
    { key: "siteUrl", label: "Site URL", type: "url", required: true, placeholder: "https://myblog.com" },
    { key: "username", label: "Username", type: "text", required: true },
    {
      key: "password",
      label: "Application password",
      type: "password",
      required: true,
      help: "WP Admin → Users → Profile → Application Passwords. Not your login password.",
    },
  ],
  settingsFields: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "postType", label: "Post type", type: "select", dynamicOptions: true, default: "posts" },
    {
      key: "status",
      label: "Status",
      type: "select",
      default: "publish",
      options: [
        { value: "publish", label: "Published" },
        { value: "draft", label: "Draft" },
        { value: "pending", label: "Pending review" },
        { value: "private", label: "Private" },
      ],
    },
    { key: "categories", label: "Categories", type: "tags", dynamicOptions: true, help: "Category names or ids.", showIf: { key: "postType", equals: "posts" } },
    { key: "tags", label: "Tags", type: "tags", dynamicOptions: true, help: "Missing tags are created.", showIf: { key: "postType", equals: "posts" } },
    { key: "excerpt", label: "Excerpt", type: "textarea" },
    { key: "slug", label: "Slug", type: "text", help: "Defaults to the title." },
    { key: "featuredFromFirstImage", label: "Use the first image as featured image", type: "checkbox", default: true },
    { key: "sticky", label: "Sticky post", type: "checkbox", default: false, showIf: { key: "postType", equals: "posts" } },
    {
      key: "commentStatus",
      label: "Comments",
      type: "select",
      default: "",
      options: [
        { value: "", label: "Site default" },
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
      ],
    },
  ],
  capabilities: {
    maxLength: 1_000_000,
    text: "required",
    media: { images: 20, videos: 5, mixed: true, required: false },
    thread: false,
  },
  docsUrl: "https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/",
  setupNotes:
    "No developer app needed. In WP Admin open **Users → Profile → Application Passwords**, create one and connect with your site URL, username and that password. " +
    "The site must use HTTPS and the REST API must be reachable (some security plugins block it or strip the Authorization header). " +
    "Plain text is converted to simple HTML paragraphs; HTML content is sent as is. The first image becomes the featured image, the others are appended to the content.",

  async connect(ctx, values) {
    let url: URL;
    try {
      url = new URL(values.siteUrl.trim());
    } catch {
      throw new ProviderError("Site URL is not a valid URL", "invalid");
    }
    if (url.protocol !== "https:") throw new ProviderError("Site URL must use https (Application Passwords require it)", "invalid");
    const siteUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    const auth = basic(values.username.trim(), values.password.trim());
    let apiBase = `${siteUrl}/wp-json`;
    let me: any;
    try {
      me = await wp(ctx, { apiBase, auth }, "/wp/v2/users/me", { query: { context: "edit" } });
    } catch (err) {
      if (!(err instanceof ProviderError) || err.status !== 404) throw err;
      apiBase = `${siteUrl}/?rest_route=`;
      me = await wp(ctx, { apiBase, auth }, "/wp/v2/users/me", { query: { context: "edit" } });
    }
    if (!me?.id) throw new ProviderError("WordPress did not return the user: is the REST API enabled?", "invalid");
    const info = await wp(ctx, { apiBase, auth }, "/").catch(() => ({}) as any);
    const avatars = Object.entries((me.avatar_urls ?? {}) as Record<string, string>).sort((a, b) => Number(b[0]) - Number(a[0]));
    return [
      {
        externalId: `${siteUrl}#${me.id}`,
        name: info?.name || url.host,
        username: me.slug || values.username.trim(),
        avatarUrl: avatars[0]?.[1] ?? null,
        profileUrl: info?.url || siteUrl,
        credentials: { siteUrl, username: values.username.trim(), password: values.password.trim() },
        meta: { apiBase, userId: me.id },
      },
    ];
  },

  validate(post) {
    return post.settings.title?.trim() ? [] : ["WordPress posts need a title"];
  },

  async publish(ctx, account, post) {
    const st = post.settings;
    const title = String(st.title ?? "").trim();
    if (!title) throw new ProviderError("WordPress posts need a title", "invalid");
    const type = String(st.postType || "posts").replace(/[^a-z0-9_-]/gi, "");

    const first = st.featuredFromFirstImage !== false ? post.media.findIndex((m) => m.kind === "image") : -1;
    // The featured image goes first; the rest become blocks in order.
    const queue = first < 0 ? post.media.map((item) => ({ item })) : [{ item: post.media[first], featured: true }, ...post.media.filter((_, i) => i !== first).map((item) => ({ item }))];
    return advancePost(counted(ctx), account, { post: { ...post, media: [] }, title, type, queue, blocks: [] });
  },

  checkStatus(ctx, account, state) {
    return advancePost(counted(ctx), account, state as WpState);
  },

  async options(ctx, account, key) {
    const s = site(account);
    if (key === "postType") {
      const types = await wp<Record<string, any>>(ctx, s, "/wp/v2/types");
      return Object.entries(types ?? {})
        .filter(([k, v]) => k !== "attachment" && !k.startsWith("wp_") && !k.startsWith("nav_") && v?.rest_base)
        .map(([, v]) => ({ value: v.rest_base, label: v.name }));
    }
    if (key === "categories" || key === "tags") {
      const terms = await wp<any[]>(ctx, s, `/wp/v2/${key}`, { query: { per_page: 100, orderby: "count", order: "desc" } });
      return (terms ?? []).map((t) => ({ value: String(t.id), label: t.name }));
    }
    return [];
  },
};
