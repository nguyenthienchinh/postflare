import { Hono, type Context } from "hono";
import type { AppEnv } from "../lib/auth";
import { APP_CSP } from "../lib/headers";
import { loadLegalContext, renderDataDeletion, renderPrivacy, renderTerms, type LegalContext } from "../lib/legal";

/**
 * /privacy/, /terms/ and /data-deletion/ with the operator's details (Admin → Settings → Legal & contact) and the
 * instance's plans (worker/lib/legal.ts). Listed in `assets.run_worker_first`; public/ keeps the generic rendering as
 * a fallback. One D1 query per page, a short browser/edge cache.
 */
export const legalPages = new Hono<AppEnv>();

const PAGES: Record<string, (ctx: LegalContext) => string> = {
  "/privacy/": renderPrivacy,
  "/terms/": renderTerms,
  "/data-deletion/": renderDataDeletion,
};

async function serve(c: Context<AppEnv>, render: (ctx: LegalContext) => string) {
  const ctx = await loadLegalContext(c.env.DB, new URL(c.req.url).host);
  // Same CSP as the static assets of these paths (public/_headers "/*"): no inline scripts.
  c.set("csp", APP_CSP);
  c.header("cache-control", "public, max-age=300");
  return c.html(render(ctx));
}

for (const [path, render] of Object.entries(PAGES)) {
  legalPages.get(path, (c) => serve(c, render));
  // Like the assets layer: /privacy → /privacy/ (keeping the query, e.g. the Meta confirmation code).
  legalPages.get(path.slice(0, -1), (c) => c.redirect(path + new URL(c.req.url).search, 307));
}
