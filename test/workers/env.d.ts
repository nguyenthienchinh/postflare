// Test-only bindings (test/workers/wrangler.test.jsonc), merged into the `env` of "cloudflare:test" / "cloudflare:workers".
// Worker code types its bindings with the global `Env`, which does not see these.
declare namespace Cloudflare {
  interface Env {
    /** Second D1 used to test migrating a legacy (single password) install. */
    LEGACY_DB: D1Database;
    /** Own instance for the live demo tests (they need DEMO_MODE and their own first user). */
    DEMO_DB: D1Database;
    /** Own instance for the analytics tests (they seed posts/metrics directly). */
    ANALYTICS_DB: D1Database;
    /** Own instance for the security hardening tests (SETUP_TOKEN needs a fresh instance). */
    SECURITY_DB: D1Database;
    /** Own instance for publishing safety, token refresh, D1 budget and media lifecycle tests. */
    PUBLISH_DB: D1Database;
    /** Own instance for the playbook tests (library, attribution, ranking, D1 query counts). */
    PLAYBOOKS_DB: D1Database;
    /** Own instance for the Meta data deletion callback tests (they configure Meta app secrets). */
    DELETION_DB: D1Database;
    /** Own instance for the App Store campaign tests (links, clicks, Revflare sync with mocked fetch). */
    CAMPAIGNS_DB: D1Database;
    /** Own instance for the sign-in link tests (they configure EMAIL_FROM and a fake EMAIL binding). */
    MAGIC_LINK_DB: D1Database;
    /** Own instance for hosted mode: plans, limits, trials, checkout/portal with mocked fetch, admin billing. */
    BILLING_DB: D1Database;
    /** Own instance for the payment provider webhooks (signatures, idempotency, status transitions). */
    WEBHOOKS_DB: D1Database;
    /** Own instance for public sign-up (with a fake EMAIL binding, and without email). */
    SIGNUP_DB: D1Database;
    /** Own instance for the Turnstile bot check (sign-up, sign-in links, login after failures; mocked siteverify). */
    TURNSTILE_DB: D1Database;
    /** Own instance for the iOS app: device tokens, pairing codes, devices, permissions across workspaces. */
    DEVICES_DB: D1Database;
    /** Own instance for APNs push notifications of publish results (mocked api.push.apple.com, D1 budget). */
    PUSH_DB: D1Database;
    /** Own instance for signing in on the web with the app (QR and push with number matching). */
    APP_LOGIN_DB: D1Database;
    /** Own instance for MEDIA_PUBLIC_URL (CDN media URLs) and image thumbnails (fake Images binding). */
    MEDIA_CDN_DB: D1Database;
    /** Own instance for access requests (/apply): sign-up modes, review, invitations, admin push and emails. */
    ACCESS_DB: D1Database;
    /** Own instance for the legal pages (/privacy/, /terms/, /data-deletion/) and Admin → Settings → Legal & contact. */
    LEGAL_DB: D1Database;
    /** Own instance for connecting accounts: the connect URL (switch account) and avatars copied to R2. */
    ACCOUNTS_DB: D1Database;
    /** Own instance for the support chat (widget API and staff inbox). */
    SUPPORT_DB: D1Database;
  }
}
