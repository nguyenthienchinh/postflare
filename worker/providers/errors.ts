export type ProviderErrorKind =
  /** Token revoked/expired and cannot be refreshed: the account must be reconnected. Not retried. */
  | "auth"
  /** The post itself is invalid (too long, bad media, missing setting...). Not retried. */
  | "invalid"
  /** Rate limited. Retried with backoff. */
  | "rate_limit"
  /** Network/5xx before anything was created on the platform. Retried with backoff. */
  | "transient"
  /**
   * The commit request (the call that creates the post) failed after it may have reached the platform: network
   * error, timeout or 5xx on a `commit: true` request (http.ts). Never retried automatically: the post goes to
   * `needs_check` and the user confirms whether it is live.
   */
  | "ambiguous";

export class ProviderError extends Error {
  constructor(
    message: string,
    public kind: ProviderErrorKind = "invalid",
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable() {
    return this.kind === "transient" || this.kind === "rate_limit";
  }
}

/**
 * Error kind of a failed *commit* request (the one that creates the post). 429 is a refusal before anything was
 * created, so it may be retried; 408/5xx may have created the post anyway.
 */
export function commitKindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 408 || status >= 500) return "ambiguous";
  return kindForStatus(status);
}

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  return "invalid";
}

export type MetricsUnavailableReason = "reconnect_required" | "not_supported";

/**
 * Analytics cannot be read for this account: the token lacks the analytics permission (reconnect to grant it) or the
 * platform / account type has none. Only changes the account's analytics status, never its publishing status.
 */
export class MetricsUnavailableError extends Error {
  constructor(
    public reason: MetricsUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "MetricsUnavailableError";
  }
}

/** Shorthand: the analytics permission is missing from the stored token. */
export const missingScope = (platform: string, scopes: string | string[], detail?: string) =>
  new MetricsUnavailableError(
    "reconnect_required",
    `${platform} analytics need the ${[scopes].flat().join(", ")} permission${[scopes].flat().length > 1 ? "s" : ""}: reconnect the account to grant ${[scopes].flat().length > 1 ? "them" : "it"}${detail ? ` (${detail})` : ""}`,
  );
