// Hand-built SVG charts for analytics (no chart library). Follows the dataviz method: thin marks (2px lines,
// <= 24px columns with 4px rounded data-ends and a 2px surface gap), hairline solid grid, one y-scale per panel,
// text in ink tokens (never the series color), a hover/focus layer with one tooltip, and a table view elsewhere.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatDayKey, niceTicks, rangeTicks } from "../../lib/analytics";
import { cn, compactNumber, fullNumber, percent } from "../../lib/format";
import type { AnalyticsDay } from "../../lib/types";

export const SERIES_1 = "var(--viz-series-1)";
export const SERIES_2 = "var(--viz-series-2)";

/** Width of an element, kept up to date. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Column path: square at the baseline, rounded data-end (radius ≤ 4). */
function columnPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/** Short stroke of a series color: the identity key next to a text label. */
export function LineKey({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-0.5 w-3 shrink-0 rounded-full", className)} style={{ backgroundColor: color }} />;
}

export function SwatchKey({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />;
}

/** Floating readout: value strong, label secondary. Positioned by the chart. */
function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(160);
  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  });
  // Right of the crosshair, flipped left near the right edge.
  const left = x + 12 + w > width ? Math.max(0, x - 12 - w) : x + 12;
  return (
    <div
      ref={ref}
      role="presentation"
      className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700"
      style={{ left }}
    >
      {children}
    </div>
  );
}

export function TooltipRow({ color, value, label, title, bar }: { color?: string; value: ReactNode; label: ReactNode; title?: string; bar?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5" title={title}>
      {color ? bar ? <SwatchKey color={color} /> : <LineKey color={color} /> : <span className="w-3" />}
      <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</span>
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
    </div>
  );
}

/** Keyboard-navigable index: arrows move, Home/End jump, Escape clears. */
function useIndexNav(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!count) return;
      const cur = index ?? count - 1;
      const next =
        e.key === "ArrowRight" ? Math.min(count - 1, cur + 1) : e.key === "ArrowLeft" ? Math.max(0, cur - 1) : e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null;
      if (e.key === "Escape") return setIndex(null);
      if (next === null) return;
      e.preventDefault();
      setIndex(next);
    },
    [count, index],
  );
  return { index, setIndex, onKeyDown, onFocus: () => setIndex((i) => i ?? count - 1), onBlur: () => setIndex(null) };
}

// ---------------------------------------------------------------------------------------------------------------
// Daily performance: three stacked panels sharing the x axis (views, engagements, posts), one crosshair, one tooltip.

const GUTTER = 44;
const PAD_R = 4;

export function DailyChart({ daily, exposureLabel }: { daily: AnalyticsDay[]; exposureLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const nav = useIndexNav(daily.length);
  const n = daily.length;
  const plotW = Math.max(0, width - GUTTER - PAD_R);
  const band = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(24, band - 2));
  const xOf = (i: number) => GUTTER + i * band + (band - barW) / 2;

  const panels = [
    { key: "views" as const, label: exposureLabel, color: SERIES_1, height: 132, ticks: niceTicks(Math.max(...daily.map((d) => d.views), 0), 3) },
    { key: "engagements" as const, label: "Engagements", color: SERIES_2, height: 96, ticks: niceTicks(Math.max(...daily.map((d) => d.engagements), 0), 3) },
    { key: "posts" as const, label: "Posts published", color: "var(--viz-muted-mark)", height: 34, ticks: [0, Math.max(1, ...daily.map((d) => d.posts))] },
  ];
  const HEAD = 30; // panel label row
  const GAP = 14;
  let y = 0;
  const layout = panels.map((p) => {
    const top = y + HEAD;
    y = top + p.height + GAP;
    return { ...p, top, base: top + p.height };
  });
  const axisTop = y - GAP + 6;
  const height = axisTop + 16;

  // ~6 x labels, always including the last day.
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))));
  const xLabels = daily.map((d, i) => ({ i, d })).filter(({ i }) => (n - 1 - i) % labelEvery === 0);

  const hover = nav.index !== null ? daily[nav.index] : null;
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left) / band);
    nav.setIndex(Math.max(0, Math.min(n - 1, i)));
  };

  const total = daily.reduce((a, d) => ({ views: a.views + d.views, engagements: a.engagements + d.engagements, posts: a.posts + d.posts }), { views: 0, engagements: 0, posts: 0 });
  const summary = `Daily chart over ${n} days: ${fullNumber(total.views)} ${exposureLabel.toLowerCase()}, ${fullNumber(total.engagements)} engagements, ${fullNumber(total.posts)} posts. Use the arrow keys to read each day.`;

  return (
    <div ref={ref} className="relative w-full select-none">
      {width > 0 && n > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={summary}
          tabIndex={0}
          onKeyDown={nav.onKeyDown}
          onFocus={nav.onFocus}
          onBlur={nav.onBlur}
          className="block overflow-visible rounded-md focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500"
        >
          {/* Hovered day: a ghost wash across all panels. */}
          {nav.index !== null && <rect x={GUTTER + nav.index * band} y={HEAD - 4} width={band} height={axisTop - HEAD} className="fill-zinc-900/[0.04] dark:fill-white/[0.05]" />}
          {layout.map((p) => {
            const max = p.ticks[p.ticks.length - 1] || 1;
            const yOf = (v: number) => p.base - (v / max) * p.height;
            return (
              <g key={p.key}>
                <g transform={`translate(0, ${p.top - HEAD + 12})`}>
                  {p.key === "posts" ? (
                    <rect x={0} y={-6} width={10} height={8} rx={2} fill={p.color} />
                  ) : (
                    <rect x={0} y={-3} width={12} height={2} rx={1} fill={p.color} />
                  )}
                  <text x={18} y={1} className="fill-zinc-700 text-[12px] font-medium dark:fill-zinc-300">
                    {p.label}
                  </text>
                </g>
                {(p.key === "posts" ? [p.ticks[1]] : p.ticks).map((t) => (
                  <g key={t}>
                    {p.key !== "posts" && <line x1={GUTTER} x2={width - PAD_R} y1={yOf(t)} y2={yOf(t)} stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} shapeRendering="crispEdges" />}
                    <text x={GUTTER - 8} y={yOf(t) + 4} textAnchor="end" className="tabular-nums text-[11px]" fill="var(--viz-ink-muted)">
                      {compactNumber(t)}
                    </text>
                  </g>
                ))}
                {p.key === "posts" && <line x1={GUTTER} x2={width - PAD_R} y1={p.base} y2={p.base} stroke="var(--viz-axis)" strokeWidth={1} shapeRendering="crispEdges" />}
                {daily.map((d, i) => {
                  const v = d[p.key];
                  if (!v) return null;
                  return <path key={d.day} d={columnPath(xOf(i), yOf(v), barW, p.base)} fill={p.color} opacity={nav.index === null || nav.index === i ? 1 : 0.55} />;
                })}
              </g>
            );
          })}
          {xLabels.map(({ i, d }) => (
            <text key={d.day} x={GUTTER + i * band + band / 2} y={axisTop + 10} textAnchor={i === n - 1 && band < 40 ? "end" : "middle"} className="text-[11px]" fill="var(--viz-ink-muted)">
              {formatDayKey(d.day)}
            </text>
          ))}
          <rect x={GUTTER} y={0} width={plotW} height={axisTop} fill="transparent" onPointerMove={onMove} onPointerLeave={() => nav.setIndex(null)} />
        </svg>
      )}
      {hover && nav.index !== null && (
        <Tooltip x={GUTTER + nav.index * band + band / 2} width={width}>
          <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">{formatDayKey(hover.day, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</p>
          <TooltipRow color={SERIES_1} bar value={fullNumber(hover.views)} label={exposureLabel.toLowerCase()} />
          <TooltipRow color={SERIES_2} bar value={fullNumber(hover.engagements)} label="engagements" />
          <TooltipRow color="var(--viz-muted-mark)" bar value={fullNumber(hover.posts)} label={hover.posts === 1 ? "post" : "posts"} />
          {hover.views > 0 && <TooltipRow value={percent(hover.engagements / hover.views)} label="engagement rate" />}
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Panel columns: one stacked panel per measure (each its own y-scale, never a dual axis), shared x axis, one
// crosshair wash and one tooltip. Generic version of DailyChart for any per-day counts (Admin → Overview).

export interface ColumnPanel<K extends string> {
  key: K;
  label: string;
  /** Series color, or a status token for state measures (failures): the label carries the meaning too. */
  color: string;
  height: number;
  /** Tooltip unit, singular / plural. */
  unit: [string, string];
}

export function PanelColumns<K extends string>({ rows, panels, label }: { rows: Array<{ day: string } & Record<K, number>>; panels: ColumnPanel<K>[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const nav = useIndexNav(rows.length);
  const n = rows.length;
  const plotW = Math.max(0, width - GUTTER - PAD_R);
  const band = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(24, band - 2));
  const xOf = (i: number) => GUTTER + i * band + (band - barW) / 2;
  const HEAD = 30;
  const GAP = 14;
  let y = 0;
  const layout = panels.map((p) => {
    const top = y + HEAD;
    y = top + p.height + GAP;
    const ticks = niceTicks(Math.max(1, ...rows.map((r) => r[p.key])), p.height < 60 ? 1 : 3).filter(Number.isInteger); // counts
    return { ...p, top, base: top + p.height, ticks };
  });
  const axisTop = y - GAP + 6;
  const height = axisTop + 16;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))));
  const xLabels = rows.map((d, i) => ({ i, d })).filter(({ i }) => (n - 1 - i) % labelEvery === 0);
  const hover = nav.index !== null ? rows[nav.index] : null;
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    nav.setIndex(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - rect.left) / band))));
  };
  const summary = `${label}. ${panels.map((p) => `${fullNumber(rows.reduce((a, r) => a + r[p.key], 0))} ${p.label.toLowerCase()}`).join(", ")} over ${n} days. Use the arrow keys to read each day.`;

  return (
    <div ref={ref} className="relative w-full select-none">
      {width > 0 && n > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={summary}
          tabIndex={0}
          onKeyDown={nav.onKeyDown}
          onFocus={nav.onFocus}
          onBlur={nav.onBlur}
          className="block overflow-visible rounded-md focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500"
        >
          {nav.index !== null && <rect x={GUTTER + nav.index * band} y={HEAD - 4} width={band} height={axisTop - HEAD} className="fill-zinc-900/[0.04] dark:fill-white/[0.05]" />}
          {layout.map((p) => {
            const max = p.ticks[p.ticks.length - 1] || 1;
            const yOf = (v: number) => p.base - (v / max) * p.height;
            return (
              <g key={p.key}>
                <g transform={`translate(0, ${p.top - HEAD + 12})`}>
                  <rect x={0} y={-6} width={10} height={8} rx={2} fill={p.color} />
                  <text x={18} y={1} className="fill-zinc-700 text-[12px] font-medium dark:fill-zinc-300">
                    {p.label}
                  </text>
                </g>
                {p.ticks.map((t) => (
                  <g key={t}>
                    <line x1={GUTTER} x2={width - PAD_R} y1={yOf(t)} y2={yOf(t)} stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                    <text x={GUTTER - 8} y={yOf(t) + 4} textAnchor="end" className="tabular-nums text-[11px]" fill="var(--viz-ink-muted)">
                      {compactNumber(t)}
                    </text>
                  </g>
                ))}
                {rows.map((d, i) => {
                  const v = d[p.key];
                  if (!v) return null;
                  return <path key={d.day} d={columnPath(xOf(i), yOf(v), barW, p.base)} fill={p.color} opacity={nav.index === null || nav.index === i ? 1 : 0.55} />;
                })}
              </g>
            );
          })}
          {xLabels.map(({ i, d }) => (
            <text key={d.day} x={GUTTER + i * band + band / 2} y={axisTop + 10} textAnchor={i === n - 1 && band < 40 ? "end" : "middle"} className="text-[11px]" fill="var(--viz-ink-muted)">
              {formatDayKey(d.day)}
            </text>
          ))}
          <rect x={GUTTER} y={0} width={plotW} height={axisTop} fill="transparent" onPointerMove={onMove} onPointerLeave={() => nav.setIndex(null)} />
        </svg>
      )}
      {hover && nav.index !== null && (
        <Tooltip x={GUTTER + nav.index * band + band / 2} width={width}>
          <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">{formatDayKey(hover.day, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</p>
          {panels.map((p) => (
            <TooltipRow key={p.key} color={p.color} bar value={fullNumber(hover[p.key])} label={hover[p.key] === 1 ? p.unit[0] : p.unit[1]} />
          ))}
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Line chart (followers per account, a post's metrics over time): 2px line, 10% wash, end dot with a surface ring,
// nearest-point crosshair.

export interface LinePoint {
  x: number;
  y: number;
  /** Tooltip heading. */
  label: string;
}

export function LineChart({
  points,
  xDomain,
  xTicks = [],
  height = 88,
  color = SERIES_1,
  fromZero = false,
  label,
  valueLabel,
  formatValue = fullNumber,
  showDots = false,
}: {
  points: LinePoint[];
  xDomain: [number, number];
  xTicks?: Array<{ x: number; label: string }>;
  height?: number;
  color?: string;
  fromZero?: boolean;
  /** Accessible summary. */
  label: string;
  /** Unit in the tooltip ("followers"). */
  valueLabel: string;
  formatValue?: (n: number) => string;
  showDots?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const nav = useIndexNav(points.length);
  const gradient = useId();
  const ys = points.map((p) => p.y);
  const lo = fromZero ? 0 : Math.min(...ys);
  const hi = Math.max(...ys, lo + 1);
  const ticks = fromZero ? niceTicks(hi, 3) : rangeTicks(lo, hi, 2);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1] === yMin ? yMin + 1 : ticks[ticks.length - 1];
  const gutter = Math.max(28, ...ticks.map((t) => compactNumber(t).length * 6.5 + 10));
  const padT = 6;
  const axisH = xTicks.length ? 18 : 4;
  const plotH = height - padT - axisH;
  const plotW = Math.max(0, width - gutter - 6);
  const span = xDomain[1] - xDomain[0] || 1;
  const xOf = (x: number) => gutter + ((x - xDomain[0]) / span) * plotW;
  const yOf = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const line = points.map((p, i) => `${i ? "L" : "M"}${xOf(p.x).toFixed(1)},${yOf(p.y).toFixed(1)}`).join("");
  const area = points.length > 1 ? `${line}L${xOf(points[points.length - 1].x).toFixed(1)},${padT + plotH}L${xOf(points[0].x).toFixed(1)},${padT + plotH}Z` : "";
  const last = points[points.length - 1];
  const hover = nav.index !== null ? points[nav.index] : null;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + gutter;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(xOf(points[i].x) - px) < Math.abs(xOf(points[best].x) - px)) best = i;
    nav.setIndex(best);
  };

  return (
    <div ref={ref} className="relative w-full select-none">
      {width > 0 && points.length > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onKeyDown={nav.onKeyDown}
          onFocus={nav.onFocus}
          onBlur={nav.onBlur}
          className="block overflow-visible rounded-md focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500"
        >
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.14} />
              <stop offset="1" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={gutter} x2={width - 6} y1={yOf(t)} y2={yOf(t)} stroke={t === ticks[0] ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={gutter - 6} y={yOf(t) + 4} textAnchor="end" className="tabular-nums text-[10px]" fill="var(--viz-ink-muted)">
                {compactNumber(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={i}
              x={xOf(t.x)}
              y={height - 3}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              className="text-[10px]"
              fill="var(--viz-ink-muted)"
            >
              {t.label}
            </text>
          ))}
          {area && <path d={area} fill={`url(#${gradient})`} />}
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {showDots &&
            points.map((p, i) => <circle key={i} cx={xOf(p.x)} cy={yOf(p.y)} r={3} fill={color} stroke="var(--viz-surface)" strokeWidth={2} />)}
          {hover && nav.index !== null ? (
            <>
              <line x1={xOf(hover.x)} x2={xOf(hover.x)} y1={padT} y2={padT + plotH} stroke="var(--viz-axis)" strokeWidth={1} shapeRendering="crispEdges" />
              <circle cx={xOf(hover.x)} cy={yOf(hover.y)} r={4.5} fill={color} stroke="var(--viz-surface)" strokeWidth={2} />
            </>
          ) : (
            last && <circle cx={xOf(last.x)} cy={yOf(last.y)} r={4} fill={color} stroke="var(--viz-surface)" strokeWidth={2} />
          )}
          <rect x={gutter} y={0} width={plotW} height={padT + plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => nav.setIndex(null)} />
        </svg>
      )}
      {hover && nav.index !== null && (
        <Tooltip x={xOf(hover.x)} width={width}>
          <p className="mb-0.5 font-medium text-zinc-700 dark:text-zinc-200">{hover.label}</p>
          <TooltipRow color={color} value={formatValue(hover.y)} label={valueLabel} />
        </Tooltip>
      )}
    </div>
  );
}

/** Horizontal magnitude bar for table cells (single series, slot 1). */
export function InlineBar({ value, max, color = SERIES_1 }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden>
      <div className="h-full rounded-r-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

/** Re-render every `ms` (relative times). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
