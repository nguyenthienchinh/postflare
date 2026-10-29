import { Api } from "../api.js";
import { str } from "../args.js";
import { DEFAULT_PROFILE, configPath, normalizeUrl, profileName, readConfig, writeConfig } from "../config.js";
import type { Command } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { c, println, printJson, table } from "../format.js";
import { prompt as ttyPrompt, readStdin } from "../io.js";
import type { MeDTO } from "../types.js";

function workspaceOf(me: MeDTO) {
  return me.workspaces.find((w) => w.id === me.currentWorkspaceId) ?? null;
}

export const login: Command = {
  name: "login",
  summary: "Save the URL and API key of a Postflare instance (create the key in Postflare → Profile → API keys).",
  description:
    "The key is checked against the server, then saved to ~/.config/postflare/config.json (mode 0600) under a profile\n" +
    "(default: \"default\"), which becomes the current one. Without --key the key is asked for without echo (TTY), or read\n" +
    "from stdin when piped. Env vars POSTFLARE_URL / POSTFLARE_API_KEY override the saved values.",
  options: {
    url: { type: "string", arg: "<url>", description: "Your Postflare URL, e.g. https://postflare.example.com" },
    key: { type: "string", arg: "<pf_...>", description: "API key (prefer the prompt or stdin: flags end up in shell history)" },
  },
  max: 0,
  examples: [
    "postflare login --url https://postflare.example.com",
    "echo \"$POSTFLARE_KEY\" | postflare login --url https://postflare.example.com",
    "postflare login --profile work --url https://pf.work.example --key pf_...",
  ],
  async run(ctx, { values }) {
    const cfg = readConfig(configPath(ctx.env));
    const name = str(values.profile) || ctx.env.POSTFLARE_PROFILE || (Object.keys(cfg.profiles).length ? cfg.current : undefined) || DEFAULT_PROFILE;
    const existing = cfg.profiles[name];
    const ask = ctx.deps.prompt ?? ttyPrompt;
    const tty = !!process.stdin.isTTY && !ctx.deps.readStdin;
    let url = str(values.url) ?? existing?.url;
    if (!url) {
      if (!tty) throw new UsageError("Missing --url", "login");
      url = await ask("Postflare URL: ");
    }
    url = normalizeUrl(url);
    let key = str(values.key);
    if (!key) {
      if (tty) key = await ask("API key (pf_..., input hidden): ", { secret: true });
      else key = ((await (ctx.deps.readStdin ?? readStdin)(false)) ?? "").trim();
    }
    if (!key) throw new UsageError("Missing API key: pass --key, pipe it on stdin, or run in a terminal to be prompted", "login");
    const api = new Api(url, key, ctx.deps.fetch);
    let me: MeDTO;
    try {
      me = await api.get<MeDTO>("/me");
    } catch (err) {
      throw new CliError(`Login failed: ${(err as Error).message}`);
    }
    cfg.profiles[name] = { url, key };
    cfg.current = name;
    writeConfig(cfg, configPath(ctx.env));
    const ws = workspaceOf(me);
    if (ctx.json) return printJson({ profile: name, url, user: me.user, workspace: ws, config: configPath(ctx.env) });
    println(`${c.green("✓")} Logged in to ${c.bold(url)} as ${c.bold(me.user.name)} <${me.user.email}>`);
    if (ws) println(`  Workspace: ${c.bold(ws.name)} (${ws.role.name})`);
    println(c.gray(`  Profile "${name}" saved to ${configPath(ctx.env)}`));
    if (!key.startsWith("pf_")) println(c.yellow("  Note: Postflare API keys usually start with pf_"));
  },
};

export const logout: Command = {
  name: "logout",
  summary: "Remove the saved credentials of a profile (the current one by default).",
  options: { all: { type: "boolean", description: "Remove every profile" } },
  max: 0,
  examples: ["postflare logout", "postflare logout --profile work"],
  async run(ctx, { values }) {
    const path = configPath(ctx.env);
    const cfg = readConfig(path);
    const removed: string[] = [];
    if (values.all) {
      removed.push(...Object.keys(cfg.profiles));
      cfg.profiles = {};
      delete cfg.current;
    } else {
      const name = profileName(str(values.profile), cfg, ctx.env);
      if (cfg.profiles[name]) {
        delete cfg.profiles[name];
        removed.push(name);
      }
      if (cfg.current === name) {
        const next = Object.keys(cfg.profiles)[0];
        if (next) cfg.current = next;
        else delete cfg.current;
      }
    }
    writeConfig(cfg, path);
    if (ctx.json) return printJson({ removed, current: cfg.current ?? null });
    println(removed.length ? `Removed profile${removed.length > 1 ? "s" : ""} ${removed.join(", ")}.` : "Nothing to remove.");
    if (ctx.env.POSTFLARE_API_KEY) println(c.yellow("POSTFLARE_API_KEY is still set in your environment."));
  },
};

export const whoami: Command = {
  name: "whoami",
  summary: "Show the user and workspace of the API key, and where the credentials come from.",
  max: 0,
  examples: ["postflare whoami", "postflare whoami --json"],
  async run(ctx) {
    const me = await ctx.api.get<MeDTO>("/me");
    const ws = workspaceOf(me);
    const { url, profile, source, key } = ctx.auth;
    const keyHint = `${key.slice(0, 8)}…`;
    if (ctx.json) {
      return printJson({ url, profile, source, key: keyHint, user: me.user, workspace: ws, instancePermissions: me.instancePermissions });
    }
    println(`${c.bold(me.user.name)} <${me.user.email}>${me.user.demo ? c.yellow("  (demo user)") : ""}`);
    if (ws) {
      println(`Workspace:   ${c.bold(ws.name)} ${c.gray(ws.id)}${ws.demo ? c.yellow("  (live demo: publishing is simulated)") : ""}`);
      println(`Role:        ${ws.role.name}`);
      println(`Permissions: ${ws.permissions.join(", ")}`);
    } else println(c.yellow("The key has no workspace."));
    println(`Server:      ${url}`);
    println(c.gray(`Profile:     ${source === "env" ? "(environment variables)" : profile}${source === "mixed" ? " + environment" : ""}  key ${keyHint}`));
  },
};

export const workspaces: Command = {
  name: "workspaces",
  summary: "List workspaces. An API key is bound to one workspace, so this shows the key's workspace.",
  max: 0,
  async run(ctx) {
    const list = await ctx.api.get<Array<{ id: string; name: string; role: { name: string }; memberCount: number; permissions: string[]; demo?: true }>>("/workspaces");
    if (ctx.json) return printJson(list);
    println(table([{ header: "ID" }, { header: "NAME" }, { header: "ROLE" }, { header: "MEMBERS", align: "right" }], list.map((w) => [w.id, w.name + (w.demo ? " (demo)" : ""), w.role.name, w.memberCount])));
    println(c.gray("API keys act in their own workspace only; create a key in another workspace to use it."));
  },
};
