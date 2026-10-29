import { ProviderError, type ProviderErrorKind } from "./errors";
import { expiresAt, requestJson, requireApp } from "./http";
import { mediaPart, streamBody, streamingMultipart } from "./multipart";
import type { AccountRecord, ConnectedAccount, CredentialsUpdate, MediaItem, Provider, ProviderContext, PublishPost } from "./types";

const API = "https://api.vk.com/method";
const V = "5.199";
const SCOPES = "vkid.personal_info wall photos video";

/** VK API answers HTTP 200 with { error: { error_code, error_msg } }. */
function apiErrorKind(code: number): ProviderErrorKind {
  if (code === 5 || code === 27 || code === 28) return "auth";
  if (code === 6 || code === 9 || code === 29) return "rate_limit";
  if (code === 1 || code === 10) return "transient";
  return "invalid";
}

async function vkApi<T = any>(ctx: ProviderContext, method: string, token: string, params: Record<string, string | number | undefined>) {
  const res = await requestJson<any>(ctx, `${API}/${method}`, { method: "POST", form: { ...params, access_token: token, v: V } });
  if (res?.error) {
    const e = res.error;
    throw new ProviderError(`VK ${method}: ${e.error_msg ?? "error"} (${e.error_code})`, apiErrorKind(Number(e.error_code)), undefined, res);
  }
  return res.response as T;
}

// VK ID OAuth errors: { error: "invalid_grant" | "invalid_token" ..., error_description }.
const idClassify = (status: number, body: any): ProviderErrorKind | undefined =>
  status === 401 || ["invalid_grant", "invalid_token", "invalid_client"].includes(body?.error) ? "auth" : undefined;

async function idToken(ctx: ProviderContext, params: Record<string, string>) {
  const res = await requestJson<any>(ctx, "https://id.vk.com/oauth2/auth", { method: "POST", form: params, classify: idClassify });
  // VK ID can also answer 200 with an error body.
  if (res?.error) throw new ProviderError(`VK ID: ${res.error_description ?? res.error}`, idClassify(400, res) ?? "invalid", undefined, res);
  return res as { access_token: string; refresh_token: string; expires_in: number; user_id: number; scope?: string };
}

async function userInfo(ctx: ProviderContext, clientId: string, accessToken: string) {
  const res = await requestJson<any>(ctx, "https://id.vk.com/oauth2/user_info", {
    method: "POST",
    form: { client_id: clientId, access_token: accessToken },
    classify: idClassify,
  });
  if (res?.error) throw new ProviderError(`VK ID: ${res.error_description ?? res.error}`, "auth", undefined, res);
  return res.user as { user_id: string; first_name: string; last_name: string; avatar?: string };
}

const token = (account: AccountRecord) => account.credentials.accessToken as string;
const ownerId = (account: AccountRecord) => String(account.meta.ownerId ?? account.externalId);

async function uploadPhoto(ctx: ProviderContext, account: AccountRecord, item: MediaItem): Promise<string> {
  const server = await vkApi<{ upload_url: string }>(ctx, "photos.getWallUploadServer", token(account), {});
  // Streamed from R2 into the multipart body (no copy into memory).
  const mp = streamingMultipart([mediaPart(ctx, "photo", item)]);
  const up = await requestJson<any>(ctx, server.upload_url, streamBody(mp.body, mp.contentType));
  if (!up?.photo || up.photo === "[]") throw new ProviderError(`VK rejected the photo ${item.filename}`, "invalid", undefined, up);
  const [saved] = await vkApi<Array<{ id: number; owner_id: number }>>(ctx, "photos.saveWallPhoto", token(account), {
    server: up.server,
    photo: up.photo,
    hash: up.hash,
    user_id: ownerId(account),
    caption: item.alt ?? undefined,
  });
  return `photo${saved.owner_id}_${saved.id}`;
}

async function uploadVideo(ctx: ProviderContext, account: AccountRecord, item: MediaItem, post: PublishPost): Promise<string> {
  const saved = await vkApi<{ upload_url: string; video_id: number; owner_id: number; access_key?: string }>(ctx, "video.save", token(account), {
    name: String(post.settings.videoTitle || item.filename).slice(0, 128),
    description: (post.content ?? "").slice(0, 5000),
    wallpost: 0,
  });
  const mp = streamingMultipart([mediaPart(ctx, "video_file", item)]);
  const up = await requestJson<any>(ctx, saved.upload_url, { method: "POST", headers: mp.headers, body: mp.body, duplex: "half" } as any);
  if (up?.error) throw new ProviderError(`VK video upload failed: ${up.error}`, "transient", undefined, up);
  return `video${saved.owner_id}_${saved.video_id}${saved.access_key ? `_${saved.access_key}` : ""}`;
}

async function attachments(ctx: ProviderContext, account: AccountRecord, post: PublishPost) {
  const out: string[] = [];
  for (const m of post.media) out.push(m.kind === "video" ? await uploadVideo(ctx, account, m, post) : await uploadPhoto(ctx, account, m));
  if (post.settings.link) out.push(String(post.settings.link));
  return out.join(",") || undefined;
}

async function toAccount(ctx: ProviderContext, clientId: string, t: Awaited<ReturnType<typeof idToken>>, deviceId: string): Promise<ConnectedAccount> {
  const u = await userInfo(ctx, clientId, t.access_token);
  const id = String(u.user_id ?? t.user_id);
  return {
    externalId: id,
    name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || `id${id}`,
    username: `id${id}`,
    avatarUrl: u.avatar ?? null,
    profileUrl: `https://vk.com/id${id}`,
    credentials: { accessToken: t.access_token, refreshToken: t.refresh_token, deviceId },
    expiresAt: expiresAt(t.expires_in),
    meta: { ownerId: id },
  };
}

export const vk: Provider = {
  id: "vk",
  name: "VK",
  color: "0077FF",
  icon: "vk",
  category: "social",
  auth: "oauth2",
  // VK ID uses PKCE: no client secret is needed.
  appFields: [{ key: "clientId", label: "App ID", type: "text", required: true }],
  docsUrl: "https://id.vk.com/about/business/go",
  setupNotes: [
    "1. Create a **Web** app in the [VK ID business account](https://id.vk.com/about/business/go).",
    "2. Add your domain and the trusted redirect URL `{{redirectUri}}`.",
    "3. Enable the access scopes **wall**, **photos** and **video**.",
    "4. Copy the **App ID** here.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: [
    { key: "link", label: "Link attachment", type: "url", help: "Shown as a link snippet under the post." },
    { key: "videoTitle", label: "Video title", type: "text", maxLength: 128 },
    { key: "closeComments", label: "Close comments", type: "checkbox", default: false },
    { key: "muteNotifications", label: "Mute notifications about comments", type: "checkbox", default: false },
  ],
  capabilities: {
    maxLength: 16_384,
    text: "optional",
    media: { images: 10, videos: 10, mixed: true, required: false },
    thread: true,
    threadLabel: "Comments",
  },

  validate(post) {
    return post.media.length > 10 ? ["VK allows at most 10 attachments per post"] : [];
  },

  authorize(ctx, { state, codeChallenge }) {
    const app = requireApp(ctx, "VK", "clientId");
    const u = new URL("https://id.vk.com/authorize");
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: app.clientId,
      redirect_uri: ctx.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: SCOPES,
    }).toString();
    return u.toString();
  },

  async callback(ctx, { code, codeVerifier, params }) {
    const app = requireApp(ctx, "VK", "clientId");
    const deviceId = params.get("device_id") ?? "";
    if (!deviceId) throw new ProviderError("VK did not return a device_id", "invalid");
    const t = await idToken(ctx, {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: app.clientId,
      device_id: deviceId,
      redirect_uri: ctx.redirectUri,
      state: params.get("state") ?? "",
    });
    return [await toAccount(ctx, app.clientId, t, deviceId)];
  },

  async refresh(ctx, account): Promise<CredentialsUpdate> {
    const app = requireApp(ctx, "VK", "clientId");
    const { refreshToken, deviceId } = account.credentials as { refreshToken?: string; deviceId?: string };
    if (!refreshToken || !deviceId) throw new ProviderError("VK refresh token missing, reconnect the account", "auth");
    const t = await idToken(ctx, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: app.clientId,
      device_id: deviceId,
      state: crypto.randomUUID().replace(/-/g, ""),
    });
    // VK ID refresh tokens are single-use: always store the new one.
    return { credentials: { accessToken: t.access_token, refreshToken: t.refresh_token, deviceId }, expiresAt: expiresAt(t.expires_in) };
  },

  // wall.post / wall.createComment are not marked `commit: true`: VK drops a second post or comment with the same
  // `guid`, so a failed call may be retried (docs/provider-brief.md "Commit semantics").
  async publish(ctx, account, post) {
    const owner = ownerId(account);
    const res = await vkApi<{ post_id: number }>(ctx, "wall.post", token(account), {
      owner_id: owner,
      message: post.content ?? "",
      attachments: await attachments(ctx, account, post),
      close_comments: post.settings.closeComments ? 1 : undefined,
      mute_notifications: post.settings.muteNotifications ? 1 : undefined,
      guid: post.id,
    });
    const id = String(res.post_id);
    return { status: "published", externalId: id, url: `https://vk.com/wall${owner}_${id}` };
  },

  async reply(ctx, account, target, post) {
    const owner = ownerId(account);
    const res = await vkApi<{ comment_id: number }>(ctx, "wall.createComment", token(account), {
      owner_id: owner,
      post_id: target.rootId,
      message: post.content ?? "",
      attachments: await attachments(ctx, account, { ...post, settings: {} }),
      guid: post.id,
    });
    const id = String(res.comment_id);
    return { externalId: id, url: `https://vk.com/wall${owner}_${target.rootId}?reply=${id}` };
  },
};
