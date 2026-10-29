import type { Context } from "hono";
import { createSession, destroySession, sessionUser, throttleIp, type AppEnv } from "../lib/auth";
import { DEMO_SESSION_TTL_MS, DEMO_USER_ID, DEMO_WORKSPACE_ID, demoEnabled, ensureDemo, takeDemoLogin } from "../lib/demo";

type Ctx = Context<AppEnv>;

/**
 * Sign the visitor in as the shared demo user (12h session in the demo workspace), seeding the demo on first use.
 * Returns an error status, or null when signed in.
 */
async function startDemo(c: Ctx): Promise<{ status: 404 | 429; error: string } | null> {
  if (!demoEnabled(c.env)) return { status: 404, error: "Not found" };
  // Already exploring the demo: keep that session (and do not count it against the limit).
  const current = await sessionUser(c);
  if (current?.user.demo) return null;
  // GET /demo linked from another site must not sign a user out of their own account (logout CSRF).
  if (current && c.req.method === "GET" && c.req.header("sec-fetch-site") === "cross-site") return null;
  if (!(await takeDemoLogin(c.env, throttleIp(c.req.header("cf-connecting-ip"))))) {
    return { status: 429, error: "Too many demo sessions from your network. Try again in an hour." };
  }
  await ensureDemo(c.env);
  // A signed-in user who opens the demo is signed out of their own account in this browser.
  if (current) await destroySession(c);
  await createSession(c, DEMO_USER_ID, DEMO_WORKSPACE_ID, DEMO_SESSION_TTL_MS);
  return null;
}

/** POST /api/auth/demo (public, DEMO_MODE only). */
export async function demoLogin(c: Ctx) {
  // Cross-origin POSTs are rejected by sameOriginMutations (lib/auth.ts) like every /api mutation.
  const err = await startDemo(c);
  return err ? c.json({ error: err.error }, err.status) : c.json({ ok: true });
}

/** GET /demo: the landing page's "Live demo" link. Signs in and opens the app. */
export async function demoPage(c: Ctx) {
  const err = await startDemo(c);
  if (!err) return c.redirect("/", 302);
  if (err.status === 404) return c.text("Not found", 404);
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Postflare demo</title>
<body style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#3f3f46">
<h1 style="font-size:1.4rem;color:#09090b">The live demo is busy</h1><p>${err.error}</p><p><a href="/" style="color:#e8590c">Back to Postflare</a></p></body>`,
    429,
  );
}
