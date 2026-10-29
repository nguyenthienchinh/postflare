import { ProviderError } from "./errors";
import { clientFields, oauthToken, request, requestJson, requireApp } from "./http";
import { mediaPart, streamBody, streamingMultipart, type MultipartPart } from "./multipart";
import type { Provider } from "./types";

const API = "https://api.dribbble.com/v2";
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif"];

export const dribbble: Provider = {
  id: "dribbble",
  name: "Dribbble",
  color: "EA4C89",
  icon: "dribbble",
  category: "social",
  auth: "oauth2",
  appFields: clientFields(),
  docsUrl: "https://dribbble.com/account/applications/new",
  setupNotes: [
    "1. Register an application at [dribbble.com/account/applications](https://dribbble.com/account/applications/new).",
    "2. Set the **Callback URL** to `{{redirectUri}}`.",
    "3. Copy the **Client ID** and **Client Secret** here.",
    "Uploading shots needs the `upload` scope, which Dribbble only grants to accounts allowed to post shots (Pro/approved players).",
  ].join("\n"),
  credentialFields: [],
  settingsFields: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "tags", label: "Tags", type: "tags", help: "Up to 12 tags." },
    { key: "team", label: "Team", type: "select", dynamicOptions: true, help: "Publish on behalf of a team (optional)." },
    { key: "lowProfile", label: "Low profile (keep off the popular/recent feeds)", type: "checkbox", default: false },
  ],
  capabilities: {
    maxLength: 10_000,
    text: "optional",
    media: { images: 1, videos: 0, mixed: false, required: true },
    thread: false,
  },

  validate(post) {
    const errors: string[] = [];
    if (!String(post.settings.title ?? "").trim()) errors.push("Dribbble shots need a title");
    const img = post.media[0];
    if (img) {
      if (!IMAGE_MIMES.includes(img.mime)) errors.push("Dribbble accepts JPG, PNG or GIF images");
      if (img.size > 8 * 1024 * 1024) errors.push("Dribbble images must be 8MB or smaller");
      // Shots must be 4:3, between 400x300 and 1600x1200.
      if (img.width && img.height && (img.width * 3 !== img.height * 4 || img.width < 400 || img.width > 1600))
        errors.push("Dribbble images must be 4:3, from 400×300 up to 1600×1200 px (e.g. 800×600)");
    }
    const tags = Array.isArray(post.settings.tags) ? post.settings.tags : [];
    if (tags.length > 12) errors.push("Dribbble allows at most 12 tags");
    return errors;
  },

  authorize(ctx, { state }) {
    const app = requireApp(ctx, "Dribbble", "clientId", "clientSecret");
    const u = new URL("https://dribbble.com/oauth/authorize");
    u.search = new URLSearchParams({ client_id: app.clientId, redirect_uri: ctx.redirectUri, scope: "public upload", state }).toString();
    return u.toString();
  },

  async callback(ctx, { code }) {
    const app = requireApp(ctx, "Dribbble", "clientId", "clientSecret");
    const token = await oauthToken(ctx, "https://dribbble.com/oauth/token", {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: ctx.redirectUri,
    });
    if (token.scope && !token.scope.split(/[ ,]+/).includes("upload"))
      throw new ProviderError("Dribbble did not grant the upload scope; this account cannot post shots", "invalid");
    const me = await requestJson<any>(ctx, `${API}/user`, { token: token.access_token });
    return [
      {
        externalId: String(me.id),
        name: me.name || me.login,
        username: me.login,
        avatarUrl: me.avatar_url ?? null,
        profileUrl: me.html_url ?? `https://dribbble.com/${me.login}`,
        // Dribbble tokens do not expire.
        credentials: { accessToken: token.access_token },
        expiresAt: null,
      },
    ];
  },

  async options(ctx, account, key) {
    if (key !== "team") return [];
    const me = await requestJson<any>(ctx, `${API}/user`, { token: account.credentials.accessToken });
    return [{ value: "", label: "No team" }, ...(me?.teams ?? []).map((t: any) => ({ value: String(t.id), label: t.name }))];
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    const item = post.media.find((m) => m.kind === "image");
    if (!item) throw new ProviderError("Dribbble shots need an image", "invalid");
    const title = String(s.title ?? "").trim();
    if (!title) throw new ProviderError("Dribbble shots need a title", "invalid");
    const parts: MultipartPart[] = [mediaPart(ctx, "image", item), { name: "title", value: title }];
    if (post.content?.trim()) parts.push({ name: "description", value: post.content });
    for (const t of (Array.isArray(s.tags) ? s.tags : []).slice(0, 12)) parts.push({ name: "tags[]", value: String(t) });
    if (s.team) parts.push({ name: "team_id", value: String(s.team) });
    if (s.lowProfile) parts.push({ name: "low_profile", value: "true" });
    // The image is streamed from R2 into the multipart body (no copy into memory).
    const mp = streamingMultipart(parts);
    // 202 Accepted; the shot id is the last segment of the Location header.
    const res = await request(ctx, `${API}/shots`, { token: account.credentials.accessToken, ...streamBody(mp.body, mp.contentType), commit: true });
    const id = res.headers.get("location")?.split("/").filter(Boolean).pop();
    if (!id) throw new ProviderError("Dribbble did not return the shot location", "transient");
    return { status: "published", externalId: id, url: `https://dribbble.com/shots/${id}` };
  },
};
