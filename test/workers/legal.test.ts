import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../worker/lib/crypto";
import { APP_CSP } from "../../worker/lib/headers";
import { makeCall } from "./app-helpers";

// Legal pages rendered by the Worker (worker/routes/legal.ts, worker/lib/legal.ts): the generic wording without
// operator values, the operator's details once set in Admin → Settings → Legal & contact (instance.settings.manage),
// subscription clauses only while billing is on, and the same security headers as the static assets. Own D1 (LEGAL_DB).

const DB = env.LEGAL_DB;
const E = { ...env, DB, DEMO_MODE: "false" } as unknown as Env;
const call = makeCall(E);
const PW = "password123";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

let admin: { cookie: string };
let member: { cookie: string };

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Ada", email: "ada@example.com", password: PW, workspaceName: "A" } });
  expect(setup.status, setup.text).toBe(200);
  admin = { cookie: setup.cookie! };
  const t = Date.now();
  await DB.prepare("INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at) VALUES ('usr_m', 'm@example.com', 'Max', ?, 'role_instance_member', 'active', ?, ?)")
    .bind(await hashPassword(PW), t, t)
    .run();
  const login = await call(null, "/api/auth/login", { body: { email: "m@example.com", password: PW }, headers: { "cf-connecting-ip": "10.90.0.1" } });
  member = { cookie: login.cookie! };
});

const LEGAL = { operatorName: "Ada Operator", contactEmail: "legal@example.com", postalAddress: null, country: "Türkiye", effectiveDate: null };

describe("legal pages", () => {
  it("serve the generic wording without operator values, with the static assets' security headers", async () => {
    for (const path of ["/privacy/", "/terms/", "/data-deletion/"]) {
      const res = await call(null, path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("content-security-policy")).toBe(APP_CSP);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    }
    const privacy = text((await call(null, "/privacy/")).text);
    expect(privacy).toContain("This Postflare instance at pf.test is run by its operator");
    expect(privacy).toContain("contact its operator");
    expect(privacy).toContain("TikTok data");
    const terms = text((await call(null, "/terms/")).text);
    expect(terms).toContain("Only people the operator invites");
    expect(terms).not.toMatch(/Subscriptions renew|merchant of record/);
  });

  it("redirect the paths without a trailing slash, keeping the query", async () => {
    const res = await call(null, "/data-deletion?code=abc");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/data-deletion/?code=abc");
    expect((await call(null, "/terms")).headers.get("location")).toBe("/terms/");
  });

  it("show the operator's details once set", async () => {
    const put = await call(admin, "/api/admin/legal", { method: "PUT", body: LEGAL });
    expect(put.status, put.text).toBe(200);
    expect(put.json).toEqual(LEGAL);
    const privacy = (await call(null, "/privacy/")).text;
    expect(text(privacy)).toContain("operated by Ada Operator, Türkiye (“the operator”)");
    expect(privacy).toContain("mailto:legal@example.com");
    expect(text((await call(null, "/terms/")).text)).toContain("governed by the laws of Türkiye");
    expect((await call(null, "/data-deletion/")).text).toContain("mailto:legal@example.com");
  });

  it("describe applications and subscriptions only when the instance uses them", async () => {
    await call(admin, "/api/admin/signup", { method: "PATCH", body: { mode: "apply" } });
    const t = Date.now();
    await DB.batch([
      DB.prepare("INSERT INTO plans (id, name, limits, price_month, is_free, is_trial_default, position, created_at, updated_at) VALUES ('pln_free', 'Free', '{}', NULL, 1, 0, 0, ?1, ?1), ('pln_c', 'Creator', '{}', 1900, 0, 1, 1, ?1, ?1)").bind(t),
      DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('billing_provider', 'polar'), ('billing_trial_days', '14')"),
    ]);
    // Plans and a provider, but billing not in effect: still no subscription clauses.
    expect(text((await call(null, "/terms/")).text)).not.toContain("merchant of record");
    await DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('billing_on', '1')").run();
    const terms = text((await call(null, "/terms/")).text);
    expect(terms).toContain("Access is by application");
    expect(terms).toContain("which acts as merchant of record");
    expect(terms).toContain("free 14-day trial of the Creator plan");
    expect(terms).toContain("The free plan costs nothing");
    const privacy = text((await call(null, "/privacy/")).text);
    expect(privacy).toContain("sold by Polar as merchant of record");
    expect(privacy).toContain("Access requests:");
  });

  it("clear values with empty strings", async () => {
    const res = await call(admin, "/api/admin/legal", { method: "PUT", body: { country: "", effectiveDate: "2026-11-01" } });
    expect(res.json).toEqual({ ...LEGAL, country: null, effectiveDate: "2026-11-01" });
    const terms = (await call(null, "/terms/")).text;
    expect(terms).toContain("Last updated: November 1, 2026");
    expect(terms).not.toContain("Governing law");
    expect((await call(admin, "/api/admin/legal", { method: "PUT", body: { contactEmail: "not an email" } })).status).toBe(400);
  });
});

describe("Admin → Settings → Legal & contact", () => {
  it("needs instance.settings.manage", async () => {
    expect((await call(null, "/api/admin/legal")).status).toBe(401);
    expect((await call(member, "/api/admin/legal")).status).toBe(403);
    expect((await call(member, "/api/admin/legal", { method: "PUT", body: { operatorName: "Mallory" } })).status).toBe(403);
    expect((await call(admin, "/api/admin/legal")).status).toBe(200);
    expect(text((await call(null, "/privacy/")).text)).not.toContain("Mallory");
  });
});
