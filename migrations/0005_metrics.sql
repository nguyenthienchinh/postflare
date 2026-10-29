-- Analytics: metric snapshots of published posts and daily account metrics (worker/lib/metrics.ts).
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

-- One row per collection of a post (about 1h, 24h, 3d, 7d, 30d after publishing, then weekly until 90 days).
CREATE TABLE post_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  metrics TEXT NOT NULL -- JSON MetricValues
);
CREATE INDEX post_metrics_post ON post_metrics (post_id, captured_at);
CREATE INDEX post_metrics_workspace ON post_metrics (workspace_id, captured_at);

-- One row per account and UTC day (followers, following, posts...).
CREATE TABLE account_metrics (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL, -- YYYY-MM-DD (UTC)
  captured_at INTEGER NOT NULL,
  metrics TEXT NOT NULL, -- JSON MetricValues
  PRIMARY KEY (account_id, day)
);
CREATE INDEX account_metrics_workspace ON account_metrics (workspace_id, day);

-- Latest values, denormalized for lists and sorting, and the collection schedule.
ALTER TABLE posts ADD COLUMN external_data TEXT; -- JSON data publish returned (Bluesky cid, Instagram story ids...), passed to postMetrics
ALTER TABLE posts ADD COLUMN metrics TEXT; -- JSON MetricValues of the latest snapshot
ALTER TABLE posts ADD COLUMN metrics_at INTEGER; -- when the latest snapshot was taken
ALTER TABLE posts ADD COLUMN metrics_next_at INTEGER; -- next collection, NULL = none planned
ALTER TABLE posts ADD COLUMN metrics_fails INTEGER NOT NULL DEFAULT 0; -- consecutive failures (backoff, gives up after a few)
CREATE INDEX posts_metrics_due ON posts (metrics_next_at) WHERE metrics_next_at IS NOT NULL;
CREATE INDEX posts_published ON posts (workspace_id, published_at) WHERE status = 'published';

-- Analytics state of an account, independent of its publishing status.
ALTER TABLE accounts ADD COLUMN metrics TEXT; -- JSON MetricValues, latest account metrics
ALTER TABLE accounts ADD COLUMN metrics_status TEXT; -- NULL (pending) | ok | reconnect_required | not_supported | error
ALTER TABLE accounts ADD COLUMN metrics_message TEXT;
ALTER TABLE accounts ADD COLUMN metrics_checked_at INTEGER;
ALTER TABLE accounts ADD COLUMN metrics_next_at INTEGER; -- next account collection (daily), or the next re-check when blocked
ALTER TABLE accounts ADD COLUMN metrics_fails INTEGER NOT NULL DEFAULT 0;

-- Published posts of the last 90 days get collected (catch-up: one snapshot now, then the regular schedule).
UPDATE posts SET metrics_next_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE status = 'published' AND external_id IS NOT NULL AND published_at > (CAST(strftime('%s', 'now') AS INTEGER) - 90 * 86400) * 1000;
