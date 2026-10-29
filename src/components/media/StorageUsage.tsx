import { HardDrive } from "lucide-react";
import { cn, formatBytes } from "../../lib/format";
import type { MediaUsageDTO } from "../../lib/types";

/** "Media older than N days is removed when unused" / "kept forever". */
export function retentionText(days: number): string {
  if (days <= 0) return "Media is kept forever.";
  return `Media older than ${days} ${days === 1 ? "day" : "days"} is removed when no post needs it anymore.`;
}

function Bar({ label, used, count, limit }: { label: string; used: number; count: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const tone = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-brand-500";
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-zinc-700 dark:text-zinc-200">{label}</span>
        <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
          {formatBytes(used)} of {formatBytes(limit)} · {count} {count === 1 ? "file" : "files"}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        role="meter"
        aria-label={`${label} storage`}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <div className={cn("h-full rounded-full transition-[width]", tone)} style={{ width: `${Math.max(pct, used > 0 ? 1 : 0)}%` }} />
      </div>
    </div>
  );
}

/** Stored media vs the R2 Free plan storage (10 GB), for the workspace and, for instance admins, the whole instance. */
export function StorageUsage({
  usage,
  show = "both",
  className,
}: {
  usage: MediaUsageDTO;
  show?: "workspace" | "instance" | "both";
  className?: string;
}) {
  const workspace = show !== "instance";
  const instance = show !== "workspace" && usage.instance;
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
        {workspace && <Bar label="This workspace" used={usage.workspace.bytes} count={usage.workspace.count} limit={usage.freeTierBytes} />}
        {instance && <Bar label="Whole instance" used={instance.bytes} count={instance.count} limit={usage.freeTierBytes} />}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <HardDrive className="mt-px size-3.5 shrink-0" />
        <span>
          Compared with the {formatBytes(usage.freeTierBytes)} of storage included in the Cloudflare R2 free plan. {retentionText(usage.retentionDays)}
        </span>
      </p>
    </div>
  );
}
