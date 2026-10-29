import { missingScope, ProviderError } from "./errors";
import { clientFields } from "./http";
import {
  LINKEDIN_COLOR,
  LINKEDIN_DOCS,
  liAuthorizeUrl,
  liCheckStatus,
  liComment,
  liExchangeCode,
  liJson,
  liPublish,
  liRefresh,
  liSetupNotes,
  liValidate,
  linkedinCapabilities,
  linkedinSettings,
} from "./linkedin-shared";
import type { AccountRecord, ConnectedAccount, MetricValues, PostMetricsResult, Provider, ProviderContext } from "./types";

// rw_organization_admin is what the Community Management API grants (it covers reading organizationAcls and the
// share/follower statistics); r_organization_social reads the page's posts and social actions (analytics).
const SCOPES = ["rw_organization_admin", "w_organization_social", "r_organization_social"];
const METRICS_SCOPES = ["rw_organization_admin", "r_organization_social"];
/** Post urns per organizationalEntityShareStatistics request (kept small: the urns go in the URL). */
const METRICS_BATCH = 20;
const POSTING_ROLES = ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR"];
const REST = "https://api.linkedin.com/rest";
const author = (account: AccountRecord) => (account.meta.organizationUrn as string) || `urn:li:organization:${account.externalId}`;

/**
 * GET for analytics. A 403 (ACCESS_DENIED: the token predates the analytics scopes, or the member lost the page
 * role) only flags analytics as reconnect_required; expired/revoked tokens keep their "auth" kind.
 */
async function liRead<T = any>(ctx: ProviderContext, account: AccountRecord, url: string): Promise<T> {
  try {
    return await liJson<T>(ctx, url, account.credentials.accessToken as string);
  } catch (err) {
    if (err instanceof ProviderError && err.status === 403 && err.kind !== "auth") throw missingScope("LinkedIn", METRICS_SCOPES);
    throw err;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Drop keys the platform did not report. */
function compact(m: MetricValues): MetricValues {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as MetricValues;
}

/** Restli 2.0 list param: `List(urn%3Ali%3Ashare%3A1,...)` (urns encoded, the List syntax not). */
const restliList = (urns: string[]) => `List(${urns.map(encodeURIComponent).join(",")})`;

/** Lifetime totals of the organization's shares (`shares=`) or ugcPosts (`ugcPosts=`): one request per kind. */
async function shareStatistics(ctx: ProviderContext, account: AccountRecord, param: "shares" | "ugcPosts", urns: string[], out: PostMetricsResult) {
  if (!urns.length) return;
  const url = `${REST}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(author(account))}&${param}=${restliList(urns)}`;
  const res = await liRead<{ elements?: Array<{ share?: string; ugcPost?: string; totalShareStatistics?: Record<string, unknown> }> }>(
    ctx,
    account,
    url,
  );
  for (const el of res?.elements ?? []) {
    const urn = el.share ?? el.ugcPost;
    const st = el.totalShareStatistics;
    if (!urn || !st || !urns.includes(urn)) continue;
    out[urn] = compact({
      impressions: num(st.impressionCount),
      reach: num(st.uniqueImpressionsCount),
      clicks: num(st.clickCount),
      likes: num(st.likeCount),
      comments: num(st.commentCount),
      shares: num(st.shareCount),
    });
  }
}

/** LinkedIn company pages the user administers: one account per organization. */
export const linkedinPage: Provider = {
  id: "linkedin_page",
  name: "LinkedIn Page",
  color: LINKEDIN_COLOR,
  icon: "linkedin",
  category: "social",
  auth: "oauth2",
  appFields: clientFields(),
  docsUrl: LINKEDIN_DOCS,
  setupNotes: [
    liSetupNotes("**Community Management API** (requires LinkedIn approval)", SCOPES),
    "Analytics (post statistics and followers) need `rw_organization_admin` and `r_organization_social`: pages connected before analytics existed must be **reconnected**.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: linkedinSettings(false),
  capabilities: linkedinCapabilities,
  validate: liValidate,

  metrics: {
    post: ["impressions", "reach", "clicks", "likes", "comments", "shares"],
    account: ["followers"],
    batch: METRICS_BATCH,
    scopes: METRICS_SCOPES,
  },

  authorize(ctx, { state }) {
    return liAuthorizeUrl(ctx, state, SCOPES);
  },

  async callback(ctx, { code }) {
    const tokens = await liExchangeCode(ctx, code);
    const tok = tokens.credentials.accessToken;
    const acls = await liJson<{ elements?: Array<{ organization: string; role: string; state: string }> }>(
      ctx,
      `${REST}/organizationAcls?q=roleAssignee&state=APPROVED&count=100`,
      tok,
    );
    const orgUrns = [
      ...new Set((acls.elements ?? []).filter((e) => POSTING_ROLES.includes(e.role) && e.state !== "REVOKED").map((e) => e.organization)),
    ];
    if (!orgUrns.length) throw new ProviderError("This LinkedIn user is not an administrator of any LinkedIn Page", "invalid");
    const accounts: ConnectedAccount[] = [];
    for (const urn of orgUrns) {
      const id = urn.split(":").pop()!;
      const org = await liJson<{ id: number; localizedName?: string; vanityName?: string }>(ctx, `${REST}/organizations/${id}`, tok).catch(
        () => ({}) as { localizedName?: string; vanityName?: string },
      );
      accounts.push({
        externalId: id,
        name: org.localizedName || `Organization ${id}`,
        username: org.vanityName ?? null,
        profileUrl: org.vanityName ? `https://www.linkedin.com/company/${org.vanityName}/` : `https://www.linkedin.com/company/${id}/`,
        ...tokens,
        meta: { organizationUrn: urn },
      });
    }
    return accounts;
  },

  refresh: liRefresh,

  publish(ctx, account, post) {
    return liPublish(ctx, account, author(account), post);
  },

  checkStatus: liCheckStatus,

  reply(ctx, account, target, post) {
    return liComment(ctx, account, author(account), target.rootId, post);
  },

  /**
   * organizationalEntityShareStatistics (lifetime totals) for the batch: one request for urn:li:share posts and one for
   * urn:li:ugcPost posts (video/older posts). Posts missing from the response (deleted, not this page's) → null.
   */
  async postMetrics(ctx, account, items) {
    const urns = [...new Set(items.map((i) => i.externalId))].slice(0, METRICS_BATCH);
    const out: PostMetricsResult = {};
    await shareStatistics(ctx, account, "shares", urns.filter((u) => u.startsWith("urn:li:share:")), out);
    await shareStatistics(ctx, account, "ugcPosts", urns.filter((u) => u.startsWith("urn:li:ugcPost:")), out);
    for (const urn of urns) if (!(urn in out)) out[urn] = null;
    return out;
  },

  /** Follower count of the page (networkSizes, COMPANY_FOLLOWED_BY_MEMBER edge). */
  async accountMetrics(ctx, account) {
    const res = await liRead<{ firstDegreeSize?: number }>(
      ctx,
      account,
      `${REST}/networkSizes/${encodeURIComponent(author(account))}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
    );
    return compact({ followers: num(res?.firstDegreeSize) });
  },
};
