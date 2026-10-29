// Version of this Postflare build, shared by the Worker and the web app.

/** Server/app version from the root package.json, injected at build time. */
export const VERSION: string = typeof __POSTFLARE_VERSION__ === "string" ? __POSTFLARE_VERSION__ : "0.0.0-dev";
/** Short git commit SHA of the build, or "dev". */
export const COMMIT: string = typeof __POSTFLARE_COMMIT__ === "string" ? __POSTFLARE_COMMIT__ : "dev";
/**
 * Version of the REST API contract. Bump it (and the CLI's known range in cli/src/compat.ts) on breaking API changes
 * only: removed/renamed routes or fields, changed semantics. Additive changes keep it.
 */
export const API_VERSION = 1;

export const UPSTREAM_REPO = "FerdiKT/postflare";
export const REPO_URL = `https://github.com/${UPSTREAM_REPO}`;
export const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;
export const UPDATING_URL = `${REPO_URL}#updating`;
export const releaseUrl = (version: string) => `${REPO_URL}/releases/tag/v${version.replace(/^v/, "")}`;

/** [major, minor, patch, prerelease] of "v1.2.3" / "1.2.3-beta.1", or null. */
export function parseVersion(v: string): [number, number, number, string] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** Semver order of two versions (<0, 0, >0); unparsable versions sort first. Prereleases sort before the release. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  if (pa[3] === pb[3]) return 0;
  if (!pa[3]) return 1;
  if (!pb[3]) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}
