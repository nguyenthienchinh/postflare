-- Users, workspaces and permission-based roles (docs/workspaces-spec.md).
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL, -- instance | workspace
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL, -- JSON array of permission keys (worker/lib/permissions.ts)
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT COLLATE NOCASE,
  instance_role_id TEXT NOT NULL,
  workspace_id TEXT, -- NULL = create a new workspace for the invitee
  workspace_role_id TEXT,
  new_workspace_name TEXT,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT
);
CREATE INDEX invitations_workspace ON invitations (workspace_id);

-- Built-in roles (ids are stable, keep in sync with BUILTIN_ROLES in worker/lib/permissions.ts).
INSERT OR IGNORE INTO roles (id, scope, name, description, permissions, builtin, created_at) VALUES
  ('role_instance_admin', 'instance', 'Admin', 'Manages platforms, users, roles and instance settings. Can act in every workspace as Owner.', '["instance.platforms.manage","instance.users.manage","instance.settings.manage","instance.workspaces.create"]', 1, 0),
  ('role_instance_member', 'instance', 'Member', 'Regular user. Can create workspaces.', '["instance.workspaces.create"]', 1, 0),
  ('role_ws_owner', 'workspace', 'Owner', 'Everything in the workspace, including deleting it.', '["workspace.manage","workspace.delete","members.manage","accounts.read","accounts.manage","posts.read","posts.write","media.read","media.write","apikeys.manage"]', 1, 0),
  ('role_ws_admin', 'workspace', 'Admin', 'Everything in the workspace except deleting it.', '["workspace.manage","members.manage","accounts.read","accounts.manage","posts.read","posts.write","media.read","media.write","apikeys.manage"]', 1, 0),
  ('role_ws_editor', 'workspace', 'Editor', 'Connects accounts, writes and schedules posts, manages media and own API keys.', '["accounts.read","accounts.manage","posts.read","posts.write","media.read","media.write","apikeys.manage"]', 1, 0),
  ('role_ws_viewer', 'workspace', 'Viewer', 'Read-only access to accounts, posts and media.', '["accounts.read","posts.read","media.read"]', 1, 0);

ALTER TABLE sessions ADD COLUMN user_id TEXT;
ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
ALTER TABLE api_keys ADD COLUMN user_id TEXT;
ALTER TABLE api_keys ADD COLUMN workspace_id TEXT;
ALTER TABLE accounts ADD COLUMN workspace_id TEXT;
ALTER TABLE accounts ADD COLUMN created_by TEXT;
ALTER TABLE posts ADD COLUMN workspace_id TEXT;
ALTER TABLE posts ADD COLUMN created_by TEXT;
ALTER TABLE media ADD COLUMN workspace_id TEXT;
ALTER TABLE media ADD COLUMN created_by TEXT;
ALTER TABLE upload_links ADD COLUMN workspace_id TEXT;
ALTER TABLE upload_links ADD COLUMN created_by TEXT;
ALTER TABLE oauth_states ADD COLUMN user_id TEXT;
ALTER TABLE oauth_states ADD COLUMN workspace_id TEXT;

CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_workspace ON sessions (workspace_id);
CREATE INDEX api_keys_user ON api_keys (user_id, workspace_id);
CREATE INDEX api_keys_workspace ON api_keys (workspace_id);
CREATE INDEX accounts_workspace ON accounts (workspace_id);
CREATE INDEX posts_workspace ON posts (workspace_id, scheduled_at);
CREATE INDEX media_workspace ON media (workspace_id, created_at);
CREATE INDEX upload_links_workspace ON upload_links (workspace_id);
CREATE INDEX oauth_states_workspace ON oauth_states (workspace_id);

-- Existing single-password install: its admin becomes usr_owner, everything moves into ws_default.
INSERT INTO users (id, email, name, password_hash, role_id, status, created_at, updated_at)
  SELECT 'usr_owner', 'owner@postflare.local', 'Owner', value, 'role_instance_admin', 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM settings WHERE key = 'admin_password';

INSERT INTO workspaces (id, name, created_by, created_at, updated_at)
  SELECT 'ws_default', 'My workspace', 'usr_owner', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');

INSERT INTO workspace_members (workspace_id, user_id, role_id, created_at)
  SELECT 'ws_default', 'usr_owner', 'role_ws_owner', CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');

UPDATE accounts SET workspace_id = 'ws_default', created_by = 'usr_owner'
  WHERE workspace_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');
UPDATE posts SET workspace_id = 'ws_default', created_by = 'usr_owner'
  WHERE workspace_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');
UPDATE media SET workspace_id = 'ws_default', created_by = 'usr_owner'
  WHERE workspace_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');
UPDATE upload_links SET workspace_id = 'ws_default', created_by = 'usr_owner'
  WHERE workspace_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');
UPDATE sessions SET user_id = 'usr_owner', workspace_id = 'ws_default'
  WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');
UPDATE api_keys SET user_id = 'usr_owner', workspace_id = 'ws_default'
  WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');
-- In-flight OAuth flows (started before the upgrade) land in the default workspace too.
UPDATE oauth_states SET user_id = 'usr_owner', workspace_id = 'ws_default'
  WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = 'usr_owner');
