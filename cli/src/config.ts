// Profiles in ~/.config/postflare/config.json (mode 0600). Env overrides: POSTFLARE_URL, POSTFLARE_API_KEY, POSTFLARE_PROFILE.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.js";

export interface Profile {
  url: string;
  key: string;
}

export interface ConfigFile {
  /** Profile used when none is given. */
  current?: string;
  profiles: Record<string, Profile>;
}

export const DEFAULT_PROFILE = "default";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POSTFLARE_CONFIG) return env.POSTFLARE_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "postflare", "config.json");
}

export function readConfig(path = configPath()): ConfigFile {
  if (!existsSync(path)) return { profiles: {} };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { current: data.current, profiles: data.profiles && typeof data.profiles === "object" ? data.profiles : {} };
  } catch (err) {
    throw new CliError(`Cannot read ${path}: ${(err as Error).message}`);
  }
}

export function writeConfig(cfg: ConfigFile, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** "https://x.com/", "https://x.com/api", "x.com" → "https://x.com" */
export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new CliError(`Invalid URL: ${input}`);
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\/(api|mcp)$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export interface ResolvedAuth {
  url: string;
  key: string;
  profile: string;
  /** Where the values come from, for `whoami`. */
  source: "env" | "config" | "mixed";
}

/** Profile name in use: --profile, else POSTFLARE_PROFILE, else the config's current profile, else "default". */
export function profileName(flag: string | undefined, cfg: ConfigFile, env: NodeJS.ProcessEnv = process.env): string {
  return flag || env.POSTFLARE_PROFILE || cfg.current || DEFAULT_PROFILE;
}

export function resolveAuth(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, path = configPath(env)): ResolvedAuth {
  const cfg = readConfig(path);
  const name = profileName(flag, cfg, env);
  const p = cfg.profiles[name];
  if (flag && !p && !(env.POSTFLARE_URL && env.POSTFLARE_API_KEY)) {
    const known = Object.keys(cfg.profiles);
    throw new CliError(`Unknown profile "${name}".${known.length ? ` Profiles: ${known.join(", ")}.` : ""} Run: postflare login --profile ${name} --url <url>`);
  }
  const url = env.POSTFLARE_URL || p?.url;
  const key = env.POSTFLARE_API_KEY || p?.key;
  if (!url || !key) {
    throw new CliError(
      "Not logged in. Run: postflare login --url https://<your-postflare> (create an API key in Postflare → Profile),\n" +
        "or set POSTFLARE_URL and POSTFLARE_API_KEY.",
    );
  }
  const fromEnv = [!!env.POSTFLARE_URL, !!env.POSTFLARE_API_KEY];
  return {
    url: normalizeUrl(url),
    key,
    profile: name,
    source: fromEnv.every(Boolean) ? "env" : fromEnv.some(Boolean) ? "mixed" : "config",
  };
}
