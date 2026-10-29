import { PLATFORM_GROUPS } from "@shared/playbooks";
import { api } from "./api";
import type { PlaybookConfidence, PlaybookFormat, PlaybookGoal, PlaybookSummaryDTO, Provider } from "./types";
import { useFetch } from "./useFetch";

export { PLATFORM_GROUPS };

export const GOAL_LABEL: Record<PlaybookGoal, string> = {
  engagement: "Engagement",
  reach: "Reach",
  clicks: "Clicks",
  followers: "Followers",
  conversions: "Conversions",
};

export const FORMAT_LABEL: Record<PlaybookFormat, string> = {
  text: "Text",
  thread: "Thread",
  image: "Image",
  carousel: "Carousel",
  video: "Video",
};

export const CONFIDENCE_LABEL: Record<PlaybookConfidence, string> = {
  ok: "Enough data",
  low: "Low confidence",
  insufficient: "Too few posts",
};

/** "Short video (TikTok, Shorts, Reels)" for groups, the provider name for ids. */
export function platformLabel(p: string, providerMap: Map<string, Provider>): string {
  return PLATFORM_GROUPS[p]?.label ?? providerMap.get(p)?.name ?? p;
}

/** Short label for chips: groups without their parenthesis. */
export function platformChip(p: string, providerMap: Map<string, Provider>): string {
  return platformLabel(p, providerMap).replace(/\s*\(.*\)$/, "");
}

/** The whole library (built-in + custom) once per page; filters are applied by the server when given. */
export function usePlaybookList(enabled = true) {
  return useFetch(enabled ? "playbooks:all" : null, () => api.playbooks.list(), ["playbooks"]);
}

/** "Name v2" for attribution labels. */
export function playbookLabel(list: PlaybookSummaryDTO[] | undefined, id: string, version?: number | null): string {
  const p = list?.find((x) => x.id === id);
  return `${p?.name ?? id}${version && (!p || !p.builtin || p.version !== version) ? ` v${version}` : ""}`;
}

/** +23% / −8% (true minus sign). */
export function liftText(lift: number | null): string {
  if (lift === null) return "–";
  const pct = Math.round(lift * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`;
}
