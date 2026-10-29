-- Key/value app settings (admin password hash, session key, generated encryption key, timezone, ...)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Developer app credentials per platform (client id / secret / extra fields), entered in the UI.
CREATE TABLE platform_apps (
  provider TEXT PRIMARY KEY,
  config_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  credentials_enc TEXT NOT NULL,
  expires_at INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active', -- active | disabled | reconnect
  status_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider, external_id)
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL, -- image | video
  width INTEGER,
  height INTEGER,
  duration REAL,
  alt TEXT,
  status TEXT NOT NULL DEFAULT 'ready', -- uploading | ready
  upload_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- draft | scheduled | publishing | published | failed | cancelled
  scheduled_at INTEGER,
  content TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',      -- JSON array of media ids
  settings TEXT NOT NULL DEFAULT '{}',   -- JSON provider-specific settings
  thread TEXT NOT NULL DEFAULT '[]',     -- JSON array of {content, media} follow-ups (replies / comments)
  external_id TEXT,
  external_url TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  workflow_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX posts_scheduled ON posts (status, scheduled_at);
CREATE INDEX posts_group ON posts (group_id);
CREATE INDEX posts_account ON posts (account_id);

CREATE TABLE post_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  level TEXT NOT NULL, -- info | warn | error
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX post_logs_post ON post_logs (post_id, id);
