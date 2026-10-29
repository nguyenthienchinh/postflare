import { ProviderError } from "./errors";
import { googleAppFields, googleAuthorizeUrl, googleClassify, googleExchangeCode, googleRefresh } from "./google-shared";
import { checkedCommit, requestJson } from "./http";
import type { ConnectedAccount, Provider, ProviderContext, PublishPost } from "./types";

const NAME = "Google Business Profile";
const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const POSTS_API = "https://mybusiness.googleapis.com/v4";
const SCOPES = ["https://www.googleapis.com/auth/business.manage"];

const get = <T = any>(ctx: ProviderContext, url: string, token: string, query?: Record<string, string | undefined>) =>
  requestJson<T>(ctx, url, { token, query, classify: googleClassify });

interface GDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Datetime setting -> Google date/time. "YYYY-MM-DDTHH:mm" (no zone) is taken as the business's local time;
 * anything else is parsed as an instant and expressed in UTC.
 */
export function splitDateTime(v: unknown): { date: GDate; time: { hours: number; minutes: number } } | null {
  if (v === undefined || v === null || v === "") return null;
  const local = typeof v === "string" ? v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/) : null;
  if (local) {
    return {
      date: { year: +local[1], month: +local[2], day: +local[3] },
      time: { hours: +(local[4] ?? 0), minutes: +(local[5] ?? 0) },
    };
  }
  const d = new Date(typeof v === "number" ? v : String(v));
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
    time: { hours: d.getUTCHours(), minutes: d.getUTCMinutes() },
  };
}

const bool = (v: unknown) => v === true || v === "true" || v === "yes" || v === 1;

function schedule(start: unknown, end: unknown, allDay: boolean) {
  const s = splitDateTime(start);
  const e = splitDateTime(end) ?? s;
  if (!s || !e) throw new ProviderError("Google Business Profile: event and offer posts need a start and end date", "invalid");
  return {
    startDate: s.date,
    endDate: e.date,
    ...(allDay ? {} : { startTime: s.time, endTime: e.time }),
  };
}

export function localPostBody(post: PublishPost) {
  const s = post.settings;
  const topicType = ["EVENT", "OFFER"].includes(s.postType) ? s.postType : "STANDARD";
  const body: Record<string, unknown> = {
    languageCode: String(s.language || "en"),
    topicType,
  };
  if (post.content.trim()) body.summary = post.content;
  const photo = post.media.find((m) => m.kind === "image");
  if (photo) body.media = [{ mediaFormat: "PHOTO", sourceUrl: photo.url }];

  const action = String(s.callToAction || "NONE");
  if (action !== "NONE" && topicType !== "OFFER") {
    if (action === "CALL") body.callToAction = { actionType: "CALL" };
    else if (s.callToActionUrl) body.callToAction = { actionType: action, url: String(s.callToActionUrl) };
  }
  if (topicType === "EVENT") {
    body.event = { title: String(s.eventTitle ?? ""), schedule: schedule(s.eventStart, s.eventEnd, bool(s.eventAllDay)) };
  }
  if (topicType === "OFFER") {
    // Offers carry their title and validity period in `event`.
    body.event = { title: String(s.offerTitle ?? ""), schedule: schedule(s.offerStart, s.offerEnd, true) };
    const offer: Record<string, string> = {};
    if (s.offerCouponCode) offer.couponCode = String(s.offerCouponCode);
    if (s.offerRedeemUrl) offer.redeemOnlineUrl = String(s.offerRedeemUrl);
    if (s.offerTerms) offer.termsConditions = String(s.offerTerms);
    body.offer = offer;
  }
  return body;
}

async function listLocations(ctx: ProviderContext, token: string) {
  const accounts: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await get<{ accounts?: any[]; nextPageToken?: string }>(ctx, `${ACCOUNTS_API}/accounts`, token, { pageToken });
    accounts.push(...(res.accounts ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);

  const out: Array<{ account: any; location: any }> = [];
  for (const account of accounts) {
    let locToken: string | undefined;
    do {
      const res = await get<{ locations?: any[]; nextPageToken?: string }>(ctx, `${INFO_API}/${account.name}/locations`, token, {
        readMask: "name,title,storefrontAddress,metadata",
        pageSize: "100",
        pageToken: locToken,
      });
      for (const location of res.locations ?? []) out.push({ account, location });
      locToken = res.nextPageToken;
    } while (locToken);
  }
  return out;
}

export const gmb: Provider = {
  id: "gmb",
  name: NAME,
  color: "4285F4",
  icon: "google",
  category: "social",
  auth: "oauth2",
  docsUrl: "https://developers.google.com/my-business/content/prereqs",
  setupNotes: [
    "1. Request access to the Business Profile APIs with the [GBP API contact form](https://support.google.com/business/contact/api_default) (approved projects get a non-zero quota; until then every call fails with quota 0).",
    "2. In the [Google Cloud console](https://console.cloud.google.com/) enable **My Business Account Management API**, **My Business Business Information API** and **Google My Business API**.",
    "3. Configure the **OAuth consent screen** with the scope `business.manage` (add yourself as a test user while in Testing).",
    "4. Create an **OAuth client ID** (*Web application*) with the authorized redirect URI `{{redirectUri}}`.",
    "5. Paste the client ID and secret here. Connecting adds one account per business location you manage.",
    "",
    "You can reuse the same Google Cloud project and OAuth client as YouTube (add both redirect URIs).",
  ].join("\n"),
  appFields: googleAppFields,
  credentialFields: [],
  settingsFields: [
    {
      key: "postType",
      label: "Post type",
      type: "select",
      default: "STANDARD",
      options: [
        { value: "STANDARD", label: "Update (what's new)" },
        { value: "EVENT", label: "Event" },
        { value: "OFFER", label: "Offer" },
      ],
    },
    { key: "eventTitle", label: "Event title", type: "text", required: true, maxLength: 58, showIf: { key: "postType", equals: "EVENT" } },
    { key: "eventStart", label: "Event start", type: "datetime", required: true, showIf: { key: "postType", equals: "EVENT" } },
    { key: "eventEnd", label: "Event end", type: "datetime", required: true, showIf: { key: "postType", equals: "EVENT" } },
    { key: "eventAllDay", label: "All-day event", type: "checkbox", default: false, showIf: { key: "postType", equals: "EVENT" } },
    { key: "offerTitle", label: "Offer title", type: "text", required: true, maxLength: 58, showIf: { key: "postType", equals: "OFFER" } },
    { key: "offerStart", label: "Offer starts", type: "datetime", required: true, showIf: { key: "postType", equals: "OFFER" } },
    { key: "offerEnd", label: "Offer ends", type: "datetime", required: true, showIf: { key: "postType", equals: "OFFER" } },
    { key: "offerCouponCode", label: "Coupon code", type: "text", showIf: { key: "postType", equals: "OFFER" } },
    { key: "offerRedeemUrl", label: "Redeem online URL", type: "url", showIf: { key: "postType", equals: "OFFER" } },
    { key: "offerTerms", label: "Terms and conditions", type: "textarea", showIf: { key: "postType", equals: "OFFER" } },
    {
      key: "callToAction",
      label: "Button",
      type: "select",
      default: "NONE",
      help: "Not used for offers (they get a \"View offer\" button).",
      options: [
        { value: "NONE", label: "None" },
        { value: "LEARN_MORE", label: "Learn more" },
        { value: "BOOK", label: "Book" },
        { value: "ORDER", label: "Order online" },
        { value: "SHOP", label: "Buy" },
        { value: "SIGN_UP", label: "Sign up" },
        { value: "CALL", label: "Call now (uses the business phone)" },
      ],
    },
    { key: "callToActionUrl", label: "Button URL", type: "url", placeholder: "https://..." },
    { key: "language", label: "Language code", type: "text", default: "en", placeholder: "en" },
  ],
  capabilities: {
    maxLength: 1500,
    text: "optional",
    media: { images: 1, videos: 0, mixed: false, required: false },
    thread: false,
  },

  authorize(ctx, p) {
    return googleAuthorizeUrl(ctx, NAME, SCOPES, p);
  },

  async callback(ctx, { code, codeVerifier }) {
    const tok = await googleExchangeCode(ctx, NAME, code, codeVerifier);
    const locations = await listLocations(ctx, tok.credentials.accessToken);
    if (!locations.length) throw new ProviderError("No Business Profile locations found for this Google account", "invalid");
    return locations.map(({ account, location }): ConnectedAccount => {
      const locationId = String(location.name).replace(/^locations\//, "");
      const address = location.storefrontAddress;
      return {
        // v4 resource name used by localPosts.
        externalId: `${account.name}/locations/${locationId}`,
        name: location.title || "Business location",
        username: address?.locality ?? account.accountName ?? null,
        profileUrl: location.metadata?.mapsUri ?? null,
        credentials: tok.credentials,
        expiresAt: tok.expiresAt,
        refreshExpiresAt: tok.refreshExpiresAt,
        meta: { accountName: account.name, locationName: location.name, mapsUri: location.metadata?.mapsUri ?? null },
      };
    });
  },

  refresh(ctx, account) {
    return googleRefresh(ctx, NAME, account);
  },

  validate(post) {
    const errors: string[] = [];
    const s = post.settings;
    const type = s.postType || "STANDARD";
    if (type === "STANDARD" && !post.content.trim() && !post.media.length) errors.push(`${NAME}: an update needs text or a photo`);
    const photo = post.media.find((m) => m.kind === "image");
    if (photo && !["image/jpeg", "image/png"].includes(photo.mime)) errors.push(`${NAME}: the photo must be JPEG or PNG`);
    if (photo && photo.size > 5_000_000) errors.push(`${NAME}: the photo must be at most 5 MB`);
    if (photo && photo.width && photo.height && (photo.width < 250 || photo.height < 250))
      errors.push(`${NAME}: the photo must be at least 250x250 pixels`);
    const action = s.callToAction || "NONE";
    if (type !== "OFFER" && action !== "NONE" && action !== "CALL" && !s.callToActionUrl) errors.push(`${NAME}: the button needs a URL`);
    return errors;
  },

  async publish(ctx, account, post) {
    // A REJECTED post is not live: a plain refusal, not an ambiguous commit.
    const res = await checkedCommit(
      ctx,
      () =>
        requestJson<{ name?: string; searchUrl?: string; state?: string }>(ctx, `${POSTS_API}/${account.externalId}/localPosts`, {
          method: "POST",
          token: String(account.credentials.accessToken),
          json: localPostBody(post),
          classify: googleClassify,
          commit: true,
        }),
      (res) => {
        if (res?.state === "REJECTED") throw new ProviderError(`${NAME}: Google rejected the post for a content policy violation`, "invalid");
      },
    );
    if (!res?.name) throw new ProviderError(`${NAME}: Google did not confirm the post`, "invalid");
    return {
      status: "published",
      externalId: res.name,
      url: res.searchUrl ?? (account.meta.mapsUri as string | null) ?? null,
    };
  },
};
