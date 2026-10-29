interface Env {
  /** Optional encryption secret. When unset, a key is generated on first run and kept in D1. */
  SECRET_KEY?: string;
  /** Optional public base URL (e.g. https://social.example.com). Defaults to the request origin. */
  PUBLIC_URL?: string;
  /**
   * Optional public custom domain of the R2 media bucket (e.g. https://cdn.example.com, no trailing slash). When set,
   * media URLs (API, app, platforms) point straight at R2 instead of the Worker's signed /m/ links (which keep working).
   */
  MEDIA_PUBLIC_URL?: string;
  /** Optional secret: when set, creating the first user (POST /api/auth/setup) requires it (fresh-deploy takeover guard). */
  SETUP_TOKEN?: string;
  /** "true" turns on the public live demo (GET /demo, POST /api/auth/demo, sandboxed demo workspace). Off by default. */
  DEMO_MODE?: string;
  /** "false" turns off the daily check for new Postflare releases on GitHub (one request a day). On by default. */
  UPDATE_CHECK?: string;
  /** GitHub repository (owner/name) whose releases the update check reads. Default: FerdiKT/postflare. */
  UPDATE_REPO?: string;
  /** Sender of sign-in link emails, e.g. "Postflare <login@example.com>" or a bare address. */
  EMAIL_FROM?: string;
  /** Optional Cloudflare `send_email` binding (Email Sending) for sign-in link emails; an instance admin turns them on. */
  EMAIL?: SendEmail;
  /** Optional Cloudflare Turnstile site key (var) for the bot check on sign-up, sign-in links and repeated failed sign-ins. Wins over Admin → Settings. */
  TURNSTILE_SITE_KEY?: string;
  /** Optional Turnstile secret key (secret), with TURNSTILE_SITE_KEY. Wins over the one stored in Admin → Settings. */
  TURNSTILE_SECRET_KEY?: string;
  /** iOS app push (APNs token auth): contents of the .p8 key (secret). Push is off unless all four APNS_* are set. */
  APNS_PRIVATE_KEY?: string;
  /** Key ID of the APNs .p8 key (var). */
  APNS_KEY_ID?: string;
  /** Apple Developer Team ID (var). */
  APNS_TEAM_ID?: string;
  /** Bundle ID of the iOS app, the APNs topic (var), e.g. app.ferdi.postflare. */
  APNS_TOPIC?: string;
  /** Optional App Store URL of the Postflare iOS app: the sign-in page offers "Sign in with the iPhone app" and "Get the app". */
  APP_STORE_URL?: string;
}
