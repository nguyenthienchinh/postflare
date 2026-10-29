import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../worker/index";
import { hashPassword } from "../../worker/lib/crypto";
import { migrate } from "../../worker/lib/migrate";
import { sha256Hex } from "../../worker/lib/util";

// An install from before users/workspaces (migrations 0001 + 0002, single admin password), upgraded by the
// runtime migrator on the next request. Runs against its own D1 (LEGACY_DB) through the real app.
const legacyEnv = { ...env, DB: env.LEGACY_DB };
const SESSION = "legacy-session-token-0123456789abcdef";
const API_KEY = "pf_legacyapikey0123456789abcdef";
const PASSWORD = "the-old-admin-password";

async function fetchLegacy(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://pf.test${path}`, init) as any, legacyEnv as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  const db = env.LEGACY_DB;
  await migrate(db, (name) => name < "0003");
  const t = Date.now();
  await db.batch([
    db.prepare("INSERT INTO settings (key, value) VALUES ('admin_password', ?)").bind(await hashPassword(PASSWORD)),
    db.prepare("INSERT INTO settings (key, value) VALUES ('timezone', 'Europe/Istanbul')"),
    db.prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(SESSION), t, t + 86_400_000),
    db.prepare("INSERT INTO api_keys (id, name, prefix, hash, created_at) VALUES ('key_old', 'Claude', 'pf_lega', ?, ?)").bind(await sha256Hex(API_KEY), t),
    db.prepare("INSERT INTO oauth_states (state, provider, code_verifier, created_at) VALUES ('st_old', 'tiktok', 'v', ?)").bind(t),
    db.prepare(
      "INSERT INTO accounts (id, provider, external_id, name, credentials_enc, created_at, updated_at) VALUES ('acc_ig', 'instagram_standalone', '1789', 'IG', 'v1.a.b', 1, 1), ('acc_tt', 'tiktok', 'tt1', 'TT', 'v1.a.b', 1, 1)",
    ),
    db.prepare(
      "INSERT INTO media (id, r2_key, filename, mime, size, kind, created_at) VALUES ('med_1', 'med_1/a.mp4', 'a.mp4', 'video/mp4', 10, 'video', 1)",
    ),
    db.prepare(
      `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, workflow_id, revision, created_at, updated_at)
       VALUES ('pst_1', 'grp_1', 'acc_ig', 'scheduled', ?, 'hello', '["med_1"]', 'pst_1-0', 0, 1, 1),
              ('pst_2', 'grp_2', 'acc_tt', 'published', 5, 'done', '[]', NULL, 0, 1, 1)`,
    ).bind(t + 86_400_000),
    db.prepare("INSERT INTO post_logs (post_id, level, message, created_at) VALUES ('pst_1', 'info', 'Scheduled', 1)"),
    db.prepare("INSERT INTO upload_links (id, token_hash, media, created_at, expires_at) VALUES ('upl_1', 'h', '[\"med_1\"]', 1, ?)").bind(t + 86_400_000),
  ]);
});

describe("upgrading a single-password install", () => {
  it("keeps the logged-in session working, now as usr_owner in ws_default", async () => {
    const cookie = `pf_session=${SESSION}`;
    const status = await (await fetchLegacy("/api/auth/status", { headers: { cookie } })).json();
    expect(status).toEqual({ setup: true, authenticated: true });
    const me: any = await (await fetchLegacy("/api/me", { headers: { cookie } })).json();
    expect(me.user).toEqual({ id: "usr_owner", name: "Owner", email: "owner@postflare.local", role: { id: "role_instance_admin", name: "Admin" } });
    expect(me.currentWorkspaceId).toBe("ws_default");
    expect(me.workspaces).toEqual([
      expect.objectContaining({ id: "ws_default", name: "My workspace", role: { id: "role_ws_owner", name: "Owner" } }),
    ]);
    const accounts: any = await (await fetchLegacy("/api/accounts", { headers: { cookie } })).json();
    expect(accounts.map((a: any) => a.id).sort()).toEqual(["acc_ig", "acc_tt"]);
    const post: any = await (await fetchLegacy("/api/posts/pst_1", { headers: { cookie } })).json();
    expect(post).toMatchObject({ status: "scheduled", content: "hello", media: ["med_1"] });
    expect(post.logs).toHaveLength(1);
  });

  it("keeps API keys working, bound to ws_default", async () => {
    const res = await fetchLegacy("/api/posts", { headers: { authorization: `Bearer ${API_KEY}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any[]).map((p) => p.id).sort()).toEqual(["pst_1", "pst_2"]);
    const keys: any = await (await fetchLegacy("/api/keys", { headers: { authorization: `Bearer ${API_KEY}` } })).json();
    expect(keys).toEqual([expect.objectContaining({ id: "key_old", name: "Claude", userId: "usr_owner" })]);
  });

  it("backfills every row and keeps the old password (login with the placeholder email)", async () => {
    const db = env.LEGACY_DB;
    for (const table of ["accounts", "posts", "media", "upload_links"]) {
      const { results } = await db.prepare(`SELECT workspace_id, created_by FROM ${table}`).all();
      expect(results.length, table).toBeGreaterThan(0);
      for (const r of results) expect(r, table).toEqual({ workspace_id: "ws_default", created_by: "usr_owner" });
    }
    expect(await db.prepare("SELECT user_id, workspace_id FROM oauth_states").first()).toEqual({ user_id: "usr_owner", workspace_id: "ws_default" });
    expect(await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first()).toEqual({ value: "Europe/Istanbul" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'admin_password'").first()).toEqual({ n: 1 });
    const login = await fetchLegacy("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@postflare.local", password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setup = await fetchLegacy("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Intruder", email: "i@example.com", password: "password123" }),
    });
    expect(setup.status).toBe(409);
  });
});
