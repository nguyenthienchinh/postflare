import { ProviderError, type ProviderErrorKind } from "./errors";
import { checkedCommit, expiresAt, request, requestJson, requireApp, sleep } from "./http";
import { mediaBody, streamBody } from "./multipart";
import type { AccountRecord, Provider, ProviderContext, PublishPost, PublishResult } from "./types";

const API = "https://slack.com/api";
const SCOPES = ["chat:write", "chat:write.public", "channels:read", "groups:read", "channels:join", "files:write", "files:read"];
const AUTH_ERRORS = ["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "missing_scope", "no_permission"];
const TRANSIENT_ERRORS = ["internal_error", "fatal_error", "service_unavailable", "request_timeout"];

/** Methods that post the message (docs/provider-brief.md "Commit semantics"). */
const COMMIT_METHODS = ["chat.postMessage", "files.completeUploadExternal"];

/** Calls a Slack Web API method. Slack answers HTTP 200 with `{ ok: false, error }` on failure. */
async function api<T = any>(ctx: ProviderContext, token: string | undefined, method: string, params: Record<string, unknown>, get = false): Promise<T> {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) flat[k] = typeof v === "string" ? v : JSON.stringify(v);
  const commit = COMMIT_METHODS.includes(method);
  // `ok: false` is a refusal (nothing posted), except a server-side error on a commit: that one is ambiguous.
  const body = await checkedCommit(
    ctx,
    () => requestJson<any>(ctx, `${API}/${method}`, get ? { token, query: flat } : { method: "POST", token, form: flat, commit }),
    (body) => {
      if (body?.ok) return;
      const error = String(body?.error ?? "unknown_error");
      const kind: ProviderErrorKind = AUTH_ERRORS.includes(error)
        ? "auth"
        : error === "ratelimited"
          ? "rate_limit"
          : TRANSIENT_ERRORS.includes(error)
            ? commit
              ? "ambiguous"
              : "transient"
            : "invalid";
      const hint = error === "not_in_channel" ? " (invite the app to this private channel)" : "";
      throw new ProviderError(`Slack ${method}: ${error}${hint}`, kind, 200, body);
    },
  );
  return body as T;
}

/** Files per message: keeps a publish at ~27 fetches (Free plan subrequest budget). */
const MAX_FILES = 10;

const token = (account: AccountRecord) => String(account.credentials.accessToken ?? "");

async function permalink(ctx: ProviderContext, account: AccountRecord, channel: string, ts: string): Promise<string | null> {
  return api<{ permalink: string }>(ctx, token(account), "chat.getPermalink", { channel, message_ts: ts }, true)
    .then((r) => r.permalink)
    .catch(() => null);
}

/** The message ts a file was shared as in `channel` (Slack fills `shares` asynchronously). */
function shareTs(file: any, channel: string): string | undefined {
  const shares = { ...file?.shares?.public, ...file?.shares?.private };
  return shares[channel]?.[0]?.ts;
}

async function findShare(ctx: ProviderContext, account: AccountRecord, fileId: string, channel: string, tries: number): Promise<string | undefined> {
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(1500);
    const { file } = await api(ctx, token(account), "files.info", { file: fileId }, true);
    const ts = shareTs(file, channel);
    if (ts) return ts;
  }
  return undefined;
}

/** Posts text (chat.postMessage) or uploads files with the text as the initial comment. */
async function send(
  ctx: ProviderContext,
  account: AccountRecord,
  post: PublishPost,
  threadTs?: string,
): Promise<{ ts: string; channel: string } | { pendingFile: string; channel: string }> {
  const s = post.settings ?? {};
  const channel = String(s.channel ?? "");
  if (!channel) throw new ProviderError("Slack: choose a channel", "invalid");
  const text = post.content;
  const broadcast = threadTs && s.replyBroadcast ? true : undefined;

  if (!post.media.length) {
    const res = await api<{ ts: string; channel: string }>(ctx, token(account), "chat.postMessage", {
      channel,
      text,
      thread_ts: threadTs,
      reply_broadcast: broadcast,
      unfurl_links: s.unfurlLinks !== false,
      unfurl_media: s.unfurlLinks !== false,
    });
    return { ts: res.ts, channel: res.channel ?? channel };
  }

  // Subrequest budget: join + 2 per file + complete + share lookups + permalink must stay within one call.
  if (post.media.length > MAX_FILES) throw new ProviderError(`Slack: at most ${MAX_FILES} files per message`, "invalid");
  // Bots must be a member of the channel to share files; joining public channels is a no-op if already in.
  if (!threadTs) await api(ctx, token(account), "conversations.join", { channel }).catch(() => {});
  const files: Array<{ id: string; title: string }> = [];
  for (const item of post.media) {
    const up = await api<{ upload_url: string; file_id: string }>(ctx, token(account), "files.getUploadURLExternal", {
      filename: item.filename,
      length: item.size,
      alt_txt: item.alt ?? undefined,
    });
    // Fixed-length stream straight from R2: zero-copy, and sends Content-Length.
    await request(ctx, up.upload_url, streamBody(await mediaBody(ctx, item), item.mime || "application/octet-stream"));
    files.push({ id: up.file_id, title: item.filename });
  }
  const done = await api<{ files: any[] }>(ctx, token(account), "files.completeUploadExternal", {
    files,
    channel_id: channel,
    initial_comment: text.trim() ? text : undefined,
    thread_ts: threadTs,
  });
  const first = done.files?.[0];
  const ts = shareTs(first, channel) ?? (await findShare(ctx, account, first?.id ?? files[0].id, channel, 4));
  return ts ? { ts, channel } : { pendingFile: first?.id ?? files[0].id, channel };
}

export const slack: Provider = {
  id: "slack",
  name: "Slack",
  color: "4A154B",
  category: "messaging",
  auth: "oauth2",
  docsUrl: "https://api.slack.com/apps",
  setupNotes: [
    "1. Create an app at https://api.slack.com/apps (From scratch).",
    `2. **OAuth & Permissions**: add the redirect URL \`{{redirectUri}}\` and the bot token scopes ${SCOPES.map((s) => `\`${s}\``).join(", ")}.`,
    "3. Copy the Client ID and Client Secret from **Basic Information**.",
    "4. Private channels: invite the app to the channel (`/invite @YourApp`).",
  ].join("\n"),
  appFields: [
    { key: "clientId", label: "Client ID", type: "text", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  ],
  credentialFields: [],
  settingsFields: [
    { key: "channel", label: "Channel", type: "select", required: true, dynamicOptions: true },
    { key: "unfurlLinks", label: "Show link previews", type: "checkbox", default: true },
    { key: "replyBroadcast", label: "Also send thread replies to the channel", type: "checkbox", default: false },
  ],
  capabilities: {
    maxLength: 40_000,
    text: "optional",
    media: { images: 10, videos: 10, mixed: true, required: false },
    thread: true,
    threadLabel: "Thread replies",
  },
  validate(post) {
    return post.media.length > MAX_FILES ? [`Slack: at most ${MAX_FILES} files per message`] : [];
  },
  authorize(ctx, { state }) {
    const { clientId } = requireApp(ctx, "Slack", "clientId", "clientSecret");
    const u = new URL("https://slack.com/oauth/v2/authorize");
    u.search = new URLSearchParams({ client_id: clientId, scope: SCOPES.join(","), redirect_uri: ctx.redirectUri, state }).toString();
    return u.toString();
  },
  async callback(ctx, { code }) {
    const { clientId, clientSecret } = requireApp(ctx, "Slack", "clientId", "clientSecret");
    const tok = await api(ctx, undefined, "oauth.v2.access", {
      code,
      redirect_uri: ctx.redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const info = await api<{ url?: string }>(ctx, tok.access_token, "auth.test", {}).catch(() => ({}) as { url?: string });
    return [
      {
        externalId: tok.team.id,
        name: tok.team.name,
        username: info.url ? new URL(info.url).hostname.split(".")[0] : null,
        profileUrl: info.url ?? null,
        // refresh_token/expires_in are only present when token rotation is enabled for the app.
        credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
        expiresAt: expiresAt(tok.expires_in),
        meta: { teamId: tok.team.id, botUserId: tok.bot_user_id, appId: tok.app_id },
      },
    ];
  },
  async refresh(ctx, account) {
    if (!account.credentials.refreshToken) return { credentials: account.credentials, expiresAt: null };
    const { clientId, clientSecret } = requireApp(ctx, "Slack", "clientId", "clientSecret");
    const tok = await api(ctx, undefined, "oauth.v2.access", {
      grant_type: "refresh_token",
      refresh_token: account.credentials.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).catch((err) => {
      if (err instanceof ProviderError && err.kind === "invalid") throw new ProviderError(err.message, "auth", err.status, err.body);
      throw err;
    });
    return { credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token ?? account.credentials.refreshToken }, expiresAt: expiresAt(tok.expires_in) };
  },
  async options(ctx, account, key) {
    if (key !== "channel") return [];
    const out: Array<{ value: string; label: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await api(
        ctx,
        token(account),
        "conversations.list",
        { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", cursor },
        true,
      );
      for (const c of res.channels ?? []) out.push({ value: c.id, label: `#${c.name}${c.is_private ? " (private)" : ""}` });
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  },
  async publish(ctx, account, post): Promise<PublishResult> {
    const r = await send(ctx, account, post);
    if ("pendingFile" in r) return { status: "pending", state: { fileId: r.pendingFile, channel: r.channel }, retryAfterSeconds: 5 };
    return { status: "published", externalId: r.ts, url: await permalink(ctx, account, r.channel, r.ts), data: { channel: r.channel } };
  },
  async checkStatus(ctx, account, state): Promise<PublishResult> {
    const channel = String(state.channel);
    const ts = await findShare(ctx, account, String(state.fileId), channel, 1);
    if (!ts) return { status: "pending", state, retryAfterSeconds: 10 };
    return { status: "published", externalId: ts, url: await permalink(ctx, account, channel, ts), data: { channel } };
  },
  async reply(ctx, account, target, post) {
    // Slack threads are flat: every follow-up goes under the root message.
    const r = await send(ctx, account, post, target.rootId);
    if ("pendingFile" in r) return { externalId: `file:${r.pendingFile}`, url: null, data: { channel: r.channel } };
    return { externalId: r.ts, url: await permalink(ctx, account, r.channel, r.ts), data: { channel: r.channel } };
  },
};
