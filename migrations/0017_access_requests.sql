-- Access requests ("Request access" on /apply, docs/hosted-spec.md "Access requests") and the sign-up mode setting.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

-- signup_enabled (1 = public sign-up) becomes signup_mode: off (invitations only, default) | apply | open.
INSERT OR IGNORE INTO settings (key, value) SELECT 'signup_mode', 'open' FROM settings WHERE key = 'signup_enabled' AND value = '1';
DELETE FROM settings WHERE key = 'signup_enabled';

-- One row per application. A pending request is updated in place when the same email applies again (unique index
-- below); approved / rejected ones stay as history. Only rejected rows are deleted, 180 days after their last change.
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY, -- ar_<random>
  name TEXT NOT NULL,
  email TEXT NOT NULL, -- normalized (lower case)
  company TEXT,
  url TEXT NOT NULL, -- website or main social profile
  role TEXT NOT NULL, -- creator | agency | startup | brand | other
  platforms TEXT NOT NULL DEFAULT '[]', -- JSON array of platform ids
  accounts INTEGER,
  volume TEXT, -- posts per month bucket
  use_case TEXT NOT NULL,
  referral TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | withdrawn
  ip TEXT,
  country TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_by TEXT, -- users.id of the admin
  reviewed_at INTEGER,
  review_note TEXT,
  invitation_id TEXT -- invitations.id created on approval
);
CREATE UNIQUE INDEX access_requests_pending_email ON access_requests (email) WHERE status = 'pending';
CREATE INDEX access_requests_status ON access_requests (status, created_at);
CREATE INDEX access_requests_created ON access_requests (created_at);
