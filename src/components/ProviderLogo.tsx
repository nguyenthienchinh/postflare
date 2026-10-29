import { useState } from "react";
import { Webhook } from "lucide-react";
import {
  siBluesky,
  siDevdotto,
  siDiscord,
  siDribbble,
  siFacebook,
  siFarcaster,
  siGoogle,
  siGooglemaps,
  siHashnode,
  siInstagram,
  siKick,
  siLemmy,
  siListmonk,
  siMastodon,
  siMedium,
  siMewe,
  siPinterest,
  siReddit,
  siTelegram,
  siThreads,
  siTiktok,
  siTumblr,
  siTwitch,
  siVk,
  siWordpress,
  siX,
  siYoutube,
  type SimpleIcon,
} from "simple-icons";
import type { AccountDTO, ProviderInfo } from "../lib/types";
import { cn } from "../lib/format";

/** Only the icons our providers use, so the bundle does not ship all of simple-icons. */
const ICONS: Record<string, SimpleIcon> = Object.fromEntries(
  [
    siBluesky, siDevdotto, siDiscord, siDribbble, siFacebook, siFarcaster, siGoogle, siGooglemaps, siHashnode, siInstagram,
    siKick, siLemmy, siListmonk, siMastodon, siMedium, siMewe, siPinterest, siReddit, siTelegram, siThreads, siTiktok,
    siTumblr, siTwitch, siVk, siWordpress, siX, siYoutube,
  ].map((i) => [i.slug, i]),
);

/** Fallback by provider id when the provider has no (known) icon slug. */
const BY_ID: Record<string, string> = { gmb: "google", tiktok_business: "tiktok", instagram_standalone: "instagram", linkedin_page: "" };

type LogoProvider = Pick<ProviderInfo, "id" | "name" | "color" | "icon">;

const SIZES = { xs: "size-4 rounded", sm: "size-5 rounded-md", md: "size-7 rounded-lg", lg: "size-9 rounded-lg", xl: "size-11 rounded-xl" };
const INNER = { xs: "size-2.5", sm: "size-3", md: "size-4", lg: "size-5", xl: "size-6" };
const TEXT = { xs: "text-[9px]", sm: "text-[10px]", md: "text-xs", lg: "text-sm", xl: "text-base" };

export function ProviderLogo({
  provider,
  size = "md",
  className,
}: {
  provider: LogoProvider | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (!provider) return <span className={cn("inline-block bg-zinc-300 dark:bg-zinc-700", SIZES[size], className)} />;
  const icon = ICONS[provider.icon ?? ""] ?? ICONS[BY_ID[provider.id] ?? ""];
  const color = `#${provider.color || "71717a"}`;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center text-white ring-1 ring-black/5 dark:ring-white/10", SIZES[size], className)}
      style={{ backgroundColor: color }}
      title={provider.name}
    >
      {icon ? (
        <svg viewBox="0 0 24 24" className={INNER[size]} fill="currentColor" aria-hidden>
          <path d={icon.path} />
        </svg>
      ) : provider.id === "webhook" ? (
        <Webhook className={INNER[size]} />
      ) : (
        <span className={cn("font-semibold leading-none", TEXT[size])}>{provider.name.charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

const AVATAR = { xs: "size-5", sm: "size-7", md: "size-9", lg: "size-11", xl: "size-14" };
const BADGE = { xs: "xs", sm: "xs", md: "xs", lg: "sm", xl: "sm" } as const;
const INITIALS = { xs: "text-[8px]", sm: "text-[10px]", md: "text-xs", lg: "text-sm", xl: "text-base" };

export function AccountAvatar({
  account,
  provider,
  size = "md",
  showProvider = true,
  className,
}: {
  account: Pick<AccountDTO, "name" | "avatarUrl"> | undefined;
  provider?: LogoProvider;
  size?: keyof typeof AVATAR;
  showProvider?: boolean;
  className?: string;
}) {
  // Per URL: a refreshed avatar (copied to our storage) gets another chance after the old link failed.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = !!account?.avatarUrl && failedUrl === account.avatarUrl;
  const name = account?.name ?? "?";
  const initials = name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className={cn("relative inline-flex shrink-0", AVATAR[size], className)}>
      {account?.avatarUrl && !failed ? (
        <img
          src={account.avatarUrl}
          alt=""
          className="size-full rounded-full object-cover ring-1 ring-black/5 dark:ring-white/10"
          onError={() => setFailedUrl(account.avatarUrl)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          className={cn("flex size-full items-center justify-center rounded-full font-semibold text-white", INITIALS[size])}
          style={{ backgroundColor: `#${provider?.color || "71717a"}` }}
        >
          {initials}
        </span>
      )}
      {showProvider && provider && (
        <ProviderLogo provider={provider} size={BADGE[size]} className="absolute -bottom-1 -right-1 ring-2 ring-white dark:ring-zinc-900" />
      )}
    </span>
  );
}
