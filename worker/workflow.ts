import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { freshAccount, getAccountRow, markReconnect, providerContext } from "./lib/accounts";
import { BILLING_COLUMNS, entitlements, LOCKED_MESSAGE, snapshotFromRow, type BillingColumnsRow } from "./billing/entitlements";
import { isDemoPost, publishDemoPosts } from "./lib/demo";
import { loadMediaItems } from "./lib/media";
import { nextCheckpoint } from "./lib/metrics";
import { ensureSchema } from "./lib/migrate";
import { getPostRow, logPost, logStatement, type PostRow } from "./lib/posts";
import { postAlert, postPushJob, postPushStatement, pushAlert, type PostPushJob, type PostPushKind } from "./lib/push";
import { baseUrl } from "./lib/settings";
import { addUsage, hasUrl, newMeter, publishEventStatement, replyEventStatement, type AttemptUsage, type PublishMeter } from "./lib/usage";
import { errorMessage, now, parseJson } from "./lib/util";
import { ProviderError } from "./providers/errors";
import { getProvider } from "./providers/registry";
import type { CommitState, PublishPost, PublishResult } from "./providers/types";
import type { ThreadItem } from "../shared/types";

export interface PublishParams {
  postId: string;
  revision: number;
}

type Done = { externalId: string; url: string | null; data: Record<string, unknown> };

/**
 * Result of a commit step. Commit steps never throw (a thrown step error is not retried either, see `commitStep`):
 * - retry: nothing reached the platform (or it refused with 429), safe to run again after a pause;
 * - fail: a definite refusal (invalid post, auth) or retries exhausted;
 * - check: the platform may have the post (ambiguous failure of the create call, or a failure after it): needs_check;
 * - stale: the post was edited, resolved or deleted meanwhile: this instance stops without touching it.
 */
export type Outcome<T> = ({ ok: true; value: T } | { ok: false; action: "retry" | "fail" | "check" | "stale"; message: string }) & {
  /** What the call used (usage_events); absent in results cached by older versions. */
  usage?: AttemptUsage;
};

const MAX_STATUS_CHECKS = 120;
/** Safe retries of a commit step (pre-send failures, rate limits): 30 s, 60 s, 120 s apart. */
const MAX_RETRIES = 3;
const NEVER_RETRY = { limit: 0, delay: "1 second" } as const;

/**
 * `posts.publish_lock` (migrations/0006): `r<revision>:<step name>` of the last commit step that started, or
 * `r<revision>:free` right after the claim. A commit step may start unless the lock already names that very step:
 * then a previous run of it was interrupted (crash, engine replay) after possibly reaching the platform.
 */
export const lockFree = (revision: number) => `r${revision}:free`;
const lockFor = (revision: number, step: string) => `r${revision}:${step}`;

/**
 * Cached results of steps run by the code before commit steps returned `Outcome` (instances that were sleeping or
 * processing when it was deployed) are plain PublishResult / Done values: a completed call.
 */
function normalize<T>(v: unknown): Outcome<T> {
  if (v && typeof v === "object" && "ok" in v && typeof (v as { ok: unknown }).ok === "boolean") return v as Outcome<T>;
  return { ok: true, value: v as T };
}

/**
 * One query for the "sandbox check" step: is the post in a demo workspace, and is its workspace locked (hosted mode:
 * billing on, not exempt, no active plan and no free plan)? Already scheduled posts are not held to the plan's limits.
 */
export async function publishGate(db: D1Database, postId: string): Promise<{ demo: boolean; locked: boolean }> {
  const row = await db
    .prepare(
      `SELECT w.is_demo, ${BILLING_COLUMNS} FROM posts p LEFT JOIN accounts a ON a.id = p.account_id
       JOIN workspaces w ON w.id = p.workspace_id OR w.id = a.workspace_id WHERE p.id = ? ORDER BY w.is_demo DESC LIMIT 1`,
    )
    .bind(postId)
    .first<BillingColumnsRow>();
  if (!row) return { demo: false, locked: false };
  return { demo: !!row.is_demo, locked: entitlements(snapshotFromRow(row)).state === "locked" };
}

export const needsCheckMessage = (platform: string, detail?: string) =>
  `We couldn't confirm whether ${platform} accepted the post. Check your profile, then mark it as published or retry.${detail ? ` (${detail})` : ""}`;

export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishParams> {
  async run(event: WorkflowEvent<PublishParams>, rawStep: WorkflowStep) {
    const { postId, revision } = event.payload;
    // Usage of this instance (usage_events): steps run so far (replayed ones included, so the count is the instance's
    // total whenever it is read) and the provider fetches of its commit steps.
    const meter = newMeter();
    const step = countSteps(rawStep, meter);
    await ensureSchema(this.env.DB);
    // Step names below ("load", "wait for schedule", "claim", "sandbox check", "publish", "processing N",
    // "check status N", "mark published", "load thread", "reply N") are those of the previous version: instances that
    // were sleeping or processing at deploy time replay their completed steps by name. Do not rename them.

    const scheduledAt = await step.do("load", async () => {
      const row = await getPostRow(this.env, postId);
      if (!row || row.revision !== revision || row.status !== "scheduled") return null;
      return row.scheduled_at ?? now();
    });
    if (scheduledAt === null) return { skipped: true };

    if (scheduledAt > Date.now()) await step.sleepUntil("wait for schedule", new Date(scheduledAt));

    const claimed = await step.do("claim", async () => {
      const res = await this.env.DB.prepare(
        "UPDATE posts SET status = 'publishing', attempts = attempts + 1, error = NULL, publish_lock = ?, updated_at = ? WHERE id = ? AND revision = ? AND status = 'scheduled'",
      )
        .bind(lockFree(revision), now(), postId, revision)
        .run();
      if (res.meta.changes > 0) return true;
      // Step retried after its UPDATE already committed: only this instance can claim this revision.
      const row = await getPostRow(this.env, postId);
      return !!row && row.revision === revision && row.status === "publishing";
    });
    if (!claimed) return { skipped: true };

    // Demo workspace (sandboxed): simulate, never call the platform. Demo posts normally get no workflow at all.
    // Same query: hosted mode's locked state (no active plan) fails the post instead of publishing it. Instances that
    // ran this step before returned a plain boolean (demo).
    const gate = await step.do("sandbox check", async () => publishGate(this.env.DB, postId));
    const demo = typeof gate === "boolean" ? gate : gate.demo;
    if (typeof gate !== "boolean" && gate.locked && !demo) {
      const push = await step.do("mark locked", async () => {
        const db = this.env.DB;
        const t = now();
        const notify = postPushStatement(this.env, db, postId, revision, "failed", t);
        const res = await db.batch([
          db
            .prepare("UPDATE posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND revision = ? AND status = 'publishing'")
            .bind(LOCKED_MESSAGE, t, postId, revision),
          guardedLog(db, postId, revision, "failed", t, "error", `Publishing failed: ${LOCKED_MESSAGE}`),
          publishEventStatement(db, { postId, revision, status: "failed", t, meter, message: LOCKED_MESSAGE }),
          ...(notify ? [notify] : []),
        ]);
        return pushJobOf("failed", postId, notify ? res[3] : undefined);
      });
      await this.notify(step, push);
      return { failed: true };
    }
    if (demo) {
      await step.sleep("simulated publish", "2 seconds");
      await step.do("simulate publish", async () => {
        await publishDemoPosts(this.env, [postId]);
      });
      return { published: true, simulated: true };
    }

    // Publish, then poll while the platform processes. Every provider call is a commit step (never auto-retried).
    let outcome = await this.commitStep<PublishResult>(step, meter, "publish", "15 minutes", revision, postId, "publishing", false, (ctx) =>
      ctx.provider.publish(ctx.pctx, ctx.account, ctx.post),
    );
    for (let i = 0; outcome.ok && outcome.value.status === "pending"; i++) {
      const pending = outcome.value;
      if (i >= MAX_STATUS_CHECKS) {
        outcome = { ok: false, action: "fail", message: "The platform did not finish processing the post in time" };
        break;
      }
      await step.sleep(`processing ${i + 1}`, `${Math.min(Math.max(pending.retryAfterSeconds ?? 10, 5), 600)} seconds`);
      outcome = await this.commitStep<PublishResult>(step, meter, `check status ${i + 1}`, "5 minutes", revision, postId, "publishing", true, (ctx) => {
        if (!ctx.provider.checkStatus) throw new ProviderError("Provider returned pending without checkStatus", "invalid");
        return ctx.provider.checkStatus(ctx.pctx, ctx.account, pending.state);
      });
    }

    if (!outcome.ok) {
      const failure = outcome;
      if (failure.action === "stale") return { skipped: true };
      const check = failure.action === "check";
      const push = await step.do(check ? "mark needs check" : "mark failed", async () => {
        const db = this.env.DB;
        const status = check ? "needs_check" : "failed";
        const t = now();
        // Push targets (iOS app) only when APNs is configured: a SELECT guarded like the log, in the same batch.
        const notify = postPushStatement(this.env, db, postId, revision, status, t);
        // One batch: the guarded update, then its log and usage event, both only if this very update happened.
        const res = await db.batch([
          db
            .prepare("UPDATE posts SET status = ?, error = ?, updated_at = ? WHERE id = ? AND revision = ? AND status = 'publishing'")
            .bind(status, failure.message.slice(0, 2000), t, postId, revision),
          guardedLog(db, postId, revision, status, t, check ? "warn" : "error", check ? failure.message : `Publishing failed: ${failure.message}`),
          publishEventStatement(db, { postId, revision, status, t, meter, message: failure.message }),
          ...(notify ? [notify] : []),
        ]);
        return pushJobOf(status, postId, notify ? res[3] : undefined);
      });
      await this.notify(step, push);
      return check ? { needsCheck: true } : { failed: true };
    }
    const result = outcome.value as Extract<PublishResult, { status: "published" }>;
    const root: Done = { externalId: result.externalId, url: result.url ?? null, data: result.data ?? {} };

    const markResult = await step.do("mark published", async () => {
      const db = this.env.DB;
      const t = now();
      const notify = postPushStatement(this.env, db, postId, revision, "published", t);
      // Guarded: an instance whose post was resolved, edited or retried meanwhile must not overwrite it. The log, the
      // usage event and the push targets join the same batch, guarded on this update (one round trip).
      const [res, , , targets] = await db.batch([
        db
          .prepare(
            // Analytics start an hour after publishing (lib/metrics.ts); `external_data` is passed to postMetrics.
            "UPDATE posts SET status = 'published', external_id = ?, external_url = ?, external_data = ?, published_at = ?, updated_at = ?, metrics_next_at = ?, metrics_fails = 0 WHERE id = ? AND revision = ? AND status = 'publishing'",
          )
          .bind(root.externalId, root.url, Object.keys(root.data).length ? JSON.stringify(root.data) : null, t, t, nextCheckpoint(t, t), postId, revision),
        guardedLog(db, postId, revision, "published", t, "info", `Published${root.url ? `: ${root.url}` : ` (id ${root.externalId})`}`),
        // +1: the "load thread" step that always follows (follow-ups record their own steps; "notify" is not counted).
        publishEventStatement(db, { postId, revision, status: "published", t, meter: { ...meter, steps: meter.steps + 1 } }),
        ...(notify ? [notify] : []),
      ]);
      return { marked: res.meta.changes > 0, push: pushJobOf("published", postId, targets) };
    });
    // Older instances returned a boolean (or nothing: they marked it unconditionally).
    const marked = markResult && typeof markResult === "object" ? markResult.marked : markResult;
    if (marked === false) return { skipped: true };
    await this.notify(step, markResult && typeof markResult === "object" ? markResult.push : null);

    const thread = await step.do("load thread", async () => {
      const row = await getPostRow(this.env, postId);
      return parseJson<ThreadItem[]>(row?.thread, []).filter((t) => t.content.trim() || t.media.length);
    });
    let parent = root;
    for (let i = 0; i < thread.length; i++) {
      const reply = await this.commitStep<Done>(step, meter, `reply ${i + 1}`, "10 minutes", revision, postId, "published", true, async (ctx) => {
        if (!ctx.provider.reply) throw new ProviderError(`${ctx.provider.name} does not support follow-ups`, "invalid");
        const item: PublishPost = {
          id: `${postId}-r${i + 1}`,
          content: thread[i].content,
          media: await loadMediaItems(this.env, ctx.pctx.baseUrl, thread[i].media),
          settings: ctx.post.settings,
          scheduledAt: ctx.post.scheduledAt,
          createdAt: ctx.post.createdAt,
        };
        const r = await ctx.provider.reply(
          ctx.pctx,
          ctx.account,
          { rootId: root.externalId, parentId: parent.externalId, rootData: root.data, parentData: parent.data },
          item,
        );
        // Its post log and usage event: one batch, the round trip the usage event alone used to take. Best effort
        // (never turns a published follow-up into a failure).
        const db = this.env.DB;
        const label = followUpLabel(ctx.provider.capabilities.threadLabel, i);
        await db
          .batch([
            logStatement(db, postId, "info", followUpLog(label, r)),
            replyEventStatement(db, {
              postId,
              outcome: "published",
              media: thread[i].media,
              hasUrl: hasUrl(thread[i].content),
              fetches: ctx.usage.fetches,
              imagesTx: ctx.usage.imagesTx,
              t: now(),
            }),
          ])
          .catch(() => {});
        return { externalId: r.externalId, url: r.url ?? null, data: r.data ?? {} };
      });
      if (reply.ok) {
        parent = reply.value;
        continue;
      }
      if (reply.action === "stale") break;
      // The root stays published; the thread stops here (a later reply would answer the wrong parent).
      const failure = reply;
      await step.do(`reply ${i + 1} failed`, async () => {
        const message = failure.action === "check" ? `Follow-up ${i + 1}: ${failure.message}` : `Follow-up ${i + 1} failed: ${failure.message}`;
        const db = this.env.DB;
        const t = now();
        await db.batch([
          db.prepare("UPDATE posts SET error = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(message.slice(0, 2000), t, postId, revision),
          logStatement(db, postId, "warn", message),
          replyEventStatement(db, {
            postId,
            outcome: failure.action === "check" ? "needs_check" : "failed",
            media: thread[i].media,
            hasUrl: hasUrl(thread[i].content),
            fetches: failure.usage?.fetches ?? null,
            imagesTx: failure.usage?.imagesTx ?? 0,
            message,
            t,
          }),
        ]);
      });
      break;
    }
    return { published: true, externalId: root.externalId };
  }

  /**
   * Push notification of a publish result to the iOS app (worker/lib/push.ts), its own step so a slow or failing APNs
   * never touches the post: only when the mark step found devices to notify, never retried (no duplicate alerts).
   */
  private async notify(step: WorkflowStep, job: PostPushJob | null | undefined) {
    if (!job || !Array.isArray(job.devices) || !job.devices.length) return;
    await step
      .do("notify", { retries: NEVER_RETRY, timeout: "1 minute" }, async () => pushAlert(this.env, this.env.DB, job.devices, postAlert(job, getProvider(job.provider)?.name ?? job.provider)))
      .catch((err) => console.error("push notification step failed", err));
  }

  /**
   * One provider call that may create the post. The step is never retried by the engine: a retry after the request
   * reached the platform would publish twice. `attempt` classifies the failure; only failures that certainly created
   * nothing are retried, each in its own step (`<name> (retry N)`) after a pause.
   */
  private async commitStep<T>(
    step: WorkflowStep,
    meter: PublishMeter,
    name: string,
    timeout: WorkflowStepConfig["timeout"],
    revision: number,
    postId: string,
    expect: PostRow["status"],
    allowLegacyLock: boolean,
    fn: AttemptFn<T>,
  ): Promise<Outcome<T>> {
    let out: Outcome<T>;
    for (let attempt = 0; ; attempt++) {
      const stepName = attempt === 0 ? name : `${name} (retry ${attempt})`;
      try {
        // step.do's Serializable<T> typing rejects Record<string, unknown>; our values are plain JSON.
        const raw = await step.do(stepName, { retries: NEVER_RETRY, timeout }, (() =>
          this.attempt(postId, revision, stepName, expect, allowLegacyLock, fn)) as () => Promise<any>);
        out = normalize<T>(raw);
        addUsage(meter, out.usage);
      } catch (err) {
        // Timeout or an engine failure inside the step: the call may have reached the platform.
        out = { ok: false, action: "check", message: needsCheckMessage("the platform", errorMessage(err)) };
      }
      if (out.ok || out.action !== "retry") return out;
      if (attempt >= MAX_RETRIES) return { ok: false, action: "fail", message: out.message };
      await step.sleep(`${name} (backoff ${attempt + 1})`, `${30 * 2 ** attempt} seconds`);
    }
  }

  /**
   * Load everything a provider call needs, take the post's publish lock, run the call and classify its outcome.
   * Never throws.
   */
  private async attempt<T>(
    postId: string,
    revision: number,
    stepName: string,
    expect: PostRow["status"],
    allowLegacyLock: boolean,
    fn: AttemptFn<T>,
  ): Promise<Outcome<T>> {
    const commit: CommitState = { sent: false, accepted: false };
    const usage: AttemptUsage = { fetches: 0, imagesTx: 0, hasUrl: null };
    const out = await this.attemptInner(postId, revision, stepName, expect, allowLegacyLock, fn, commit, usage);
    return { ...out, usage };
  }

  private async attemptInner<T>(
    postId: string,
    revision: number,
    stepName: string,
    expect: PostRow["status"],
    allowLegacyLock: boolean,
    fn: AttemptFn<T>,
    commit: CommitState,
    usage: AttemptUsage,
  ): Promise<Outcome<T>> {
    const env = this.env;
    const db = env.DB;
    let platform = "the platform";
    let accountId: string | null = null;
    try {
      const row = await getPostRow(env, postId);
      // Guard: only the instance of the current revision calls the platform, and only while the post is in the state
      // this step expects (publishing, or published for follow-ups).
      if (!row || row.revision !== revision || row.status !== expect) {
        return { ok: false, action: "stale", message: row ? "The post changed while publishing" : "Post was deleted" };
      }
      const accountRow = await getAccountRow(env, row.account_id);
      if (!accountRow) return { ok: false, action: "fail", message: "Account was removed" };
      accountId = accountRow.id;
      if (await isDemoPost(db, postId)) return { ok: false, action: "fail", message: "Demo workspace: publishing is simulated, nothing is sent to the platform" };
      if (accountRow.status === "disabled") return { ok: false, action: "fail", message: "Account is disabled" };
      const provider = getProvider(accountRow.provider);
      if (!provider) return { ok: false, action: "fail", message: `Unknown provider ${accountRow.provider}` };
      platform = provider.name;

      // Take the lock. Steps run in order and a completed step never runs again, so the only way to find this step's
      // own name in the lock is a re-run after an interruption: that run may have reached the platform.
      const lock = await db
        .prepare(
          `UPDATE posts SET publish_lock = ? WHERE id = ? AND revision = ? AND status = ?
             AND ((publish_lock LIKE ? AND publish_lock != ?)${allowLegacyLock ? " OR publish_lock IS NULL" : ""})`,
        )
        .bind(lockFor(revision, stepName), postId, revision, expect, `r${revision}:%`, lockFor(revision, stepName))
        .run();
      if (!lock.meta.changes) {
        const current = await getPostRow(env, postId);
        if (!current || current.revision !== revision || current.status !== expect) return { ok: false, action: "stale", message: "The post changed while publishing" };
        // Lock NULL: claimed by the previous version of this workflow, which may have been publishing at deploy time.
        return {
          ok: false,
          action: "check",
          message: needsCheckMessage(platform, current.publish_lock ? "an earlier attempt was interrupted" : "publishing was interrupted by an update"),
        };
      }

      const pctx = await providerContext(env, provider, {
        log: (level, message) => void logPost(env, postId, level, message).catch(() => {}),
      });
      // Count provider fetches (token refresh included) and Images transformations for usage_events.
      const baseFetch = pctx.fetch;
      pctx.fetch = (input, init) => {
        usage.fetches++;
        return baseFetch(input, init);
      };
      const baseMedia = pctx.media;
      pctx.media = {
        ...baseMedia,
        image: (item, opts) => {
          usage.imagesTx++;
          return baseMedia.image(item, opts);
        },
      };
      if (expect === "publishing") usage.hasUrl = hasUrl(row.content);
      const account = await freshAccount(env, provider, pctx, accountRow);
      const post: PublishPost = {
        id: row.id,
        content: row.content,
        media: await loadMediaItems(env, await baseUrl(env), parseJson<string[]>(row.media, [])),
        settings: parseJson(row.settings, {}),
        scheduledAt: row.scheduled_at ?? row.created_at,
        createdAt: row.created_at,
      };
      pctx.commit = commit;
      return { ok: true, value: await fn({ provider, pctx, account, post, row, usage }) };
    } catch (err) {
      const out = classify(err, commit, platform);
      const message = errorMessage(err);
      await logPost(env, postId, out.action === "retry" ? "warn" : "error", message).catch(() => {});
      if (err instanceof ProviderError && err.kind === "auth" && out.action === "fail" && accountId) {
        await markReconnect(env, accountId, message).catch(() => {});
      }
      return out;
    }
  }
}

type AttemptFn<T> = (c: {
  provider: NonNullable<ReturnType<typeof getProvider>>;
  pctx: Awaited<ReturnType<typeof providerContext>>;
  account: Awaited<ReturnType<typeof freshAccount>>;
  post: PublishPost;
  row: PostRow;
  usage: AttemptUsage;
}) => Promise<T>;

/** The push job of a mark step's batch result (the rows of `postPushStatement`), as a plain JSON step value. */
function pushJobOf(kind: PostPushKind, postId: string, result: D1Result | undefined): PostPushJob | null {
  return postPushJob(kind, postId, result?.results as Parameters<typeof postPushJob>[2]);
}

/** "First comment" (comment-style platforms), else "Follow-up N", as in the post's log. */
export function followUpLabel(threadLabel: string | undefined, index: number): string {
  if (/comment/i.test(threadLabel ?? "")) return index === 0 ? "First comment" : `Comment ${index + 1}`;
  return `Follow-up ${index + 1}`;
}

/**
 * Log line of a published follow-up: its own link when the platform has one ("First comment posted: <url>"), else the
 * post it is on with its id ("First comment posted on <post url> (comment id …)"), else only the id.
 */
export function followUpLog(label: string, r: { externalId: string; url?: string | null; urlIsPost?: boolean }): string {
  if (r.url && r.urlIsPost) return `${label} posted on ${r.url} (${/comment/i.test(label) ? "comment " : ""}id ${r.externalId})`;
  return `${label} posted${r.url ? `: ${r.url}` : ` (id ${r.externalId})`}`;
}

/** INSERT of a post log that only happens when the post is at `revision` in `status` with `updated_at = t`. */
function guardedLog(db: D1Database, postId: string, revision: number, status: PostRow["status"], t: number, level: "info" | "warn" | "error", message: string) {
  return db
    .prepare(
      "INSERT INTO post_logs (post_id, level, message, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM posts WHERE id = ? AND revision = ? AND status = ? AND updated_at = ?)",
    )
    .bind(postId, level, message.slice(0, 2000), t, postId, revision, status, t);
}

/** `step` that counts its `do` calls into `meter.steps` (sleeps are not counted: not billed as steps). */
function countSteps(step: WorkflowStep, meter: PublishMeter): WorkflowStep {
  return {
    do: ((...args: unknown[]) => {
      meter.steps++;
      return (step.do as (...a: unknown[]) => unknown)(...args);
    }) as WorkflowStep["do"],
    sleep: (...args: Parameters<WorkflowStep["sleep"]>) => step.sleep(...args),
    sleepUntil: (...args: Parameters<WorkflowStep["sleepUntil"]>) => step.sleepUntil(...args),
    waitForEvent: ((...args: unknown[]) => (step as any).waitForEvent(...args)) as WorkflowStep["waitForEvent"],
  } as WorkflowStep;
}

/** Failure of a commit step → what to do next (see Outcome). */
export function classify(err: unknown, commit: CommitState, platform: string): Outcome<never> & { ok: false } {
  const message = errorMessage(err);
  // The platform accepted the post, something after that failed: it is live (or partly), never publish again.
  if (commit.accepted) return { ok: false, action: "check", message: needsCheckMessage(platform, message) };
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case "ambiguous":
        return { ok: false, action: "check", message: needsCheckMessage(platform, message) };
      case "auth":
        return { ok: false, action: "fail", message: `Account needs to be reconnected: ${message}` };
      case "invalid":
        return { ok: false, action: "fail", message };
      case "rate_limit":
        // A refusal: nothing was created.
        return { ok: false, action: "retry", message };
      case "transient":
        return commit.sent ? { ok: false, action: "check", message: needsCheckMessage(platform, message) } : { ok: false, action: "retry", message };
    }
  }
  // Unknown exception (a bug, an unexpected response shape...): harmless before the create call, ambiguous after.
  return commit.sent ? { ok: false, action: "check", message: needsCheckMessage(platform, message) } : { ok: false, action: "retry", message };
}
