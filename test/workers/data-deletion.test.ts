import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { dailyJobs } from "../../worker/index";
import { encryptJson } from "../../worker/lib/crypto";
import { DELETION_RETENTION_MS } from "../../worker/lib/meta-deletion";
import { ensureSchema } from "../../worker/lib/migrate";
import { base64url } from "../../worker/lib/util";
import { ORIGIN } from "./helpers";
import { countingD1 } from "./d1-counter";

// Meta's Data Deletion Request Callback (POST /oauth/meta/data-deletion) and its status lookup. Own D1 instance
// (DELETION_DB): the Meta app secrets are instance-wide.

const { db: DB, count } = countingD1(env.DELETION_DB);
const E = { ...env, DB, PUBLIC_URL: "https://pf.example.com", UPDATE_CHECK: "false" } as unknown as Env;
const FB_SECRET = "fb-app-secret";
const THREADS_SECRET = "threads-app-secret";

async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, init) as any, E, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function signedRequest(secret: string, payload: Record<string, unknown>) {
  const body = base64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}.${body}`;
}

const payload = (userId: string) => ({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: Math.floor(Date.now() / 1000), expires: 0 });

function deletion(signed: string | null, path = "/oauth/meta/data-deletion") {
  const body = new URLSearchParams(signed === null ? {} : { signed_request: signed });
  return call(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
}

const run = (sql: string, ...binds: unknown[]) => DB.prepare(sql).bind(...binds).run();
const exists = async (table: string, id: string) => !!(await DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first());

async function account(id: string, provider: string, externalId: string, meta: Record<string, unknown> = {}) {
  const t = Date.now();
  await run(
    `INSERT INTO accounts (id, provider, external_id, name, credentials_enc, meta, status, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 'ws_del')`,
    id,
    provider,
    externalId,
    id,
    await encryptJson(E, { accessToken: `token-${id}` }),
    JSON.stringify(meta),
    t,
    t,
  );
  await run(
    `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, 'published', ?, 'hello', ?, ?, 'ws_del')`,
    `post_${id}`,
    `grp_${id}`,
    id,
    t,
    t,
    t,
  );
}

beforeAll(async () => {
  await ensureSchema(DB);
  const t = Date.now();
  await run("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws_del', 'Deletion', ?, ?)", t, t);
  for (const [provider, secret] of [["facebook", FB_SECRET], ["threads", THREADS_SECRET]]) {
    await run("INSERT INTO platform_apps (provider, config_enc, updated_at) VALUES (?, ?, ?)", provider, await encryptJson(E, { clientId: "id", clientSecret: secret }), t);
  }
  await account("acc_page1", "facebook", "PAGE1", { pageId: "PAGE1", metaUserId: "FBUSER1" });
  await account("acc_page2", "facebook", "PAGE2", { pageId: "PAGE2", metaUserId: "FBUSER1" });
  await account("acc_other", "facebook", "PAGE3", { pageId: "PAGE3", metaUserId: "FBUSER2" });
  // Same user id, but Instagram (Facebook login) has no app secret configured here: not matched.
  await account("acc_ig", "instagram", "IG1", { pageId: "PAGE1", metaUserId: "FBUSER1" });
  await account("acc_threads", "threads", "TH1");
});

describe("Meta data deletion callback", () => {
  it("rejects a bad signature without deleting anything", async () => {
    const forged = await signedRequest("wrong-secret", payload("FBUSER1"));
    const res = await deletion(forged);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/signed_request/);
    expect(await exists("accounts", "acc_page1")).toBe(true);
    // Tampered payload with a genuine signature of another body.
    const good = await signedRequest(FB_SECRET, payload("FBUSER2"));
    const tampered = `${good.split(".")[0]}.${base64url(JSON.stringify(payload("FBUSER1")))}`;
    expect((await deletion(tampered)).status).toBe(400);
    expect((await deletion(null)).status).toBe(400);
    expect((await deletion("not-a-signed-request")).status).toBe(400);
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'meta_deletion:%'").first("n")).toBe(0);
    expect(await exists("accounts", "acc_page2")).toBe(true);
  });

  it("removes the user's accounts and returns a status URL and confirmation code", async () => {
    count.reset();
    const res = await deletion(await signedRequest(FB_SECRET, payload("FBUSER1")));
    expect(res.status, res.text).toBe(200);
    expect(res.json.confirmation_code).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(res.json.url).toBe(`https://pf.example.com/data-deletion/?code=${res.json.confirmation_code}`);
    expect(count.calls).toBeLessThan(15);
    expect(await exists("accounts", "acc_page1")).toBe(false);
    expect(await exists("accounts", "acc_page2")).toBe(false);
    expect(await exists("posts", "post_acc_page1")).toBe(false);
    expect(await exists("accounts", "acc_other")).toBe(true);
    expect(await exists("accounts", "acc_ig")).toBe(true);
    expect(await exists("accounts", "acc_threads")).toBe(true);
    // No user id is stored with the request.
    const stored = await DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`meta_deletion:${res.json.confirmation_code}`).first<string>("value");
    expect(stored).not.toContain("FBUSER1");

    const status = await call(`/oauth/meta/data-deletion/status?code=${res.json.confirmation_code}`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ status: "completed", accounts: 2 });
    expect(status.json.completedAt).toBeGreaterThan(0);
  });

  it("matches the external id with the app secret that signed (Threads)", async () => {
    const res = await deletion(await signedRequest(THREADS_SECRET, payload("TH1")), "/oauth/threads/data-deletion");
    expect(res.status, res.text).toBe(200);
    expect(await exists("accounts", "acc_threads")).toBe(false);
    // The Facebook-only path does not accept the Threads secret.
    expect((await deletion(await signedRequest(THREADS_SECRET, payload("TH1")), "/oauth/facebook/data-deletion")).status).toBe(400);
    expect((await deletion(await signedRequest(THREADS_SECRET, payload("TH1")), "/oauth/x/data-deletion")).status).toBe(404);
  });

  it("answers no_data for an unknown user", async () => {
    const res = await deletion(await signedRequest(FB_SECRET, payload("NOBODY")));
    expect(res.status).toBe(200);
    expect(res.json.confirmation_code).toBeTruthy();
    const status = await call(`/oauth/meta/data-deletion/status?code=${res.json.confirmation_code}`);
    expect(status.json).toMatchObject({ status: "no_data", accounts: 0 });
    expect(await exists("accounts", "acc_other")).toBe(true);
  });

  it("returns 404 for unknown codes and prunes old requests in the daily cron", async () => {
    expect((await call("/oauth/meta/data-deletion/status?code=unknowncode123456")).status).toBe(404);
    expect((await call("/oauth/meta/data-deletion/status?code=<script>")).status).toBe(404);
    const old = Date.now() - DELETION_RETENTION_MS - 1000;
    await run("INSERT INTO settings (key, value) VALUES ('meta_deletion:oldcode1234567890', ?)", JSON.stringify({ status: "no_data", providers: [], accounts: 0, requested_at: old, completed_at: old }));
    const before = await DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'meta_deletion:%'").first<number>("n");
    await dailyJobs(E);
    expect(await DB.prepare("SELECT 1 FROM settings WHERE key = 'meta_deletion:oldcode1234567890'").first()).toBeNull();
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'meta_deletion:%'").first<number>("n")).toBe(before! - 1);
  });
});
