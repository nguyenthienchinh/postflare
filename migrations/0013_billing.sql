-- Hosted mode (docs/hosted-spec.md, worker/billing/): plans, per-workspace subscriptions, provider webhook events and
-- public sign-up with email verification. Everything stays off until an instance admin turns it on.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

-- Plans are data: a named bundle of limits plus prices, defined in Admin → Billing.
CREATE TABLE plans (
  id TEXT PRIMARY KEY, -- pln_...
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '[]', -- JSON array of display strings
  limits TEXT NOT NULL DEFAULT '{}', -- JSON, keys of worker/billing/host.ts (absent or null = unlimited)
  price_month INTEGER, -- cents, NULL = interval not offered
  price_year INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  provider_prices TEXT NOT NULL DEFAULT '{}', -- JSON {"polar":{"month":"<product id>","year":"..."},"stripe":{...},"lemonsqueezy":{...}}
  is_free INTEGER NOT NULL DEFAULT 0,
  is_trial_default INTEGER NOT NULL DEFAULT 0,
  highlight INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, -- 0 = archived: keeps its subscribers, not sold
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Provider webhook events already processed (idempotency), kept 90 days (daily cleanup).
CREATE TABLE billing_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT,
  workspace_id TEXT,
  nonce TEXT, -- the request that recorded it (its workspace update is guarded on it)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX billing_events_created ON billing_events (created_at);

-- Subscription state per workspace (the billing entity).
ALTER TABLE workspaces ADD COLUMN plan_id TEXT;
ALTER TABLE workspaces ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'none'; -- none | trialing | active | past_due | canceled | expired
ALTER TABLE workspaces ADD COLUMN trial_ends_at INTEGER;
ALTER TABLE workspaces ADD COLUMN current_period_end INTEGER;
ALTER TABLE workspaces ADD COLUMN billing_provider TEXT; -- polar | stripe | lemonsqueezy | manual
ALTER TABLE workspaces ADD COLUMN billing_customer_id TEXT;
ALTER TABLE workspaces ADD COLUMN billing_subscription_id TEXT;
ALTER TABLE workspaces ADD COLUMN billing_interval TEXT; -- month | year
ALTER TABLE workspaces ADD COLUMN billing_exempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN billing_updated_at INTEGER; -- time of the last applied change (provider event time when given)
ALTER TABLE workspaces ADD COLUMN billing_past_due_since INTEGER; -- start of the past-due grace period
CREATE INDEX workspaces_billing_subscription ON workspaces (billing_provider, billing_subscription_id) WHERE billing_subscription_id IS NOT NULL;
CREATE INDEX workspaces_billing_customer ON workspaces (billing_provider, billing_customer_id) WHERE billing_customer_id IS NOT NULL;
CREATE INDEX workspaces_plan ON workspaces (plan_id) WHERE plan_id IS NOT NULL;

-- The operator own workspaces (everything that exists before billing) are never limited.
UPDATE workspaces SET billing_exempt = 1;

-- One local trial per user.
ALTER TABLE users ADD COLUMN trial_used_at INTEGER;

-- Email links: sign-in ("login") or sign-up verification ("verify", `data` = JSON {"workspaceName": ...}).
ALTER TABLE magic_links ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';
ALTER TABLE magic_links ADD COLUMN data TEXT;

-- New permission "Manage billing", granted to the built-in workspace Owner only.
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'billing.manage')
  WHERE id = 'role_ws_owner' AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'billing.manage');
