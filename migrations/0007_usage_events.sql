-- Usage metering (worker/lib/usage.ts): one row per unit of work (a publish outcome, a follow-up, a metrics batch, a
-- media upload/delete). Written inside the batch of the state change it describes, so it adds no D1 round trip.
-- Plain INTEGER PRIMARY KEY (no AUTOINCREMENT): no sqlite_sequence write per event. Kept 400 days (daily cron).
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT,
  account_id TEXT,
  post_id TEXT,
  revision INTEGER,
  provider TEXT,
  kind TEXT NOT NULL, -- publish | reply | metrics_refresh | media_upload | media_delete
  outcome TEXT NOT NULL, -- published | failed | needs_check | ok
  post_type TEXT, -- text | image | video | mixed (publish / reply)
  has_url INTEGER NOT NULL DEFAULT 0, -- the text contains a URL or a bare domain (X bills these ~13x)
  media_count INTEGER NOT NULL DEFAULT 0,
  media_bytes INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1, -- posts in a metrics batch, files in a media sweep
  workflow_steps INTEGER, -- step.do calls (publish: the instance up to "load thread"; reply: its own steps), sleeps excluded
  platform_api_calls INTEGER, -- provider fetches (ctx.fetch) for this unit of work, incl. token refreshes
  images_tx INTEGER NOT NULL DEFAULT 0, -- Cloudflare Images transformations
  is_demo INTEGER NOT NULL DEFAULT 0, -- demo workspace (simulated): excluded from instance totals
  message TEXT, -- error message of failed / needs_check outcomes
  created_at INTEGER NOT NULL,
  day TEXT NOT NULL -- YYYY-MM-DD (UTC)
);
CREATE INDEX usage_events_day ON usage_events (day);
CREATE INDEX usage_events_ws_day ON usage_events (workspace_id, day);
CREATE INDEX usage_events_provider_day ON usage_events (provider, day);

-- New permission "View instance overview" (Admin → Overview), granted to the built-in instance Admin role.
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'instance.overview.view')
  WHERE id = 'role_instance_admin' AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'instance.overview.view');
