-- Playbooks (worker/lib/playbooks.ts): reusable, versioned recipes for writing posts. Built-in playbooks are Markdown
-- files bundled into the Worker (playbooks/*.md); workspaces can add their own here. Posts record which playbook
-- (and version / A-B variant) they were written with, so the analytics can rank playbooks.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

-- Custom playbooks of a workspace: the head row carries the latest version (what lists and searches read).
CREATE TABLE playbooks (
  id TEXT PRIMARY KEY, -- pbk_...
  workspace_id TEXT NOT NULL,
  slug TEXT NOT NULL, -- kebab-case, unique in the workspace, never equal to a built-in id
  version INTEGER NOT NULL, -- latest version (1, 2, ...)
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL, -- engagement | reach | clicks | followers | conversions
  platforms TEXT NOT NULL DEFAULT '[]', -- JSON array of provider ids / groups
  formats TEXT NOT NULL DEFAULT '[]', -- JSON array: text, thread, image, carousel, video
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array
  inputs TEXT NOT NULL DEFAULT '[]', -- JSON array: what the writer must know first
  body TEXT NOT NULL, -- Markdown
  based_on TEXT, -- "<built-in id>@<version>" it was duplicated from
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 -- deleted from the library, kept for the attribution of existing posts
);
CREATE UNIQUE INDEX playbooks_slug ON playbooks (workspace_id, slug);

-- Every version ever saved, immutable: an edit inserts a new row (posts keep pointing at the version they used).
CREATE TABLE playbook_versions (
  playbook_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL,
  platforms TEXT NOT NULL DEFAULT '[]',
  formats TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  inputs TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (playbook_id, version)
);
CREATE INDEX playbook_versions_workspace ON playbook_versions (workspace_id);

-- Attribution of posts: built-in id (e.g. "launch-announcement") or custom id (pbk_...), its version, A/B label.
ALTER TABLE posts ADD COLUMN playbook_id TEXT;
ALTER TABLE posts ADD COLUMN playbook_version INTEGER;
ALTER TABLE posts ADD COLUMN variant TEXT;
CREATE INDEX posts_playbook ON posts (workspace_id, playbook_id) WHERE playbook_id IS NOT NULL;

-- New permission "Manage playbooks", granted to the built-in workspace Owner, Admin and Editor roles.
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'playbooks.manage')
  WHERE id IN ('role_ws_owner', 'role_ws_admin', 'role_ws_editor') AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'playbooks.manage');
