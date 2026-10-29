import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_CSP, PAGE_CSP } from "../worker/lib/headers";

// public/_headers (static assets) and worker/lib/headers.ts (Worker responses) must send the same CSPs.
describe("security headers", () => {
  const file = readFileSync("public/_headers", "utf8");
  const csps = [...file.matchAll(/^\s*Content-Security-Policy: (.+)$/gm)].map((m) => m[1].trim());

  it("the app CSP of public/_headers matches APP_CSP (Turnstile script + iframe allowed)", () => {
    expect(csps[0]).toBe(APP_CSP);
    expect(APP_CSP).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(APP_CSP).toContain("frame-src https://challenges.cloudflare.com");
  });

  it("the landing CSP matches PAGE_CSP", () => {
    expect(csps[1]).toBe(PAGE_CSP);
  });
});
