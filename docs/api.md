# Postflare REST API

Base: `https://<host>/api`. JSON in and out; errors are `{ "error": "message" }` with a 4xx/5xx status (validation
errors also carry `errors: string[]`). Types: [`shared/types.ts`](../shared/types.ts). Authentication: the web app's
session cookie (plus `X-Workspace-Id`), the iOS app's device token `Authorization: Bearer pfd_...` (acts like the
session, plus `X-Workspace-Id`), or `Authorization: Bearer pf_...` (an API key bound to one workspace, created in
Profile). Every endpoint is workspace-scoped: ids of other workspaces answer 404. Permissions are listed per endpoint
(catalog: [workspaces-spec.md](workspaces-spec.md)).

This file documents the account connection, account group, App Store campaign, hosted mode (plans, billing, sign-up), bot protection, iOS app and media URL endpoints in detail
and lists the changes they brought to existing endpoints. The rest of the API (accounts, media, posts, analytics, playbooks, users, workspaces) is summarized in the
README ("API & MCP", "Analytics", "Playbooks") and typed in `shared/types.ts`.

## Connecting accounts

- `GET /connect/:provider/url` (`accounts.manage`) → `{ url }`: the platform's authorization URL (OAuth providers).
  `?switchAccount=1` asks the platform to show its login again so another account can be picked; only providers whose
  `ProviderInfo.switchAccount` (`{ label, note }`) is set honour it, the others ignore it. Instagram (Instagram login)
  then adds `force_reauth=true`, which signs the user out of instagram.com in that browser: the default link never
  does. The connect dialog shows it as a "Use a different Instagram account" link with that warning.
- `AccountDTO.avatarUrl`: a copy of the platform's profile picture in R2, because Instagram / Facebook / TikTok (and
  other) picture URLs are signed and expire within days. Copied when the account is connected or reconnected (up to
  10 per login, JPEG/PNG/GIF/WebP by magic bytes, ≤ 1 MB, https only, 5 s timeout) to
  `avatars/<account id>-<content hash>.<ext>` and served as `<MEDIA_PUBLIC_URL>/avatars/<name>` or, without a media
  domain, the signed `/m/avatars/:sig/:name` (public, immutable). A failed copy never fails the connect: the
  platform's URL is kept and retried. The frequent cron re-checks a couple of accounts per tick (never copied ones
  first, then each about weekly; failures after a day, `accounts.avatar_checked_at`, migration 0018): a fresh URL from
  the provider's `profile()` (Instagram, Instagram via Facebook, Facebook, Threads, TikTok), else the stored one. So
  accounts connected before this get their copy within hours, with no manual step. `POST /accounts/:id/refresh` also
  re-copies it. A replaced picture's old copy, and all copies of removed accounts (and of deleted workspaces), are
  deleted from R2. Clients keep falling back to initials when an image fails to load.
- Publishing log (`PostDTO.logs`): every follow-up the workflow posts is logged as `info`, "First comment posted:
  <url>" on comment-style platforms ("Comment 2 posted…"), "Follow-up N posted: <url>" otherwise (`(id …)` when the
  platform gives no URL); failed ones stay `warn`.

## Account groups

Workspace-scoped "brand / project" folders for accounts (migration `0010_account_groups.sql`). An account is in at most
one group; deleting a group ungroups its accounts. Reading needs `accounts.read`, every change `accounts.manage`. Ids of
other workspaces answer 404, and a group of another workspace can never be assigned.

- `GET /account-groups` → `AccountGroupDTO[]` `{ id, name, color, position, accountCount, createdAt, updatedAt }`, in
  display order.
- `POST /account-groups` `{ name, color? }` → 201 `AccountGroupDTO`. `name`: 1–50 characters, unique per workspace
  (case-insensitive, 409 otherwise). `color`: one of `zinc red orange amber green teal sky indigo violet pink`
  (`shared/accountGroups.ts`); without one the palette is cycled. New groups go last.
- `PATCH /account-groups/:id` `{ name?, color?, position? }` → `AccountGroupDTO`. `position` moves the group to that
  index (clamped) and renumbers the others.
- `DELETE /account-groups/:id` → `{ ok, ungrouped }` (number of accounts that became ungrouped).
- `PATCH /accounts/:id` `{ groupId }` (group id or `null`; `status` still works, alone or together) → `AccountDTO`.
- `POST /accounts/group` `{ accountIds: string[], groupId: string | null }` → `{ ok, updated, groupId }`: bulk move
  (at most 500 ids, one statement). Any id not in the workspace → 404 and nothing changes.
- `AccountDTO.groupId` (`null` = ungrouped). `GET /posts?accountGroupId=<id>|none`: posts of the group's accounts.
- MCP: `list_accounts` returns each account's `group: { id, name }` (absent when ungrouped) and takes `group` (id or
  name, `"none"` = ungrouped); `list_account_groups` lists `{ id, name, accounts }`.
- CLI: `pf groups [create|rename|rm]`, `pf accounts` GROUP column and `--group`, `pf accounts group <account...> --to
  <group|none>`, and the `group:<name|id>` account selector (`pf post -a "group:Party Games"`: every enabled account of
  the group).

## App Store campaign links

Posts about one of your App Store apps get a **tracked link** `https://<host>/a/<code>` (8 base62 characters) that
counts clicks and redirects (302) to Apple's campaign link:

```
https://apps.apple.com/app/apple-store/id<APP_ID>?pt=<PROVIDER_TOKEN>&ct=<CAMPAIGN_TOKEN>&mt=8
```

This is the format Apple documents in App Store Connect Help,
[Campaign links](https://developer.apple.com/help/app-store-connect-analytics/acquisition/campaign-links)
(`pt` = provider token, one per developer account; `ct` = campaign token, "up to 30 alphanumeric characters and spaces"
plus some punctuation; `mt=8` = apps).

- **Campaign tokens**: `pf-<platform>-<10 chars derived from the post id>` (e.g. `pf-x-0k3j9a8z1q`, `pf-bsky-…`),
  lowercase `[a-z0-9-]`, at most 18 characters, stable for a post (a post belongs to one account, so one platform).
  Bio links: `pf-<platform>-bio` (`-bio-2`, `-bio-3` for further accounts of the same platform and app).
- **Where links are created**: posts tagged with an app (`appId`) on clickable platforms: X, Threads, Bluesky,
  LinkedIn (profile and page), Facebook, Pinterest (destination link), Reddit, Mastodon, YouTube (description),
  Telegram, Discord, Slack, Tumblr, Lemmy, Farcaster, Nostr, VK. Instagram and TikTok captions are not clickable:
  use the account's bio link (`POST /api/campaigns/bio-links`).
- **Auto-insert** (workspace setting `autoLink`, per post `autoLink: true|false`): when a post is created or updated,
  App Store URLs of its app (`apps.apple.com/…/id<n>…`, without their own `ct=`) in the text and follow-ups are
  replaced by the tracked link, Pinterest's destination link / Reddit's link URL are filled, and the link is appended
  when the post has no link at all. A change that would exceed the platform's limit is skipped (X counts a URL as 23)
  and logged on the post. Rewriting happens at create/update time, so the post shows the exact text that will be
  published; the publish workflow is unchanged.
- **Results**: clicks are counted by Postflare (one counter per link and UTC day; crawlers, link-preview bots, HTTP
  libraries and HEAD requests are redirected but not counted). Downloads, redownloads, purchases, proceeds and sales
  per campaign token come from Apple App Analytics through an optional [Revflare](https://github.com/FerdiKT/revflare)
  connection, synced every 6 hours per workspace by the hourly analytics cron tick. Apple's numbers lag 2–3 days,
  campaign rows with fewer than 5 users are withheld (Detailed reports) and proceeds are Apple's estimate.

### Public redirect

`GET /a/<code>` (no auth): 302 to the App Store campaign link (`Cache-Control: private, no-store`,
`Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`); unknown or malformed codes answer a 404 HTML page. One D1
read, plus one upsert per counted click. Nothing about the post, account or workspace is exposed.

### Settings (`posts.read` to read, `workspace.manage` to change)

- `GET /campaigns/settings` → `CampaignSettingsDTO`
  `{ providerToken, autoLink, revflare: { url, keyConfigured, status, message, syncedAt, nextSyncAt, currency }, linkBase }`.
  The Revflare API key is never returned.
- `PUT /campaigns/settings` `{ providerToken?, autoLink?, revflareUrl?, revflareKey? }` → `CampaignSettingsDTO`.
  `revflareUrl`: https only, public hosts only (no localhost, private/link-local IPs, `.internal`/`.local` names;
  `http://localhost` is accepted only when Postflare itself runs on localhost); a trailing `/api/v1` is removed.
  `revflareKey`: `rf_...`, stored encrypted (AES-GCM, like platform credentials). `revflareKey: null` (or `""`)
  disconnects (synced numbers stay). New connection details schedule a sync on the next hourly tick.
- `POST /campaigns/test` `{ revflareUrl?, revflareKey? }` → `{ ok, error?, apps?, currency? }`: tests the given or stored
  connection (`GET /api/v1/apps` on Revflare, 10 s timeout, redirects not followed).
- `POST /campaigns/sync` → `{ ok, error?, campaigns?, currency?, asOf? }` (502 on failure): sync now
  (`GET /api/v1/acquisition/campaigns` and `GET /api/v1/acquisition?by=app,campaign&range=all`).

### Apps (`posts.read` to read, `workspace.manage` to change)

- `GET /apps` → `AppDTO[]` `{ id, appStoreId, name, iconUrl, revflareAppId, createdAt }`.
- `POST /apps` `{ appStoreId, name?, iconUrl? }` → 201 `AppDTO`. Without a name, name and icon come from the public
  iTunes lookup (`https://itunes.apple.com/lookup?id=<id>`). Adding an existing App Store id updates it.
- `POST /apps/import` → `{ imported, apps }`: apps with an App Store id from Revflare (`GET /api/v1/apps`).
- `DELETE /apps/:id`: posts lose the tag; tracked links already published keep redirecting.

### Links

- `GET /campaigns/links?postId&accountId&appId&kind=post|bio&limit` (`posts.read`) → `CampaignLinkDTO[]`
  `{ code, kind, trackedUrl, appStoreUrl, ct, postId, accountId, provider, appId, appStoreId, createdAt, clicks,
  downloads, redownloads, purchases, proceeds, sales, currency, asOf }` (App Store numbers `null` until reported).
- `POST /campaigns/bio-links` `{ accountId, appId }` (`posts.write`) → 201 `CampaignLinkDTO`: the account's bio link for
  the app, created on first use (needs the provider token).

### Changes to existing endpoints

- `POST /posts`: `appId` (workspace app id, App Store id or app name; 404 when not in the workspace) and `autoLink`
  (`true`/`false`, absent = workspace default). `PATCH /posts/:id`: the same; `appId: null` removes the tag. Edits keep
  the post's code and token; a new app points the same token at the new app. The text is rewritten only when the edit
  touches the text, settings, app or `autoLink` (a reschedule leaves it alone).
- `PostDTO`: `appId`, `autoLink`; `GET /posts/:id` adds `campaign: CampaignLinkDTO | null`.
- `GET /posts/:id/metrics` and `GET /analytics/posts` items: `campaign: { clicks, downloads, redownloads, purchases,
  proceeds, sales, currency, asOf } | null`. `GET /analytics/posts?sort=` also takes `clicks`, `downloads` (alias
  `installs`) and `proceeds`.
- `GET /analytics/summary`: totals, `byProvider` and `byAccount` rows add `campaignPosts`, `clicks`, `downloads`,
  `redownloads`, `proceeds` (posts published in the range); the summary adds `currency`.
- `GET /playbooks/stats?sort=lift|downloads|proceeds|downloadsPerPost|proceedsPerPost` (aliases `installs`, `revenue`):
  rows add `campaignPosts`, `clicks`, `downloads`, `proceeds`, `downloadsPerPost`, `proceedsPerPost`; the response adds
  `sort` and `currency`. Still one aggregate query.

### MCP

`create_post` / `update_post` take `appId` and `autoLink`; new tools `list_apps` and `get_bio_link`;
`get_post_metrics`, `get_top_posts` (sort `clicks`, `installs`, `proceeds`), `get_analytics_summary` and
`get_playbook_stats` (sort `installs`, `proceeds`, `installsPerPost`, `proceedsPerPost`) include clicks, installs and
proceeds.

### Revflare key permissions

Any Revflare workspace API key whose user can read the workspace (role viewer or above) works: Postflare only reads
`/apps`, `/acquisition` and `/acquisition/campaigns`. Revflare must import Apple's App Analytics reports for the apps
(App Store Connect key with the Admin role to create the report requests, see Revflare's docs).

## Hosted mode: plans, billing and sign-up

Design: [hosted-spec.md](hosted-spec.md). Everything is off by default (self-hosted instances see no difference). Billing
is **on** when an instance admin turned it on AND the active provider is configured AND an active paid plan exists;
only then are limits enforced, and never in exempt or demo workspaces. Types: `BillingDTO`, `PublicPlanDTO`,
`AdminPlanDTO`, `AdminBillingDTO`, `AdminWorkspaceBillingDTO`, `PlanLimitErrorDTO`, `SignupDTO` in `shared/types.ts`.

### Limit errors (402)

Actions the workspace's plan does not allow answer **402**
`{ error, code: "plan_limit", limit, used, max, upgradeUrl }` (`PlanLimitErrorDTO`). `limit` is a limit key or
`"locked"` (no active plan: the workspace is read-only, nothing can be created, scheduled or published; reading,
exporting and deleting still work). `upgradeUrl` = `<origin>/workspace?tab=billing`. MCP tools fail with the same
`error` text; the CLI prints it with the URL.

| key | counted as | checked by |
|---|---|---|
| `accounts` | accounts of the workspace that are not disabled | `POST /connect/:provider`, OAuth callbacks (only accounts new to the workspace; reconnects are free; over the limit they redirect to `/accounts?error=…&planLimit=accounts`), `PATCH /accounts/:id {status: "active"}` of a disabled account |
| `posts_per_month` | posts published or scheduled in a UTC calendar month, one per account (drafts and failed posts are free; deleting a published post does not free its slot, deleting or cancelling a scheduled one does) | `POST /posts` with a schedule or `"now"` (REST, MCP `create_post`, CLI, composer, duplicate), `PATCH /posts/:id` that schedules a draft/failed/cancelled post or moves it to another month, `POST /posts/:id/retry`; checked against the month each post is scheduled in |
| `x_posts_per_month` | the same, X accounts only | the same |
| `members` | members + pending invitations | `POST /invitations` (into a workspace), `POST /invitations/accept` (existing workspace) |
| `storage_mb` | sum of media sizes | `POST /media`, `POST /media/from-url`, `POST /media/multipart`, upload links (`/u/:token/file`, `/u/:token/multipart`) |
| `api` | boolean | `POST /keys`; every API-key request (REST, CLI, MCP) answers 402 when `false` |

The locked state also blocks `PATCH /posts/:id` that schedules, `POST /posts/:id/retry`, `POST /posts/:id/comments`,
`POST /posts/:id/resolve {published: false}`, `POST /upload-links`. The publish workflow fails posts of a locked
workspace with "This workspace has no active plan…" (already scheduled posts are not held to the other limits).

### Workspace

- `GET /billing` (`posts.read`) → `BillingDTO` `{ enabled, exempt, state, plan, subscribedPlanId, status, trialEndsAt,
  currentPeriodEnd, graceEndsAt, interval, provider, hasSubscription, usage, limits, plans, canManage }`.
  `state`: `unlimited` · `plan` · `trial` · `free` · `locked`. `status`: `none` · `trialing` · `active` · `past_due` ·
  `canceled` (paid until `currentPeriodEnd`) · `expired`. `usage` `{ accounts, postsThisMonth, xPostsThisMonth,
  members, storageMb }` (posts: the current UTC month, counted like the limits) and `plans` (pricing cards) only
  while billing is on. `limits: null` = unlimited.
- `POST /billing/checkout` `{ planId, interval: "month" | "year" }` (`billing.manage`) → `{ url }`: redirect there. The
  checkout returns to `/workspace?tab=billing&checkout=success|canceled`; the plan changes when the provider's webhook
  arrives (poll `GET /billing`). 409: billing off, exempt workspace, already subscribed through a provider (use the
  portal to change plans) or no provider; 400: free plan or interval not offered (`PublicPlanDTO.checkoutIntervals`);
  404: unknown or archived plan; 502: provider error (its message).
- `POST /billing/portal` (`billing.manage`) → `{ url }` (provider's customer portal: change plan, payment method,
  invoices, cancel). 409 without a provider subscription.

### Public

- `GET /billing/plans` → `PublicPlansDTO` `{ enabled, currency, plans }` (empty while billing is off): the pricing table
  of the landing and sign-up pages.
- `POST /billing/webhooks/:provider` (`polar` · `stripe` · `lemonsqueezy`): provider webhooks. No session, exempt from
  the same-origin check (and must be excluded from Cloudflare rate limiting rules). 404 when the provider is not
  configured, 400 on a bad signature, 200 otherwise (duplicates, ignored event types, unknown workspaces and stale
  events included: `{ ok, duplicate? | ignored? | stale?, workspaceId? }`).
- `GET /auth/status` adds `signupMode` (`apply` | `open`; absent = invitations only) and `signup: true` while sign-up
  is open (kept for older clients).
- `POST /auth/signup` `{ name, email, password, workspaceName? }` → `SignupDTO`. With email configured:
  `{ ok: true, verify: true }` (a link `/auth/verify#<token>` is mailed, valid 24 h; the same answer when the email
  already has an account, whose owner gets a "sign in instead" email). Without email: `{ ok: true, verify: false,
  workspaceId }`, signed in (409 for an existing email). 400 invalid input, 404 while off, 429 after 5 per IP per hour.
  New users get the instance Member role and own their first workspace (trial when billing is on).
- `POST /auth/signup/verify` `{ token }` → `{ ok, workspaceId }`, signed in (the `/auth/verify` page POSTs it on click).
  400 invalid, used or expired; 404 while sign-up is off.
- Pending (unverified) users cannot sign in (`POST /auth/login` → 403 "Confirm your email first…"), appear in
  `GET /users` with `status: "pending"` (an admin can `PATCH /users/:id {status: "active"}` them), and are deleted after
  7 days by the daily job.

### Instance admin

`instance.settings.manage`:
- `GET /admin/billing` → `AdminBillingDTO` `{ enabled, active, problems, activeProvider, providers, trialDays,
  pastDueGraceDays, signupEnabled, emailConfigured, limits }`. `providers[]`: `{ id, name, recommended, description,
  configured, sandbox, webhookUrl, events, fields: [{ key, label, secret, help?, set, value }], dashboardUrl }`; secrets
  are never returned (`set: true`, `value: null`). `limits`: the limit key catalog for the plan editor.
- `PATCH /admin/billing` `{ enabled?, activeProvider?, trialDays? (0–365, 0 = no trial), pastDueGraceDays? (0–90),
  signupEnabled? }` → `AdminBillingDTO`. Turning on is refused (400 `{ error, problems }`) until the active provider is
  configured and an active paid plan exists. The first time billing goes on, every workspace without a plan becomes
  exempt (the operator's own). Billing switches itself off (limits lifted) if the provider is removed or the last paid
  plan archived.
- `PUT /admin/billing/providers/:id` `{ values: { <field>: string }, sandbox? }` → `AdminBillingDTO`. Stored encrypted;
  an empty secret keeps the stored one. Fields: Polar `accessToken`, `webhookSecret` (+ `sandbox`); Stripe `secretKey`,
  `webhookSecret`; Lemon Squeezy `apiKey`, `storeId`, `webhookSecret`.
- `DELETE /admin/billing/providers/:id` → `AdminBillingDTO` (409 for the provider of new sales while billing is on).
- `POST /admin/billing/providers/:id/test` → `{ ok: true, account? } | { ok: false, error }` (one API call).
- `GET /admin/billing/plans` → `AdminPlanDTO[]` (archived included, `workspaces` = workspaces on the plan).
- `POST /admin/billing/plans` `PlanInput` → 201 `AdminPlanDTO`. `PlanInput`: `{ name, description?, features?:
  string[], limits?: { accounts?, posts_per_month?, x_posts_per_month?, members?, storage_mb?: number | null, api?:
  boolean | null }, priceMonth?, priceYear? (integer cents, null = not offered), currency? (ISO, default USD),
  providerPrices?: { polar?: { month?, year? }, stripe?: …, lemonsqueezy?: … } (product / price / variant ids),
  isFree?, isTrialDefault? (each on one plan at most: setting it clears the others), highlight?, position?, active? }`.
- `POST /admin/billing/plans/suggested` → 201 `AdminPlanDTO[]` (Free, Creator, Team without provider ids).
- `PATCH /admin/billing/plans/:id` (any `PlanInput` subset) → `AdminPlanDTO`.
- `DELETE /admin/billing/plans/:id` → `{ ok }`, or `{ ok, archived: true }` when workspaces are on it.
- `GET /admin/signup` / `PATCH /admin/signup { mode: "off" | "apply" | "open" }` → `AdminSignupDTO` `{ mode, enabled
  (mode is open), emailConfigured }`. Older clients may still send `{ enabled }` (true = open, false = off); the
  `signupEnabled` field of `PATCH /admin/billing` only switches open sign-up on or off and leaves `apply` alone.
- `GET /admin/overview` adds `billing: { enabled, paying, trialing, pastDue, manual, exempt, mrrCents, currency }` and
  `counts.users.pending`.

`instance.users.manage`:
- `GET /admin/billing/workspaces?status=active,trialing` → `AdminWorkspaceBillingDTO[]` (newest first, max 500)
  `{ workspaceId, workspaceName, demo, exempt, state, planId, planName, status, trialEndsAt, currentPeriodEnd, interval,
  provider, customerId, subscriptionId, updatedAt, createdAt }`.
- `GET /admin/workspaces/:id/billing` → `AdminWorkspaceBillingDTO`.
- `PATCH /admin/workspaces/:id/billing` `{ exempt?, planId? (null removes), status?, trialEndsAt?, currentPeriodEnd? }`
  → `AdminWorkspaceBillingDTO`. A plan set here gets provider `manual` and status `active` (or `trialing` with
  `trialEndsAt`); a provider subscription that still runs takes over again with its next webhook.

### Permissions

New workspace permission `billing.manage` (migration 0013: built-in Owner only). Everyone with `posts.read` reads
`GET /billing`.

## Access requests

Sign-up by application (`signup_mode` apply, [hosted-spec.md](hosted-spec.md) "Access requests"). Types:
`AccessRequestInput`, `AccessRequestDTO`, `AccessRequestListDTO`, `AccessRequestReviewInput`, `AccessRequestReviewDTO`
in [shared/types.ts](../shared/types.ts).

Public:
- `POST /access-requests` `{ name, email, company?, url, role, platforms, accounts?, volume?, useCase, referral?,
  consent: true, turnstileToken? }` → `{ ok: true }`, the same whether or not the email applied before or has an
  account (a pending request of that email is updated). `role`: `creator | agency | startup | brand | other`;
  `platforms`: one or more of `x, instagram, tiktok, youtube, linkedin, facebook, threads, bluesky, pinterest, other`;
  `volume` (posts per month): `1-30 | 31-100 | 101-300 | 301-1000 | 1000+`; `useCase` 20-1000 characters; `url` http(s)
  (a bare domain gets `https://`). 400 invalid input, 400 `code: "captcha"` (Turnstile action `apply`), 404 unless the
  mode is `apply`, 429 after 5 per IP per hour or 3 per email per day.

`instance.users.manage` (web session or iOS device token; API keys carry no instance permissions):
- `GET /access-requests?status=pending|approved|rejected|withdrawn|all&q=&limit=&before=` → `AccessRequestListDTO`
  `{ items, counts: { pending, approved, rejected, withdrawn }, nextBefore }`. Newest first; `q` searches name, email,
  company and link; `limit` 1-100 (default 50); pass `nextBefore` as `before` for the next page. `status` defaults to
  `all`.
- `GET /access-requests/count` → `{ pending }` (nav badge).
- `GET /access-requests/:id` → `AccessRequestDTO` `{ id, name, email, company, url, role, platforms, accounts, volume,
  useCase, referral, status, ip, country, userAgent, createdAt, updatedAt, reviewedBy: { id, name } | null,
  reviewedAt, reviewNote, invitationId, invitationAccepted, existingUser }`.
- `PATCH /access-requests/:id` `{ status: "approved" | "rejected", note? (≤ 1000), notify? (default true) }` →
  `AccessRequestReviewDTO` `{ request, invitation?: { id, url, expiresAt }, existingUser?: true, emailed }`.
  - Approve (pending, rejected or withdrawn): an invitation bound to the email (instance role Member, new workspace named
    after the company or "<name>'s workspace", 7 days), accepted with the normal `POST /invitations/accept`. Emailed
    when `notify` and email is configured (`emailed`); `invitation.url` is always returned. Approving an approved
    request whose invitation is unused returns a new link (the old one is revoked). An email that already has an
    account: only marked approved (`existingUser: true`, no invitation).
  - Reject (pending, or approved with an unused invitation, which is revoked): with `notify` and email configured a
    short polite email includes the note.
  - 409: already rejected, already approved for an existing account, invitation already accepted, or a concurrent
    review. 404 unknown id.
- 403 without the permission (401 signed out).

## Bot protection (Cloudflare Turnstile)

Off unless configured: both a site key and a secret key, from Admin → Settings or the `TURNSTILE_SITE_KEY` var +
`TURNSTILE_SECRET_KEY` secret (each env value wins over the stored one). Not used for API keys, invitations or the
first-run `POST /auth/setup`.

- `GET /auth/status` adds `turnstileSiteKey` (the widget's site key) while it is on.
- The widget token goes in the body as `turnstileToken`:
  - `POST /auth/signup` (widget action `signup`), `POST /access-requests` (action `apply`) and `POST /auth/magic-link`
    (action `magic_link`): always required.
  - `POST /auth/login` (action `login`): only once the IP (IPv6 /64) or the email has 3 or more failed sign-ins in the
    current 15 minute window. The 401 of the failure that reaches 3 carries `captchaRequired: true`; until the counters
    clear (a successful sign-in or 15 minutes) a request without a valid token answers 400 with `captchaRequired: true`.
- The token is checked with Cloudflare's siteverify (5 s timeout, `remoteip` from `cf-connecting-ip`, an
  `idempotency_key`) before any password hashing, database write or email: it must succeed, be solved on the request's
  hostname (or `PUBLIC_URL`'s) and carry the expected action. Answers to Turnstile's test secret keys skip the hostname
  and action checks (local testing).
- Failure: 400 `{ error: "The bot check failed. Try again.", code: "captcha" }`. Cloudflare unreachable (timeout,
  network error, 5xx, `internal-error`): 503 `{ error, code: "captcha_unavailable" }` (fails closed).

`instance.settings.manage`:
- `GET /admin/turnstile` → `AdminTurnstileDTO` `{ configured, siteKey, siteKeyFromEnv, secretSet, secretFromEnv }`.
  The secret is never returned.
- `PUT /admin/turnstile` `{ siteKey, secretKey? }` → `AdminTurnstileDTO`. The secret is stored encrypted; an empty or
  missing `secretKey` keeps the stored one. Values set by the env are ignored.
- `DELETE /admin/turnstile` → `AdminTurnstileDTO` (removes the stored keys; env keys stay in effect).
- `POST /admin/turnstile/test` `{ secretKey? }` (default: the effective secret) → `{ ok: true, testing? } | { ok: false,
  error }`: siteverify with a dummy token. `invalid-input-response` means the secret is valid, `invalid-input-secret`
  that it is wrong; `testing: true` for a Turnstile test secret (always passes).

## Legal pages

`/privacy/`, `/terms/` and `/data-deletion/` are rendered by the Worker (`worker/lib/legal.ts`; `/privacy` etc. redirect
with 307) with the operator's details below, the sign-up mode and, only while billing is on, the subscription terms
(provider, trial, free plan, grace days). Without operator values they keep the generic self-host wording. One D1 query,
`cache-control: public, max-age=300`, the app CSP. The paths must be in `assets.run_worker_first`; `public/` keeps
the generic rendering as a fallback (`test/legal.test.ts` keeps it in sync).

Instance admin (`instance.settings.manage`, Admin → Settings → Legal & contact):
- `GET /admin/legal` → `AdminLegalDTO` `{ operatorName, contactEmail, postalAddress, country, effectiveDate }` (null =
  not set). Settings keys `legal_operator_name`, `legal_contact_email`, `legal_postal_address`, `legal_country`,
  `legal_effective_date`.
- `PUT /admin/legal` (same shape, every key optional; `""` or null clears it) → `AdminLegalDTO`. 400 for an invalid email,
  a date that is not `YYYY-MM-DD`, or values over 200 (name), 254 (email), 500 (address), 100 (country) characters.

## iOS app

Full app-facing reference (request/response shapes, push payloads, loc keys): [ios-api.md](ios-api.md). Web sign-in
with the app: [app-login-spec.md](app-login-spec.md).

Public (`/auth`, before sign-in):
- `POST /auth/device` `{ email, password, deviceName, turnstileToken? }` → `DeviceTokenDTO` `{ token: "pfd_…",
  deviceId, user, instancePermissions, workspaces, currentWorkspaceId, server }`. Same throttle, bot check and refusals
  (pending, disabled) as `POST /auth/login`.
- `POST /auth/pair` `{ code, deviceName }` → `DeviceTokenDTO`. Codes are single use, 5 minutes; 10 wrong codes per IP
  in 15 minutes → 429.
- `POST /auth/device/logout` (device token) → `{ ok }`: revokes the token and its push registration.
- Web login requests: `POST /auth/app-login` `{ kind: "qr" } | { kind: "push", email, turnstileToken? }` →
  `AppLoginStartDTO`; `GET /auth/app-login/:id` (`X-Login-Secret`) → `AppLoginPollDTO` (sets the session cookie once
  approved); `DELETE /auth/app-login/:id`; app side (device token): `POST /auth/app-login/:id/inspect | approve |
  deny`. 404 while the instance has neither `APP_STORE_URL` nor a signed-in device; push needs APNs. 10 starts per IP
  and 3 push starts per email in 10 minutes.

Signed in (no workspace permission needed: devices belong to the user):
- `POST /pairing-codes` (web session only) → `PairingCodeDTO` `{ id, code, url: "postflare://pair?s=…&c=…",
  expiresAt }`; `GET /pairing-codes/:id` → `PairingStatusDTO` `{ status: pending | used | expired, deviceName }`.
- `GET /devices` → `{ items: DeviceDTO[], push }`; `DELETE /devices/:id` (`me` = the calling device) signs it out.
- Device token only: `PUT /devices/me` `{ apnsToken?, environment?, name?, prefs? }` → `DeviceDTO`;
  `PATCH /devices/me/prefs` `{ published?, failed?, workspaces? }` → `DeviceDTO`. `POST /devices/:id/test`.

A device token cannot create API keys (`POST /keys`) or pairing codes: credentials that would outlive its revocation.

### Changes to existing endpoints (iOS app)

- `GET /auth/status` adds `appLogin` (the iOS app is available: `APP_STORE_URL` set or a device signed in),
  `pushLogin` (APNs configured and a device with push on) and `appStoreUrl`.
- `GET /overview` accepts `todayStart` / `weekStart` (ms) and adds `periods { today, week, todayStart, weekStart }`
  (posts by status in each period) and `failures` (latest 5 failed / needs_check). Its reads are one D1 batch.
- `POST /me/password` with a device token keeps that device signed in (other sessions and devices end).
- `POST /me/workspace` works with device tokens too.

## Media URLs and thumbnails

`MediaDTO` (`GET /media`, uploads, upload links, MCP `list_media`) has `url` and `thumbUrl`, both public (no auth):

- `url`: the signed `/m/:id/:sig/:name` link of the instance, or, when the instance sets `MEDIA_PUBLIC_URL` (README
  "Custom media domain"), `<MEDIA_PUBLIC_URL>/<media id>/<file name>` served straight from the R2 bucket's custom
  domain (Range requests supported, no Worker request). Providers hand the same URL to platforms that pull media.
  Unfinished multipart uploads always get the `/m/` link (404 until completed). `/m/` links stay valid after a media
  domain is set (URLs already handed out keep resolving).
- `thumbUrl` (new, nullable): a WebP thumbnail of images, max 480 px (scale-down), made once when the upload completes
  (single, multipart, from URL, upload links) with the Images binding and stored at `<media id>/thumb/480.webp`:
  `/m/:id/:sig/thumb/480.webp` (same signature as the file) or `<MEDIA_PUBLIC_URL>/<media id>/thumb/480.webp`. `null` for
  videos, small images (≤ 480 px and ≤ 256 KB, when the upload sent `X-Width`/`X-Height`), images uploaded before
  thumbnails, and when the Images binding is missing or the transform failed: show `url` then. Deleted with the media.

Deleting media removes the R2 objects at once; with a Cache Rule on the media domain the edge and browsers may still
serve them for up to the cache TTL (1 day in the README example).
