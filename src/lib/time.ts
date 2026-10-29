/** Date helpers that work in an arbitrary IANA timezone (the app setting) rather than the browser zone. */

export const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function zonedParts(ts: number, tz: string): ZonedParts {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    partsFormatters.set(tz, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: WEEKDAYS.indexOf(out.weekday),
  };
}

function offset(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(ts / 60000) * 60000;
}

/** Epoch ms of a wall-clock time in `tz`. Month is 1-12; overflowing days/hours roll over. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - offset(guess, tz);
  const o2 = offset(ts, tz);
  ts = guess - o2;
  return ts;
}

/** Day key "YYYY-MM-DD" of a timestamp in tz. */
export function dayKey(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Midnight (in tz) of the day containing ts. */
export function startOfDay(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return zonedTime(p.year, p.month, p.day, 0, 0, tz);
}

export function addDays(ts: number, days: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return zonedTime(p.year, p.month, p.day + days, p.hour, p.minute, tz);
}

/** "YYYY-MM-DDTHH:mm" value for <input type="datetime-local"> in tz. */
export function toLocalInput(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function fromLocalInput(value: string, tz: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return zonedTime(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}

export function formatDateTime(ts: number, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  }).format(new Date(ts));
}

export function formatTime(ts: number, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ts));
}

export function formatDate(ts: number, tz: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(new Date(ts));
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 864e5],
    ["month", 30 * 864e5],
    ["week", 7 * 864e5],
    ["day", 864e5],
    ["hour", 36e5],
    ["minute", 6e4],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return diff > 30_000 ? "in a moment" : "just now";
}

export function timezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const list = intl.supportedValuesOf?.("timeZone") ?? [browserTimezone, "UTC"];
  return list.includes("UTC") ? list : ["UTC", ...list];
}
