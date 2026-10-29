import { describe, expect, it } from "vitest";
import { ACCOUNT_GROUP_COLORS, defaultGroupColor, isAccountGroupColor } from "../shared/accountGroups";
import { providerDisplayName } from "../shared/providerNames";
import type { AccountDTO, AccountGroupDTO } from "../shared/types";
import {
  GROUP_COLOR_CLASSES,
  UNGROUPED_KEY,
  buildSections,
  matchesAccountSearch,
  parseAccountFilter,
  pickerSections,
  selectionState,
  sortGroups,
  stepPosition,
} from "../src/lib/accountGroups";

// Grouping/sorting helpers of the Accounts page, the composer's account picker and the account filters.

const acc = (id: string, provider: string, name: string, username: string | null, groupId: string | null = null, status: AccountDTO["status"] = "active"): AccountDTO => ({
  id,
  provider,
  externalId: id,
  name,
  username,
  avatarUrl: null,
  profileUrl: null,
  status,
  statusMessage: null,
  expiresAt: null,
  createdAt: 0,
  reconnectedAt: null,
  metricsStatus: { status: "ok", message: null, checkedAt: null, metrics: null },
  groupId,
});
const grp = (id: string, name: string, position: number, createdAt = 0): AccountGroupDTO => ({ id, name, color: "violet", position, accountCount: 0, createdAt, updatedAt: 0 });

const NAMES: Record<string, string> = { instagram_standalone: "Instagram", youtube: "YouTube", x: "X", tiktok: "TikTok" };
const providerName = (id: string) => NAMES[id] ?? id;

const ACCOUNTS = [
  acc("a1", "youtube", "Party Games", "PartyGamesYT", "g_pg"),
  acc("a2", "instagram_standalone", "Party Games", "partygames", "g_pg"),
  acc("a3", "instagram_standalone", "Airport Officer", "airportofficer", "g_ao"),
  acc("a4", "x", "Postflare", "@postflareio", null),
  acc("a5", "tiktok", "Çay Saati", "caysaati", "g_gone"),
  acc("a6", "youtube", "airport officer", "AirportOfficerYT", "g_ao", "disabled"),
];
const GROUPS = [grp("g_ao", "Airport Officer", 1), grp("g_pg", "Party Games", 0), grp("g_empty", "Empty", 2)];

const shape = (sections: ReturnType<typeof buildSections>) => sections.map((s) => [s.key, s.title, s.accounts.map((a) => a.id)]);

describe("buildSections", () => {
  it("platform view: one section per platform, by platform name; accounts by name", () => {
    expect(shape(buildSections(ACCOUNTS, "platform", { providerName }))).toEqual([
      ["p:instagram_standalone", "Instagram", ["a3", "a2"]],
      ["p:tiktok", "TikTok", ["a5"]],
      ["p:x", "X", ["a4"]],
      ["p:youtube", "YouTube", ["a6", "a1"]],
    ]);
  });

  it("platform view before the provider catalog loads: fallback display names, never raw ids", () => {
    const sections = buildSections([...ACCOUNTS, acc("a7", "facebook", "Party Games", null)], "platform", { providerName: (id) => providerDisplayName(id, new Map()) });
    expect(sections.map((s) => s.title)).toEqual(["Facebook Page", "Instagram", "TikTok", "X (Twitter)", "YouTube"]);
  });

  it("group view: groups in position order (empty ones too), then Ungrouped (no group or an unknown one)", () => {
    expect(shape(buildSections(ACCOUNTS, "group", { groups: GROUPS, providerName }))).toEqual([
      ["g:g_pg", "Party Games", ["a2", "a1"]],
      ["g:g_ao", "Airport Officer", ["a3", "a6"]],
      ["g:g_empty", "Empty", []],
      [UNGROUPED_KEY, "Ungrouped", ["a5", "a4"]],
    ]);
    // Without groups everything is one "Accounts" section; hideEmpty drops empty groups.
    expect(shape(buildSections(ACCOUNTS.slice(0, 2), "group", { groups: [] }))).toEqual([[UNGROUPED_KEY, "Accounts", ["a2", "a1"]]]);
    expect(buildSections(ACCOUNTS, "group", { groups: GROUPS, hideEmpty: true }).map((s) => s.key)).not.toContain("g:g_empty");
  });

  it("all view: one flat section in the API order", () => {
    expect(shape(buildSections(ACCOUNTS, "all"))).toEqual([["all", "All accounts", ACCOUNTS.map((a) => a.id)]]);
  });

  it("search filters every view by name or @username and hides empty sections", () => {
    expect(shape(buildSections(ACCOUNTS, "group", { groups: GROUPS, query: "airport" }))).toEqual([["g:g_ao", "Airport Officer", ["a3", "a6"]]]);
    expect(shape(buildSections(ACCOUNTS, "platform", { providerName, query: "@postflare" }))).toEqual([["p:x", "X", ["a4"]]]);
    expect(buildSections(ACCOUNTS, "all", { query: "nothing" })[0].accounts).toEqual([]);
  });
});

describe("matchesAccountSearch", () => {
  it("matches name and username, ignoring case, @ and accents", () => {
    const a = ACCOUNTS[4];
    expect(matchesAccountSearch(a, "cay")).toBe(true);
    expect(matchesAccountSearch(a, "@CAYSAATI")).toBe(true);
    expect(matchesAccountSearch(ACCOUNTS[3], "postflareio")).toBe(true);
    expect(matchesAccountSearch(a, "tea")).toBe(false);
    expect(matchesAccountSearch(a, "  ")).toBe(true);
  });
});

describe("composer picker", () => {
  it("groups by group when the workspace has groups (no empty sections), else by platform", () => {
    expect(pickerSections(ACCOUNTS, GROUPS).map((s) => s.key)).toEqual(["g:g_pg", "g:g_ao", UNGROUPED_KEY]);
    expect(pickerSections(ACCOUNTS, [], providerName).map((s) => s.title)).toEqual(["Instagram", "TikTok", "X", "YouTube"]);
  });

  it("select-all state ignores disabled accounts", () => {
    const ao = ACCOUNTS.filter((a) => a.groupId === "g_ao");
    expect(selectionState(ao, [])).toBe("none");
    expect(selectionState(ao, ["a3"])).toBe("all"); // a6 is disabled
    const pg = ACCOUNTS.filter((a) => a.groupId === "g_pg");
    expect(selectionState(pg, new Set(["a1"]))).toBe("some");
    expect(selectionState([ACCOUNTS[5]], ["a6"])).toBe("none");
  });
});

describe("group order and colors", () => {
  it("sorts by position, then creation; steps up/down", () => {
    const groups = [grp("b", "B", 1, 5), grp("a", "A", 1, 1), grp("c", "C", 0)];
    expect(sortGroups(groups).map((g) => g.id)).toEqual(["c", "a", "b"]);
    expect(stepPosition(groups, "a", -1)).toBe(0);
    expect(stepPosition(groups, "a", 1)).toBe(2);
    expect(stepPosition(groups, "c", -1)).toBeNull();
    expect(stepPosition(groups, "b", 1)).toBeNull();
    expect(stepPosition(groups, "nope", 1)).toBeNull();
  });

  it("every palette color has classes; defaults cycle without zinc", () => {
    for (const c of ACCOUNT_GROUP_COLORS) expect(GROUP_COLOR_CLASSES[c]?.dot).toMatch(/^bg-/);
    expect(isAccountGroupColor("violet")).toBe(true);
    expect(isAccountGroupColor("#fff")).toBe(false);
    expect(defaultGroupColor(0)).toBe("red");
    expect(new Set(Array.from({ length: 18 }, (_, i) => defaultGroupColor(i))).has("zinc")).toBe(false);
  });

  it("parses account filter values", () => {
    expect(parseAccountFilter("")).toEqual({});
    expect(parseAccountFilter("acc_1")).toEqual({ accountId: "acc_1" });
    expect(parseAccountFilter("group:agr_1")).toEqual({ groupId: "agr_1" });
  });
});
