import { ProviderError } from "./errors";
import { request, requestJson, requireApp, type RequestOptions } from "./http";
import { mediaPart, streamBody, streamingMultipart, type MultipartPart } from "./multipart";
import type { AccountRecord, Provider, ProviderContext } from "./types";

const host = (ctx: ProviderContext) => (ctx.app.host || "https://mewe.com").replace(/\/+$/, "");

function appHeaders(ctx: ProviderContext): Record<string, string> {
  const app = requireApp(ctx, "MeWe", "appId", "apiKey");
  return { "x-app-id": app.appId, "x-api-key": app.apiKey };
}

const classify: RequestOptions["classify"] = (status) => (status === 420 ? "rate_limit" : status === 401 ? "auth" : undefined);

function meweApi<T = any>(ctx: ProviderContext, tok: string, path: string, opts: RequestOptions = {}) {
  return requestJson<T>(ctx, path.startsWith("http") ? path : `${host(ctx)}${path}`, {
    ...opts,
    token: tok,
    headers: { ...appHeaders(ctx), ...(opts.headers as Record<string, string>) },
    classify,
  });
}

/** MeWe returns `expiresAt` as ISO date, seconds or ms. */
export function parseExpiry(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  if (!Number.isNaN(n)) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

const token = (account: AccountRecord) => String(account.credentials.accessToken);

/** MeWe developer API (login-request flow): timeline or group posts with photos. */
export const mewe: Provider = {
  id: "mewe",
  name: "MeWe",
  color: "17377F",
  icon: "mewe",
  category: "social",
  auth: "oauth2",
  appFields: [
    { key: "appId", label: "App ID", type: "text", required: true },
    { key: "apiKey", label: "API key", type: "password", required: true },
    { key: "host", label: "MeWe host", type: "url", placeholder: "https://mewe.com", help: "Leave empty unless MeWe gave you another host." },
  ],
  credentialFields: [],
  settingsFields: [
    {
      key: "postType",
      label: "Post to",
      type: "select",
      default: "timeline",
      options: [
        { value: "timeline", label: "My timeline" },
        { value: "group", label: "A group" },
      ],
    },
    { key: "group", label: "Group", type: "select", dynamicOptions: true, required: true, showIf: { key: "postType", equals: "group" } },
  ],
  capabilities: {
    maxLength: 63_206,
    text: "required",
    media: { images: 10, videos: 0, mixed: false, required: false },
    thread: false,
  },
  docsUrl: "https://mewe.com/developers",
  setupNotes:
    "1. Request developer access from MeWe and create an app to get an **App ID** and **API key**.\n" +
    "2. Set the app's redirect URL to `{{redirectUri}}`.\n" +
    "3. Enter the App ID and API key here, then connect an account. MeWe tokens expire (about 30 days) and cannot be refreshed: reconnect when asked.",

  authorize(ctx, { state }) {
    const app = requireApp(ctx, "MeWe", "appId", "apiKey");
    const u = new URL(`${host(ctx)}/login`);
    u.searchParams.set("client_id", app.appId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  },

  async callback(ctx, { code, params }) {
    const loginRequestToken = params.get("loginRequestToken") || code;
    if (!loginRequestToken) throw new ProviderError("MeWe did not return a login request token", "invalid");
    const t = await requestJson(ctx, `${host(ctx)}/api/dev/token`, {
      headers: appHeaders(ctx),
      query: { loginRequestToken },
      classify,
    });
    if (t?.pending) throw new ProviderError("The MeWe login request is still pending: approve it in MeWe and try again", "invalid");
    if (!t?.apiToken) throw new ProviderError("MeWe did not return an API token", "auth");
    const me = await meweApi(ctx, t.apiToken, "/api/dev/me");
    const name = me.name || `${me.firstName ?? ""} ${me.lastName ?? ""}`.trim() || me.handle;
    return [
      {
        externalId: String(me.userId ?? me.id),
        name,
        username: me.handle ?? null,
        profileUrl: me.handle ? `https://mewe.com/${me.handle}` : null,
        credentials: { accessToken: t.apiToken },
        expiresAt: parseExpiry(t.expiresAt) ?? Date.now() + 30 * 86400_000,
      },
    ];
  },

  validate(post) {
    return post.settings.postType === "group" && !post.settings.group ? ["Choose a MeWe group"] : [];
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    const toGroup = s.postType === "group";
    if (toGroup && !s.group) throw new ProviderError("Choose a MeWe group", "invalid");
    const tok = token(account);

    const uploadedPhotoIds: string[] = [];
    for (const m of post.media.filter((m) => m.kind === "image")) {
      // Streamed from R2 into the multipart body (no copy into memory).
      const mp = streamingMultipart([{ ...mediaPart(ctx, "file", m), filename: m.filename || "photo.jpg" } as MultipartPart]);
      const up = await meweApi(ctx, tok, "/api/dev/photo/upload", streamBody(mp.body, mp.contentType));
      if (!up?.id) throw new ProviderError("MeWe photo upload returned no id", "transient");
      uploadedPhotoIds.push(String(up.id));
    }

    const path = toGroup ? `/api/dev/group/${encodeURIComponent(s.group)}/post` : "/api/dev/me/post";
    // May answer 204 without a body, in which case there is no post id to report.
    const res = await request(ctx, `${host(ctx)}${path}`, {
      method: "POST",
      token: tok,
      headers: appHeaders(ctx),
      json: { text: post.content, ...(uploadedPhotoIds.length ? { uploadedPhotoIds } : {}) },
      classify,
      commit: true,
    });
    const body = await res.json<any>().catch(() => ({}));
    const id = body?.postItemId ?? body?.id ?? body?.post?.postItemId ?? post.id;
    const url = toGroup ? `https://mewe.com/group/${s.group}` : account.username ? `https://mewe.com/${account.username}/posts` : null;
    return { status: "published", externalId: String(id), url };
  },

  async options(ctx, account, key) {
    if (key !== "group") return [];
    const groups: any[] = [];
    let next: string | null = "/api/dev/groups";
    for (let page = 0; next && page < 20; page++) {
      const data: any = await meweApi(ctx, token(account), next);
      groups.push(...(data?.groups ?? []));
      next = data?.nextPage ? `${host(ctx)}${data.nextPage}` : null;
    }
    return groups.map((g) => ({ value: String(g.groupId ?? g.id), label: g.name }));
  },
};
