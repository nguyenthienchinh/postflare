import type { ProviderErrorKind } from "./errors";
import { expiresAt, oauthToken, requireApp } from "./http";
import type { AccountRecord, CredentialsUpdate, ProviderContext } from "./types";

/** OAuth + error helpers shared by the Google providers (YouTube, Business Profile). */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const googleDocsUrl = "https://console.cloud.google.com/apis/credentials";

export function googleAuthorizeUrl(
  ctx: ProviderContext,
  providerName: string,
  scopes: string[],
  p: { state: string; codeChallenge: string },
): string {
  const { clientId } = requireApp(ctx, providerName, "clientId", "clientSecret");
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ctx.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state: p.state,
    // offline + consent: always get a refresh token, even when the user connected before.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function googleExchangeCode(ctx: ProviderContext, providerName: string, code: string, codeVerifier: string) {
  const { clientId, clientSecret } = requireApp(ctx, providerName, "clientId", "clientSecret");
  const token = await oauthToken(ctx, GOOGLE_TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: ctx.redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return {
    credentials: { accessToken: token.access_token, refreshToken: token.refresh_token },
    expiresAt: expiresAt(token.expires_in),
    // Only sent for time-limited grants (e.g. an OAuth consent screen in Testing: 7 days).
    refreshExpiresAt: expiresAt(token.refresh_token_expires_in),
    scope: token.scope ?? "",
  };
}

export async function googleRefresh(ctx: ProviderContext, providerName: string, account: AccountRecord): Promise<CredentialsUpdate> {
  const { clientId, clientSecret } = requireApp(ctx, providerName, "clientId", "clientSecret");
  const token = await oauthToken(ctx, GOOGLE_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: String(account.credentials.refreshToken ?? ""),
    client_id: clientId,
    client_secret: clientSecret,
  });
  return {
    // Google usually does not rotate the refresh token; keep the stored one unless a new one is returned.
    credentials: { accessToken: token.access_token, ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}) },
    expiresAt: expiresAt(token.expires_in),
    ...(token.refresh_token_expires_in ? { refreshExpiresAt: expiresAt(token.refresh_token_expires_in) } : {}),
  };
}

/** Reasons found in Google API error bodies (`error.errors[].reason` / `error.status` / `error.details[].reason`). */
export function googleReasons(body: any): string[] {
  const e = body?.error;
  if (!e || typeof e !== "object") return typeof e === "string" ? [e] : [];
  const out: string[] = [];
  if (typeof e.status === "string") out.push(e.status);
  for (const x of e.errors ?? []) if (x?.reason) out.push(String(x.reason));
  for (const x of e.details ?? []) if (x?.reason) out.push(String(x.reason));
  return out;
}

export function googleClassify(status: number, body: any): ProviderErrorKind | undefined {
  const reasons = googleReasons(body);
  const has = (...r: string[]) => r.some((x) => reasons.includes(x));
  if (status === 401 || has("UNAUTHENTICATED", "authError", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions"))
    return "auth";
  if (has("rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED")) return "rate_limit";
  // Daily quotas (quotaExceeded, uploadLimitExceeded) do not recover with a short backoff.
  if (has("quotaExceeded", "uploadLimitExceeded", "dailyLimitExceeded")) return "invalid";
  if (status === 429) return "rate_limit";
  if (status >= 500 || has("backendError", "internalError")) return "transient";
  return undefined;
}

export const googleAppFields = [
  { key: "clientId", label: "OAuth Client ID", type: "text" as const, required: true },
  { key: "clientSecret", label: "OAuth Client Secret", type: "password" as const, required: true },
];
