# Provider implementation brief (for contributors / agents)

Postflare is a self-hosted social scheduler running entirely on Cloudflare Workers (Hono API, D1, R2, Workflows).
Each platform is one file in `worker/providers/<id>.ts` exporting a `Provider` object (see `worker/providers/types.ts`).

## Read first
- `worker/providers/types.ts` — the contract. `worker/providers/http.ts` — `request`, `requestJson`, `oauthToken`, `expiresAt`, `requireApp`, `clientFields`, `sleep`. `worker/providers/errors.ts` — `ProviderError(kind)`.
- `worker/providers/webhook.ts` — a small finished example.
- `worker/workflow.ts` — how publish / checkStatus / reply are called (each is one workflow step; failures are classified, see "Commit semantics").
- `http.ts` also has `commit: true`, `commitCall` and `checkedCommit` for the request that creates the post (see "Commit semantics").
- `test/helpers.ts` — `mockFetch`, `testContext`, `testAccount`, `image()`, `video()` for tests.
- Reference implementation ([Postiz](https://github.com/gitroomhq/postiz-app), AGPL-3.0, NestJS):
  [`libraries/nestjs-libraries/src/integrations/social/<name>.provider.ts`](https://github.com/gitroomhq/postiz-app/tree/main/libraries/nestjs-libraries/src/integrations/social)
  and the per-provider settings DTOs in
  [`libraries/nestjs-libraries/src/dtos/posts/providers-settings/`](https://github.com/gitroomhq/postiz-app/tree/main/libraries/nestjs-libraries/src/dtos/posts/providers-settings).
  Use it to learn the endpoints, scopes, quirks and settings; rewrite for our contract. Do not copy NestJS/Prisma structure.
  Double-check endpoints against your own knowledge of the current official API docs; prefer the current API version.

## Rules
- Runtime is Cloudflare Workers (+ nodejs_compat). No Node-only libs (no sharp, googleapis, form-data, twitter-api-v2, axios). Use `ctx.fetch` (never global fetch) via the http helpers so tests can mock it. Web FormData/Blob/crypto.subtle are available. `@noble/curves` and `@noble/hashes` are installed if you need secp256k1/ed25519.
- Memory is 128MB: never load a whole large video into memory. Use `ctx.media.rangeStream(item, offset, length)` for chunked uploads, `mediaBody(ctx, item)` / `ctx.media.stream(item)` for streaming, or let the platform pull `item.url` (public, supports Range) when the API supports pull-from-URL. `ctx.media.image(item, { maxWidth, format, quality })` resizes/re-encodes images (use for size limits / unsupported formats). See "Free plan budget" below.
- Map failures to `ProviderError` kinds: expired/revoked token that refresh cannot fix → "auth"; invalid content/settings → "invalid"; 429 → "rate_limit"; 5xx/network before the post is created → "transient"; 5xx/network on the request that creates it → "ambiguous" (see "Commit semantics"). `request()` already maps by status; pass `classify` for APIs that return 200/400 with error codes (e.g. Meta error code 190 → auth).
- Long processing (video transcoding, Instagram containers, TikTok publish status, YouTube processing if you need it): return `{ status: "pending", state, retryAfterSeconds }` from `publish` and implement `checkStatus(state)` which must never re-post. Never busy-wait more than ~30s inside publish.
- `publish` returns `externalId` and the public `url` of the post whenever it can be derived.
- Mark the request that creates the post `commit: true` ("Commit semantics" below). Set `hotlinksMedia: true` when published posts keep pointing at our media URLs (`item.url`: `/m/` links, or the R2 custom domain when `MEDIA_PUBLIC_URL` is set) (markdown/HTML images, embeds, URLs the platform does not copy): the retention sweep then never deletes that media.
- When the platform says when the refresh credential expires, return `refreshExpiresAt` (ms) from `callback`/`connect` and `refresh` (see "Refresh-token expiry").
- Threads/comments: set `capabilities.thread = true` + `threadLabel`, implement `reply(ctx, account, {rootId, parentId, rootData, parentData}, post)`. Chain-style platforms reply to `parentId`; comment-style platforms (Facebook, Instagram, LinkedIn, YouTube...) comment on `rootId`. Use `data` to pass extra ids (e.g. Bluesky cid/uri). Return the reply's own public `url` when it can be derived (Facebook `<post>?comment_id=`, YouTube `&lc=`, the reply's post URL on X/Threads/Bluesky). When the platform has no public link to one comment (Instagram, LinkedIn...), return the commented post's URL with `urlIsPost: true`. The workflow logs every follow-up on the post ("First comment posted: <url>", "First comment posted on <post url> (comment id …)", "Follow-up 2 posted (id …)"), failures as warnings.
- OAuth2: `authorize` builds the URL with `ctx.redirectUri`, `state`, and PKCE (`codeChallenge`, S256) when the platform supports it. `callback` exchanges the code (use `codeVerifier` when PKCE) and returns one `ConnectedAccount` per postable identity (e.g. every Facebook Page, every LinkedIn organisation, every YouTube channel). Store tokens in `credentials`, non-secret ids in `meta`, `expiresAt` in ms. Implement `refresh` when tokens expire.
- Profile pictures: return the platform's `avatarUrl` from `callback`/`connect`; it is copied into R2 (lib/avatars.ts). When the platform's picture URLs are signed and expire (Meta CDN, TikTok), also implement `profile(ctx, account)` → `{ avatarUrl }` (one cheap request): the cron re-reads it about weekly to refresh the copy.
- `appFields` = developer app config (usually `clientFields()`), entered on the Platforms page. Include `docsUrl` (where to create the app) and `setupNotes` — short markdown steps: where to create the app, which products/permissions/scopes to enable, and the redirect URL `{{redirectUri}}` to whitelist. If the platform needs no developer app (credentials auth), `appFields: []`.
- `credentialFields` for credentials auth (app password, bot token, API key, instance URL...). `connect` must verify the credentials with a real API call and return the account(s).
- `settingsFields` = per-post options (title, privacy, board, subreddit, channel, post type...). Use `dynamicOptions: true` + `options(ctx, account, key, settings)` for values loaded from the account (boards, channels, playlists, subreddits, flairs, categories). Use `showIf` for conditional fields. Give sensible `default`s. Be complete: cover the useful options Postiz offers for that platform.
- `capabilities`: accurate max length, media limits, mixed media, required media; `mediaNote` when attached media has a non-obvious role (YouTube: the image becomes the custom thumbnail). It is shown under the composer's media picker, in MCP `list_platforms` and `postflare platforms <id>`.
- Brand `color` (hex without #) and `icon` = simple-icons slug (https://simpleicons.org) when one exists. `name` is the display name (e.g. "LinkedIn Page", "Instagram (Facebook login)").
- `category`: social | video | community | blog | messaging | newsletter.
- Comment density: match `worker/` — short doc comments on non-obvious things, no noise.

## Commit semantics (no double posts)
Publishing is not blindly retried. Every publish / checkStatus / reply call gets `ctx.commit = { sent, accepted }`
(`CommitState` in types.ts); the workflow reads it after the call to decide what a failure means.
- **The commit** is the request that creates the post or makes it public: X `POST /2/tweets`, Meta `media_publish` /
  `threads_publish` (often in `checkStatus`), Facebook feed / video with `published: true` / reel finish / story publish,
  LinkedIn `POST /rest/posts`, TikTok photo `content/init` and the last video chunk, Telegram `send*`, Discord / Slack
  message posts, blog post creates (DEV, Hashnode, Medium, WordPress), Pinterest `POST /pins`, Reddit submit, comments
  and replies... Media upload init/append/finalize, invisible containers / drafts, status polls and lookups are not
  commits: they keep their normal (retryable) kinds.
- Mark it: `request(ctx, url, { ..., commit: true })` (also through `requestJson` and provider wrappers that pass
  `RequestOptions` along). It sets `commit.sent` before the fetch and `commit.accepted` on 2xx. A network error,
  timeout (408) or 5xx then throws `ProviderError("ambiguous")`: the post may exist, so it is never retried
  automatically and goes to `needs_check` (the user confirms). 429 stays `rate_limit` and 4xx stay `invalid` / `auth`:
  definite refusals, nothing was created. A classifier's "transient" on a commit becomes "ambiguous".
- `commitCall(ctx, fn)` wraps a commit that does not go through `request` (a provider's own fetch, websockets): unknown
  and transient errors become "ambiguous", definite refusals pass through.
- `checkedCommit(ctx, send, check)` for APIs that report refusals in a 2xx body (Graph `error`, Slack `ok: false`,
  Reddit `json.errors`, GraphQL `errors`, Telegram `ok: false`, Twitch/Kick `is_sent: false`): `check` throws on such a
  body and `accepted` is restored, so the refusal fails normally instead of going to `needs_check`.
- The workflow: `accepted` + any later error → `needs_check` (the post exists); `sent` + an unknown (non-ProviderError)
  exception → `needs_check`; nothing sent → normal classification (retry `transient` / `rate_limit`, fail `invalid` /
  `auth`). Several commits in one call (a Telegram album then the long text, Slack file share): mark each.
- **Never swallow a commit failure** into `pending` or a retry: catch blocks that turn retryable upload errors into
  `pending` (X, LinkedIn, YouTube, TikTok...) must only wrap uploads, never the commit ("ambiguous" is not retryable,
  so `err.retryable` checks already let it through). Do not "retry once with other parameters" after an ambiguous
  failure (Facebook's text-preset fallback only retries after `invalid`).
- **Staying retryable** is allowed only when the platform deduplicates the create, and must be documented with a
  comment at the call: an idempotency key (Mastodon `Idempotency-Key`, VK `guid`, Neynar `idem`, the webhook's
  `Idempotency-Key` header), a lookup before the create (Listmonk campaign named after the post; a failed lookup must
  fail the call, not be ignored), a deterministic id (Bluesky rkey from `postTid(post)` + getRecord on any failed
  create; Nostr `created_at` from the post so the event id is stable and relays answer `duplicate:`), or a resumable
  session that creates at most one object (YouTube: a lost final PUT is resumed by probing the same session, which
  answers 200/201 with the created video; on that answer the provider marks `accepted` itself).
- `PublishPost.createdAt` never changes (use it for ids that must survive user retries); `scheduledAt` is stable
  across automatic retries of one publish. Reply posts have ids `${postId}-r${n}`.
- Tests: `test/providers/commit.test.ts` — a network error on the create call → "ambiguous" with `commit.sent`; a
  failure before it → its normal kind with `commit.sent === false`.

## Refresh-token expiry
`ConnectedAccount.refreshExpiresAt` / `CredentialsUpdate.refreshExpiresAt` (ms) = when the credential
`refresh` uses stops working; the cron refreshes the account well before it. Return it when the platform says:
`refresh_expires_in` (TikTok), `refresh_token_expires_in` (LinkedIn, Pinterest, TikTok Business, Google when the grant
is time-limited), the refresh JWT's `exp` (Bluesky), or the long-lived token's own expiry when it refreshes itself
(Instagram login `ig_refresh_token`, Threads `th_refresh_token`). Leave it out of a refresh result when unknown
(undefined = unchanged).

## Free plan budget
Postflare runs on the Workers Free plan. Each workflow step (one `publish`, `checkStatus` or `reply` call) is one invocation with ~10ms CPU (time spent waiting on the network does not count), 50 external subrequests (every `fetch`, including WebSocket relays; R2/D1 bindings are separate) and 128MB memory.
- **Zero-copy media.** Never copy media bytes through JS: no `media.bytes` / `media.range` / `media.blob` / `arrayBuffer()` for uploads. Raw bodies: `mediaBody(ctx, item)` (whole file) or `ctx.media.rangeStream(item, offset, length)` (a chunk), passed straight as the fetch body with `duplex: "half"`; both are fixed-length, so Content-Length is sent. Multipart: `streamingMultipart` with `mediaPart(ctx, name, item)` or `open: () => ctx.media.rangeStream(...)` (file parts are piped natively). Prefer a raw body when the API allows it. Only small payloads that must exist in memory may be buffered (an image re-encoded by `ctx.media.image`, a ≤1MB link thumbnail of unknown size).
- **At most 40 fetches per call** (`MAX_FETCHES` in `worker/providers/budget.ts`), leaving room for a token refresh. Count the worst case (max media count × fetches per item, mention lookups, relays...). Wrap the context with `counted(ctx)` and check `left()` before each fetch in loops.
- **Chunked uploads resume across calls.** Use big chunks the API accepts, but small enough that a failed one is cheap to redo and stays inside the 5 min request timeout (YouTube 32MiB PUTs, TikTok 64MB, X 4MB segments, LinkedIn's dictated parts). When the budget (or ~2-3 min of wall time) is used, return `pending` with a state that holds everything needed to continue (upload URL / media id / next offset or part / collected ETags) and continue in `checkStatus`. A resume must never re-create the upload or the post. Catch retryable errors mid-upload and return `pending` with the progress so far instead of throwing.
- **Bounded polling.** "Wait for processing" loops inside one call count fetches: bound them by a poll count or `left()` (keeping the fetches still needed after the loop), not only by time. `reply()` cannot return `pending`, so reject (as `invalid`) media that cannot be uploaded and polled within one call, and throw `transient` when processing is still running at the bound.
- Tests: for big videos use `hollowMedia(ctx)` (1-byte streams) and assert per-call request counts ≤ 40 and resume-from-serialized-state; use `noCopy(ctx)` to fail if bytes are copied.

## Metrics (analytics)
Optional. The cron collects metrics of published posts (about 1h, 24h, 3d, 7d and 30d after publishing, then weekly until
90 days) and account metrics once a day (`worker/lib/metrics.ts`); the Analytics API reads the stored snapshots.
- Contract (`worker/providers/types.ts`): `metrics: { post: MetricKey[]; account: MetricKey[]; batch?; scopes? }` describes
  what you report (shown to the UI as `ProviderInfo.analytics`); `postMetrics(ctx, account, items)` returns
  `{ [externalId]: MetricValues | null }`; `accountMetrics(ctx, account)` returns `MetricValues`.
- `MetricValues` keys (all optional numbers): impressions, reach, views, likes, comments, shares, saves, clicks, replies,
  reposts, quotes, followers, following, posts, plus `extra: Record<string, number>` for platform-specific numbers.
  Only set a key when the platform reports it (0 is a value; missing means "not reported"). Map platform names to the
  closest key: Instagram `saved` → saves, Threads `reposts` → reposts, YouTube subscribers → followers, Bluesky likes → likes,
  Mastodon favourites → likes and reblogs → reposts, Reddit score → likes (+ `extra.upvote_ratio`).
  Engagements = likes + comments + shares + saves + replies + reposts + quotes + clicks (`engagements()` in
  `shared/types.ts`); engagement rate is measured against views, else impressions, else reach. Do not double count:
  never put the same interactions in two keys (e.g. Instagram `total_interactions` goes to `extra`). Watch time keys
  (`watchTimeMinutes`, `avgViewDurationSeconds`, `avgViewPercentage` 0-100) are averages/totals per post, never summed.
  Structured data (a retention curve, views per traffic source) goes into `details` (`MetricDetails`): it is stored with
  the snapshot only (not `posts.metrics`) and returned once as `PostMetricsDTO.details` (latest snapshot that has it).
- Batching: set `metrics.batch` to the API's max ids per request (YouTube 50, X 100, TikTok 20, Reddit 100, Bluesky 25...)
  and fetch the whole batch in one request. For per-post APIs keep `batch` small (≤ 10) and check `fetchesLeft(ctx)`
  (`budget.ts`) before each fetch: items you did not fetch are simply left out of the result (they stay due).
  `null` for an item = the platform has no metrics for it (deleted, private, unknown id); it backs off and eventually stops.
- Errors: a missing analytics permission/scope must throw `MetricsUnavailableError("reconnect_required", ...)` (or
  `missingScope(platform, scopes)`) from `errors.ts`, never ProviderError("auth"): an analytics failure must not mark the
  account as needing a reconnect for publishing. `MetricsUnavailableError("not_supported")` when the account type has no
  analytics (e.g. personal accounts). Other failures: normal ProviderError kinds (the collector backs off).
  Tokens are refreshed by the collector before the call (`freshAccount`).
- Add the analytics scopes to the requested OAuth scopes and to `setupNotes` (existing accounts must reconnect). If the
  platform refuses the whole login when a scope is not approved for the app (TikTok), make them opt-in with an app
  field (see `analytics` in `tiktok.ts`) and throw `MetricsUnavailableError("not_supported")` while it is off.
- `items[].data` is the `data` publish returned (stored in `posts.external_data`; absent for posts published before
  analytics existed). Use it for ids that are not the externalId (Bluesky cid, Instagram story frames, TikTok post id).
- Collector (`worker/lib/metrics.ts`): one `postMetrics` call per `metrics.batch` due posts of an account, with a
  counted context limited to the fetches left in the cron tick (35 per tick). Results: values → snapshot in
  `post_metrics` + `posts.metrics`, next checkpoint; `null` → backoff (1h, 2h, 4h... gives up after 6 failures);
  absent → still due. `MetricsUnavailableError` / ProviderError("auth") → `accounts.metrics_status`
  (reconnect_required / not_supported, re-checked weekly or on reconnect); other errors → `error` + backoff.
  Demo workspaces never reach providers (lib/demo-metrics.ts generates the numbers).
- Tests: batching (one request per batch, ids joined), mapping to normalized keys, missing items → null, budget
  (per-post APIs stop at `fetchesLeft`), and the reconnect-required signal (e.g. a 403 scope error → MetricsUnavailableError).

## Tests (required)
Write `test/providers/<id>.test.ts` with vitest using `mockFetch` + `testContext`. Cover at least: authorize URL params, callback/connect → accounts, refresh (if any), publish text, publish with media (image and video where supported, including chunked/pending flows), reply (if supported), options (if any), and error mapping (401 → auth). Run with `npx vitest run test/providers/<id>.test.ts`.

## Do not
- Do not edit files outside your assigned providers and their tests. If the shared contract truly blocks you, work around it inside your file and report what change you would want.
- Do not run git commit / git add. Do not run npm install (ask in your report if you need a package).
- Typecheck: `npx tsc --noEmit -p tsconfig.worker.json 2>&1 | grep -E "providers/(<your ids>)"` — other agents are editing other providers concurrently, so ignore errors in files that are not yours.
