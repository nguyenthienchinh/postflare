import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../worker/lib/migrate";
import { BUILTIN_ROLES } from "../worker/lib/permissions";

describe("splitStatements", () => {
  it("splits the init migration into statements without comments", () => {
    const stmts = splitStatements(readFileSync("migrations/0001_init.sql", "utf8"));
    expect(stmts.filter((s) => s.startsWith("CREATE TABLE")).length).toBe(9);
    expect(stmts.some((s) => s.includes("--"))).toBe(false);
  });
});

describe("0003_users_workspaces", () => {
  const sql = readFileSync("migrations/0003_users_workspaces.sql", "utf8");
  const stmts = splitStatements(sql);

  it("splits into single statements without comments", () => {
    expect(stmts.some((s) => s.includes("--"))).toBe(false);
    expect(stmts.filter((s) => s.startsWith("CREATE TABLE")).length).toBe(5);
    expect(stmts.filter((s) => s.startsWith("ALTER TABLE")).length).toBe(14);
    // Each piece is exactly one statement.
    for (const s of stmts) expect(s.includes(";\n"), s.slice(0, 60)).toBe(false);
  });

  it("seeds the built-in roles exactly as worker/lib/permissions.ts defines them (with 0007's, 0008's and 0013's additions)", () => {
    // 0007 grants instance.overview.view to the built-in instance Admin, 0008 playbooks.manage to Owner, Admin and Editor,
    // 0013 billing.manage to the Owner.
    const later: Record<string, string[]> = {
      role_instance_admin: ["instance.overview.view", "instance.support.manage"],
      role_ws_owner: ["playbooks.manage", "billing.manage"],
      role_ws_admin: ["playbooks.manage"],
      role_ws_editor: ["playbooks.manage"],
    };
    expect(readFileSync("migrations/0007_usage_events.sql", "utf8")).toMatch(/json_insert\(permissions, '\$\[#\]', 'instance\.overview\.view'\)\s+WHERE id = 'role_instance_admin'/);
    expect(readFileSync("migrations/0008_playbooks.sql", "utf8")).toMatch(
      /json_insert\(permissions, '\$\[#\]', 'playbooks\.manage'\)\s+WHERE id IN \('role_ws_owner', 'role_ws_admin', 'role_ws_editor'\)/,
    );
    expect(readFileSync("migrations/0013_billing.sql", "utf8")).toMatch(/json_insert\(permissions, '\$\[#\]', 'billing\.manage'\)\s+WHERE id = 'role_ws_owner'/);
    expect(readFileSync("migrations/0021_support.sql", "utf8")).toMatch(/json_insert\(permissions, '\$\[#\]', 'instance\.support\.manage'\)\s+WHERE id = 'role_instance_admin'/);
    const insert = stmts.find((s) => s.startsWith("INSERT OR IGNORE INTO roles"))!;
    const rows = [...insert.matchAll(/\('(role_[a-z_]+)', '(instance|workspace)', '([^']+)', '[^']*', '(\[[^\]]*\])', 1, 0\)/g)];
    expect(rows.length).toBe(Object.keys(BUILTIN_ROLES).length);
    for (const [, id, scope, name, perms] of rows) {
      const role = BUILTIN_ROLES[id];
      expect(role, id).toBeDefined();
      expect({ scope, name, permissions: [...JSON.parse(perms), ...(later[id] ?? [])].sort() }).toEqual({ scope: role.scope, name: role.name, permissions: [...role.permissions].sort() });
    }
  });
});
