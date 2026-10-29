/**
 * Display names of the providers, for the moments the catalog (GET /api/providers) has not loaded yet: right after an
 * OAuth redirect the accounts can arrive first, and section headings / toasts would show raw ids ("instagram_standalone").
 * Must match each provider's `name` (test/registry.test.ts).
 */
export const PROVIDER_NAMES: Record<string, string> = {
  bluesky: "Bluesky",
  devto: "DEV",
  discord: "Discord",
  dribbble: "Dribbble",
  facebook: "Facebook Page",
  farcaster: "Farcaster",
  gmb: "Google Business Profile",
  hashnode: "Hashnode",
  instagram: "Instagram (Facebook login)",
  instagram_standalone: "Instagram",
  kick: "Kick",
  lemmy: "Lemmy",
  linkedin: "LinkedIn",
  linkedin_page: "LinkedIn Page",
  listmonk: "Listmonk",
  mastodon: "Mastodon",
  medium: "Medium",
  mewe: "MeWe",
  moltbook: "Moltbook",
  nostr: "Nostr",
  pinterest: "Pinterest",
  reddit: "Reddit",
  skool: "Skool",
  slack: "Slack",
  telegram: "Telegram",
  threads: "Threads",
  tiktok: "TikTok",
  tiktok_business: "TikTok Business",
  tumblr: "Tumblr",
  twitch: "Twitch",
  vk: "VK",
  webhook: "Webhook",
  whop: "Whop",
  wordpress: "WordPress",
  x: "X (Twitter)",
  youtube: "YouTube",
};

/** Display name of a provider: the loaded catalog's, else the built-in fallback, else the id. */
export function providerDisplayName(id: string, catalog?: { get(id: string): { name: string } | undefined }): string {
  return catalog?.get(id)?.name ?? PROVIDER_NAMES[id] ?? id;
}
