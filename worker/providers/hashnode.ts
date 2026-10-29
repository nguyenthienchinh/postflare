import { ProviderError } from "./errors";
import { checkedCommit, requestJson } from "./http";
import type { AccountRecord, MetricValues, PostMetricsResult, Provider, ProviderContext } from "./types";

const GQL = "https://gql.hashnode.com";

/**
 * GraphQL call; Hashnode answers 200 with `errors` for most failures (a refusal: nothing created). `commit`: the
 * mutation creates the post or draft (docs/provider-brief.md "Commit semantics").
 */
async function gql<T = any>(ctx: ProviderContext, token: string, query: string, variables: Record<string, unknown> = {}, commit = false): Promise<T> {
  const send = () =>
    requestJson(ctx, GQL, {
      method: "POST",
      headers: { authorization: token },
      json: { query, variables },
      classify: (status, body) => kindFor(body?.errors) ?? (status === 403 ? "auth" : undefined),
      commit,
    });
  const res = await checkedCommit(ctx, send, (res) => {
    if (res?.errors?.length) {
      const kind = kindFor(res.errors) ?? "invalid";
      throw new ProviderError(`Hashnode: ${res.errors[0].message}`, kind, 200, res);
    }
  });
  return res.data as T;
}

function kindFor(errors: any): "auth" | "rate_limit" | undefined {
  const code = errors?.[0]?.extensions?.code;
  if (code === "UNAUTHENTICATED" || code === "FORBIDDEN") return "auth";
  if (code === "TOO_MANY_REQUESTS") return "rate_limit";
  return undefined;
}

const token = (account: AccountRecord) => String(account.credentials.accessToken);
const publicationId = (account: AccountRecord) => String(account.meta.publicationId ?? account.externalId);

export function tagSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

/** Free-text tags → Hashnode tag inputs: existing tags by id, unknown ones by slug + name (Hashnode creates them). */
async function resolveTags(ctx: ProviderContext, tok: string, input: unknown) {
  const names = (Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [])
    .map((t) => String(t).replace(/^#/, "").trim())
    .filter(Boolean);
  const unique = [...new Map(names.map((n) => [tagSlug(n), n])).entries()].filter(([slug]) => slug).slice(0, 5);
  if (!unique.length) return [];
  const query = `query { ${unique.map(([slug], i) => `t${i}: tag(slug: ${JSON.stringify(slug)}) { id slug name }`).join(" ")} }`;
  const found = await gql<Record<string, { id: string } | null>>(ctx, tok, query).catch(() => ({}) as Record<string, null>);
  return unique.map(([slug, name], i) => (found[`t${i}`]?.id ? { id: found[`t${i}`]!.id } : { slug, name }));
}

/** Posts per metrics query (GraphQL aliases `p0..pN` in one request). */
const METRICS_BATCH = 20;

/** Hashnode post → metrics. Comments = top-level responses + their replies. */
function postValues(p: any): MetricValues {
  const out: MetricValues = {};
  if (typeof p.views === "number") out.views = p.views;
  if (typeof p.reactionCount === "number") out.likes = p.reactionCount;
  if (typeof p.responseCount === "number" || typeof p.replyCount === "number") out.comments = (p.responseCount ?? 0) + (p.replyCount ?? 0);
  return out;
}

/** Hashnode blogs via a Personal Access Token. One account per publication. */
export const hashnode: Provider = {
  hotlinksMedia: true,
  id: "hashnode",
  name: "Hashnode",
  color: "2962FF",
  icon: "hashnode",
  category: "blog",
  auth: "credentials",
  appFields: [],
  credentialFields: [
    { key: "token", label: "Personal Access Token", type: "password", required: true, help: "hashnode.com → Settings → Developer → Generate new token." },
  ],
  settingsFields: [
    { key: "title", label: "Title", type: "text", required: true, maxLength: 250 },
    { key: "subtitle", label: "Subtitle", type: "text", maxLength: 250 },
    { key: "tags", label: "Tags", type: "tags", help: "Up to 5 tags, e.g. JavaScript, Web Development." },
    { key: "canonical", label: "Canonical URL", type: "url", help: "Original article URL if this is a republished post." },
    { key: "slug", label: "Slug", type: "text", help: "Defaults to a slug generated from the title." },
    { key: "series", label: "Series", type: "select", dynamicOptions: true },
    { key: "coverFromFirstImage", label: "Use the first image as cover image", type: "checkbox", default: true },
    { key: "enableTableOfContent", label: "Table of contents", type: "checkbox", default: false },
    { key: "delisted", label: "Hide from Hashnode feeds (delisted)", type: "checkbox", default: false },
    { key: "disableComments", label: "Disable comments", type: "checkbox", default: false },
    {
      key: "status",
      label: "Status",
      type: "select",
      default: "publish",
      options: [
        { value: "publish", label: "Publish" },
        { value: "draft", label: "Save as draft" },
      ],
    },
  ],
  capabilities: {
    maxLength: 100_000,
    text: "required",
    media: { images: 10, videos: 0, mixed: false, required: false },
    thread: false,
  },
  docsUrl: "https://hashnode.com/settings/developer",
  setupNotes:
    "No developer app needed. Generate a **Personal Access Token** at hashnode.com → Settings → Developer and paste it when connecting. Every publication (blog) you own becomes a separate account.",

  async connect(ctx, values) {
    const tok = values.token?.trim();
    if (!tok) throw new ProviderError("Personal Access Token is required", "invalid");
    const { me } = await gql(
      ctx,
      tok,
      `query { me { id username name profilePicture publications(first: 50) { edges { node { id title url } } } } }`,
    );
    if (!me?.id) throw new ProviderError("Hashnode rejected the token", "auth");
    const pubs: Array<{ id: string; title: string; url: string }> = (me.publications?.edges ?? []).map((e: any) => e.node);
    if (!pubs.length) throw new ProviderError("This Hashnode user has no publication (blog). Create one on hashnode.com first.", "invalid");
    return pubs.map((p) => ({
      externalId: p.id,
      name: p.title || me.name,
      username: me.username,
      avatarUrl: me.profilePicture ?? null,
      profileUrl: p.url ?? null,
      credentials: { accessToken: tok },
      meta: { publicationId: p.id, publicationUrl: p.url, userId: me.id },
    }));
  },

  validate(post) {
    return post.settings.title?.trim() ? [] : ["Hashnode posts need a title"];
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    const title = String(s.title ?? "").trim();
    if (!title) throw new ProviderError("Hashnode posts need a title", "invalid");
    const tok = token(account);
    const images = post.media.filter((m) => m.kind === "image");
    const useCover = s.coverFromFirstImage !== false && images.length > 0;
    const inline = useCover ? images.slice(1) : images;
    const contentMarkdown = [post.content, ...inline.map((m) => `![${m.alt ?? ""}](${m.url})`)].filter(Boolean).join("\n\n");
    const draft = s.status === "draft";
    const input: Record<string, unknown> = {
      title,
      publicationId: publicationId(account),
      contentMarkdown,
      tags: await resolveTags(ctx, tok, s.tags),
      ...(s.subtitle ? { subtitle: String(s.subtitle) } : {}),
      ...(s.slug ? { slug: String(s.slug) } : {}),
      ...(s.series ? { seriesId: String(s.series) } : {}),
      ...(useCover ? { coverImageOptions: { coverImageURL: images[0].url } } : {}),
      ...(s.canonical ? { originalArticleURL: String(s.canonical) } : {}),
    };
    if (draft) {
      input.settings = { enableTableOfContent: !!s.enableTableOfContent, delist: !!s.delisted, ...(s.slug ? { slugOverridden: true } : {}) };
      const data = await gql(ctx, tok, `mutation($input: CreateDraftInput!) { createDraft(input: $input) { draft { id } } }`, { input }, true);
      const id = data?.createDraft?.draft?.id;
      if (!id) throw new ProviderError("Hashnode did not return the draft", "transient");
      return { status: "published", externalId: id, url: `https://hashnode.com/draft/${id}` };
    }
    input.settings = { enableTableOfContent: !!s.enableTableOfContent, delisted: !!s.delisted, ...(s.slug ? { slugOverridden: true } : {}) };
    if (s.disableComments) input.disableComments = true;
    const data = await gql(ctx, tok, `mutation($input: PublishPostInput!) { publishPost(input: $input) { post { id url } } }`, { input }, true);
    const p = data?.publishPost?.post;
    if (!p?.id) throw new ProviderError("Hashnode did not return the post", "transient");
    return { status: "published", externalId: p.id, url: p.url ?? null };
  },

  async options(ctx, account, key) {
    if (key !== "series") return [];
    const data = await gql(ctx, token(account), `query($id: ObjectId!) { publication(id: $id) { seriesList(first: 50) { edges { node { id name } } } } }`, {
      id: publicationId(account),
    });
    return (data?.publication?.seriesList?.edges ?? []).map((e: any) => ({ value: e.node.id, label: e.node.name }));
  },

  metrics: { post: ["views", "likes", "comments"], account: ["followers", "following", "posts"], batch: METRICS_BATCH },

  async postMetrics(ctx, account, items) {
    const batch = items.slice(0, METRICS_BATCH);
    if (!batch.length) return {};
    // One request for the whole batch; unknown ids (deleted posts, drafts) resolve to null.
    const query = `query { ${batch
      .map((it, i) => `p${i}: post(id: ${JSON.stringify(it.externalId)}) { id views reactionCount responseCount replyCount }`)
      .join(" ")} }`;
    const data = await gql<Record<string, any>>(ctx, token(account), query).catch((err) => {
      // A per-post error (e.g. not found) still comes with partial data: keep it, the failed aliases become null.
      if (err instanceof ProviderError && err.kind === "invalid" && (err.body as any)?.data) return (err.body as any).data as Record<string, any>;
      throw err;
    });
    const out: PostMetricsResult = {};
    batch.forEach((it, i) => {
      const p = data?.[`p${i}`];
      out[it.externalId] = p ? postValues(p) : null;
    });
    return out;
  },

  async accountMetrics(ctx, account) {
    // Followers belong to the Hashnode user (shared by all their publications); posts are the publication's.
    const data = await gql(
      ctx,
      token(account),
      `query($id: ObjectId!) { me { followersCount followingsCount } publication(id: $id) { posts(first: 1) { totalDocuments } } }`,
      { id: publicationId(account) },
    );
    const out: MetricValues = {};
    if (typeof data?.me?.followersCount === "number") out.followers = data.me.followersCount;
    if (typeof data?.me?.followingsCount === "number") out.following = data.me.followingsCount;
    const posts = data?.publication?.posts?.totalDocuments;
    if (typeof posts === "number") out.posts = posts;
    return out;
  },
};
