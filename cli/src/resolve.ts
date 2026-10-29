// Account selectors (--account) and provider settings (--set key=value).

import { parseTime } from "./dates.js";
import { UsageError } from "./errors.js";
import type { AccountDTO, AccountGroupDTO, FieldDef, ProviderInfo } from "./types.js";

const bare = (u: string | null | undefined) => (u ?? "").replace(/^@/, "").toLowerCase();

export const accountLabel = (a: AccountDTO) => `${a.name}${a.username ? ` (@${a.username.replace(/^@/, "")})` : ""}`;

function candidates(list: AccountDTO[]): string {
  return list.map((a) => `  ${a.id}  ${a.provider.padEnd(20)} ${accountLabel(a)}${a.status !== "active" ? `  [${a.status}]` : ""}`).join("\n");
}

/** Accounts matching one selector (no error handling). */
export function matchAccounts(selector: string, accounts: AccountDTO[]): AccountDTO[] {
  const s = selector.trim();
  const lower = s.toLowerCase();
  const byId = accounts.filter((a) => a.id === s);
  if (byId.length) return byId;
  // provider:@user / provider:name / provider:id
  const colon = s.indexOf(":");
  if (colon > 0) {
    const provider = lower.slice(0, colon);
    const rest = s.slice(colon + 1);
    const pool = accounts.filter((a) => a.provider === provider);
    if (pool.length) return rest ? matchAccounts(rest, pool) : pool;
  }
  if (s.startsWith("@")) return accounts.filter((a) => a.username && bare(a.username) === bare(s));
  const byProvider = accounts.filter((a) => a.provider === lower);
  if (byProvider.length) return byProvider;
  const byName = accounts.filter((a) => a.name.toLowerCase() === lower || (a.username && bare(a.username) === lower));
  if (byName.length) return byName;
  return [];
}

const GROUP_PREFIX = "group:";
const split = (selectors: string[]) => selectors.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
const isGroupSelector = (s: string) => s.toLowerCase().startsWith(GROUP_PREFIX);

/** True when a selector is `group:<name|id>` (the caller then loads the account groups). */
export const usesGroups = (selectors: string[]) => split(selectors).some(isGroupSelector);

/** A group by id or name (case-insensitive). Errors list the groups. */
export function matchGroup(ref: string, groups: AccountGroupDTO[]): AccountGroupDTO {
  const r = ref.trim();
  const found = groups.find((g) => g.id === r) ?? groups.find((g) => g.name.toLowerCase() === r.toLowerCase());
  if (found) return found;
  if (!groups.length) throw new UsageError(`No account group matches "${r}": this workspace has no groups yet (postflare groups create <name>)`);
  throw new UsageError(`No account group matches "${r}". Groups:\n${groups.map((g) => `  ${g.id}  ${g.name}`).join("\n")}`);
}

/**
 * Resolve --account values (repeatable, comma separated) to accounts. A selector is an account id, `@username`,
 * a platform id (e.g. `bluesky`, when you have one account there), an account name, `platform:@username`, or
 * `group:<name|id>` (every account of that group except disabled ones; needs `groups`). Errors list the candidates.
 */
export function resolveAccounts(selectors: string[], accounts: AccountDTO[], groups?: AccountGroupDTO[]): AccountDTO[] {
  const out: AccountDTO[] = [];
  const add = (a: AccountDTO) => !out.some((x) => x.id === a.id) && out.push(a);
  const list = split(selectors);
  if (!list.length) throw new UsageError("Choose at least one account with --account (id, @username or platform). See: postflare accounts");
  for (const sel of list) {
    if (isGroupSelector(sel)) {
      if (!groups) throw new Error("resolveAccounts: group selectors need the account groups");
      const g = matchGroup(sel.slice(GROUP_PREFIX.length), groups);
      const members = accounts.filter((a) => a.groupId === g.id && a.status !== "disabled");
      if (!members.length) throw new UsageError(`Group "${g.name}" has no ${accounts.some((a) => a.groupId === g.id) ? "enabled " : ""}accounts. See: postflare accounts --group "${g.name}"`);
      members.forEach(add);
      continue;
    }
    const found = matchAccounts(sel, accounts);
    if (!found.length) {
      throw new UsageError(
        accounts.length
          ? `No account matches "${sel}". Connected accounts:\n${candidates(accounts)}`
          : `No account matches "${sel}": this workspace has no connected accounts (connect them in the Postflare app).`,
      );
    }
    if (found.length > 1) {
      throw new UsageError(
        `"${sel}" matches ${found.length} accounts:\n${candidates(found)}\nUse an account id or platform:@username (repeat --account to post to several, or group:<name> for a whole group).`,
      );
    }
    add(found[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings

export interface Target {
  account: AccountDTO;
  provider: ProviderInfo;
}

/** Field defaults, like the web composer's initial values. */
export function defaultSettings(fields: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

export function isVisible(f: FieldDef, values: Record<string, unknown>): boolean {
  if (!f.showIf) return true;
  const v = values[f.showIf.key];
  return v === f.showIf.equals || String(v ?? "") === String(f.showIf.equals);
}

const TRUE = new Set(["true", "yes", "y", "1", "on"]);
const FALSE = new Set(["false", "no", "n", "0", "off"]);

/** Turn a --set string into the field's type. */
export function coerceSetting(field: FieldDef, raw: string, providerId: string): unknown {
  const v = raw.trim();
  const where = `${providerId}.${field.key}`;
  if ((v.startsWith("[") || v.startsWith("{")) && field.type !== "text" && field.type !== "textarea") {
    try {
      return JSON.parse(v);
    } catch {
      /* fall through */
    }
  }
  switch (field.type) {
    case "checkbox": {
      if (TRUE.has(v.toLowerCase())) return true;
      if (FALSE.has(v.toLowerCase())) return false;
      throw new UsageError(`${where} is a yes/no setting: use true or false (got "${raw}")`);
    }
    case "number": {
      const n = Number(v);
      if (v === "" || !Number.isFinite(n)) throw new UsageError(`${where} must be a number (got "${raw}")`);
      return n;
    }
    case "tags":
      return v.split(",").map((x) => x.trim()).filter(Boolean);
    case "datetime":
      return v ? new Date(parseTime(v)).toISOString() : "";
    case "select": {
      const opts = field.options ?? [];
      const hit = opts.find((o) => o.value === v) ?? opts.find((o) => o.value.toLowerCase() === v.toLowerCase() || o.label.toLowerCase() === v.toLowerCase());
      if (hit) return hit.value;
      if (opts.length && !field.dynamicOptions) {
        throw new UsageError(`Invalid value "${raw}" for ${where}. Choose one of: ${opts.map((o) => `${o.value} (${o.label})`).join(", ")}`);
      }
      return v;
    }
    default:
      return raw;
  }
}

function describeFields(p: ProviderInfo): string {
  return p.settingsFields.length ? p.settingsFields.map((f) => f.key).join(", ") : "(none)";
}

/**
 * Settings per account: field defaults, then each `key=value` (scoped with `platform.key` or `accountId.key`; unscoped
 * keys apply to every selected account whose platform has that setting). Starts from `base` (existing post settings)
 * instead of the defaults when given.
 */
export function buildSettings(targets: Target[], sets: string[], base?: Map<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const t of targets) out.set(t.account.id, { ...(base?.get(t.account.id) ?? defaultSettings(t.provider.settingsFields)) });
  for (const item of sets) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new UsageError(`--set expects key=value (got "${item}")`);
    let key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1);
    let scope = targets;
    const dot = key.indexOf(".");
    if (dot > 0) {
      const prefix = key.slice(0, dot);
      const scoped = targets.filter((t) => t.provider.id === prefix || t.account.id === prefix);
      if (!scoped.length) {
        const known = [...new Set(targets.flatMap((t) => [t.provider.id, t.account.id]))].join(", ");
        throw new UsageError(`--set ${key}: "${prefix}" is not one of the selected platforms/accounts (${known})`);
      }
      scope = scoped;
      key = key.slice(dot + 1);
    }
    const applicable = scope.filter((t) => t.provider.settingsFields.some((f) => f.key === key));
    if (!applicable.length) {
      const help = [...new Map(scope.map((t) => [t.provider.id, t.provider])).values()].map((p) => `${p.id}: ${describeFields(p)}`).join("\n  ");
      throw new UsageError(`Unknown setting "${key}". Settings of the selected platforms:\n  ${help}\nDetails: postflare platforms <id>`);
    }
    for (const t of applicable) {
      const field = t.provider.settingsFields.find((f) => f.key === key)!;
      out.get(t.account.id)![key] = coerceSetting(field, value, t.provider.id);
    }
  }
  return out;
}

/** Required visible settings left empty, as helpful messages (the server validates too; this names the --set to use). */
export function missingSettings(targets: Target[], settings: Map<string, Record<string, unknown>>): string[] {
  const errors: string[] = [];
  for (const t of targets) {
    const values = settings.get(t.account.id) ?? {};
    for (const f of t.provider.settingsFields) {
      if (!f.required || f.type === "checkbox" || !isVisible(f, values)) continue;
      const v = values[f.key];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) {
        const opts = f.options?.length ? `  (${f.options.map((o) => o.value).join(" | ")})` : f.dynamicOptions ? `  (see: postflare accounts options ${t.account.id} ${f.key})` : "";
        errors.push(`${accountLabel(t.account)} [${t.provider.name}]: "${f.label}" is required: --set ${t.provider.id}.${f.key}=…${opts}`);
      }
    }
  }
  return errors;
}
