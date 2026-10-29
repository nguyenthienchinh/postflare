// App Store campaign links: token rules, link building and App Store URL detection. Pure functions shared by the
// worker (worker/lib/campaigns.ts), the web app (composer hints) and the tests.
//
// Apple's format (App Store Connect Help, "Campaign links":
// https://developer.apple.com/help/app-store-connect-analytics/acquisition/campaign-links):
//   https://apps.apple.com/app/apple-store/id123456789?pt=123456&ct=test1234&mt=8
// pt = provider token (one per developer account), ct = campaign token ("up to 30 alphanumeric characters and spaces"
// plus some punctuation; not starting or ending with a space), mt=8 = media type (apps).

/** Apple's documented maximum length of a campaign token. Ours are lowercase [a-z0-9-] and much shorter. */
export const MAX_CAMPAIGN_TOKEN = 30;

/** Short platform labels used in campaign tokens (pf-<short>-...). Unlisted platforms: their id, alphanumerics only, 4 chars. */
export const PLATFORM_SHORT: Record<string, string> = {
  x: "x",
  threads: "th",
  bluesky: "bsky",
  linkedin: "li",
  linkedin_page: "lip",
  facebook: "fb",
  pinterest: "pin",
  reddit: "rd",
  mastodon: "mst",
  youtube: "yt",
  telegram: "tg",
  instagram: "ig",
  instagram_standalone: "igs",
  tiktok: "tt",
  tiktok_business: "ttb",
  discord: "dc",
  slack: "slk",
  tumblr: "tmb",
  lemmy: "lmy",
  farcaster: "fc",
  nostr: "nos",
  vk: "vk",
};

export function platformShort(provider: string): string {
  return PLATFORM_SHORT[provider] ?? (provider.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || "p");
}

/**
 * Platforms where a URL in the post (or its link field / first comment) is clickable: tracked links are used and
 * auto-inserted there. Instagram and TikTok captions are not clickable: they use the account's bio link instead.
 */
export const CLICKABLE_PLATFORMS = new Set([
  "x",
  "threads",
  "bluesky",
  "linkedin",
  "linkedin_page",
  "facebook",
  "pinterest",
  "reddit",
  "mastodon",
  "youtube",
  "telegram",
  "discord",
  "slack",
  "tumblr",
  "lemmy",
  "farcaster",
  "nostr",
  "vk",
]);

/** Platforms whose captions never make links clickable (the composer shows the bio link instead). */
export const BIO_LINK_PLATFORMS = new Set(["instagram", "instagram_standalone", "tiktok", "tiktok_business"]);

export const isClickable = (provider: string) => CLICKABLE_PLATFORMS.has(provider);

/** A campaign token we generate: lowercase letters, digits and dashes, at most 30 characters. */
export const CAMPAIGN_TOKEN_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

export function isValidCampaignToken(ct: string): boolean {
  return ct.length <= MAX_CAMPAIGN_TOKEN && CAMPAIGN_TOKEN_RE.test(ct);
}

/** 64-bit FNV-1a of a string, as two 32-bit halves (no crypto needed: tokens only need to be stable and spread). */
function fnv1a64(input: string): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return [h1, h2];
}

/** 10 base36 characters derived from the post id (stable; `attempt` > 0 only after a collision). */
export function postShortId(postId: string, attempt = 0): string {
  const [a, b] = fnv1a64(attempt ? `${postId}#${attempt}` : postId);
  return (a.toString(36).padStart(7, "0").slice(-5) + b.toString(36).padStart(7, "0").slice(-5)).toLowerCase();
}

/**
 * Campaign token of a post on a platform: pf-<platform short>-<10 chars from the post id>, e.g. "pf-x-0k3j9a8z1q".
 * Stable for a post (posts belong to one account, so one platform); `attempt` picks another one after a collision.
 */
export function postCampaignToken(provider: string, postId: string, attempt = 0): string {
  return `pf-${platformShort(provider)}-${postShortId(postId, attempt)}`;
}

/** Campaign token of an account's bio link: pf-<platform short>-bio, then -bio-2, -bio-3... for further accounts. */
export function bioCampaignToken(provider: string, n = 1): string {
  return `pf-${platformShort(provider)}-bio${n > 1 ? `-${n}` : ""}`;
}

/** A plausible numeric App Store id (the id<n> of apps.apple.com links). */
export const isAppStoreId = (v: unknown): v is string => typeof v === "string" && /^\d{5,12}$/.test(v);

/** Provider tokens are numeric in App Store Connect; accept short alphanumerics to be safe. */
export const isProviderToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);

/** Apple's campaign link: https://apps.apple.com/app/apple-store/id<APP_ID>?pt=<PT>&ct=<CT>&mt=8 */
export function appStoreCampaignUrl(appStoreId: string, providerToken: string, ct: string): string {
  if (!isAppStoreId(appStoreId)) throw new Error(`Invalid App Store id: ${appStoreId}`);
  const q = new URLSearchParams({ pt: providerToken, ct, mt: "8" });
  return `https://apps.apple.com/app/apple-store/id${appStoreId}?${q}`;
}

/** Characters allowed in a short link code (base62). */
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const LINK_CODE_LENGTH = 8;
export const LINK_CODE_RE = /^[0-9A-Za-z]{6,12}$/;

/** A random short link code (8 base62 characters, ~47 bits). */
export function newLinkCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = "";
  while (out.length < LINK_CODE_LENGTH) {
    for (const b of random(LINK_CODE_LENGTH * 2)) {
      // 62 * 4 = 248: rejection sampling keeps the distribution uniform.
      if (b < 248 && out.length < LINK_CODE_LENGTH) out += CODE_ALPHABET[b % 62];
    }
  }
  return out;
}

/** App Store URLs (apps.apple.com / itunes.apple.com with an id<n> segment). Group 1 = the app id. */
export const APP_STORE_URL_RE = /https?:\/\/(?:apps|itunes)\.apple\.com\/[^\s]*?\bid(\d{5,12})(?:[/?#][^\s]*)?/gi;

/** Trailing punctuation that ends a sentence, not the URL. */
export const trimUrlEnd = (url: string) => url.replace(/[.,!?;:'")\]]+$/, "");

/** App Store URLs of an app in a text (with positions), skipping links that already carry a campaign token. */
export function findAppStoreUrls(text: string, appStoreId: string): Array<{ index: number; url: string }> {
  const out: Array<{ index: number; url: string }> = [];
  for (const m of text.matchAll(APP_STORE_URL_RE)) {
    if (m[1] !== appStoreId) continue;
    const url = trimUrlEnd(m[0]);
    if (/[?&]ct=/i.test(url)) continue;
    out.push({ index: m.index!, url });
  }
  return out;
}

/** Any http(s) URL in a text. */
export const HAS_URL_RE = /https?:\/\/\S+/i;
