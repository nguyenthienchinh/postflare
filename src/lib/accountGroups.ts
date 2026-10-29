// Account grouping for the Accounts page, the composer's account picker and filters. Pure (unit-tested in
// test/accountGroups.test.ts): no React, no DOM.

import type { AccountDTO, AccountGroupDTO } from "../../shared/types";
import { ACCOUNT_GROUP_COLORS } from "../../shared/accountGroups";

export type AccountsView = "platform" | "group" | "all";
export const ACCOUNTS_VIEWS: AccountsView[] = ["platform", "group", "all"];

export interface AccountSection {
  /** Stable key (collapsed state): `p:<provider>`, `g:<groupId>`, `g:none` or `all`. */
  key: string;
  kind: "platform" | "group" | "ungrouped" | "all";
  title: string;
  accounts: AccountDTO[];
  group?: AccountGroupDTO;
  provider?: string;
}

export const UNGROUPED_KEY = "g:none";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Search by name or @username (with or without the @), case- and accent-insensitive. */
export function matchesAccountSearch(a: AccountDTO, query: string): boolean {
  const q = fold(query.trim().replace(/^@/, ""));
  if (!q) return true;
  return fold(a.name).includes(q) || fold((a.username ?? "").replace(/^@/, "")).includes(q);
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Accounts by name, then platform, then id (stable). */
export function sortAccounts(list: AccountDTO[], providerName: (id: string) => string = (id) => id): AccountDTO[] {
  return [...list].sort((a, b) => collator.compare(a.name, b.name) || collator.compare(providerName(a.provider), providerName(b.provider)) || a.id.localeCompare(b.id));
}

/** Groups in display order (position, then creation). */
export function sortGroups(groups: AccountGroupDTO[]): AccountGroupDTO[] {
  return [...groups].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

/**
 * Sections for a view. Platform: one per platform, by platform name. Group: the groups in order (empty ones too unless
 * searching or `hideEmpty`), then "Ungrouped" (accounts without a known group) when not empty. All: one flat section
 * in the API's order. `query` filters every view.
 */
export function buildSections(
  accounts: AccountDTO[],
  view: AccountsView,
  opts: { groups?: AccountGroupDTO[]; providerName?: (id: string) => string; query?: string; hideEmpty?: boolean } = {},
): AccountSection[] {
  const providerName = opts.providerName ?? ((id: string) => id);
  const query = opts.query ?? "";
  const list = query.trim() ? accounts.filter((a) => matchesAccountSearch(a, query)) : accounts;
  if (view === "all") return [{ key: "all", kind: "all", title: "All accounts", accounts: list }];

  if (view === "platform") {
    const by = new Map<string, AccountDTO[]>();
    for (const a of list) by.set(a.provider, [...(by.get(a.provider) ?? []), a]);
    return [...by.entries()]
      .map(([provider, accs]) => ({ key: `p:${provider}`, kind: "platform" as const, title: providerName(provider), provider, accounts: sortAccounts(accs, providerName) }))
      .sort((a, b) => collator.compare(a.title, b.title));
  }

  const groups = sortGroups(opts.groups ?? []);
  const known = new Set(groups.map((g) => g.id));
  const hideEmpty = opts.hideEmpty || !!query.trim();
  const sections: AccountSection[] = groups.map((g) => ({
    key: `g:${g.id}`,
    kind: "group",
    title: g.name,
    group: g,
    accounts: sortAccounts(
      list.filter((a) => a.groupId === g.id),
      providerName,
    ),
  }));
  const ungrouped = list.filter((a) => !a.groupId || !known.has(a.groupId));
  if (ungrouped.length) sections.push({ key: UNGROUPED_KEY, kind: "ungrouped", title: groups.length ? "Ungrouped" : "Accounts", accounts: sortAccounts(ungrouped, providerName) });
  return hideEmpty ? sections.filter((s) => s.accounts.length) : sections;
}

/** Sections of the composer's account picker: by group when the workspace has groups, else by platform. */
export function pickerSections(accounts: AccountDTO[], groups: AccountGroupDTO[], providerName?: (id: string) => string): AccountSection[] {
  return buildSections(accounts, groups.length ? "group" : "platform", { groups, providerName, hideEmpty: true });
}

/** Accounts a "select all" can pick (disabled ones cannot publish). */
export const selectable = (accounts: AccountDTO[]) => accounts.filter((a) => a.status !== "disabled");

/** How many of a section's selectable accounts are selected. */
export function selectionState(accounts: AccountDTO[], selected: Iterable<string>): "all" | "some" | "none" {
  const set = selected instanceof Set ? (selected as Set<string>) : new Set(selected);
  const pool = selectable(accounts);
  const n = pool.filter((a) => set.has(a.id)).length;
  return !pool.length || n === 0 ? "none" : n === pool.length ? "all" : "some";
}

/** New position of a group moved one step up (-1) or down (+1); null when it cannot move. */
export function stepPosition(groups: AccountGroupDTO[], id: string, dir: -1 | 1): number | null {
  const order = sortGroups(groups);
  const i = order.findIndex((g) => g.id === id);
  const j = i + dir;
  return i < 0 || j < 0 || j >= order.length ? null : j;
}

/** Tailwind classes per palette color (literal strings so Tailwind finds them). */
export const GROUP_COLOR_CLASSES: Record<string, { dot: string; soft: string; ring: string }> = {
  zinc: { dot: "bg-zinc-400", soft: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300", ring: "ring-zinc-400" },
  red: { dot: "bg-red-500", soft: "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300", ring: "ring-red-500" },
  orange: { dot: "bg-orange-500", soft: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300", ring: "ring-orange-500" },
  amber: { dot: "bg-amber-500", soft: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300", ring: "ring-amber-500" },
  green: { dot: "bg-emerald-500", soft: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300", ring: "ring-emerald-500" },
  teal: { dot: "bg-teal-500", soft: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300", ring: "ring-teal-500" },
  sky: { dot: "bg-sky-500", soft: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300", ring: "ring-sky-500" },
  indigo: { dot: "bg-indigo-500", soft: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300", ring: "ring-indigo-500" },
  violet: { dot: "bg-violet-500", soft: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300", ring: "ring-violet-500" },
  pink: { dot: "bg-pink-500", soft: "bg-pink-50 text-pink-700 dark:bg-pink-950/60 dark:text-pink-300", ring: "ring-pink-500" },
};

export const GROUP_COLORS = ACCOUNT_GROUP_COLORS;
export const groupColor = (color: string | undefined) => GROUP_COLOR_CLASSES[color ?? ""] ?? GROUP_COLOR_CLASSES.zinc;

/** Value of a group in an account filter <select> (`group:<id>`), and back. */
export const groupFilterValue = (groupId: string) => `group:${groupId}`;
export const parseAccountFilter = (value: string): { accountId?: string; groupId?: string } =>
  value.startsWith("group:") ? { groupId: value.slice(6) } : value ? { accountId: value } : {};
