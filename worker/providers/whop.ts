import { ProviderError } from "./errors";
import { counted, type CountedContext } from "./budget";
import { expiresAt, request, requestJson, requireApp, sleep, type RequestOptions } from "./http";
import { mediaBody } from "./multipart";
import type { AccountRecord, ConnectedAccount, MediaItem, Provider, ProviderContext } from "./types";

const BASE = "https://api.whop.com";
const SCOPES = ["openid", "profile", "email", "forum:post:create", "forum:read", "company:basic:read"];
/** How long publish waits for uploaded files to become ready before handing over to checkStatus. */
const INLINE_WAIT_MS = 20_000;

const classify: RequestOptions["classify"] = (status, body) => {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (status === 401 || /invalid_grant|invalid_token|insufficient_scope/.test(text)) return "auth";
  return undefined;
};

function whopApi<T = any>(ctx: ProviderContext, tok: string, path: string, opts: RequestOptions = {}) {
  return requestJson<T>(ctx, `${BASE}/api/v1${path}`, { ...opts, token: tok, classify });
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>) {
  const app = requireApp(ctx, "Whop", "clientId");
  return requestJson(ctx, `${BASE}/oauth/token`, {
    method: "POST",
    headers: { accept: "application/json" },
    json: { ...params, client_id: app.clientId, ...(app.clientSecret ? { client_secret: app.clientSecret } : {}) },
    classify: (status, body) => (body?.error === "invalid_grant" || status === 401 ? "auth" : undefined),
  });
}

async function userAccount(ctx: ProviderContext, t: any): Promise<ConnectedAccount> {
  const u = await requestJson(ctx, `${BASE}/oauth/userinfo`, { token: t.access_token, classify });
  return {
    externalId: String(u.sub),
    name: u.name || u.preferred_username || "Whop user",
    username: u.preferred_username ?? null,
    avatarUrl: u.picture || null,
    credentials: { accessToken: t.access_token, refreshToken: t.refresh_token },
    expiresAt: expiresAt(t.expires_in ?? 3600),
  };
}

const token = (account: AccountRecord) => String(account.credentials.accessToken);

/** Creates a file record and streams the bytes to its upload URL. Whop then processes it asynchronously. */
async function uploadFile(ctx: ProviderContext, tok: string, item: MediaItem): Promise<string> {
  const file = await whopApi(ctx, tok, "/files", { method: "POST", json: { filename: item.filename || (item.kind === "video" ? "video.mp4" : "image.jpg") } });
  if (!file?.id) throw new ProviderError("Whop did not create the file", "transient");
  if (file.upload_url) {
    await request(ctx, file.upload_url, {
      method: "PUT",
      headers: { "content-type": item.mime, ...(file.upload_headers ?? {}) },
      // Fixed-length stream straight from R2: zero-copy, and sends Content-Length.
      body: await mediaBody(ctx, item),
      ...({ duplex: "half" } as object),
    });
  }
  return String(file.id);
}

/** "ready" when every file is ready; throws when one failed. */
async function filesState(ctx: ProviderContext, tok: string, ids: string[]): Promise<"ready" | "pending"> {
  for (const id of ids) {
    const f = await whopApi(ctx, tok, `/files/${encodeURIComponent(id)}`);
    if (f?.upload_status === "failed") throw new ProviderError(`Whop could not process the uploaded file ${id}`, "invalid");
    if (f?.upload_status !== "ready") return "pending";
  }
  return "ready";
}

/**
 * Polls until every file is ready, bounded by time and by the call's subrequest budget: a round costs up to
 * one fetch per file, and one fetch is kept for creating the post.
 */
async function waitForFiles(ctx: CountedContext, tok: string, ids: string[], maxMs: number): Promise<boolean> {
  if (!ids.length) return true;
  const deadline = Date.now() + maxMs;
  for (;;) {
    if ((await filesState(ctx, tok, ids)) === "ready") return true;
    if (Date.now() + 3000 > deadline || ctx.left() - 1 < ids.length) return false;
    await sleep(3000);
  }
}

interface Draft {
  experienceId: string;
  content: string;
  title?: string;
  fileIds: string[];
}

async function createForumPost(ctx: ProviderContext, tok: string, d: Draft, parentId?: string) {
  const res = await whopApi(ctx, tok, "/forum_posts", {
    method: "POST",
    json: {
      experience_id: d.experienceId,
      content: d.content,
      ...(d.title && !parentId ? { title: d.title } : {}),
      ...(parentId ? { parent_id: parentId } : {}),
      ...(d.fileIds.length ? { attachments: d.fileIds.map((id) => ({ id })) } : {}),
    },
    commit: true,
  });
  if (!res?.id) throw new ProviderError("Whop did not return the forum post", "transient");
  return String(res.id);
}

const postUrl = (experienceId: string, id: string) => `https://whop.com/experiences/${experienceId}/${id}`;

/** Whop forums (OAuth 2.1 + PKCE). */
export const whop: Provider = {
  id: "whop",
  name: "Whop",
  color: "FF6243",
  category: "community",
  auth: "oauth2",
  appFields: [
    { key: "clientId", label: "Client ID (App ID)", type: "text", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", help: "Optional: only for confidential OAuth clients." },
  ],
  credentialFields: [],
  settingsFields: [
    { key: "company", label: "Company", type: "select", dynamicOptions: true, required: true },
    { key: "experience", label: "Forum", type: "select", dynamicOptions: true, required: true, help: "Forum experience of the selected company." },
    { key: "title", label: "Title", type: "text" },
  ],
  capabilities: {
    maxLength: 50_000,
    text: "required",
    media: { images: 10, videos: 2, mixed: true, required: false },
    thread: true,
    threadLabel: "Comments",
  },
  docsUrl: "https://dev.whop.com",
  setupNotes:
    "1. Create an app in the Whop developer dashboard (dev.whop.com) and enable OAuth.\n" +
    "2. Add the redirect URI `{{redirectUri}}`.\n" +
    `3. Grant the permissions/scopes: \`${SCOPES.join(" ")}\`.\n` +
    "4. Copy the App/Client ID (and secret if your client is confidential) here.",

  authorize(ctx, { state, codeChallenge }) {
    const app = requireApp(ctx, "Whop", "clientId");
    const u = new URL(`${BASE}/oauth/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("state", state);
    u.searchParams.set("nonce", crypto.randomUUID());
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  },

  async callback(ctx, { code, codeVerifier }) {
    const t = await tokenRequest(ctx, { grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri, code_verifier: codeVerifier });
    if (!t?.access_token) throw new ProviderError(`Whop: ${t?.error_description || t?.error || "no access token"}`, "auth");
    return [await userAccount(ctx, t)];
  },

  async refresh(ctx, account) {
    if (!account.credentials.refreshToken) throw new ProviderError("Whop session expired, reconnect the account", "auth");
    const t = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: String(account.credentials.refreshToken) });
    return {
      credentials: { accessToken: t.access_token, refreshToken: t.refresh_token ?? account.credentials.refreshToken },
      expiresAt: expiresAt(t.expires_in ?? 3600),
    };
  },

  validate(post) {
    return post.settings.experience ? [] : ["Choose a Whop forum"];
  },

  async publish(ctx, account, post) {
    const experienceId = String(post.settings.experience ?? "");
    if (!experienceId) throw new ProviderError("Choose a Whop forum", "invalid");
    const tok = token(account);
    const c = counted(ctx);
    const fileIds: string[] = [];
    for (const m of post.media) fileIds.push(await uploadFile(c, tok, m));
    const draft: Draft = { experienceId, content: post.content, title: post.settings.title || undefined, fileIds };
    if (!(await waitForFiles(c, tok, fileIds, INLINE_WAIT_MS))) {
      return { status: "pending", state: { ...draft }, retryAfterSeconds: 15 };
    }
    const id = await createForumPost(ctx, tok, draft);
    return { status: "published", externalId: id, url: postUrl(experienceId, id), data: { experienceId } };
  },

  /** Waits for media processing, then creates the post (only once: the post is created on the first ready poll). */
  async checkStatus(ctx, account, state) {
    const draft = state as unknown as Draft;
    const tok = token(account);
    if ((await filesState(ctx, tok, draft.fileIds)) !== "ready") return { status: "pending", state, retryAfterSeconds: 15 };
    const id = await createForumPost(ctx, tok, draft);
    return { status: "published", externalId: id, url: postUrl(draft.experienceId, id), data: { experienceId: draft.experienceId } };
  },

  async reply(ctx, account, target, post) {
    const experienceId = String(target.rootData?.experienceId ?? post.settings.experience);
    const tok = token(account);
    const c = counted(ctx);
    const fileIds: string[] = [];
    for (const m of post.media) fileIds.push(await uploadFile(c, tok, m));
    if (!(await waitForFiles(c, tok, fileIds, 25_000))) throw new ProviderError("Whop is still processing the comment's media", "transient");
    const id = await createForumPost(c, tok, { experienceId, content: post.content, fileIds }, target.parentId);
    return { externalId: id, url: postUrl(experienceId, target.rootId), urlIsPost: true, data: { experienceId } };
  },

  async options(ctx, account, key, settings) {
    const tok = token(account);
    if (key === "company") {
      const { data } = await whopApi(ctx, tok, "/companies", { query: { first: 50 } });
      return (data ?? []).map((c: any) => ({ value: String(c.id), label: c.title || c.name || c.id }));
    }
    if (key === "experience") {
      if (!settings.company) return [];
      const { data } = await whopApi(ctx, tok, "/forums", { query: { company_id: String(settings.company), first: 50 } });
      return (data ?? []).map((f: any) => ({ value: String(f.experience?.id ?? f.id), label: f.experience?.name || f.id }));
    }
    return [];
  },
};
