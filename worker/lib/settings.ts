export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** Public base URL used for OAuth redirects and media links outside of a request (workflows, cron). */
export async function baseUrl(env: Env, requestUrl?: string): Promise<string> {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, "");
  const stored = await getSetting(env.DB, "public_url");
  if (stored) return stored;
  if (requestUrl) {
    const origin = new URL(requestUrl).origin;
    await setSetting(env.DB, "public_url", origin);
    return origin;
  }
  throw new Error("Public URL unknown: open the app once in the browser or set PUBLIC_URL");
}

/** Instance setting "Enable experimental integrations" (providers with status "experimental", e.g. unofficial APIs). */
export const EXPERIMENTAL_SETTING = "experimental_integrations";

export async function experimentalEnabled(db: D1Database): Promise<boolean> {
  return (await getSetting(db, EXPERIMENTAL_SETTING)) === "true";
}

/**
 * Error message when a provider cannot be connected because it is experimental and experimental integrations are
 * off; null when it can be connected. Already connected accounts keep publishing either way.
 */
export async function connectBlocked(
  db: D1Database,
  provider: { id: string; name: string; status?: string },
  allowedProviders: readonly string[] | null = null,
): Promise<string | null> {
  if (!providerAllowed(allowedProviders, provider.id)) return notAllowedMessage(provider.name);
  if (provider.status !== "experimental" || (await experimentalEnabled(db))) return null;
  return `${provider.name} is an experimental integration (unofficial API) and is disabled on this instance. An instance admin can turn on "Enable experimental integrations" in Instance settings.`;
}

/**
 * Instance setting "Platforms for new workspaces": a JSON array of provider ids copied into `workspaces.allowed_providers`
 * when a workspace is created (absent = every platform). Changing it never touches existing workspaces.
 */
export const WORKSPACE_PROVIDERS_SETTING = "workspace_default_providers";

/** A stored allowed-providers list (JSON array) → ids, or null (every platform) when empty or invalid. */
export function parseAllowedProviders(v: string | null | undefined): string[] | null {
  if (!v) return null;
  try {
    const list = JSON.parse(v);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** A request's allowed-providers value: null (every platform), known ids (deduped, sorted), or undefined when invalid. */
export function allowedProvidersInput(v: unknown, known: readonly string[]): string[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !known.includes(x))) return undefined;
  return [...new Set(v as string[])].sort();
}

export const providerAllowed = (allowed: readonly string[] | null | undefined, providerId: string) => !allowed || allowed.includes(providerId);

export const notAllowedMessage = (name: string) =>
  `${name} is not available in this workspace. Ask the instance admin to enable it (Admin → Billing → Workspaces).`;

/** Statement giving a just-created workspace the instance's platforms for new workspaces. */
export function defaultProvidersStatement(db: D1Database, workspaceId: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE workspaces SET allowed_providers = (SELECT value FROM settings WHERE key = '${WORKSPACE_PROVIDERS_SETTING}') WHERE id = ?`)
    .bind(workspaceId);
}

/** Instance setting "Media retention (days)": see lib/media-lifecycle.ts. 0 keeps media forever. */
export const MEDIA_RETENTION_SETTING = "media_retention_days";
export const DEFAULT_MEDIA_RETENTION_DAYS = 30;

export async function mediaRetentionDays(db: D1Database): Promise<number> {
  return parseMediaRetention(await getSetting(db, MEDIA_RETENTION_SETTING));
}

/** The stored "Media retention (days)" value → days (default when unset or invalid). */
export function parseMediaRetention(v: string | null | undefined): number {
  const n = v === null || v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MEDIA_RETENTION_DAYS;
}
