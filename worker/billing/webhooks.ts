/**
 * POST /api/billing/webhooks/:provider (public). Load that provider's config (404 when not configured) → verify the
 * signature (400) → find the workspace (metadata, else the stored subscription / customer id) → map the product to a
 * plan → one batch: record the event (`INSERT OR IGNORE` into billing_events: a duplicate changes nothing) and update the
 * workspace, guarded on this request having recorded the event and on the event being newer than the last applied
 * change. Unknown workspaces and unmapped products answer 200 (logged): the provider must not retry forever.
 * At most 4 D1 round trips, no provider fetch.
 */
import type { BillingProviderId } from "../../shared/types";
import { now, randomToken } from "../lib/util";
import { loadProviderConfig, isConfigured } from "./config";
import { planForProduct, type PlanRow } from "./plans";
import { getBillingProvider } from "./providers";
import { WebhookSignatureError, type BillingEvent } from "./types";

export type WebhookResult =
  | { status: 200; body: { ok: true; ignored?: true; duplicate?: true; workspaceId?: string | null; stale?: true } }
  | { status: 400 | 404; body: { error: string } };

interface WorkspaceBillingRow {
  id: string;
  billing_provider: string | null;
  billing_subscription_id: string | null;
  billing_status: string;
  billing_updated_at: number | null;
}

export async function handleWebhook(env: Env, providerId: string, headers: Headers, raw: string, t = now()): Promise<WebhookResult> {
  const provider = getBillingProvider(providerId);
  if (!provider) return { status: 404, body: { error: "Unknown billing provider" } };
  const cfg = await loadProviderConfig(env, provider.id);
  if (!isConfigured(provider, cfg)) return { status: 404, body: { error: `${provider.name} is not configured on this instance` } };
  let event: BillingEvent | null;
  try {
    event = await provider.parseWebhook(cfg!, headers, raw, t);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return { status: 400, body: { error: err.message } };
    throw err;
  }
  if (!event) return { status: 200, body: { ok: true, ignored: true } };
  return applyEvent(env.DB, provider.id, event, t);
}

/** Applies a verified event (exported for tests). */
export async function applyEvent(db: D1Database, provider: BillingProviderId, event: BillingEvent, t = now()): Promise<WebhookResult> {
  const seen = await db.prepare("SELECT 1 AS x FROM billing_events WHERE provider = ? AND event_id = ?").bind(provider, event.id).first();
  if (seen) return { status: 200, body: { ok: true, duplicate: true } };

  const [wsRes, planRes] = await db.batch<any>([
    db
      .prepare(
        `SELECT id, billing_provider, billing_subscription_id, billing_status, billing_updated_at FROM workspaces
         WHERE id = ?1 OR (billing_provider = ?2 AND ((?3 IS NOT NULL AND billing_subscription_id = ?3) OR (?4 IS NOT NULL AND billing_customer_id = ?4)))
         ORDER BY id = ?1 DESC, billing_subscription_id = ?3 DESC LIMIT 1`,
      )
      .bind(event.workspaceId ?? "", provider, event.subscriptionId ?? null, event.customerId ?? null),
    db.prepare("SELECT id, provider_prices FROM plans"),
  ]);
  const ws = (wsRes.results[0] as WorkspaceBillingRow | undefined) ?? null;
  const nonce = randomToken(12);
  const record = db
    .prepare("INSERT OR IGNORE INTO billing_events (provider, event_id, type, workspace_id, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(provider, event.id, event.type, ws?.id ?? null, nonce, t);
  if (!ws) {
    console.warn(`billing webhook: no workspace for ${provider} event ${event.id} (${event.type}, workspace ${event.workspaceId}, subscription ${event.subscriptionId})`);
    await record.run();
    return { status: 200, body: { ok: true, ignored: true, workspaceId: null } };
  }
  // A late event of an older subscription (e.g. the old one expiring after a new checkout) must not end the new one.
  if (ws.billing_provider === provider && ws.billing_subscription_id && event.subscriptionId && event.subscriptionId !== ws.billing_subscription_id) {
    if (event.status === "expired" || event.status === "canceled" || event.status === "past_due") {
      await record.run();
      return { status: 200, body: { ok: true, ignored: true, workspaceId: ws.id } };
    }
  }

  const mapped = planForProduct(planRes.results as PlanRow[], provider, event.productRef);
  if (event.productRef && !mapped) console.warn(`billing webhook: ${provider} product ${event.productRef} is not mapped to a plan (Admin → Billing → plans)`);
  const at = event.occurredAt ?? t;
  const sets = ["billing_provider = ?", "billing_updated_at = ?"];
  const binds: unknown[] = [provider, at];
  if (event.customerId) sets.push("billing_customer_id = ?") && binds.push(event.customerId);
  if (event.subscriptionId) sets.push("billing_subscription_id = ?") && binds.push(event.subscriptionId);
  if (event.status) {
    sets.push("billing_status = ?") && binds.push(event.status);
    // Grace starts when the subscription becomes past due (kept while it stays past due).
    sets.push("billing_past_due_since = CASE WHEN ? = 'past_due' THEN COALESCE(CASE WHEN billing_status = 'past_due' THEN billing_past_due_since END, ?) ELSE NULL END");
    binds.push(event.status, t);
    // A paid subscription replaces the local trial.
    sets.push("trial_ends_at = CASE WHEN ? IN ('active', 'past_due', 'canceled') THEN NULL ELSE trial_ends_at END") && binds.push(event.status);
  }
  if (mapped) sets.push("plan_id = ?", "billing_interval = ?") && binds.push(mapped.planId, mapped.interval);
  else if (event.interval) sets.push("billing_interval = ?") && binds.push(event.interval);
  if (event.currentPeriodEnd !== undefined) sets.push("current_period_end = ?") && binds.push(event.currentPeriodEnd);

  const [, upd] = await db.batch([
    record,
    db
      .prepare(
        `UPDATE workspaces SET ${sets.join(", ")} WHERE id = ? AND (billing_updated_at IS NULL OR billing_updated_at <= ? OR billing_provider IS NOT ?)
           AND EXISTS (SELECT 1 FROM billing_events WHERE provider = ? AND event_id = ? AND nonce = ?)`,
      )
      .bind(...binds, ws.id, at, provider, provider, event.id, nonce),
  ]);
  if (!upd.meta.changes) {
    const dup = !(await db.prepare("SELECT 1 AS x FROM billing_events WHERE provider = ? AND event_id = ? AND nonce = ?").bind(provider, event.id, nonce).first());
    return { status: 200, body: dup ? { ok: true, duplicate: true } : { ok: true, stale: true, workspaceId: ws.id } };
  }
  return { status: 200, body: { ok: true, workspaceId: ws.id } };
}
