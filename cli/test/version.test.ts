import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_API_VERSION, compatWarning, resetCompatCache } from "../src/compat.js";
import type { Deps } from "../src/context.js";
import { run } from "../src/main.js";
import { VERSION } from "../src/version.js";

// GET /api/version: `postflare version` and the once-per-process compatibility warning.

const dir = mkdtempSync(join(tmpdir(), "postflare-version-"));
let out = "";
let err = "";
let paths: string[] = [];

function deps(version: { status: number; body?: unknown }): Deps {
  return {
    fetch: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/api/version") return new Response(JSON.stringify(version.body ?? { error: "Not found" }), { status: version.status });
      if (path === "/api/accounts") return Response.json([]);
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    env: { POSTFLARE_URL: "https://pf.test", POSTFLARE_API_KEY: "pf_test", POSTFLARE_CONFIG: join(dir, "none.json") },
    readStdin: async () => null,
  };
}

beforeEach(() => {
  out = "";
  err = "";
  paths = [];
  resetCompatCache();
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => ((err += String(s)), true));
});
afterEach(() => vi.restoreAllMocks());

describe("postflare version", () => {
  it("prints the CLI and server versions", async () => {
    expect(await run(["version", "--no-color"], deps({ status: 200, body: { version: "0.3.0", commit: "abc1234", apiVersion: 1 } }))).toBe(0);
    expect(out).toContain(`postflare CLI  ${VERSION}`);
    expect(out).toContain("https://pf.test  v0.3.0 (commit abc1234, API 1)");
    expect(err).toBe("");
  });

  it("--json, and servers without /api/version (404) are unknown, not an error", async () => {
    expect(await run(["version", "--json"], deps({ status: 404 }))).toBe(0);
    expect(JSON.parse(out)).toEqual({
      cli: { version: VERSION, apiVersions: { min: 1, max: MAX_API_VERSION } },
      server: { url: "https://pf.test", version: null, commit: null, apiVersion: null },
      compatible: true,
      warning: null,
    });
  });

  it("works without being logged in", async () => {
    const d = deps({ status: 200 });
    d.env = { POSTFLARE_CONFIG: join(dir, "none.json") };
    expect(await run(["version", "--no-color"], d)).toBe(0);
    expect(out).toContain("not logged in");
    expect(paths).toEqual([]);
  });

  it("--version prints the CLI version only, without asking the server", async () => {
    expect(await run(["--version"], deps({ status: 200 }))).toBe(0);
    expect(out.trim()).toBe(VERSION);
    expect(paths).toEqual([]);
  });
});

describe("compatibility warning", () => {
  it("warns once per process on stderr when the server's API is newer than the CLI knows", async () => {
    const d = deps({ status: 200, body: { version: "9.0.0", commit: "abc1234", apiVersion: MAX_API_VERSION + 1 } });
    expect(await run(["accounts", "--json", "--no-color"], d)).toBe(0);
    expect(JSON.parse(out)).toEqual([]);
    expect(err).toContain("warning: this Postflare server (v9.0.0, API 2) is newer than postflare CLI");
    expect(err).toContain("npm i -g postflare@latest");
    err = "";
    expect(await run(["accounts", "--json"], d)).toBe(0);
    expect(err).toBe("");
    // The version is asked once per process and server.
    expect(paths.filter((p) => p === "/api/version")).toHaveLength(1);
  });

  it("stays quiet for compatible and unknown servers, and with POSTFLARE_NO_VERSION_CHECK", async () => {
    expect(await run(["accounts", "--json"], deps({ status: 200, body: { version: "0.1.0", commit: "dev", apiVersion: 1 } }))).toBe(0);
    resetCompatCache();
    expect(await run(["accounts", "--json"], deps({ status: 404 }))).toBe(0);
    expect(err).toBe("");
    resetCompatCache();
    paths = [];
    const d = deps({ status: 200, body: { version: "9.0.0", commit: "x", apiVersion: 99 } });
    d.env!.POSTFLARE_NO_VERSION_CHECK = "1";
    expect(await run(["accounts", "--json"], d)).toBe(0);
    expect(err).toBe("");
    // No /api/version call (accounts also loads the account groups for its GROUP column).
    expect(paths.sort()).toEqual(["/api/account-groups", "/api/accounts"]);
  });

  it("suggests updating the server when its API is too old", () => {
    expect(compatWarning({ version: "0.0.1", commit: "x", apiVersion: 0 }, "1.0.0")).toMatch(/older than postflare CLI 1\.0\.0 supports \(API 1\+\)\. Update the server/);
    expect(compatWarning({ version: "0.1.0", commit: "x", apiVersion: 1 }, "1.0.0")).toBeNull();
    expect(compatWarning(null, "1.0.0")).toBeNull();
  });
});
