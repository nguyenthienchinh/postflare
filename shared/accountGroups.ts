// Account groups ("brand / project" folders for accounts), shared by the Worker, the web app and tests.

/** Palette keys a group color can take (the web app maps them to Tailwind colors). */
export const ACCOUNT_GROUP_COLORS = ["zinc", "red", "orange", "amber", "green", "teal", "sky", "indigo", "violet", "pink"] as const;
export type AccountGroupColor = (typeof ACCOUNT_GROUP_COLORS)[number];

export const isAccountGroupColor = (v: unknown): v is AccountGroupColor => typeof v === "string" && (ACCOUNT_GROUP_COLORS as readonly string[]).includes(v);

/** Color for a new group without one: cycles through the palette (skipping zinc) by position. */
export const defaultGroupColor = (position: number): AccountGroupColor => ACCOUNT_GROUP_COLORS[1 + (Math.max(0, position) % (ACCOUNT_GROUP_COLORS.length - 1))];

export const ACCOUNT_GROUP_NAME_MAX = 50;
/** Accounts per bulk assignment request. */
export const ACCOUNT_GROUP_BULK_MAX = 500;
