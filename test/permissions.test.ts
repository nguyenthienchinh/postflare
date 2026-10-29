import { describe, expect, it } from "vitest";
import type { PermissionKey } from "../shared/types";
import { BUILTIN_ROLES, INSTANCE_PERMISSIONS, PERMISSIONS, WORKSPACE_PERMISSIONS, isSubset, parsePermissions, permissionError } from "../worker/lib/permissions";

describe("permission catalog", () => {
  it("has the keys of the spec, each with a description", () => {
    expect(INSTANCE_PERMISSIONS).toEqual(["instance.platforms.manage", "instance.users.manage", "instance.settings.manage", "instance.workspaces.create", "instance.overview.view", "instance.support.manage"]);
    expect(WORKSPACE_PERMISSIONS).toEqual([
      "workspace.manage",
      "workspace.delete",
      "members.manage",
      "accounts.read",
      "accounts.manage",
      "posts.read",
      "posts.write",
      "media.read",
      "media.write",
      "playbooks.manage",
      "apikeys.manage",
      "billing.manage",
    ]);
    for (const p of PERMISSIONS) expect(p.description && p.label && p.action, p.key).toBeTruthy();
  });

  it("built-in roles follow the spec", () => {
    expect(BUILTIN_ROLES.role_instance_admin.permissions).toEqual(INSTANCE_PERMISSIONS);
    expect(BUILTIN_ROLES.role_instance_member.permissions).toEqual(["instance.workspaces.create"]);
    expect(BUILTIN_ROLES.role_ws_owner.permissions).toEqual(WORKSPACE_PERMISSIONS);
    expect(BUILTIN_ROLES.role_ws_admin.permissions).not.toContain("workspace.delete");
    // Admin: everything but deleting the workspace and billing (Owner only, docs/hosted-spec.md).
    expect(BUILTIN_ROLES.role_ws_admin.permissions).not.toContain("billing.manage");
    expect(BUILTIN_ROLES.role_ws_admin.permissions.length).toBe(WORKSPACE_PERMISSIONS.length - 2);
    expect(BUILTIN_ROLES.role_ws_viewer.permissions).toEqual(["accounts.read", "posts.read", "media.read"]);
    // Admins cannot grant Owner; Editors cannot grant Admin.
    expect(isSubset(BUILTIN_ROLES.role_ws_owner.permissions, BUILTIN_ROLES.role_ws_admin.permissions)).toBe(false);
    expect(isSubset(BUILTIN_ROLES.role_ws_editor.permissions, BUILTIN_ROLES.role_ws_admin.permissions)).toBe(true);
    expect(isSubset(BUILTIN_ROLES.role_ws_admin.permissions, BUILTIN_ROLES.role_ws_editor.permissions)).toBe(false);
  });

  it("parses stored permissions per scope, dropping unknown keys", () => {
    expect(parsePermissions('["posts.read","bogus","instance.users.manage","posts.read"]', "workspace")).toEqual(["posts.read"]);
    expect(parsePermissions('["posts.read","instance.users.manage"]', "instance")).toEqual(["instance.users.manage"]);
    expect(parsePermissions("not json", "workspace")).toEqual([]);
    expect(parsePermissions(null, "workspace")).toEqual([]);
  });

  it("phrases 403 errors", () => {
    expect(permissionError("posts.write" as PermissionKey)).toBe("You don't have permission to create or change posts");
  });
});
