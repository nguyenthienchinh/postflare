import type { ReactNode } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, CircleSlash, Clock, Minus, XCircle } from "lucide-react";
import { METRICS_STATUS_LABEL } from "../../lib/analytics";
import { cn, compactNumber, fullNumber } from "../../lib/format";
import type { AccountMetricsStatusDTO } from "../../lib/types";
import { Badge } from "../ui/Misc";

/** A number shown compact, with the full value on hover. */
export function Num({ value, className, title }: { value: number | null | undefined; className?: string; title?: string }) {
  if (value === null || value === undefined) return <span className={cn("text-zinc-400", className)}>–</span>;
  return (
    <span className={className} title={title ?? fullNumber(value)}>
      {compactNumber(value)}
    </span>
  );
}

/**
 * Signed change with direction icon. Color = direction × whether up is good (status tokens, always with an icon and
 * the sign, never color alone).
 */
export function Delta({ value, text, title, upIsGood = true, className }: { value: number | null; text: ReactNode; title?: string; upIsGood?: boolean; className?: string }) {
  if (value === null) return null;
  const flat = value === 0;
  const good = flat ? null : value > 0 === upIsGood;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      title={title}
      className={cn("inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums", flat && "text-zinc-500 dark:text-zinc-400", className)}
      style={good === null ? undefined : { color: good ? "var(--viz-delta-up)" : "var(--viz-delta-down)" }}
    >
      <Icon className="size-3.5" aria-hidden />
      {text}
    </span>
  );
}

/** Analytics collection state of an account, as a badge (icon + label). */
export function MetricsStatusBadge({ status, className }: { status: AccountMetricsStatusDTO; className?: string }) {
  const s = status.status;
  const tone = s === "ok" ? "green" : s === "reconnect_required" ? "amber" : s === "error" ? "red" : "zinc";
  const Icon = s === "ok" ? BarChart3 : s === "reconnect_required" ? AlertTriangle : s === "error" ? XCircle : s === "pending" ? Clock : CircleSlash;
  return (
    <Badge tone={tone} className={className}>
      <span title={status.message ?? undefined} className="inline-flex items-center gap-1">
        <Icon className="size-3" aria-hidden />
        {METRICS_STATUS_LABEL[s]}
      </span>
    </Badge>
  );
}
