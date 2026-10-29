import { fetchesLeft } from "./budget";
import { ProviderError, type ProviderErrorKind } from "./errors";
import { requestJson, type RequestOptions } from "./http";
import { mediaPart, streamBody, streamingMultipart } from "./multipart";
import type { AccountRecord, CredentialsUpdate, MediaItem, MetricValues, PostMetricsResult, Provider, ProviderContext } from "./types";

/** Lemmy JWTs do not expire on their own; re-login weekly so a revoked session heals before a post. */
const SESSION_MS = 7 * 24 * 3600 * 1000;

// Lemmy errors: 400 { error: "not_logged_in" | "incorrect_login" | "rate_limit_error" | ... }.
const classify = (status: number, body: any): ProviderErrorKind | undefined => {
  const e = String(body?.error ?? "");
  if (status === 401 || ["not_logged_in", "incorrect_login", "incorrect_totp_token", "missing_totp_token"].includes(e)) return "auth";
  if (e === "rate_limit_error") return "rate_limit";
  return undefined;
};

function instanceUrl(raw: string): string {
  const v = (raw || "").trim().replace(/\/+$/, "");
  return new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).origin;
}

async function login(ctx: ProviderContext, instance: string, username: string, password: string): Promise<string> {
  const res = await requestJson<{ jwt?: string }>(ctx, `${instance}/api/v3/user/login`, {
    method: "POST",
    json: { username_or_email: username, password },
    classify,
  });
  if (!res?.jwt) throw new ProviderError("Lemmy login returned no token (email not verified or registration pending?)", "auth");
  return res.jwt;
}

const instance = (account: AccountRecord) => account.meta.instance as string;

/** Authenticated call; on an auth error re-login once with the stored credentials. */
async function call<T = any>(ctx: ProviderContext, account: AccountRecord, path: string, opts: RequestOptions = {}): Promise<T> {
  const run = (jwt: string) => requestJson<T>(ctx, `${instance(account)}${path}`, { ...opts, token: jwt, classify });
  try {
    return await run(account.credentials.accessToken as string);
  } catch (err) {
    const { username, password } = account.credentials as { username?: string; password?: string };
    if (!(err instanceof ProviderError && err.kind === "auth") || !username || !password) throw err;
    const jwt = await login(ctx, instance(account), username, password);
    account.credentials.accessToken = jwt;
    return run(jwt);
  }
}

async function communityId(ctx: ProviderContext, account: AccountRecord, settings: Record<string, any>): Promise<number> {
  const name = String(settings.communityName ?? "").trim().replace(/^!/, "");
  if (name) {
    const res = await call(ctx, account, "/api/v3/community", { query: { name } }).catch((err) => {
      if (err instanceof ProviderError && err.kind === "invalid") throw new ProviderError(`Lemmy community "${name}" not found`, "invalid");
      throw err;
    });
    return res.community_view.community.id;
  }
  const id = Number(settings.community);
  if (!id) throw new ProviderError("Choose a Lemmy community", "invalid");
  return id;
}

async function uploadImage(ctx: ProviderContext, account: AccountRecord, item: MediaItem): Promise<string> {
  // Streamed from R2 into the multipart body (no copy into memory).
  const mp = streamingMultipart([mediaPart(ctx, "images[]", item)]);
  const jwt = account.credentials.accessToken as string;
  const res = await requestJson<any>(ctx, `${instance(account)}/pictrs/image`, {
    ...streamBody(mp.body, mp.contentType),
    token: jwt,
    // Older Lemmy versions only read the jwt cookie on the pict-rs proxy.
    headers: { "content-type": mp.contentType, cookie: `jwt=${jwt}` },
    classify,
  });
  const file = res?.files?.[0]?.file;
  if (res?.msg !== "ok" || !file) throw new ProviderError(`Lemmy image upload failed: ${res?.msg ?? "unknown error"}`, "invalid", undefined, res);
  return `${instance(account)}/pictrs/image/${file}`;
}

/** Lemmy answers an unknown post with 404 (0.19) or 400 `couldnt_find_post` (older). */
const notFound = (err: unknown) =>
  err instanceof ProviderError && (err.status === 404 || ["couldnt_find_post", "not_found"].includes(String((err.body as any)?.error ?? "")));

/** One post's vote and comment counts; null when it is gone (unknown, deleted or removed). */
async function postCounts(ctx: ProviderContext, account: AccountRecord, id: string): Promise<MetricValues | null> {
  let res: any;
  try {
    res = await call(ctx, account, "/api/v3/post", { query: { id } });
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
  const pv = res?.post_view;
  const c = pv?.counts;
  if (!c || pv.post?.deleted || pv.post?.removed) return null;
  const out: MetricValues = { extra: {} };
  // Upvotes are the likes; score (= up - down) and downvotes stay platform-specific.
  if (typeof c.upvotes === "number") out.likes = c.upvotes;
  if (typeof c.comments === "number") out.comments = c.comments;
  if (typeof c.score === "number") out.extra!.score = c.score;
  if (typeof c.downvotes === "number") out.extra!.downvotes = c.downvotes;
  return out;
}

export const lemmy: Provider = {
  id: "lemmy",
  name: "Lemmy",
  color: "00BC8C",
  icon: "lemmy",
  category: "community",
  auth: "credentials",
  appFields: [],
  setupNotes:
    "No developer app needed. Connect with your instance URL, username and password. The password is stored encrypted and used to renew the session. Accounts with two-factor authentication are not supported.",
  credentialFields: [
    { key: "instance", label: "Instance URL", type: "url", required: true, default: "https://lemmy.world", placeholder: "https://lemmy.world" },
    { key: "username", label: "Username or email", type: "text", required: true },
    { key: "password", label: "Password", type: "password", required: true },
  ],
  settingsFields: [
    { key: "community", label: "Community", type: "select", dynamicOptions: true, help: "Communities you are subscribed to." },
    { key: "communityName", label: "…or community name", type: "text", placeholder: "technology@lemmy.world", help: "Overrides the list above." },
    { key: "title", label: "Title", type: "text", required: true, maxLength: 200 },
    { key: "url", label: "Link URL", type: "url" },
    { key: "nsfw", label: "NSFW", type: "checkbox", default: false },
  ],
  capabilities: {
    maxLength: 10_000,
    text: "optional",
    media: { images: 1, videos: 0, mixed: false, required: false },
    thread: true,
    threadLabel: "Comments",
  },

  validate(post) {
    const errors: string[] = [];
    const title = String(post.settings.title ?? "").trim();
    if (!title) errors.push("Lemmy posts need a title");
    else if (title.length > 200) errors.push("Lemmy titles are limited to 200 characters");
    if (!post.settings.community && !String(post.settings.communityName ?? "").trim()) errors.push("Choose a Lemmy community");
    return errors;
  },

  async connect(ctx, values) {
    const inst = instanceUrl(values.instance);
    const username = values.username.trim();
    const jwt = await login(ctx, inst, username, values.password);
    const site = await requestJson<any>(ctx, `${inst}/api/v3/site`, { token: jwt, classify });
    const person = site?.my_user?.local_user_view?.person;
    if (!person) throw new ProviderError("Lemmy did not return the logged-in user", "auth");
    const host = new URL(inst).host;
    return [
      {
        externalId: `${person.id}@${host}`,
        name: person.display_name || person.name,
        username: `${person.name}@${host}`,
        avatarUrl: person.avatar ?? null,
        profileUrl: person.actor_id ?? `${inst}/u/${person.name}`,
        credentials: { accessToken: jwt, username, password: values.password },
        expiresAt: Date.now() + SESSION_MS,
        meta: { instance: inst, personId: person.id },
      },
    ];
  },

  async refresh(ctx, account): Promise<CredentialsUpdate> {
    const { username, password } = account.credentials as { username?: string; password?: string };
    if (!username || !password) throw new ProviderError("Lemmy credentials missing, reconnect the account", "auth");
    const jwt = await login(ctx, instance(account), username, password);
    return { credentials: { ...account.credentials, accessToken: jwt }, expiresAt: Date.now() + SESSION_MS };
  },

  async options(ctx, account, key) {
    if (key !== "community") return [];
    const res = await call(ctx, account, "/api/v3/community/list", { query: { type_: "Subscribed", sort: "Active", limit: 50 } });
    return (res?.communities ?? []).map((c: any) => {
      const host = new URL(c.community.actor_id).host;
      return { value: String(c.community.id), label: `${c.community.title || c.community.name} (${c.community.name}@${host})` };
    });
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    const title = String(s.title ?? "").trim();
    if (!title) throw new ProviderError("Lemmy posts need a title", "invalid");
    const body: Record<string, unknown> = { name: title, community_id: await communityId(ctx, account, s), nsfw: !!s.nsfw };
    if (post.content?.trim()) body.body = post.content;
    const link = String(s.url ?? "").trim();
    const img = post.media.find((m) => m.kind === "image");
    const imageUrl = img ? await uploadImage(ctx, account, img) : null;
    if (link) {
      body.url = /^https?:\/\//.test(link) ? link : `https://${link}`;
      if (imageUrl) body.custom_thumbnail = imageUrl;
    } else if (imageUrl) body.url = imageUrl;
    const res = await call(ctx, account, "/api/v3/post", { method: "POST", json: body, commit: true });
    const id = String(res.post_view.post.id);
    return { status: "published", externalId: id, url: `${instance(account)}/post/${id}` };
  },

  async reply(ctx, account, target, post) {
    let content = post.content ?? "";
    const img = post.media.find((m) => m.kind === "image");
    if (img) content = `${content}\n\n![${img.alt ?? ""}](${await uploadImage(ctx, account, img)})`.trim();
    const res = await call(ctx, account, "/api/v3/comment", { method: "POST", json: { post_id: Number(target.rootId), content }, commit: true });
    const id = String(res.comment_view.comment.id);
    return { externalId: id, url: `${instance(account)}/comment/${id}` };
  },

  // No batch endpoint: one `/api/v3/post?id=` per post, within the fetch budget. Lemmy has no followers.
  metrics: { post: ["likes", "comments"], account: ["posts"], batch: 10 },

  async postMetrics(ctx, account, items) {
    const todo = items.slice(0, Math.max(0, fetchesLeft(ctx)));
    const out: PostMetricsResult = {};
    // Sequential: `call` may re-login once and update the stored token for the next requests.
    for (const it of todo) {
      if (fetchesLeft(ctx) <= 0) break;
      out[it.externalId] = await postCounts(ctx, account, it.externalId);
    }
    return out;
  },

  async accountMetrics(ctx, account) {
    // limit=1 keeps the posts/comments lists that come with the person small.
    const res = await call(ctx, account, "/api/v3/user", { query: { person_id: account.meta.personId as number, limit: 1 } });
    const c = res?.person_view?.counts ?? {};
    const out: MetricValues = {};
    if (typeof c.post_count === "number") out.posts = c.post_count;
    if (typeof c.comment_count === "number") out.extra = { comment_count: c.comment_count };
    return out;
  },
};
