# Hosted mode: sign-up, plans and billing

Postflare follows the Postiz model: **one open-source codebase, no feature gates in the license.** A self-hosted
instance and the hosted service run the same code. The hosted service is an instance where the admin has turned on
public sign-up and selling plans. Everything is **off by default**, so a fresh self-hosted deploy behaves exactly as
before.

This spec is written so the same design can be ported to Adsflare and Revflare (same Cloudflare Worker + D1 + React
stack, same users/workspaces/roles model). Everything product-specific is listed under "Limits" and "Host hooks";
everything else (`worker/billing/`) should copy over with renames only.

## Concepts

- **Billing entity = workspace** (Postiz bills per organization). A user can own several workspaces, and each has its
  own plan. Members of a workspace never pay; the workspace does.
- **Plan**: a named bundle of limits plus prices (monthly and/or yearly), defined by the instance admin in
  Admin → Billing. Plans are data (D1), not code.
- **Payment provider**: Polar (default and recommended: merchant of record, no Stripe account needed), Stripe or
  Lemon Squeezy. The admin configures credentials for any of them; **exactly one is the active sales channel**
  (`billing_provider` setting). New checkouts go through the active one. Webhooks of every configured provider keep
  being accepted, so subscriptions bought earlier through another provider keep working.
- **Billing on** = setting `billing_enabled` = "1" AND an active provider is configured AND at least one active paid
  plan exists. When billing is off, no limits are enforced anywhere (self-hosted behaviour).
- **Exempt workspace** (`workspaces.billing_exempt = 1`): never limited. Set by the migration for every workspace that
  exists before billing is turned on (the operator's own workspaces), always for the demo workspace, and toggleable by
  instance admins in Admin → Users/Workspaces ("Comp this workspace" / assign a plan by hand).

## Subscription state (per workspace)

Columns on `workspaces` (migration):

| column | meaning |
|---|---|
| `plan_id` | `plans.id` the workspace is on (paid, trial, or the free plan), NULL = none |
| `billing_status` | `none` · `trialing` · `active` · `past_due` · `canceled` (canceled = paid until `current_period_end`, then none) · `expired` |
| `trial_ends_at` | ms epoch, local trial (no card) |
| `current_period_end` | ms epoch from the provider |
| `billing_provider` | `polar` · `stripe` · `lemonsqueezy` · `manual` |
| `billing_customer_id`, `billing_subscription_id` | provider ids |
| `billing_interval` | `month` · `year` |
| `billing_exempt` | 0/1 |
| `billing_updated_at` | ms epoch |

**Effective plan** (`entitlements(workspace)`), computed in one query (workspace row JOIN plans):
1. billing off, or workspace exempt → unlimited.
2. `active`, `past_due` within a grace of `past_due_grace_days` (setting, default 7), or `canceled` before
   `current_period_end` → the workspace's plan.
3. `trialing` before `trial_ends_at` → the trial plan (`plan_id`).
4. otherwise → the **free plan** if the admin marked one (`plans.is_free = 1`), else the "locked" state: read-only
   (everything can be viewed, exported and deleted; nothing new can be created, scheduled or published).

Trial: when a workspace is created while billing is on (sign-up, "New workspace", invitation that creates a
workspace), it starts `trialing` on the plan marked `is_trial_default` for `trial_days` (setting, default 7; 0 = no
trial, start on the free plan or locked). No card needed (simplest across providers; Postiz Cloud also offers a
7-day trial). One trial per user: a user who already had a trial workspace gets the free plan/locked instead.

## Limits (Postflare)

`plans.limits` is JSON; absent key or `null` = unlimited. Keys for Postflare:

| key | counted as | enforced at |
|---|---|---|
| `accounts` | connected accounts in the workspace (not disabled) | connecting a new account (OAuth callback, webhook/Bluesky/Mastodon credential connect) |
| `posts_per_month` | posts published or scheduled in a UTC calendar month (one per account post, i.e. what the user sees as a post card), see "Monthly posts" below | create post (REST, MCP, CLI, composer, publish now, duplicate), `PATCH` that schedules a draft/failed/cancelled post or moves a post to another month, retry |
| `x_posts_per_month` | same, platform `x` only (X API costs money per post, $0.015, $0.20 with a URL) | the same, for X accounts |
| `members` | workspace members + pending invitations to this workspace | invite, accept |
| `storage_mb` | sum of media bytes in the workspace | media upload / import |
| `api` | boolean: API keys and MCP allowed | create API key; API-key/MCP requests answer 402 when false |

Locked or over-limit actions answer **HTTP 402** `{ error, code: "plan_limit", limit, used, max, upgradeUrl }`
(MCP: tool error with the same text; CLI prints the error). Publishing of posts that were already scheduled is not
blocked by limits (they were within limits when created), only by the locked state: the publish workflow marks such
posts `failed` with "This workspace has no active plan" (one extra query, read in the existing workspace lookup).

Counting must stay cheap (Free plan: ≤50 D1 queries per invocation, 10 ms CPU): each check is one `COUNT(*)` on an
indexed column, run only when billing is on and the workspace is not exempt.

**Monthly posts** (deletion-proof). A post counts toward the UTC calendar month it is published or scheduled in, not
the month it was created in. `used(month)` = the distinct posts of the workspace that have a publish outcome
`published` or `needs_check` in that month in `usage_events` (`kind = 'publish'`, one row per post card per publish
attempt; thread replies and comments are `kind = 'reply'` and never count; the rows survive deleting the post or its
account) UNION the posts still to publish (`scheduled`, `publishing`, and `needs_check`, which the stuck-publishing
sweep sets without a usage event) whose `scheduled_at` falls in that month. So:
- drafts are free until scheduled; failed posts don't count (a retry takes a slot again);
- deleting, cancelling or un-scheduling a post that is not published yet frees its slot; deleting a published one
  does not;
- a post re-published after a `needs_check` counts once per month (UNION dedupes by post id);
- every check is against the target month of each post: a batch create or a reschedule into next month counts
  against next month (rescheduling within the same month takes no new slot), the 402 names the month.
One query per limit key and month: the `usage_events` part reads the partial covering index
`usage_events_ws_published` (migration 0014), the posts part `posts_workspace (workspace_id, scheduled_at)`.
`GET /api/billing` reports the current month with the same definition. `POST /posts/:id/resolve {published: false}`
(re-publish a `needs_check` post) is only checked for the locked state: the post already holds its slot.

## Plans (table `plans`)

`id` (`pln_…`), `name`, `description`, `features` (JSON array of display strings), `limits` (JSON), `price_month`,
`price_year` (integer cents, NULL = interval not offered), `currency` (ISO, default USD), `provider_prices` (JSON:
`{ "polar": { "month": "<product id>", "year": "<product id>" }, "stripe": { "month": "price_…", … },
"lemonsqueezy": { "month": "<variant id>", … } }`), `is_free`, `is_trial_default`, `highlight` (most popular badge),
`position`, `active` (archived plans keep their subscribers), `created_at`, `updated_at`.

Prices shown in the UI come from the plan row; the provider's product/price id is what is charged. The admin creates
the products in the provider's dashboard and pastes their ids (no product sync API needed, works the same for all
providers). Suggested starting plans (seeded only as a "Create suggested plans" button, never automatically): Free
(1 workspace member, 3 accounts, 30 posts/month, 0 X posts, 500 MB), Creator $19/mo (10 accounts, 300 posts, 50 X
posts, 3 members, 5 GB), Team $49/mo (30 accounts, 1,500 posts, 300 X posts, 10 members, 20 GB, API).

## Providers (`worker/billing/providers/*.ts`)

```ts
interface BillingProvider {
  id: "polar" | "stripe" | "lemonsqueezy";
  name: string;
  /** Credential fields shown in Admin → Billing (stored encrypted with encryptJson, never returned to the UI). */
  fields: { key: string; label: string; secret: boolean; help?: string }[];
  /** Checks the credentials (one cheap API call) for the "Test connection" button. */
  verify(cfg): Promise<{ ok: true; account?: string } | { ok: false; error: string }>;
  createCheckout(cfg, input: { workspaceId; planId; interval; productRef; email; successUrl; cancelUrl; customerId? }): Promise<{ url: string }>;
  portalUrl(cfg, input: { customerId; subscriptionId; returnUrl }): Promise<string>;
  /** Verifies the signature on the raw body and maps the event, or throws. */
  parseWebhook(cfg, req: Request, rawBody: string): Promise<BillingEvent | null>; // null = ignored event type
}
type BillingEvent = { id: string; type: "subscription.updated" | "subscription.deleted" | "checkout.completed";
  workspaceId: string | null; customerId?: string; subscriptionId?: string; status?: BillingStatus;
  productRef?: string; interval?: "month" | "year"; currentPeriodEnd?: number; cancelAtPeriodEnd?: boolean;
  occurredAt?: number }; // implemented: parseWebhook(cfg, headers, rawBody, now), see worker/billing/types.ts
```

- **Polar** (`api.polar.sh`, sandbox `sandbox-api.polar.sh` when the "Sandbox" box is checked): organization access
  token + webhook secret. Checkout: `POST /v1/checkouts/` with `products: [product id]`, `success_url`, `return_url`
  (back button), `customer_email` (or `customer_id` when the workspace already has a Polar customer) and
  `metadata.workspace_id` (Polar copies checkout metadata to the subscription) → `url`. Portal:
  `POST /v1/customer-sessions/ { customer_id, return_url }` → `customer_portal_url`. Webhooks follow Standard Webhooks
  (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, space
  separated when several), 5-minute tolerance; the payload is `{ type, timestamp, data: Subscription }`. Events
  `subscription.created/updated/active/canceled/uncanceled/revoked/past_due`. *Corrected (2026-10 docs):* secrets
  created since 2026-09-08 are Standard Webhooks secrets (HMAC key = base64-decoded part after `whsec_`), older ones
  use the UTF-8 bytes of the whole `whsec_…` string: both keys are tried. `external_customer_id` is **not** sent
  (Polar customers are unique per email in an organization; one user owning several workspaces would collide), the
  workspace travels in `metadata` and the customer id comes back in the webhook.
- **Stripe**: secret key + webhook signing secret. Checkout Session (form-encoded) `mode=subscription`,
  `line_items[0][price]`, `client_reference_id`, `metadata[workspace_id]` and `subscription_data[metadata][workspace_id]`;
  Billing Portal session `{ customer, return_url }`; `Stripe-Signature` (`t=…,v1=<hex HMAC of "t.body">`, several `v1`
  while a secret is rolled, 5-minute tolerance); events `checkout.session.completed`,
  `customer.subscription.created/updated/deleted`. *Corrected:* since API version 2025-03-31 ("basil")
  `current_period_end` is on the subscription items (`items.data[].current_period_end`), no longer on the subscription:
  both places are read. `cancel_at_period_end` or `cancel_at` → `canceled` until that date.
- **Lemon Squeezy**: API key, store id, webhook signing secret. `POST /v1/checkouts` (JSON:API,
  `application/vnd.api+json`) with `checkout_data.email`, `checkout_data.custom.workspace_id` (echoed as
  `meta.custom_data`), `product_options.redirect_url` and the store / variant relationships; `X-Signature` = hex
  HMAC-SHA256 of the raw body. *Corrected:* there is no cancel URL; `urls.customer_portal` is a pre-signed link valid
  24 hours, so the portal endpoint fetches the subscription (`GET /v1/subscriptions/:id`) every time; there is no
  event id or timestamp header (dedupe key = SHA-256 of the body, ordering by the subscription's `updated_at`);
  `subscription_payment_failed/success/recovered/refunded` deliver a subscription *invoice*, not a subscription, so
  they are ignored (the `subscription_updated` that accompanies them carries the new status). Handled:
  `subscription_created/updated/cancelled/resumed/expired/paused/unpaused`.
- All calls use `fetch` with a 10 s timeout, signatures are checked with `crypto.subtle.verify` (constant time), Web
  Crypto only (no SDKs: Workers Free size/CPU).

Webhook route: `POST /api/billing/webhooks/:provider` (public, no session, exempt from the same-origin check, and from
the Cloudflare rate limit rule: document it). Steps: load that provider's config (404 if not configured) → verify
signature (400) → dedupe on `billing_events (provider, event_id)` (`INSERT OR IGNORE`; duplicate → 200) → map
`productRef` → plan through `plans.provider_prices` → update the workspace row (only if the event is newer than
`billing_updated_at` when the provider gives a timestamp) → 200. Unknown workspace → 200 + logged (never make the
provider retry forever). `billing_events` keeps 90 days (daily cleanup).

## Sign-up (public registration)

- Setting `signup_mode` (Admin → Settings → Sign-up; useful for self-hosters too): `off` (invitations only, default),
  `apply` (access requests, below) or `open` (this section). Migration 0017 turned the older `signup_enabled = 1` into
  `open`. With `open` the sign-in page shows "Create an account" and `GET /api/auth/status` has `signup: true` (kept
  for older clients) and `signupMode: "open"`.
- `POST /api/auth/signup { name, email, password, workspaceName? }`:
  - If email sending is configured (magic-link `EMAIL` binding + `EMAIL_FROM`), sign-up is **verified by email**: the
    user is created with `status = 'pending'`, a link `/auth/verify#<token>` is mailed (reuse `magic_links` with a
    `purpose` column: `login` | `verify`), and clicking it activates the user, creates their workspace (trial when
    billing is on) and signs in. Pending users cannot log in; pending rows older than 7 days are deleted daily.
    Same answer for existing emails (no enumeration): an existing active user gets a "someone tried to sign up with
    your email, sign in instead" email.
  - Without email configured, sign-up is immediate (status active, signed in). The admin settings card warns that
    hosted instances should configure email first.
  - Throttled: 5 sign-ups per IP per hour (settings-table counter like the magic-link throttle).
  - Bot protection: optional Cloudflare Turnstile (Admin → Settings "Bot protection", or the `TURNSTILE_SITE_KEY` var +
    `TURNSTILE_SECRET_KEY` secret, which win). When configured, sign-up (action `signup`) and sign-in links (action
    `magic_link`) need a `turnstileToken`, and so does sign-in (action `login`) once the IP or email has 3 recent
    failures (the 401 then says `captchaRequired: true`). Checked server side in `worker/lib/turnstile.ts` (siteverify:
    success, hostname, action; 5 s timeout, fails closed with 503) before any hashing, write or email. The Public
    sign-up card warns while sign-up is on without it. Endpoints: docs/api.md "Bot protection".
  - New users get the instance **Member** role (can create workspaces); first workspace = Owner.
- Landing page: the "Sign up — coming soon" button becomes "Sign up" → `/signup` when `signup` is true (the landing
  already reads `/api/auth/status`).

## Access requests (sign-up by application)

For instances that admit people by hand (capacity on Workers Free, platform app caps such as TikTok's unaudited
apps, app reviews that want to see a gated, real service): `signup_mode = apply`.

- `GET /api/auth/status` has `signupMode: "apply"` (no `signup`). The landing page turns its sign-up pills and a hero
  button into "Request access" → `/apply` ("Sign up" → `/signup` stays for `open`; nothing changes when the API is
  unreachable); the sign-in page shows "Don't have an account? Request access".
- `/apply` (SPA route, signed out): name\*, email\*, company or brand, website or main social profile\* (http/https,
  `example.com` becomes `https://example.com/`), role\* (Creator, Agency, Startup / app developer, Brand / marketing
  team, Other), platforms\* (X, Instagram, TikTok, YouTube, LinkedIn, Facebook, Threads, Bluesky, Pinterest, Other),
  accounts to connect (0-1000), posts per month (1-30, 31-100, 101-300, 301-1000, 1000+), use case\* (20-1000
  characters), how they heard (≤ 200), consent\* (Terms + Privacy Policy). Turnstile action `apply` when configured.
  The confirmation is the same for everyone: "We review every request by hand, usually within a few days. We'll email
  you at …".
- `POST /api/access-requests` (public; 404 unless `apply`): validates, throttles (5 per IP per hour, 3 per email per
  day; settings counters `apply:<ip>` / `apply:email:<email>`, cleaned daily), bot check, then **one D1 batch**:
  counters, `INSERT … ON CONFLICT (email) WHERE status = 'pending' DO UPDATE` (a pending request of the same email is
  updated, never duplicated), the admin push devices and the admin emails. Only a new request notifies, after the
  response: APNs push type `access_request` to at most 5 admin devices (instance.users.manage, device pref
  `accessRequests` default on) and an email to at most 3 instance admins when email is configured. Always `{ ok }`.
- Table `access_requests` (migration 0017): id, name, email, company, url, role, platforms (JSON), accounts, volume,
  use_case, referral, status (`pending | approved | rejected | withdrawn`), ip, country, user_agent, created_at,
  updated_at, reviewed_by, reviewed_at, review_note, invitation_id. Nothing is deleted automatically except rejected
  requests 180 days after their last change.
- Review (`instance.users.manage`): **Admin → Requests** (status tabs with counts, search, detail drawer, nav badge with
  the pending count), and the iOS app (Settings → Access requests). Not through API keys (they are workspace-scoped and carry no
  instance permissions), so not through the CLI or MCP.
  - Approve: an invitation through the normal machinery (`invitations` row, email-bound, instance role Member, a new
    workspace named after the company or "<name>'s workspace", 7 days). The applicant accepts it with the usual
    `/invite/<token>` page and owns the new workspace (trial when billing is on). The link is emailed when email is
    configured (template "Your Postflare access request was approved") and always returned, so the admin can send it
    by hand on Workers Free (where Email Sending only reaches verified addresses). Approving again while the invitation
    is unused issues a new link and revokes the old one. An email that already has an account is only marked approved.
  - Reject: optional note; with `notify` (default) and email configured, a short polite email includes it. Rejecting an
    approved request revokes its unused invitation.
- Endpoints: [api.md](api.md) "Access requests".

## Permissions

- New workspace permission `billing.manage` ("Manage billing": see plan and usage, upgrade, open the billing portal,
  cancel). Owner only (migration adds it to the built-in Owner like 0008 did for `playbooks.manage`). Everyone with
  `posts.read` sees the plan name and limits in the usage meter.
- Admin → Billing needs `instance.settings.manage`; per-workspace plan overrides need `instance.users.manage`.

## API

Workspace (session or API key with the permission):
- `GET /api/billing` → `{ enabled, plan, status, trialEndsAt, currentPeriodEnd, interval, provider, exempt, usage: { accounts, postsThisMonth, xPostsThisMonth, members, storageMb }, limits, plans: [public plan list], canManage }`
- `POST /api/billing/checkout { planId, interval }` → `{ url }` (billing.manage; 409 if already subscribed through a provider: use the portal to change plans)
- `POST /api/billing/portal` → `{ url }` (billing.manage)

Public:
- `GET /api/billing/plans` → active plans for the pricing table (landing page, sign-up page), `{ enabled, currency, plans }`
- `POST /api/billing/webhooks/:provider`

Instance admin (`instance.settings.manage`):
- `GET/PATCH /api/admin/billing` → `{ enabled, activeProvider, providers: [{ id, name, configured, sandbox, webhookUrl, fields }], trialDays, pastDueGraceDays, signupEnabled }` (secrets never returned, only "set")
- `PUT /api/admin/billing/providers/:id` (credentials) · `DELETE` · `POST …/:id/test`
- `GET/POST/PATCH/DELETE /api/admin/billing/plans[/:id]` (delete only without subscribers, else archive)
- `PATCH /api/admin/workspaces/:id/billing { exempt?, planId?, status?, trialEndsAt? }` (`instance.users.manage`, provider `manual`)
- Admin → Overview gains: paying workspaces, trialing, past due, MRR estimate (sum of monthly prices + yearly/12).

## UI

- **Admin → Billing** (new page): enable switch (refused with a clear message until a provider is configured and a paid
  plan exists), provider cards (Polar first, "Recommended: merchant of record, handles VAT/sales tax, no Stripe account
  needed"; each with fields, sandbox toggle, webhook URL to copy, events to subscribe to, Test connection, "Use for new
  sales" radio), plans table with editor (limits form, prices, provider product ids per provider, free/trial default,
  highlight, archive), trial days and grace days, "Create suggested plans".
- **Admin → Settings**: "Sign-up" card (Invitation only / Request access / Open sign-up, warnings without email or
  bot protection). "Legal & contact" card: operator name, contact email, optional postal address, country and
  effective date, filled into `/privacy/` and `/terms/` (rendered by the Worker); the subscription clauses (merchant of
  record, trial, renewal, cancellation, refunds, price changes, free plan) appear there only while billing is on. **Admin → Requests**: access requests.
- **Workspace settings → Billing** tab: current plan + status badge, trial countdown, usage meters vs limits,
  pricing cards with month/year switch → checkout redirect, "Manage billing" → portal, return URLs
  `/workspace?tab=billing&checkout=success|canceled` (success shows "Payment received, your plan updates in a moment"
  and polls `GET /api/billing` a few times since the webhook may arrive after the redirect).
- **Banner** in the layout: trial ends in ≤3 days, trial over / locked, past due. Links to the Billing tab (or tells
  non-owners to ask the owner).
- **Limit errors**: 402 responses show a toast/dialog with "Upgrade" for users with billing.manage.
- **Sign-up page** `/signup`, **verify page** `/auth/verify`.
- Hidden entirely when billing/sign-up are off (self-hosted look unchanged).

## Host hooks (what a port to Adsflare/Revflare changes)

`worker/billing/` gets everything through a small adapter:
- `limitsCatalog`: the product's limit keys, labels and counters (one SQL each).
- where to call `assertWithinLimit(c, key, adding)` (create endpoints) and `assertNotLocked(c)` (write endpoints, background jobs).
- workspace creation paths call `startTrial(db, workspaceId, userId)`.
Adsflare limit ideas: Apple Ads accounts, managed campaigns, automation rules, members. Revflare: apps, monthly tracked
transactions/events, members.

## Free plan constraints

- Each billing request: ≤10 D1 queries, one provider fetch, Web Crypto HMAC only.
- No new cron triggers; trial expiry is evaluated lazily (computed from timestamps on read). The existing daily job
  deletes old `billing_events`, unverified pending users and expired verify links, and sends nothing.

## Out of scope for now

Usage-based credits (see the credit design in the cost report), coupons (the providers have them; checkout pages accept
them), invoices UI (provider portal), taxes (merchant-of-record providers handle them; Stripe users must enable Stripe
Tax themselves), per-workspace platform apps (own X keys).

## Implementation notes (deviations from the text above)

Code: `worker/billing/` (`host.ts` is the Postflare adapter: limit keys, labels, counters, suggested plans; everything
else is product-neutral), migrations `0013_billing.sql` and `0014_billing_post_counts.sql`, tests `test/workers/billing*.test.ts`, `signup.test.ts`,
`test/billing-entitlements.test.ts`. Endpoints: docs/api.md "Hosted mode".

- **Billing on is derived.** The admin switch is `billing_enabled`; `billing_on` = "1" is recomputed after every admin
  change (switch, providers, plans) and read inside the query that already loads the request's workspace (scalar
  subqueries on `settings` and `plans`), so with billing off no request makes an extra D1 query and limit checks
  return without counting. Removing the active provider (refused while billing is on) or archiving the last paid plan
  switches billing off, which lifts every limit rather than locking everyone out.
- **Exempt on first activation.** Besides the migration (every workspace at upgrade time), the first time billing
  goes on every workspace without a plan becomes exempt, so workspaces created between the upgrade and the activation
  (the operator's) stay unlimited. Sign-ups made while billing was still off are comped too; un-comp them in Admin.
- **Extra columns:** `workspaces.billing_past_due_since` (start of the grace period: `past_due` is paid while
  `past_due_since + past_due_grace_days` is in the future), `users.trial_used_at` (one trial per user),
  `magic_links.purpose` (`login` | `verify`) and `magic_links.data` (the sign-up's workspace name),
  `billing_events.nonce` (the workspace update is guarded on the request that recorded the event, in the same batch,
  so a failed update is retried by the provider instead of being lost as a "duplicate").
- **Status mapping** (provider → ours): active/trialing → `active` (`canceled` when set to cancel at period end);
  past_due/unpaid → `past_due`; canceled before the end → `canceled` with `current_period_end` = access end; ended,
  revoked, deleted, expired, paused → `expired`; incomplete checkouts are ignored. A paid subscription clears the local
  trial. A late terminal event of an older subscription id never ends the workspace's newer subscription. Events with a
  provider timestamp older than `billing_updated_at` are ignored (`billing_updated_at` stores the provider's event time).
- **Paying but unmapped:** an active subscription whose product id is not in any plan keeps the workspace's plan (or,
  without one, no limits) and logs a warning: a paying customer is never locked by a configuration mistake.
- **Locked** blocks: new posts, scheduling (`PATCH` that schedules, retry, resolve-and-republish, comments), connecting
  accounts, media uploads/imports/multipart and upload links, invitations, API keys. Playbooks, account groups and
  apps can still be edited. Reconnecting an existing account is allowed.
- **Monthly posts are counted from usage events plus pending posts** (see "Monthly posts" above), not post rows by
  `created_at`: an earlier draft of this implementation let users publish, delete and get the quota back.
- **Sign-up details:** verification links last 24 hours (sign-in links 15 minutes); signing up again with a pending
  email replaces its password and link (only the mailbox owner can confirm it); without email configured an existing
  email answers 409 (no way to stay enumeration-safe without sending mail). `POST /api/auth/signup/verify` activates.
  Pending users never count for "setup done" (`hasUsers`), cannot use sessions, sign-in links or API keys, and are
  listed in Admin → Users as `pending` (an admin can activate them).
- **Additional endpoints:** `POST /api/admin/billing/plans/suggested`, `GET /api/admin/billing/workspaces`,
  `GET /api/admin/workspaces/:id/billing`, `GET/PATCH /api/admin/signup` (the Admin → Settings card),
  `POST /api/auth/signup/verify`. `GET /api/billing` adds `state`, `graceEndsAt`, `hasSubscription`,
  `subscribedPlanId`; plans carry `checkoutIntervals`.
- **Overview:** MRR counts provider subscriptions only (plans assigned by hand are reported as `manual`); the numbers
  ride in an existing statement of the overview batch (still one round trip of 12 statements).
- **Workflow:** the "sandbox check" step now reads the demo flag and the billing state in one query; a locked
  workspace's post is marked failed in a "mark locked" step. Instances that ran the step before the upgrade get a
  boolean back and keep the old behaviour.
