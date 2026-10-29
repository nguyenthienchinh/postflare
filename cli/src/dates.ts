// Natural date parsing for --at / --from / --to. Local time unless the input has an offset (ISO with Z or +02:00).

import { UsageError } from "./errors.js";

const UNITS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

const WEEKDAYS = new Map<string, number>();
["sun sunday", "mon monday", "tue tues tuesday", "wed weds wednesday", "thu thur thurs thursday", "fri friday", "sat saturday"].forEach((names, i) => {
  for (const n of names.split(" ")) WEEKDAYS.set(n, i);
});

/** "9", "9:30", "09:30", "9am", "9:30 pm", "21:15" → [hours, minutes] or null. */
export function parseClock(s: string): [number, number] | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (!m[2] && !ap) return null; // a bare number is ambiguous
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return [h, min];
}

const at = (base: Date, [h, m]: [number, number], addDays = 0) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, h, m, 0, 0);

export interface ParseOptions {
  /** Reference time (tests). */
  now?: Date;
  /** Time used for "tomorrow", "mon", "2026-10-14" without a clock. Default: 09:00 (for --at) */
  defaultClock?: [number, number];
  /** Bare relative durations ("7d", "2h") mean that long AGO (ranges) instead of being rejected. */
  relativePast?: boolean;
}

/**
 * Parse a point in time. Accepts:
 * "now", "in 30m" / "in 2 hours" / "+3d", "today 18:00", "tomorrow 9:00", "tomorrow 9am", "mon 18:00", "next fri 10:00",
 * "18:00" (today, or tomorrow when already past), "2026-10-14 09:00" / "2026-10-14T09:00" (local), "2026-10-14",
 * ISO dates with an offset ("2026-10-14T09:00:00Z"), ms timestamps; with `relativePast`: "7d", "12h", "yesterday".
 * Returns ms since the epoch.
 */
export function parseTime(input: string, opts: ParseOptions = {}): number {
  const now = opts.now ?? new Date();
  const clock = opts.defaultClock ?? [9, 0];
  const raw = input.trim();
  const s = raw.toLowerCase().replace(/\s+/g, " ");
  const fail = (hint = "") =>
    new UsageError(
      `Cannot understand the date "${input}"${hint}. Examples: "now", "in 2h", "tomorrow 9:00", "mon 18:00", "2026-10-14 09:00", "2026-10-14T09:00:00Z"`,
    );
  if (!s) throw fail();
  if (s === "now") return now.getTime();

  // Relative: "in 2h", "+90m", "in 1 day"; ranges also take "7d" (ago) and "-7d".
  let m = /^(in |\+|-)?\s*(\d+(?:\.\d+)?)\s*([a-z]+)( ago)?$/.exec(s);
  if (m && Object.hasOwn(UNITS, m[3])) {
    const ms = Number(m[2]) * UNITS[m[3]];
    const future = m[1] === "in " || m[1] === "+";
    const past = m[1] === "-" || !!m[4] || (!m[1] && opts.relativePast);
    if (future && !m[4]) return now.getTime() + ms;
    if (past) return now.getTime() - ms;
    throw fail(` (did you mean "in ${m[2]}${m[3]}"?)`);
  }

  // Epoch milliseconds.
  if (/^\d{12,}$/.test(s)) return Number(s);

  // today / tomorrow / yesterday [clock]
  m = /^(today|tomorrow|tmrw|yesterday)(?: (?:at )?(.+))?$/.exec(s);
  if (m) {
    const cl = m[2] ? parseClock(m[2]) : m[1] === "today" || m[1] === "yesterday" ? (opts.relativePast ? [0, 0] as [number, number] : clock) : clock;
    if (!cl) throw fail();
    return at(now, cl, m[1] === "today" ? 0 : m[1] === "yesterday" ? -1 : 1).getTime();
  }

  // [next] weekday [clock]
  m = /^(next )?([a-z]+)(?: (?:at )?(.+))?$/.exec(s);
  if (m) {
    const idx = WEEKDAYS.get(m[2]);
    if (idx !== undefined) {
      const cl = m[3] ? parseClock(m[3]) : clock;
      if (!cl) throw fail();
      let add = (idx - now.getDay() + 7) % 7;
      if (m[1] && add === 0) add = 7;
      let d = at(now, cl, add);
      if (d.getTime() <= now.getTime()) d = at(now, cl, add + 7);
      return d.getTime();
    }
  }

  // Clock only: today, or tomorrow when already past.
  const cl = parseClock(s);
  if (cl) {
    const d = at(now, cl);
    return (d.getTime() <= now.getTime() ? at(now, cl, 1) : d).getTime();
  }

  // Local date [time]: 2026-10-14, 2026-10-14 09:00, 2026-10-14T09:00[:ss]
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}[:.]\d{2}(?::\d{2})?(?: ?[ap]m)?))?$/.exec(s);
  if (m) {
    let c: [number, number] | null = clock;
    let sec = 0;
    if (m[4]) {
      const parts = /^(\d{1,2}[:.]\d{2})(?::(\d{2}))?( ?[ap]m)?$/.exec(m[4])!;
      c = parseClock(parts[1] + (parts[3] ?? ""));
      sec = Number(parts[2] ?? 0);
    } else if (opts.relativePast) c = [0, 0];
    if (!c) throw fail();
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), c[0], c[1], sec, 0);
    if (d.getMonth() !== Number(m[2]) - 1) throw fail(" (no such day)");
    return d.getTime();
  }

  // Anything else with an explicit offset/zone: ISO 8601.
  if (/^\d{4}-\d{2}-\d{2}t[\d:.]+(z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  throw fail();
}

/** --at: a future time (a few seconds of slack). */
export function parseFuture(input: string, opts: ParseOptions = {}): number {
  const now = opts.now ?? new Date();
  const ms = parseTime(input, opts);
  if (ms < now.getTime() - 60_000) {
    throw new UsageError(`"${input}" is in the past (${new Date(ms).toLocaleString()}). Use --now to publish immediately.`);
  }
  return ms;
}

/** "7d", "30d", "90d", "12h", "2w" → ms. */
export function parseSpan(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(input.trim());
  const unit = m && Object.hasOwn(UNITS, m[2].toLowerCase()) ? UNITS[m[2].toLowerCase()] : 0;
  if (!m || !unit) throw new UsageError(`Invalid range "${input}" (use e.g. 7d, 30d, 90d, 12h)`);
  return Number(m[1]) * unit;
}
