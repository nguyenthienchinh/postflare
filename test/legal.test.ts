import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_LEGAL,
  STATIC_CONTEXT,
  longDate,
  parseLegalInput,
  renderDataDeletion,
  renderPrivacy,
  renderTerms,
  validDate,
  type LegalContext,
} from "../worker/lib/legal";

// Instance-aware legal pages (worker/lib/legal.ts). public/{privacy,terms,data-deletion}/index.html are the generic
// rendering (fallback when run_worker_first lacks these paths): UPDATE_LEGAL=1 npx vitest run test/legal.test.ts
// rewrites them.

const FILES = [
  ["public/privacy/index.html", renderPrivacy],
  ["public/terms/index.html", renderTerms],
  ["public/data-deletion/index.html", renderDataDeletion],
] as const;

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const HOSTED: LegalContext = {
  host: "postflare.example.com",
  legal: { operatorName: "Ada Operator", contactEmail: "legal@example.com", postalAddress: null, country: "Türkiye", effectiveDate: null },
  signupMode: "apply",
  billing: { provider: "polar", trialDays: 7, trialPlan: "Creator", freePlan: true, graceDays: 7 },
  mediaRetentionDays: 30,
};
const SELF_HOSTED: LegalContext = { host: "social.example.org", legal: EMPTY_LEGAL, signupMode: "off", billing: null, mediaRetentionDays: 0 };

describe("static fallbacks", () => {
  for (const [file, render] of FILES) {
    it(`${file} is the generic rendering`, () => {
      const html = render(STATIC_CONTEXT);
      if (process.env.UPDATE_LEGAL) writeFileSync(file, html);
      expect(readFileSync(file, "utf8"), `${file} is stale: run UPDATE_LEGAL=1 npx vitest run test/legal.test.ts`).toBe(html);
    });
  }
});

describe("privacy policy", () => {
  it("generic: no operator identity, no billing, the platform sections stay", () => {
    const t = text(renderPrivacy(SELF_HOSTED));
    expect(t).toContain("run by its operator");
    expect(t).toContain("contact its operator");
    expect(t).not.toMatch(/Polar|Stripe|Lemon Squeezy|merchant of record|Billing:/);
    expect(t).not.toContain("Access requests:"); // signup mode off
    for (const s of ["TikTok data", "user.info.basic", "user.info.profile", "video.publish", "video.upload", "video.list", "Manage app permissions", "Meta data", "Google API Services User Data Policy"])
      expect(t).toContain(s);
    expect(t).toContain("unused media is kept until you delete it");
  });

  it("with the operator and billing: identity, contact, Polar, access requests", () => {
    const html = renderPrivacy(HOSTED);
    const t = text(html);
    expect(t).toContain("This Postflare instance at postflare.example.com is operated by Ada Operator, Türkiye (“the operator”)");
    expect(html).toContain('<a href="mailto:legal@example.com">legal@example.com</a>');
    expect(t).toContain("sold by Polar as merchant of record");
    expect(t).toContain("never receives or stores card data");
    expect(t).toContain("Access requests:");
    expect(t).not.toContain("contact its operator");
  });

  it("escapes the operator's values", () => {
    const html = renderPrivacy({ ...SELF_HOSTED, legal: { ...EMPTY_LEGAL, operatorName: '<script>alert("x")</script>', postalAddress: "1 Main St\n<b>Town</b>" } });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>Town");
  });

  it("the effective date overrides the version date", () => {
    expect(renderPrivacy({ ...HOSTED, legal: { ...HOSTED.legal, effectiveDate: "2026-11-01" } })).toContain("Last updated: November 1, 2026");
  });
});

describe("terms of service", () => {
  it("generic: no subscription clauses, no governing law", () => {
    const t = text(renderTerms(SELF_HOSTED));
    expect(t).not.toMatch(/Polar|merchant of record|Subscriptions renew|free trial|Governing law/);
    expect(t).toContain("Only people the operator invites");
    expect(t).toContain("GNU AGPL-3.0");
    expect(t).toContain("Branded Content Policy");
  });

  it("billing on: Polar, trial, renewal, cancellation, refunds, price changes, free plan", () => {
    const t = text(renderTerms(HOSTED));
    expect(t).toContain("operated by Ada Operator, Türkiye");
    expect(t).toContain("Access is by application");
    expect(t).toContain("sold by Polar , which acts as merchant of record");
    expect(t).toContain("free 7-day trial of the Creator plan, without a payment card");
    expect(t).toContain("renew automatically");
    expect(t).toContain("Manage billing");
    expect(t).toContain("refund policy");
    expect(t).toContain("at least 30 days' notice");
    expect(t).toContain("The free plan costs nothing");
    expect(t).toContain("governed by the laws of Türkiye");
  });

  it("no trial clause without trial days or a trial plan; Stripe is not a merchant of record", () => {
    const t = text(renderTerms({ ...HOSTED, billing: { ...HOSTED.billing!, provider: "stripe", trialDays: 0, freePlan: false } }));
    expect(t).not.toContain("trial");
    expect(t).not.toContain("merchant of record");
    expect(t).toContain("sold by the operator; payments are processed by Stripe");
    expect(t).not.toContain("The free plan");
  });
});

describe("data deletion", () => {
  it("keeps the status script and shows the contact email when set", () => {
    expect(renderDataDeletion(STATIC_CONTEXT)).toContain('<script src="/data-deletion/status.js" defer></script>');
    expect(renderDataDeletion(STATIC_CONTEXT)).toContain('id="status-text"');
    expect(renderDataDeletion(HOSTED)).toContain("mailto:legal@example.com");
    expect(renderDataDeletion(STATIC_CONTEXT)).toContain("contact the operator of this Postflare instance");
  });
});

describe("settings input", () => {
  it("validates and normalizes", () => {
    expect(parseLegalInput({ operatorName: "  Ann  Co ", contactEmail: "a@b.co", effectiveDate: "" })).toEqual({ values: { operatorName: "Ann Co", contactEmail: "a@b.co", effectiveDate: null } });
    expect(parseLegalInput({ contactEmail: "nope" })).toEqual({ error: "Enter a valid contact email" });
    expect(parseLegalInput({ effectiveDate: "2026-02-30" })).toHaveProperty("error");
    expect(parseLegalInput({ operatorName: "x".repeat(201) })).toHaveProperty("error");
    expect(parseLegalInput({ country: 3 })).toHaveProperty("error");
    expect(parseLegalInput({ postalAddress: "1 Main St\r\nTown" })).toEqual({ values: { postalAddress: "1 Main St\nTown" } });
    expect(validDate("2026-10-20")).toBe(true);
    expect(longDate("2026-10-20")).toBe("October 20, 2026");
  });
});
