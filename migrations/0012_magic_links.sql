-- Sign-in links by email: the table of 0011 under the name the API uses (magic_links), plus an index on user_id
-- (a user's links end when one signs in or when the user is disabled or deleted). Throttle counters of the old
-- POST /api/auth/email-link (settings keys login_link:*) are dropped, the new ones are magic_link:*.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

ALTER TABLE login_links RENAME TO magic_links;
DROP INDEX IF EXISTS login_links_expires;
CREATE INDEX magic_links_expires ON magic_links (expires_at);
CREATE INDEX magic_links_user ON magic_links (user_id);
DELETE FROM settings WHERE key LIKE 'login_link:%';
