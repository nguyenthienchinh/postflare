-- Account groups (worker/routes/accountGroups.ts): workspace-scoped "brand / project" folders for accounts.
-- An account belongs to at most one group (accounts.group_id, NULL = ungrouped). Deleting a group ungroups its accounts.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

CREATE TABLE account_groups (
  id TEXT PRIMARY KEY, -- agr_...
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL, -- palette key (shared/accountGroups.ts ACCOUNT_GROUP_COLORS)
  position INTEGER NOT NULL DEFAULT 0, -- display order, 0 first
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX account_groups_name ON account_groups (workspace_id, name COLLATE NOCASE);

ALTER TABLE accounts ADD COLUMN group_id TEXT; -- account_groups.id of the same workspace, NULL = ungrouped
CREATE INDEX accounts_group ON accounts (group_id) WHERE group_id IS NOT NULL;
