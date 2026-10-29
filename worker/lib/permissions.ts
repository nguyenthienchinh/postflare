import type { InstancePermission, PermissionInfo, PermissionKey, WorkspacePermission } from "../../shared/types";

/**
 * The permission catalog: every permission the app checks, with the text shown in the UI and in 403 errors.
 * Roles (table `roles`) are named bundles of these keys. Built-in roles are seeded by migrations/0003
 * (`instance.overview.view` is added to the instance Admin by migrations/0007, `billing.manage` to the Owner by 0013,
 * `instance.support.manage` to the instance Admin by 0021).
 */
export const PERMISSIONS: ReadonlyArray<PermissionInfo & { action: string }> = [
  {
    key: "instance.platforms.manage",
    scope: "instance",
    label: "Manage platforms",
    description: "Platforms page: developer app credentials (client ids and secrets).",
    action: "manage platform apps",
  },
  {
    key: "instance.users.manage",
    scope: "instance",
    label: "Manage users",
    description: "List users, invite, change instance roles, disable or delete users, manage roles, see and manage every workspace.",
    action: "manage users",
  },
  {
    key: "instance.settings.manage",
    scope: "instance",
    label: "Manage instance settings",
    description: "Public URL and default timezone.",
    action: "change instance settings",
  },
  {
    key: "instance.workspaces.create",
    scope: "instance",
    label: "Create workspaces",
    description: "Create new workspaces (the creator becomes their Owner).",
    action: "create workspaces",
  },
  {
    key: "instance.overview.view",
    scope: "instance",
    label: "View instance overview",
    description: "Admin overview: usage, publishing health and Free plan quotas across every workspace.",
    action: "view the instance overview",
  },
  {
    key: "instance.support.manage",
    scope: "instance",
    label: "Answer support chats",
    description: "Admin → Support: read and answer the support chat (tickets), its settings and push notifications.",
    action: "answer support chats",
  },
  {
    key: "workspace.manage",
    scope: "workspace",
    label: "Manage workspace",
    description: "Rename the workspace; App Store campaign settings (provider token, auto-insert, Revflare connection) and apps.",
    action: "manage this workspace",
  },
  {
    key: "workspace.delete",
    scope: "workspace",
    label: "Delete workspace",
    description: "Delete the workspace and everything in it.",
    action: "delete this workspace",
  },
  {
    key: "members.manage",
    scope: "workspace",
    label: "Manage members",
    description: "Invite members to the workspace, change their roles, remove them.",
    action: "manage members of this workspace",
  },
  { key: "accounts.read", scope: "workspace", label: "View accounts", description: "See connected accounts.", action: "view accounts" },
  {
    key: "accounts.manage",
    scope: "workspace",
    label: "Manage accounts",
    description: "Connect, reconnect, disable and remove accounts.",
    action: "manage accounts",
  },
  { key: "posts.read", scope: "workspace", label: "View posts", description: "See posts, the calendar and publishing logs.", action: "view posts" },
  {
    key: "posts.write",
    scope: "workspace",
    label: "Write posts",
    description: "Create, edit, schedule, publish now, retry, cancel and delete posts.",
    action: "create or change posts",
  },
  { key: "media.read", scope: "workspace", label: "View media", description: "See the media library.", action: "view media" },
  {
    key: "media.write",
    scope: "workspace",
    label: "Manage media",
    description: "Upload, import, edit alt text, delete media and create upload links.",
    action: "upload or change media",
  },
  {
    key: "playbooks.manage",
    scope: "workspace",
    label: "Manage playbooks",
    description: "Create, edit, duplicate and archive the workspace's own playbooks (everyone who can view posts can read them).",
    action: "manage playbooks",
  },
  {
    key: "apikeys.manage",
    scope: "workspace",
    label: "Manage own API keys",
    description: "Create and revoke your own API keys for this workspace.",
    action: "manage API keys",
  },
  {
    key: "billing.manage",
    scope: "workspace",
    label: "Manage billing",
    description: "See the plan and usage, upgrade, open the billing portal and cancel (hosted mode; everyone who can view posts sees the plan and limits).",
    action: "manage billing of this workspace",
  },
];

export const INSTANCE_PERMISSIONS = PERMISSIONS.filter((p) => p.scope === "instance").map((p) => p.key as InstancePermission);
export const WORKSPACE_PERMISSIONS = PERMISSIONS.filter((p) => p.scope === "workspace").map((p) => p.key as WorkspacePermission);

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function isPermission(key: string, scope?: "instance" | "workspace"): key is PermissionKey {
  const p = BY_KEY.get(key as PermissionKey);
  return !!p && (!scope || p.scope === scope);
}

export function permissionError(key: PermissionKey): string {
  return `You don't have permission to ${BY_KEY.get(key)?.action ?? key}`;
}

export const ROLE = {
  instanceAdmin: "role_instance_admin",
  instanceMember: "role_instance_member",
  owner: "role_ws_owner",
  admin: "role_ws_admin",
  editor: "role_ws_editor",
  viewer: "role_ws_viewer",
} as const;

/** Mirrors the seed rows of migrations/0003 plus 0007, 0008 and 0013 (a test checks they match). */
export const BUILTIN_ROLES: Record<string, { scope: "instance" | "workspace"; name: string; permissions: PermissionKey[] }> = {
  [ROLE.instanceAdmin]: { scope: "instance", name: "Admin", permissions: [...INSTANCE_PERMISSIONS] },
  [ROLE.instanceMember]: { scope: "instance", name: "Member", permissions: ["instance.workspaces.create"] },
  [ROLE.owner]: { scope: "workspace", name: "Owner", permissions: [...WORKSPACE_PERMISSIONS] },
  // Billing stays with the Owner (docs/hosted-spec.md "Permissions").
  [ROLE.admin]: { scope: "workspace", name: "Admin", permissions: WORKSPACE_PERMISSIONS.filter((p) => p !== "workspace.delete" && p !== "billing.manage") },
  [ROLE.editor]: {
    scope: "workspace",
    name: "Editor",
    permissions: ["accounts.read", "accounts.manage", "posts.read", "posts.write", "media.read", "media.write", "playbooks.manage", "apikeys.manage"],
  },
  [ROLE.viewer]: { scope: "workspace", name: "Viewer", permissions: ["accounts.read", "posts.read", "media.read"] },
};

/** Parse a role's stored permission JSON, dropping unknown keys (e.g. removed permissions). */
export function parsePermissions(json: string | null | undefined, scope: "instance" | "workspace"): PermissionKey[] {
  let list: unknown;
  try {
    list = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  return Array.isArray(list) ? [...new Set(list.filter((k): k is PermissionKey => typeof k === "string" && isPermission(k, scope)))] : [];
}

/** True when every permission of `subset` is in `of`. */
export function isSubset(subset: readonly string[], of: readonly string[]): boolean {
  const set = new Set(of);
  return subset.every((p) => set.has(p));
}

/**
 * Public live demo (worker/lib/demo.ts). These roles are not seeded by a migration: they are created only when
 * DEMO_MODE is on, are hidden from the role pickers and cannot be granted (`getRole` refuses them).
 */
export const DEMO_ROLE = { instance: "role_instance_demo", workspace: "role_ws_demo" } as const;

/** Everything a demo visitor may do, whatever role an admin hands the demo user. */
export const DEMO_WORKSPACE_PERMISSIONS: WorkspacePermission[] = ["accounts.read", "posts.read", "posts.write", "media.read"];

export const isDemoRole = (id: string | null | undefined) => id === DEMO_ROLE.instance || id === DEMO_ROLE.workspace;
