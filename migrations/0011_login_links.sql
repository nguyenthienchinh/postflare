-- Email sign-in links ("magic links", worker/routes/auth.ts): one row per link sent. Single use, short-lived.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY, -- sha256 of the token in the emailed URL
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER -- set when the link signs in, NULL = unused
);
CREATE INDEX login_links_expires ON login_links (expires_at);
