import { Hono } from "hono";
import { billingAdminRoutes, billingPublicRoutes, billingRoutes } from "./billing/routes";
import { PlanLimitError } from "./billing/entitlements";
import { forbidDemoUser, isSessionValid, requireAuth, sameOriginMutations, type AppEnv } from "./lib/auth";
import { APP_CSP, securityHeaders } from "./lib/headers";
import { refreshAvatars, refreshExpiringAccounts } from "./lib/accounts";
import { demoCron } from "./lib/demo";
import { ensureSchema } from "./lib/migrate";
import { recoverStuckPosts, sweepScheduledPosts } from "./lib/posts";
import { now } from "./lib/util";
import { CRON_METRICS_LIMITS, CRON_METRICS_LIMITS_CAMPAIGN_TICK, TICK_FETCH_BUDGET, collectMetrics, expireMetricsSchedules } from "./lib/metrics";
import { campaignSyncCron } from "./lib/revflare";
import { sweepMedia } from "./lib/media-lifecycle";
import { pruneDeletionsStatement } from "./lib/meta-deletion";
import { updateCheckCron } from "./lib/updates";
import { cronRunStatement, metricsEventsStatement, pruneUsageStatement, type MetricsEvent } from "./lib/usage";
import { accessRequestPublicRoutes, accessRequestRoutes } from "./routes/accessRequests";
import { accountGroupRoutes } from "./routes/accountGroups";
import { accountRoutes } from "./routes/accounts";
import { adminRoutes } from "./routes/admin";
import { analyticsRoutes } from "./routes/analytics";
import { appLoginRoutes } from "./routes/appLogin";
import { authRoutes } from "./routes/auth";
import { campaignRedirect, campaignRoutes } from "./routes/campaigns";
import { demoLogin, demoPage } from "./routes/demo";
import { deviceRoutes } from "./routes/devices";
import { invitationPublicRoutes, invitationRoutes } from "./routes/invitations";
import { legalPages } from "./routes/legal";
import { mcpRoutes } from "./routes/mcp";
import { mediaRoutes, publicMedia } from "./routes/media";
import { oauthRoutes } from "./routes/oauth";
import { platformRoutes } from "./routes/platforms";
import { playbookRoutes } from "./routes/playbooks";
import { postRoutes } from "./routes/posts";
import { settingsRoutes } from "./routes/settings";
import { updateRoutes, versionRoute } from "./routes/updates";
import { uploadLinkPublic, uploadLinkRoutes } from "./routes/uploadLinks";
import { supportAdminRoutes, supportPublicRoutes } from "./routes/support";
import { userRoutes } from "./routes/users";
import { changePassword, meRoutes, workspaceRoutes } from "./routes/workspaces";

export { PublishWorkflow } from "./workflow";

const api = new Hono<AppEnv>();
api.use("*", sameOriginMutations);
api.post("/auth/demo", demoLogin);
// Sign in on the web with the iOS app: public browser endpoints, app endpoints check the device token themselves.
api.route("/auth/app-login", appLoginRoutes);
api.route("/auth", authRoutes);
api.route("/invitations", invitationPublicRoutes);
// "Request access" form (signup_mode apply): POST only; the admin endpoints of the same path are below requireAuth.
api.route("/access-requests", accessRequestPublicRoutes);
api.route("/version", versionRoute);
// Public pricing table and payment provider webhooks (signed by the provider, no session).
api.route("/billing", billingPublicRoutes);
// Support chat widget (any website, CORS, a visitor token; docs/support-spec.md). The staff inbox is below requireAuth.
api.route("/support", supportPublicRoutes);
// Everything below needs a session, an iOS device token or an API key; handlers scope by c.var.workspace and check
// permissions.
api.use("*", requireAuth);
api.post("/auth/password", forbidDemoUser, changePassword); // Old path of POST /api/me/password.
api.route("/", meRoutes);
api.route("/", deviceRoutes);
api.route("/", workspaceRoutes);
api.route("/", userRoutes);
api.route("/", invitationRoutes);
api.route("/", accessRequestRoutes);
api.route("/", platformRoutes);
api.route("/", accountGroupRoutes);
api.route("/", accountRoutes);
api.route("/", mediaRoutes);
api.route("/", postRoutes);
api.route("/", analyticsRoutes);
api.route("/", playbookRoutes);
api.route("/", campaignRoutes);
api.route("/", settingsRoutes);
api.route("/", uploadLinkRoutes);
api.route("/", updateRoutes);
api.route("/", adminRoutes);
api.route("/", billingRoutes);
api.route("/", billingAdminRoutes);
api.route("/", supportAdminRoutes);
api.notFound((c) => c.json({ error: "Not found" }, 404));

const app = new Hono<AppEnv>();
app.use("*", securityHeaders);
app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});
app.onError((err, c) => {
  // Hosted mode: an action the workspace's plan does not allow (worker/billing/entitlements.ts).
  if (err instanceof PlanLimitError) return c.json(err.body, 402);
  console.error(err);
  return c.json({ error: err.message || "Internal error" }, 500);
});
// Public landing page for visitors; the app itself for signed-in users (both are static assets).
app.get("/", async (c) => {
  // Fetch "/" (not "/index.html", which the assets layer redirects back to "/", looping forever).
  if (await isSessionValid(c)) {
    // The app itself (Vite build, no inline scripts): strict CSP.
    c.set("csp", APP_CSP);
    return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw));
  }
  const res = await c.env.ASSETS.fetch(new Request(new URL("/landing/", c.req.url), c.req.raw));
  // Link previews need absolute URLs: the landing page ships relative ones so any instance can serve it.
  const origin = new URL(c.req.url).origin;
  return new HTMLRewriter()
    .on('meta[property="og:image"], meta[name="twitter:image"]', {
      element(el) {
        const v = el.getAttribute("content");
        if (v?.startsWith("/")) el.setAttribute("content", origin + v);
      },
    })
    .on("head", {
      element(el) {
        el.append(`<meta property="og:url" content="${origin}/">`, { html: true });
      },
    })
    .transform(res);
});
// Public live demo (DEMO_MODE=true): signs in as the demo user and opens the app.
app.get("/demo", demoPage);
// Privacy Policy, Terms of Service and Data Deletion with the operator's details (Admin → Settings → Legal & contact).
app.route("/", legalPages);
app.route("/api", api);
app.route("/oauth", oauthRoutes);
app.route("/m", publicMedia);
app.route("/u", uploadLinkPublic);
// Tracked App Store links (public, cheap: one D1 read + one upsert per counted click).
app.route("/a", campaignRedirect);
app.route("/mcp", mcpRoutes(app));

/**
 * The one cron trigger (wrangler.jsonc `triggers.crons`; mirror changes in wrangler.local.jsonc). Free accounts get only
 * 5 cron triggers shared by all their Workers, so Postflare uses one and picks the job from the tick's UTC time:
 * :00/:15/:30/:45 publishing + refresh, :05/:20/:35/:50 analytics (its own invocation, so its own 50-query budget),
 * 03:10 daily cleanups. The other ticks do nothing.
 */
export const TICK_CRON = "*/5 * * * *";
/** Older configs with one trigger per job still work: these expressions map straight to their job. */
export const FREQUENT_CRON = "*/15 * * * *";
export const DAILY_CRON = "0 3 * * *";
export const METRICS_CRON = "7,22,37,52 * * * *";

export type CronJob = "frequent" | "metrics" | "daily";

export function cronJob(cron: string, scheduledTime: number): CronJob | null {
  if (cron === DAILY_CRON) return "daily";
  if (cron === METRICS_CRON) return "metrics";
  if (cron !== TICK_CRON) return "frequent"; // FREQUENT_CRON, or an unknown expression
  const d = new Date(scheduledTime);
  const m = d.getUTCMinutes();
  if (d.getUTCHours() === 3 && m === 10) return "daily";
  return m % 15 === 0 ? "frequent" : m % 15 === 5 ? "metrics" : null;
}

/**
 * Every 15 minutes: publishing safety nets, token refreshes, avatar copies (a couple of accounts), the demo. Kept small: one invocation may run
 * at most 50 D1 queries and 50 external subrequests on the Free plan (test/workers/budget.test.ts counts them).
 */
export async function frequentJobs(env: Env): Promise<void> {
  const started = now();
  await Promise.allSettled([
    sweepScheduledPosts(env),
    recoverStuckPosts(env),
    refreshExpiringAccounts(env),
    refreshAvatars(env),
    demoCron(env),
  ]);
  await recordCronRun(env, "frequent", started);
}

/** The hourly analytics tick (:50, or :52 with the legacy METRICS_CRON) also syncs Revflare campaign numbers. */
export const isCampaignTick = (scheduledTime: number) => new Date(scheduledTime).getUTCMinutes() >= 45;

/**
 * Analytics collection, on its own trigger so it doesn't share the publishing tick's D1 and subrequest budget.
 * Once an hour it first syncs App Store campaign numbers from Revflare (lib/revflare.ts: at most 2 workspaces, 2
 * fetches and one batch each) and collects fewer posts that tick to stay within the 50 D1 queries / 40 fetches.
 */
export async function metricsJobs(env: Env, scheduledTime: number = now()): Promise<void> {
  const started = now();
  const events: MetricsEvent[] = [];
  const campaignTick = isCampaignTick(scheduledTime);
  let fetches = 0;
  if (campaignTick) {
    fetches = await campaignSyncCron(env)
      .then((r) => r.fetches)
      .catch((err) => {
        console.error("campaign sync failed", err);
        return 4;
      });
  }
  const limits = campaignTick ? CRON_METRICS_LIMITS_CAMPAIGN_TICK : CRON_METRICS_LIMITS;
  await collectMetrics(env, { ...limits, budget: TICK_FETCH_BUDGET - fetches, events }).catch((err) => console.error("metrics cron failed", err));
  // The tick's usage events and its last-run marker: one batch (the tick is close to the 50-query budget).
  await env.DB.batch([...(events.length ? [metricsEventsStatement(env.DB, events)] : []), cronRunStatement(env.DB, "metrics", started, now())]).catch((err) =>
    console.error("metrics usage not recorded", err),
  );
}

/** Once a day: cleanups, the metrics schedule scan, the update check and the media lifecycle sweep. */
export async function dailyJobs(env: Env): Promise<void> {
  const started = now();
  await Promise.allSettled([
    // New Postflare release? At most one GitHub request a day (UPDATE_CHECK="false" turns it off).
    updateCheckCron(env),
    expireMetricsSchedules(env),
    sweepMedia(env),
    env.DB.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(now() - 60 * 60 * 1000).run(),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()).run(),
    env.DB.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(now()).run(),
    // iOS app: used/expired pairing codes and web login requests, and devices whose token was revoked or expired.
    env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").bind(now() - 60 * 60 * 1000).run(),
    env.DB.prepare("DELETE FROM web_logins WHERE expires_at < ?").bind(now() - 60 * 60 * 1000).run(),
    env.DB.prepare("DELETE FROM devices WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = devices.session_id AND s.expires_at > ?)").bind(now()).run(),
    env.DB.prepare("DELETE FROM upload_links WHERE expires_at < ?").bind(now() - 7 * 24 * 60 * 60 * 1000).run(),
    env.DB.prepare(
      "DELETE FROM settings WHERE (key LIKE 'login_fail:%' OR key LIKE 'magic_link:%' OR key LIKE 'demo_login:%' OR key LIKE 'signup:%' OR key LIKE 'pair_fail:%' OR key LIKE 'app_login:%' OR key LIKE 'apply:%') AND json_extract(value, '$.until') < ?",
    )
      .bind(now())
      .run(),
    env.DB.prepare("DELETE FROM invitations WHERE accepted_at IS NULL AND expires_at < ?").bind(now() - 30 * 24 * 60 * 60 * 1000).run(),
    // Access requests: only rejected ones go, 180 days after their last change (the rest is history for the admins).
    env.DB.prepare("DELETE FROM access_requests WHERE status = 'rejected' AND updated_at < ?").bind(now() - 180 * 24 * 60 * 60 * 1000).run(),
    // Meta data deletion requests shown on /data-deletion/ (90 days).
    pruneDeletionsStatement(env.DB, now()).run(),
    // Usage events older than USAGE_RETENTION_DAYS (bounded per run).
    pruneUsageStatement(env.DB, now()).run(),
    // Hosted mode: processed provider webhook events (90 days) and sign-ups never verified (7 days).
    env.DB.prepare("DELETE FROM billing_events WHERE created_at < ?").bind(now() - 90 * 24 * 60 * 60 * 1000).run(),
    env.DB.prepare(
      "DELETE FROM users WHERE status = 'pending' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = users.id)",
    )
      .bind(now() - 7 * 24 * 60 * 60 * 1000)
      .run(),
  ]);
  await recordCronRun(env, "daily", started);
}

/** `cron_last_run:<name>` in settings (Admin → Overview): one upsert per run, never fails the job. */
async function recordCronRun(env: Env, name: string, started: number) {
  await cronRunStatement(env.DB, name, started, now())
    .run()
    .catch((err) => console.error("cron last run not recorded", err));
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    const job = cronJob(event.cron, event.scheduledTime);
    if (!job) return;
    await ensureSchema(env.DB);
    ctx.waitUntil(job === "daily" ? dailyJobs(env) : job === "metrics" ? metricsJobs(env, event.scheduledTime) : frequentJobs(env));
  },
} satisfies ExportedHandler<Env>;
