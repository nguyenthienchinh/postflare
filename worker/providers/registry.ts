import { x } from "./x";
import { linkedin } from "./linkedin";
import { linkedinPage } from "./linkedin_page";
import { facebook } from "./facebook";
import { instagram } from "./instagram";
import { instagramStandalone } from "./instagram_standalone";
import { threads } from "./threads";
import { bluesky } from "./bluesky";
import { mastodon } from "./mastodon";
import { pinterest } from "./pinterest";
import { reddit } from "./reddit";
import { tumblr } from "./tumblr";
import { vk } from "./vk";
import { nostr } from "./nostr";
import { farcaster } from "./farcaster";
import { lemmy } from "./lemmy";
import { dribbble } from "./dribbble";
import { mewe } from "./mewe";
import { skool } from "./skool";
import { whop } from "./whop";
import { moltbook } from "./moltbook";
import { youtube } from "./youtube";
import { tiktok } from "./tiktok";
import { tiktokBusiness } from "./tiktok_business";
import { gmb } from "./gmb";
import { twitch } from "./twitch";
import { kick } from "./kick";
import { telegram } from "./telegram";
import { discord } from "./discord";
import { slack } from "./slack";
import { devto } from "./devto";
import { hashnode } from "./hashnode";
import { medium } from "./medium";
import { wordpress } from "./wordpress";
import { listmonk } from "./listmonk";
import { webhook } from "./webhook";
import type { ProviderInfo } from "../../shared/types";
import type { Provider } from "./types";

export const providers: Provider[] = [
  x, linkedin, linkedinPage, facebook, instagram, instagramStandalone, threads, bluesky, mastodon, pinterest, reddit, tumblr, vk, nostr, farcaster, lemmy, dribbble, mewe, skool, whop, moltbook, youtube, tiktok, tiktokBusiness, gmb, twitch, kick, telegram, discord, slack, devto, hashnode, medium, wordpress, listmonk, webhook,
];

const byId = new Map(providers.map((p) => [p.id, p]));

export function getProvider(id: string): Provider | undefined {
  return byId.get(id);
}

export function redirectUriFor(base: string, p: Provider): string {
  return `${base}/oauth/${p.id}/callback${p.redirectTrailingSlash ? "/" : ""}`;
}

export function providerInfo(p: Provider): ProviderInfo {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    icon: p.icon,
    category: p.category,
    auth: p.auth,
    appFields: p.appFields,
    credentialFields: p.credentialFields,
    settingsFields: p.settingsFields,
    capabilities: p.capabilities,
    docsUrl: p.docsUrl,
    setupNotes: p.setupNotes,
    composerNotice: p.composerNotice,
    status: p.status ?? "beta",
    statusNote: p.statusNote,
    switchAccount: p.switchAccount,
    analytics: {
      post: !!(p.postMetrics && p.metrics?.post.length),
      account: !!(p.accountMetrics && p.metrics?.account.length),
      metrics: [...new Set([...(p.postMetrics ? p.metrics?.post ?? [] : []), ...(p.accountMetrics ? p.metrics?.account ?? [] : [])])],
    },
  };
}
