import { describe, expect, it } from "vitest";
import { FREE_PLAN, quotaLevel } from "../worker/lib/admin-overview";
import { addUsage, hasUrl, newMeter, utcDay } from "../worker/lib/usage";

describe("hasUrl (usage_events.has_url)", () => {
  it("detects links with a scheme", () => {
    expect(hasUrl("Read https://example.com/post?id=1 today")).toBe(true);
    expect(hasUrl("http://localhost:3000")).toBe(true);
    expect(hasUrl("HTTPS://EXAMPLE.ORG")).toBe(true);
  });

  it("detects bare domains (X auto-links them)", () => {
    expect(hasUrl("Try postflare.io")).toBe(true);
    expect(hasUrl("docs at www.example.com/guide")).toBe(true);
    expect(hasUrl("sub.domain.dev is live")).toBe(true);
    expect(hasUrl("(see example.co)")).toBe(true);
  });

  it("ignores text without links", () => {
    expect(hasUrl("")).toBe(false);
    expect(hasUrl(null)).toBe(false);
    expect(hasUrl(undefined)).toBe(false);
    expect(hasUrl("Hello world. New release today!")).toBe(false);
    expect(hasUrl("version 1.2.3 and file.txt")).toBe(false);
    expect(hasUrl("ping @postflareio")).toBe(false);
  });

  it("does not treat e-mail addresses as links", () => {
    expect(hasUrl("mail hi@example.com")).toBe(false);
  });
});

describe("usage helpers", () => {
  it("sums attempt usage into the publish meter", () => {
    const m = newMeter();
    addUsage(m, { fetches: 3, imagesTx: 1, hasUrl: false });
    addUsage(m, undefined);
    addUsage(m, { fetches: 2, imagesTx: 0, hasUrl: true });
    expect(m).toEqual({ steps: 0, fetches: 5, imagesTx: 1, hasUrl: true });
  });

  it("formats UTC days", () => {
    expect(utcDay(Date.UTC(2026, 0, 2, 23, 59))).toBe("2026-01-02");
  });

  it("warns at 70 % and 90 %", () => {
    expect(quotaLevel(2099, FREE_PLAN.workflowStepsPerDay)).toBe("ok");
    expect(quotaLevel(2100, FREE_PLAN.workflowStepsPerDay)).toBe("warning");
    expect(quotaLevel(2700, FREE_PLAN.workflowStepsPerDay)).toBe("critical");
    expect(quotaLevel(5, 0)).toBe("ok");
  });
});
