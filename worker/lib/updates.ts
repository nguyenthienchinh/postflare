// Update check: once a day (cron) the instance asks GitHub for the newest server release (tags `v*`; the CLI's
// `cli-v*` releases are ignored) and stores it in settings. One outgoing request per day. Off with UPDATE_CHECK="false".

import type { UpdateStatusDTO } from "../../shared/types";
import { API_VERSION, COMMIT, UPSTREAM_REPO, VERSION, compareVersions, parseVersion, releaseUrl } from "../../shared/version";
import { getSetting, setSetting } from "./settings";
import { now } from "./util";

export const UPDATE_SETTING = "update_check";
const DAY = 24 * 60 * 60 * 1000;
/** After a failed check (rate limit, GitHub down...), try again sooner than a day. */
const RETRY_AFTER_ERROR = 6 * 60 * 60 * 1000;
/** Manual checks (POST /api/updates/check): at most one per minute per instance. */
export const MANUAL_CHECK_INTERVAL = 60 * 1000;

export interface StoredUpdate {
  latestVersion: string | null;
  url: string | null;
  publishedAt: number | null;
  checkedAt: number;
  error?: string | null;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

export const updateCheckEnabled = (env: Env) => env.UPDATE_CHECK?.toLowerCase() !== "false";
export const updateRepo = (env: Env) => (env.UPDATE_REPO?.trim() || UPSTREAM_REPO).replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");

export function versionInfo() {
  return { version: VERSION, commit: COMMIT, apiVersion: API_VERSION };
}

export async function readStoredUpdate(db: D1Database): Promise<StoredUpdate | null> {
  const raw = await getSetting(db, UPDATE_SETTING);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUpdate;
  } catch {
    return null;
  }
}

/**
 * The newest server release among GitHub releases: highest semver `v<x.y.z>` tag that is neither a draft nor a
 * prerelease. Listing (instead of /releases/latest) keeps working when a CLI release (`cli-v*`) is marked "latest".
 */
export function pickLatestServerRelease(releases: GitHubRelease[]): GitHubRelease | null {
  let best: GitHubRelease | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !/^v\d/.test(r.tag_name)) continue;
    const v = parseVersion(r.tag_name);
    if (!v || v[3]) continue;
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best;
}

/** Asks GitHub now and stores the result (one request). Never throws. */
export async function checkForUpdatesNow(env: Env, fetchImpl: typeof fetch = fetch): Promise<StoredUpdate> {
  const previous = await readStoredUpdate(env.DB);
  let result: StoredUpdate;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${updateRepo(env)}/releases?per_page=30`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": `postflare/${VERSION} (update check; +https://github.com/${UPSTREAM_REPO})`,
      },
    });
    if (res.status === 404) {
      // No such (public) repository yet, e.g. still private: nothing to report, no error.
      result = { latestVersion: null, url: null, publishedAt: null, checkedAt: now(), error: null };
    } else if (!res.ok) {
      result = { ...(previous ?? { latestVersion: null, url: null, publishedAt: null }), checkedAt: now(), error: `GitHub answered ${res.status}` };
    } else {
      const latest = pickLatestServerRelease((await res.json()) as GitHubRelease[]);
      result = latest
        ? {
            latestVersion: latest.tag_name.replace(/^v/, ""),
            url: latest.html_url,
            publishedAt: latest.published_at ? Date.parse(latest.published_at) : null,
            checkedAt: now(),
            error: null,
          }
        : { latestVersion: null, url: null, publishedAt: null, checkedAt: now(), error: null };
    }
  } catch (err) {
    result = { ...(previous ?? { latestVersion: null, url: null, publishedAt: null }), checkedAt: now(), error: `Update check failed: ${(err as Error).message}` };
  }
  await setSetting(env.DB, UPDATE_SETTING, JSON.stringify(result));
  return result;
}

/** Cron: checks at most once a day (sooner after an error). */
export async function updateCheckCron(env: Env, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!updateCheckEnabled(env)) return;
  const stored = await readStoredUpdate(env.DB);
  if (stored && now() - stored.checkedAt < (stored.error ? RETRY_AFTER_ERROR : DAY)) return;
  await checkForUpdatesNow(env, fetchImpl);
}

export function updateStatus(env: Env, stored: StoredUpdate | null): UpdateStatusDTO {
  const latest = stored?.latestVersion ?? null;
  const updateAvailable = !!latest && compareVersions(latest, VERSION) > 0;
  return {
    current: VERSION,
    commit: COMMIT,
    latest,
    updateAvailable,
    url: stored?.url ?? (latest ? releaseUrl(latest) : null),
    publishedAt: stored?.publishedAt ?? null,
    checkedAt: stored?.checkedAt ?? null,
    error: stored?.error ?? null,
    enabled: updateCheckEnabled(env),
    repo: updateRepo(env),
  };
}
