-- Platforms a workspace may use (connect accounts, schedule posts). JSON array of provider ids; NULL = every platform.
-- New workspaces copy the instance setting "workspace_default_providers" (absent = NULL). Existing workspaces stay NULL.
ALTER TABLE workspaces ADD COLUMN allowed_providers TEXT;
