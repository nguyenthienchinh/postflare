-- Public live demo (DEMO_MODE=true, worker/lib/demo.ts). Demo rows themselves are seeded at runtime, only when enabled.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.

-- A demo workspace is sandboxed: publishing, token refresh and dynamic options are simulated, connecting accounts and
-- uploading media are refused.
ALTER TABLE workspaces ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;

-- The shared demo identity: no instance permissions, capped workspace permissions, only reaches demo workspaces.
ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
