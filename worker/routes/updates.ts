import { Hono } from "hono";
import { requireInstancePermission, type AppEnv } from "../lib/auth";
import { MANUAL_CHECK_INTERVAL, checkForUpdatesNow, readStoredUpdate, updateCheckEnabled, updateStatus, versionInfo } from "../lib/updates";
import { now } from "../lib/util";

/** GET /api/version: public and cheap (no auth, no queries), for clients checking compatibility (CLI). */
export const versionRoute = new Hono<AppEnv>().get("/", (c) => {
  c.header("cache-control", "no-store");
  return c.json(versionInfo());
});

/** Update status for instance admins. */
export const updateRoutes = new Hono<AppEnv>();

updateRoutes.get("/updates", requireInstancePermission("instance.settings.manage"), async (c) => {
  return c.json(updateStatus(c.env, await readStoredUpdate(c.env.DB)));
});

/** Checks GitHub now. At most one request per minute: a recent result is returned as is. */
updateRoutes.post("/updates/check", requireInstancePermission("instance.settings.manage"), async (c) => {
  if (!updateCheckEnabled(c.env)) return c.json({ error: "Update checks are turned off (UPDATE_CHECK=\"false\")" }, 409);
  const stored = await readStoredUpdate(c.env.DB);
  if (stored && now() - stored.checkedAt < MANUAL_CHECK_INTERVAL) return c.json(updateStatus(c.env, stored));
  return c.json(updateStatus(c.env, await checkForUpdatesNow(c.env)));
});
