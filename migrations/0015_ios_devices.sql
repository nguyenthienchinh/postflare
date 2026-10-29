-- iOS app (docs/ios-api.md): device tokens, pairing codes, push devices and "sign in on the web with the app"
-- (docs/app-login-spec.md).
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

-- Device tokens (Authorization: Bearer pfd_...) are sessions too: same user/workspace columns, revoked by everything
-- that ends the sessions of a user (password change, disabling or deleting the user). kind = web (cookie) | device.
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'web';
ALTER TABLE sessions ADD COLUMN name TEXT;
ALTER TABLE sessions ADD COLUMN last_used_at INTEGER;

-- One row per signed-in app install (created with its device token). apns_token is set once the app registers for
-- push (PUT /api/devices/me), NULL = push off. Rows whose session is gone are ignored and removed by the daily job.
CREATE TABLE devices (
  id TEXT PRIMARY KEY, -- dev_<random>
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE, -- sessions.id (sha256 of the device token)
  name TEXT,
  apns_token TEXT UNIQUE,
  environment TEXT NOT NULL DEFAULT 'production', -- production | sandbox (APNs host)
  prefs TEXT NOT NULL DEFAULT '{}', -- JSON { published, failed, workspaces: [ids] | null } (worker/lib/push.ts)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_push_at INTEGER
);
CREATE INDEX devices_user ON devices (user_id);

-- Pairing codes shown as a QR code on the web Profile page: single use, 5 minutes. Only the hash of the code is stored.
CREATE TABLE pairing_codes (
  id TEXT PRIMARY KEY, -- pc_<random>, polled by the web page
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  device_id TEXT
);
CREATE INDEX pairing_codes_expires ON pairing_codes (expires_at);

-- Browser sign-in approved in the app (QR or push with number matching). 3 minutes, single use.
CREATE TABLE web_logins (
  id TEXT PRIMARY KEY, -- wl_<random>, in the QR / push payload
  secret_hash TEXT NOT NULL, -- sha256 of the poll secret of the browser (only it knows the secret)
  nonce_hash TEXT NOT NULL, -- sha256 of the QR nonce (proves the scanner saw this QR)
  user_id TEXT, -- push: the target user (NULL for unknown emails), QR: set on approval
  kind TEXT NOT NULL, -- qr | push
  number INTEGER, -- push: the 2-digit number shown on the web page
  status TEXT NOT NULL, -- pending | approved | denied | consumed | expired
  ip TEXT,
  city TEXT,
  country TEXT,
  user_agent TEXT,
  approved_device_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX web_logins_expires ON web_logins (expires_at);
