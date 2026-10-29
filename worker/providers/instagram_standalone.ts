import { MetricsUnavailableError, ProviderError } from "./errors";
import { clientFields, expiresAt, oauthToken, requireApp } from "./http";
import {
  IG_GRAPH,
  graph,
  instagramCapabilities,
  instagramAccountMetrics,
  instagramCheck,
  instagramComment,
  instagramCreate,
  instagramMetricKeys,
  instagramPostMetrics,
  instagramSettingsFields,
  instagramValidate,
  type IgAccount,
} from "./meta-shared";
import type { AccountRecord, ConnectedAccount, Provider, ProviderContext } from "./types";

const METRICS_SCOPES = ["instagram_business_manage_insights"];
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments", ...METRICS_SCOPES];
const PROFESSIONAL = ["BUSINESS", "MEDIA_CREATOR", "CREATOR"];

/** Personal accounts have no insights. Accounts connected before account_type was stored are tried anyway. */
function requireProfessional(account: AccountRecord) {
  const type = account.meta?.accountType;
  if (typeof type === "string" && type && !PROFESSIONAL.includes(type))
    throw new MetricsUnavailableError("not_supported", `Instagram ${type} accounts have no insights; switch to a professional account`);
}

const igAccount = (account: AccountRecord): IgAccount => ({
  igUserId: account.externalId,
  token: account.credentials.accessToken as string,
  username: account.username,
});

interface Me {
  user_id: string;
  id?: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  account_type?: string;
}

async function me(ctx: ProviderContext, token: string) {
  return graph<Me>(ctx, `${IG_GRAPH}/me`, { token, query: { fields: "user_id,id,username,name,profile_picture_url,account_type" } });
}

function toAccount(user: Me, token: string, expiresIn?: number, scopedId?: string): ConnectedAccount {
  return {
    // user_id is the professional account id used by the publishing endpoints.
    externalId: String(user.user_id ?? user.id),
    name: user.name || user.username || "Instagram",
    username: user.username ?? null,
    avatarUrl: user.profile_picture_url ?? null,
    profileUrl: user.username ? `https://www.instagram.com/${user.username}/` : null,
    credentials: { accessToken: token },
    expiresAt: expiresAt(expiresIn ?? 60 * 24 * 3600),
    // The long-lived token refreshes itself (ig_refresh_token): it must be refreshed before it expires.
    refreshExpiresAt: expiresAt(expiresIn ?? 60 * 24 * 3600),
    // App-scoped user id (`id` of /me, or the token's user_id): Meta's data deletion callback identifies the user by it.
    meta: { accountType: user.account_type ?? null, metaUserId: user.id ? String(user.id) : scopedId ?? null },
  };
}

/** Instagram API with Instagram Login (graph.instagram.com): no Facebook Page needed. */
export const instagramStandalone: Provider = {
  id: "instagram_standalone",
  name: "Instagram",
  color: "E4405F",
  icon: "instagram",
  category: "social",
  auth: "oauth2",
  statusNote: "Connection verified; publishing being verified",
  appFields: clientFields("Instagram App ID", "Instagram App Secret"),
  docsUrl: "https://developers.facebook.com/apps",
  setupNotes: [
    "Works with Instagram **Business or Creator** accounts, no Facebook Page required.",
    "1. Create an app at [developers.facebook.com/apps](https://developers.facebook.com/apps) (type **Business**) and add the **Instagram** product.",
    "2. Open *Instagram → API setup with Instagram login*. In *Set up Instagram business login*, add `{{redirectUri}}` as the redirect URL.",
    `3. Request the permissions ${SCOPES.map((s) => `\`${s}\``).join(", ")}.`,
    "4. Copy the **Instagram App ID** and **Instagram App Secret** shown on that page (not the Facebook App ID).",
    "In the same *Set up Instagram business login* step, set the *Data deletion request URL* to `{{baseUrl}}/oauth/meta/data-deletion` (the deauthorize callback can be `{{baseUrl}}`).",
    "Tokens last 60 days and are refreshed automatically.",
    "Analytics need `instagram_business_manage_insights`; accounts connected before analytics existed must reconnect.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: instagramSettingsFields,
  capabilities: instagramCapabilities,
  validate: instagramValidate,

  // force_reauth makes Instagram ask for credentials even when the browser is signed in, and it ends that
  // instagram.com session: only on request ("Use a different Instagram account"), never by default.
  switchAccount: {
    label: "Use a different Instagram account",
    note: "Instagram asks you to sign in again. This signs you out of instagram.com in this browser.",
  },

  authorize(ctx, { state, switchAccount }) {
    requireApp(ctx, "Instagram", "clientId", "clientSecret");
    const u = new URL("https://www.instagram.com/oauth/authorize");
    if (switchAccount) u.searchParams.set("force_reauth", "true");
    u.searchParams.set("client_id", ctx.app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(","));
    u.searchParams.set("state", state);
    return u.toString();
  },

  async callback(ctx, { code }) {
    requireApp(ctx, "Instagram", "clientId", "clientSecret");
    const short = await oauthToken(ctx, "https://api.instagram.com/oauth/access_token", {
      client_id: ctx.app.clientId,
      client_secret: ctx.app.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: ctx.redirectUri,
      // Instagram appends "#_" to the code in the redirect.
      code: code.replace(/#_$/, ""),
    });
    // Newer responses wrap the token in `data: [...]`.
    const shortToken: string | undefined = short.access_token ?? short.data?.[0]?.access_token;
    if (!shortToken) throw new ProviderError("Instagram did not return an access token", "auth");
    const long = await graph<{ access_token: string; expires_in?: number }>(ctx, "https://graph.instagram.com/access_token", {
      query: { grant_type: "ig_exchange_token", client_secret: ctx.app.clientSecret, access_token: shortToken },
    });
    const user = await me(ctx, long.access_token);
    if (user.account_type && !PROFESSIONAL.includes(user.account_type))
      ctx.log("warn", `Instagram account type ${user.account_type} may not be allowed to publish; switch to a professional account`);
    const scopedId = short.user_id ?? short.data?.[0]?.user_id;
    return [toAccount(user, long.access_token, long.expires_in, scopedId === undefined ? undefined : String(scopedId))];
  },

  async refresh(ctx, account) {
    const res = await graph<{ access_token: string; expires_in?: number }>(ctx, "https://graph.instagram.com/refresh_access_token", {
      query: { grant_type: "ig_refresh_token", access_token: account.credentials.accessToken as string },
    });
    const exp = expiresAt(res.expires_in ?? 60 * 24 * 3600);
    return { credentials: { ...account.credentials, accessToken: res.access_token }, expiresAt: exp, refreshExpiresAt: exp };
  },

  async profile(ctx, account) {
    const res = await graph<{ profile_picture_url?: string }>(ctx, `${IG_GRAPH}/me`, {
      token: account.credentials.accessToken as string,
      query: { fields: "profile_picture_url" },
    });
    return { avatarUrl: res.profile_picture_url ?? null };
  },

  publish: (ctx, account, post) => instagramCreate(ctx, IG_GRAPH, igAccount(account), post),
  checkStatus: (ctx, account, state) => instagramCheck(ctx, igAccount(account), state),
  reply: (ctx, account, target, post) => instagramComment(ctx, IG_GRAPH, igAccount(account), target.rootId, post),

  // graph.instagram.com has no documented Batch API: one GET per media (story frame), within the fetch budget.
  metrics: { ...instagramMetricKeys, batch: 10, scopes: METRICS_SCOPES },
  async postMetrics(ctx, account, items) {
    requireProfessional(account);
    return instagramPostMetrics(ctx, { host: IG_GRAPH, token: account.credentials.accessToken as string, scopes: METRICS_SCOPES, batch: false }, items);
  },
  async accountMetrics(ctx, account) {
    requireProfessional(account);
    return instagramAccountMetrics(ctx, IG_GRAPH, account, METRICS_SCOPES);
  },
};
