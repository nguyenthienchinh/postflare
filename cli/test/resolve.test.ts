import { describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import { buildSettings, coerceSetting, missingSettings, resolveAccounts } from "../src/resolve.js";
import type { AccountDTO, FieldDef, ProviderInfo } from "../src/types.js";

const acc = (id: string, provider: string, name: string, username: string | null, status: AccountDTO["status"] = "active"): AccountDTO => ({
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
});

const ACCOUNTS = [
  acc("acc_x1", "x", "Fiona", "fiona"),
  acc("acc_bs", "bluesky", "Fiona", "fiona.bsky.social"),
  acc("acc_ig", "instagram_standalone", "My App", "@myapp"),
  acc("acc_tt1", "tiktok", "App TikTok", "myapp"),
  acc("acc_tt2", "tiktok", "Second TikTok", "other"),
];

describe("resolveAccounts", () => {
  it("by id, @username, platform, name and platform:@username", () => {
    expect(resolveAccounts(["acc_x1"], ACCOUNTS).map((a) => a.id)).toEqual(["acc_x1"]);
    expect(resolveAccounts(["@fiona.bsky.social"], ACCOUNTS).map((a) => a.id)).toEqual(["acc_bs"]);
    expect(resolveAccounts(["bluesky"], ACCOUNTS).map((a) => a.id)).toEqual(["acc_bs"]);
    expect(resolveAccounts(["my app"], ACCOUNTS).map((a) => a.id)).toEqual(["acc_ig"]);
    expect(resolveAccounts(["tiktok:@other"], ACCOUNTS).map((a) => a.id)).toEqual(["acc_tt2"]);
    expect(resolveAccounts(["tiktok:App TikTok"], ACCOUNTS).map((a) => a.id)).toEqual(["acc_tt1"]);
  });

  it("repeatable, comma separated, deduplicated", () => {
    expect(resolveAccounts(["x,bluesky", "acc_x1", "instagram_standalone"], ACCOUNTS).map((a) => a.id)).toEqual(["acc_x1", "acc_bs", "acc_ig"]);
  });

  it("ambiguous selectors list the candidates", () => {
    expect(() => resolveAccounts(["tiktok"], ACCOUNTS)).toThrow(/matches 2 accounts:[\s\S]*acc_tt1[\s\S]*acc_tt2[\s\S]*platform:@username/);
    expect(() => resolveAccounts(["fiona"], ACCOUNTS)).toThrow(/matches 2 accounts/);
    expect(() => resolveAccounts(["@myapp"], ACCOUNTS)).toThrow(/matches 2 accounts/);
  });

  it("unknown selectors list every account", () => {
    try {
      resolveAccounts(["linkedin"], ACCOUNTS);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toContain('No account matches "linkedin"');
      for (const a of ACCOUNTS) expect((err as Error).message).toContain(a.id);
    }
    expect(() => resolveAccounts([], ACCOUNTS)).toThrow(/--account/);
    expect(() => resolveAccounts(["x"], [])).toThrow(/no connected accounts/);
  });
});

const field = (f: Partial<FieldDef> & { key: string; type: FieldDef["type"] }): FieldDef => ({ label: f.key, ...f });

const TIKTOK: ProviderInfo = {
  id: "tiktok",
  name: "TikTok",
  category: "video",
  auth: "oauth2",
  capabilities: { maxLength: 2200, text: "optional", media: { images: 35, videos: 1, mixed: false, required: true }, thread: false },
  settingsFields: [
    field({ key: "postMode", type: "select", default: "direct", options: [{ value: "direct", label: "Post directly" }, { value: "inbox", label: "Inbox draft" }] }),
    field({ key: "allowComment", type: "checkbox", default: false, showIf: { key: "postMode", equals: "direct" } }),
    field({
      key: "privacy_level",
      label: "Who can view",
      type: "select",
      required: true,
      dynamicOptions: true,
      showIf: { key: "postMode", equals: "direct" },
      options: [
        { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
        { value: "SELF_ONLY", label: "Only me" },
      ],
    }),
    field({ key: "coverTimestampMs", type: "number" }),
  ],
};

const IG: ProviderInfo = {
  id: "instagram_standalone",
  name: "Instagram",
  category: "social",
  auth: "oauth2",
  capabilities: { maxLength: 2200, text: "optional", media: { images: 10, videos: 10, mixed: true, required: true }, thread: true },
  settingsFields: [
    field({ key: "post_type", type: "select", default: "post", options: [{ value: "post", label: "Post / Reel" }, { value: "story", label: "Story" }] }),
    field({ key: "collaborators", type: "tags" }),
  ],
};

const YT: ProviderInfo = {
  id: "youtube",
  name: "YouTube",
  category: "video",
  auth: "oauth2",
  capabilities: { maxLength: 5000, text: "optional", media: { images: 1, videos: 1, mixed: true, required: true }, thread: true },
  settingsFields: [field({ key: "title", type: "text", required: true }), field({ key: "publishAt", type: "datetime" })],
};

describe("settings", () => {
  const targets = [
    { account: ACCOUNTS[3], provider: TIKTOK },
    { account: ACCOUNTS[2], provider: IG },
  ];

  it("fills defaults and applies unscoped / platform / account scoped values with type coercion", () => {
    const s = buildSettings(targets, ["privacy_level=only me", "allowComment=yes", "instagram_standalone.collaborators=a, b", "acc_tt1.coverTimestampMs=1500"]);
    expect(s.get("acc_tt1")).toEqual({ postMode: "direct", allowComment: true, privacy_level: "SELF_ONLY", coverTimestampMs: 1500 });
    expect(s.get("acc_ig")).toEqual({ post_type: "post", collaborators: ["a", "b"] });
  });

  it("explains unknown keys, scopes and values", () => {
    expect(() => buildSettings(targets, ["title=x"])).toThrow(/Unknown setting "title"[\s\S]*tiktok: postMode/);
    expect(() => buildSettings(targets, ["youtube.title=x"])).toThrow(/"youtube" is not one of the selected/);
    expect(() => buildSettings(targets, ["instagram_standalone.post_type=reel"])).toThrow(/Choose one of: post \(Post \/ Reel\), story \(Story\)/);
    expect(() => buildSettings(targets, ["allowComment=maybe"])).toThrow(/yes\/no/);
    expect(() => buildSettings(targets, ["coverTimestampMs=abc"])).toThrow(/must be a number/);
    expect(() => buildSettings(targets, ["novalue"])).toThrow(/key=value/);
  });

  it("starts from existing settings when editing", () => {
    const base = new Map([["acc_tt1", { postMode: "direct", privacy_level: "SELF_ONLY", title: "kept" }]]);
    const s = buildSettings([targets[0]], ["privacy_level=PUBLIC_TO_EVERYONE"], base);
    expect(s.get("acc_tt1")).toEqual({ postMode: "direct", privacy_level: "PUBLIC_TO_EVERYONE", title: "kept" });
  });

  it("coerces datetime, JSON and dynamic selects", () => {
    expect(coerceSetting(field({ key: "publishAt", type: "datetime" }), "2026-10-14T09:00:00Z", "youtube")).toBe("2026-10-14T09:00:00.000Z");
    expect(coerceSetting(field({ key: "board", type: "select", dynamicOptions: true }), "12345", "pinterest")).toBe("12345");
    expect(coerceSetting(field({ key: "tags", type: "tags" }), '["a","b"]', "youtube")).toEqual(["a", "b"]);
    expect(coerceSetting(field({ key: "title", type: "text" }), "[draft] title", "youtube")).toBe("[draft] title");
  });

  it("names the --set for missing required settings (only visible ones)", () => {
    const s = buildSettings([...targets, { account: acc("acc_yt", "youtube", "Chan", null), provider: YT }], []);
    const missing = missingSettings([...targets, { account: acc("acc_yt", "youtube", "Chan", null), provider: YT }], s);
    expect(missing).toHaveLength(2);
    expect(missing[0]).toContain("--set tiktok.privacy_level=…  (PUBLIC_TO_EVERYONE | SELF_ONLY)");
    expect(missing[1]).toContain("--set youtube.title=");
    const inbox = buildSettings([targets[0]], ["postMode=inbox"]);
    expect(missingSettings([targets[0]], inbox)).toEqual([]);
  });
});
