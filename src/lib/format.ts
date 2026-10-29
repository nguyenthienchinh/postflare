export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function textLength(text: string): number {
  return Array.from(text).length;
}

export function truncate(text: string, n: number): string {
  const chars = Array.from(text);
  return chars.length > n ? chars.slice(0, n).join("").trimEnd() + "…" : text;
}

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fullFmt = new Intl.NumberFormat("en-US");

/** 950, 1.2K, 3.4M (full value: `fullNumber`). */
export function compactNumber(n: number): string {
  return Math.abs(n) < 1000 ? fullFmt.format(Math.round(n)) : compactFmt.format(n);
}

/** 1,234,567 */
export function fullNumber(n: number): string {
  return fullFmt.format(Math.round(n));
}

/** 0.0423 → "4.2%" */
export function percent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

/** +12, −3 (true minus sign), compact. */
export function signedCompact(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${compactNumber(Math.abs(n))}`;
}

/** 12.5, "EUR" → "€12.50" (plain number with the code when the currency is unknown). */
export function money(n: number, currency: string | null | undefined, opts: { compact?: boolean } = {}): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      ...(opts.compact && Math.abs(n) >= 1000 ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }),
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency ?? ""}`.trim();
  }
}
