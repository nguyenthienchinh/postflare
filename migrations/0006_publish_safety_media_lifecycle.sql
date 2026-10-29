-- Double-post protection: the commit step of a publish workflow takes this lock (revision:step) before calling the
-- platform. A re-executed step that finds its own lock taken (crash, engine replay) goes to needs_check instead of
-- calling the platform again. r<revision>:free = claimed by the current code, nothing in flight.
ALTER TABLE posts ADD COLUMN publish_lock TEXT;

-- Token refresh: expiry of the refresh credential (refresh token, or the long-lived token itself), when known.
ALTER TABLE accounts ADD COLUMN refresh_expires_at INTEGER;
CREATE INDEX accounts_expiry ON accounts (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX accounts_refresh_expiry ON accounts (refresh_expires_at) WHERE refresh_expires_at IS NOT NULL;

-- Media lifecycle: where a file came from (NULL = app or API, upload_link = an upload link) for the daily sweep.
ALTER TABLE media ADD COLUMN source TEXT;
CREATE INDEX media_created ON media (created_at);
UPDATE media SET source = 'upload_link' WHERE id IN (SELECT j.value FROM upload_links l, json_each(l.media) j);
