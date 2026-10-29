// CLI ↔ server compatibility. The server reports its REST API contract version at GET /api/version (`apiVersion`,
// bumped on breaking API changes only). Servers older than the endpoint answer 404: they are treated as API 1.

import type { Api } from "./api.js";
import type { VersionDTO } from "./types.js";

/** Oldest server API version this CLI works with. */
export const MIN_API_VERSION = 1;
/** Newest server API version this CLI knows. */
export const MAX_API_VERSION = 1;

const cache = new Map<string, Promise<VersionDTO | null>>();
const warned = new Set<string>();

/** The server's version (once per process and server), or null when it is unknown (old server, network error...). */
export function serverVersion(api: Api): Promise<VersionDTO | null> {
  let p = cache.get(api.baseUrl);
  if (!p) {
    p = api.get<VersionDTO>("/version").then(
      (v) => (v && typeof v.apiVersion === "number" ? v : null),
      () => null,
    );
    cache.set(api.baseUrl, p);
  }
  return p;
}

/** The warning to print for this server, or null when the CLI and the server are compatible (or it is unknown). */
export function compatWarning(server: VersionDTO | null, cliVersion: string): string | null {
  if (!server) return null;
  if (server.apiVersion < MIN_API_VERSION) {
    return (
      `this Postflare server (v${server.version}, API ${server.apiVersion}) is older than postflare CLI ${cliVersion} supports ` +
      `(API ${MIN_API_VERSION}+). Update the server, or install an older CLI.`
    );
  }
  if (server.apiVersion > MAX_API_VERSION) {
    return (
      `this Postflare server (v${server.version}, API ${server.apiVersion}) is newer than postflare CLI ${cliVersion} knows ` +
      `(API ${MAX_API_VERSION}). Update the CLI: npm i -g postflare@latest`
    );
  }
  return null;
}

/** Waits (at most `timeoutMs`) for the version check and returns its warning, once per server and process. */
export async function pendingWarning(api: Api, cliVersion: string, timeoutMs = 2000): Promise<string | null> {
  if (warned.has(api.baseUrl)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  const server = await Promise.race([serverVersion(api), timeout]);
  clearTimeout(timer);
  const warning = compatWarning(server, cliVersion);
  if (warning) warned.add(api.baseUrl);
  return warning;
}

/** Tests: forget cached versions and warnings. */
export function resetCompatCache() {
  cache.clear();
  warned.clear();
}
