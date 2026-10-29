import { describe, expect, it } from "vitest";
import { pickLatestServerRelease } from "../worker/lib/updates";
import { compareVersions, parseVersion } from "../shared/version";

describe("compareVersions", () => {
  it("orders semver versions, with or without v, prereleases before the release", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("0.0.0-dev", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("garbage", "0.1.0")).toBeLessThan(0);
    expect(parseVersion("cli-v1.0.0")).toBeNull();
  });
});

describe("pickLatestServerRelease", () => {
  const r = (tag_name: string, extra = {}) => ({ tag_name, html_url: "", draft: false, prerelease: false, published_at: null, ...extra });
  it("ignores CLI tags, drafts and prereleases", () => {
    expect(pickLatestServerRelease([r("cli-v3.0.0"), r("v0.2.0"), r("v0.10.0"), r("v1.0.0", { draft: true }), r("v0.11.0-beta.1")])?.tag_name).toBe("v0.10.0");
    expect(pickLatestServerRelease([r("cli-v0.2.0")])).toBeNull();
  });
});
