import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth";

// Security headers. The Worker sets them on its own responses; pages served straight from static assets (the app
// on every other path, /landing/) get the same ones from public/_headers: keep both in sync. The legal pages
// (/privacy/, /terms/, /data-deletion/) are rendered by the Worker with APP_CSP, the CSP their static fallbacks get.

const COMMON = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Avatars and media previews come from the platforms' CDNs (and /m/ links may use PUBLIC_URL's origin).
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

/** Cloudflare Turnstile (bot check on the sign-up / sign-in forms): its script and its challenge iframe. */
const TURNSTILE = "https://challenges.cloudflare.com";

/** The React app (Vite build): no inline scripts; Turnstile's api.js and iframe. */
export const APP_CSP = [`script-src 'self' ${TURNSTILE}`, ...COMMON, `frame-src ${TURNSTILE}`].join("; ");

/** Pages written by hand or by the Worker (landing, upload page, demo notice): static inline scripts, no user markup. */
export const PAGE_CSP = ["script-src 'self' 'unsafe-inline'", ...COMMON].join("; ");

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  // Responses of fetch()/ASSETS have immutable headers: replace with a copy, then change the copy's headers (assigning
  // a Response with the headers already set would not work: Hono copies the previous response's headers over it).
  c.res = new Response(c.res.body, c.res);
  const h = c.res.headers;
  h.set("x-content-type-options", "nosniff");
  if (!h.has("referrer-policy")) h.set("referrer-policy", "strict-origin-when-cross-origin");
  if ((h.get("content-type") ?? "").startsWith("text/html")) {
    h.set("x-frame-options", "DENY");
    // The Vite dev server injects inline scripts (HMR) into index.html.
    if (!isLocal(new URL(c.req.url).hostname)) h.set("content-security-policy", c.get("csp") ?? PAGE_CSP);
  }
};
