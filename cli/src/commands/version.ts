import { MAX_API_VERSION, MIN_API_VERSION, compatWarning, serverVersion } from "../compat.js";
import type { Command } from "../context.js";
import { c, println, printJson } from "../format.js";
import { VERSION } from "../version.js";

export const version: Command = {
  name: "version",
  summary: "Show the CLI version and the version of the Postflare server it talks to.",
  description:
    "`postflare --version` prints only the CLI version (no network). This command also asks the server (GET /api/version)\n" +
    "and warns when the server's API is older or newer than this CLI supports.",
  max: 0,
  examples: ["postflare version", "postflare version --json"],
  async run(ctx) {
    let url: string | null = null;
    let server = null;
    try {
      url = ctx.auth.url;
    } catch {
      /* not logged in: CLI version only */
    }
    if (url) server = await serverVersion(ctx.api);
    const warning = compatWarning(server, VERSION);
    if (ctx.json) {
      return printJson({
        cli: { version: VERSION, apiVersions: { min: MIN_API_VERSION, max: MAX_API_VERSION } },
        server: url ? { url, ...(server ?? { version: null, commit: null, apiVersion: null }) } : null,
        compatible: !warning,
        warning,
      });
    }
    println(`postflare CLI  ${c.bold(VERSION)} ${c.gray(`(server API ${MIN_API_VERSION === MAX_API_VERSION ? MIN_API_VERSION : `${MIN_API_VERSION}-${MAX_API_VERSION}`})`)}`);
    if (!url) println(c.gray("Server         not logged in (postflare login)"));
    else if (!server) println(`Server         ${url} ${c.gray("(version unknown: older server or unreachable)")}`);
    else println(`Server         ${url}  ${c.bold(`v${server.version}`)} ${c.gray(`(commit ${server.commit}, API ${server.apiVersion})`)}`);
    if (warning) println(`${c.yellow("warning:")} ${warning}`);
  },
};
