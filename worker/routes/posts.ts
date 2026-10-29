import { Hono } from "hono";
import type { CreatePostsInput, OverviewDTO, ResolvePostInput, ThreadItem } from "../../shared/types";
import type { Context } from "hono";
import { assertNotLocked, enforce, entitlements, type LimitAdds } from "../billing/entitlements";
import { monthStart } from "../billing/host";
import { forbidInDemoWorkspace, requirePermission, wsId, type AppEnv } from "../lib/auth";
import { findAccount, freshAccount, providerContext, type AccountRow } from "../lib/accounts";
import { DEMO_POSTS_PER_DAY, demoPostsLeft, queueDemoPublish, simulateDueDemoPosts } from "../lib/demo";
import type { MediaRow } from "../lib/media";
import { normalizeVariant, resolveAttribution } from "../lib/playbooks";
import {
  campaignContext,
  insertLinkStatement,
  isLinkCollision,
  listLinks,
  newPostLink,
  rewriteForCampaign,
  trackedUrl,
  wantsPostLink,
  type CampaignContext,
  type CampaignLinkRow,
} from "../lib/campaigns";
import { baseUrl, notAllowedMessage, providerAllowed } from "../lib/settings";
import { appStoreCampaignUrl } from "../../shared/campaigns";
import { findPost, logPost, logStatement, postDto, startWorkflow, startWorkflows, terminateWorkflow, workflowInstanceId, type PostRow } from "../lib/posts";
import { errorMessage, newId, now, parseJson } from "../lib/util";
import { validatePost } from "../lib/validate";
import { ProviderError } from "../providers/errors";
import { getProvider } from "../providers/registry";

export const postRoutes = new Hono<AppEnv>();

type Draft = { accountId: string; content: string; media: string[]; settings: Record<string, unknown>; thread: ThreadItem[] };

type Media = Map<string, MediaRow>;

/** Accounts and media of the workspace that the drafts use: two queries whatever the number of drafts. */
async function loadRefs(env: Env, workspaceId: string, drafts: Draft[]): Promise<{ accounts: Map<string, AccountRow>; media: Media }> {
  const accountIds = [...new Set(drafts.map((d) => d.accountId))];
  const mediaIds = [...new Set(drafts.flatMap((d) => [...d.media, ...d.thread.flatMap((t) => t.media)]))];
  const [accounts, media] = await Promise.all([
    accountIds.length
      ? env.DB.prepare(`SELECT * FROM accounts WHERE workspace_id = ? AND id IN (${accountIds.map(() => "?").join(",")})`)
          .bind(workspaceId, ...accountIds)
          .all<AccountRow>()
      : { results: [] as AccountRow[] },
    mediaIds.length
      ? env.DB.prepare(`SELECT * FROM media WHERE workspace_id = ? AND id IN (${mediaIds.map(() => "?").join(",")})`)
          .bind(workspaceId, ...mediaIds)
          .all<MediaRow>()
      : { results: [] as MediaRow[] },
  ]);
  return { accounts: new Map(accounts.results.map((r) => [r.id, r])), media: new Map(media.results.map((r) => [r.id, r])) };
}

/** Media rows in order. Throws for ids that are unknown or belong to another workspace. */
function mediaRows(media: Media, ids: string[]): MediaRow[] {
  return ids.map((id) => {
    const row = media.get(id);
    if (!row) throw new Error(`Media ${id} not found`);
    return row;
  });
}

/** Validate a draft against its account's provider. Returns errors (empty when valid). No D1 query. */
function check(refs: Awaited<ReturnType<typeof loadRefs>>, d: Draft, strict: boolean, allowed: readonly string[] | null | undefined): string[] {
  const account = refs.accounts.get(d.accountId);
  if (!account) return [`Account ${d.accountId} not found`];
  const provider = getProvider(account.provider);
  if (!provider) return [`Unknown provider ${account.provider}`];
  if (!providerAllowed(allowed, provider.id)) return [`${account.name}: ${notAllowedMessage(provider.name)}`];
  try {
    // Drafts are not validated against the platform, but their media must belong to this workspace.
    const media = mediaRows(refs.media, d.media);
    const thread = d.thread.map((t) => ({ ...t, mediaRows: mediaRows(refs.media, t.media) }));
    if (!strict) return [];
    if (account.status === "disabled") return [`${account.name} is disabled`];
    return validatePost(provider, { content: d.content, media, settings: d.settings, thread }).map((e) => `${account.name}: ${e}`);
  } catch (err) {
    return [(err as Error).message];
  }
}

async function checkAll(env: Env, workspaceId: string, drafts: Draft[], strict: boolean, allowed: readonly string[] | null | undefined): Promise<string[]> {
  const refs = await loadRefs(env, workspaceId, drafts);
  return drafts.flatMap((d) => check(refs, d, strict, allowed));
}

function normalize(p: CreatePostsInput["posts"][number]): Draft {
  return {
    accountId: p.accountId,
    content: p.content ?? "",
    media: p.media ?? [],
    settings: p.settings ?? {},
    thread: (p.thread ?? []).map((t) => ({ content: t.content ?? "", media: t.media ?? [] })),
  };
}

/**
 * Playbook attribution of a create/update body: `undefined` when the body has none of the fields, else the values to
 * store (`playbookId: null` clears it). The playbook must be built-in or belong to this workspace (else "not found").
 */
async function attribution(
  env: Env,
  workspaceId: string,
  body: { playbookId?: string | null; playbookVersion?: number | null; variant?: string | null },
  current?: { id: string | null; version: number | null; variant: string | null },
): Promise<{ id: string | null; version: number | null; variant: string | null } | { error: string } | undefined> {
  if (body.playbookId === undefined && body.playbookVersion === undefined && body.variant === undefined) return undefined;
  const variant = body.variant === undefined ? (current?.variant ?? null) : normalizeVariant(body.variant);
  if (variant && typeof variant === "object") return variant;
  // Only the variant changes: keep the playbook as it is.
  if (current && body.playbookId === undefined && body.playbookVersion === undefined) return { id: current.id, version: current.version, variant };
  const ref = body.playbookId === undefined ? (current?.id ?? null) : body.playbookId;
  if (ref === null || ref === "") {
    if (body.playbookVersion != null) return { error: "playbookVersion needs a playbookId" };
    return { id: null, version: null, variant };
  }
  if (typeof ref !== "string") return { error: "playbookId must be a string" };
  const version = body.playbookVersion === undefined || body.playbookVersion === null ? null : Number(body.playbookVersion);
  const res = await resolveAttribution(env.DB, workspaceId, ref, version);
  if ("error" in res) return res;
  return { id: res.id, version: res.version, variant };
}

/** `autoLink` of a body → stored value (undefined = not in the body). */
const autoLinkValue = (v: unknown): number | null | undefined => (v === undefined ? undefined : v === null ? null : v ? 1 : 0);

/**
 * Tracked links of new posts (clickable platforms, when the workspace has a provider token) and, with auto-insert on,
 * their rewritten text (App Store URLs replaced, link appended; see rewriteForCampaign). No D1 query.
 */
function planCampaign(
  ws: string,
  rows: Array<{ id: string; d: Draft }>,
  refs: Awaited<ReturnType<typeof loadRefs>>,
  camp: CampaignContext,
  base: string | null,
  autoInsert: boolean,
  attempt: number,
): { drafts: Draft[]; links: CampaignLinkRow[]; notes: Map<string, string[]> } {
  const links: CampaignLinkRow[] = [];
  const notes = new Map<string, string[]>();
  const drafts = rows.map(({ id, d }) => {
    const account = refs.accounts.get(d.accountId);
    const provider = account && getProvider(account.provider);
    if (!camp.app || !account || !provider || !wantsPostLink(provider.id)) return d;
    if (!camp.providerToken || !base) {
      notes.set(id, ["No tracked App Store link: set the Apple provider token in Workspace settings → App Store campaigns"]);
      return d;
    }
    const link = newPostLink(ws, { id, accountId: account.id, provider: provider.id }, camp.app, camp.providerToken, attempt);
    links.push(link);
    if (!autoInsert) return d;
    const r = rewriteForCampaign(provider, d, trackedUrl(base, link.code), camp.app.appStoreId);
    if (r.skipped.length) notes.set(id, r.skipped);
    return r.changed ? { ...d, content: r.content, thread: r.thread, settings: r.settings } : d;
  });
  return { drafts, links, notes };
}

/** Returns null for an unparseable `scheduledAt` (NaN would otherwise be stored as NULL and publish immediately). */
function resolveSchedule(scheduledAt: CreatePostsInput["scheduledAt"]): { status: PostRow["status"]; at: number | null } | null {
  if (scheduledAt === null || scheduledAt === undefined) return { status: "draft", at: null };
  if (scheduledAt === "now") return { status: "scheduled", at: now() };
  // A ms timestamp or an ISO date string.
  const at = typeof scheduledAt === "string" ? Date.parse(scheduledAt) : Number(scheduledAt);
  // Workflows can sleep for at most a year.
  if (!Number.isFinite(at) || at > now() + 360 * 24 * 60 * 60 * 1000) return null;
  return { status: "scheduled", at: Math.max(at, now()) };
}

/** Monthly post limits of posts scheduled at `at` on accounts of these providers (one per post). */
function postSlots(at: number, providers: Array<string | null | undefined>): LimitAdds {
  const x = providers.filter((p) => p === "x").length;
  return { posts_per_month: [{ at, n: providers.length }], ...(x ? { x_posts_per_month: [{ at, n: x }] } : {}) };
}

/** Provider of an account of the request's workspace, only looked up when limits apply (no query otherwise). */
async function accountProvider(c: Context<AppEnv>, accountId: string): Promise<string | null> {
  if (!entitlements(c.var.workspace?.billing).billing) return null;
  const r = await c.env.DB.prepare("SELECT provider FROM accounts WHERE id = ? AND workspace_id = ?").bind(accountId, wsId(c)).first<{ provider: string }>();
  return r?.provider ?? null;
}

/**
 * Demo workspace: posts never get a Workflow. Immediate ones are "published" a few seconds later in the background,
 * later ones when they are due (`simulateDueDemoPosts`: cron, and whenever the demo's posts are listed).
 */
const isDemo = (c: Context<AppEnv>) => !!c.var.workspace?.demo;
const isImmediate = (at: number | null) => at !== null && at <= now() + 5000;
const demoPublish = (c: Context<AppEnv>, ids: string[]) => queueDemoPublish(c.env, (p) => c.executionCtx.waitUntil(p), ids);

postRoutes.get("/posts", requirePermission("posts.read"), async (c) => {
  if (isDemo(c)) await simulateDueDemoPosts(c.env, wsId(c));
  const where: string[] = ["workspace_id = ?"];
  const binds: unknown[] = [wsId(c)];
  const { from, to, status, accountId, groupId } = c.req.query();
  if (from) where.push("COALESCE(scheduled_at, created_at) >= ?") && binds.push(Number(from));
  if (to) where.push("COALESCE(scheduled_at, created_at) < ?") && binds.push(Number(to));
  if (status) {
    const list = status.split(",");
    where.push(`status IN (${list.map(() => "?").join(",")})`);
    binds.push(...list);
  }
  if (accountId) where.push("account_id = ?") && binds.push(accountId);
  if (groupId) where.push("group_id = ?") && binds.push(groupId);
  // Posts of the accounts in an account group ("none" = ungrouped accounts).
  const accountGroupId = c.req.query("accountGroupId");
  if (accountGroupId === "none") where.push("account_id IN (SELECT id FROM accounts WHERE workspace_id = ? AND group_id IS NULL)") && binds.push(wsId(c));
  else if (accountGroupId) where.push("account_id IN (SELECT id FROM accounts WHERE workspace_id = ? AND group_id = ?)") && binds.push(wsId(c), accountGroupId);
  const playbookId = c.req.query("playbookId");
  if (playbookId === "none") where.push("playbook_id IS NULL");
  else if (playbookId === "any") where.push("playbook_id IS NOT NULL");
  else if (playbookId) where.push("playbook_id = ?") && binds.push(playbookId);
  const variant = c.req.query("variant");
  if (variant) where.push("variant = ?") && binds.push(variant);
  const limit = Math.min(Number(c.req.query("limit")) || 500, 1000);
  const order = c.req.query("order") === "desc" ? "DESC" : "ASC";
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM posts WHERE ${where.join(" AND ")} ORDER BY COALESCE(scheduled_at, created_at) ${order} LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<PostRow>();
  return c.json(results.map(postDto));
});

postRoutes.get("/posts/:id", requirePermission("posts.read"), async (c) => {
  const row = await findPost(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT id, level, message, created_at AS createdAt FROM post_logs WHERE post_id = ? ORDER BY id",
  )
    .bind(row.id)
    .all();
  const [campaign] = await listLinks(c.env.DB, wsId(c), await baseUrl(c.env, c.req.url), { postId: row.id, kind: "post", limit: 1 });
  return c.json({ ...postDto(row), campaign: campaign ?? null, logs: results });
});

postRoutes.post("/posts/validate", requirePermission("posts.write"), async (c) => {
  const body = await c.req.json<CreatePostsInput>();
  const errors = await checkAll(c.env, wsId(c), (body.posts ?? []).map(normalize), true, c.var.workspace?.allowedProviders);
  return c.json({ errors });
});

postRoutes.post("/posts", requirePermission("posts.write"), async (c) => {
  const workspaceId = wsId(c);
  const body = await c.req.json<CreatePostsInput>();
  if (!body.posts?.length) return c.json({ error: "Select at least one account" }, 400);
  const normalized = body.posts.map(normalize);
  const schedule = resolveSchedule(body.scheduledAt);
  if (!schedule) return c.json({ error: "Invalid scheduledAt" }, 400);
  const { status, at } = schedule;
  // App Store campaign: the app and the workspace's provider token / auto-insert default (one query, only with an app).
  const appRef = typeof body.appId === "string" && body.appId.trim() ? body.appId.trim() : null;
  if (body.appId !== undefined && body.appId !== null && typeof body.appId !== "string") return c.json({ error: "appId must be a string" }, 400);
  const camp = appRef ? await campaignContext(c.env.DB, workspaceId, appRef) : null;
  if (appRef && !camp?.app) return c.json({ error: `App ${appRef} not found (add it in Workspace settings → App Store campaigns)` }, 404);
  const autoLink = autoLinkValue(body.autoLink);
  const base = camp?.app && camp.providerToken ? await baseUrl(c.env, c.req.url) : null;

  const refs = await loadRefs(c.env, workspaceId, normalized);
  const ids = normalized.map(() => newId("pst_"));
  const plan = (attempt: number) =>
    camp?.app
      ? planCampaign(workspaceId, normalized.map((d, i) => ({ id: ids[i], d })), refs, camp, base, !!(autoLink ?? (camp.autoLink ? 1 : 0)), attempt)
      : { drafts: normalized, links: [] as CampaignLinkRow[], notes: new Map<string, string[]>() };
  let planned = plan(0);
  // Validated after the rewrite: exactly what will be published.
  const errors = planned.drafts.flatMap((d) => check(refs, d, status !== "draft", c.var.workspace?.allowedProviders));
  if (errors.length) return c.json({ error: errors.join("\n"), errors }, 400);
  const pb = await attribution(c.env, workspaceId, body);
  if (pb && "error" in pb) return c.json({ error: pb.error }, pb.error.endsWith("not found") ? 404 : 400);
  // Hosted mode: posts per month (one per account) and X posts per month, counted in the month they are scheduled in
  // (drafts are free until scheduled). No query while billing is off.
  await enforce(c, status === "scheduled" ? postSlots(at!, normalized.map((d) => refs.accounts.get(d.accountId)?.provider)) : {});
  if (isDemo(c) && (await demoPostsLeft(c.env, workspaceId)) < normalized.length) {
    return c.json(
      { error: `The live demo has reached today's limit of ${DEMO_POSTS_PER_DAY} new posts. It resets daily: come back tomorrow, or deploy your own Postflare.` },
      429,
    );
  }

  const groupId = newId("grp_");
  const t = now();
  const demo = isDemo(c);
  // Real workspaces start one workflow per scheduled post; its instance id is known up front (`${id}-0`).
  const withWorkflow = status === "scheduled" && !demo;
  const message = status === "scheduled" ? (body.scheduledAt === "now" ? "Queued for immediate publishing" : `Scheduled for ${new Date(at!).toISOString()}`) : null;
  const statements = () => {
    const rows = planned.drafts.map((d, i) => {
      const id = ids[i];
      return { id, revision: 0, d, workflowId: withWorkflow ? workflowInstanceId({ id, revision: 0 }) : null };
    });
    return {
      rows,
      list: [
        ...rows.map((r) =>
          c.env.DB.prepare(
            `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, settings, thread, attempts, revision, workflow_id, created_at, updated_at, workspace_id, created_by, playbook_id, playbook_version, variant, app_id, campaign_autolink)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(r.id, groupId, r.d.accountId, status, at, r.d.content, JSON.stringify(r.d.media), JSON.stringify(r.d.settings), JSON.stringify(r.d.thread), r.workflowId, t, t, workspaceId, c.var.user.id, pb?.id ?? null, pb?.version ?? null, pb?.variant ?? null, camp?.app?.id ?? null, autoLink ?? null),
        ),
        ...planned.links.map((l) => insertLinkStatement(c.env.DB, l)),
        ...(message ? rows.map((r) => logStatement(c.env.DB, r.id, "info", message)) : []),
        ...[...planned.notes].flatMap(([id, notes]) => notes.map((n) => logStatement(c.env.DB, id, "warn", n))),
      ],
    };
  };
  // One batch (one transaction) for every row and log line: the D1 query count does not grow with the accounts.
  let batch = statements();
  try {
    await c.env.DB.batch(batch.list);
  } catch (err) {
    // A link code or campaign token collided (practically never): new ones, same posts.
    if (!isLinkCollision(err)) throw err;
    planned = plan(1);
    batch = statements();
    await c.env.DB.batch(batch.list);
  }
  const rows = batch.rows;
  if (withWorkflow) {
    // If this fails, the posts keep their workflow ids and the cron sweep (sweepScheduledPosts) re-arms them.
    await startWorkflows(c.env, rows);
  } else if (demo && status === "scheduled" && isImmediate(at)) {
    await demoPublish(c, rows.map((r) => r.id));
  }
  const { results } = await c.env.DB.prepare("SELECT * FROM posts WHERE group_id = ? AND workspace_id = ?")
    .bind(groupId, workspaceId)
    .all<PostRow>();
  return c.json(results.map(postDto), 201);
});

/** Edit a draft/scheduled/failed post. Changing `scheduledAt` reschedules; null turns it into a draft. */
postRoutes.patch("/posts/:id", requirePermission("posts.write"), async (c) => {
  const ws = wsId(c);
  const row = await findPost(c.env, ws, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!["draft", "scheduled", "failed", "cancelled"].includes(row.status))
    return c.json({ error: `A ${row.status} post cannot be edited` }, 409);
  const body = await c.req.json<
    Partial<Draft> & Pick<CreatePostsInput, "playbookId" | "playbookVersion" | "variant" | "appId" | "autoLink"> & { scheduledAt?: CreatePostsInput["scheduledAt"] }
  >();
  let draft: Draft = {
    accountId: row.account_id,
    content: body.content ?? row.content,
    media: body.media ?? parseJson(row.media, []),
    settings: body.settings ?? parseJson(row.settings, {}),
    thread: body.thread ? body.thread.map((t) => ({ content: t.content ?? "", media: t.media ?? [] })) : parseJson(row.thread, []),
  };
  const sched =
    body.scheduledAt !== undefined
      ? resolveSchedule(body.scheduledAt)
      : { status: row.status === "scheduled" ? "scheduled" : ("draft" as PostRow["status"]), at: row.scheduled_at };
  if (!sched) return c.json({ error: "Invalid scheduledAt" }, 400);
  // A locked workspace (hosted mode, no active plan) can edit drafts but not schedule them. Scheduling a post that
  // holds no slot yet (draft, failed, cancelled) or moving it to another month takes one in the target month.
  const takesSlot =
    sched.status === "scheduled" && (row.status !== "scheduled" || row.scheduled_at === null || monthStart(row.scheduled_at) !== monthStart(sched.at!));
  if (sched.status === "scheduled") await enforce(c, takesSlot ? postSlots(sched.at!, [await accountProvider(c, row.account_id)]) : {});

  // App Store campaign: the app (kept, changed or removed), the auto-insert override, the post's tracked link.
  if (body.appId !== undefined && body.appId !== null && typeof body.appId !== "string") return c.json({ error: "appId must be a string" }, 400);
  const appRef = body.appId === undefined ? (row.app_id ?? null) : body.appId?.trim() || null;
  const autoLink = body.autoLink === undefined ? (row.campaign_autolink ?? null) : autoLinkValue(body.autoLink)!;
  const camp = appRef ? await campaignContext(c.env.DB, ws, appRef) : null;
  if (appRef && !camp?.app) return c.json({ error: `App ${appRef} not found (add it in Workspace settings → App Store campaigns)` }, 404);
  const refs = await loadRefs(c.env, ws, [draft]);
  let linkStatement: ((revision: number) => D1PreparedStatement) | null = null;
  let notes: string[] = [];
  const provider = getProvider(refs.accounts.get(row.account_id)?.provider ?? "");
  if (camp?.app && provider && wantsPostLink(provider.id) && camp.providerToken) {
    const base = await baseUrl(c.env, c.req.url);
    const existing = await c.env.DB.prepare("SELECT * FROM campaign_links WHERE post_id = ? AND workspace_id = ?").bind(row.id, ws).first<CampaignLinkRow>();
    let link: CampaignLinkRow;
    // Only while the update below succeeds (guarded on the new revision): the link and the text change together.
    const guard = "EXISTS (SELECT 1 FROM posts WHERE id = ? AND revision = ?)";
    if (existing) {
      // Stable: same code and token; a new app keeps the token and points the link at the new app.
      link = existing;
      if (existing.app_id !== camp.app.id) {
        link = { ...existing, app_id: camp.app.id, app_store_id: camp.app.appStoreId, url: appStoreCampaignUrl(camp.app.appStoreId, camp.providerToken, existing.ct) };
        linkStatement = (rev) =>
          c.env.DB.prepare(`UPDATE campaign_links SET app_id = ?, app_store_id = ?, url = ? WHERE code = ? AND ${guard}`).bind(link.app_id, link.app_store_id, link.url, link.code, row.id, rev);
      }
    } else {
      link = newPostLink(ws, { id: row.id, accountId: row.account_id, provider: provider.id }, camp.app, camp.providerToken);
      linkStatement = (rev) =>
        c.env.DB.prepare(
          `INSERT INTO campaign_links (code, workspace_id, kind, post_id, account_id, provider, app_id, app_store_id, ct, url, created_at)
           SELECT ?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        ).bind(link.code, ws, row.id, link.account_id, link.provider, link.app_id, link.app_store_id, link.ct, link.url, link.created_at, row.id, rev);
    }
    // Rewrite only when this edit touches the text, settings, app or auto-insert (a reschedule leaves the text alone).
    const touched = body.content !== undefined || body.thread !== undefined || body.settings !== undefined || body.appId !== undefined || body.autoLink !== undefined;
    if (touched && !!(autoLink ?? (camp.autoLink ? 1 : 0))) {
      const r = rewriteForCampaign(provider, draft, trackedUrl(base, link.code), camp.app.appStoreId);
      notes = r.skipped;
      if (r.changed) draft = { ...draft, content: r.content, thread: r.thread, settings: r.settings };
    }
  }
  const errors = [draft].flatMap((d) => check(refs, d, sched.status === "scheduled", c.var.workspace?.allowedProviders));
  if (errors.length) return c.json({ error: errors.join("\n"), errors }, 400);
  const pb = (await attribution(c.env, ws, body, { id: row.playbook_id ?? null, version: row.playbook_version ?? null, variant: row.variant ?? null })) ?? {
    id: row.playbook_id ?? null,
    version: row.playbook_version ?? null,
    variant: row.variant ?? null,
  };
  if ("error" in pb) return c.json({ error: pb.error }, pb.error.endsWith("not found") ? 404 : 400);

  // Guarded on the revision/status we read: if the workflow claimed the post meanwhile, it is publishing and must
  // not be rescheduled (that would publish it twice). Bump first, then stop the old workflow: its claim now fails.
  const revision = row.revision + 1;
  const update = c.env.DB.prepare(
    `UPDATE posts SET content = ?, media = ?, settings = ?, thread = ?, status = ?, scheduled_at = ?, error = NULL,
       revision = ?, workflow_id = NULL, updated_at = ?, playbook_id = ?, playbook_version = ?, variant = ?, app_id = ?, campaign_autolink = ?
     WHERE id = ? AND workspace_id = ? AND revision = ? AND status = ?`,
  ).bind(draft.content, JSON.stringify(draft.media), JSON.stringify(draft.settings), JSON.stringify(draft.thread), sched.status, sched.at, revision, now(), pb.id, pb.version, pb.variant, camp?.app?.id ?? null, autoLink, row.id, ws, row.revision, row.status);
  const extra = [...(linkStatement ? [linkStatement(revision)] : []), ...notes.map((n) => logStatement(c.env.DB, row.id, "warn", n))];
  const res = extra.length ? (await c.env.DB.batch([update, ...extra]))[0] : await update.run();
  if (!res.meta.changes) return c.json({ error: "The post changed while saving (it may be publishing), reload and try again" }, 409);
  if (row.workflow_id) await terminateWorkflow(c.env, row.workflow_id);
  if (sched.status === "scheduled") {
    if (isDemo(c)) {
      await logPost(c.env, row.id, "info", `Rescheduled for ${new Date(sched.at!).toISOString()}`);
      if (isImmediate(sched.at)) await demoPublish(c, [row.id]);
    } else {
      await startWorkflow(c.env, { id: row.id, revision, workflow_id: null });
      await logPost(c.env, row.id, "info", `Rescheduled for ${new Date(sched.at!).toISOString()}`);
    }
  }
  return c.json(postDto((await findPost(c.env, ws, row.id))!));
});

postRoutes.post("/posts/:id/retry", requirePermission("posts.write"), async (c) => {
  const row = await findPost(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "failed" && row.status !== "cancelled") return c.json({ error: "Only failed or cancelled posts can be retried" }, 409);
  // Failed and cancelled posts hold no slot: publishing now takes one this month.
  const at = now();
  await enforce(c, postSlots(at, [await accountProvider(c, row.account_id)]));
  const revision = row.revision + 1;
  const res = await c.env.DB.prepare(
    "UPDATE posts SET status = 'scheduled', scheduled_at = ?, error = NULL, revision = ?, workflow_id = NULL, updated_at = ? WHERE id = ? AND revision = ? AND status = ?",
  )
    .bind(at, revision, at, row.id, row.revision, row.status)
    .run();
  if (!res.meta.changes) return c.json({ error: "The post changed meanwhile, reload and try again" }, 409);
  if (isDemo(c)) {
    await logPost(c.env, row.id, "info", "Retry requested");
    await demoPublish(c, [row.id]);
  } else {
    await startWorkflow(c.env, { id: row.id, revision, workflow_id: null });
    await logPost(c.env, row.id, "info", "Retry requested");
  }
  return c.json(postDto((await findPost(c.env, wsId(c), row.id))!));
});

/**
 * Adds a follow-up (comment / thread reply) under an already published post, published right away. Not part of the
 * post's thread: it is logged on the post. `replyTo`: platform id of a reply under the post (e.g. someone's comment
 * on X) to answer that instead of the post itself.
 */
postRoutes.post("/posts/:id/comments", requirePermission("posts.write"), forbidInDemoWorkspace("Commenting on live posts"), async (c) => {
  const row = await findPost(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "published" || !row.external_id) return c.json({ error: "Only published posts can get a comment" }, 409);
  const { content, replyTo } = await c.req.json<{ content?: string; replyTo?: string }>().catch(() => ({ content: undefined, replyTo: undefined }));
  const parentId = replyTo?.trim() || row.external_id;
  if (!/^[\w.:-]{1,200}$/.test(parentId)) return c.json({ error: "replyTo must be a platform post id" }, 400);
  const text = content?.trim();
  if (!text) return c.json({ error: "content is required" }, 400);
  await assertNotLocked(c);
  const accountRow = await findAccount(c.env, wsId(c), row.account_id);
  const provider = accountRow && getProvider(accountRow.provider);
  if (!accountRow || !provider) return c.json({ error: "The post's account no longer exists" }, 409);
  if (!provider.reply || !provider.capabilities.thread) return c.json({ error: `${provider.name} does not support comments or replies` }, 400);
  const settings = parseJson<Record<string, unknown>>(row.settings, {});
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const account = await freshAccount(c.env, provider, ctx, accountRow);
    const data = parseJson<Record<string, unknown>>(row.external_data, {});
    const r = await provider.reply(ctx, account, { rootId: row.external_id, parentId, rootData: data, parentData: parentId === row.external_id ? data : undefined }, {
      id: `${row.id}-c${now()}`,
      content: text,
      media: [],
      settings,
      scheduledAt: row.scheduled_at ?? now(),
      createdAt: row.created_at,
    });
    await logPost(c.env, row.id, "info", `Comment added${r.url ? `: ${r.url}` : ""}`);
    return c.json({ externalId: r.externalId, url: r.url ?? null }, 201);
  } catch (err) {
    await logPost(c.env, row.id, "warn", `Comment failed: ${errorMessage(err)}`);
    return c.json({ error: errorMessage(err) }, err instanceof ProviderError && err.kind === "auth" ? 409 : 502);
  }
});

/**
 * A needs_check post (the platform may or may not have it): the user checked the profile.
 * published: true marks it published (with the URL of the live post, if given); false publishes it again now.
 */
postRoutes.post("/posts/:id/resolve", requirePermission("posts.write"), async (c) => {
  const row = await findPost(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "needs_check") return c.json({ error: "Only posts that need a check can be resolved" }, 409);
  const body = await c.req.json<ResolvePostInput>().catch(() => null);
  if (!body || typeof body.published !== "boolean") return c.json({ error: "published (boolean) is required" }, 400);
  const revision = row.revision + 1;
  const t = now();
  if (body.published) {
    let url: string | null = null;
    if (body.url) {
      try {
        const u = new URL(String(body.url));
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
        url = u.toString();
      } catch {
        return c.json({ error: "Invalid url" }, 400);
      }
    }
    // Guarded on the revision we read; the bump makes any instance still holding this post stale.
    const res = await c.env.DB.prepare(
      `UPDATE posts SET status = 'published', external_url = COALESCE(?, external_url), error = NULL, published_at = ?, revision = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND revision = ? AND status = 'needs_check'`,
    )
      .bind(url, t, revision, t, row.id, wsId(c), row.revision)
      .run();
    if (!res.meta.changes) return c.json({ error: "The post changed meanwhile, reload and try again" }, 409);
    await logPost(c.env, row.id, "info", `Marked as published by ${c.var.user.name ?? "a user"}${url ? `: ${url}` : ""}`);
  } else {
    await assertNotLocked(c);
    const res = await c.env.DB.prepare(
      "UPDATE posts SET status = 'scheduled', scheduled_at = ?, error = NULL, revision = ?, workflow_id = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND revision = ? AND status = 'needs_check'",
    )
      .bind(t, revision, t, row.id, wsId(c), row.revision)
      .run();
    if (!res.meta.changes) return c.json({ error: "The post changed meanwhile, reload and try again" }, 409);
    const message = `Retry requested by ${c.var.user.name ?? "a user"} after a check (the platform may now have it twice)`;
    if (isDemo(c)) {
      await logPost(c.env, row.id, "info", message);
      await demoPublish(c, [row.id]);
    } else {
      await startWorkflow(c.env, { id: row.id, revision, workflow_id: null });
      await logPost(c.env, row.id, "info", message);
    }
  }
  return c.json(postDto((await findPost(c.env, wsId(c), row.id))!));
});

postRoutes.post("/posts/:id/cancel", requirePermission("posts.write"), async (c) => {
  const row = await findPost(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "scheduled") return c.json({ error: "Only scheduled posts can be cancelled" }, 409);
  // Only cancel if the workflow has not claimed it yet; then stop the workflow (its claim fails on the new revision).
  const res = await c.env.DB.prepare(
    "UPDATE posts SET status = 'cancelled', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'scheduled'",
  )
    .bind(now(), row.id, row.revision)
    .run();
  if (!res.meta.changes) return c.json({ error: "The post is already being published" }, 409);
  if (row.workflow_id) await terminateWorkflow(c.env, row.workflow_id);
  await logPost(c.env, row.id, "info", "Cancelled");
  return c.json(postDto((await findPost(c.env, wsId(c), row.id))!));
});

postRoutes.delete("/posts/:id", requirePermission("posts.write"), async (c) => {
  const row = await findPost(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status === "publishing") return c.json({ error: "The post is being published right now" }, 409);
  // Guarded so a post claimed by its workflow since we read it is not deleted (and its workflow killed) mid-publish.
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM posts WHERE id = ? AND workspace_id = ? AND status != 'publishing'").bind(row.id, wsId(c)),
    c.env.DB.prepare("DELETE FROM post_logs WHERE post_id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE id = ?)").bind(row.id, row.id),
    c.env.DB.prepare("DELETE FROM post_metrics WHERE post_id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE id = ?)").bind(row.id, row.id),
  ]);
  if (!res.meta.changes && (await findPost(c.env, wsId(c), row.id))) return c.json({ error: "The post is being published right now" }, 409);
  if (row.workflow_id && row.status === "scheduled") await terminateWorkflow(c.env, row.workflow_id);
  return c.json({ ok: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of a period from a query parameter (ms), else `fallback`. */
function periodStart(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Dashboard of the web app and home screen of the iOS app: one D1 round trip (batch). `todayStart` / `weekStart` (ms)
 * let the client use its own time zone; defaults are UTC midnight and UTC Monday.
 */
postRoutes.get("/overview", requirePermission("posts.read"), async (c) => {
  const ws = wsId(c);
  if (isDemo(c)) await simulateDueDemoPosts(c.env, ws);
  const t = now();
  const midnight = Math.floor(t / DAY_MS) * DAY_MS;
  const todayStart = periodStart(c.req.query("todayStart"), midnight);
  // 1970-01-01 was a Thursday: (days + 3) % 7 days since Monday.
  const weekStart = periodStart(c.req.query("weekStart"), midnight - ((Math.floor(t / DAY_MS) + 3) % 7) * DAY_MS);
  const db = c.env.DB;
  const [counts, upcoming, recent, failures, accounts, periods] = await db.batch<any>([
    db.prepare("SELECT status, COUNT(*) AS n FROM posts WHERE workspace_id = ? GROUP BY status").bind(ws),
    // Posts being published right now stay listed (first) until they have a result.
    db.prepare("SELECT * FROM posts WHERE workspace_id = ? AND status IN ('publishing', 'scheduled') ORDER BY status = 'publishing' DESC, scheduled_at LIMIT 10").bind(ws),
    db.prepare("SELECT * FROM posts WHERE workspace_id = ? AND status IN ('published', 'failed', 'needs_check') ORDER BY updated_at DESC LIMIT 10").bind(ws),
    db.prepare("SELECT * FROM posts WHERE workspace_id = ? AND status IN ('failed', 'needs_check') ORDER BY updated_at DESC LIMIT 5").bind(ws),
    db.prepare("SELECT COUNT(*) AS total, SUM(status = 'reconnect') AS reconnect FROM accounts WHERE workspace_id = ?").bind(ws),
    // A post's time: when it was published, else when it is (or was) scheduled, else (drafts) when it was created.
    db
      .prepare(
        `SELECT status, SUM(at >= ?1 AND at < ?2) AS today, SUM(at >= ?3 AND at < ?4) AS week FROM (
           SELECT status, CASE WHEN status = 'published' THEN COALESCE(published_at, updated_at) ELSE COALESCE(scheduled_at, created_at) END AS at
           FROM posts WHERE workspace_id = ?5
         ) WHERE (at >= ?1 AND at < ?2) OR (at >= ?3 AND at < ?4) GROUP BY status`,
      )
      .bind(todayStart, todayStart + DAY_MS, weekStart, weekStart + 7 * DAY_MS, ws),
  ]);
  const by = (key: "today" | "week") =>
    Object.fromEntries((periods.results as Array<{ status: string; today: number; week: number }>).filter((r) => r[key] > 0).map((r) => [r.status, r[key]]));
  const acc = accounts.results[0] as { total: number; reconnect: number | null } | undefined;
  const out: OverviewDTO = {
    counts: Object.fromEntries((counts.results as Array<{ status: string; n: number }>).map((r) => [r.status, r.n])),
    periods: { today: by("today"), week: by("week"), todayStart, weekStart },
    upcoming: (upcoming.results as PostRow[]).map(postDto),
    recent: (recent.results as PostRow[]).map(postDto),
    failures: (failures.results as PostRow[]).map(postDto),
    accounts: { total: acc?.total ?? 0, reconnect: acc?.reconnect ?? 0 },
  };
  return c.json(out);
});
