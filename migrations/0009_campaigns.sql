-- App Store campaign links and install/revenue attribution (worker/lib/campaigns.ts, worker/lib/revflare.ts).
-- Posts tagged with an app get an App Store campaign token (ct) and a tracked short link (/a/<code>) that counts
-- clicks and redirects to https://apps.apple.com/app/apple-store/id<app>?pt=<provider token>&ct=<token>&mt=8.
-- Apple App Analytics (read through an optional Revflare connection) reports downloads and proceeds per ct.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

-- Workspace settings (workspace.manage). The Revflare API key is encrypted (lib/crypto.ts encryptJson), never returned.
ALTER TABLE workspaces ADD COLUMN apple_provider_token TEXT; -- pt= of campaign links (one per developer account, public)
ALTER TABLE workspaces ADD COLUMN campaign_autolink INTEGER NOT NULL DEFAULT 0; -- insert/replace tracked links by default
ALTER TABLE workspaces ADD COLUMN revflare_url TEXT; -- https origin of a Revflare instance
ALTER TABLE workspaces ADD COLUMN revflare_key_enc TEXT; -- encrypted rf_ API key
ALTER TABLE workspaces ADD COLUMN revflare_status TEXT; -- NULL (never synced) | ok | error
ALTER TABLE workspaces ADD COLUMN revflare_message TEXT;
ALTER TABLE workspaces ADD COLUMN revflare_synced_at INTEGER; -- last successful campaign sync
ALTER TABLE workspaces ADD COLUMN revflare_next_at INTEGER; -- next campaign sync (metrics cron), NULL = due
ALTER TABLE workspaces ADD COLUMN revflare_fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN revflare_currency TEXT; -- currency of the synced proceeds
CREATE INDEX workspaces_revflare_due ON workspaces (revflare_next_at) WHERE revflare_key_enc IS NOT NULL;

-- App Store apps of a workspace (added by hand or imported from Revflare).
CREATE TABLE workspace_apps (
  id TEXT PRIMARY KEY, -- app_...
  workspace_id TEXT NOT NULL,
  app_store_id TEXT NOT NULL, -- numeric Apple id (the id<n> of apps.apple.com links)
  name TEXT NOT NULL,
  icon_url TEXT,
  revflare_app_id TEXT, -- the id of the app in Revflare, when imported from there
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX workspace_apps_store ON workspace_apps (workspace_id, app_store_id);

-- The app a post is about, and the per-post override of the workspace auto-insert setting (NULL = workspace default).
ALTER TABLE posts ADD COLUMN app_id TEXT;
ALTER TABLE posts ADD COLUMN campaign_autolink INTEGER;

-- Tracked links: one per post (kind post, ct pf-<platform>-<id>) or per account and app (kind bio, ct pf-<platform>-bio).
CREATE TABLE campaign_links (
  code TEXT PRIMARY KEY, -- /a/<code>, 8 random base62 characters
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- post | bio
  post_id TEXT, -- kind post
  account_id TEXT,
  provider TEXT NOT NULL,
  app_id TEXT NOT NULL, -- workspace_apps.id
  app_store_id TEXT NOT NULL,
  ct TEXT NOT NULL, -- Apple campaign token (lowercase a-z 0-9 -, at most 30 characters: the limit Apple documents)
  url TEXT NOT NULL, -- the App Store campaign link /a/<code> redirects to
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX campaign_links_ct ON campaign_links (workspace_id, app_store_id, ct);
CREATE UNIQUE INDEX campaign_links_post ON campaign_links (post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX campaign_links_bio ON campaign_links (account_id, app_id) WHERE kind = 'bio';
CREATE INDEX campaign_links_workspace ON campaign_links (workspace_id, post_id);

-- Clicks per link and UTC day: one upsert per counted click.
CREATE TABLE campaign_clicks (
  code TEXT NOT NULL,
  day TEXT NOT NULL, -- YYYY-MM-DD (UTC)
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day)
) WITHOUT ROWID;

-- Apple App Analytics per campaign token (all time, from Revflare), replaced on every sync.
CREATE TABLE campaign_stats (
  workspace_id TEXT NOT NULL,
  app_store_id TEXT NOT NULL,
  ct TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0, -- first-time downloads
  redownloads INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0, -- App Store purchases (units, refunds subtract)
  proceeds REAL NOT NULL DEFAULT 0,
  sales REAL NOT NULL DEFAULT 0,
  currency TEXT,
  first_day TEXT,
  last_day TEXT, -- latest report day with this token (as-of)
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, app_store_id, ct)
) WITHOUT ROWID;
