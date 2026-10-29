import { Hono } from "hono";
import {
  engagements,
  exposure,
  type AccountDTO,
  type AccountGroupDTO,
  type AnalyticsBreakdown,
  type AnalyticsPostDTO,
  type AnalyticsSummaryDTO,
  type AnalyticsTotals,
  type CampaignResultsDTO,
  type MetricValues,
} from "../../shared/types";
import { apiKeyUser, type AppEnv } from "../lib/auth";

/**
 * Minimal MCP server (Streamable HTTP, JSON responses) so AI agents can schedule posts.
 * Authenticate with an API key: `Authorization: Bearer pf_...`. The key is bound to one workspace and acts with its
 * user's permissions there. Every tool is a thin wrapper over the REST API, called in-process with the same key,
 * so workspace scoping and permission checks are the REST API's.
 */
export function mcpRoutes(api: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> }) {
  const mcp = new Hono<AppEnv>();

  const call = async (c: any, method: string, path: string, body?: unknown): Promise<any> => {
    const req = new Request(new URL(`/api${path}`, c.req.url), {
      method,
      headers: { authorization: c.req.header("authorization") ?? "", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await api.fetch(req, c.env, c.executionCtx);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
    return data;
  };

  /**
   * One URL path segment from a tool argument. Without encoding, an id like "../keys" or "x#" (e.g. from a prompt
   * injection) would reach other REST routes than the tool's (DELETE /api/workspaces/..., POST /api/keys...).
   */
  const seg = (v: unknown, name = "id") => {
    if (v === undefined || v === null || v === "") throw new Error(`Missing ${name}`);
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`Invalid ${name}: expected a string`);
    const s = String(v).trim();
    if (!s || s === "." || s === "..") throw new Error(`Invalid ${name}: ${s}`);
    return encodeURIComponent(s);
  };

  /**
   * The post id of post tools. Agents often name it `postId` (as in refresh_metrics) instead of `id`; without the
   * alias that read as an empty id and failed with "Invalid id" for perfectly valid ids like pst_JigXPHc1GeGPQqD2.
   */
  const postSeg = (a: any) => seg(a.id ?? a.postId, "id (the post id, e.g. pst_...)");

  const toMs = (v: unknown) => {
    if (v === "now" || v === null || v === undefined) return v ?? null;
    const ms = Date.parse(String(v));
    // NaN would serialize to null and silently create a draft.
    if (!Number.isFinite(ms)) throw new Error(`Invalid scheduledAt: ${String(v)} (use an ISO date, "now" or null)`);
    return ms;
  };

  /** from/to of analytics tools: ISO date, ms timestamp or relative ("7d", "12h", "30m" ago). */
  const when = (v: unknown, name: string): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const s = String(v).trim();
    const rel = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i.exec(s);
    if (rel) return Date.now() - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as "m"];
    const ms = /^\d{10,}$/.test(s) ? Number(s) : Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error(`Invalid ${name}: ${s} (use an ISO date or a relative time like "7d")`);
    return ms;
  };

  const analyticsQuery = (a: any) => {
    const q = new URLSearchParams();
    const from = when(a.from, "from");
    const to = when(a.to, "to");
    if (from !== undefined) q.set("from", String(from));
    if (to !== undefined) q.set("to", String(to));
    if (a.accountId) q.set("accountId", a.accountId);
    if (a.provider) q.set("provider", a.provider);
    return q;
  };

  const tools: Record<string, { description: string; inputSchema: object; run: (c: any, a: any) => Promise<unknown> }> = {
    list_platforms: {
      description:
        "List supported platforms with their capabilities (max length, media limits, threads; `mediaNote` explains what media is used for, " +
        "e.g. YouTube: an image attached next to the video becomes the custom thumbnail) and per-post settings fields (with help texts).",
      inputSchema: { type: "object", properties: {} },
      run: async (c) =>
        (await call(c, "GET", "/providers")).map((p: any) => ({
          id: p.id,
          name: p.name,
          configured: p.configured,
          status: p.status,
          capabilities: p.capabilities,
          settingsFields: p.settingsFields,
        })),
    },
    list_accounts: {
      description:
        "List connected social accounts. Use the account id when creating posts. `status` is the publishing state; " +
        "`analytics` is the analytics collection state (ok, pending, reconnect_required, not_supported, error) and `followers` the latest follower count. " +
        "`group` is the account's group (brand / project, see list_account_groups; absent when ungrouped); pass `group` (id or name, \"none\" = ungrouped) to list one group's accounts, " +
        "e.g. to post to every account of a brand. Pass `platform` to list one platform's accounts (both filters combine).",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "Only accounts of this group: group id or name (case-insensitive); \"none\" for ungrouped accounts." },
          platform: {
            type: "string",
            description:
              "Only accounts of this platform: provider id (see list_platforms, e.g. x, instagram_standalone, facebook) or an alias: " +
              `${Object.keys(PLATFORM_ALIASES).join(", ")}. Comma-separate several.`,
          },
        },
      },
      run: async (c, a) => {
        const [accounts, groups] = (await Promise.all([call(c, "GET", "/accounts"), call(c, "GET", "/account-groups")])) as [AccountDTO[], AccountGroupDTO[]];
        const byId = new Map(groups.map((g) => [g.id, g]));
        let list = accounts;
        if (a?.platform !== undefined && a.platform !== null && a.platform !== "") {
          const wanted = platformIds(String(a.platform));
          list = list.filter((x) => wanted.has(x.provider));
        }
        if (a?.group !== undefined && a.group !== null && a.group !== "") {
          const ref = String(a.group).trim();
          if (ref.toLowerCase() === "none") list = list.filter((x) => !x.groupId || !byId.has(x.groupId));
          else {
            const g = groups.find((x) => x.id === ref) ?? groups.find((x) => x.name.toLowerCase() === ref.toLowerCase());
            if (!g) throw new Error(`No account group matches "${ref}". Groups: ${groups.map((x) => `${x.name} (${x.id})`).join(", ") || "none yet"}`);
            list = list.filter((x) => x.groupId === g.id);
          }
        }
        return list.map((x) => compactAccount(x, x.groupId ? byId.get(x.groupId) : undefined));
      },
    },
    list_account_groups: {
      description:
        "List this workspace's account groups (brands / projects, e.g. one per app): id, name and how many accounts each has. " +
        "Use list_accounts with `group` to get a group's accounts.",
      inputSchema: { type: "object", properties: {} },
      run: async (c) => ((await call(c, "GET", "/account-groups")) as AccountGroupDTO[]).map((g) => ({ id: g.id, name: g.name, accounts: g.accountCount })),
    },
    get_account_options: {
      description: "Load choices for a dynamic settings field of an account (e.g. Pinterest boards, subreddits, Discord channels).",
      inputSchema: {
        type: "object",
        properties: { accountId: { type: "string" }, key: { type: "string" }, settings: { type: "object" } },
        required: ["accountId", "key"],
      },
      run: (c, a) =>
        call(c, "GET", `/accounts/${seg(a.accountId, "accountId")}/options/${seg(a.key, "key")}?settings=${encodeURIComponent(JSON.stringify(a.settings ?? {}))}`),
    },
    upload_media_from_url: {
      description: "Import an image or video from a public URL into the media library. Returns the media id to attach to posts.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, filename: { type: "string" }, alt: { type: "string" } },
        required: ["url"],
      },
      run: (c, a) => call(c, "POST", "/media/from-url", a),
    },
    create_upload_link: {
      description:
        "Create a one-time upload link for media that is not at a public URL (e.g. files the user attached in chat or has on their phone). " +
        "Either give `pageUrl` to the user (they open it and pick photos/videos), or, if you can run code with network access, " +
        "PUT the raw bytes to `putUrl` with headers Content-Type and X-Filename (max 90MB per request). " +
        "Then call get_upload_link to get the media ids.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", description: "Shown on the upload page, e.g. what to upload." },
          expiresMinutes: { type: "number", description: "Default 120." },
        },
      },
      run: (c, a) => call(c, "POST", "/upload-links", a),
    },
    get_upload_link: {
      description: "List the media uploaded through an upload link (ids to attach to posts).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (c, a) => call(c, "GET", `/upload-links/${seg(a.id ?? a.uploadLinkId)}`),
    },
    list_media: {
      description: "List the media library (newest first).",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      run: (c, a) => call(c, "GET", `/media?limit=${encodeURIComponent(String(a.limit ?? 30))}`),
    },
    create_post: {
      description:
        "Create a post on one or more accounts. `scheduledAt` is an ISO date, \"now\" to publish immediately, or null for a draft. Per-account `content`, `settings`, `media` and `thread` override the shared values. " +
        "Pass the `playbookId` (and `playbookVersion`) of the playbook you followed (get_playbook), and a `variant` label (\"A\"/\"B\") when testing two versions. " +
        "When the post is about an App Store app, pass `appId` (list_apps): posts on clickable platforms (X, Threads, Bluesky, LinkedIn, Facebook, Pinterest, Reddit, Mastodon, YouTube, Telegram...) " +
        "get a tracked link (clicks, App Store installs and proceeds per post); with auto-insert (workspace setting, or `autoLink: true`) App Store URLs of that app in the text are replaced by it, " +
        "or it is appended when the post has no link. Instagram/TikTok captions are not clickable: use the account's bio link instead.",
      inputSchema: {
        type: "object",
        properties: {
          scheduledAt: { type: ["string", "null"] },
          content: { type: "string" },
          playbookId: { type: "string", description: "Id of the playbook the post was written with (search_playbooks / get_playbook)." },
          playbookVersion: { type: "number", description: "Version of that playbook (default: latest)." },
          variant: { type: "string", description: "A/B label, e.g. \"A\" or \"B\" (max 32 characters)." },
          appId: { type: "string", description: "App Store app the post is about: app id from list_apps, App Store id or app name." },
          autoLink: { type: "boolean", description: "Override the workspace setting: replace App Store URLs / append the tracked link (true) or leave the text alone (false)." },
          media: { type: "array", items: { type: "string" } },
          thread: {
            type: "array",
            items: { type: "object", properties: { content: { type: "string" }, media: { type: "array", items: { type: "string" } } } },
          },
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                accountId: { type: "string" },
                content: { type: "string" },
                media: { type: "array", items: { type: "string" } },
                settings: { type: "object" },
                thread: { type: "array", items: { type: "object" } },
              },
              required: ["accountId"],
            },
          },
        },
        required: ["accounts"],
      },
      run: (c, a) =>
        call(c, "POST", "/posts", {
          scheduledAt: toMs(a.scheduledAt),
          ...(a.playbookId ? { playbookId: String(a.playbookId) } : {}),
          ...(a.playbookVersion != null ? { playbookVersion: Number(a.playbookVersion) } : {}),
          ...(a.variant ? { variant: String(a.variant) } : {}),
          ...(a.appId ? { appId: String(a.appId) } : {}),
          ...(typeof a.autoLink === "boolean" ? { autoLink: a.autoLink } : {}),
          posts: a.accounts.map((x: any) => ({
            accountId: x.accountId,
            content: x.content ?? a.content ?? "",
            media: x.media ?? a.media ?? [],
            settings: x.settings ?? {},
            thread: x.thread ?? a.thread ?? [],
          })),
        }),
    },
    list_posts: {
      description:
        "List posts, optionally filtered by ISO date range, status (comma separated: draft, scheduled, publishing, published, failed, cancelled, needs_check) or account. " +
        "needs_check = the platform may or may not have accepted the post (ambiguous failure): never retried automatically, see resolve_post.",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" }, status: { type: "string" }, accountId: { type: "string" } },
      },
      run: (c, a) => {
        const q = new URLSearchParams();
        if (a.from) q.set("from", String(Date.parse(a.from)));
        if (a.to) q.set("to", String(Date.parse(a.to)));
        if (a.status) q.set("status", a.status);
        if (a.accountId) q.set("accountId", a.accountId);
        return call(c, "GET", `/posts?${q}`);
      },
    },
    get_post: {
      description: "Get a post with its publishing log and, when it is about an app, its tracked link (`campaign`: trackedUrl, ct, clicks, App Store downloads, proceeds).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (c, a) => call(c, "GET", `/posts/${postSeg(a)}`),
    },
    list_apps: {
      description:
        "List this workspace's App Store apps (id, App Store id, name). Pass an app's id as `appId` to create_post for tracked App Store links " +
        "(campaign token per post and platform: clicks, installs and proceeds per post in the analytics tools).",
      inputSchema: { type: "object", properties: {} },
      run: async (c) => ((await call(c, "GET", "/apps")) as any[]).map((x) => ({ id: x.id, appStoreId: x.appStoreId, name: x.name })),
    },
    get_bio_link: {
      description:
        "Get (or create) the tracked bio link of an account for an app: put it in the profile of Instagram/TikTok accounts, whose captions are not clickable. " +
        "Its campaign token is pf-<platform>-bio; clicks and installs show in Postflare.",
      inputSchema: { type: "object", properties: { accountId: { type: "string" }, appId: { type: "string" } }, required: ["accountId", "appId"] },
      run: async (c, a) => {
        const l = await call(c, "POST", "/campaigns/bio-links", { accountId: a.accountId, appId: a.appId });
        return drop({ url: l.trackedUrl, ct: l.ct, appStoreUrl: l.appStoreUrl, clicks: l.clicks, installs: l.downloads, proceeds: l.proceeds, currency: l.currency });
      },
    },
    update_post: {
      description: "Edit a draft, scheduled or failed post. `scheduledAt`: ISO date, \"now\", or null for draft.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          media: { type: "array", items: { type: "string" } },
          settings: { type: "object" },
          thread: { type: "array", items: { type: "object" } },
          scheduledAt: { type: ["string", "null"] },
          playbookId: { type: ["string", "null"], description: "Playbook attribution (null removes it)." },
          playbookVersion: { type: "number" },
          variant: { type: ["string", "null"] },
          appId: { type: ["string", "null"], description: "App Store app (list_apps); null removes it." },
          autoLink: { type: ["boolean", "null"], description: "Auto-insert override (null = workspace default)." },
        },
        required: ["id"],
      },
      run: (c, { id, postId, scheduledAt, ...rest }) =>
        call(c, "PATCH", `/posts/${postSeg({ id, postId })}`, { ...rest, ...(scheduledAt !== undefined ? { scheduledAt: toMs(scheduledAt) } : {}) }),
    },
    cancel_post: {
      description: "Cancel a scheduled post.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (c, a) => call(c, "POST", `/posts/${postSeg(a)}/cancel`),
    },
    retry_post: {
      description: "Retry a failed post now.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (c, a) => call(c, "POST", `/posts/${postSeg(a)}/retry`),
    },
    resolve_post: {
      description:
        "Resolve a needs_check post (we could not confirm whether the platform accepted it). Ask the user to check the profile first. " +
        "`published: true` marks it published (optionally with the live post `url`); `published: false` publishes it again now, " +
        "which duplicates the post if the platform did accept the first attempt.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, published: { type: "boolean" }, url: { type: "string" } },
        required: ["id", "published"],
      },
      run: (c, a) => call(c, "POST", `/posts/${postSeg(a)}/resolve`, { published: a.published === true, url: a.url ?? null }),
    },
    get_analytics_summary: {
      description:
        "Analytics of the posts PUBLISHED in a range (default: last 30 days): totals (views, impressions, reach, engagements, " +
        "engagement rate in %), change vs the previous period of equal length, per platform, per account, posts per day and follower growth. " +
        "`from`/`to`: ISO date or relative (\"7d\", \"30d\", \"12h\" = that long ago). A post's metrics count for the day it was published.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "ISO date or relative like \"7d\" (default 30d)." },
          to: { type: "string", description: "ISO date or relative (default now)." },
          accountId: { type: "string" },
          provider: { type: "string", description: "Platform id, e.g. instagram_standalone, tiktok, youtube." },
        },
      },
      run: async (c, a) => compactSummary(await call(c, "GET", `/analytics/summary?${analyticsQuery(a)}`)),
    },
    get_top_posts: {
      description:
        "Published posts of a range with their latest metrics, best first. `sort`: views (views, else impressions, else reach), " +
        "engagements, engagementRate, publishedAt (newest first), or for posts with tracked App Store links clicks, installs (first-time downloads) or proceeds. " +
        "`limit` ≤ 50 (default 10). " +
        CAMPAIGN_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "ISO date or relative like \"7d\" (default 30d)." },
          to: { type: "string" },
          accountId: { type: "string" },
          provider: { type: "string" },
          sort: { type: "string", enum: ["views", "engagements", "engagementRate", "publishedAt", "clicks", "installs", "proceeds"] },
          limit: { type: "number" },
        },
      },
      run: async (c, a) => {
        const q = analyticsQuery(a);
        q.set("sort", a.sort === "installs" ? "downloads" : (a.sort ?? "views"));
        q.set("limit", String(Math.min(Math.max(Number(a.limit) || 10, 1), 50)));
        return ((await call(c, "GET", `/analytics/posts?${q}`)) as any[]).map(compactPost);
      },
    },
    get_post_metrics: {
      description:
        "Latest metrics of a published post and the series of snapshots collected over time (~1h, 24h, 3d, 7d, 30d, then weekly). " +
        "YouTube adds watchTimeMinutes, avgViewDurationSeconds, avgViewPercentage (0-100) and shares from 24h on (YouTube Analytics lags 1-3 days), " +
        "and `details` from the 7d/30d snapshots: `retention` = [[elapsed share of the video 0.01..1, audienceWatchRatio], ...] (ratio of viewers still " +
        "watching, can exceed 1 on rewatches) and `trafficSources` = views per insightTrafficSourceType (YT_SEARCH, RELATED_VIDEO, SHORTS, EXT_URL...). " +
        "Posts with a tracked App Store link add `campaign`: clicks, installs (first-time downloads), redownloads, proceeds. " +
        CAMPAIGN_NOTE,
      inputSchema: { type: "object", properties: { id: { type: "string", description: "Post id (pst_...), as returned by list_posts / get_top_posts." } }, required: ["id"] },
      run: async (c, a) => {
        const m = await call(c, "GET", `/posts/${postSeg(a)}/metrics`);
        const rate = rateOf(m.metrics);
        return drop({
          postId: m.postId,
          publishedAt: iso(m.publishedAt),
          metrics: m.metrics ?? null,
          engagements: m.metrics ? engagements(m.metrics) : undefined,
          engagementRatePct: rate,
          metricsAt: iso(m.metricsAt),
          nextCollectionAt: iso(m.metricsNextAt),
          snapshots: m.snapshots.map((s: any) => ({ at: iso(s.capturedAt), ...s.metrics })),
          details: m.details ?? undefined,
          detailsAt: iso(m.detailsAt),
          campaign: m.campaign ? compactCampaign(m.campaign) : undefined,
        });
      },
    },
    refresh_metrics: {
      description:
        "Collect metrics now instead of waiting for the next scheduled collection: either one published post (`postId`) or an account " +
        "(`accountId`: its follower metrics and its due posts). Repeated refreshes within a minute return the stored values.",
      inputSchema: { type: "object", properties: { postId: { type: "string" }, accountId: { type: "string" } } },
      run: async (c, a) => {
        if (!!a.postId === !!a.accountId) throw new Error("Give either postId or accountId");
        const r = await call(c, "POST", "/analytics/refresh", a.postId ? { postId: a.postId } : { accountId: a.accountId });
        if (r.post) return { post: compactPost(r.post) };
        return {
          account: drop({
            id: r.account.id,
            analytics: r.account.metricsStatus.status,
            message: r.account.metricsStatus.message ?? undefined,
            metrics: r.account.metricsStatus.metrics ?? undefined,
            postsRefreshed: r.account.postsRefreshed,
          }),
        };
      },
    },
    search_playbooks: {
      description:
        "Search the playbook library (built-in recipes plus this workspace's own) for writing a post: by text (`q`, e.g. \"app launch\", \"game clip\"), " +
        "`platform` (provider id like x, tiktok, instagram_standalone, or a group: short-video, microblog, professional, visual), " +
        "`goal` (engagement, reach, clicks, followers, conversions) and `format` (text, thread, image, carousel, video). Best match first. " +
        "Then call get_playbook for the full recipe.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          platform: { type: "string" },
          goal: { type: "string", enum: ["engagement", "reach", "clicks", "followers", "conversions"] },
          format: { type: "string", enum: ["text", "thread", "image", "carousel", "video"] },
          limit: { type: "number", description: "Default 8." },
        },
      },
      run: async (c, a) => {
        const q = new URLSearchParams();
        for (const k of ["q", "platform", "goal", "format"]) if (a[k]) q.set(k, String(a[k]));
        const list = (await call(c, "GET", `/playbooks?${q}`)) as any[];
        return list.slice(0, Math.min(Math.max(Number(a.limit) || 8, 1), 30)).map((p) =>
          drop({ id: p.id, version: p.version, name: p.name, summary: p.summary, goal: p.goal, platforms: p.platforms, formats: p.formats, builtin: p.builtin || undefined, inputs: p.inputs }),
        );
      },
    },
    get_playbook: {
      description:
        "Get a playbook as a ready-to-use prompt: the recipe (structure, platform notes, hooks, examples, things to avoid, checklist), " +
        "this workspace's target accounts with their limits, and how to attribute the post. Follow it, then pass its playbookId/playbookVersion to create_post. " +
        "`accountId` narrows the target accounts.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, version: { type: "number" }, accountId: { type: "string" } },
        required: ["id"],
      },
      run: async (c, a) => {
        const q = new URLSearchParams();
        if (a.version) q.set("version", String(a.version));
        if (a.accountId) q.set("accountId", String(a.accountId));
        const p = await call(c, "GET", `/playbooks/${seg(a.id ?? a.playbookId)}?${q}`);
        return { id: p.id, version: p.version, name: p.name, goal: p.goal, inputs: p.inputs, checklist: p.checklist, prompt: p.prompt };
      },
    },
    get_playbook_stats: {
      description:
        "Rank playbooks by measured performance in this workspace: for each playbook (and version / A-B variant), published posts with metrics, " +
        "median engagement rate, median views and lift vs each account's usual (posts without a playbook), with a confidence label " +
        "(insufficient < 5 posts, low < 20, ok), plus App Store installs and proceeds of posts with tracked links. Correlational, not causal. " +
        "Use it to pick the playbook that works best for an account or platform; `sort`: lift (default), installs, proceeds, installsPerPost, proceedsPerPost.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Look-back window in days (default 90, max 366)." },
          platform: { type: "string", description: "Provider id, e.g. tiktok." },
          accountId: { type: "string" },
          sort: { type: "string", enum: ["lift", "installs", "proceeds", "installsPerPost", "proceedsPerPost"] },
        },
      },
      run: async (c, a) => {
        const q = new URLSearchParams();
        if (a.sort) q.set("sort", { installs: "downloads", installsPerPost: "downloadsPerPost" }[String(a.sort)] ?? String(a.sort));
        if (a.days) q.set("days", String(a.days));
        if (a.platform) q.set("platform", String(a.platform));
        if (a.accountId) q.set("accountId", String(a.accountId));
        const s = await call(c, "GET", `/playbooks/stats?${q}`);
        const row = (r: any) =>
          drop({
            playbookId: r.playbookId ?? undefined,
            name: r.name,
            version: r.version ?? undefined,
            variant: r.variant === undefined ? undefined : (r.variant ?? "(none)"),
            posts: r.posts,
            accounts: r.accounts,
            liftPct: pct(r.lift),
            medianEngagementRatePct: pct(r.medianEngagementRate),
            medianViews: r.medianViews ?? undefined,
            confidence: r.confidence,
            trackedPosts: r.campaignPosts || undefined,
            clicks: r.campaignPosts ? r.clicks : undefined,
            installs: r.campaignPosts ? r.downloads : undefined,
            proceeds: r.campaignPosts ? round(r.proceeds) : undefined,
            installsPerPost: r.downloadsPerPost === null || r.downloadsPerPost === undefined ? undefined : round(r.downloadsPerPost),
            proceedsPerPost: r.proceedsPerPost ?? undefined,
          });
        return drop({
          range: { from: iso(s.from), to: iso(s.to), days: s.days },
          postsAnalyzed: s.postsAnalyzed,
          sort: s.sort,
          currency: s.currency ?? undefined,
          baseline: row(s.baseline),
          playbooks: s.playbooks.map((p: any) => drop({ ...row(p), versions: p.versions.length > 1 ? p.versions.map(row) : undefined, variants: p.variants.map(row) })),
          method: s.method,
        });
      },
    },
    delete_post: {
      description: "Delete a post from Postflare (does not delete it from the platform).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (c, a) => call(c, "DELETE", `/posts/${postSeg(a)}`),
    },
  };

  mcp.get("/", (c) => c.json({ error: "Use POST (MCP Streamable HTTP)" }, 405));

  mcp.post("/", async (c) => {
    if (!(await apiKeyUser(c.env, c.req.header("authorization")))) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: use an API key" } }, 401);
    }
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const handle = async (msg: any) => {
      if (!msg || typeof msg !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
      const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
      if (msg.id === undefined || msg.method === undefined) return null; // notification or client response
      switch (msg.method) {
        case "initialize":
          return reply({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "postflare", version: "1.0.0" },
            instructions:
              "Schedule social posts and read their analytics. This API key works in one Postflare workspace: you only see and change its accounts, posts and media, " +
              "and only what the key's user is allowed to (tools return a permission error otherwise). Typical flow: list_accounts -> attach media -> create_post. Accounts can be grouped by brand/project: \"post to <brand>\" = list_accounts with `group` (list_account_groups). Check list_platforms for limits and required settings. " +
              "Before writing a post, search_playbooks for the goal/platform, get_playbook and follow it, and pass its playbookId (and playbookVersion) to create_post; " +
              "get_playbook_stats shows which playbooks perform best in this workspace. " +
              "Media from a public URL: upload_media_from_url. Files attached in chat or on the user's device: create_upload_link " +
              "(user opens pageUrl, or your code sandbox PUTs bytes to putUrl), then get_upload_link. " +
              "Local files from a terminal agent (up to 90MB): POST the raw bytes to <this server>/api/media with headers " +
              "`Authorization: Bearer <same API key>`, `Content-Type: <mime>`, `X-Filename: <name>` (optionally X-Width/X-Height/X-Duration), " +
              "e.g. `curl --data-binary @clip.mp4 -H 'Content-Type: video/mp4' -H 'X-Filename: clip.mp4' -H 'Authorization: Bearer pf_...' https://<host>/api/media`; the JSON response has the media id. " +
              "Analytics: get_analytics_summary (KPIs, change vs previous period, per platform/account, followers), get_top_posts, " +
              "get_post_metrics, refresh_metrics. Posts about an App Store app (create_post `appId`, see list_apps) get tracked links: clicks, installs and proceeds per post. Metrics are collected ~1h, 24h, 3d, 7d and 30d after publishing; accounts whose " +
              "`analytics` is reconnect_required must be reconnected in the app to grant analytics permissions.",
          });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({
            tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
          });
        case "tools/call": {
          const tool = tools[msg.params?.name];
          if (!tool) return fail(-32602, `Unknown tool ${msg.params?.name}`);
          try {
            const result = await tool.run(c, toolArgs(msg.params.arguments));
            return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
          } catch (err) {
            return reply({ content: [{ type: "text", text: (err as Error).message }], isError: true });
          }
        }
        default:
          return fail(-32601, `Method not found: ${msg.method}`);
      }
    };
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map(handle))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(payload);
    return out ? c.json(out) : c.body(null, 202);
  });

  return mcp;
}

/** Tool arguments: some clients send them as a JSON string instead of an object. */
function toolArgs(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw new Error("Invalid arguments: expected a JSON object");
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Platform names agents use for list_accounts `platform`, mapped to provider ids. */
const PLATFORM_ALIASES: Record<string, string[]> = {
  instagram: ["instagram", "instagram_standalone"],
  ig: ["instagram", "instagram_standalone"],
  twitter: ["x"],
  fb: ["facebook"],
  tiktok: ["tiktok", "tiktok_business"],
  linkedin: ["linkedin", "linkedin_page"],
  yt: ["youtube"],
  "google-business": ["gmb"],
};

/** Provider ids of a `platform` filter: comma-separated provider ids or aliases (case-insensitive, "-"/" " = "_"). */
function platformIds(ref: string): Set<string> {
  const out = new Set<string>();
  for (const raw of ref.split(",")) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const alias = PLATFORM_ALIASES[k];
    if (alias) alias.forEach((id) => out.add(id));
    else out.add(k.replace(/[\s-]+/g, "_"));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Compact, LLM-friendly shapes of the analytics DTOs (ISO dates, rates in %, rounded, no nulls/empty arrays).

const CAMPAIGN_NOTE =
  "App Store installs/proceeds come from Apple App Analytics via Revflare: 2-3 days delay, small numbers (< 5 users) withheld, proceeds are Apple's estimate.";

const iso = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms).toISOString() : undefined);
const pct = (r: number | null | undefined) => (typeof r === "number" ? Math.round(r * 10000) / 100 : undefined);
const round = (n: number) => Math.round(n * 100) / 100;

/** Drops undefined/null values and empty arrays. */
function drop<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

const rateOf = (m: MetricValues | null | undefined) => {
  const e = exposure(m);
  return m && e ? pct(engagements(m) / e) : undefined;
};

function compactTotals(t: AnalyticsTotals) {
  return drop({
    posts: t.posts,
    postsWithMetrics: t.postsWithMetrics,
    views: t.views || undefined,
    impressions: t.impressions || undefined,
    reach: t.reach || undefined,
    engagements: t.engagements,
    likes: t.likes || undefined,
    comments: t.comments || undefined,
    shares: t.shares || undefined,
    engagementRatePct: pct(t.engagementRate),
    followers: t.followers,
    followersChange: t.followersChange,
    trackedPosts: t.campaignPosts || undefined,
    clicks: t.campaignPosts ? t.clicks : undefined,
    installs: t.campaignPosts ? t.downloads : undefined,
    redownloads: t.campaignPosts ? t.redownloads : undefined,
    proceeds: t.campaignPosts ? round(t.proceeds) : undefined,
    proceedsPerPost: t.campaignPosts ? round(t.proceeds / t.campaignPosts) : undefined,
  });
}

function compactCampaign(c: CampaignResultsDTO) {
  return drop({
    clicks: c.clicks,
    installs: c.downloads ?? undefined,
    redownloads: c.redownloads ?? undefined,
    purchases: c.purchases ?? undefined,
    proceeds: c.proceeds ?? undefined,
    currency: c.currency ?? undefined,
    asOf: c.asOf ?? undefined,
    note: c.downloads === null ? "App Store numbers not reported yet (Revflare not connected, or the token has no data yet)" : undefined,
  });
}

/** Change of each total vs the previous period: absolute and % (when the previous value is not 0). */
function deltas(cur: AnalyticsTotals, prev: AnalyticsTotals) {
  const out: Record<string, string> = {};
  for (const k of ["posts", "views", "impressions", "reach", "engagements", "followers"] as const) {
    const a = cur[k] ?? 0;
    const b = prev[k] ?? 0;
    if (!a && !b) continue;
    const d = a - b;
    out[k] = `${d >= 0 ? "+" : ""}${d}${b ? ` (${d >= 0 ? "+" : ""}${round((d / b) * 100)}%)` : ""}`;
  }
  if (cur.engagementRate !== null && prev.engagementRate !== null) {
    const d = pct(cur.engagementRate - prev.engagementRate)!;
    out.engagementRatePct = `${d >= 0 ? "+" : ""}${d} pts`;
  }
  return out;
}

function compactBreakdown(b: AnalyticsBreakdown) {
  return drop({
    ...(b.accountId ? { accountId: b.accountId, name: b.name, username: b.username ?? undefined, provider: b.provider } : { provider: b.provider, name: b.name }),
    ...compactTotals(b),
  });
}

function compactSummary(s: AnalyticsSummaryDTO) {
  return drop({
    range: { from: iso(s.from), to: iso(s.to), tz: s.tz },
    currency: s.totals.campaignPosts ? (s.currency ?? undefined) : undefined,
    totals: compactTotals(s.totals),
    previousPeriod: compactTotals(s.previous),
    change: deltas(s.totals, s.previous),
    byProvider: s.byProvider.map(compactBreakdown),
    byAccount: s.byAccount.map(compactBreakdown),
    // Only the days something was published (the rest are all zeros).
    daily: s.daily.filter((d) => d.posts > 0),
    followers: s.followers.map((f) => {
      const first = f.points[0]?.followers;
      const last = f.points[f.points.length - 1]?.followers;
      return { accountId: f.accountId, name: f.name, provider: f.provider, start: first, end: last, change: last - first, days: f.points.length };
    }),
  });
}

function compactPost(p: AnalyticsPostDTO) {
  const m = p.metrics ?? {};
  const { extra: _extra, ...values } = m;
  const nonZero = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "number" && v !== 0));
  const excerpt = Array.from(p.excerpt.replace(/\s+/g, " ").trim());
  return drop({
    id: p.id,
    accountId: p.accountId,
    account: p.accountUsername ? `${p.accountName} (@${p.accountUsername.replace(/^@/, "")})` : p.accountName,
    provider: p.provider,
    publishedAt: iso(p.publishedAt),
    excerpt: excerpt.length > 140 ? excerpt.slice(0, 139).join("") + "…" : excerpt.join(""),
    url: p.externalUrl ?? undefined,
    views: exposure(p.metrics) ?? undefined,
    engagements: p.metrics ? p.engagements : undefined,
    engagementRatePct: pct(p.engagementRate),
    metrics: p.metrics ? nonZero : undefined,
    metricsAt: iso(p.metricsAt),
    campaign: p.campaign ? compactCampaign(p.campaign) : undefined,
    note: p.metrics ? undefined : "no metrics collected yet",
  });
}

function compactAccount(a: AccountDTO, group?: AccountGroupDTO) {
  const ms = a.metricsStatus;
  return drop({
    id: a.id,
    provider: a.provider,
    name: a.name,
    username: a.username,
    status: a.status,
    statusMessage: a.statusMessage,
    profileUrl: a.profileUrl,
    followers: ms?.metrics?.followers,
    analytics: ms?.status,
    analyticsMessage: ms && (ms.status === "reconnect_required" || ms.status === "error") ? ms.message : undefined,
    group: group ? { id: group.id, name: group.name } : null,
  });
}
