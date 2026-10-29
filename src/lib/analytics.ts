/** Analytics helpers shared by the analytics page, the post drawer, the accounts page and the dashboard. */

import type { AnalyticsTotals, MetricKey, MetricValues, MetricsStatus } from "./types";
import { pad, zonedParts, zonedTime } from "./time";

export const RANGE_PRESETS = ["7d", "30d", "90d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number] | "custom";

export const PRESET_DAYS: Record<(typeof RANGE_PRESETS)[number], number> = { "7d": 7, "30d": 30, "90d": 90 };
const MAX_DAYS = 366;

export interface DayRange {
  /** Local midnight (tz) of the first day. */
  from: number;
  /** Local midnight (tz) after the last day (exclusive). */
  to: number;
  /** First / last day as YYYY-MM-DD (inclusive). */
  fromDay: string;
  toDay: string;
  days: number;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(s: string | null | undefined): s is string {
  return !!s && DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** Today as YYYY-MM-DD in tz. */
export function todayKey(tz: string, now = Date.now()): string {
  const p = zonedParts(now, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** YYYY-MM-DD shifted by n days (calendar arithmetic, no timezone involved). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Days from a to b inclusive. */
export function dayCount(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;
}

/**
 * A whole-day range in tz: the last N days including today for presets, the given days for custom (swapped if
 * reversed, clamped to 366 days, falling back to 30 days when invalid).
 */
export function resolveRange(preset: RangePreset, tz: string, custom?: { from?: string | null; to?: string | null }, now = Date.now()): DayRange {
  const today = todayKey(tz, now);
  let fromDay: string;
  let toDay: string;
  if (preset === "custom" && isDay(custom?.from) && isDay(custom?.to)) {
    [fromDay, toDay] = custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from];
    if (dayCount(fromDay, toDay) > MAX_DAYS) fromDay = shiftDay(toDay, -(MAX_DAYS - 1));
  } else {
    const n = preset === "custom" ? 30 : PRESET_DAYS[preset];
    toDay = today;
    fromDay = shiftDay(today, -(n - 1));
  }
  const at = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return zonedTime(y, m, d, 0, 0, tz);
  };
  return { from: at(fromDay), to: at(shiftDay(toDay, 1)), fromDay, toDay, days: dayCount(fromDay, toDay) };
}

/** "Oct 3" for a YYYY-MM-DD key (calendar date, no timezone shift). */
export function formatDayKey(day: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...opts }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Post-level metric keys in display order (account-level keys excluded). */
export const POST_METRIC_KEYS: MetricKey[] = ["views", "impressions", "reach", "likes", "comments", "replies", "shares", "reposts", "quotes", "saves", "clicks"];
export const ACCOUNT_METRIC_KEYS: MetricKey[] = ["followers", "following", "posts"];
/** Watch-time keys (YouTube Analytics): shown with their own units, never summed across posts. */
export const WATCH_METRIC_KEYS: MetricKey[] = ["watchTimeMinutes", "avgViewDurationSeconds", "avgViewPercentage"];

export const METRIC_LABELS: Record<MetricKey, string> = {
  views: "Views",
  impressions: "Impressions",
  reach: "Reach",
  likes: "Likes",
  comments: "Comments",
  replies: "Replies",
  shares: "Shares",
  reposts: "Reposts",
  quotes: "Quotes",
  saves: "Saves",
  clicks: "Clicks",
  followers: "Followers",
  following: "Following",
  posts: "Posts",
  watchTimeMinutes: "Watch time",
  avgViewDurationSeconds: "Avg. view duration",
  avgViewPercentage: "Avg. % viewed",
};

/** "2:05" (m:ss) or "1:02:05" for a duration in seconds. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Watch-time values with their units: "4.2h" / "35 min", "2:05", "41.3%". */
export function formatWatchMetric(key: MetricKey, v: number): string {
  if (key === "avgViewDurationSeconds") return formatDuration(v);
  if (key === "avgViewPercentage") return `${v.toFixed(1)}%`;
  if (key === "watchTimeMinutes") return v >= 120 ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" }).format(v / 60)}h` : `${Math.round(v)} min`;
  return String(v);
}

/** Readable names of YouTube traffic sources (insightTrafficSourceType); unknown values are title-cased. */
const TRAFFIC_LABELS: Record<string, string> = {
  ADVERTISING: "YouTube ads",
  ANNOTATION: "Annotations",
  CAMPAIGN_CARD: "Campaign cards",
  END_SCREEN: "End screens",
  EXT_URL: "External",
  HASHTAGS: "Hashtag pages",
  LIVE_REDIRECT: "Live redirects",
  NO_LINK_EMBEDDED: "Embedded (no link)",
  NO_LINK_OTHER: "Direct or unknown",
  NOTIFICATION: "Notifications",
  PLAYLIST: "Playlists",
  PRODUCT_PAGE: "Product pages",
  PROMOTED: "Promoted",
  RELATED_VIDEO: "Suggested videos",
  SHORTS: "Shorts feed",
  SOUND_PAGE: "Sound pages",
  SUBSCRIBER: "Browse features",
  YT_CHANNEL: "Channel pages",
  YT_OTHER_PAGE: "Other YouTube features",
  YT_SEARCH: "YouTube search",
  VIDEO_REMIXES: "Remixes",
  WATCH_WITH: "Watch with",
};

export function trafficSourceLabel(source: string): string {
  return TRAFFIC_LABELS[source] ?? source.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Which key a post's exposure (views / impressions / reach) comes from. */
export function exposureKey(m: MetricValues | null | undefined): "views" | "impressions" | "reach" | null {
  if (!m) return null;
  return m.views !== undefined ? "views" : m.impressions !== undefined ? "impressions" : m.reach !== undefined ? "reach" : null;
}

/** The exposure measure of a set of totals: views when any, else impressions, else reach. */
export function totalsExposure(t: Pick<AnalyticsTotals, "views" | "impressions" | "reach">): { key: "views" | "impressions" | "reach"; value: number } {
  if (t.views > 0) return { key: "views", value: t.views };
  if (t.impressions > 0) return { key: "impressions", value: t.impressions };
  if (t.reach > 0) return { key: "reach", value: t.reach };
  return { key: "views", value: 0 };
}

/** Relative change, null when there is no base. */
export function change(current: number, previous: number): number | null {
  if (!previous) return null;
  return (current - previous) / previous;
}

export const METRICS_STATUS_LABEL: Record<MetricsStatus, string> = {
  ok: "Analytics on",
  pending: "Collecting",
  reconnect_required: "Analytics: reconnect",
  not_supported: "No analytics",
  error: "Analytics error",
};

/** Clean axis ticks from 0 to ≥ max (3-5 ticks). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Ticks covering [min, max] (not necessarily from 0), for follower lines. */
export function rangeTicks(min: number, max: number, count = 3): number[] {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
