import { existsSync, readFileSync, statSync } from "node:fs";
import { list, str, type Parsed } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { parseFuture, parseTime } from "../dates.js";
import { CliError, UsageError } from "../errors.js";
import { c, eprintln, fmtDate, fmtNum, fmtPct, fmtStatus, fmtWhen, println, printJson, table, truncate } from "../format.js";
import { readStdin } from "../io.js";
import { accountLabel, buildSettings, missingSettings, type Target } from "../resolve.js";
import {
  BIO_LINK_PLATFORMS,
  exposure,
  type AccountDTO,
  type AppDTO,
  type CampaignLinkDTO,
  type CreatePostsInput,
  type PostDTO,
  type PostMetricsDTO,
  type ResolvePostInput,
  type ThreadItem,
} from "../types.js";
import { APP_OPTION, AUTOLINK_OPTIONS, appsOf, campaignNote, campaignResultsLine, readAutoLink, resolveApp } from "./apps.js";
import { uploadAll } from "./media.js";
import { parsePlaybookRef } from "./playbooks.js";

// ---------------------------------------------------------------------------------------------------------------
// Shared option handling

const TEXT_OPTIONS = {
  text: { type: "string", short: "t", arg: "<text>", description: "Post text (\"-\" reads stdin)" },
  "text-file": { type: "string", arg: "<path>", description: "Read the post text from a file (\"-\" = stdin)" },
} as const;

const PLAYBOOK_OPTIONS = {
  playbook: { type: "string", arg: "<id[@version]>", description: "Playbook the post was written with (postflare playbooks), e.g. text-thread@1" },
  variant: { type: "string", arg: "<label>", description: "A/B variant label, e.g. A or B (compared in postflare playbooks stats)" },
} as const;

/** --playbook / --variant → body fields (none when not given). */
function readPlaybook(values: Parsed["values"]): Pick<CreatePostsInput, "playbookId" | "playbookVersion" | "variant"> {
  const out: Pick<CreatePostsInput, "playbookId" | "playbookVersion" | "variant"> = {};
  const ref = str(values.playbook);
  if (ref) {
    const r = parsePlaybookRef(ref);
    out.playbookId = r.id;
    if (r.version !== undefined) out.playbookVersion = r.version;
  }
  const variant = str(values.variant);
  if (variant !== undefined) out.variant = variant;
  return out;
}

const WHEN_OPTIONS = {
  at: { type: "string", arg: "<when>", description: "Schedule: \"2026-10-14 09:00\", \"tomorrow 9:00\", \"mon 18:00\", \"in 2h\", ISO (local time)" },
  now: { type: "boolean", description: "Publish immediately" },
  draft: { type: "boolean", description: "Save as a draft (not scheduled)" },
} as const;

/** Text from --text / --text-file / piped stdin; undefined when none was given. */
async function readText(ctx: Ctx, values: Parsed["values"], implicitStdin: boolean): Promise<string | undefined> {
  const read = ctx.deps.readStdin ?? readStdin;
  const text = str(values.text);
  const file = str(values["text-file"]);
  if (text !== undefined && file !== undefined) throw new UsageError("Use either --text or --text-file");
  if (text === "-" || file === "-") return ((await read(false)) ?? "").replace(/\n$/, "");
  if (text !== undefined) return text;
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8").replace(/\n$/, "");
    } catch {
      throw new UsageError(`Cannot read ${file}`);
    }
  }
  if (!implicitStdin) return undefined;
  const piped = await read(true);
  return piped === null ? undefined : piped.replace(/\n$/, "");
}

/** --at / --now / --draft → scheduledAt (undefined when none given). */
function readWhen(ctx: Ctx, values: Parsed["values"]): CreatePostsInput["scheduledAt"] | undefined {
  const at = str(values.at);
  const n = [at !== undefined, !!values.now, !!values.draft].filter(Boolean).length;
  if (n > 1) throw new UsageError("Use only one of --at, --now and --draft");
  if (values.now) return "now";
  if (values.draft) return null;
  if (at !== undefined) return parseFuture(at, { now: ctx.now });
  return undefined;
}

/** --media values: media ids as is, local paths uploaded first. */
async function resolveMedia(ctx: Ctx, items: string[], alt?: string): Promise<string[]> {
  const ids: string[] = [];
  for (const item of items.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean)) {
    if (existsSync(item) && statSync(item).isFile()) ids.push((await uploadAll(ctx, [item], alt))[0].id);
    else if (/^med_[\w-]+$/.test(item)) ids.push(item);
    else throw new UsageError(`--media ${item}: not a file or a media id (med_...)`);
  }
  return ids;
}

async function targetsFor(ctx: Ctx, accounts: AccountDTO[]): Promise<Target[]> {
  return Promise.all(accounts.map(async (account) => ({ account, provider: await ctx.provider(account.provider) })));
}

function whenLabel(p: PostDTO): string {
  if (p.status === "published") return fmtWhen(p.publishedAt);
  if (p.status === "draft") return c.gray("draft");
  return fmtWhen(p.scheduledAt);
}

function postsTable(posts: PostDTO[], accounts: AccountDTO[]): string {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return table(
    [{ header: "ID" }, { header: "STATUS" }, { header: "WHEN" }, { header: "ACCOUNT" }, { header: "TEXT", flex: true }],
    posts.map((p) => {
      const a = byId.get(p.accountId);
      return [p.id, fmtStatus(p.status), whenLabel(p), a ? `${a.provider} ${a.username ? `@${a.username.replace(/^@/, "")}` : a.name}` : p.accountId, truncate(p.content || (p.media.length ? `[${p.media.length} media]` : ""), 60)];
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// post

export const post: Command = {
  name: "post",
  summary: "Create a post on one or more accounts: schedule it, publish it now, or save a draft.",
  description: [
    "Accounts (--account, repeatable or comma separated): an account id, @username, a platform id when you have one",
    "account there (e.g. bluesky), an account name, platform:@username, or group:<name> (every enabled account of an",
    "account group, see postflare groups).",
    "Text: --text, --text-file, or piped on stdin. Media: ids (med_...) or local files (uploaded first).",
    "Settings: --set key=value applies to every selected platform that has the setting; --set <platform>.key=value or",
    "--set <accountId>.key=value targets one. Defaults of each platform's settings are filled in like in the app.",
    "List settings with: postflare platforms <id>. Exactly one of --at, --now or --draft is required.",
    "--app tags the post with an App Store app (postflare apps): clickable platforms (X, Threads, Bluesky, LinkedIn...)",
    "get a tracked link (clicks, installs, proceeds per post), inserted in the text when auto-insert is on (workspace",
    "setting, --autolink / --no-autolink). Instagram/TikTok captions aren't clickable: use postflare apps bio-link.",
  ].join("\n"),
  options: {
    account: { type: "string", short: "a", multiple: true, arg: "<selector>", description: "Target account(s)" },
    ...TEXT_OPTIONS,
    media: { type: "string", short: "m", multiple: true, arg: "<id|path>", description: "Attach media (local files are uploaded)" },
    alt: { type: "string", arg: "<text>", description: "Alt text for files uploaded by --media" },
    ...WHEN_OPTIONS,
    set: { type: "string", multiple: true, arg: "<key=value>", description: "Platform setting, e.g. tiktok.privacy_level=SELF_ONLY" },
    thread: { type: "string", multiple: true, arg: "<text>", description: "Follow-up (thread reply / first comment), in order" },
    ...PLAYBOOK_OPTIONS,
    ...APP_OPTION,
    ...AUTOLINK_OPTIONS,
    "dry-run": { type: "boolean", description: "Only validate (files given to --media are still uploaded)" },
  },
  max: 0,
  examples: [
    "postflare post -a bluesky -a x --text \"Shipping v2 today 🚀\" --at \"tomorrow 9:00\"",
    "postflare post -a instagram_standalone -a tiktok -m reel.mp4 --text-file caption.txt --at \"fri 18:00\" \\\n      --set tiktok.privacy_level=PUBLIC_TO_EVERYONE",
    "postflare post -a x --text \"1/ A thread\" --thread \"2/ more\" --thread \"3/ end\" --now",
    "postflare post -a youtube -m video.mp4 --set title=\"Launch\" --set privacy=public --draft",
    "echo \"Hello\" | postflare post -a @me --now --dry-run",
    "postflare post -a x --text-file a.txt --playbook text-thread@1 --variant A --at \"tue 9:00\"",
    "postflare post -a x -a threads --text \"Tempo 2.0 is out\" --app Tempo --at \"tomorrow 9:00\"",
    "postflare post -a \"group:Party Games\" -m clip.mp4 --text \"New level!\" --at \"fri 18:00\"",
  ],
  async run(ctx, { values }) {
    const accounts = await ctx.resolveAccounts(list(values.account));
    const scheduledAt = readWhen(ctx, values);
    if (scheduledAt === undefined) throw new UsageError("Say when: --at <when>, --now or --draft", "post");
    const targets = await targetsFor(ctx, accounts);
    const content = (await readText(ctx, values, true)) ?? "";
    const settings = buildSettings(targets, list(values.set));
    const threadTexts = list(values.thread);
    const thread: ThreadItem[] = threadTexts.map((t) => ({ content: t, media: [] }));
    if (thread.length) {
      const without = targets.filter((t) => !t.provider.capabilities.thread);
      if (without.length === targets.length) throw new UsageError(`${without.map((t) => t.provider.name).join(", ")}: follow-ups (--thread) are not supported`);
      for (const t of without) eprintln(c.yellow(`! ${t.provider.name} does not support follow-ups: --thread is ignored for ${accountLabel(t.account)}`));
    }
    if (scheduledAt !== null) {
      const missing = missingSettings(targets, settings);
      if (missing.length) throw new CliError(`Missing settings:\n  ${missing.join("\n  ")}`);
    }
    const autoLink = readAutoLink(values, "post");
    if (autoLink !== undefined && !str(values.app)) throw new UsageError("--autolink / --no-autolink go with --app", "post");
    const app = str(values.app) ? await resolveApp(ctx, str(values.app)!) : null;
    const media = await resolveMedia(ctx, list(values.media), str(values.alt));
    const body: CreatePostsInput = {
      scheduledAt,
      posts: targets.map((t) => ({
        accountId: t.account.id,
        content,
        media,
        settings: settings.get(t.account.id) ?? {},
        thread: t.provider.capabilities.thread ? thread : [],
      })),
      ...readPlaybook(values),
      ...(app ? { appId: app.id } : {}),
      ...(autoLink !== undefined ? { autoLink } : {}),
    };

    if (values["dry-run"]) {
      const { errors } = await ctx.api.post<{ errors: string[] }>("/posts/validate", body);
      if (ctx.json) printJson({ ok: !errors.length, errors, request: body });
      else if (!errors.length) {
        println(`${c.green("✓")} Valid for ${targets.map((t) => `${t.provider.name} ${accountLabel(t.account)}`).join(", ")}`);
        println(c.gray(`  ${scheduledAt === null ? "draft" : scheduledAt === "now" ? "would publish now" : `would be scheduled for ${fmtDate(scheduledAt)}`}`));
      }
      if (errors.length) {
        if (!ctx.json) throw new CliError(`Validation failed:\n  ${errors.join("\n  ")}`);
        process.exitCode = 1;
      }
      return;
    }

    const created = await ctx.api.post<PostDTO[]>("/posts", body);
    if (ctx.json) return printJson(created);
    const what = scheduledAt === null ? "Saved draft" : scheduledAt === "now" ? "Publishing now" : `Scheduled for ${fmtDate(scheduledAt)}`;
    println(`${c.green("✓")} ${what}: ${created.length} post${created.length > 1 ? "s" : ""}`);
    println(postsTable(created, await ctx.accounts()));
    if (app) await reportLinks(ctx, app, created, targets);
    println(c.gray(`Check: postflare posts show ${created[0].id}`));
  },
};

/** After creating posts with --app: which got a tracked link (inserted or not), and the bio-link hint. */
async function reportLinks(ctx: Ctx, app: AppDTO, created: PostDTO[], targets: Target[]) {
  const ids = new Set(created.map((p) => p.id));
  const found = await ctx.api
    .get<CampaignLinkDTO[]>("/campaigns/links", { appId: app.id, kind: "post", limit: Math.min(created.length + 20, 500) })
    .then((rows) => rows.filter((l) => l.postId && ids.has(l.postId)))
    .catch(() => null);
  const name = (accountId: string) => targets.find((t) => t.account.id === accountId)?.provider.name ?? accountId;
  if (found) {
    const inText = (l: CampaignLinkDTO) => {
      const p = created.find((x) => x.id === l.postId);
      return !!p && JSON.stringify([p.content, p.thread, p.settings]).includes(l.trackedUrl);
    };
    const inserted = found.filter(inText);
    const kept = found.filter((l) => !inText(l));
    if (inserted.length) println(`${c.green("✓")} Tracked link added for ${inserted.map((l) => name(l.accountId!)).join(", ")}`);
    for (const l of kept) println(`${c.green("✓")} Tracked link for ${name(l.accountId!)} (not inserted in the text): ${c.cyan(l.trackedUrl)}`);
    const clickable = targets.filter((t) => !BIO_LINK_PLATFORMS.has(t.provider.id));
    if (clickable.length && !found.length) println(c.yellow("! No tracked link was created: set the Apple provider token in Workspace settings → App Store campaigns"));
  }
  for (const t of targets.filter((t) => BIO_LINK_PLATFORMS.has(t.provider.id))) {
    println(c.gray(`  ${t.provider.name} captions aren't clickable: use the bio link: postflare apps bio-link -a ${t.account.id} --app ${app.id}`));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// posts

export const posts: Command = {
  name: "posts",
  summary: "List posts (newest first). Subcommands: show, edit, cancel, retry, resolve, comment, rm.",
  options: {
    status: { type: "string", arg: "<list>", description: "Comma separated: draft,scheduled,publishing,published,failed,needs_check,cancelled" },
    upcoming: { type: "boolean", description: "Scheduled posts, soonest first" },
    from: { type: "string", arg: "<when>", description: "From (scheduled/created time): \"7d\", \"2026-10-01\", \"yesterday\"..." },
    to: { type: "string", arg: "<when>", description: "Until" },
    account: { type: "string", short: "a", multiple: true, arg: "<selector>", description: "Only these accounts" },
    limit: { type: "string", arg: "<n>", description: "Max posts (default 50)" },
    playbook: { type: "string", arg: "<id>", description: "Only posts written with this playbook (\"none\": without one)" },
  },
  max: 0,
  examples: ["postflare posts --upcoming", "postflare posts --status failed", "postflare posts -a tiktok --from 7d --json"],
  async run(ctx, { values }) {
    const all = await ctx.accounts();
    const selected = list(values.account).length ? await ctx.resolveAccounts(list(values.account)) : null;
    const opt = { now: ctx.now, relativePast: true, defaultClock: [0, 0] as [number, number] };
    const limit = Math.min(Number(str(values.limit)) || 50, 1000);
    let rows = await ctx.api.get<PostDTO[]>("/posts", {
      status: values.upcoming ? "scheduled" : str(values.status),
      from: str(values.from) ? parseTime(str(values.from)!, opt) : values.upcoming ? ctx.now.getTime() - 60 * 60 * 1000 : undefined,
      to: str(values.to) ? parseTime(str(values.to)!, opt) : undefined,
      accountId: selected?.length === 1 ? selected[0].id : undefined,
      order: values.upcoming ? "asc" : "desc",
      limit: selected && selected.length > 1 ? 1000 : limit,
      playbookId: str(values.playbook),
    });
    if (selected) rows = rows.filter((p) => selected.some((a) => a.id === p.accountId)).slice(0, limit);
    if (ctx.json) return printJson(rows);
    if (!rows.length) return println("No posts.");
    println(postsTable(rows, all));
  },
};

/** avgViewPercentage 45.2 → "45.2%", avgViewDurationSeconds 123 → "2:03", counts → fmtNum. */
function fmtMetric(key: string, v: number | undefined): string {
  if (v === undefined) return "-";
  if (key === "avgViewPercentage") return `${+v.toFixed(1)}%`;
  if (key === "avgViewDurationSeconds") {
    const sec = Math.round(v);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }
  return fmtNum(v);
}

export const postsShow: Command = {
  name: "posts show",
  args: "<id>",
  summary: "Show a post with its publishing log and, once published, its metrics.",
  min: 1,
  max: 1,
  async run(ctx, { positionals }) {
    const p = await ctx.api.get<PostDTO>(`/posts/${encodeURIComponent(positionals[0])}`);
    const metrics = p.status === "published" ? await ctx.api.get<PostMetricsDTO>(`/posts/${p.id}/metrics`).catch(() => null) : null;
    if (ctx.json) return printJson({ ...p, metrics });
    const a = (await ctx.accounts().catch(() => [] as AccountDTO[])).find((x) => x.id === p.accountId);
    const app = p.appId ? ((await appsOf(ctx).catch(() => [] as AppDTO[])).find((x) => x.id === p.appId) ?? null) : null;
    println(`${c.bold(p.id)}  ${fmtStatus(p.status)}  ${a ? `${a.provider} ${accountLabel(a)}` : p.accountId}`);
    if (p.status === "published") println(`Published: ${fmtWhen(p.publishedAt)}${p.externalUrl ? `  ${c.cyan(p.externalUrl)}` : ""}`);
    else if (p.scheduledAt) println(`Scheduled: ${fmtWhen(p.scheduledAt)}`);
    if (p.status === "needs_check") {
      println(c.yellow(`Needs check: ${p.error ?? "the platform did not confirm whether it accepted the post."}`));
      println(c.gray(`  Live on the profile? postflare posts resolve ${p.id} --published [--url URL]. Not there? postflare posts resolve ${p.id} --retry`));
    } else if (p.error) println(c.red(`Error: ${p.error}`));
    println(c.gray(`Group ${p.groupId} · created ${fmtDate(p.createdAt)} · attempts ${p.attempts}`));
    if (p.playbookId) println(c.gray(`Playbook ${p.playbookId}${p.playbookVersion ? `@${p.playbookVersion}` : ""}${p.variant ? ` · variant ${p.variant}` : ""}`));
    if (p.appId || p.campaign) {
      const appLabel = app ? `${app.name} (${app.appStoreId})` : (p.appId ?? `App Store id ${p.campaign!.appStoreId}`);
      println(`App: ${appLabel}${p.autoLink === false ? c.gray(" · auto-insert off") : p.autoLink === true ? c.gray(" · auto-insert on") : ""}`);
      if (p.campaign) {
        const results = { ...p.campaign, ...(metrics?.campaign ?? {}) };
        println(`  Tracked link: ${c.cyan(p.campaign.trackedUrl)}  ${c.gray(`ct ${p.campaign.ct}`)}`);
        println(`  ${campaignResultsLine(results)}`);
        println(`  ${campaignNote()}`);
      } else if (a && BIO_LINK_PLATFORMS.has(a.provider)) {
        println(c.gray(`  Captions aren't clickable here: use the bio link: postflare apps bio-link -a ${a.id} --app ${p.appId}`));
      }
    }
    println("");
    println(p.content || c.gray("(no text)"));
    if (p.media.length) println(`\nMedia: ${p.media.join(", ")}`);
    const settings = Object.entries(p.settings).filter(([, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
    if (settings.length) println(`Settings: ${settings.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`).join("  ")}`);
    p.thread.forEach((t, i) => println(`Follow-up ${i + 1}: ${truncate(t.content, 200)}${t.media.length ? ` [${t.media.join(", ")}]` : ""}`));
    if (p.logs?.length) {
      println("\nLog:");
      for (const l of p.logs) println(`  ${c.gray(fmtDate(l.createdAt))}  ${l.level === "error" ? c.red(l.message) : l.level === "warn" ? c.yellow(l.message) : l.message}`);
    }
    if (metrics) {
      println("\nMetrics:");
      if (!metrics.metrics) println(c.gray(`  not collected yet${metrics.metricsNextAt ? ` (next: ${fmtWhen(metrics.metricsNextAt)})` : ""}`));
      else {
        const m = metrics.metrics;
        const { extra, ...rest } = m;
        println("  " + Object.entries(rest).map(([k, v]) => `${k} ${c.bold(fmtMetric(k, v))}`).join("  "));
        const exp = exposure(m);
        const eng = ["likes", "comments", "shares", "saves", "replies", "reposts", "quotes", "clicks"].reduce((n, k) => n + (m[k] ?? 0), 0);
        if (exp) println(`  engagement rate ${c.bold(fmtPct(eng / exp))}`);
        if (extra && Object.keys(extra).length) println(c.gray("  " + Object.entries(extra).map(([k, v]) => `${k} ${fmtNum(v)}`).join("  ")));
        const d = metrics.details;
        if (d?.retention?.length) {
          // Share of viewers still watching at 10%, 25%, 50%, 75% and 100% of the video.
          const at = (x: number) => d.retention!.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best));
          println(`  retention ${[0.1, 0.25, 0.5, 0.75, 1].map((x) => `${Math.round(x * 100)}% ${c.bold(fmtPct(at(x)[1], 0))}`).join("  ")}`);
        }
        if (d?.trafficSources?.length) {
          const total = d.trafficSources.reduce((n, t) => n + t.views, 0) || 1;
          println(`  traffic   ${d.trafficSources.slice(0, 6).map((t) => `${t.source} ${c.bold(fmtNum(t.views))} (${fmtPct(t.views / total, 0)})`).join("  ")}`);
        }
        println(c.gray(`  collected ${fmtDate(metrics.metricsAt)}${metrics.metricsNextAt ? `, next ${fmtDate(metrics.metricsNextAt)}` : ""} · ${metrics.snapshots.length} snapshots`));
      }
    }
  },
};

export const postsEdit: Command = {
  name: "posts edit",
  args: "<id>",
  summary: "Edit a draft, scheduled, failed or cancelled post (text, time, settings, media, follow-ups).",
  description: "Changing the time reschedules; --draft unschedules. --media and --thread replace the current lists; --set merges.",
  options: {
    ...TEXT_OPTIONS,
    ...WHEN_OPTIONS,
    set: { type: "string", multiple: true, arg: "<key=value>", description: "Change a setting" },
    media: { type: "string", short: "m", multiple: true, arg: "<id|path>", description: "Replace the media" },
    "no-media": { type: "boolean", description: "Remove all media" },
    thread: { type: "string", multiple: true, arg: "<text>", description: "Replace the follow-ups" },
    "no-thread": { type: "boolean", description: "Remove the follow-ups" },
    ...PLAYBOOK_OPTIONS,
    "no-playbook": { type: "boolean", description: "Remove the playbook attribution" },
    ...APP_OPTION,
    "no-app": { type: "boolean", description: "Remove the App Store app (and stop using its tracked link)" },
    ...AUTOLINK_OPTIONS,
  },
  min: 1,
  max: 1,
  examples: [
    "postflare posts edit pst_abc --at \"tomorrow 18:00\"",
    "postflare posts edit pst_abc --text \"Fixed typo\" --set privacy=public",
    "postflare posts edit pst_abc --app Tempo --autolink",
  ],
  async run(ctx, { values, positionals }) {
    const current = await ctx.api.get<PostDTO>(`/posts/${encodeURIComponent(positionals[0])}`);
    const body: Record<string, unknown> = {};
    const content = await readText(ctx, values, false);
    if (content !== undefined) body.content = content;
    const when = readWhen(ctx, values);
    if (when !== undefined) body.scheduledAt = when;
    if (list(values.set).length) {
      const account = (await ctx.accounts()).find((a) => a.id === current.accountId);
      if (!account) throw new CliError(`Account ${current.accountId} not found`);
      const target = { account, provider: await ctx.provider(account.provider) };
      body.settings = buildSettings([target], list(values.set), new Map([[account.id, current.settings]])).get(account.id);
    }
    if (values["no-media"]) body.media = [];
    else if (list(values.media).length) body.media = await resolveMedia(ctx, list(values.media));
    if (values["no-thread"]) body.thread = [];
    else if (list(values.thread).length) body.thread = list(values.thread).map((t) => ({ content: t, media: [] }));
    if (values["no-playbook"]) {
      if (str(values.playbook)) throw new UsageError("Use either --playbook or --no-playbook", "posts edit");
      body.playbookId = null;
    }
    Object.assign(body, readPlaybook(values));
    if (values["no-app"]) {
      if (str(values.app)) throw new UsageError("Use either --app or --no-app", "posts edit");
      body.appId = null;
    } else if (str(values.app)) body.appId = (await resolveApp(ctx, str(values.app)!)).id;
    const autoLink = readAutoLink(values, "posts edit");
    if (autoLink !== undefined) body.autoLink = autoLink;
    if (!Object.keys(body).length) throw new UsageError("Nothing to change: give --text, --at/--now/--draft, --set, --media, --thread, --playbook or --app", "posts edit");
    const updated = await ctx.api.patch<PostDTO>(`/posts/${current.id}`, body);
    if (ctx.json) return printJson(updated);
    println(`${c.green("✓")} Updated ${updated.id}: ${fmtStatus(updated.status)} ${updated.status === "scheduled" ? fmtWhen(updated.scheduledAt) : ""}`);
  },
};

function simple(name: string, summary: string, method: "POST" | "DELETE", path: (id: string) => string, done: string): Command {
  return {
    name,
    args: "<ids...>",
    summary,
    min: 1,
    async run(ctx, { positionals }) {
      const out: unknown[] = [];
      for (const id of positionals) out.push(await ctx.api.request(method, path(encodeURIComponent(id))));
      if (ctx.json) return printJson(out.length === 1 ? out[0] : out);
      println(`${c.green("✓")} ${done}: ${positionals.join(", ")}`);
    },
  };
}

export const postsCancel = simple("posts cancel", "Cancel scheduled posts (they stay in the list as cancelled).", "POST", (id) => `/posts/${id}/cancel`, "Cancelled");
export const postsRetry = simple("posts retry", "Retry failed or cancelled posts now.", "POST", (id) => `/posts/${id}/retry`, "Retrying");
export const postsResolve: Command = {
  name: "posts resolve",
  args: "<id>",
  summary: "Resolve a needs_check post (publish outcome unknown): it is live (--published) or publish it again (--retry).",
  description:
    "needs_check: the platform did not confirm whether it accepted the post, so it is never retried automatically. Check the profile first: --retry may publish a duplicate if the first attempt went through.",
  options: {
    published: { type: "boolean", description: "The post is live: mark it published" },
    url: { type: "string", arg: "<url>", description: "Link to the live post (with --published)" },
    retry: { type: "boolean", description: "The post is not live: publish it again now" },
  },
  min: 1,
  max: 1,
  examples: ["postflare posts resolve pst_abc --published --url https://x.com/me/status/123", "postflare posts resolve pst_abc --retry"],
  async run(ctx, { values, positionals }) {
    const url = str(values.url);
    if (!!values.published === !!values.retry) throw new UsageError("Give either --published or --retry", "posts resolve");
    if (url && !values.published) throw new UsageError("--url only goes with --published", "posts resolve");
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw new UsageError(`--url ${url}: not an http(s) URL`, "posts resolve");
    const body: ResolvePostInput = values.published ? { published: true, ...(url ? { url } : {}) } : { published: false };
    const p = await ctx.api.request<PostDTO>("POST", `/posts/${encodeURIComponent(positionals[0])}/resolve`, { body });
    if (ctx.json) return printJson(p);
    println(`${c.green("✓")} ${values.published ? "Marked as published" : "Publishing again"}: ${p.id} ${fmtStatus(p.status)}${p.externalUrl ? `  ${c.cyan(p.externalUrl)}` : ""}`);
  },
};

export const postsComment: Command = {
  name: "posts comment",
  args: "<id>",
  summary: "Add a comment (or thread reply) under a published post, right away.",
  options: {
    text: { type: "string", short: "t", arg: "<text>", description: "Comment text" },
    "reply-to": { type: "string", arg: "<id|url>", description: "Answer this reply under the post (its id or link, e.g. an X reply) instead of the post itself" },
  },
  min: 1,
  max: 1,
  examples: [
    'postflare posts comment pst_abc --text "Answer: DENIED. Her passport expires too soon."',
    'postflare posts comment pst_abc --reply-to https://x.com/someone/status/123 --text "Thanks!"',
  ],
  async run(ctx, { values, positionals }) {
    const content = str(values.text)?.trim();
    if (!content) throw new UsageError("--text is required", "posts comment");
    const to = str(values["reply-to"])?.trim();
    // A link to the reply: its id is the last path segment (x.com/u/status/<id>, bsky…/post/<rkey>, threads…/post/<id>).
    const replyTo = to && /^https?:\/\//i.test(to) ? new URL(to).pathname.split("/").filter(Boolean).pop() : to;
    const r = await ctx.api.request<{ externalId: string; url: string | null }>("POST", `/posts/${encodeURIComponent(positionals[0])}/comments`, {
      body: { content, ...(replyTo ? { replyTo } : {}) },
    });
    if (ctx.json) return printJson(r);
    println(`${c.green("✓")} Comment added${r.url ? `: ${c.cyan(r.url)}` : ` (${r.externalId})`}`);
  },
};

export const postsRm = simple("posts rm", "Delete posts from Postflare (published posts stay on the platforms).", "DELETE", (id) => `/posts/${id}`, "Deleted");
