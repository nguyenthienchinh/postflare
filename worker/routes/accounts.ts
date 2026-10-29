import { Hono } from "hono";
import { forbidInDemoWorkspace, requirePermission, wsId, type AppEnv } from "../lib/auth";
import {
  AccountElsewhereError,
  accountDto,
  findAccount,
  freshAccount,
  providerContext,
  refreshAvatars,
  removeAccounts,
  saveConnectedAccounts,
  type AccountRow,
} from "../lib/accounts";
import { PlanLimitError, enforce } from "../billing/entitlements";
import { pkceChallenge } from "../lib/crypto";
import { connectBlocked } from "../lib/settings";
import { demoOptions } from "../lib/demo";
import { errorMessage, now, parseJson, randomToken } from "../lib/util";
import { ProviderError } from "../providers/errors";
import { findGroup } from "./accountGroups";
import { getProvider } from "../providers/registry";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get("/accounts", requirePermission("accounts.read"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM accounts WHERE workspace_id = ? ORDER BY provider, name")
    .bind(wsId(c))
    .all<AccountRow>();
  return c.json(results.map(accountDto));
});

/** `{ status?: "active" | "disabled", groupId?: string | null }` (group of this workspace, null = ungrouped). */
accountRoutes.patch("/accounts/:id", requirePermission("accounts.manage"), async (c) => {
  const input = (await c.req.json<{ status?: unknown; groupId?: unknown }>().catch(() => null)) ?? {};
  const { status, groupId } = input;
  const hasGroup = "groupId" in input;
  if (status === undefined && !hasGroup) return c.json({ error: "Nothing to change (status or groupId)" }, 400);
  if (status !== undefined && status !== "active" && status !== "disabled") return c.json({ error: "Invalid status" }, 400);
  if (hasGroup && groupId !== null && typeof groupId !== "string") return c.json({ error: "groupId must be a group id or null" }, 400);
  const ws = wsId(c);
  if (typeof groupId === "string" && !(await findGroup(c.env.DB, ws, groupId))) return c.json({ error: "Group not found" }, 404);
  // Re-enabling a disabled account counts against the plan's account limit again.
  if (status === "active") {
    const current = await findAccount(c.env, ws, c.req.param("id"));
    if (current?.status === "disabled") await enforce(c, { accounts: 1 });
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (status !== undefined) sets.push("status = ?") && binds.push(status);
  if (hasGroup) sets.push("group_id = ?") && binds.push(groupId);
  await c.env.DB.prepare(`UPDATE accounts SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .bind(...binds, now(), c.req.param("id"), ws)
    .run();
  const row = await findAccount(c.env, ws, c.req.param("id"));
  return row ? c.json(accountDto(row)) : c.json({ error: "Not found" }, 404);
});

accountRoutes.delete("/accounts/:id", requirePermission("accounts.manage"), async (c) => {
  const row = await findAccount(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  await removeAccounts(c.env, [row.id]);
  return c.json({ ok: true });
});

/** Force a token refresh (also a quick "is this account still working" check), then re-copy the avatar. */
accountRoutes.post("/accounts/:id/refresh", requirePermission("accounts.manage"), async (c) => {
  const row = await findAccount(c.env, wsId(c), c.req.param("id"));
  const provider = row && getProvider(row.provider);
  if (!row || !provider) return c.json({ error: "Not found" }, 404);
  // Demo workspace: the tokens are fake, there is nothing to refresh.
  if (c.var.workspace?.demo) return c.json(accountDto(row));
  if (provider.refresh) {
    try {
      const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
      await freshAccount(c.env, provider, ctx, row, { force: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  }
  const fresh = (await findAccount(c.env, wsId(c), row.id))!;
  if (provider.profile || fresh.avatar_url) {
    await refreshAvatars(c.env, { rows: [fresh] });
    return c.json(accountDto((await findAccount(c.env, wsId(c), row.id)) ?? fresh));
  }
  return c.json(accountDto(fresh));
});

/** GET /api/accounts/:id/composer-info: what the platform says about posting right now (TikTok creator_info). */
accountRoutes.get("/accounts/:id/composer-info", requirePermission("posts.write"), async (c) => {
  const row = await findAccount(c.env, wsId(c), c.req.param("id"));
  const provider = row && getProvider(row.provider);
  if (!row || !provider) return c.json({ error: "Not found" }, 404);
  if (!provider.composerInfo || c.var.workspace?.demo) return c.json({});
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const account = await freshAccount(c.env, provider, ctx, row);
    return c.json(await provider.composerInfo(ctx, account));
  } catch (err) {
    return c.json({ error: errorMessage(err) }, err instanceof ProviderError && err.kind === "auth" ? 409 : 400);
  }
});

// Used by the composer to fill dynamic settings fields (boards, channels...), so it needs posts.write.
accountRoutes.get("/accounts/:id/options/:key", requirePermission("posts.write"), async (c) => {
  const row = await findAccount(c.env, wsId(c), c.req.param("id"));
  const provider = row && getProvider(row.provider);
  if (!row || !provider) return c.json({ error: "Not found" }, 404);
  if (!provider.options) return c.json([]);
  // Demo workspace: a small fake list instead of asking the platform.
  if (c.var.workspace?.demo) return c.json(demoOptions(provider.id, c.req.param("key")));
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const account = await freshAccount(c.env, provider, ctx, row);
    const settings = parseJson<Record<string, unknown>>(c.req.query("settings"), {});
    return c.json(await provider.options(ctx, account, c.req.param("key"), settings));
  } catch (err) {
    return c.json({ error: errorMessage(err) }, err instanceof ProviderError && err.kind === "auth" ? 409 : 400);
  }
});

/** Connect with credentials (app passwords, bot tokens, API keys). */
accountRoutes.post("/connect/:provider", requirePermission("accounts.manage"), forbidInDemoWorkspace("Connecting accounts"), async (c) => {
  const provider = getProvider(c.req.param("provider"));
  if (!provider?.connect) return c.json({ error: "This platform connects with OAuth" }, 400);
  const blocked = await connectBlocked(c.env.DB, provider, c.var.workspace?.allowedProviders);
  if (blocked) return c.json({ error: blocked }, 403);
  const { values } = await c.req.json<{ values: Record<string, string> }>();
  for (const f of provider.credentialFields) {
    if (f.required && !values?.[f.key]?.trim()) return c.json({ error: `${f.label} is required` }, 400);
  }
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const accounts = await provider.connect(ctx, values);
    const ids = await saveConnectedAccounts(c.env, provider.id, accounts, { workspaceId: wsId(c), userId: c.var.user.id }, (adding) => enforce(c, { accounts: adding }));
    return c.json({ ids });
  } catch (err) {
    if (err instanceof PlanLimitError) throw err;
    return c.json({ error: errorMessage(err) }, err instanceof AccountElsewhereError ? 409 : 400);
  }
});

/**
 * Start an OAuth flow: returns the platform authorization URL. `?switchAccount=1` asks the platform to show its login
 * again so another account can be picked (only providers with `switchAccount`; ignored by the others).
 */
accountRoutes.get("/connect/:provider/url", requirePermission("accounts.manage"), forbidInDemoWorkspace("Connecting accounts"), async (c) => {
  const provider = getProvider(c.req.param("provider"));
  if (!provider?.authorize) return c.json({ error: "This platform connects with credentials" }, 400);
  const blocked = await connectBlocked(c.env.DB, provider, c.var.workspace?.allowedProviders);
  if (blocked) return c.json({ error: blocked }, 403);
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    const switchAccount = !!provider.switchAccount && ["1", "true"].includes(c.req.query("switchAccount") ?? "");
    const url = await provider.authorize(ctx, { state, codeVerifier, codeChallenge: await pkceChallenge(codeVerifier), switchAccount });
    // The callback saves into this workspace, and only for this user.
    await c.env.DB.prepare(
      "INSERT INTO oauth_states (state, provider, code_verifier, user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(state, provider.id, codeVerifier, c.var.user.id, wsId(c), now())
      .run();
    return c.json({ url });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});
