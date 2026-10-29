import type { ProviderInfo, ProviderStatus } from "../lib/types";
import { cn } from "../lib/format";
import { Badge } from "./ui/Misc";

export const PROVIDER_STATUS: Record<ProviderStatus, { label: string; tone: "green" | "blue" | "amber"; help: string }> = {
  verified: { label: "Verified", tone: "green", help: "Publishing confirmed against the live API with a real account." },
  beta: {
    label: "Beta",
    tone: "blue",
    help: "Built against the official API and tested with mocked responses; not yet confirmed with a live account. Please report issues.",
  },
  experimental: {
    label: "Experimental",
    tone: "amber",
    help: "Uses an unofficial API: it may break without notice and may conflict with the platform's terms. Instance admins turn it on in Instance settings.",
  },
};

/** "Beta" / "Experimental" pill next to a platform name, with an explanatory tooltip. Verified shows nothing unless `showVerified`. */
export function ProviderStatusBadge({
  provider,
  showVerified,
  className,
}: {
  provider: Pick<ProviderInfo, "status" | "statusNote"> | undefined;
  showVerified?: boolean;
  className?: string;
}) {
  if (!provider) return null;
  const status = provider.status ?? "beta";
  if (status === "verified" && !showVerified) return null;
  const m = PROVIDER_STATUS[status];
  return (
    <Badge tone={m.tone} title={provider.statusNote ? `${provider.statusNote}.\n\n${m.help}` : m.help} className={cn("cursor-help", className)}>
      {m.label}
    </Badge>
  );
}
