-- Monthly post limits (worker/billing/host.ts postsSql): published posts are counted from usage_events (rows survive
-- deleting the post) by the UTC month of the publish outcome. Partial covering index: exactly the counted rows, so a
-- check reads no table rows and skips metrics/media/reply/failed events (outcome is a column so the IN stays covered).
-- Posts still to publish are counted through posts_workspace (workspace_id, scheduled_at) from 0003.
CREATE INDEX usage_events_ws_published ON usage_events (workspace_id, day, provider, post_id, outcome) WHERE kind = 'publish' AND outcome IN ('published', 'needs_check');

-- The created_at counter it replaces (0013, before it shipped) is no longer used.
DROP INDEX IF EXISTS posts_workspace_created;
