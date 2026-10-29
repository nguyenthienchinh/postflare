// Terminal output helpers: colors, tables, numbers, dates. No dependencies.

let colorEnabled = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export function setColor(enabled: boolean) {
  colorEnabled = enabled;
}

const wrap = (open: number, close: number) => (s: string | number) => (colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export const visibleLength = (s: string) => Array.from(s.replace(ANSI, "")).length;

/** One line, at most `max` visible characters (with an ellipsis). Not for colored strings. */
export function truncate(s: string | null | undefined, max: number): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(one);
  if (max <= 0) return "";
  return chars.length > max ? chars.slice(0, Math.max(max - 1, 0)).join("") + "…" : one;
}

export interface Column {
  header: string;
  align?: "left" | "right";
  /** This column shrinks (its cells are truncated) when the table is wider than the terminal. */
  flex?: boolean;
  /** Hard cap on the column width. */
  max?: number;
}

/** A plain text table. Cells may contain ANSI colors (only non-flex columns: flex cells are truncated as text). */
export function table(columns: Column[], rows: Array<Array<string | number | null | undefined>>, width = process.stdout.columns || 120): string {
  const cells = rows.map((r) => columns.map((col, i) => {
    const v = r[i];
    const s = v === null || v === undefined || v === "" ? "-" : String(v);
    return col.max ? truncate(s, col.max) : s;
  }));
  const widths = columns.map((col, i) => Math.max(visibleLength(col.header), ...cells.map((r) => visibleLength(r[i]))));
  const total = () => widths.reduce((a, b) => a + b, 0) + (columns.length - 1) * 2;
  const flex = columns.map((col, i) => (col.flex ? i : -1)).filter((i) => i >= 0);
  if (total() > width && flex.length) {
    const over = total() - width;
    const share = Math.ceil(over / flex.length);
    for (const i of flex) widths[i] = Math.max(visibleLength(columns[i].header), 12, widths[i] - share);
    for (const r of cells) for (const i of flex) r[i] = truncate(r[i], widths[i]);
  }
  const pad = (s: string, i: number) => {
    const n = widths[i] - visibleLength(s);
    if (n <= 0) return s;
    return columns[i].align === "right" ? " ".repeat(n) + s : s + " ".repeat(n);
  };
  const line = (r: string[]) => r.map(pad).join("  ").replace(/\s+$/, "");
  return [line(columns.map((col) => c.bold(col.header))), ...cells.map(line)].join("\n");
}

/** 1234 → "1,234"; 123456 → "123.5K"; 1234567 → "1.2M". */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e5) return `${+(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-US");
}

/** 0.0567 → "5.67%". */
export function fmtPct(r: number | null | undefined, digits = 2): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "-";
  return `${+(r * 100).toFixed(digits)}%`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return "-";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, "0")}` : `${sec < 10 ? sec.toFixed(1) : s}s`;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Local "2026-10-14 09:00". */
export function fmtDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "in 2h", "3d ago". */
export function fmtRelative(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return "";
  const d = ms - now;
  const a = Math.abs(d);
  const unit =
    a < 60_000 ? "now" : a < 3_600_000 ? `${Math.round(a / 60_000)}m` : a < 86_400_000 ? `${Math.round(a / 3_600_000)}h` : `${Math.round(a / 86_400_000)}d`;
  if (unit === "now") return "now";
  return d > 0 ? `in ${unit}` : `${unit} ago`;
}

export const fmtWhen = (ms: number | null | undefined) => (ms === null || ms === undefined ? "-" : `${fmtDate(ms)} ${c.gray(`(${fmtRelative(ms)})`)}`);

/** "+12 (+5.3%)" colored green/red. */
export function fmtDelta(cur: number | null | undefined, prev: number | null | undefined): string {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return "";
  const d = cur - prev;
  if (!d) return c.gray("±0");
  const pct = prev ? ` ${d > 0 ? "+" : ""}${+((d / prev) * 100).toFixed(1)}%` : "";
  const s = `${d > 0 ? "+" : ""}${fmtNum(d)}${pct}`;
  return d > 0 ? c.green(s) : c.red(s);
}

const STATUS_COLORS: Record<string, (s: string) => string> = {
  published: c.green,
  active: c.green,
  ok: c.green,
  scheduled: c.blue,
  publishing: c.cyan,
  draft: c.gray,
  cancelled: c.gray,
  pending: c.gray,
  not_supported: c.gray,
  disabled: c.gray,
  failed: c.red,
  error: c.red,
  reconnect: c.yellow,
  needs_check: c.yellow,
  reconnect_required: c.yellow,
};

export const fmtStatus = (s: string) => (STATUS_COLORS[s] ?? ((x: string) => x))(s);

export function printJson(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function println(s = ""): void {
  process.stdout.write(s + "\n");
}

export function eprintln(s = ""): void {
  process.stderr.write(s + "\n");
}
