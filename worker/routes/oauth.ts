import { Hono } from "hono";
import { PlanLimitError, enforceWorkspace } from "../billing/entitlements";
import { sessionUser, workspaceAccess, type AppEnv } from "../lib/auth";
import { providerContext, saveConnectedAccounts } from "../lib/accounts";
import { META_PROVIDERS, deletionStatus, handleDataDeletion } from "../lib/meta-deletion";
import { connectBlocked } from "../lib/settings";
import { errorMessage, now } from "../lib/util";
import { getProvider } from "../providers/registry";

export const oauthRoutes = new Hono<AppEnv>();

const STATE_TTL_MS = 30 * 60 * 1000;

/**
 * Meta's Data Deletion Request Callback (public: Meta signs the request with the app secret). `meta` checks the
 * secrets of every configured Meta provider; a provider id only that app's. Responds `{ url, confirmation_code }`.
 */
oauthRoutes.post("/:provider/data-deletion", async (c) => {
  const id = c.req.param("provider");
  if (id !== "meta" && !(META_PROVIDERS as readonly string[]).includes(id)) return c.json({ error: "Not found" }, 404);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const signed = form.signed_request;
  if (typeof signed !== "string" || !signed) return c.json({ error: "Missing signed_request" }, 400);
  const res = await handleDataDeletion(c.env, signed, { providers: id === "meta" ? META_PROVIDERS : [id], requestUrl: c.req.url });
  if (!res.ok) return c.json({ error: res.error }, 400);
  return c.json({ url: res.url, confirmation_code: res.code });
});

/** Status of a deletion request, for the public /data-deletion/ page (the confirmation code is the only key). */
oauthRoutes.get("/meta/data-deletion/status", async (c) => {
  const record = await deletionStatus(c.env.DB, c.req.query("code") ?? "");
  if (!record) return c.json({ error: "Not found" }, 404);
  return c.json({ status: record.status, accounts: record.accounts, requestedAt: record.requested_at, completedAt: record.completed_at });
});

// Some platforms (Apple-style form_post, TikTok...) may POST the callback.
oauthRoutes.on(["GET", "POST"], ["/:provider/callback", "/:provider/callback/"], async (c) => {
  const back = (q: Record<string, string>) => c.redirect(`/accounts?${new URLSearchParams(q)}`);
  const provider = getProvider(c.req.param("provider"));
  if (!provider?.callback) return back({ error: "Unknown platform" });
  const session = await sessionUser(c);
  if (!session) return c.redirect("/login");

  const params = new URLSearchParams(new URL(c.req.url).search);
  if (c.req.method === "POST") {
    const form = await c.req.parseBody();
    for (const [k, v] of Object.entries(form)) if (typeof v === "string") params.set(k, v);
  }
  const error = params.get("error_description") || params.get("error_message") || params.get("error");
  if (error) return back({ error: `${provider.name}: ${error}` });

  const stateParam = params.get("state") ?? "";
  // Consume atomically so a replayed callback cannot reuse the state.
  const state = await c.env.DB.prepare(
    "DELETE FROM oauth_states WHERE state = ? AND provider = ? RETURNING code_verifier, created_at, user_id, workspace_id",
  )
    .bind(stateParam, provider.id)
    .first<{ code_verifier: string; created_at: number; user_id: string | null; workspace_id: string | null }>();
  if (!state || state.created_at < now() - STATE_TTL_MS) return back({ error: "Login link expired, please try again" });
  // The flow must be finished by the user who started it, who must still be allowed to manage accounts there.
  if (state.user_id !== session.user.id || !state.workspace_id) {
    return back({ error: "This connection was started by another user, please try again" });
  }
  const ws = await workspaceAccess(c.env.DB, session.user.id, session.instancePermissions, state.workspace_id);
  if (!ws?.permissions.includes("accounts.manage")) return back({ error: "You can no longer connect accounts in this workspace" });
  if (ws.demo) return back({ error: "Connecting accounts is disabled in the demo workspace" });
  const blocked = await connectBlocked(c.env.DB, provider, ws.allowedProviders);
  if (blocked) return back({ error: blocked });

  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const accounts = await provider.callback(ctx, {
      code: params.get("code") ?? params.get("oauth_verifier") ?? "",
      codeVerifier: state.code_verifier,
      params,
    });
    if (!accounts.length) return back({ error: `${provider.name}: no accounts found for this login` });
    const ids = await saveConnectedAccounts(c.env, provider.id, accounts, { workspaceId: ws.id, userId: session.user.id }, (adding) =>
      enforceWorkspace(c.env.DB, ws.id, ws.billing, { accounts: adding }, c.req.url),
    );
    return back({ connected: String(ids.length), provider: provider.id, workspaceId: ws.id });
  } catch (err) {
    // A plan limit (402 elsewhere) names its key so the app opens the upgrade dialog instead of a plain error.
    if (err instanceof PlanLimitError) return back({ error: err.body.error, planLimit: err.body.limit });
    return back({ error: `${provider.name}: ${errorMessage(err)}` });
  }
});
