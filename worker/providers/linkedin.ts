import { clientFields, requestJson } from "./http";
import {
  LINKEDIN_COLOR,
  LINKEDIN_DOCS,
  liAuthorizeUrl,
  liCheckStatus,
  liComment,
  liExchangeCode,
  liPublish,
  liRefresh,
  liSetupNotes,
  liValidate,
  linkedinCapabilities,
  linkedinSettings,
} from "./linkedin-shared";
import type { AccountRecord, Provider } from "./types";

const SCOPES = ["openid", "profile", "w_member_social"];
const author = (account: AccountRecord) => (account.meta.personUrn as string) || `urn:li:person:${account.externalId}`;

/** Personal LinkedIn profile, via "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn". */
export const linkedin: Provider = {
  id: "linkedin",
  name: "LinkedIn",
  color: LINKEDIN_COLOR,
  icon: "linkedin",
  category: "social",
  auth: "oauth2",
  appFields: clientFields(),
  docsUrl: LINKEDIN_DOCS,
  setupNotes: liSetupNotes("**Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**", SCOPES),
  credentialFields: [],
  settingsFields: linkedinSettings(true),
  capabilities: linkedinCapabilities,
  validate: liValidate,

  authorize(ctx, { state }) {
    return liAuthorizeUrl(ctx, state, SCOPES);
  },

  async callback(ctx, { code }) {
    const tokens = await liExchangeCode(ctx, code);
    const me = await requestJson<{ sub: string; name?: string; given_name?: string; family_name?: string; picture?: string }>(
      ctx,
      "https://api.linkedin.com/v2/userinfo",
      { token: tokens.credentials.accessToken },
    );
    return [
      {
        externalId: me.sub,
        name: me.name || [me.given_name, me.family_name].filter(Boolean).join(" ") || "LinkedIn",
        avatarUrl: me.picture ?? null,
        ...tokens,
        meta: { personUrn: `urn:li:person:${me.sub}` },
      },
    ];
  },

  refresh: liRefresh,

  publish(ctx, account, post) {
    return liPublish(ctx, account, author(account), post);
  },

  checkStatus: liCheckStatus,

  reply(ctx, account, target, post) {
    return liComment(ctx, account, author(account), target.rootId, post);
  },
};
