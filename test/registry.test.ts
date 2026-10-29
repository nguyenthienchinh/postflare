import { describe, expect, it } from "vitest";
import { PROVIDER_NAMES, providerDisplayName } from "../shared/providerNames";
import { providerInfo, providers } from "../worker/providers/registry";

describe("provider registry", () => {
  it("has unique ids", () => {
    const ids = providers.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults to beta, with tiktok/webhook/x verified and skool experimental", () => {
    const by = (status: string) => providers.filter((p) => providerInfo(p).status === status).map((p) => p.id).sort();
    expect(by("verified")).toEqual(["tiktok", "webhook", "x"]);
    expect(by("experimental")).toEqual(["skool"]);
    expect(by("beta").length).toBe(providers.length - 4);
  });

  it("has fallback display names for every provider (Accounts page before the catalog loads)", () => {
    expect(PROVIDER_NAMES).toEqual(Object.fromEntries(providers.map((p) => [p.id, p.name])));
    expect(providerDisplayName("instagram_standalone")).toBe("Instagram");
    expect(providerDisplayName("facebook", new Map())).toBe("Facebook Page");
    expect(providerDisplayName("facebook", new Map([["facebook", { name: "Facebook" }]]))).toBe("Facebook");
    expect(providerDisplayName("unknown_x")).toBe("unknown_x");
  });

  for (const p of providers) {
    describe(p.id, () => {
      const info = providerInfo(p);
      it("implements its auth flow", () => {
        if (p.auth === "oauth2") {
          expect(p.authorize, "authorize").toBeTypeOf("function");
          expect(p.callback, "callback").toBeTypeOf("function");
        } else {
          expect(p.connect, "connect").toBeTypeOf("function");
          expect(p.credentialFields.length).toBeGreaterThan(0);
        }
      });

      it("implements reply when it supports follow-ups", () => {
        if (p.capabilities.thread) expect(p.reply).toBeTypeOf("function");
      });

      it("implements options for dynamic fields", () => {
        if (p.settingsFields.some((f) => f.dynamicOptions)) expect(p.options).toBeTypeOf("function");
      });

      it("has valid field definitions", () => {
        for (const f of [...p.appFields, ...p.credentialFields, ...p.settingsFields]) {
          expect(f.key && f.label, `${f.key} label`).toBeTruthy();
          if (f.type === "select" && !f.dynamicOptions) expect(f.options?.length, `${f.key} options`).toBeGreaterThan(0);
          if (f.showIf) expect(p.settingsFields.concat(p.credentialFields, p.appFields).some((o) => o.key === f.showIf!.key), `${f.key} showIf`).toBe(true);
        }
      });

      it("declares the metrics it collects", () => {
        if (p.postMetrics) expect(p.metrics?.post.length, "metrics.post").toBeGreaterThan(0);
        if (p.accountMetrics) expect(p.metrics?.account.length, "metrics.account").toBeGreaterThan(0);
        if (p.metrics) {
          expect(p.postMetrics || p.accountMetrics, "metrics without postMetrics/accountMetrics").toBeTruthy();
          expect(p.metrics.batch ?? 1).toBeGreaterThanOrEqual(1);
        }
      });

      it("has a valid status", () => {
        expect(["verified", "beta", "experimental"]).toContain(info.status);
        if (p.statusNote !== undefined) expect(p.statusNote.trim().length).toBeGreaterThan(0);
        // Experimental means an unofficial API: the note says which and why.
        if (info.status === "experimental") expect(p.statusNote, "statusNote").toBeTruthy();
      });

      it("has metadata", () => {
        expect(p.name).not.toBe(p.id === "x" ? "" : p.id);
        expect(p.color).toMatch(/^[0-9a-fA-F]{6}$/);
        if (p.appFields.some((f) => f.required)) expect(p.setupNotes, "setupNotes").toBeTruthy();
      });
    });
  }

});
