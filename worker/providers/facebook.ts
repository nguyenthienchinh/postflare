import { ProviderError } from "./errors";
import { clientFields, requireApp } from "./http";
import {
  FB_GRAPH,
  GRAPH_BATCH_MAX,
  bestEffort,
  facebookAuthorizeUrl,
  facebookPages,
  facebookUserId,
  facebookUserToken,
  graph,
  graphBatch,
  insightValues,
  metricsFailure,
  metricsGet,
  type GraphReply,
} from "./meta-shared";
import type { AccountRecord, MediaItem, MetricValues, PostMetricsResult, Provider, ProviderContext, PublishPost, PublishResult } from "./types";

const METRICS_SCOPES = ["read_insights", "pages_read_engagement"];
const SCOPES = ["pages_show_list", "pages_manage_posts", "pages_manage_engagement", "pages_read_engagement", "business_management", "read_insights"];

/** Formats the Page photos endpoint accepts by URL; anything else (WebP, HEIC, AVIF...) is re-encoded to JPEG and uploaded. */
const PHOTO_MIMES = /^image\/(jpeg|jpg|pjpeg|png|gif|bmp|tiff)$/i;
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
/** Background presets only apply to text-only posts up to this length. */
const PRESET_MAX_CHARS = 130;

// Facebook has no endpoint listing text_format_preset_id values; these ids are global.
const PRESETS: Array<[string, string]> = [
  ["106018623298955", "Solid purple"],
  ["204187940028597", "Solid red"],
  ["217761075370932", "Solid blue"],
  ["301029513638534", "Solid teal"],
  ["1881421442117417", "Solid black"],
  ["219266485227663", "Solid magenta"],
  ["175493843120364", "Pink and yellow gradient"],
  ["303063890126415", "Yellow/orange/pink gradient"],
  ["249307305544279", "Gradient, red-blue"],
  ["1777259169190672", "Gradient, purple-magenta"],
  ["688479024672716", "Gradient, teal light-green"],
  ["122708641613922", "Gradient, dark grey-black"],
  ["191761991491375", "3D hearts"],
  ["200521337465306", "3D flame emojis"],
  ["2193627793985415", "3D heart-eyes emojis"],
  ["365653833956649", "Pink tropical plants"],
  ["143093446467972", "Blue clouds on dark blue"],
  ["161409924510923", "Rocket ship makes heart in sky"],
  ["518948401838663", "Pink heart pattern on pink"],
  ["228164237768720", "Grey heart pattern on black"],
];

interface Page {
  id: string;
  name: string;
  username?: string;
  access_token?: string;
  picture?: { data?: { url?: string } };
  tasks?: string[];
}

type FbState =
  | { kind: "video"; videoId: string }
  | { kind: "reel"; videoId: string; finished: boolean; description: string }
  | { kind: "story"; items: Array<{ kind: "photo" | "video"; id: string }>; done: number; lastPostId?: string };

interface VideoStatus {
  video_status?: string;
  uploading_phase?: { status?: string };
  processing_phase?: { status?: string };
  publishing_phase?: { status?: string; publish_status?: string };
}

const pageToken = (account: AccountRecord) => account.credentials.accessToken as string;
const absolute = (url: string | undefined | null) => (!url ? null : url.startsWith("/") ? `https://www.facebook.com${url}` : url);

async function permalink(ctx: ProviderContext, token: string, id: string, fallback: string | null) {
  return bestEffort(async () => absolute((await graph<{ permalink_url?: string }>(ctx, `${FB_GRAPH}/${id}`, { token, query: { fields: "permalink_url" } })).permalink_url), fallback);
}

/**
 * Public link of a comment: the post with `comment_id` (the part after the "_" of a Graph comment id
 * "<object id>_<comment id>"), which opens the post scrolled to the comment. Built, not fetched: no subrequest.
 */
export function commentUrl(postId: string, commentId: string): string {
  return `https://www.facebook.com/${postId}?comment_id=${encodeURIComponent(commentId.split("_").pop()!)}`;
}

/** Upload one unpublished photo and return its id (used for multi-photo posts and photo stories). */
async function uploadPhoto(ctx: ProviderContext, account: AccountRecord, m: MediaItem): Promise<string> {
  const token = pageToken(account);
  const url = `${FB_GRAPH}/${account.externalId}/photos`;
  if (PHOTO_MIMES.test(m.mime) && m.size <= PHOTO_MAX_BYTES) {
    return (await graph<{ id: string }>(ctx, url, { method: "POST", token, json: { url: m.url, published: false, alt_text_custom: m.alt ?? undefined } })).id;
  }
  // Unsupported format or too big for Facebook to fetch: re-encode as JPEG and upload the bytes.
  const blob = await ctx.media.image(m, { format: "image/jpeg", maxWidth: 2048, maxHeight: 2048, quality: 85 });
  const form = new FormData();
  form.set("source", blob, m.filename.replace(/\.[^.]+$/, "") + ".jpg");
  form.set("published", "false");
  if (m.alt) form.set("alt_text_custom", m.alt);
  return (await graph<{ id: string }>(ctx, url, { method: "POST", token, body: form })).id;
}

/** Start a resumable video upload (Reels / video stories) and let Facebook pull the file from its public URL. */
async function hostedUpload(ctx: ProviderContext, account: AccountRecord, edge: "video_reels" | "video_stories", m: MediaItem) {
  const token = pageToken(account);
  const start = await graph<{ video_id: string; upload_url: string }>(ctx, `${FB_GRAPH}/${account.externalId}/${edge}`, {
    method: "POST",
    token,
    json: { upload_phase: "start" },
  });
  await graph(ctx, start.upload_url, { method: "POST", headers: { authorization: `OAuth ${token}`, file_url: m.url } });
  return start.video_id;
}

async function videoStatus(ctx: ProviderContext, token: string, videoId: string): Promise<VideoStatus> {
  const res = await graph<{ status?: VideoStatus }>(ctx, `${FB_GRAPH}/${videoId}`, { token, query: { fields: "status" } });
  const status = res.status ?? {};
  const failed = [status.video_status, status.uploading_phase?.status, status.processing_phase?.status, status.publishing_phase?.status].includes("error");
  if (failed) throw new ProviderError(`Facebook could not process the video: ${JSON.stringify(status)}`, "invalid", 200, res);
  return status;
}

const pending = (state: FbState, retryAfterSeconds = 15): PublishResult => ({
  status: "pending",
  state: state as unknown as Record<string, unknown>,
  retryAfterSeconds,
});

async function publishFeed(ctx: ProviderContext, account: AccountRecord, post: PublishPost): Promise<PublishResult> {
  const token = pageToken(account);
  const s = post.settings ?? {};
  const photos: string[] = [];
  for (const m of post.media) photos.push(await uploadPhoto(ctx, account, m));
  const preset = !photos.length && !s.url && s.text_format_preset_id && Array.from(post.content).length <= PRESET_MAX_CHARS ? String(s.text_format_preset_id) : undefined;
  const body = (withPreset: boolean) => ({
    message: post.content || undefined,
    link: s.url || undefined,
    attached_media: photos.length ? photos.map((id) => ({ media_fbid: id })) : undefined,
    text_format_preset_id: withPreset ? preset : undefined,
    published: true,
  });
  const url = `${FB_GRAPH}/${account.externalId}/feed`;
  let res: { id: string };
  try {
    res = await graph(ctx, url, { method: "POST", token, json: body(!!preset), commit: true });
  } catch (err) {
    // Presets are undocumented and get retired; a stale one fails the whole post, so retry once without it.
    // Only after a definite refusal ("invalid"): an ambiguous failure may have created the post.
    if (!preset || !(err instanceof ProviderError) || err.kind !== "invalid") throw err;
    ctx.log("warn", `Facebook rejected the background preset, publishing as plain text: ${err.message}`);
    res = await graph(ctx, url, { method: "POST", token, json: body(false), commit: true });
  }
  return { status: "published", externalId: res.id, url: await permalink(ctx, token, res.id, `https://www.facebook.com/${res.id}`) };
}

// ---- Metrics
// Feed posts ("pageId_postId"): counts from the post node, plus post insights. Since the Nov 2025 deprecation of
// post_impressions*, views = post_media_view and reach = post_total_media_view_unique.
// Videos / reels (id without "_"): likes/comments summaries of the video node plus `video_insights` without a metric
// list (Graph returns every metric valid for that video type, so a reel vs video mismatch cannot fail the request);
// views = fb_reels_total_plays (reels) or total_video_views (videos), reach = post_impressions_unique /
// total_video_impressions_unique when present. Assumption: these names follow the current Video Insights docs.
const POST_FIELDS = "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)";
const POST_INSIGHTS = "post_media_view,post_total_media_view_unique,post_clicks";
const VIDEO_FIELDS = "likes.summary(total_count).limit(0),comments.summary(total_count).limit(0)";

const isVideo = (id: string) => !id.includes("_");
const first = (v: Record<string, number>, names: string[]) => names.map((n) => v[n]).find((x) => typeof x === "number");

function fbMetrics(id: string, node: any, insights: GraphReply | undefined, ctx: ProviderContext): MetricValues {
  const out: MetricValues = {};
  const total = (edge: any) => (typeof edge?.summary?.total_count === "number" ? edge.summary.total_count : undefined);
  const likes = total(isVideo(id) ? node?.likes : node?.reactions);
  const comments = total(node?.comments);
  if (likes !== undefined) out.likes = likes;
  if (comments !== undefined) out.comments = comments;
  // `shares` is omitted when nobody shared the post.
  if (!isVideo(id)) out.shares = typeof node?.shares?.count === "number" ? node.shares.count : 0;
  if (insights?.ok) {
    const v = insightValues(insights.body?.data);
    const views = isVideo(id) ? first(v, ["fb_reels_total_plays", "blue_reels_play_count", "total_video_views"]) : v.post_media_view;
    const reach = isVideo(id) ? first(v, ["post_impressions_unique", "total_video_impressions_unique"]) : v.post_total_media_view_unique;
    if (views !== undefined) out.views = views;
    if (reach !== undefined) out.reach = reach;
    if (!isVideo(id) && typeof v.post_clicks === "number") out.clicks = v.post_clicks;
  } else if (insights && metricsFailure("Facebook", METRICS_SCOPES, insights) === "invalid") {
    ctx.log("warn", `Facebook insights of ${id}: ${insights.body?.error?.message ?? insights.status}`);
  }
  return out;
}

export const facebook: Provider = {
  id: "facebook",
  name: "Facebook Page",
  color: "0866FF",
  icon: "facebook",
  category: "social",
  auth: "oauth2",
  appFields: [
    ...clientFields("App ID", "App Secret"),
    {
      key: "configId",
      label: "Login for Business configuration ID",
      type: "text",
      help: "Only for apps using Facebook Login for Business. Leave empty to request the scopes directly.",
    },
  ],
  docsUrl: "https://developers.facebook.com/apps",
  setupNotes: [
    "1. Create an app at [developers.facebook.com/apps](https://developers.facebook.com/apps) (type **Business**).",
    "2. Add the **Facebook Login for Business** (or Facebook Login) product and add `{{redirectUri}}` to *Valid OAuth Redirect URIs*.",
    `3. Request the permissions ${SCOPES.map((s) => `\`${s}\``).join(", ")} (Advanced Access needs App Review unless you only post to Pages you manage as an app admin/tester).`,
    "4. If you use Login for Business, create a configuration with those permissions and paste its ID below.",
    "5. Copy the App ID and App Secret from *App settings → Basic*. One account is added per Page you select.",
    "In *App settings → Basic*, set the *Data deletion request URL* to the data deletion callback `{{baseUrl}}/oauth/meta/data-deletion` (and the *Privacy policy URL* to `{{baseUrl}}/privacy/`).",
    "Analytics need `read_insights` and `pages_read_engagement`; Pages connected before analytics existed must reconnect.",
  ].join("\n"),
  credentialFields: [],
  settingsFields: [
    {
      key: "post_type",
      label: "Post type",
      type: "select",
      default: "post",
      options: [
        { value: "post", label: "Post (text, link, photos or video)" },
        { value: "reel", label: "Reel (one vertical video)" },
        { value: "story", label: "Story (each media becomes a story)" },
      ],
    },
    { key: "url", label: "Link", type: "url", placeholder: "https://...", help: "Shared link preview (text and photo posts).", showIf: { key: "post_type", equals: "post" } },
    { key: "title", label: "Video title", type: "text", maxLength: 255, help: "Used for video posts.", showIf: { key: "post_type", equals: "post" } },
    {
      key: "text_format_preset_id",
      label: "Background",
      type: "select",
      help: `Coloured background for text-only posts up to ${PRESET_MAX_CHARS} characters.`,
      options: [{ value: "", label: "None" }, ...PRESETS.map(([value, label]) => ({ value, label }))],
      default: "",
      showIf: { key: "post_type", equals: "post" },
    },
  ],
  capabilities: {
    maxLength: 63206,
    text: "optional",
    media: { images: 20, videos: 1, mixed: false, required: false },
    thread: true,
    threadLabel: "Comments",
  },

  validate(post) {
    const type = post.settings?.post_type ?? "post";
    const videos = post.media.filter((m) => m.kind === "video").length;
    const errors: string[] = [];
    if (type === "reel" && (post.media.length !== 1 || videos !== 1)) errors.push("A Facebook Reel needs exactly one video");
    if (type === "story" && !post.media.length) errors.push("A Facebook story needs at least one photo or video");
    if (type === "post" && !post.content.trim() && !post.media.length && !post.settings?.url) errors.push("Facebook posts need text, a link or media");
    return errors;
  },

  authorize(ctx, { state }) {
    requireApp(ctx, "Facebook", "clientId", "clientSecret");
    return facebookAuthorizeUrl(ctx, state, SCOPES);
  },

  async callback(ctx, { code }) {
    requireApp(ctx, "Facebook", "clientId", "clientSecret");
    const { token } = await facebookUserToken(ctx, code);
    const pages = await facebookPages<Page>(ctx, token, "id,name,username,access_token,picture.type(large),tasks");
    const usable = pages.filter((p) => p.access_token && (!p.tasks || p.tasks.includes("CREATE_CONTENT")));
    if (!usable.length) throw new ProviderError("No Facebook Page with content permissions was granted. Select at least one Page you manage.", "invalid");
    const metaUserId = await facebookUserId(ctx, token);
    return usable.map((p) => ({
      externalId: p.id,
      name: p.name,
      username: p.username ?? null,
      avatarUrl: p.picture?.data?.url ?? null,
      profileUrl: `https://www.facebook.com/${p.username ?? p.id}`,
      // Page tokens obtained from a long-lived user token do not expire.
      credentials: { accessToken: p.access_token },
      expiresAt: null,
      meta: { pageId: p.id, metaUserId },
    }));
  },

  async profile(ctx, account) {
    const page = await graph<Page>(ctx, `${FB_GRAPH}/${account.externalId}`, { token: pageToken(account), query: { fields: "picture.type(large)" } });
    return { avatarUrl: page.picture?.data?.url ?? null };
  },

  async publish(ctx, account, post) {
    const errors = facebook.validate!(post);
    if (errors.length) throw new ProviderError(errors.join("; "), "invalid");
    const token = pageToken(account);
    const type = post.settings?.post_type ?? "post";

    if (type === "story") {
      // Upload everything first (invisible until the story publish calls in checkStatus).
      const items: Array<{ kind: "photo" | "video"; id: string }> = [];
      for (const m of post.media) {
        items.push(m.kind === "video" ? { kind: "video", id: await hostedUpload(ctx, account, "video_stories", m) } : { kind: "photo", id: await uploadPhoto(ctx, account, m) });
      }
      return pending({ kind: "story", items, done: 0 }, 5);
    }

    if (type === "reel") {
      const videoId = await hostedUpload(ctx, account, "video_reels", post.media[0]);
      return pending({ kind: "reel", videoId, finished: false, description: post.content }, 10);
    }

    const video = post.media.find((m) => m.kind === "video");
    if (video) {
      const res = await graph<{ id: string }>(ctx, `${FB_GRAPH}/${account.externalId}/videos`, {
        method: "POST",
        token,
        json: { file_url: video.url, description: post.content || undefined, title: post.settings?.title || undefined, published: true },
        // Creates the (published) video post: the commit.
        commit: true,
      });
      return pending({ kind: "video", videoId: res.id }, 20);
    }

    return publishFeed(ctx, account, post);
  },

  async checkStatus(ctx, account, raw) {
    const state = raw as unknown as FbState;
    const token = pageToken(account);
    const pageId = account.externalId;

    if (state.kind === "video") {
      const status = await videoStatus(ctx, token, state.videoId);
      if (status.video_status !== "ready") return pending(state, 20);
      return {
        status: "published",
        externalId: state.videoId,
        url: await permalink(ctx, token, state.videoId, `https://www.facebook.com/${pageId}/videos/${state.videoId}`),
      };
    }

    if (state.kind === "reel") {
      const status = await videoStatus(ctx, token, state.videoId);
      if (!state.finished) {
        if (status.uploading_phase?.status !== "complete") return pending(state, 10);
        // One video id = one reel, but whether a failed finish published it is unknown: treated as the commit.
        await graph(ctx, `${FB_GRAPH}/${pageId}/video_reels`, {
          method: "POST",
          token,
          json: { upload_phase: "finish", video_id: state.videoId, video_state: "PUBLISHED", description: state.description || undefined },
          commit: true,
        });
        return pending({ ...state, finished: true }, 15);
      }
      const live = status.video_status === "ready" || status.publishing_phase?.status === "complete";
      if (!live) return pending(state, 15);
      return { status: "published", externalId: state.videoId, url: `https://www.facebook.com/reel/${state.videoId}` };
    }

    // Stories: publish one item per call so progress is persisted between items.
    const item = state.items[state.done];
    if (item.kind === "video") {
      const status = await videoStatus(ctx, token, item.id);
      if (status.uploading_phase?.status !== "complete" && status.video_status !== "upload_complete" && status.video_status !== "ready")
        return pending(state, 10);
    }
    const res = await graph<{ post_id?: string; id?: string }>(ctx, `${FB_GRAPH}/${pageId}/${item.kind === "video" ? "video_stories" : "photo_stories"}`, {
      method: "POST",
      token,
      json: item.kind === "video" ? { upload_phase: "finish", video_id: item.id } : { photo_id: item.id },
      commit: true,
    });
    const postId = res.post_id ?? res.id ?? item.id;
    const done = state.done + 1;
    if (done < state.items.length) return pending({ ...state, done, lastPostId: postId }, 5);
    return { status: "published", externalId: postId, url: `https://www.facebook.com/stories/${pageId}/` };
  },

  async reply(ctx, account, target, post) {
    const image = post.media.find((m) => m.kind === "image");
    if (post.media.some((m) => m.kind === "video")) throw new ProviderError("Facebook comments cannot contain videos", "invalid");
    if (post.media.length > 1) ctx.log("warn", "Facebook comments support one image; only the first is attached");
    const res = await graph<{ id: string }>(ctx, `${FB_GRAPH}/${target.rootId}/comments`, {
      method: "POST",
      token: pageToken(account),
      json: { message: post.content || undefined, attachment_url: image?.url },
      commit: true,
    });
    return { externalId: res.id, url: commentUrl(target.rootId, res.id) };
  },

  // Two sub-requests per post (node counts + insights) in one Graph Batch API fetch.
  metrics: { post: ["views", "reach", "likes", "comments", "shares", "clicks"], account: ["followers"], batch: GRAPH_BATCH_MAX / 2, scopes: METRICS_SCOPES },

  async postMetrics(ctx, account, items) {
    const urls = items.flatMap(({ externalId: id }) =>
      isVideo(id) ? [`${id}?fields=${VIDEO_FIELDS}`, `${id}/video_insights`] : [`${id}?fields=${POST_FIELDS}`, `${id}/insights?metric=${POST_INSIGHTS}`],
    );
    const replies = await graphBatch(ctx, pageToken(account), urls);
    const result: PostMetricsResult = {};
    items.forEach(({ externalId: id }, i) => {
      const node = replies[2 * i];
      const insights = replies[2 * i + 1];
      if (!node || !insights) return; // not fetched: stays due
      if (!node.ok) {
        if (metricsFailure("Facebook", METRICS_SCOPES, node) === "invalid") ctx.log("warn", `Facebook metrics of ${id}: ${node.body?.error?.message ?? node.status}`);
        result[id] = null;
        return;
      }
      result[id] = fbMetrics(id, node.body, insights, ctx);
    });
    return result;
  },

  async accountMetrics(ctx, account) {
    const res = await metricsGet(ctx, `${FB_GRAPH}/${account.externalId}`, { token: pageToken(account), query: { fields: "followers_count,fan_count" } }, "Facebook", METRICS_SCOPES);
    const out: MetricValues = {};
    if (typeof res?.followers_count === "number") out.followers = res.followers_count;
    if (typeof res?.fan_count === "number") out.extra = { fans: res.fan_count };
    return out;
  },
};
