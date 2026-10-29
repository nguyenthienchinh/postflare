// App Store apps of the workspace and their tracked campaign links (postflare apps, apps bio-link, links), plus the
// helpers other commands use for --app and campaign results.

import { list, str } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { UsageError } from "../errors.js";
import { c, fmtNum, println, printJson, table } from "../format.js";
import { accountLabel, resolveAccounts } from "../resolve.js";
import { CAMPAIGN_DATA_NOTE, type AccountDTO, type AppDTO, type CampaignLinkDTO, type CampaignResultsDTO } from "../types.js";

// ---------------------------------------------------------------------------------------------------------------
// Helpers

export const APP_OPTION = {
  app: { type: "string", arg: "<ref>", description: "App Store app the post is about: app id, App Store id or name (postflare apps)" },
} as const;

export const AUTOLINK_OPTIONS = {
  autolink: { type: "boolean", description: "Insert the tracked link (replace the app's App Store URLs / append it) even if the workspace default is off" },
  "no-autolink": { type: "boolean", description: "Create the tracked link but leave the text alone" },
} as const;

/** --autolink / --no-autolink → autoLink (undefined when neither is given). */
export function readAutoLink(values: Record<string, unknown>, command: string): boolean | undefined {
  if (values.autolink && values["no-autolink"]) throw new UsageError("Use either --autolink or --no-autolink", command);
  if (values.autolink) return true;
  if (values["no-autolink"]) return false;
  return undefined;
}

export const appsOf = (ctx: Ctx) => ctx.api.get<AppDTO[]>("/apps");

/** An app by id (app_...), App Store id (with or without "id") or name (case-insensitive). Errors list the apps. */
export function matchApp(ref: string, apps: AppDTO[]): AppDTO {
  const r = ref.trim();
  const store = r.replace(/^id(?=\d+$)/i, "");
  const found = apps.find((a) => a.id === r) ?? apps.find((a) => a.appStoreId === store) ?? apps.find((a) => a.name.toLowerCase() === r.toLowerCase());
  if (found) return found;
  if (!apps.length) throw new UsageError(`No app matches "${r}": this workspace has no apps yet (postflare apps add <appStoreId> or postflare apps import)`);
  throw new UsageError(`No app matches "${r}". Apps:\n${apps.map((a) => `  ${a.id}  ${a.appStoreId.padEnd(12)} ${a.name}`).join("\n")}`);
}

export async function resolveApp(ctx: Ctx, ref: string): Promise<AppDTO> {
  return matchApp(ref, await appsOf(ctx));
}

/** 4.5, "USD" → "$4.50"; without a currency "4.50". */
export function fmtMoney(n: number | null | undefined, currency?: string | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
    } catch {
      /* unknown currency code */
    }
  }
  return n.toFixed(2) + (currency ? ` ${currency}` : "");
}

export const campaignNote = () => c.gray(CAMPAIGN_DATA_NOTE);

/** "clicks 12  App Store downloads 3  redownloads 1  proceeds $4.99  (as of 2026-10-14)" */
export function campaignResultsLine(r: CampaignResultsDTO): string {
  const parts = [`clicks ${c.bold(fmtNum(r.clicks))}`];
  if (r.downloads === null && r.proceeds === null) parts.push(c.gray("App Store numbers not reported yet"));
  else {
    parts.push(`App Store downloads ${c.bold(fmtNum(r.downloads))}`);
    if (r.redownloads) parts.push(`redownloads ${c.bold(fmtNum(r.redownloads))}`);
    parts.push(`proceeds ${c.bold(fmtMoney(r.proceeds, r.currency))}`);
  }
  if (r.asOf) parts.push(c.gray(`(as of ${r.asOf})`));
  return parts.join("  ");
}

const accountName = (accounts: AccountDTO[], id: string | null) => {
  const a = id ? accounts.find((x) => x.id === id) : undefined;
  return a ? `${a.provider} ${a.username ? `@${a.username.replace(/^@/, "")}` : a.name}` : (id ?? "");
};

// ---------------------------------------------------------------------------------------------------------------
// apps

export const apps: Command = {
  name: "apps",
  summary: "App Store apps of the workspace (for tracked links). Subcommands: add, import, rm, bio-link.",
  description:
    "Posts tagged with an app (postflare post --app <ref>) get a tracked link with an App Store campaign token per post and\n" +
    "platform: clicks are counted by Postflare, installs and proceeds come from Apple App Analytics via Revflare.",
  max: 0,
  examples: ["postflare apps", "postflare apps --json"],
  async run(ctx) {
    const rows = await appsOf(ctx);
    if (ctx.json) return printJson(rows);
    if (!rows.length) return println("No apps. Add one: postflare apps add <appStoreId>, or postflare apps import (from Revflare).");
    println(
      table(
        [{ header: "ID" }, { header: "APP STORE ID" }, { header: "NAME", flex: true }, { header: "SOURCE" }],
        rows.map((a) => [a.id, a.appStoreId, a.name, a.revflareAppId ? "revflare" : "manual"]),
      ),
    );
  },
};

export const appsAdd: Command = {
  name: "apps add",
  args: "<appStoreId>",
  summary: "Add an App Store app by its numeric id (name and icon are looked up on the App Store).",
  options: { name: { type: "string", arg: "<name>", description: "App name (required when the App Store lookup finds nothing)" } },
  min: 1,
  max: 1,
  examples: ["postflare apps add 1234567890", "postflare apps add id1234567890 --name \"Tempo\""],
  async run(ctx, { values, positionals }) {
    const name = str(values.name);
    const app = await ctx.api.post<AppDTO>("/apps", { appStoreId: positionals[0], ...(name ? { name } : {}) });
    if (ctx.json) return printJson(app);
    println(`${c.green("✓")} ${app.name} (${app.appStoreId}): ${app.id}`);
  },
};

export const appsImport: Command = {
  name: "apps import",
  summary: "Import the apps of the connected Revflare workspace.",
  max: 0,
  examples: ["postflare apps import"],
  async run(ctx) {
    const res = await ctx.api.post<{ imported: number; apps: AppDTO[] }>("/apps/import", {});
    if (ctx.json) return printJson(res);
    println(`${c.green("✓")} Imported ${res.imported} app${res.imported === 1 ? "" : "s"} from Revflare (${res.apps.length} in the workspace)`);
  },
};

export const appsRm: Command = {
  name: "apps rm",
  args: "<app>",
  summary: "Remove an app (posts lose the tag; existing tracked links keep redirecting).",
  min: 1,
  max: 1,
  examples: ["postflare apps rm app_abc"],
  async run(ctx, { positionals }) {
    const app = await resolveApp(ctx, positionals[0]);
    const res = await ctx.api.delete(`/apps/${encodeURIComponent(app.id)}`);
    if (ctx.json) return printJson(res);
    println(`${c.green("✓")} Removed ${app.name} (${app.id})`);
  },
};

export const appsBioLink: Command = {
  name: "apps bio-link",
  summary: "Tracked bio link of an account for an app (Instagram/TikTok captions aren't clickable).",
  description: "Put the URL in the account's bio / link-in-bio page. Its campaign token is pf-<platform>-bio.",
  options: {
    account: { type: "string", short: "a", arg: "<selector>", description: "The account (id, @username, platform...)" },
    ...APP_OPTION,
  },
  max: 0,
  examples: ["postflare apps bio-link -a instagram_standalone --app Tempo", "postflare apps bio-link -a @myapp_tt --app 1234567890 --json"],
  async run(ctx, { values }) {
    const sel = str(values.account);
    const ref = str(values.app);
    if (!sel || !ref) throw new UsageError("Give --account <selector> and --app <ref>", "apps bio-link");
    const [account] = resolveAccounts([sel], await ctx.accounts());
    const app = await resolveApp(ctx, ref);
    const link = await ctx.api.post<CampaignLinkDTO>("/campaigns/bio-links", { accountId: account.id, appId: app.id });
    if (ctx.json) return printJson(link);
    println(`${c.bold(app.name)} · ${account.provider} ${accountLabel(account)}`);
    println(`  Bio link:  ${c.cyan(link.trackedUrl)}`);
    println(`  Campaign:  ${link.ct}`);
    if (typeof link.clicks === "number") println(`  ${campaignResultsLine(link)}`);
    println(c.gray("Put it in the profile's bio / link-in-bio page."));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// links

export const links: Command = {
  name: "links",
  summary: "Tracked App Store links with their clicks, installs and proceeds (newest first).",
  options: {
    account: { type: "string", short: "a", arg: "<selector>", description: "Only this account's links" },
    ...APP_OPTION,
    kind: { type: "string", arg: "<post|bio>", description: "Post links or bio links" },
    post: { type: "string", arg: "<id>", description: "The link of one post" },
    limit: { type: "string", arg: "<n>", description: "Max links (default 200, max 500)" },
  },
  max: 0,
  examples: ["postflare links", "postflare links --app Tempo --kind bio", "postflare links -a x --json"],
  async run(ctx, { values }) {
    const kind = str(values.kind);
    if (kind && kind !== "post" && kind !== "bio") throw new UsageError("--kind must be post or bio", "links");
    const accounts = str(values.account) || !ctx.json ? await ctx.accounts().catch(() => [] as AccountDTO[]) : [];
    const accountId = str(values.account) ? resolveAccounts(list(values.account), accounts)[0].id : undefined;
    const appId = str(values.app) ? (await resolveApp(ctx, str(values.app)!)).id : undefined;
    const rows = await ctx.api.get<CampaignLinkDTO[]>("/campaigns/links", { accountId, appId, kind, postId: str(values.post), limit: str(values.limit) });
    if (ctx.json) return printJson(rows);
    if (!rows.length) return println("No tracked links.");
    const reported = rows.some((r) => r.downloads !== null || r.proceeds !== null);
    println(
      table(
        [
          { header: "KIND" },
          { header: "ACCOUNT" },
          { header: "POST" },
          { header: "CAMPAIGN" },
          { header: "CLICKS", align: "right" },
          { header: "INSTALLS", align: "right" },
          { header: "PROCEEDS", align: "right" },
          { header: "AS OF" },
          { header: "URL" },
        ],
        rows.map((l) => [
          l.kind,
          accountName(accounts, l.accountId) || l.provider,
          l.postId ?? "",
          l.ct,
          fmtNum(l.clicks),
          fmtNum(l.downloads),
          fmtMoney(l.proceeds, l.currency),
          l.asOf ?? "",
          l.trackedUrl,
        ]),
      ),
    );
    if (reported) println(campaignNote());
    else println(c.gray("Installs and proceeds appear once Revflare reports the campaign tokens (Apple App Analytics lags 2-3 days)."));
  },
};
