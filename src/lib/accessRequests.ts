import type { AccessRequestPlatform, AccessRequestRole, AccessRequestStatus, AccessRequestVolume } from "./types";

/** Labels of the "Request access" form (/apply) and Admin → Requests. */
export const ROLE_LABELS: Record<AccessRequestRole, string> = {
  creator: "Creator",
  agency: "Agency",
  startup: "Startup / app developer",
  brand: "Brand / marketing team",
  other: "Other",
};

/** Platforms people can pick, shown with the provider logos (the public form has no access to /api/providers). */
export const PLATFORMS: Array<{ id: AccessRequestPlatform; name: string; color: string; icon: string }> = [
  { id: "x", name: "X", color: "000000", icon: "x" },
  { id: "instagram", name: "Instagram", color: "E4405F", icon: "instagram" },
  { id: "tiktok", name: "TikTok", color: "000000", icon: "tiktok" },
  { id: "youtube", name: "YouTube", color: "FF0000", icon: "youtube" },
  { id: "linkedin", name: "LinkedIn", color: "0A66C2", icon: "" },
  { id: "facebook", name: "Facebook", color: "0866FF", icon: "facebook" },
  { id: "threads", name: "Threads", color: "000000", icon: "threads" },
  { id: "bluesky", name: "Bluesky", color: "0285FF", icon: "bluesky" },
  { id: "pinterest", name: "Pinterest", color: "BD081C", icon: "pinterest" },
  { id: "other", name: "Other", color: "71717a", icon: "" },
];

export const platformName = (id: string) => PLATFORMS.find((p) => p.id === id)?.name ?? id;

export const VOLUME_LABELS: Record<AccessRequestVolume, string> = {
  "1-30": "Up to 30",
  "31-100": "31–100",
  "101-300": "101–300",
  "301-1000": "301–1,000",
  "1000+": "More than 1,000",
};

export const STATUS_LABELS: Record<AccessRequestStatus, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn" };
export const STATUS_TONES = { pending: "amber", approved: "green", rejected: "red", withdrawn: "zinc" } as const;

export const USE_CASE_MIN = 20;
export const USE_CASE_MAX = 1000;
