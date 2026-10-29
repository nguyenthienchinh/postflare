# Users, workspaces and roles

Postflare goes from "one admin password" to a multi-user instance:

- An **instance** (one deployment) has **users** and **workspaces**.
- **Platform apps** (developer credentials on the Platforms page), the public URL and user management are **instance-level** and only for instance admins.
- **Accounts, posts, media, upload links and API keys belong to a workspace.** A user can be a member of several workspaces and switches between them.
- Access is **permission-based**. Roles are named bundles of permissions. Built-in roles ship now; the `roles` table already supports custom roles later.

Example: Alice (instance Admin, Owner of "Alice") invites Bob. The invite either creates a new workspace for him ("Bob", he becomes its Owner) or adds him to an existing workspace with a role. He connects his own accounts and posts; he never sees the Platforms page.

## Permissions

Instance scope:
| key | meaning |
|---|---|
| `instance.platforms.manage` | Platforms page: developer app credentials |
| `instance.users.manage` | list users, invite, change instance role, disable/delete users, see and manage every workspace |
| `instance.settings.manage` | public URL, timezone default |
| `instance.workspaces.create` | create new workspaces (becomes Owner) |
| `instance.overview.view` | Admin → Overview: usage, publishing health, Free plan quotas across all workspaces (migrations/0007 grants it to the built-in Admin) |

Workspace scope:
| key | meaning |
|---|---|
| `workspace.manage` | rename the workspace; App Store campaign settings (Apple provider token, auto-insert default, Revflare connection, test/sync) and the workspace's apps (add, import, remove). Reading apps and tracked links needs `posts.read`; bio links need `posts.write`. No new permission or migration of roles was needed. |
| `workspace.delete` | delete the workspace and everything in it |
| `members.manage` | invite members to this workspace, change their roles, remove them |
| `accounts.read` | see connected accounts and account groups |
| `accounts.manage` | connect, reconnect, disable, remove accounts; create, rename, recolor, reorder and delete account groups and move accounts between them (migration 0010, no role changes needed) |
| `posts.read` | see posts, calendar, logs |
| `posts.write` | create, edit, schedule, publish now, retry, cancel, delete posts |
| `media.read` | see the media library |
| `media.write` | upload, import, edit alt text, delete media, create upload links |
| `playbooks.manage` | create, edit, duplicate and archive the workspace's own playbooks (reading needs `posts.read`) |
| `apikeys.manage` | create/revoke **own** API keys for this workspace |
| `billing.manage` | hosted mode: see plan and usage, upgrade (checkout), open the billing portal; built-in Owner only (migration 0013, docs/hosted-spec.md) |

## Built-in roles (`builtin = 1`, cannot be edited/deleted)

Instance: **Admin** = all instance permissions. **Member** = `instance.workspaces.create`.
Workspace: **Owner** = all workspace permissions. **Admin** = all except `workspace.delete`. **Editor** = accounts.read, accounts.manage, posts.*, media.*, playbooks.manage, apikeys.manage. **Viewer** = accounts.read, posts.read, media.read.

Rules:
- The instance must always keep at least one active instance Admin; a workspace must always keep at least one Owner. Reject changes that would break this (including deleting/disabling the last one).
- A user cannot change their own instance role.
- Members with `members.manage` can only grant workspace roles whose permissions are a subset of their own (an Admin cannot create Owners).
- Instance Admins (`instance.users.manage`) can act in any workspace as if Owner (for support/cleanup) — the workspace switcher lists all workspaces for them, marked.

## Schema (migration `0003_users_workspaces.sql`)

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id), status TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login_at INTEGER);
CREATE TABLE roles (id TEXT PRIMARY KEY, scope TEXT NOT NULL, -- instance | workspace
  name TEXT NOT NULL, description TEXT, permissions TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE workspace_members (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES roles(id),
  created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id));
CREATE TABLE invitations (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT COLLATE NOCASE,
  instance_role_id TEXT NOT NULL, workspace_id TEXT, -- NULL = create a new workspace for the invitee
  workspace_role_id TEXT, new_workspace_name TEXT, invited_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, accepted_at INTEGER, accepted_by TEXT);
```
Built-in role ids are stable: `role_instance_admin`, `role_instance_member`, `role_ws_owner`, `role_ws_admin`, `role_ws_editor`, `role_ws_viewer` (seeded in the migration with their permission JSON arrays).

Existing tables get columns (ALTER TABLE ... ADD COLUMN):
- `sessions.user_id`, `sessions.workspace_id` (last selected workspace).
- `api_keys.user_id`, `api_keys.workspace_id`.
- `accounts.workspace_id`, `accounts.created_by`; `posts.workspace_id`, `posts.created_by`; `media.workspace_id`, `media.created_by`; `upload_links.workspace_id`, `upload_links.created_by`; `oauth_states.user_id`, `oauth_states.workspace_id`.
- Indexes on every new `workspace_id`.
- `accounts` UNIQUE(provider, external_id) stays instance-wide: one social account can be connected in only one workspace (connecting it from another workspace returns a clear error naming that it is connected elsewhere — do not move it silently).

### Migrating an existing install (must be lossless — there is real data in production)
The migration itself (plain SQL, idempotent per wrangler's d1_migrations tracking):
1. Create/seed roles.
2. If `settings.admin_password` exists: create user `usr_owner` with email `owner@postflare.local` (placeholder), name `Owner`, `password_hash` = that setting, role `role_instance_admin`; create workspace `ws_default` named `My workspace`; add `usr_owner` as `role_ws_owner`.
   (Use `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM settings WHERE key='admin_password')`.)
3. Backfill: `UPDATE accounts/posts/media/upload_links SET workspace_id='ws_default', created_by='usr_owner' WHERE workspace_id IS NULL`; `UPDATE sessions SET user_id='usr_owner', workspace_id='ws_default'`; `UPDATE api_keys SET user_id='usr_owner', workspace_id='ws_default'` — only when `usr_owner` exists.
4. Keep `settings.admin_password` row (harmless) but it is no longer used for login.
The UI shows a banner to a user whose email ends with `@postflare.local`: "Set your email address" → Profile.

Fresh installs: `/api/auth/setup` now takes `{ name, email, password, workspaceName? }`, creates the first user as instance Admin + Owner of a new workspace, logs in.

## Auth & request context
- Login: `POST /api/auth/login {email, password}` (same D1 throttle per IP, plus per email). Disabled users cannot log in; their sessions/API keys stop working.
- Sign-in link by email (off by default; needs the `EMAIL` send_email binding + `EMAIL_FROM` and the instance setting `magic_link_enabled`, toggled with `GET`/`PATCH /api/admin/email {enabled}` → `{configured, from, enabled}` and tested with `POST /api/admin/email/test`, all `instance.settings.manage`; `GET /api/auth/status` then has `magicLink: true`): `POST /api/auth/magic-link {email}` always answers `{ok:true}` (404 while off, 429 after 3 per email or 10 per IP in 15 min) and mails existing active users a single-use link `/auth/link#<token>` (15 min); the page POSTs `/api/auth/magic-link/verify {token}` on click to open the session (400 invalid/used/expired, 403 disabled user, 404 while off) and the user's other links end. Links are deleted when the user is disabled or deleted and when the feature is turned off.
- `GET /api/auth/status` → `{ setup: boolean, authenticated: boolean }` (unchanged shape).
- `GET /api/me` → `{ user: {id, name, email, role: {id, name}}, instancePermissions: string[], workspaces: [{id, name, role: {id,name}, permissions: string[], viaAdmin?: true}], currentWorkspaceId }`.
- Current workspace: header `X-Workspace-Id` (sent by the web app on every request), else the session's `workspace_id`, else the user's first workspace. `POST /api/me/workspace {workspaceId}` stores it on the session. API keys are bound to one workspace (header ignored).
- Middleware sets `c.var.user`, `c.var.workspace` (id + effective permissions), `c.var.instancePermissions`. Helper `requirePermission("posts.write")` / `requireInstancePermission(...)` returns 403 `{error: "You don't have permission to …"}`.
- **Every** query on accounts/posts/media/upload_links/post_logs must be scoped by `workspace_id` (or by joining through a scoped row). Fetching an id from another workspace returns 404, never 403 (don't leak existence).
- MCP (`/mcp`) uses the API key's user + workspace and its effective permissions; tools fail with a permission error message when not allowed.
- OAuth connect: the state row stores user_id + workspace_id; the callback saves accounts into that workspace. The callback requires the same logged-in user.
- Public routes stay public: `/m/*` (signed media), `/u/*` (upload links write into the link's workspace), `/oauth/*/callback`, landing, privacy, terms, `/invite/*` page.
- Workflows/cron are unchanged in behaviour; they operate on rows regardless of workspace.

## Endpoints (new/changed)
Profile: `PATCH /api/me {name?, email?}`, `POST /api/me/password {current, next}` (logs out other sessions of that user).
Workspaces: `GET /api/workspaces` (mine; all for instance admins), `POST /api/workspaces {name}` (needs `instance.workspaces.create`), `PATCH /api/workspaces/:id {name}`, `DELETE /api/workspaces/:id` (deletes its accounts/posts/media incl. R2 objects + terminates scheduled workflows).
Members: `GET /api/workspaces/:id/members`, `PATCH /api/workspaces/:id/members/:userId {roleId}`, `DELETE /api/workspaces/:id/members/:userId` (also "leave workspace" for self).
Roles: `GET /api/roles` → all roles with permissions + `GET /api/permissions` → permission catalog with descriptions (for UI). (Creating custom roles: `POST/PATCH/DELETE /api/roles` behind `instance.users.manage`, non-builtin only — implement, simple.)
Users (instance admin): `GET /api/users` (with their workspaces), `PATCH /api/users/:id {roleId?, status?, name?}`, `DELETE /api/users/:id` (their memberships go; content stays in workspaces; refuse if last admin).
Invitations: `POST /api/invitations {email?, instanceRoleId, workspaceId?|null, workspaceRoleId?, newWorkspaceName?}` → `{id, url, expiresAt}` (link `/invite/<token>`, valid 7 days). Instance admins can invite to any workspace or a new one; users with `members.manage` can only invite into their workspace (instance role forced to Member). `GET /api/invitations` (pending, for workspaces I manage / all for admins), `DELETE /api/invitations/:id`.
Public: `GET /api/invitations/lookup/:token` → `{email, workspaceName|newWorkspaceName, invitedBy, expired}`; `POST /api/invitations/accept {token, name, email, password}` → creates the user (or, if a logged-in user accepts, just adds the membership), logs in. Email in the invite (if set) must match.
API keys: list/create/revoke only own keys in the current workspace (`apikeys.manage`); instance admins see all keys of a workspace.
Existing endpoints keep their shapes; they just become workspace-scoped and permission-checked: providers list (readable by anyone logged in; `configured` flag stays), platforms (`instance.platforms.manage`), settings (`instance.settings.manage` for writes; GET allowed to all), accounts, connect, posts, overview, media, upload-links.

No email sending: invite links are copied and sent by hand (show a copy button and a share sheet on mobile).

## Web app
- Setup page: name, email, password (+ workspace name). Login: email + password.
- Sidebar: workspace switcher at the top (list, "Create workspace" if allowed). Nav items hidden when the user lacks the permission (Platforms only with `instance.platforms.manage`; Accounts/Posts/Media/Calendar by their read permissions; write buttons hidden/disabled without write permission).
- New pages: **Profile** (name, email, password, own API keys + MCP docs moved here), **Workspace settings** (name, members table with role select, invite button, pending invites, leave/delete workspace), **Admin → Users** (users table: name, email, instance role, workspaces, status, last login; invite user; change role; disable; delete), **Admin → Roles** (read-only built-ins with permission matrix; create/edit custom roles), **Admin → Instance settings** (public URL, timezone — the current Settings page content minus API keys).
- Invite acceptance page `/invite/:token` (public route in the SPA): shows who invited and which workspace; form name/email/password; or "Join as <current user>" when logged in.
- Banner for placeholder email (`@postflare.local`).
- Everything else keeps working per current workspace (calendar, composer only lists accounts in the current workspace, etc.).
