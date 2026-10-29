import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AVATAR_RECHECK_MS, AVATARS_PER_TICK, refreshAvatars, removeAccounts, saveConnectedAccounts } from "../../worker/lib/accounts";
import { AVATAR_MAX_BYTES, storedAvatarName } from "../../worker/lib/avatars";
import { makeCall } from "./app-helpers";
import { countingD1 } from "./d1-counter";

// Connecting accounts: the OAuth connect URL and avatars copied to R2. Own D1 instance (ACCOUNTS_DB); R2 is the shared
// test bucket (avatar keys hold unique account ids).

const E = { ...env, DB: env.ACCOUNTS_DB, DEMO_MODE: "false", PUBLIC_URL: "https://pf.test", MEDIA_PUBLIC_URL: undefined } as unknown as Env;
const call = makeCall(E);
let owner: { cookie: string };

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", { body: { name: "Ann", email: "ann@example.com", password: "password123", workspaceName: "Ann" } });
  expect(setup.status, setup.text).toBe(200);
  owner = { cookie: setup.cookie! };
  const app = await call(owner, "/api/platforms/instagram_standalone", { method: "PUT", body: { values: { clientId: "IGAPP", clientSecret: "IGSECRET" } } });
  expect(app.status, app.text).toBe(200);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/connect/:provider/url", () => {
  it("never forces the Instagram login by default; switchAccount=1 opts in", async () => {
    const plain = await call(owner, "/api/connect/instagram_standalone/url");
    expect(plain.status, plain.text).toBe(200);
    expect(new URL(plain.json.url).searchParams.has("force_reauth")).toBe(false);
    const other = await call(owner, "/api/connect/instagram_standalone/url?switchAccount=1");
    expect(new URL(other.json.url).searchParams.get("force_reauth")).toBe("true");
    const platforms = await call(owner, "/api/providers");
    const ig = platforms.json.find((p: any) => p.id === "instagram_standalone");
    expect(ig.switchAccount).toMatchObject({ label: "Use a different Instagram account" });
  });
});

describe("reconnecting an account", () => {
  const ws = async () => (await E.DB.prepare("SELECT id FROM workspaces LIMIT 1").first<{ id: string }>())!.id;
  const user = async () => (await E.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>())!.id;
  const dto = async (id: string) => (await call(owner, "/api/accounts")).json.find((a: any) => a.id === id);

  it("records reconnectedAt and keeps analytics that already work; blocked analytics are re-checked", async () => {
    mockPictures({});
    const owner_ = { workspaceId: await ws(), userId: await user() };
    const [id] = await saveConnectedAccounts(E, "instagram_standalone", [igAccount("ig_re", null)], owner_);
    const fresh = await dto(id);
    expect(fresh.reconnectedAt).toBeNull();
    expect(fresh.metricsStatus.status).toBe("pending");
    await E.DB.prepare("UPDATE accounts SET created_at = 1000, metrics = '{\"followers\":42}', metrics_status = 'ok', metrics_checked_at = 2000, metrics_next_at = ? WHERE id = ?")
      .bind(Date.now() + 86_400_000, id)
      .run();

    expect(await saveConnectedAccounts(E, "instagram_standalone", [igAccount("ig_re", null)], owner_)).toEqual([id]);
    const again = await dto(id);
    expect(again.createdAt).toBe(1000);
    expect(again.reconnectedAt).toBeGreaterThan(1000);
    expect(again.metricsStatus).toMatchObject({ status: "ok", metrics: { followers: 42 } });
    const row = await accountRow(id);
    expect(row.metrics_next_at).toBeNull(); // collected again at the next analytics tick (new permissions)

    // A blocked state is cleared so the new token is tried; the stored values still show as collected.
    await E.DB.prepare("UPDATE accounts SET metrics_status = 'reconnect_required', metrics_message = 'grant insights' WHERE id = ?").bind(id).run();
    await saveConnectedAccounts(E, "instagram_standalone", [igAccount("ig_re", null)], owner_);
    expect((await accountRow(id)).metrics_status).toBeNull();
    expect((await dto(id)).metricsStatus).toMatchObject({ status: "ok", message: null });
    // Never collected: pending.
    await E.DB.prepare("UPDATE accounts SET metrics = NULL WHERE id = ?").bind(id).run();
    expect((await dto(id)).metricsStatus.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Avatars copied to R2 (worker/lib/avatars.ts)

const jpeg = (fill: number, size = 64) => {
  const b = new Uint8Array(size).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const PIC_A = "https://scontent.cdninstagram.com/v/a.jpg?oe=1";
const PIC_B = "https://scontent.cdninstagram.com/v/b.jpg?oe=2";
const PIC_FRESH = "https://scontent.cdninstagram.com/v/fresh.jpg?oe=3";

/** globalThis.fetch: pictures by URL (`null` = 403 like an expired signed link), Graph /me with a fresh picture URL. */
function mockPictures(pictures: Record<string, Response | null>, profile: string | null = PIC_FRESH) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input as any, init).url;
    calls.push(url);
    if (url.startsWith("https://graph.instagram.com/")) return Response.json({ profile_picture_url: profile });
    const res = pictures[url];
    return res ? res.clone() : new Response("URL signature expired", { status: 403 });
  });
  return calls;
}
const pic = (bytes: Uint8Array | string, type = "image/jpeg") => new Response(bytes, { headers: { "content-type": type } });

let wsId = "";
let userId = "";
const accountRow = (id: string) => E.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<any>();
const avatarObjects = async (id: string) => (await env.MEDIA.list({ prefix: `avatars/${id}-` })).objects.map((o) => o.key);
const igAccount = (externalId: string, avatarUrl: string | null) => ({
  externalId,
  name: `IG ${externalId}`,
  username: externalId,
  avatarUrl,
  credentials: { accessToken: "LONG" },
  expiresAt: null,
});

describe("account avatars", () => {
  beforeAll(async () => {
    wsId = (await E.DB.prepare("SELECT id FROM workspaces LIMIT 1").first<{ id: string }>())!.id;
    userId = (await E.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>())!.id;
  });

  it("connect copies the picture to R2 and stores a stable URL; reconnecting with another picture replaces it", async () => {
    mockPictures({ [PIC_A]: pic(jpeg(1)), [PIC_B]: pic(jpeg(2)) });
    const [id] = await saveConnectedAccounts(E, "instagram_standalone", [igAccount("ig_1", PIC_A)], { workspaceId: wsId, userId });
    const row = await accountRow(id);
    expect(row.avatar_url).toMatch(new RegExp(`^https://pf\\.test/m/avatars/[\\w-]{22}/${id}-[0-9a-f]{16}\\.jpg$`));
    expect(row.avatar_checked_at).toBeGreaterThan(0);
    const first = await avatarObjects(id);
    expect(first).toHaveLength(1);
    // Served by the Worker (no D1 read), immutable; a wrong signature is a 404.
    vi.restoreAllMocks();
    const served = await call(null, new URL(row.avatar_url).pathname);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(served.headers.get("cache-control")).toContain("immutable");
    const name = row.avatar_url.split("/").pop();
    expect((await call(null, `/m/avatars/AAAAAAAAAAAAAAAAAAAAAA/${name}`)).status).toBe(404);
    expect((await call(owner, "/api/accounts")).json.find((a: any) => a.id === id).avatarUrl).toBe(row.avatar_url);

    mockPictures({ [PIC_A]: pic(jpeg(1)), [PIC_B]: pic(jpeg(2)) });
    expect(await saveConnectedAccounts(E, "instagram_standalone", [igAccount("ig_1", PIC_B)], { workspaceId: wsId, userId })).toEqual([id]);
    const after = await accountRow(id);
    expect(after.avatar_url).not.toBe(row.avatar_url);
    const objects = await avatarObjects(id);
    expect(objects).toHaveLength(1);
    expect(objects[0]).not.toBe(first[0]);
  });

  it("never breaks connecting: expired, non-image, SVG or oversized pictures keep the platform URL for a retry", async () => {
    const big = jpeg(3, AVATAR_MAX_BYTES + 10);
    mockPictures({
      "https://x.example/html": pic("<html>", "text/html"),
      "https://x.example/svg": pic('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/svg+xml"),
      "https://x.example/big": pic(big),
    });
    const urls = ["https://expired.example/a.jpg", "https://x.example/html", "https://x.example/svg", "https://x.example/big", "http://x.example/plain.jpg"];
    const ids = await saveConnectedAccounts(
      E,
      "instagram_standalone",
      urls.map((u, i) => igAccount(`ig_bad_${i}`, u)),
      { workspaceId: wsId, userId },
    );
    for (const [i, id] of ids.entries()) {
      const row = await accountRow(id);
      expect(row.avatar_url).toBe(urls[i]);
      expect(row.avatar_checked_at).toBeNull();
      expect(await avatarObjects(id)).toEqual([]);
    }
    await removeAccounts(E, ids);
  });

  it("uses the media domain when MEDIA_PUBLIC_URL is set", async () => {
    mockPictures({ [PIC_A]: pic(jpeg(4)) });
    const cdnEnv = { ...E, MEDIA_PUBLIC_URL: "https://cdn.pf.test" } as Env;
    const [id] = await saveConnectedAccounts(cdnEnv, "instagram_standalone", [igAccount("ig_cdn", PIC_A)], { workspaceId: wsId, userId });
    expect((await accountRow(id)).avatar_url).toMatch(new RegExp(`^https://cdn\\.pf\\.test/avatars/${id}-[0-9a-f]{16}\\.jpg$`));
    await removeAccounts(cdnEnv, [id]);
  });

  it("the cron backfills existing accounts with a fresh profile picture, within the tick's budget", async () => {
    // Connected before avatars were copied: the stored signed URL has expired, avatar_checked_at is NULL.
    mockPictures({});
    const [id] = await saveConnectedAccounts(E, "instagram_standalone", [igAccount("ig_old", "https://scontent.cdninstagram.com/v/expired.jpg")], { workspaceId: wsId, userId });
    await E.DB.prepare("UPDATE accounts SET avatar_checked_at = NULL WHERE id = ?").bind(id).run();
    // Everyone else was checked recently.
    await E.DB.prepare("UPDATE accounts SET avatar_checked_at = ? WHERE id != ?").bind(Date.now(), id).run();
    vi.restoreAllMocks();
    const calls = mockPictures({ [PIC_FRESH]: pic(jpeg(5)) });
    const { db, count } = countingD1(E.DB);
    expect(await refreshAvatars({ ...E, DB: db } as Env)).toBe(1);
    expect(calls).toEqual([expect.stringMatching(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/me\?/), PIC_FRESH]);
    expect(count.queries + count.batchStatements, count.sql.join("\n")).toBeLessThanOrEqual(5);
    const row = await accountRow(id);
    expect(row.avatar_url).toMatch(new RegExp(`/m/avatars/[\\w-]{22}/${id}-[0-9a-f]{16}\\.jpg$`));
    expect(row.avatar_checked_at).toBeGreaterThan(Date.now() - 60_000);
    // Checked: not picked again until the weekly re-check.
    vi.restoreAllMocks();
    const again = mockPictures({});
    expect(await refreshAvatars(E)).toBe(0);
    expect(again).toEqual([]);
    expect(AVATARS_PER_TICK).toBeLessThanOrEqual(3);
  });

  it("a failed re-check keeps the stored copy and retries a day later", async () => {
    mockPictures({ [PIC_A]: pic(jpeg(6)) });
    const [id] = await saveConnectedAccounts(E, "instagram_standalone", [igAccount("ig_keep", PIC_A)], { workspaceId: wsId, userId });
    const stored = (await accountRow(id)).avatar_url;
    vi.restoreAllMocks();
    // The profile answers with a picture that cannot be downloaded.
    mockPictures({}, "https://scontent.cdninstagram.com/v/broken.jpg");
    const row = await accountRow(id);
    await refreshAvatars(E, { rows: [row] });
    const after = await accountRow(id);
    expect(after.avatar_url).toBe(stored);
    expect(after.avatar_checked_at).toBeLessThan(Date.now() - AVATAR_RECHECK_MS + 25 * 60 * 60 * 1000);
    expect(await avatarObjects(id)).toHaveLength(1);
  });

  it("removing an account deletes its avatar copies", async () => {
    mockPictures({ [PIC_A]: pic(jpeg(7)) });
    const [id] = await saveConnectedAccounts(E, "instagram_standalone", [igAccount("ig_rm", PIC_A)], { workspaceId: wsId, userId });
    expect(await avatarObjects(id)).toHaveLength(1);
    vi.restoreAllMocks();
    expect((await call(owner, `/api/accounts/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await avatarObjects(id)).toEqual([]);
  });

  it("recognizes only this account's copies as stored avatars", () => {
    expect(storedAvatarName("https://pf.test/m/avatars/sig/acc_1-0123456789abcdef.jpg", "acc_1")).toBe("acc_1-0123456789abcdef.jpg");
    expect(storedAvatarName("https://cdn.pf.test/avatars/acc_1-0123456789abcdef.png", "acc_1")).toBe("acc_1-0123456789abcdef.png");
    expect(storedAvatarName("https://cdn.pf.test/avatars/acc_1-x-0123456789abcdef.png", "acc_1")).toBeNull();
    expect(storedAvatarName("https://cdn.pf.test/avatars/acc_2-0123456789abcdef.png", "acc_1")).toBeNull();
    expect(storedAvatarName(PIC_A, "acc_1")).toBeNull();
    expect(storedAvatarName(null, "acc_1")).toBeNull();
  });
});

describe("platforms a workspace may use", () => {
  it("new workspaces copy the instance default; connecting and the provider list follow the workspace", async () => {
    const save = await call(owner, "/api/settings", { method: "PUT", body: { workspaceProviders: ["youtube", "youtube"] } });
    expect(save.status, save.text).toBe(200);
    expect((await call(owner, "/api/settings")).json.workspaceProviders).toEqual(["youtube"]);
    expect((await call(owner, "/api/settings", { method: "PUT", body: { workspaceProviders: ["nope"] } })).status).toBe(400);

    const ws = await call(owner, "/api/workspaces", { body: { name: "Limited" } });
    expect(ws.status, ws.text).toBe(201);
    const limited = { ...owner, ws: ws.json.id as string };

    const blocked = await call(limited, "/api/connect/instagram_standalone/url");
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toMatch(/not available in this workspace/);
    const list = await call(limited, "/api/providers");
    expect(list.json.find((p: any) => p.id === "instagram_standalone").allowed).toBe(false);
    expect(list.json.find((p: any) => p.id === "youtube").allowed).toBe(true);

    // The first workspace predates the setting: every platform.
    expect((await call(owner, "/api/connect/instagram_standalone/url")).status).toBe(200);

    const admin = await call(owner, `/api/admin/workspaces/${limited.ws}/billing`, { method: "PATCH", body: { allowedProviders: null } });
    expect(admin.status, admin.text).toBe(200);
    expect(admin.json.allowedProviders).toBeNull();
    expect((await call(limited, "/api/connect/instagram_standalone/url")).status).toBe(200);
    const bad = await call(owner, `/api/admin/workspaces/${limited.ws}/billing`, { method: "PATCH", body: { allowedProviders: ["nope"] } });
    expect(bad.status).toBe(400);

    await call(owner, "/api/settings", { method: "PUT", body: { workspaceProviders: null } });
    expect((await call(owner, "/api/settings")).json.workspaceProviders).toBeNull();
  });
});
