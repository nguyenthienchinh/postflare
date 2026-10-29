import { ProviderError } from "./errors";
import { clientFields, requireApp } from "./http";
import {
  FB_GRAPH,
  graph,
  facebookAuthorizeUrl,
  facebookPages,
  facebookUserId,
  facebookUserToken,
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
import type { AccountRecord, Provider } from "./types";

const SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
  "instagram_manage_insights",
];
const METRICS_SCOPES = ["instagram_manage_insights"];

interface PageWithIg {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
}

// The Page access token (non-expiring) is used for every Instagram call.
const igAccount = (account: AccountRecord): IgAccount => ({
  igUserId: account.externalId,
  token: account.credentials.accessToken as string,
  username: account.username,
});

/** Instagram professional accounts linked to Facebook Pages, published through graph.facebook.com. */
export const instagram: Provider = {
  id: "instagram",
  name: "Instagram (Facebook login)",
  color: "E4405F",
  icon: "instagram",
  category: "social",
  auth: "oauth2",
  appFields: [
    ...clientFields("App ID", "App Secret"),
    {
      key: "configId",
      label: "Login for Business configuration ID",
      type: "text",
      help: "Only for apps using Facebook Login for Business. Leave empty to request the scopes directly.",
    },
  ],
  docsUrl: "https://developers.facebook.com/apps",
  setupNotes: [
    "Requires an Instagram **Business or Creator** account linked to a Facebook Page you manage.",
    "1. Create an app at [developers.facebook.com/apps](https://developers.facebook.com/apps) (type **Business**) — the same app as Facebook Page works.",
    "2. Add **Facebook Login for Business** (or Facebook Login) and **Instagram Graph API**; add `{{redirectUri}}` to *Valid OAuth Redirect URIs*.",
    `3. Request the permissions ${SCOPES.map((s) => `\`${s}\``).join(", ")}.`,
    "4. Copy the App ID and App Secret from *App settings → Basic*. One account is added per linked Instagram account.",
    "In *App settings → Basic*, set the *Data deletion request URL* to the data deletion callback `{{baseUrl}}/oauth/meta/data-deletion` (and the *Privacy policy URL* to `{{baseUrl}}/privacy/`).",
    "Analytics need `instagram_manage_insights` (add it to your Login for Business configuration too); accounts connected before analytics existed must reconnect.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: instagramSettingsFields,
  capabilities: instagramCapabilities,
  validate: instagramValidate,

  authorize(ctx, { state }) {
    requireApp(ctx, "Instagram", "clientId", "clientSecret");
    return facebookAuthorizeUrl(ctx, state, SCOPES);
  },

  async callback(ctx, { code }) {
    requireApp(ctx, "Instagram", "clientId", "clientSecret");
    const { token } = await facebookUserToken(ctx, code);
    const pages = await facebookPages<PageWithIg>(
      ctx,
      token,
      "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}",
    );
    const linked = pages.filter((p) => p.instagram_business_account?.id && p.access_token);
    if (!linked.length)
      throw new ProviderError(
        "No Instagram professional account was found. Link an Instagram Business/Creator account to a Facebook Page and select that Page.",
        "invalid",
      );
    const metaUserId = await facebookUserId(ctx, token);
    return linked.map((p) => {
      const ig = p.instagram_business_account!;
      return {
        externalId: ig.id,
        name: ig.name || ig.username || p.name,
        username: ig.username ?? null,
        avatarUrl: ig.profile_picture_url ?? null,
        profileUrl: ig.username ? `https://www.instagram.com/${ig.username}/` : null,
        credentials: { accessToken: p.access_token },
        expiresAt: null,
        meta: { pageId: p.id, pageName: p.name, metaUserId },
      };
    });
  },

  async profile(ctx, account) {
    const res = await graph<{ profile_picture_url?: string }>(ctx, `${FB_GRAPH}/${account.externalId}`, {
      token: account.credentials.accessToken as string,
      query: { fields: "profile_picture_url" },
    });
    return { avatarUrl: res.profile_picture_url ?? null };
  },

  publish: (ctx, account, post) => instagramCreate(ctx, FB_GRAPH, igAccount(account), post),
  checkStatus: (ctx, account, state) => instagramCheck(ctx, igAccount(account), state),
  reply: (ctx, account, target, post) => instagramComment(ctx, FB_GRAPH, igAccount(account), target.rootId, post),

  // Media insights through the Graph Batch API: one fetch for up to 50 media (story frames count one each).
  metrics: { ...instagramMetricKeys, batch: 50, scopes: METRICS_SCOPES },
  postMetrics: (ctx, account, items) =>
    instagramPostMetrics(ctx, { host: FB_GRAPH, token: account.credentials.accessToken as string, scopes: METRICS_SCOPES, batch: true }, items),
  accountMetrics: (ctx, account) => instagramAccountMetrics(ctx, FB_GRAPH, account, METRICS_SCOPES),
};
