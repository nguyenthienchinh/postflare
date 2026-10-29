import { commandHelp, parseCommand, splitCommand } from "./args.js";
import { accountOptions, accounts, accountsGroup, platforms } from "./commands/accounts.js";
import { groups, groupsCreate, groupsRename, groupsRm } from "./commands/groups.js";
import { apps, appsAdd, appsBioLink, appsImport, appsRm, links } from "./commands/apps.js";
import { analytics, analyticsRefresh, analyticsTop } from "./commands/analytics.js";
import { login, logout, whoami, workspaces } from "./commands/auth.js";
import { mediaAlias, mediaImport, mediaList, mediaRm, mediaUpload } from "./commands/media.js";
import { playbooks, playbooksSearch, playbooksShow, playbooksStats } from "./commands/playbooks.js";
import { post, posts, postsCancel, postsComment, postsEdit, postsResolve, postsRetry, postsRm, postsShow } from "./commands/posts.js";
import { skillInstall } from "./commands/skill.js";
import { uploadLink } from "./commands/uploadlink.js";
import { version } from "./commands/version.js";
import { pendingWarning } from "./compat.js";
import { Ctx, type Command, type Deps } from "./context.js";
import { ApiError, CliError, UsageError } from "./errors.js";
import { c, eprintln, println, setColor, truncate } from "./format.js";
import { VERSION } from "./version.js";

export const COMMANDS: Command[] = [
  login,
  logout,
  whoami,
  workspaces,
  accounts,
  accountOptions,
  accountsGroup,
  groups,
  groupsCreate,
  groupsRename,
  groupsRm,
  platforms,
  mediaUpload,
  mediaList,
  mediaImport,
  mediaRm,
  mediaAlias,
  post,
  posts,
  postsShow,
  postsEdit,
  postsCancel,
  postsRetry,
  postsResolve,
  postsComment,
  postsRm,
  analytics,
  analyticsTop,
  analyticsRefresh,
  playbooks,
  playbooksSearch,
  playbooksShow,
  playbooksStats,
  apps,
  appsAdd,
  appsImport,
  appsRm,
  appsBioLink,
  links,
  uploadLink,
  skillInstall,
  version,
];

const GROUPS: Array<[string, string[]]> = [
  ["Setup", ["login", "logout", "whoami", "workspaces", "version", "skill install"]],
  ["Accounts & platforms", ["accounts", "accounts options", "accounts group", "groups", "groups create", "groups rename", "groups rm", "platforms"]],
  ["Media", ["media upload", "media list", "media import", "media rm", "upload-link"]],
  ["Posts", ["post", "posts", "posts show", "posts edit", "posts cancel", "posts retry", "posts resolve", "posts comment", "posts rm"]],
  ["Playbooks", ["playbooks", "playbooks search", "playbooks show", "playbooks stats"]],
  ["Analytics", ["analytics", "analytics top", "analytics refresh"]],
  ["Apps & links", ["apps", "apps add", "apps import", "apps rm", "apps bio-link", "links"]],
];

export function mainHelp(): string {
  const byName = new Map(COMMANDS.map((c) => [c.name, c]));
  const w = Math.max(...COMMANDS.map((c) => (c.name + (c.args ? ` ${c.args}` : "")).length));
  const room = process.stdout.isTTY && process.stdout.columns ? Math.max(process.stdout.columns - w - 4, 30) : Infinity;
  const lines = [
    `postflare ${VERSION}: schedule social posts, upload media and read analytics on your Postflare instance.`,
    "",
    "Usage: postflare <command> [options]",
  ];
  for (const [title, names] of GROUPS) {
    lines.push("", `${title}:`);
    for (const n of names) {
      const cmd = byName.get(n)!;
      lines.push(`  ${(cmd.name + (cmd.args ? ` ${cmd.args}` : "")).padEnd(w)}  ${room === Infinity ? cmd.summary : truncate(cmd.summary, room)}`);
    }
  }
  lines.push(
    "",
    "Global options: --json (machine-readable output on every command), --profile <name>, --no-color, -h/--help, --version",
    "Environment: POSTFLARE_URL, POSTFLARE_API_KEY, POSTFLARE_PROFILE, POSTFLARE_CONFIG (config path), NO_COLOR",
    "Exit codes: 0 ok, 1 error (API errors print the server's message), 2 usage error",
    "",
    "Examples:",
    "  postflare login --url https://postflare.example.com",
    "  postflare accounts",
    "  postflare post -a bluesky -a x --text \"Hello\" --at \"tomorrow 9:00\"",
    "  postflare post -a tiktok -m clip.mp4 --set privacy_level=SELF_ONLY --now",
    "  postflare playbooks search launch --platform x",
    "  postflare post -a x --text-file post.txt --playbook launch-announcement@1 --now",
    "  postflare post -a x -a threads --text \"Tempo 2.0 is out\" --app Tempo --at \"fri 9:00\"",
    "  postflare post -a \"group:Party Games\" -m clip.mp4 --text \"New level\" --at \"fri 18:00\"",
    "  postflare analytics --range 7d",
    "",
    "Help for a command: postflare <command> --help",
  );
  return lines.join("\n");
}

/** Run the CLI; returns the exit code. */
export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  if (argv.includes("--no-color")) setColor(false);
  if (argv[0] === "--version" || argv[0] === "-v") {
    println(VERSION);
    return 0;
  }
  const names = COMMANDS.map((c) => c.name);
  let { name, rest, words } = splitCommand(argv, names);
  // `postflare help <command>`
  if (words[0] === "help") {
    const sub = splitCommand(argv.slice(argv.indexOf("help") + 1), names);
    const cmd = COMMANDS.find((c) => c.name === sub.name);
    println(cmd ? commandHelp(cmd) : mainHelp());
    return 0;
  }
  if (!name) {
    if (!words.length) {
      println(mainHelp());
      return argv.some((a) => a === "-h" || a === "--help") || !argv.length ? 0 : 2;
    }
    eprintln(`${c.red("error:")} unknown command "${words[0]}"`);
    eprintln(`Run postflare --help for the list of commands.`);
    return 2;
  }
  const cmd = COMMANDS.find((c) => c.name === name)!;
  const state: { ctx?: Ctx } = {};
  const code = await execute(cmd, rest, deps, state);
  // Warn once (stderr) when the server's API is outside what this CLI supports; most useful when a command failed.
  const api = state.ctx?.usedApi;
  if (api && !state.ctx!.env.POSTFLARE_NO_VERSION_CHECK && cmd.name !== "version") {
    const warning = await pendingWarning(api, VERSION);
    if (warning) eprintln(`${c.yellow("warning:")} ${warning}`);
  }
  return code;
}

async function execute(cmd: Command, rest: string[], deps: Deps, state: { ctx?: Ctx }): Promise<number> {
  try {
    const parsed = parseCommand(cmd, rest);
    if (parsed.values["no-color"]) setColor(false);
    if (parsed.values.help) {
      println(commandHelp(cmd));
      return 0;
    }
    process.exitCode = undefined;
    state.ctx = new Ctx(parsed, deps);
    await cmd.run(state.ctx, parsed);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      eprintln(`${c.red("error:")} ${err.message}`);
      eprintln(c.gray(`See: postflare ${cmd.name} --help`));
      return 2;
    }
    if (err instanceof ApiError || err instanceof CliError) {
      eprintln(`${c.red("error:")} ${err.message}`);
      return 1;
    }
    eprintln(`${c.red("error:")} ${(err as Error)?.stack ?? String(err)}`);
    return 1;
  }
}
