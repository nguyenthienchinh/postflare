# Postflare iOS app: API

Everything the native iOS app uses, for the people (and agents) building it. The server is one Postflare instance; the
app stores its URL, signs in once and keeps a **device token**. Base: `<server>/api`, JSON in and out, errors
`{ "error": "message" }` (some with a `code`) and a 4xx/5xx status. Field types: [`shared/types.ts`](../shared/types.ts)
(names below). Design references: [app-login-spec.md](app-login-spec.md) (sign in on the web with the app),
[workspaces-spec.md](workspaces-spec.md) (users, workspaces, permissions), [api.md](api.md) (account groups, campaigns,
billing in detail).

## Conventions

- **Auth:** `Authorization: Bearer pfd_...` on every request after sign-in. The token acts like the user's web session:
  every workspace the user can see, the same permissions as in the browser (instance admin pages included), no CSRF
  check (send no `Origin` header, or the server's own). It lives a year from its last use (sliding) and ends when the
  user signs the device out (app or web), changes the password from another device, or is disabled or deleted.
  `401` with `code: "device_signed_out"` = the token is gone: go back to the sign-in screen.
- **Workspace:** send `X-Workspace-Id: ws_...` with every workspace-scoped request (posts, accounts, media, analytics,
  billing...). Without it the server uses the device's remembered workspace (`POST /me/workspace`), else the user's
  first one. An id the user cannot access answers `404 { error: "Workspace not found" }` (never another workspace).
- **Permissions:** each workspace in `GET /me` has `permissions` (`posts.read`, `posts.write`, `media.write`,
  `accounts.manage`, `billing.manage`, ...). Hide what the role cannot do; the server answers `403` otherwise.
- **Times** are Unix milliseconds. Ids are prefixed strings (`pst_`, `acc_`, `med_`, `ws_`, `dev_`...).
- **Plan limits (hosted mode):** `402 { code: "plan_limit", limit, used, max, upgradeUrl }` (`PlanLimitErrorDTO`):
  show the message and offer `upgradeUrl` (opens the web app). `GET /billing` tells whether billing is on at all.
- **Demo:** the shared live-demo user cannot sign in on devices; demo workspaces never push.

## Sign-in

### Email and password

`POST /auth/device` `{ email, password, deviceName, turnstileToken? }` → `DeviceTokenDTO`:

```json
{
  "token": "pfd_…",
  "deviceId": "dev_…",
  "user": { "id": "usr_…", "name": "Ada", "email": "ada@example.com", "role": { "id": "role_instance_admin", "name": "Admin" } },
  "instancePermissions": ["instance.users.manage", "…"],
  "workspaces": [{ "id": "ws_…", "name": "Tempo", "role": { "id": "role_ws_owner", "name": "Owner" }, "permissions": ["posts.read", "…"] }],
  "currentWorkspaceId": "ws_…",
  "server": "https://social.example.com"
}
```

Same rules as the web sign-in: `401` wrong email or password, `429` throttled (5 failures per IP, 10 per email in 15
minutes, shared with the web), `403` for pending (unconfirmed) or disabled accounts. When the instance uses
Cloudflare Turnstile, a 401/400 with `captchaRequired: true` means the next try needs a widget token (the app can open
the web sign-in instead, or pair with a QR code). `deviceName`: e.g. `UIDevice.current.name` (at most 100 characters).

### Pairing code (QR on the web)

Profile → **Postflare for iPhone** → "Connect iPhone" shows a QR code with
`postflare://pair?s=<url-encoded server>&c=<code>` and the code as text (`XXXXX-XXXXX`, letters A-Z without I/O and
digits 2-9). Single use, 5 minutes.

`POST /auth/pair` `{ code, deviceName }` → `DeviceTokenDTO` (the code may contain the dash, spaces or lower case).
`currentWorkspaceId` is the workspace that was open on the web. `400` invalid / used / expired, `429` after 10 wrong
codes per IP in 15 minutes. The app must use `s` as its server (show it before pairing); the web page notices the
pairing by itself.

### Sign out

`POST /auth/device/logout` → `{ ok: true }`: revokes the token and the push registration. (`POST /auth/logout` with the
device token does the same.)

### Server info before sign-in

`GET /auth/status` (no auth) → `AuthStatusDTO`: `setup` (false = fresh instance, set it up on the web first),
`magicLink`, `signup`, `signupMode` (`apply`: people request access on `<server>/apply`; `open`: `<server>/signup`),
`turnstileSiteKey`, `appLogin`, `pushLogin`, `appStoreUrl`. `GET /version` →
`VersionDTO` `{ version, commit, apiVersion }`: refuse servers whose `apiVersion` the app does not support.

## Profile and workspaces

- `GET /me` → `MeDTO` `{ user, instancePermissions, workspaces, currentWorkspaceId }`.
- `POST /me/workspace` `{ workspaceId }` → `{ ok, currentWorkspaceId }`: the default for requests without
  `X-Workspace-Id` (and for the next app start).
- `PATCH /me` `{ name?, email? }`; `POST /me/password` `{ current, next }` (signs out the user's other sessions and
  devices, this device stays signed in).
- `GET /workspaces` → `WorkspaceDTO[]` (with `memberCount`); members and invitations: see the README "Users,
  workspaces and roles".

## Devices and push registration

- `PUT /devices/me` `{ apnsToken?, environment?, name?, prefs? }` → `DeviceDTO`. Call it after every launch with the
  current APNs token (hex string from `didRegisterForRemoteNotificationsWithDeviceToken`) and
  `environment: "sandbox"` for development builds (`aps-environment` = development), `"production"` for TestFlight and
  the App Store. `apnsToken: null` turns push off. A token registered by another install (same phone signed in again)
  moves to this device. Only callable with a device token.
- `PATCH /devices/me/prefs` `{ published?, failed?, accessRequests?, workspaces? }` (or `{ prefs: {…} }`) →
  `DeviceDTO`. `DevicePrefsDTO`: `published` (default true), `failed` (failed and needs_check, default true),
  `accessRequests` (instance admins: new access requests, default true; only users with `instance.users.manage` ever
  get them), `workspaces` (ids, `null` = all the user's workspaces; does not apply to access requests). Unknown fields
  are ignored.
- `GET /devices` → `{ items: DeviceDTO[], push: boolean }` (`push`: APNs is configured on the server). `DeviceDTO`:
  `{ id, name, push, environment, prefs, createdAt, lastSeenAt, lastPushAt, current? }` (`current`: the calling device).
- `POST /devices/me/test` (or `/devices/:id/test`) → `{ ok }`: a test notification (`400` when APNs is not configured
  or the device has no token, `502` when Apple refused it).
- `DELETE /devices/:id` (or `/devices/me`) → `{ ok }`: signs that install out at once.

## Home screen

`GET /overview?todayStart=<ms>&weekStart=<ms>` (`posts.read`) → `OverviewDTO`:

```json
{
  "counts": { "published": 120, "scheduled": 8, "failed": 2 },
  "periods": { "today": { "published": 3, "scheduled": 2 }, "week": { "published": 14, "failed": 1 }, "todayStart": 0, "weekStart": 0 },
  "upcoming": ["PostDTO (publishing first, then scheduled soonest first, 10)"],
  "recent": ["PostDTO (latest published / failed / needs_check, 10)"],
  "failures": ["PostDTO (latest failed / needs_check, 5)"],
  "accounts": { "total": 9, "reconnect": 1 }
}
```

Send the start of today and of this week in the user's time zone (defaults: UTC midnight, UTC Monday). A post counts
in a period by its publish time (published), else its scheduled time, else its creation (drafts). `counts` is all
time. One D1 round trip: fine to refresh on every appearance and on pull to refresh.

## Accounts and account groups

- `GET /accounts` (`accounts.read`) → `AccountDTO[]`: `{ id, provider, name, username, avatarUrl, profileUrl, status
  (active | disabled | reconnect), statusMessage, groupId, metricsStatus: { status, metrics: { followers… } } }`.
  Reconnecting needs the platform's OAuth in a browser: open `<server>/accounts` in Safari (or an
  `ASWebAuthenticationSession`) rather than doing it in the app.
- `GET /providers` → platform catalog (`ProviderInfo`: name, limits, capabilities, settings fields for the composer).
- `GET /accounts/:id/options/:key?settings=<json>` (`posts.write`): dynamic choices of a settings field (boards,
  playlists, subreddits...).
- `GET /account-groups` (`accounts.read`) → `AccountGroupDTO[]` (brands / projects); `POST`, `PATCH /:id`,
  `DELETE /:id`, `POST /accounts/group { accountIds, groupId }` (`accounts.manage`), details in [api.md](api.md).

## Posts

`PostDTO`: `{ id, groupId, accountId, status, scheduledAt, content, media: [mediaId], settings, thread: [{ content,
media }], externalId, externalUrl, error, attempts, createdAt, updatedAt, publishedAt, playbookId, playbookVersion,
variant, appId, autoLink }`. `status`: `draft | scheduled | publishing | published | failed | cancelled | needs_check`.

- `GET /posts?from&to&status=a,b&accountId&accountGroupId&groupId&order=asc|desc&limit` (`posts.read`, limit ≤ 1000,
  default 500) → `PostDTO[]` ordered by scheduled (or created) time. Calendar: `from`/`to`; feed: `order=desc&limit=50`.
- `GET /posts/:id` → `PostDTO & { logs: [{ id, level, message, createdAt }], campaign }`.
- `POST /posts/validate` `CreatePostsInput` → `{ errors: string[] }` (dry run, no write).
- `POST /posts` `CreatePostsInput` (`posts.write`) → `PostDTO[]` (201), one post per account, sharing a `groupId`:

  ```json
  { "scheduledAt": "now" , "posts": [{ "accountId": "acc_…", "content": "Hello", "media": ["med_…"], "settings": {}, "thread": [] }] }
  ```

  `scheduledAt`: `"now"`, a ms timestamp or ISO string (≤ 360 days ahead), or `null` for drafts. Optional
  `playbookId`, `playbookVersion`, `variant`, `appId`, `autoLink`.
- `PATCH /posts/:id` (drafts, scheduled, failed, cancelled) `{ content?, media?, settings?, thread?, scheduledAt?,
  … }` → `PostDTO` (`409` while publishing or once published).
- `POST /posts/:id/retry` (failed, cancelled) → `PostDTO`, publishes now.
- `POST /posts/:id/cancel` (scheduled) → `PostDTO`.
- `POST /posts/:id/resolve` `{ published: boolean, url? }` (needs_check only): "it is live" (optionally with its link)
  or "publish it again".
- `POST /posts/:id/comments` `{ content, replyTo? }`: a follow-up under a published post.
- `DELETE /posts/:id` → `{ ok }` (`409` while publishing).

## Media

`MediaDTO`: `{ id, filename, mime, size, kind (image | video), width, height, duration, alt, url, thumbUrl, createdAt }`.
`url` and `thumbUrl` need no auth header: the signed `/m/` links, or the instance's R2 media domain
(`MEDIA_PUBLIC_URL`, cacheable, Range requests for streaming) when set ([api.md](api.md#media-urls-and-thumbnails)).
Use `thumbUrl` (WebP, max 480 px; `null` for videos and older images: fall back to `url`) for grids and thumbnails, and
`url` for the viewer, hero images and `AVPlayer`. Cache both on disk (the URLs of a media id never change).
Images: jpeg, png, gif, webp, heic/heif, avif; videos: mp4, quicktime, webm, x-m4v, mpeg; at most 5 GB.

- **Up to 90 MB:** `POST /media` with the raw bytes as body, `Content-Type: <mime>`, `X-Filename: <url-encoded name>`,
  optional `X-Width`, `X-Height`, `X-Duration` (seconds) → `MediaDTO`. `413` above 90 MB.
- **Large videos (multipart, resumable per part):**
  1. `POST /media/multipart` `{ filename, mime, size, width?, height?, duration? }` → `{ id, partSize, parts }`
     (`partSize` = 50 MB).
  2. `PUT /media/multipart/:id/:partNumber` (1-based) with the raw bytes of that slice → `{ partNumber, etag }`.
     Upload parts in parallel (2-3 at a time) from a background `URLSession`; retry failed parts.
  3. `POST /media/multipart/:id/complete` `{ parts: [{ partNumber, etag }] }` → `MediaDTO`.
- `POST /media/from-url` `{ url, filename?, alt? }` → `MediaDTO`.
- `GET /media?limit&before=<createdAt>` (`media.read`) → `MediaDTO[]` newest first (paginate with `before`).
- `PATCH /media/:id` `{ alt }`, `DELETE /media/:id`, `GET /media/usage`.
- Demo workspaces refuse uploads (`403`).

## Analytics

`posts.read`; `from` / `to` in ms or ISO (default: last 30 days), `tz` (IANA, e.g. `Europe/Istanbul`), `accountId`,
`provider`:
- `GET /analytics/summary` → `AnalyticsSummaryDTO`: totals and change vs the previous period, per day, per platform /
  account, followers.
- `GET /analytics/posts?sort=views|engagements|engagementRate|publishedAt|clicks|downloads|proceeds&limit&offset` →
  `AnalyticsPostDTO[]` (top posts).
- `GET /posts/:id/metrics` → `PostMetricsDTO` (latest values, `metricsNextAt`, and the snapshots of the 1h / 24h /
  3d / 7d / 30d collections).
- `POST /analytics/refresh` `{ postId }` or `{ accountId }` (`posts.write`) → `AnalyticsRefreshDTO`.

## Billing (hosted mode)

`GET /billing` (`posts.read`) → `BillingDTO`: `enabled` (false: hide billing everywhere), `state`
(unlimited | plan | trial | free | locked), `plan`, `trialEndsAt`, `usage`, `limits`, `canManage`. Upgrades and the
billing portal happen on the web (`POST /billing/checkout`, `POST /billing/portal` return a URL to open in Safari;
do not sell digital subscriptions inside the app).

## Access requests (instance admins)

Only with `instance.users.manage` in `instancePermissions` (hide the screens otherwise; the server answers `403`).
People apply on the web (`/apply`) while the instance's sign-up mode is "Request access"; admins review them.

- `GET /access-requests?status=pending|approved|rejected|withdrawn|all&q=&limit=&before=` → `AccessRequestListDTO`
  `{ items: AccessRequestDTO[], counts: { pending, approved, rejected, withdrawn }, nextBefore }` (newest first,
  `limit` ≤ 100, next page with `before=<nextBefore>`).
- `GET /access-requests/count` → `{ pending }` (badge).
- `GET /access-requests/:id` → `AccessRequestDTO` (`role`: creator | agency | startup | brand | other; `platforms`:
  x, instagram, tiktok, youtube, linkedin, facebook, threads, bluesky, pinterest, other; `volume`: 1-30 | 31-100 |
  101-300 | 301-1000 | 1000+; `existingUser`, `invitationAccepted`).
- `PATCH /access-requests/:id` `{ status: "approved" | "rejected", note?, notify? }` → `{ request, invitation?: { id,
  url, expiresAt }, existingUser?, emailed }`. After approving show `invitation.url` with Copy and the share sheet
  (it may not have been emailed: `emailed`). Approving an approved request with an unused invitation makes a new link.
  `409` when the request was already handled. Details: [api.md](api.md#access-requests).

## Sign in on the web with the app

The app approves browser sign-ins ([app-login-spec.md](app-login-spec.md)). Entry points:

- Scanning a QR code `postflare://web-login?s=<server>&r=<id>&k=<nonce>` (in-app scanner, or the Camera app opening
  the URL scheme). Refuse it when `s` is not the app's server ("This code is for another server").
- A push notification of type `web_login` (see below) with `id`.

Endpoints (device token):
- `POST /auth/app-login/:id/inspect` `{ nonce? }` → `AppLoginInspectDTO` `{ kind (qr | push), ip, city, country,
  browser, os, server, createdAt, expiresAt, numbers? }`. QR requests need the `k` nonce; push requests only open on
  the target user's devices. `numbers` (push): three numbers, one of them is shown on the web page. `404` unknown (or
  not for this device), `410` expired or already handled.
- `POST /auth/app-login/:id/approve` `{ nonce? , number? }` → `{ ok }` after Face ID / passcode
  (LocalAuthentication). Push: the number the user tapped; a wrong one denies the request (`403`). `410` too late.
- `POST /auth/app-login/:id/deny` `{ nonce? }` → `{ ok }`.

The approval sheet shows the server host, browser and OS, location and IP, the time, and: "Only approve if you are
signing in right now. Postflare will never ask you to approve a request someone else sends you."

## Push notifications

APNs alerts with `title-loc-key` / `loc-key` + args; `title` / `body` carry an English fallback. Custom keys sit next
to `aps`. `mutable-content` is not set. Tapping:
- `post_published`, `post_failed`, `post_needs_check` → open the post (`postId`) in workspace `workspaceId` (switch the
  workspace first).
- `web_login` → open the approval sheet for `id` (inspect it; no action buttons on the notification itself).
- `access_request` → open access request `id` (Settings → Access requests).
- `test` → nothing.

Publish result (`thread-id` = workspace id, `apns-collapse-id` = `<postId>:<kind>`):

```json
{
  "aps": {
    "alert": {
      "title": "Tempo App · Instagram", "body": "Published: First 100 characters of the post…",
      "title-loc-key": "PUSH_POST_TITLE", "title-loc-args": ["Tempo App", "Instagram"],
      "loc-key": "PUSH_POST_PUBLISHED_BODY", "loc-args": ["First 100 characters of the post…"]
    },
    "sound": "default", "thread-id": "ws_…", "interruption-level": "active"
  },
  "type": "post_published", "postId": "pst_…", "workspaceId": "ws_…"
}
```

Who gets them: members of the post's workspace whose role can see posts, active users, signed-in devices with a token,
whose `prefs` want the kind and the workspace; never for demo workspaces. Instance admins only get pushes for the
workspaces they are members of. At most 10 devices per event (the most recently used ones).

Web sign-in request (`category: WEB_LOGIN`, `thread-id: web-login`, `interruption-level: time-sensitive` (needs the
Time Sensitive Notifications capability), `apns-expiration` = the request's expiry, 3 minutes):

```json
{
  "aps": {
    "alert": {
      "title": "Sign-in request", "body": "Chrome on macOS · Berlin, DE",
      "title-loc-key": "PUSH_WEB_LOGIN_TITLE", "title-loc-args": [],
      "loc-key": "PUSH_WEB_LOGIN_BODY", "loc-args": ["Chrome", "macOS", "Berlin, DE"]
    },
    "sound": "default", "thread-id": "web-login", "category": "WEB_LOGIN", "interruption-level": "time-sensitive"
  },
  "type": "web_login", "id": "wl_…"
}
```

New access request (instance admins with `accessRequests` on, at most 5 devices; `thread-id: access-requests`,
`interruption-level: passive`, `apns-collapse-id` = the request id, expires after 7 days):

```json
{
  "aps": {
    "alert": {
      "title": "New access request", "body": "Ann Lee · Ann Co · Startup / app developer",
      "title-loc-key": "PUSH_ACCESS_REQUEST_TITLE", "title-loc-args": [],
      "loc-key": "PUSH_ACCESS_REQUEST_BODY", "loc-args": ["Ann Lee", "Ann Co", "Startup / app developer"]
    },
    "sound": "default", "thread-id": "access-requests", "interruption-level": "passive"
  },
  "type": "access_request", "id": "ar_…"
}
```

The second arg is the company, or the host of the applicant's link when there is none; the role label is English.

### Loc keys (ship these in `Localizable.strings`)

| Key | Args | en | tr |
| --- | --- | --- | --- |
| `PUSH_POST_TITLE` | account name, platform | `%1$@ · %2$@` | `%1$@ · %2$@` |
| `PUSH_POST_PUBLISHED_BODY` | text (≤ 100 chars) | `Published: %1$@` | `Yayınlandı: %1$@` |
| `PUSH_POST_PUBLISHED_BODY_EMPTY` | – | `Your post is live.` | `Gönderiniz yayında.` |
| `PUSH_POST_FAILED_BODY` | error (≤ 100 chars) | `Failed: %1$@` | `Yayınlanamadı: %1$@` |
| `PUSH_POST_NEEDS_CHECK_BODY` | text, or the message when empty | `Check needed: %1$@` | `Kontrol gerekiyor: %1$@` |
| `PUSH_WEB_LOGIN_TITLE` | – | `Sign-in request` | `Oturum açma isteği` |
| `PUSH_WEB_LOGIN_BODY` | browser, OS, location | `%1$@ on %2$@ · %3$@` | `%2$@ üzerinde %1$@ · %3$@` |
| `PUSH_TEST_TITLE` | – | `Postflare` | `Postflare` |
| `PUSH_TEST_BODY` | – | `Notifications work.` | `Bildirimler çalışıyor.` |
| `PUSH_ACCESS_REQUEST_TITLE` | – | `New access request` | `Yeni erişim isteği` |
| `PUSH_ACCESS_REQUEST_BODY` | name, company or website, role | `%1$@ · %2$@ · %3$@` | `%1$@ · %2$@ · %3$@` |

The account name and platform name come from the server untranslated (platform names are brand names).
