import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowBigDown,
  ArrowBigUp,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Forward,
  Globe,
  Heart,
  ImageOff,
  Link2,
  Lock,
  MessageCircle,
  MessageSquare,
  Music2,
  Play,
  Repeat2,
  Send,
  Share,
  SquareArrowOutUpRight,
  ThumbsUp,
  Users,
  VideoOff,
  X as Close,
  BarChart3,
} from "lucide-react";
import { xSplitAtLimit, xWeightedLength } from "@shared/xText";
import { cn, formatDuration } from "../../lib/format";
import { useMediaLookup } from "../../lib/mediaCache";
import type { AccountDTO, FieldOption, MediaDTO, Provider, ThreadItem } from "../../lib/types";
import { useFetch } from "../../lib/useFetch";
import { api } from "../../lib/api";
import { AccountAvatar, ProviderLogo } from "../ProviderLogo";
import { useOverlay } from "../ui/Dialog";
import { MediaThumb } from "./MediaThumb";

/** What a preview shows: the composer's current item or a stored post. */
export interface PreviewPost {
  content: string;
  media: string[];
  thread: ThreadItem[];
  settings: Record<string, unknown>;
}

interface Ctx {
  account: AccountDTO | undefined;
  provider: Provider;
  post: PreviewPost;
  /** Short time as the platform shows it ("2h", "Draft", the schedule). */
  time: string;
  name: string;
  handle: string;
  username: string;
  media: (id: string) => MediaDTO | undefined;
  open: (ids: string[], index: number) => void;
  str: (key: string) => string;
  bool: (key: string) => boolean;
  tags: (key: string) => string[];
  /** Label of a select value (static options, or the account's dynamic options). */
  label: (key: string, value: string) => string;
  /** The text split where it goes over the platform limit (X: weighted). */
  split: (text: string) => [string, string];
  threadLabel: string;
}

/**
 * How the post will look on its platform (same layouts as the iOS app's PostPreview.swift). Generic glyphs only, no
 * platform UI copied pixel for pixel. Media opens full screen on click.
 */
export function PlatformPreview({ account, provider, post, time }: { account: AccountDTO | undefined; provider: Provider; post: PreviewPost; time: string }) {
  const lookup = useMediaLookup([...post.media, ...post.thread.flatMap((t) => t.media)]);
  const [viewer, setViewer] = useState<{ ids: string[]; index: number } | null>(null);
  const dynamic = useDynamicLabels(account?.id, provider, post.settings);
  const name = account?.name ?? "Unknown account";
  const username = account?.username?.replace(/^@/, "") || name;
  const s = post.settings;
  const max = provider.capabilities.maxLength;
  const ctx: Ctx = {
    account,
    provider,
    post,
    time,
    name,
    username,
    handle: account?.username ? `@${username}` : provider.name,
    media: lookup,
    open: (ids, index) => setViewer({ ids, index }),
    str: (key) => {
      const v = s[key];
      if (v === undefined || v === null || v === "") return "";
      return Array.isArray(v) ? v.map(String).join(", ") : typeof v === "object" ? "" : String(v).trim();
    },
    bool: (key) => s[key] === true || s[key] === "true",
    tags: (key) => {
      const v = s[key];
      const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
      return list.map((t) => t.trim()).filter(Boolean);
    },
    label: (key, value) =>
      provider.settingsFields.find((f) => f.key === key)?.options?.find((o) => o.value === value)?.label ?? dynamic[key]?.find((o) => o.value === value)?.label ?? value,
    split: (text) => {
      if (provider.id === "x") return xSplitAtLimit(text, s.premium ? 25_000 : 280);
      const chars = Array.from(text);
      return max > 0 && chars.length > max ? [chars.slice(0, max).join(""), chars.slice(max).join("")] : [text, ""];
    },
    threadLabel: provider.capabilities.threadLabel ?? "Follow-ups",
  };

  const first = post.media[0] ? lookup(post.media[0]) : undefined;
  const singleVideo = post.media.length === 1 && first?.kind === "video";
  let body: ReactNode;
  switch (provider.id) {
    case "youtube":
      body = <YouTubePreview ctx={ctx} />;
      break;
    case "tiktok":
    case "tiktok_business":
      body = <ShortVideoPreview ctx={ctx} style="tiktok" />;
      break;
    case "instagram":
    case "instagram_standalone":
      body = ctx.str("post_type") === "story" ? <StoryPreview ctx={ctx} /> : singleVideo ? <ShortVideoPreview ctx={ctx} style="reel" /> : <InstagramPreview ctx={ctx} />;
      break;
    case "linkedin":
    case "linkedin_page":
    case "facebook":
      body = <FeedPreview ctx={ctx} />;
      break;
    case "pinterest":
      body = <PinPreview ctx={ctx} />;
      break;
    case "reddit":
    case "lemmy":
      body = <RedditPreview ctx={ctx} />;
      break;
    default:
      body =
        provider.id === "kick" && singleVideo ? (
          <ShortVideoPreview ctx={ctx} style="reel" />
        ) : provider.category === "blog" || provider.category === "newsletter" ? (
          <ArticlePreview ctx={ctx} />
        ) : provider.category === "video" ? (
          <YouTubePreview ctx={ctx} />
        ) : (
          <SocialPreview ctx={ctx} />
        );
  }

  return (
    <div className="overflow-hidden rounded-xl bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-800">
      <div className="flex items-center gap-1.5 border-b border-zinc-100 px-3 py-1.5 text-[11px] font-medium text-zinc-500 dark:border-zinc-800">
        <ProviderLogo provider={provider} size="xs" />
        {provider.name}
      </div>
      {body}
      {viewer && <Lightbox ctx={ctx} ids={viewer.ids} start={viewer.index} onClose={() => setViewer(null)} />}
    </div>
  );
}

/** Labels of dynamic select values the preview shows (Pinterest board, Reddit flair). */
function useDynamicLabels(accountId: string | undefined, provider: Provider, settings: Record<string, unknown>): Record<string, FieldOption[]> {
  const field = provider.settingsFields.find((f) => (f.key === "board" || f.key === "flair") && f.dynamicOptions && settings[f.key]);
  const key = field && accountId ? `options:${accountId}:${field.key}:${JSON.stringify(settings)}` : null;
  const res = useFetch(key, () => api.accounts.options(accountId!, field!.key, settings));
  return field && res.data ? { [field.key]: res.data } : {};
}

// ---------- shared pieces ----------

const muted = "text-zinc-500 dark:text-zinc-400";
const link = "text-sky-600 dark:text-sky-400";

function Avatar({ ctx, size = "md", ring }: { ctx: Ctx; size?: "xs" | "sm" | "md" | "lg"; ring?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 rounded-full", ring)}>
      <AccountAvatar account={ctx.account} provider={ctx.provider} size={size} showProvider={false} />
    </span>
  );
}

function linkify(s: string, tone: string) {
  return s.split(/(\s+)/).map((w, i) =>
    /^(#|@)\w/.test(w) || /^https?:\/\//.test(w) ? (
      <span key={i} className={tone}>
        {w}
      </span>
    ) : (
      w
    ),
  );
}

/**
 * Post text with hashtags, mentions and links coloured, the part over the limit marked, and long text collapsed to
 * `lines` with "more" (never collapsed while something is over the limit, so the mark stays visible).
 */
function RichText({ ctx, text, lines, lead, className, tone = link, empty = "No text" }: { ctx: Ctx; text: string; lines?: number; lead?: string; className?: string; tone?: string; empty?: string | null }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const [ok, over] = ctx.split(text);
  const clamp = !!lines && !open && !over;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && clamp) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [clamp, text, lines]);
  if (!text.trim()) return empty ? <p className={cn("text-sm italic", muted)}>{empty}</p> : null;
  return (
    <div className={className}>
      <p
        ref={ref}
        className="whitespace-pre-wrap break-words text-sm leading-relaxed"
        style={clamp ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" } : undefined}
      >
        {lead && <span className="mr-1 font-semibold">{lead}</span>}
        {linkify(ok, tone)}
        {over && <mark className="rounded-sm bg-red-200 text-red-900 dark:bg-red-900/70 dark:text-red-100">{over}</mark>}
      </p>
      {clamp && clamped && (
        <button type="button" onClick={() => setOpen(true)} className={cn("text-sm font-medium hover:underline", tone.includes("text-white") ? "text-white/75" : muted)}>
          more
        </button>
      )}
    </div>
  );
}

/** Characters used against the platform limit (X: weighted). */
function LimitCounter({ ctx, text }: { ctx: Ctx; text: string }) {
  const x = ctx.provider.id === "x";
  const limit = x ? (ctx.bool("premium") ? 25_000 : 280) : ctx.provider.capabilities.maxLength;
  if (!limit || !text) return null;
  const used = x ? xWeightedLength(text) : Array.from(text).length;
  return <span className={cn("text-[11px] tabular-nums", used > limit ? "font-bold text-red-600 dark:text-red-400" : muted)}>{`${used}/${limit}`}</span>;
}

function Icons({ icons, trailing = [], spread, className }: { icons: Array<typeof Heart>; trailing?: Array<typeof Heart>; spread?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cn("flex items-center", spread ? "justify-between" : "gap-4", muted, className)}>
      {icons.map((I, i) => (
        <I key={i} className="size-[18px]" />
      ))}
      {trailing.length > 0 && (
        <span className={cn("flex items-center gap-4", !spread && "ml-auto")}>
          {trailing.map((I, i) => (
            <I key={i} className="size-[18px]" />
          ))}
        </span>
      )}
    </div>
  );
}

/** Aspect ratio (width / height) of a media item, clamped to what feeds show. */
function ratio(m: MediaDTO | undefined, lo = 0.8, hi = 1.91, fallback = 1): number {
  if (!m?.width || !m.height) return fallback;
  return Math.min(Math.max(m.width / m.height, lo), hi);
}

/** One media cell: fills its box, opens the viewer on click. */
function Cell({ ctx, ids, index, full, badge = true, className }: { ctx: Ctx; ids: string[]; index: number; full?: boolean; badge?: boolean; className?: string }) {
  const m = ctx.media(ids[index]);
  return (
    <button type="button" onClick={() => ctx.open(ids, index)} className={cn("relative block size-full overflow-hidden bg-zinc-100 dark:bg-zinc-800", className)} aria-label="Open media full screen">
      <MediaThumb media={m} className="absolute inset-0 size-full" full={full ?? ids.length === 1} badge={badge} />
    </button>
  );
}

/** 1-4 media in the X / Facebook grid (+N on the fourth). */
function Grid({ ctx, ids, rounded = "rounded-2xl" }: { ctx: Ctx; ids: string[]; rounded?: string }) {
  if (!ids.length) return null;
  const shown = ids.slice(0, 4);
  const frame = cn("overflow-hidden ring-1 ring-zinc-200 dark:ring-zinc-700", rounded);
  if (shown.length === 1)
    return (
      <div className={frame} style={{ aspectRatio: ratio(ctx.media(ids[0])) }}>
        <Cell ctx={ctx} ids={ids} index={0} />
      </div>
    );
  return (
    <div className={cn(frame, "grid aspect-video gap-0.5", shown.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2")}>
      {shown.map((_, i) => (
        <div key={i} className={cn("relative min-h-0", shown.length === 3 && i === 0 && "row-span-2")}>
          <Cell ctx={ctx} ids={ids} index={i} />
          {i === 3 && ids.length > 4 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white">+{ids.length - 4}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Swipeable media (Instagram carousel, Pinterest, TikTok photos) with a page counter and dots. */
function Carousel({ ctx, ids, aspect, dots = true, className }: { ctx: Ctx; ids: string[]; aspect: number; dots?: boolean; className?: string }) {
  const [page, setPage] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const go = (i: number) => ref.current?.scrollTo({ left: i * ref.current.clientWidth, behavior: "smooth" });
  return (
    <div className={className}>
      <div className="group relative" style={{ aspectRatio: aspect }}>
        <div
          ref={ref}
          onScroll={(e) => setPage(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
          className="flex size-full snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {ids.map((id, i) => (
            <div key={`${id}-${i}`} className="relative size-full shrink-0 snap-center">
              <Cell ctx={ctx} ids={ids} index={i} full />
            </div>
          ))}
        </div>
        {ids.length > 1 && (
          <>
            <span className="pointer-events-none absolute right-2.5 top-2.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
              {page + 1}/{ids.length}
            </span>
            {page > 0 && <CarouselArrow side="left" onClick={() => go(page - 1)} />}
            {page < ids.length - 1 && <CarouselArrow side="right" onClick={() => go(page + 1)} />}
          </>
        )}
      </div>
      {dots && ids.length > 1 && (
        <div aria-hidden className="mt-2 flex justify-center gap-1">
          {ids.map((_, i) => (
            <span key={i} className={cn("size-1.5 rounded-full", i === page ? "bg-sky-500" : "bg-zinc-300 dark:bg-zinc-600")} />
          ))}
        </div>
      )}
    </div>
  );
}

function CarouselArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const I = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous" : "Next"}
      className={cn(
        "absolute top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-zinc-800 opacity-0 shadow transition group-hover:opacity-100 focus-visible:opacity-100",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <I className="size-4" />
    </button>
  );
}

function NoMedia({ text, className, dark }: { text: string; className?: string; dark?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 text-sm", dark ? "text-white/70" : cn("bg-zinc-100 dark:bg-zinc-800", muted), className)}>
      <ImageOff className="size-5" />
      {text}
    </div>
  );
}

/** Follow-up items as comments under the post. */
function Comments({ ctx, items }: { ctx: Ctx; items: ThreadItem[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-3">
      <p className={cn("text-xs font-semibold", muted)}>{ctx.threadLabel}</p>
      {items.map((t, i) => (
        <div key={i} className="flex gap-2.5">
          <Avatar ctx={ctx} size="sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs font-semibold">{ctx.username}</p>
            <RichText ctx={ctx} text={t.content} lines={4} empty={t.media.length ? null : "Media only"} />
            <Grid ctx={ctx} ids={t.media} rounded="rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold dark:bg-zinc-800", className)}>{children}</span>;
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function LinkCard({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-zinc-100/70 p-2 dark:bg-zinc-800/60">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-zinc-200/70 dark:bg-zinc-700">
        <Link2 className={cn("size-4", muted)} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold">{host(url)}</span>
        <span className={cn("block truncate text-xs", muted)}>{url}</span>
      </span>
    </div>
  );
}

// ---------- YouTube (and other video platforms) ----------

function YouTubePreview({ ctx }: { ctx: Ctx }) {
  const first = ctx.post.media[0] ? ctx.media(ctx.post.media[0]) : undefined;
  const short = ctx.bool("shorts") || (!!first?.height && !!first.width && first.height > first.width);
  const title = ctx.str("title");
  const privacy = ctx.str("privacy");
  const PrivacyIcon = privacy === "public" ? Globe : privacy === "unlisted" ? Link2 : Lock;
  const tags = ctx.tags("tags");
  return (
    <div>
      <div className="flex aspect-video items-center justify-center bg-black">
        {first ? (
          <div className={cn("h-full", short ? "aspect-[9/16]" : "w-full")}>
            <Cell ctx={ctx} ids={ctx.post.media} index={0} full className="bg-black" />
          </div>
        ) : (
          <span className="flex items-center gap-2 text-sm text-white/70">
            <VideoOff className="size-4" /> No video
          </span>
        )}
      </div>
      <div className="space-y-3 p-4">
        <div className="space-y-1.5">
          {title ? (
            <h3 className="text-base font-bold leading-snug">{title + (ctx.bool("shorts") && !/#shorts/i.test(title) ? " #Shorts" : "")}</h3>
          ) : (
            <h3 className={cn("text-base font-bold italic", muted)}>No title</h3>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {privacy && (
              <Pill>
                <PrivacyIcon className={cn("size-3", muted)} />
                {ctx.label("privacy", privacy)}
              </Pill>
            )}
            {ctx.bool("shorts") && <Pill>Short</Pill>}
            <span className={cn("text-xs", muted)}>{ctx.time}</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <Avatar ctx={ctx} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{ctx.name}</p>
            <p className={cn("truncate text-xs", muted)}>{ctx.handle}</p>
          </div>
          <span aria-hidden className="rounded-full bg-zinc-900 px-3.5 py-1.5 text-xs font-semibold text-white dark:bg-white dark:text-zinc-900">
            Subscribe
          </span>
        </div>
        <div className="space-y-1.5 rounded-xl bg-zinc-100 p-3 dark:bg-zinc-800/70">
          {tags.length > 0 && (
            <p className={cn("truncate text-xs font-semibold", link)}>
              {tags
                .slice(0, 6)
                .map((t) => "#" + t.replace(/\s+/g, ""))
                .join(" ")}
            </p>
          )}
          <RichText ctx={ctx} text={ctx.post.content} lines={3} />
        </div>
        {ctx.post.thread.length > 0 && (
          <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <Comments ctx={ctx} items={ctx.post.thread} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- TikTok, Reels ----------

function ShortVideoPreview({ ctx, style }: { ctx: Ctx; style: "tiktok" | "reel" }) {
  const ids = ctx.post.media;
  const first = ids[0] ? ctx.media(ids[0]) : undefined;
  const video = first?.kind === "video";
  // TikTok's title setting is for photo posts only.
  const title = style === "tiktok" && !video ? ctx.str("title") : "";
  const rail = style === "tiktok" ? [Heart, MessageCircle, Bookmark, Forward] : [Heart, MessageCircle, Send, Ellipsis];
  return (
    <div className="flex justify-center bg-zinc-50 px-4 py-4 dark:bg-zinc-950/40">
      <div className="relative aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-2xl bg-black text-white">
        {ids.length > 1 ? (
          <Carousel ctx={ctx} ids={ids} aspect={9 / 16} dots={false} className="size-full" />
        ) : ids.length ? (
          <>
            <Cell ctx={ctx} ids={ids} index={0} badge={false} full className="bg-black" />
            {video && <Play aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 fill-white/85 text-white/85 drop-shadow" />}
            {video && !!first?.duration && (
              <span className="pointer-events-none absolute right-2.5 top-2.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">{formatDuration(first.duration)}</span>
            )}
          </>
        ) : (
          <NoMedia text="No video" dark className="size-full" />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-b from-transparent via-black/55 to-black/85" />
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-3 p-3 [text-shadow:0_1px_2px_rgba(0,0,0,.5)]">
          <div className="max-h-[55%] min-w-0 flex-1 space-y-1 overflow-y-auto [scrollbar-width:none]">
            {style === "reel" ? (
              <div className="flex items-center gap-2">
                <Avatar ctx={ctx} size="xs" />
                <span className="text-xs font-semibold">{ctx.username}</span>
              </div>
            ) : (
              <p className="text-xs font-semibold">@{ctx.username}</p>
            )}
            {title && <p className="text-xs font-bold">{title}</p>}
            <div className="text-xs [&_p]:text-xs [&_p]:font-medium">
              <RichText ctx={ctx} text={ctx.post.content} lines={2} tone="font-semibold text-white" empty="No text" />
            </div>
            <p aria-hidden className="flex items-center gap-1 truncate text-[11px]">
              <Music2 className="size-3 shrink-0" />
              {style === "tiktok" ? `Original sound · ${ctx.name}` : ctx.name}
            </p>
          </div>
          <div aria-hidden className="flex flex-col items-center gap-4 pb-1">
            {style === "tiktok" && <Avatar ctx={ctx} size="sm" ring="ring-[1.5px] ring-white" />}
            {rail.map((I, i) => (
              <I key={i} className={cn("size-5", style === "tiktok" && i < 3 && "fill-white")} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Instagram ----------

function InstagramPreview({ ctx }: { ctx: Ctx }) {
  const ids = ctx.post.media;
  const collaborators = ctx.tags("collaborators").map((c) => (c.startsWith("@") ? c : "@" + c));
  return (
    <div>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Avatar ctx={ctx} size="sm" ring="p-[2px] bg-[conic-gradient(#facc15,#f97316,#ec4899,#a855f7,#facc15)] [&>span]:ring-2 [&>span]:ring-white dark:[&>span]:ring-zinc-900 [&>span]:rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{ctx.username}</p>
          {collaborators.length > 0 && <p className={cn("truncate text-xs", muted)}>with {new Intl.ListFormat("en", { type: "conjunction" }).format(collaborators)}</p>}
        </div>
        <Ellipsis aria-hidden className={cn("size-4", muted)} />
      </div>
      {ids.length ? <Carousel ctx={ctx} ids={ids} aspect={ratio(ctx.media(ids[0]))} /> : <NoMedia text="Instagram needs a photo or video." className="h-40" />}
      <div className="space-y-2 px-3 pb-3 pt-2.5">
        <Icons icons={[Heart, MessageCircle, Send]} trailing={[Bookmark]} />
        <RichText ctx={ctx} text={ctx.post.content} lines={2} lead={ctx.post.content.trim() ? ctx.username : undefined} />
        {ctx.post.thread.length > 0 && (
          <div className="pt-1">
            <Comments ctx={ctx} items={ctx.post.thread} />
          </div>
        )}
        <p className={cn("text-xs", muted)}>{ctx.time}</p>
      </div>
    </div>
  );
}

function StoryPreview({ ctx }: { ctx: Ctx }) {
  const ids = ctx.post.media;
  return (
    <div className="flex flex-col items-center gap-2 bg-zinc-50 px-4 py-4 dark:bg-zinc-950/40">
      <div className="relative aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-2xl bg-black text-white">
        {ids.length ? <Carousel ctx={ctx} ids={ids} aspect={9 / 16} dots={false} className="size-full" /> : <NoMedia text="No media" dark className="size-full" />}
        <div className="pointer-events-none absolute inset-x-0 top-0 space-y-2.5 bg-gradient-to-b from-black/40 to-transparent p-2.5 [text-shadow:0_1px_2px_rgba(0,0,0,.5)]">
          <div className="flex gap-0.5">
            {(ids.length ? ids : [""]).map((_, i) => (
              <span key={i} className={cn("h-[2.5px] flex-1 rounded-full", i === 0 ? "bg-white/95" : "bg-white/35")} />
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Avatar ctx={ctx} size="xs" />
            <span className="font-semibold">{ctx.username}</span>
            <span className="opacity-70">{ctx.time}</span>
          </div>
        </div>
      </div>
      <p className={cn("text-[11px]", muted)}>Stories don't show the caption.</p>
    </div>
  );
}

// ---------- X, Threads, Bluesky, Mastodon ... ----------

function SocialPreview({ ctx }: { ctx: Ctx }) {
  const items: ThreadItem[] = [{ content: ctx.post.content, media: ctx.post.media }, ...ctx.post.thread];
  const textRequired = ctx.provider.capabilities.text === "required";
  const textless = ctx.provider.capabilities.text === "none";
  return (
    <div className="p-4">
      {items.map((t, i) => {
        const last = i === items.length - 1;
        return (
          <div key={i} className="flex gap-2.5">
            <div className="flex flex-col items-center gap-1">
              <Avatar ctx={ctx} size="md" />
              {!last && <span className="w-0.5 flex-1 rounded-full bg-zinc-200 dark:bg-zinc-700" />}
            </div>
            <div className={cn("min-w-0 flex-1 space-y-1.5", !last && "pb-4")}>
              <div className="flex min-w-0 items-baseline gap-1 text-sm">
                <span className="truncate font-bold">{ctx.name}</span>
                <span className={cn("truncate", muted)}>{ctx.handle}</span>
                <span className={cn("shrink-0", muted)}>· {ctx.time}</span>
              </div>
              {!textless && <RichText ctx={ctx} text={t.content} lines={8} empty={t.media.length && !(i === 0 && textRequired) ? null : "No text"} />}
              <Grid ctx={ctx} ids={t.media} />
              <div className="flex items-center gap-3 pt-0.5">
                <Icons icons={[MessageCircle, Repeat2, Heart, BarChart3]} trailing={[Share]} spread className="flex-1 [&>span]:ml-0" />
                <LimitCounter ctx={ctx} text={t.content} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- LinkedIn, Facebook ----------

function FeedPreview({ ctx }: { ctx: Ctx }) {
  const facebook = ctx.provider.id === "facebook";
  const title = ctx.str(facebook ? "title" : "mediaTitle");
  const url = facebook ? ctx.str("url") : "";
  const Visibility = ctx.str("visibility") === "CONNECTIONS" ? Users : Globe;
  const reactions: Array<[string, typeof Heart]> = [
    ["Like", ThumbsUp],
    ["Comment", MessageSquare],
    facebook ? ["Share", Forward] : ["Repost", Repeat2],
  ];
  return (
    <div className="pb-2.5">
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <Avatar ctx={ctx} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{ctx.name}</p>
          <p className={cn("flex items-center gap-1 text-xs", muted)}>
            {ctx.time} · <Visibility className="size-3" />
          </p>
        </div>
        <Ellipsis aria-hidden className={cn("size-4", muted)} />
      </div>
      <div className="space-y-1.5 px-4 py-2.5">
        {title && ctx.post.media.length > 0 && <p className="text-sm font-semibold">{title}</p>}
        <RichText ctx={ctx} text={ctx.post.content} lines={3} />
      </div>
      {ctx.post.media.length > 0 ? (
        <Grid ctx={ctx} ids={ctx.post.media} rounded="rounded-none ring-0 border-y border-zinc-100 dark:border-zinc-800" />
      ) : (
        url && (
          <div className="px-4 pb-1">
            <LinkCard url={url} />
          </div>
        )
      )}
      <div aria-hidden className={cn("mx-4 mt-2 flex border-t border-zinc-100 pt-2 text-xs font-semibold dark:border-zinc-800", muted)}>
        {reactions.map(([label, I]) => (
          <span key={label} className="flex flex-1 items-center justify-center gap-1.5">
            <I className="size-4" /> {label}
          </span>
        ))}
      </div>
      {ctx.post.thread.length > 0 && (
        <div className="px-4 pt-3">
          <Comments ctx={ctx} items={ctx.post.thread} />
        </div>
      )}
    </div>
  );
}

// ---------- Pinterest ----------

function PinPreview({ ctx }: { ctx: Ctx }) {
  const ids = ctx.post.media;
  const title = ctx.str("title");
  const url = ctx.str("link");
  const board = ctx.str("board");
  return (
    <div className="space-y-2.5 p-4">
      {ids.length ? (
        <Carousel ctx={ctx} ids={ids} aspect={ratio(ctx.media(ids[0]), 0.66, 1.2)} className="overflow-hidden rounded-2xl [&>div:first-child]:overflow-hidden [&>div:first-child]:rounded-2xl" />
      ) : (
        <NoMedia text="Pinterest needs an image or a video." className="h-48 rounded-2xl" />
      )}
      <div className="flex items-center gap-4">
        <Icons icons={[Heart, MessageCircle, Share, Ellipsis]} />
        <span aria-hidden className="ml-auto rounded-full bg-[#BD081C] px-3.5 py-1.5 text-xs font-semibold text-white">
          Save
        </span>
      </div>
      {title && <h3 className="text-lg font-bold leading-snug">{title}</h3>}
      <RichText ctx={ctx} text={ctx.post.content} lines={3} empty={null} />
      {url && (
        <p className="flex items-center gap-1.5 truncate text-xs font-semibold">
          <SquareArrowOutUpRight className="size-3.5 shrink-0" />
          {host(url)}
        </p>
      )}
      <div className="flex items-center gap-2 text-xs">
        <Avatar ctx={ctx} size="sm" />
        <span className="font-semibold">{ctx.name}</span>
        {board && <span className={cn("truncate", muted)}>· {ctx.label("board", board)}</span>}
      </div>
    </div>
  );
}

// ---------- Reddit, Lemmy ----------

function RedditPreview({ ctx }: { ctx: Ctx }) {
  const sub = ctx.str("subreddit") || ctx.str("community");
  const title = ctx.str("title");
  const flair = ctx.str("flair");
  const url = ctx.str("url");
  return (
    <div className="space-y-2 p-4">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Avatar ctx={ctx} size="xs" />
        {sub && <span className="font-semibold">{sub.startsWith("r/") || ctx.provider.id !== "reddit" ? sub : `r/${sub}`}</span>}
        <span className={cn("truncate", muted)}>
          u/{ctx.username} · {ctx.time}
        </span>
      </div>
      {title && <h3 className="text-base font-bold leading-snug">{title}</h3>}
      {(flair || ctx.bool("nsfw") || ctx.bool("spoiler")) && (
        <div className="flex flex-wrap gap-1.5">
          {flair && <Pill className="text-[11px]">{ctx.label("flair", flair)}</Pill>}
          {ctx.bool("nsfw") && <Pill className="bg-red-100 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300">NSFW</Pill>}
          {ctx.bool("spoiler") && <Pill className="text-[11px]">Spoiler</Pill>}
        </div>
      )}
      {url && <LinkCard url={url} />}
      <RichText ctx={ctx} text={ctx.post.content} lines={6} empty={null} />
      <Grid ctx={ctx} ids={ctx.post.media} />
      <Icons icons={[ArrowBigUp, ArrowBigDown, MessageCircle, Share]} className="pt-0.5" />
      {ctx.post.thread.length > 0 && (
        <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <Comments ctx={ctx} items={ctx.post.thread} />
        </div>
      )}
    </div>
  );
}

// ---------- Blogs, newsletters ----------

function ArticlePreview({ ctx }: { ctx: Ctx }) {
  const title = ctx.str("title");
  const tags = ctx.tags("tags");
  return (
    <div className="space-y-3 p-4">
      {ctx.post.media.length > 0 && (
        <div className="aspect-[1.91] overflow-hidden rounded-xl">
          <Cell ctx={ctx} ids={ctx.post.media} index={0} full />
        </div>
      )}
      {title && <h3 className="text-xl font-bold leading-snug">{title}</h3>}
      <div className="flex items-center gap-2 text-xs">
        <Avatar ctx={ctx} size="sm" />
        <span className="font-semibold">{ctx.name}</span>
        <span className={muted}>· {ctx.time}</span>
      </div>
      <RichText ctx={ctx} text={ctx.post.content} lines={10} />
      {tags.length > 0 && <p className={cn("text-xs", muted)}>{tags.map((t) => `#${t}`).join(" ")}</p>}
    </div>
  );
}

// ---------- full screen viewer ----------

function Lightbox({ ctx, ids, start, onClose }: { ctx: Ctx; ids: string[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const panel = useRef<HTMLDivElement>(null);
  useOverlay(true, onClose, panel);
  const prev = () => setIndex((i) => (i - 1 + ids.length) % ids.length);
  const next = () => setIndex((i) => (i + 1) % ids.length);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ids.length < 2) return;
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ids.length]);
  const m = ctx.media(ids[index]);
  const button = "flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20";
  return createPortal(
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal aria-label="Media" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 focus:outline-none" onClick={onClose}>
      <div className="flex max-h-[92vh] max-w-[92vw] items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {!m ? (
          <ImageOff className="size-8 text-white/60" />
        ) : m.kind === "video" ? (
          <video key={m.id} src={m.url} controls autoPlay playsInline className="max-h-[92vh] max-w-[92vw]" />
        ) : (
          <img key={m.id} src={m.url} alt={m.alt ?? ""} className="max-h-[92vh] max-w-[92vw] object-contain" />
        )}
      </div>
      <button type="button" aria-label="Close" onClick={onClose} className={cn(button, "absolute right-4 top-4")} data-autofocus>
        <Close className="size-5" />
      </button>
      {ids.length > 1 && (
        <>
          <button type="button" aria-label="Previous" onClick={(e) => (e.stopPropagation(), prev())} className={cn(button, "absolute left-4 top-1/2 -translate-y-1/2")}>
            <ChevronLeft className="size-5" />
          </button>
          <button type="button" aria-label="Next" onClick={(e) => (e.stopPropagation(), next())} className={cn(button, "absolute right-4 top-1/2 -translate-y-1/2")}>
            <ChevronRight className="size-5" />
          </button>
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-white">
            {index + 1} / {ids.length}
          </span>
        </>
      )}
    </div>,
    document.body,
  );
}
