import { useEffect, useMemo } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { AccountAvatar } from "../../components/ProviderLogo";
import { SettingsForm, type UiFieldDef } from "../../components/SettingsForm";
import { api } from "../../lib/api";
import { cn, formatDuration } from "../../lib/format";
import { useMediaLookup } from "../../lib/mediaCache";
import type { AccountDTO, Provider } from "../../lib/types";
import { useFetch } from "../../lib/useFetch";

/** GET /api/accounts/:id/composer-info for TikTok (creator_info). */
interface CreatorInfo {
  nickname?: string | null;
  username?: string | null;
  privacyLevelOptions?: string[];
  commentDisabled?: boolean;
  duetDisabled?: boolean;
  stitchDisabled?: boolean;
  maxVideoPostDurationSec?: number | null;
}

const MUSIC = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const BRANDED = "https://www.tiktok.com/legal/page/global/bc-policy/en";
const PRIVATE_BRANDED = "Branded content visibility cannot be set to private.";

const truthy = (v: unknown) => v === true || v === "true";

/**
 * TikTok settings following TikTok's content sharing guidelines for Direct Post
 * (https://developers.tiktok.com/doc/content-sharing-guidelines): creator_info is read every time the settings show
 * (which account, privacy options, interactions turned off in the app, max video length), interactions are opt-in and
 * greyed out when the creator turned them off, photo posts only offer comments, and the commercial content disclosure
 * shows TikTok's exact labels, blocks private branded content and adapts the consent declaration.
 */
export function TikTokSettings({
  account,
  provider,
  values,
  onChange,
  errors,
  showErrors,
  media,
}: {
  account: AccountDTO;
  provider: Provider;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  errors: Record<string, string>;
  showErrors: boolean;
  media: string[];
}) {
  const info = useFetch(`composer-info:${account.id}`, () => api.accounts.composerInfo(account.id) as Promise<CreatorInfo>, ["accounts"]);
  const lookup = useMediaLookup(media);
  const items = media.map(lookup);
  const video = items.find((m) => m?.kind === "video");
  const photos = items.length > 0 && items.every((m) => m?.kind === "image");
  const c = info.data;
  const direct = values.postMode !== "inbox";
  const commercial = truthy(values.commercialContent);
  const organic = commercial && truthy(values.brandOrganic);
  const branded = commercial && truthy(values.brandContent);
  const privateChosen = values.privacy_level === "SELF_ONLY";

  // Interactions the creator turned off in the TikTok app can't be on.
  useEffect(() => {
    if (!c) return;
    if (c.commentDisabled && truthy(values.allowComment)) onChange("allowComment", false);
    if (c.duetDisabled && truthy(values.allowDuet)) onChange("allowDuet", false);
    if (c.stitchDisabled && truthy(values.allowStitch)) onChange("allowStitch", false);
  }, [c, values.allowComment, values.allowDuet, values.allowStitch]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = useMemo<UiFieldDef[]>(
    () =>
      provider.settingsFields
        .filter((f) => {
          // Photo posts: only "Allow comments" among the interactions; videos have no photo title or auto music.
          if (photos && ["allowDuet", "allowStitch", "aiGenerated", "coverTimestampMs"].includes(f.key)) return false;
          if (video && ["title", "autoAddMusic"].includes(f.key)) return false;
          return true;
        })
        .map((f): UiFieldDef => {
          const off = (disabled: boolean | undefined, what: string): UiFieldDef =>
            disabled ? { ...f, disabled: true, note: `${what} are turned off in this account's TikTok settings.` } : f;
          switch (f.key) {
            case "allowComment":
              return off(c?.commentDisabled, "Comments");
            case "allowDuet":
              return off(c?.duetDisabled, "Duets");
            case "allowStitch":
              return off(c?.stitchDisabled, "Stitches");
            case "privacy_level":
              return branded ? { ...f, disabledOptions: { SELF_ONLY: PRIVATE_BRANDED } } : f;
            case "brandContent":
              return privateChosen ? { ...f, disabled: !branded, note: PRIVATE_BRANDED } : f;
            default:
              return f;
          }
        }),
    [provider.settingsFields, c, photos, video, branded, privateChosen],
  );

  const tooLong = !!(direct && video?.duration && c?.maxVideoPostDurationSec && video.duration > c.maxVideoPostDurationSec);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5 rounded-lg bg-zinc-50 px-3 py-2 text-sm ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-700">
        <AccountAvatar account={account} provider={provider} size="sm" />
        <span className="min-w-0">
          <span className="text-zinc-500">Posting to </span>
          <span className="font-medium">{c?.nickname || account.name}</span>
          {(c?.username || account.username) && <span className="text-zinc-500"> @{(c?.username || account.username)!.replace(/^@/, "")}</span>}
        </span>
      </div>
      {info.error && (
        <Line tone="red">
          TikTok can&rsquo;t take a post from this account right now ({info.error.message}). Try again later.
        </Line>
      )}
      {tooLong && (
        <Line tone="red">
          This account can post videos up to {formatDuration(c!.maxVideoPostDurationSec!)}; this one is {formatDuration(video!.duration!)}. Trim it, or send it to the TikTok inbox as a draft.
        </Line>
      )}
      <SettingsForm fields={fields} values={values} onChange={onChange} accountId={account.id} errors={errors} showErrors={showErrors} />
      {direct && commercial && (
        <Line tone={organic || branded ? "zinc" : "red"}>
          {!organic && !branded
            ? "You need to indicate if your content promotes yourself, a third party, or both."
            : branded
              ? `Your ${photos ? "photo" : "video"} will be labeled as 'Paid partnership'`
              : `Your ${photos ? "photo" : "video"} will be labeled as 'Promotional content'`}
        </Line>
      )}
      <div className="space-y-1 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700">
        <p>
          {branded ? (
            <>
              By posting, you agree to TikTok&rsquo;s <A href={BRANDED}>Branded Content Policy</A> and <A href={MUSIC}>Music Usage Confirmation</A>.
            </>
          ) : (
            <>
              By posting, you agree to TikTok&rsquo;s <A href={MUSIC}>Music Usage Confirmation</A>.
            </>
          )}
        </p>
        <p>After publishing, it can take a few minutes for the post to appear on your profile.</p>
      </div>
    </div>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-brand-600 underline underline-offset-2 dark:text-brand-400">
      {children}
    </a>
  );
}

function Line({ tone, children }: { tone: "red" | "zinc"; children: React.ReactNode }) {
  const I = tone === "red" ? AlertTriangle : Info;
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
        tone === "red" ? "bg-red-50 text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900" : "bg-zinc-50 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-zinc-700",
      )}
    >
      <I className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
