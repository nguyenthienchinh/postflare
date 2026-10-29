// Account groups (brand / project folders for accounts): postflare groups [create|rename|rm].
// Assign accounts with `postflare accounts group`, post to a whole group with `postflare post -a group:<name>`.

import { str } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { c, println, printJson, table } from "../format.js";
import { matchGroup } from "../resolve.js";
import type { AccountGroupDTO } from "../types.js";

/** Palette of group colors (shared/accountGroups.ts on the server). */
const COLORS = ["zinc", "red", "orange", "amber", "green", "teal", "sky", "indigo", "violet", "pink"];

const COLOR_OPTION = { color: { type: "string", arg: "<color>", description: `Color: ${COLORS.join(", ")}` } } as const;

function readColor(values: Record<string, unknown>, command: string): string | undefined {
  const color = str(values.color as string | undefined)?.toLowerCase();
  if (color !== undefined && !COLORS.includes(color)) throw new UsageError(`--color must be one of: ${COLORS.join(", ")}`, command);
  return color;
}

export const groups: Command = {
  name: "groups",
  summary: "Account groups (brands / projects) with their account counts. Subcommands: create, rename, rm.",
  description:
    "An account is in at most one group. Move accounts with: postflare accounts group <account...> --to <group>.\n" +
    "Post to every enabled account of a group with: postflare post -a group:<name> ...",
  max: 0,
  examples: ["postflare groups", "postflare groups --json"],
  async run(ctx) {
    const rows = await ctx.groups();
    if (ctx.json) return printJson(rows);
    if (!rows.length) return println('No account groups. Create one: postflare groups create "Party Games"');
    println(
      table(
        [{ header: "ID" }, { header: "NAME", flex: true }, { header: "COLOR" }, { header: "ACCOUNTS", align: "right" }],
        rows.map((g) => [g.id, g.name, g.color, g.accountCount]),
      ),
    );
  },
};

export const groupsCreate: Command = {
  name: "groups create",
  args: "<name>",
  summary: "Create an account group (added at the end; without --color one is picked).",
  options: COLOR_OPTION,
  min: 1,
  max: 1,
  examples: ['postflare groups create "Party Games"', "postflare groups create Postflare --color orange"],
  async run(ctx, { values, positionals }) {
    const color = readColor(values, "groups create");
    const g = await ctx.api.post<AccountGroupDTO>("/account-groups", { name: positionals[0], ...(color ? { color } : {}) });
    if (ctx.json) return printJson(g);
    println(`${c.green("✓")} Created ${c.bold(g.name)} (${g.id})`);
    println(c.gray(`Add accounts: postflare accounts group <account...> --to "${g.name}"`));
  },
};

export const groupsRename: Command = {
  name: "groups rename",
  args: "<group> [new name]",
  summary: "Rename an account group and/or change its color.",
  options: COLOR_OPTION,
  min: 1,
  max: 2,
  examples: ['postflare groups rename "Party Games" "Party Games!"', "postflare groups rename agr_abc --color violet"],
  async run(ctx, { values, positionals }) {
    const color = readColor(values, "groups rename");
    const name = positionals[1];
    if (!name && !color) throw new UsageError("Give a new name and/or --color", "groups rename");
    const group = matchGroup(positionals[0], await ctx.groups());
    const g = await ctx.api.patch<AccountGroupDTO>(`/account-groups/${encodeURIComponent(group.id)}`, { ...(name ? { name } : {}), ...(color ? { color } : {}) });
    if (ctx.json) return printJson(g);
    println(`${c.green("✓")} ${group.name}${g.name !== group.name ? ` → ${c.bold(g.name)}` : ""}${color ? ` (${g.color})` : ""}`);
  },
};

export const groupsRm: Command = {
  name: "groups rm",
  args: "<group>",
  summary: "Delete an account group (its accounts become ungrouped; nothing else changes).",
  min: 1,
  max: 1,
  examples: ['postflare groups rm "Party Games"'],
  async run(ctx, { positionals }) {
    const group = matchGroup(positionals[0], await ctx.groups());
    const res = await ctx.api.delete<{ ok: true; ungrouped: number }>(`/account-groups/${encodeURIComponent(group.id)}`);
    if (ctx.json) return printJson(res);
    println(`${c.green("✓")} Deleted ${group.name}${res.ungrouped ? ` (${res.ungrouped} account${res.ungrouped === 1 ? "" : "s"} now ungrouped)` : ""}`);
  },
};
