/**
 * Instance-aware legal pages: /privacy/, /terms/ and /data-deletion/ (rendered by the Worker, worker/routes/legal.ts).
 *
 * The operator of an instance fills in Admin → Settings → "Legal & contact" (who runs it, a contact email, optionally
 * a postal address, a country and an effective date). Without these values the pages keep the generic self-host
 * wording ("contact its operator"). The subscription clauses only appear while billing is in effect on the instance
 * (`billing_on`); the TikTok, Meta and Google sections always stay, since they describe what the software does.
 *
 * Pure functions (no Workers APIs) so the Node tests can render them too. public/privacy/, public/terms/ and
 * public/data-deletion/ hold the generic rendering (`STATIC_CONTEXT`) as a fallback for deployments whose
 * `assets.run_worker_first` does not list these paths yet; test/legal.test.ts fails when they are stale
 * (`UPDATE_LEGAL=1 npx vitest run test/legal.test.ts` rewrites them).
 */
import type { AdminLegalDTO, BillingProviderId, SignupMode } from "../../shared/types";

/** Settings keys (table `settings`, one row each; absent = not set). */
export const LEGAL_SETTING = {
  operatorName: "legal_operator_name",
  contactEmail: "legal_contact_email",
  postalAddress: "legal_postal_address",
  country: "legal_country",
  effectiveDate: "legal_effective_date",
} as const;

/** Date of the current wording, shown as "Last updated" unless the operator sets an effective date. */
export const LEGAL_VERSION_DATE = "2026-10-20";

export const LEGAL_LIMITS = { operatorName: 200, contactEmail: 254, postalAddress: 500, country: 100 } as const;

export interface BillingTerms {
  provider: BillingProviderId | null;
  /** Days of the local trial (0 = none). */
  trialDays: number;
  /** Name of the plan new workspaces try (null = no trial plan, so no trial). */
  trialPlan: string | null;
  /** An active free plan exists. */
  freePlan: boolean;
  graceDays: number;
}

export interface LegalContext {
  /** Host of the instance (null in the static fallback). */
  host: string | null;
  legal: AdminLegalDTO;
  /** null = unknown (static fallback). */
  signupMode: SignupMode | null;
  /** null = billing not in effect. */
  billing: BillingTerms | null;
  /** null = unknown (static fallback: the default is described). */
  mediaRetentionDays: number | null;
}

export const EMPTY_LEGAL: AdminLegalDTO = { operatorName: null, contactEmail: null, postalAddress: null, country: null, effectiveDate: null };

/** What the static files in public/ are rendered with. */
export const STATIC_CONTEXT: LegalContext = { host: null, legal: EMPTY_LEGAL, signupMode: null, billing: null, mediaRetentionDays: null };

// ---------- Settings ----------

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** YYYY-MM-DD that is a real calendar date. */
export function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Validates PUT /api/admin/legal. Empty strings and null clear a value; absent keys are left as they are. */
export function parseLegalInput(body: unknown): { values: Partial<AdminLegalDTO> } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid body" };
  const b = body as Record<string, unknown>;
  const values: Partial<AdminLegalDTO> = {};
  for (const key of Object.keys(LEGAL_SETTING) as (keyof AdminLegalDTO)[]) {
    if (!(key in b)) continue;
    const raw = b[key];
    if (raw !== null && typeof raw !== "string") return { error: `${key} must be a string` };
    const v = key === "postalAddress" ? (raw ?? "").replace(/\r\n?/g, "\n").trim() : (raw ?? "").replace(/\s+/g, " ").trim();
    if (!v) {
      values[key] = null;
      continue;
    }
    if (key in LEGAL_LIMITS && v.length > LEGAL_LIMITS[key as keyof typeof LEGAL_LIMITS]) {
      return { error: `${LABELS[key]} is too long (at most ${LEGAL_LIMITS[key as keyof typeof LEGAL_LIMITS]} characters)` };
    }
    if (key === "contactEmail" && !EMAIL_RE.test(v)) return { error: "Enter a valid contact email" };
    if (key === "effectiveDate" && !validDate(v)) return { error: "The effective date must be a date (YYYY-MM-DD)" };
    values[key] = v;
  }
  return { values };
}

const LABELS: Record<keyof AdminLegalDTO, string> = {
  operatorName: "Operator name",
  contactEmail: "Contact email",
  postalAddress: "Postal address",
  country: "Country",
  effectiveDate: "Effective date",
};

/** Settings rows → the stored legal values. */
export function legalFromRows(rows: Map<string, string>): AdminLegalDTO {
  const out = { ...EMPTY_LEGAL };
  for (const [key, setting] of Object.entries(LEGAL_SETTING) as [keyof AdminLegalDTO, string][]) out[key] = rows.get(setting)?.trim() || null;
  return out;
}

/**
 * Everything the pages need, in one D1 query: the legal settings, the sign-up mode, the media retention, the billing
 * state and the trial/free plans.
 */
export async function loadLegalContext(db: D1Database, host: string): Promise<LegalContext> {
  const keys = [
    ...Object.values(LEGAL_SETTING),
    "signup_mode",
    "media_retention_days",
    "billing_on",
    "billing_provider",
    "billing_trial_days",
    "billing_past_due_grace_days",
  ];
  const { results } = await db
    .prepare(
      `SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(", ")})
       UNION ALL SELECT 'plan:trial', (SELECT name FROM plans WHERE is_trial_default = 1 AND active = 1 ORDER BY position LIMIT 1)
         WHERE EXISTS (SELECT 1 FROM plans WHERE is_trial_default = 1 AND active = 1)
       UNION ALL SELECT 'plan:free', '1' WHERE EXISTS (SELECT 1 FROM plans WHERE is_free = 1 AND active = 1)`,
    )
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const s = new Map(results.map((r) => [r.key, r.value]));
  const days = (v: string | undefined, fallback: number) => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  const provider = s.get("billing_provider");
  const mode = s.get("signup_mode");
  return {
    host,
    legal: legalFromRows(s),
    signupMode: mode === "apply" || mode === "open" ? mode : "off",
    mediaRetentionDays: days(s.get("media_retention_days"), 30),
    billing:
      s.get("billing_on") === "1"
        ? {
            provider: provider === "polar" || provider === "stripe" || provider === "lemonsqueezy" ? provider : null,
            trialDays: days(s.get("billing_trial_days"), 7),
            trialPlan: s.get("plan:trial") ?? null,
            freePlan: s.has("plan:free"),
            graceDays: days(s.get("billing_past_due_grace_days"), 7),
          }
        : null,
  };
}

// ---------- HTML helpers ----------

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const a = (href: string, text: string) => `<a href="${esc(href)}">${text}</a>`;
const h2 = (id: string, title: string) => `<h2 id="${id}">${title}</h2>`;
const p = (html: string) => `<p>${html}</p>`;
const ul = (items: (string | false | null | undefined)[]) => `<ul>\n${items.filter(Boolean).map((i) => `<li>${i}</li>`).join("\n")}\n</ul>`;

const STYLE =
  ":root{color-scheme:light dark;font-family:-apple-system,system-ui,sans-serif;line-height:1.6}body{max-width:720px;margin:0 auto;padding:40px 20px}h1{font-size:28px}h2{font-size:18px;margin-top:28px}.muted{color:#888}";

function page(title: string, body: string, extra: { style?: string; head?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Postflare</title><link rel="icon" href="/favicon.svg">
<style>${STYLE}${extra.style ?? ""}</style>${extra.head ? `\n${extra.head}` : ""}
</head><body><p><a href="/">Postflare</a></p>${body}
</body></html>
`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-20" → "October 20, 2026". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const updated = (ctx: LegalContext) => `<p class="muted">Last updated: ${longDate(ctx.legal.effectiveDate ?? LEGAL_VERSION_DATE)}</p>`;

/** "the operator at <a>mail</a>" or "the operator of this instance". */
function contactOperator(ctx: LegalContext): string {
  const mail = ctx.legal.contactEmail;
  return mail ? `the operator at ${a(`mailto:${mail}`, esc(mail))}` : "the operator of this instance";
}

/** "This Postflare instance (host) is operated by X (“the operator”)" / the generic sentence. */
function operatorIntro(ctx: LegalContext): string {
  const where = ctx.host ? ` at ${esc(ctx.host)}` : "";
  const op = ctx.legal.operatorName;
  const from = ctx.legal.country ? `, ${esc(ctx.legal.country)}` : "";
  return op
    ? `This Postflare instance${where} is operated by ${esc(op)}${from} (“the operator”), who decides who may use it.`
    : `This Postflare instance${where} is run by its operator (“the operator”), who decides who may use it.`;
}

/** The contact block (name, address, country, email), or the generic sentence. */
function contactBlock(ctx: LegalContext, generic: string): string {
  const { operatorName, postalAddress, country, contactEmail } = ctx.legal;
  if (!operatorName && !contactEmail) return p(generic);
  const lines = [
    operatorName && esc(operatorName),
    postalAddress && esc(postalAddress).replace(/\n/g, "<br>"),
    country && esc(country),
    contactEmail && `Email: ${a(`mailto:${contactEmail}`, esc(contactEmail))}`,
  ].filter(Boolean);
  return `<p>${lines.join("<br>")}</p>`;
}

const PROVIDER_NAMES: Record<BillingProviderId, string> = { polar: "Polar", stripe: "Stripe", lemonsqueezy: "Lemon Squeezy" };
const PROVIDER_SITES: Record<BillingProviderId, string> = { polar: "https://polar.sh", stripe: "https://stripe.com", lemonsqueezy: "https://www.lemonsqueezy.com" };
/** Merchant of record: the provider is the seller (taxes, invoices, refunds). Stripe only processes payments for the operator. */
const isMerchantOfRecord = (id: BillingProviderId | null) => id === "polar" || id === "lemonsqueezy";
const providerLink = (id: BillingProviderId) => a(PROVIDER_SITES[id], PROVIDER_NAMES[id]);

const TIKTOK = {
  terms: "https://www.tiktok.com/legal/terms-of-service",
  privacy: "https://www.tiktok.com/legal/privacy-policy",
  guidelines: "https://www.tiktok.com/community-guidelines",
  branded: "https://www.tiktok.com/legal/page/global/bc-policy/en",
};

// ---------- Privacy Policy ----------

export function renderPrivacy(ctx: LegalContext): string {
  const billing = ctx.billing;
  const pay = billing?.provider ?? null;
  const apply = ctx.signupMode === "apply" || ctx.signupMode === null;
  const retention =
    ctx.mediaRetentionDays === null
      ? "after 30 days by default; the operator can change this"
      : ctx.mediaRetentionDays === 0
        ? "on this instance unused media is kept until you delete it"
        : `on this instance after ${ctx.mediaRetentionDays} day${ctx.mediaRetentionDays === 1 ? "" : "s"}`;

  const body = [
    `<h1>Privacy Policy</h1>${updated(ctx)}`,
    p(
      `Postflare is open-source social media scheduling software. ${operatorIntro(ctx)} This policy explains what this instance collects about the people who use it${apply ? " or apply to use it" : ""} (“users”), why, who else receives it, how long it is kept and how to have it deleted.`,
    ),

    h2("operator", "Who is responsible"),
    ctx.legal.operatorName || ctx.legal.contactEmail
      ? p(
          `The operator is responsible for the personal data processed by this instance (the “controller”). Contact details: ${[
            ctx.legal.operatorName && esc(ctx.legal.operatorName),
            ctx.legal.postalAddress && esc(ctx.legal.postalAddress).replace(/\n/g, ", "),
            ctx.legal.country && esc(ctx.legal.country),
          ]
            .filter(Boolean)
            .join(", ")}${ctx.legal.contactEmail ? `${ctx.legal.operatorName || ctx.legal.postalAddress || ctx.legal.country ? ", " : ""}${a(`mailto:${ctx.legal.contactEmail}`, esc(ctx.legal.contactEmail))}` : ""}.`,
        )
      : p("Each Postflare instance is run independently by its operator, who is responsible for the personal data it processes. The authors of the Postflare software do not receive any data from this instance."),

    h2("collect", "What we collect"),
    ul([
      `<strong>Your user account:</strong> your name, email address, a hashed password, your role and the workspaces you belong to, and your sign-in sessions (including the iOS app sessions you name). API keys, invitations and sign-in links are stored only as hashes. To limit failed sign-ins and abuse, the IP address of a request is kept for a short time with a counter.`,
      apply &&
        `<strong>Access requests:</strong> when you ask for access${ctx.signupMode === null ? " (on instances that admit people by application)" : ""}, the form's answers: name, email, company or brand, website or main social profile, role, the platforms you use, how many accounts you would connect, your expected posts per month, your use case and how you heard about Postflare. With them we store the IP address, country and browser (user agent) of the request, and the operator's review (status, note, invitation).`,
      `<strong>Connected social media accounts:</strong> the access and refresh tokens the platform issues (encrypted), and the account's basic profile: account id, display name, username, avatar and profile link, plus the choices needed to post (for example a Facebook Page, a Pinterest board or a YouTube playlist).`,
      `<strong>Posts and media:</strong> the text, images, videos and settings of the posts you create or schedule, their status and the platform's answers (post ids, links, error messages), and the files in your media library with their thumbnails.`,
      `<strong>Performance metrics:</strong> views, likes, comments, shares and similar counts of posts published through Postflare, and follower and post counts of connected accounts, collected about 1 hour, 1 day, 3 days, 7 days and 30 days after publishing.`,
      `<strong>Tracked App Store links</strong> (if your workspace uses them): the number of clicks per link and day. No IP address, cookie or device identifier is stored for a click.`,
      `<strong>iOS app:</strong> the device name, its Apple push token and your notification preferences. When you approve a web sign-in with the app, the browser's IP address, approximate location (city and country) and browser type are shown on your phone; they are deleted within a day.`,
      billing &&
        pay &&
        `<strong>Billing:</strong> paid plans are ${isMerchantOfRecord(pay) ? `sold by ${providerLink(pay)} as merchant of record` : `processed by ${providerLink(pay)}`}. ${PROVIDER_NAMES[pay]} collects your payment card or other payment details, billing address and tax information under its own privacy policy. Postflare never receives or stores card data: it stores only each workspace's plan, subscription status, billing interval, trial and renewal dates and ${PROVIDER_NAMES[pay]}'s customer and subscription ids. When you start a checkout, your email address and workspace id are sent to ${PROVIDER_NAMES[pay]}.`,
      `<strong>Usage records:</strong> for each publish attempt, the platform, the post type, the number and size of media files and the outcome (with the platform's error message, if any), used for plan limits, reliability and capacity planning. They do not contain the text of your posts.`,
    ]),
    p(
      "Postflare sets one cookie, the sign-in session cookie, which is needed for the service to work. It uses no advertising or analytics trackers, and no data is collected from people who only view posts you publish.",
    ),

    h2("use", "How it is used"),
    p(
      `This data is used only to provide the service: to sign you in and keep your account secure, publish the posts you schedule to the accounts you connected, refresh their access tokens, show you and the members of your workspace the posts' status and performance, send the emails and notifications you expect (sign-in links, invitations, sign-up confirmations, decisions on access requests, publishing results)${apply ? ", review access requests" : ""}${billing ? ", apply your plan and its limits" : ""}, and prevent abuse. It is not sold, not shared with third parties except as described below, not used for advertising and not used to train AI models.`,
    ),
    p(
      "If you connect an AI assistant or another tool to your workspace through an API key or MCP, that tool can read and change your workspace's data on your behalf; it is your choice and that tool's provider handles the data under its own terms.",
    ),
    p(
      "Legal bases (where the GDPR, the UK GDPR, Türkiye's KVKK or similar laws apply): providing the service you asked for (contract); keeping it secure, preventing abuse and reviewing access requests (legitimate interests); connecting accounts and push notifications, which you can withdraw at any time (consent); and keeping records the law requires (legal obligation).",
    ),

    h2("tiktok", "TikTok data"),
    p(
      `When you connect a TikTok account, Postflare uses TikTok's Login Kit and Content Posting API with the scopes below, each only for the purpose listed:`,
    ),
    ul([
      `<code>user.info.basic</code>: your TikTok open id, display name and avatar, to show which account is connected.`,
      `<code>user.info.profile</code>: your username (and profile link), shown in Postflare and used to link to your published posts.`,
      `<code>video.publish</code>: to publish the videos and photos you schedule directly to your profile with the caption, privacy level (“who can view”), comment, duet and stitch settings and commercial content disclosure you choose. Before posting, Postflare reads your creator info (the privacy options and maximum video length TikTok allows for your account) to offer only valid choices.`,
      `<code>video.upload</code>: to send videos and photos to your TikTok inbox as drafts instead, when you choose that mode, so you finish the post in the TikTok app.`,
      `<code>video.list</code> and <code>user.info.stats</code>, only when the operator has turned on TikTok analytics for this instance: the view, like, comment and share counts of the posts published through Postflare (looked up by their ids only), and your account's follower, following, like and video counts, to show you their performance.`,
    ]),
    p(
      `Videos are uploaded to TikTok from this instance's storage; for photo posts TikTok downloads the images from this instance's media links. Postflare does not read your direct messages, comments, followers, other videos or anything else in your TikTok account. TikTok business accounts connected through the TikTok API for Business (“TikTok Business”) use that API's equivalent scopes (<code>user.info.basic</code>, <code>user.info.username</code>, <code>user.info.stats</code>, <code>video.list</code>, <code>video.upload</code>, <code>video.publish</code>) for the same purposes.`,
    ),
    p(
      `What is stored: the encrypted access and refresh tokens, the profile information above, the posts you scheduled with TikTok's publish ids and post ids, and their metrics. TikTok data is not sold, not shared with third parties, not used for advertising and not used to train AI models; it is shown only to you and the members of your workspace. Your use of TikTok remains subject to ${a(TIKTOK.terms, "TikTok's Terms of Service")} and ${a(TIKTOK.privacy, "Privacy Policy")}.`,
    ),
    p(
      `To revoke access, open the TikTok app and go to <em>Profile → Menu (☰) → Settings and privacy → Security → Manage app permissions</em>, then remove this app. Postflare then can no longer post or read anything, and the account shows as needing a reconnect. To delete the data stored here, remove the account in Postflare (<em>Accounts → the account → Remove</em>): this deletes its tokens, profile data, posts scheduled for it and their metrics at once. Posts already published stay on TikTok until you delete them there. You can also ask ${contactOperator(ctx)} to delete everything.`,
    ),

    h2("meta", "Meta data (Instagram, Threads and Facebook)"),
    p(
      "When a user connects an Instagram professional account, a Threads profile or a Facebook Page, Postflare uses Meta's APIs only to publish the posts, reels, carousels and stories the user schedules to that account, post the first comment or reply the user wrote for them, and read the account's basic profile (id, username, name, profile picture, account type) to show which account is connected. It reads insights (such as views, reach, likes, comments, shares and follower counts) of posts published through Postflare and of the account, to show the user their performance. Postflare does not read direct messages, does not read or reply to other people's comments, and does not access accounts the user did not connect. Meta data is not sold, shared with third parties, used for advertising, or used to train AI models; it is shown only to the user and the members of their workspace. Removing the app in Facebook, Instagram or Threads settings (Apps and websites) makes Meta ask this instance to delete the data automatically.",
    ),

    h2("google", "Google and YouTube data"),
    p(
      `When a user connects a YouTube channel, Postflare uses the YouTube Data API only to upload videos the user chooses to the user's own channel, set their title, description, privacy, playlist and thumbnail, and post a first comment. It reads the list of the user's channels, playlists and video categories to offer these choices, and the view, like and comment counts of videos published through Postflare and the channel's subscriber and video counts to show the user their performance. Postflare's use and transfer of information received from Google APIs adheres to the ${a("https://developers.google.com/terms/api-services-user-data-policy", "Google API Services User Data Policy")}, including the Limited Use requirements. Google user data is not sold, shared with third parties, used for advertising, or used to train AI models. Postflare uses YouTube API Services: by connecting a channel you also agree to the ${a("https://www.youtube.com/t/terms", "YouTube Terms of Service")}, and Google handles your data under the ${a("https://policies.google.com/privacy", "Google Privacy Policy")}. Access can be revoked at any time at ${a("https://myaccount.google.com/permissions", "myaccount.google.com/permissions")}.`,
    ),

    h2("other-platforms", "Other platforms"),
    p(
      "For every other platform you connect (for example X, LinkedIn, Bluesky, Pinterest or Reddit) the same rules apply: Postflare uses its official API only to read your basic profile, publish what you schedule and read the performance of those posts and of the account.",
    ),

    h2("recipients", "Who else receives data"),
    ul([
      `<strong>Cloudflare, Inc.</strong> hosts this instance: its servers (Workers), database (D1), file storage (R2) and image processing (Images), and, when the operator turns them on, outgoing email (Email Sending) and the bot check on sign-up and sign-in forms (Turnstile). Cloudflare processes data in data centers around the world and may keep short-lived request logs (such as IP addresses) for operation and security.`,
      billing && pay && `<strong>${PROVIDER_NAMES[pay]}</strong> handles payments for paid plans, as described above.`,
      `<strong>Apple</strong> (Apple Push Notification service) delivers notifications to the iOS app if you turn them on. A notification contains the account and platform name and the start of the post text (for publishing results), the browser and approximate location of a sign-in request, or, for instance admins, the name, company and role of a new access request.`,
      `<strong>The platforms you connect</strong> receive the content you publish to them, on your instruction, and handle it under their own terms and privacy policies.`,
      `<strong>Services you connect yourself</strong>, such as a Revflare instance for App Store numbers, a webhook or an AI assistant, receive what you send to them.`,
      `<strong>Authorities</strong>, only when the law requires it.`,
    ]),
    p(
      "When data is processed outside your country (for example in the United States), these providers protect it under their data processing terms, including the EU Standard Contractual Clauses where applicable.",
    ),

    h2("security", "Storage and security"),
    p(
      `Data is stored on Cloudflare infrastructure (Workers, D1 and R2) and sent over HTTPS. Access tokens are encrypted at rest; passwords, API keys, sessions and invitation and sign-in links are stored only as hashes. Workspaces are isolated from each other and members only get the permissions of their role. Media files are served through long, unguessable links, because the platforms must be able to download them; anyone who has such a link can open the file.`,
    ),

    h2("retention", "How long data is kept"),
    ul([
      "Your user account: as long as it exists. An instance admin deletes it on request.",
      "Connected accounts, their posts and metrics: until you remove the account or delete the workspace.",
      `Media files: until you delete them, and otherwise automatically once no scheduled or recent post needs them (${retention}).`,
      apply &&
        "Access requests: pending and approved requests are kept as a record of who was admitted; rejected requests are deleted 180 days after their last change. Ask the operator to delete yours sooner.",
      "Sign-ups that were never confirmed: 7 days. Sign-in sessions: 30 days on the web, and up to a year for the iOS app while it is used. Counters with IP addresses (sign-in and abuse limits) and web sign-in approvals: deleted once they expire, within a few days at most.",
      "Usage records: 400 days.",
      billing && `Billing: the plan and subscription status are kept while the workspace exists; records of payment provider events are deleted after 90 days. ${pay ? PROVIDER_NAMES[pay] : "The payment provider"} keeps invoices and payment records as tax law requires.`,
      "Meta data deletion requests (confirmation code and number of removed accounts): 90 days.",
    ]),

    h2("rights", "Your rights"),
    p(
      `You can access, correct, export and delete your data, restrict or object to its processing, and withdraw your consent at any time. Much of this you can do yourself: change your name and password in your profile, remove connected accounts, delete posts and media, and delete a workspace you own. For anything else, including a copy of your data, deleting your user account or correcting information, contact ${contactOperator(ctx)}; requests are answered within 30 days. You can also complain to the data protection authority where you live.`,
    ),

    h2("deletion", "Deleting data"),
    p(
      `Disconnecting an account in Postflare deletes its stored tokens and profile data. You can also revoke Postflare's access at any time from the connected platform's own settings (for TikTok: Settings and privacy → Security → Manage app permissions; for Facebook, Instagram and Threads: Apps and websites, after which Meta asks this instance to delete your data automatically). See ${a("/data-deletion/", "Data Deletion")} for the details and to check the status of a deletion request.`,
    ),

    h2("children", "Children"),
    p(
      `This instance is not meant for children: you must be at least 16 years old to use it${apply ? " or apply for access" : ""}. The operator does not knowingly collect personal data of children under 13 (under 16 in the EEA and the UK). If you believe a child has given us personal data, contact ${contactOperator(ctx)} and it will be deleted.`,
    ),

    h2("changes", "Changes"),
    p("This policy may be updated; the date above shows the latest version. Material changes are announced to users (for example by email) before they take effect."),

    h2("contact", "Contact"),
    contactBlock(ctx, "For questions about this instance or to have your data deleted, contact its operator."),
  ];
  return page("Privacy Policy", body.join("\n"));
}

// ---------- Terms of Service ----------

export function renderTerms(ctx: LegalContext): string {
  const billing = ctx.billing;
  const pay = billing?.provider ?? null;
  const op = ctx.legal.operatorName;
  const where = ctx.host ? ` at ${esc(ctx.host)}` : "";

  const access: Record<"off" | "apply" | "open" | "unknown", string> = {
    apply:
      "Access is by application. Submitting a request does not guarantee access: the operator reviews every request by hand and may approve or decline it at its discretion, without having to give a reason. An approved applicant receives a personal invitation to create an account.",
    off: "Only people the operator invites can create an account.",
    open: "Anyone who meets these terms can create an account. The operator may refuse or close an account at its discretion.",
    unknown: "Only people the operator has given access can sign in.",
  };

  const trial = billing && billing.trialDays > 0 && billing.trialPlan;
  const afterTrial = billing?.freePlan ? "moves to the free plan" : "becomes read-only (you can still view and delete everything) until a paid plan is chosen";

  const body = [
    `<h1>Terms of Service</h1>${updated(ctx)}`,
    p(
      op
        ? `These terms govern your use of the Postflare service${where}, operated by ${esc(op)}${ctx.legal.country ? `, ${esc(ctx.legal.country)}` : ""} (“the operator”, “we”). By applying for access, creating an account or using the service, you agree to them and to the ${a("/privacy/", "Privacy Policy")}.`
        : `Postflare is open-source, self-hosted software for scheduling and publishing content to social media accounts. ${operatorIntro(ctx)} These terms govern the use of this instance; by using it you agree to them and to the ${a("/privacy/", "Privacy Policy")}.`,
    ),

    h2("service", "The service"),
    p(
      "Postflare lets you connect your social media accounts, schedule posts and media, publish them through each platform's official API, and see how they perform. Content is published to connected accounts solely on the instruction of their users.",
    ),

    h2("access", "Access and accounts"),
    p(access[ctx.signupMode ?? "unknown"]),
    p(
      "You must be at least 16 years old and able to agree to these terms. Give accurate information, keep your password and API keys safe, and tell the operator if you think someone else used your account. You are responsible for what happens in your account and for the members you invite to your workspaces.",
    ),
    p(
      "The operator may suspend or close an account or workspace, or disconnect an account from it, if it breaks these terms or the law, puts the service, other users or the connected platforms at risk, or if a platform requires it. Where reasonable, the operator tells you first.",
    ),

    h2("acceptable-use", "Acceptable use"),
    p("When you use Postflare you must comply with the terms of every platform you connect, in particular:"),
    ul([
      `for TikTok: the ${a(TIKTOK.terms, "TikTok Terms of Service")}, the ${a(TIKTOK.guidelines, "Community Guidelines")} and the ${a(TIKTOK.branded, "Branded Content Policy")} (use the commercial content disclosure when a post promotes a brand, product or service);`,
      `for YouTube: the ${a("https://www.youtube.com/t/terms", "YouTube Terms of Service")};`,
      "for Instagram, Facebook and Threads: Meta's terms and community standards; and the rules of every other platform you post to.",
    ]),
    p("You must not:"),
    ul([
      "send spam, post in automated bulk, or post at a volume or frequency meant to manipulate a platform's reach or ranking;",
      "artificially inflate engagement, impersonate others, or run fake or misleading accounts;",
      "connect accounts you do not own or are not authorized to manage;",
      "publish content that is illegal, infringes someone's rights (including copyright, trademarks and privacy), or is hateful, harassing, sexually exploitative or deceptive;",
      "upload malware, probe or attack the service, get around its limits or security, or put an unreasonable load on it;",
      "resell or share access to the service without the operator's permission.",
    ]),

    h2("content", "Your content"),
    p(
      "You keep all rights to the content you upload and publish. You give the operator only the permission needed to provide the service: to store, process (for example resize images or create thumbnails) and send your content to the platforms you choose, at the times you choose. You are responsible for your content and for having the rights to publish it. The operator does not review content before it is published, but may remove content or stop a post that breaks these terms or the law.",
    ),

    h2("platforms", "Third-party platforms"),
    p(
      "Postflare uses the official APIs of connected platforms. Availability of these platforms and their features is outside Postflare's control: a platform can change or limit its API, reject or remove a post, or restrict or revoke an account's access at any time. The operator is not responsible for the actions of the platforms, including decisions about your accounts or content. Postflare shows the status of every post, but cannot guarantee that a scheduled post is published at a given time.",
    ),

    ...(billing
      ? [
          h2("plans", "Plans, payments and subscriptions"),
          p(
            pay && isMerchantOfRecord(pay)
              ? `Paid plans are sold by ${providerLink(pay)}, which acts as merchant of record: ${PROVIDER_NAMES[pay]} is the seller on your receipt, processes the payment, charges any applicable taxes (such as VAT or sales tax) and issues invoices. Its terms of purchase also apply to your payment.`
              : `Paid plans are sold by the operator${pay ? `; payments are processed by ${providerLink(pay)}` : ""}. Prices include or add applicable taxes as shown at checkout.`,
          ),
          p(
            `Plans, prices and limits are as shown on the ${a("/#pricing", "pricing page")} and in <em>Workspace settings → Billing</em>. A subscription belongs to a workspace and covers its members. Each plan has limits, such as connected accounts, posts per month, X posts per month, members, media storage and API access; when a limit is reached, new actions of that kind are refused until the next month or an upgrade, while posts already scheduled are still published.`,
          ),
          trial
            ? p(
                `New workspaces start with a free ${billing.trialDays}-day trial of the ${esc(billing.trialPlan!)} plan, without a payment card. There is one trial per person. When the trial ends without a subscription, the workspace ${afterTrial}.`,
              )
            : "",
          billing.freePlan ? p("The free plan costs nothing and has the limits shown on the pricing page. The operator may change its limits or discontinue it with notice.") : "",
          p(
            `Subscriptions renew automatically at the end of each monthly or yearly period, at the price then in effect, until cancelled. You can cancel at any time in <em>Workspace settings → Billing → Manage billing</em>${pay ? ` (${PROVIDER_NAMES[pay]}'s billing portal)` : ""}: the plan then stays active until the end of the period already paid and does not renew. If a renewal payment fails, the plan keeps working for ${billing.graceDays} day${billing.graceDays === 1 ? "" : "s"} while you update your payment details${billing.freePlan ? "; after that the workspace moves to the free plan" : "; after that the workspace becomes read-only until a plan is active again"}.`,
          ),
          p(
            pay && isMerchantOfRecord(pay)
              ? `Refunds are handled by ${PROVIDER_NAMES[pay]} under its refund policy. If you think you were charged in error, contact ${contactOperator(ctx)} and we will help.`
              : `If you think you were charged in error, contact ${contactOperator(ctx)}. Refunds are given where the law requires it or at the operator's discretion.`,
          ),
          p(
            "The operator may change prices or plans. A price change applies to an existing subscription only from the renewal after at least 30 days' notice by email, so you can cancel before it takes effect. Nothing in these terms limits your rights as a consumer under the law of your country, including any right of withdrawal.",
          ),
        ]
      : []),

    h2("availability", "Availability and changes to the service"),
    p(
      `The service is provided on a best-effort basis, without a guaranteed uptime. It can be interrupted for maintenance, updates or problems of the infrastructure it runs on, and features may change. If the operator decides to shut down the service, it will tell users at least 30 days in advance where possible${billing ? " and end paid subscriptions without further renewals" : ""}.`,
    ),

    h2("termination", "Ending your use"),
    p(
      `You may stop using the service at any time: remove your connected accounts, delete your workspaces${billing ? " (cancel any subscription first)" : ""}, and ask ${contactOperator(ctx)} to delete your user account. The operator may end your access as described under “Access and accounts”. After an account is deleted its data is removed as described in the ${a("/privacy/", "Privacy Policy")}.`,
    ),

    h2("open-source", "Open-source software"),
    p(
      `Postflare is open-source software licensed under the ${a("https://www.gnu.org/licenses/agpl-3.0.html", "GNU AGPL-3.0")}. The license governs copying, changing and running the software, including on your own infrastructure. These terms govern only this ${op ? "hosted service" : "instance"}, which is operated by ${op ? esc(op) : "its operator"}.`,
    ),

    h2("warranty", "No warranty"),
    p(
      `The service and the software are provided “as is” and “as available”, without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement, to the extent the law allows.`,
    ),

    h2("liability", "Limitation of liability"),
    p(
      `To the extent the law allows, the operator is not liable for indirect or consequential damages, lost profits, lost data or content, missed or failed posts, or actions taken by the platforms, and the operator's total liability for any claim is limited to ${billing ? "the amount you paid for the service in the 12 months before the claim" : "the amount you paid for the service, if any"}. Nothing in these terms excludes liability that cannot be excluded by law, such as for intent or gross negligence, or your mandatory rights as a consumer.`,
    ),

    ...(ctx.legal.country
      ? [
          h2("law", "Governing law"),
          p(
            `These terms are governed by the laws of ${esc(ctx.legal.country)}. If you are a consumer, you also keep the protection of the mandatory laws of the country where you live, and you may bring claims in its courts.`,
          ),
        ]
      : []),

    h2("changes", "Changes"),
    p(
      "These terms may be updated; the date above reflects the latest version. Material changes are announced to users (for example by email) at least 14 days before they take effect; continuing to use the service after that means you accept them.",
    ),

    h2("contact", "Contact"),
    contactBlock(ctx, "For questions about these terms, contact the operator of this instance."),
  ];
  return page("Terms of Service", body.filter(Boolean).join("\n"));
}

// ---------- Data Deletion ----------

export function renderDataDeletion(ctx: LegalContext): string {
  const body = [
    `<h1>Data Deletion</h1>`,
    `<section id="status" hidden><h2 style="margin-top:0">Your deletion request</h2><p id="status-text" class="muted">Looking up your request…</p></section>`,
    p(
      "Postflare is open-source, self-hosted social media scheduling software. This instance stores, for each social media account connected to it, the access tokens issued by the platform, basic profile information (account id, display name, username and avatar), the posts scheduled for that account and their performance metrics. Here is how to have that data deleted.",
    ),
    `<h2>1. Remove the account in Postflare</h2>`,
    p(
      "In Postflare, open <strong>Accounts</strong>, pick the account and choose <strong>Remove</strong>. This deletes its stored access tokens and profile data, the posts scheduled for it and their metrics, and stops anything still scheduled.",
    ),
    `<h2>2. Revoke access on the platform</h2>`,
    p(
      "On TikTok, open <em>Profile → Menu (☰) → Settings and privacy → Security → Manage app permissions</em> and remove this app; on YouTube, remove it at <a href=\"https://myaccount.google.com/permissions\">myaccount.google.com/permissions</a>. Postflare then can no longer use the account; remove it in Postflare (step 1) to delete the data stored here.",
    ),
    p(
      "You can also remove this instance's app from your Meta account: on Facebook, <em>Settings and privacy → Settings → Apps and websites</em>; on Instagram, <em>Settings → Website permissions → Apps and websites</em>; on Threads, <em>Settings → Account → Website permissions</em>. When you remove it and ask for your data to be deleted, Meta notifies this instance automatically and every account you connected with that login is removed as described above. Meta then gives you a confirmation code and a link to this page to check the status.",
    ),
    `<h2>3. Contact the operator</h2>`,
    p(
      ctx.legal.contactEmail
        ? `For anything else, such as deleting your user account, an access request or all your data, email ${a(`mailto:${ctx.legal.contactEmail}`, esc(ctx.legal.contactEmail))}${ctx.legal.operatorName ? ` (${esc(ctx.legal.operatorName)})` : ""}.`
        : "For anything else, or to have your data deleted another way, contact the operator of this Postflare instance.",
    ),
    `<p class="muted">See also the <a href="/privacy/">Privacy Policy</a> and <a href="/terms/">Terms of Service</a>.</p>`,
  ];
  return page("Data Deletion", body.join("\n"), {
    style: "#status{padding:12px 16px;border-radius:8px;border:1px solid #8884}",
    head: `<script src="/data-deletion/status.js" defer></script>`,
  });
}
