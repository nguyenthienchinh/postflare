# Postflare for iOS

Native iPhone app for a Postflare server (SwiftUI, Swift Charts, Liquid Glass; iOS 26+, no third-party packages).
It talks to the REST API with a device token ([`docs/ios-api.md`](../docs/ios-api.md)); the models in
`Postflare/Core/Models.swift` mirror [`shared/types.ts`](../shared/types.ts).

What it does: home (today / this week by status, up next, what needs attention, plan banner), posts (list grouped by
day and a month calendar, filters by status, account group and account), post detail (a native-looking preview per platform
— YouTube, TikTok / Reels, Instagram feed and stories, X-style threads, LinkedIn / Facebook, Pinterest, Reddit, blogs —
switchable between the accounts of the group, collapsible long text, a fullscreen media viewer with zoom and video
playback, then performance: every metric the post has, growth over the snapshots, YouTube audience retention and
traffic sources, tracked App Store link results, "Refresh now"; then settings with their labels, ids and the publishing
log; retry, cancel, change schedule, resolve a check, duplicate, delete),
composer (accounts by group, per-platform character counters, photos and videos with upload progress, now / later /
draft, required platform settings), accounts, analytics (7 days to 1 year, filtered by platform or account; KPIs against the previous period, a daily
chart, followers per account, platforms and accounts, top posts by views / engagements / rate / newest / link results
with paging), notifications, signing a computer in, and two widgets.

## Build

The Xcode project is generated (and git-ignored):

```sh
cd ios
cp Local.example.xcconfig Local.xcconfig   # once: your bundle id and team (git-ignored)
xcodegen generate          # after adding/removing files or changing project.yml / the xcconfig files
open Postflare.xcodeproj
```

A fresh clone needs only Xcode 26+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

### Your bundle id and team

`Config.xcconfig` (tracked) holds neutral defaults: bundle id `com.example.postflare`, no team (simulator builds only).
Put your own values in the git-ignored `Local.xcconfig`, which `Config.xcconfig` includes:

| Setting | What |
| --- | --- |
| `POSTFLARE_BUNDLE_ID` | The app's bundle id. The widget extension is `<id>.widgets`, the shared keychain group `<team>.<id>.shared`, widget kinds `<id>.upnext` and `<id>.today`. Set the server's `APNS_TOPIC` to the same value. |
| `DEVELOPMENT_TEAM` | Your Apple Developer team id. |
| `POSTFLARE_APP_PROFILE`, `POSTFLARE_WIDGETS_PROFILE` | Names of the App Store provisioning profiles for Release builds. |
| `ASC_WEB_APPLE_ID` | Your Apple ID, only for `scripts/create-app-record.sh`. |

Every value can also be given as an environment variable to the scripts (`POSTFLARE_BUNDLE_ID=... scripts/release.sh`).

Command line (simulator):

```sh
xcodebuild -project Postflare.xcodeproj -scheme Postflare \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/DerivedData build
```

## Layout

| Path | What |
| --- | --- |
| `Postflare/Core/` | Compiled into the app **and** the widget extension: API client, models, formatting (status and platform names, colours, letter glyphs), keychain + shared settings, response cache, widget snapshot. |
| `Postflare/App/` | App entry and tabs, `AppModel` (session, workspace, catalog of accounts / groups / platforms, media lookup, routing, deep links), push registration. |
| `Postflare/Features/` | Home, Posts (list, calendar, detail, reschedule), Compose (+ media upload), Accounts, Analytics, Settings (notifications, devices, `WebLoginView`), onboarding with the QR scanner, shared components. |
| `Postflare/Resources/` | Assets (app icon, `BrandGlyph`), `en.lproj` / `tr.lproj` (`Localizable.strings` incl. the push `loc-key`s, English plurals in `Localizable.stringsdict`, `InfoPlist.strings`). |
| `PostflareWidgets/` | "Up next" (small, medium, Lock Screen rectangular and inline) and "Today" (small, medium, Lock Screen circular and rectangular). |
| `scripts/` | `create-app-record.sh`, `release.sh` (TestFlight). |

The app icon (`AppIcon.png`) is `public/brand/postflare-logo-1024.png`; the in-app mark (`BrandGlyph`) is the glyph of
`public/favicon.svg` (a calendar page crossed by the flare). Brand orange `#FF500A`.

Sharing between the app and the widget extension goes through the keychain access group `<team>.<bundle id>.shared`
(device token, server, workspace; the app reads it from the `PostflareKeychainGroup` Info.plist key). Every
provisioning profile of the team allows it, so no App Group has to be registered. Each process keeps its own response
cache; widgets load `GET /overview` and `GET /accounts` themselves (every 15 minutes, sooner when a post is due, and
whenever the app reloads the timelines).

## Sign-in

- Email and password against your server (`POST /api/auth/device`). The server field defaults to
  `https://postflare.ferdi.app` and can be changed (plain `http://` only on the local network). Servers whose
  `apiVersion` the app does not support are refused. When the server asks for a bot check (Turnstile after failed
  sign-ins), the app points to the QR code instead.
- QR code / link: `postflare://pair?s=<url-encoded server>&c=<CODE>` (web app → Profile → **Postflare for iPhone** →
  Connect iPhone). The in-app scanner or the Camera app; opening the link while signed in offers to switch.

The `pfd_` device token is kept in the keychain. Sign out: `POST /api/auth/device/logout` (revokes the token and the
push registration). Any `401` (e.g. `device_signed_out`) returns to the sign-in screen.

## Workspaces

Every workspace-scoped request sends `X-Workspace-Id`. The switcher (Home toolbar, Settings) also calls
`POST /me/workspace` so the next start opens the same one. Actions are hidden for roles without the permission
(`posts.write`, `media.write`, `accounts.manage`). In demo workspaces uploads and connecting accounts are hidden.

## Signing a computer in

The signed-in app can sign a browser in ([`docs/app-login-spec.md`](../docs/app-login-spec.md)): on the web sign-in
page choose **Sign in with the iPhone app**, then scan the QR code in Settings → **Sign in on a computer** (the same
scanner also takes pairing codes) or with the Camera app
(`postflare://web-login?s=<server>&r=<id>&k=<nonce>` opens the app). Codes for a server other than the configured one
are refused. With push, the browser sends a request instead (`WEB_LOGIN` category, `{ type: "web_login", id }`) and the
app shows three numbers: pick the one on the computer's screen. `WebLoginSheet` shows the browser, location, IP and
time, and approves with Face ID / Touch ID or the passcode (LocalAuthentication).

## Deep links

`postflare://home`, `posts[/list|/calendar]`, `calendar`, `post/<id>`, `compose` (`?duplicate=<post id>`),
`accounts`, `analytics`, `settings[/notifications|/devices|/access-requests[/<id>]|/support[/<id>]]`, `notifications`, `pair?...`, `web-login?...`.

Debug builds accept `-PFOpenURL <url>` (open a deep link at launch) and `-PFSkipPushPrompt YES` for simulator
automation, e.g. `xcrun simctl launch booted com.example.postflare -PFOpenURL postflare://posts -PFSkipPushPrompt YES`.

## Media uploads

Photos and videos come from the system photo picker (no library permission prompt). HEIC and other camera formats are
converted to JPEG; JPEG, PNG, GIF and WebP stay as they are. Videos go up as picked (QuickTime / MP4) with their pixel
size and duration. Files up to 90 MB use one `POST /media` request; larger ones the multipart flow
(`POST /media/multipart`, 50 MB parts, three in parallel, each retried up to three times, then `complete`; on failure
the unfinished upload is deleted). Uploads continue for a while when the app goes to the background
(`beginBackgroundTask`), not across app termination.

## Push

On launch (when permission was given) and after sign-in the app registers with `PUT /devices/me`
`{ apnsToken, environment, name }` (`sandbox` in Debug, `production` in Release builds). Preferences (published,
failed / needs check, workspace filter) go to `PATCH /devices/me/prefs`; Settings → Notifications can send a test push
(`POST /devices/me/test`). Alert texts are localized on the device with the `PUSH_*` keys in
`Resources/*.lproj/Localizable.strings`.

Server side: set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and **`APNS_TOPIC` = your bundle id**
(`POSTFLARE_BUNDLE_ID`), see the root README "iOS app → Push notifications (APNs)". The bundle id needs the Push
Notifications capability (automatic signing adds it). Tapping `post_published`, `post_failed` or `post_needs_check`
switches to the post's workspace and opens the post; `web_login` opens the approval sheet; `access_request` (`id`)
opens Settings → Access requests → that request; `support_message` (`id`) opens Settings → Support → that
conversation (no banner while that conversation is on screen); `test` does nothing.

## Access requests

Instance admins (`instance.users.manage` in `instancePermissions`) get Settings → **Access requests** (pending count
from `GET /access-requests/count` as the badge): the people who asked for an account on the web (`/apply`), filtered by
status (pending, all, approved, rejected), searchable, 50 per page (`nextBefore`). The detail shows everything they
sent; **Approve** (`PATCH /access-requests/:id { status: "approved" }`) shows the invitation link (copy, share) and
whether it was emailed, or that the email already has an account; **Reject** takes an optional note and "Email the
applicant". An approved request whose invitation is unused offers **New invite link** (the old one stops working).
The `accessRequests` device pref (Settings → Notifications, admins only) turns their pushes on or off.

## Support

Users who answer support chats (`instance.support.manage`) get Settings → **Support** (unread count from
`GET /admin/support/count` as the badge), see [`docs/support-spec.md`](../docs/support-spec.md). The inbox filters by
Open / Waiting (`pending`) / Closed / All with their counts, **Mine** (assigned to me), search (name, email, message,
`#number`), 50 per page (`nextBefore`), and closes or reopens with a swipe. The conversation shows the thread (customer
left, staff right, internal notes in yellow), the customer (contact, Postflare user and workspace, page, country,
browser), and a composer: **Reply** (sets the conversation to Waiting), **Reply & close** or **Internal note**. The menu
closes / reopens, marks waiting, assigns (`GET /admin/support/staff`) and deletes. Opening it marks it read; it refreshes
every 5 s while on screen and the app is active. The `support` device pref (Settings → Notifications) turns the pushes
on or off.

## Release (TestFlight)

1. **App record (once, by hand).** Apple creates new apps only through a web session, so run
   `scripts/create-app-record.sh` yourself in a terminal. It skips if your bundle id already exists; otherwise it runs
   `asc web apps create` (name "Postflare", falling back to "Postflare: Social Scheduler"; SKU `postflare`; en-US),
   which asks for the Apple ID password and the **two-factor code** (`ASC_WEB_APPLE_ID` in `Local.xcconfig` or the
   environment).
2. **Each build.** `scripts/release.sh` uses the asc API key (`asc auth login`) and stops early if the app record is
   missing. It archives (Release, `generic/platform=iOS`), exports (it writes `build/ExportOptions.plist` from
   `Local.xcconfig`), uploads with `asc builds upload --wait`, and adds the build to the app's internal TestFlight group.
   The build number is the latest uploaded one + 1, or `BUILD=n scripts/release.sh`. Needs `xcodegen`, `jq` and `asc`.

Signing: Debug uses automatic signing; Release uses the App Store profiles named in `POSTFLARE_APP_PROFILE` and
`POSTFLARE_WIDGETS_PROFILE`. The app id (`<id>`) needs Push Notifications.

Export compliance: `ITSAppUsesNonExemptEncryption = NO` is in the Info.plist. Billing is never sold in the app: plan
banners and 402 answers link to the web billing page.

Screenshots go to `ios/screenshots/` (git-ignored).
