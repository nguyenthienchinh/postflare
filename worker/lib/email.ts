/**
 * Outgoing email (sign-in links) through Cloudflare Email Sending: the optional `send_email` binding EMAIL plus the
 * EMAIL_FROM var, e.g. "Postflare <login@example.com>". Sending to arbitrary recipients needs Workers Paid and a domain
 * onboarded to Email Sending; on the Free plan the binding only delivers to the account's verified addresses.
 * Sign-in links are on only when that is configured AND an instance admin turned them on (setting below).
 */
import { getSetting } from "./settings";

/** Instance setting "Sign-in links by email" ("1" = on, absent = off). */
export const MAGIC_LINK_SETTING = "magic_link_enabled";

/** Email is configured when both the binding and a sender address exist. */
export const emailConfigured = (env: Env) => !!env.EMAIL && !!env.EMAIL_FROM?.trim();

/** Sign-in links are offered: email is configured and an instance admin turned them on. */
export async function magicLinkEnabled(env: Env): Promise<boolean> {
  return emailConfigured(env) && (await getSetting(env.DB, MAGIC_LINK_SETTING)) === "1";
}

/** "Name <a@b.c>" or "a@b.c" → the builder's `from`. */
export function sender(from: string): string | { email: string; name: string } {
  const m = from.trim().match(/^(.*?)\s*<([^>]+)>$/);
  return m && m[1] ? { name: m[1].replace(/^"|"$/g, ""), email: m[2].trim() } : (m?.[2] ?? from.trim());
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends through the EMAIL binding. Throws the binding's error (it carries Cloudflare's `code` and message). */
export async function sendEmail(env: Env, msg: OutgoingEmail): Promise<void> {
  await env.EMAIL!.send({ from: sender(env.EMAIL_FROM!), to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const layout = (title: string, body: string) => `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#18181b;max-width:480px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
${body}
</body></html>`;

export function magicLinkEmail(to: string, url: string, minutes: number): OutgoingEmail {
  const host = new URL(url).host;
  const note = `The link works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email.`;
  return {
    to,
    subject: "Your Postflare sign-in link",
    text: `Sign in to Postflare (${host}):\n\n${url}\n\n${note}\n`,
    html: layout(
      "Sign in to Postflare",
      `<p style="margin:0 0 20px;color:#52525b">Click the button to sign in to ${escapeHtml(host)}.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Sign in</a></p>
<p style="margin:0;font-size:13px;color:#71717a">${note}<br><br>${escapeHtml(url)}</p>`,
    ),
  };
}

/** The admin's "Send test email" message. */
export function testEmail(to: string, host: string): OutgoingEmail {
  const text = `Email sending works for Postflare on ${host}: sign-in links by email can reach this address.`;
  return { to, subject: "Postflare test email", text: `${text}\n`, html: layout("Postflare test email", `<p style="margin:0;color:#52525b">${escapeHtml(text)}</p>`) };
}

const button = (url: string, label: string) =>
  `<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">${label}</a></p>`;

/** Public sign-up: the confirmation link that activates the account (docs/hosted-spec.md "Sign-up"). */
export function verifySignupEmail(to: string, url: string, hours: number): OutgoingEmail {
  const host = new URL(url).host;
  const note = `The link works once and expires in ${hours} hours. If you did not sign up, ignore this email: no account is created.`;
  return {
    to,
    subject: "Confirm your Postflare account",
    text: `Confirm your email to finish creating your Postflare account (${host}):\n\n${url}\n\n${note}\n`,
    html: layout(
      "Confirm your email",
      `<p style="margin:0 0 20px;color:#52525b">Click the button to finish creating your account on ${escapeHtml(host)}.</p>
${button(url, "Confirm and sign in")}
<p style="margin:0;font-size:13px;color:#71717a">${note}<br><br>${escapeHtml(url)}</p>`,
    ),
  };
}

/** Sign-up with an email that already has an account: told to sign in instead (the API answers the same either way). */
export function signupExistingEmail(to: string, loginUrl: string): OutgoingEmail {
  const host = new URL(loginUrl).host;
  const text = `Someone (maybe you) tried to create a Postflare account on ${host} with this email address. You already have an account: sign in instead. If it wasn't you, you can ignore this email.`;
  return {
    to,
    subject: "You already have a Postflare account",
    text: `${text}\n\n${loginUrl}\n`,
    html: layout("You already have an account", `<p style="margin:0 0 20px;color:#52525b">${escapeHtml(text)}</p>\n${button(loginUrl, "Sign in")}`),
  };
}

// ---------- Access requests (docs/hosted-spec.md "Access requests") ----------

const p = (text: string, extra = "") => `<p style="margin:0 0 16px;color:#52525b${extra}">${escapeHtml(text)}</p>`;

/** Approved: the invitation link (email-bound, a new workspace of their own). */
export function accessApprovedEmail(to: string, name: string, url: string, days: number): OutgoingEmail {
  const host = new URL(url).host;
  const intro = `Hi ${name}, your request to use Postflare on ${host} was approved. Create your account with the link below: it is for ${to} only and works for ${days} days.`;
  return {
    to,
    subject: "Your Postflare access request was approved",
    text: `${intro}\n\n${url}\n\nIf you did not ask for access, ignore this email.\n`,
    html: layout(
      "You're in",
      `${p(intro)}
${button(url, "Create your account")}
<p style="margin:0;font-size:13px;color:#71717a">If you did not ask for access, ignore this email.<br><br>${escapeHtml(url)}</p>`,
    ),
  };
}

/** Rejected (only when the admin chose to notify): short and polite, with the admin's note when given. */
export function accessRejectedEmail(to: string, name: string, host: string, note: string | null): OutgoingEmail {
  const intro = `Hi ${name}, thank you for your interest in Postflare on ${host}. We can't offer you access right now: we keep the number of accounts small so the service stays reliable for everyone.`;
  const outro = "You can always run your own copy of Postflare: it is open source and free to self-host.";
  return {
    to,
    subject: "About your Postflare access request",
    text: `${intro}\n\n${note ? `${note}\n\n` : ""}${outro}\n`,
    html: layout("About your access request", `${p(intro)}${note ? p(note, ";white-space:pre-wrap;border-left:3px solid #e4e4e7;padding-left:12px") : ""}${p(outro, ";font-size:13px")}`),
  };
}

/** Instance admins: a new access request to review. */
export function newAccessRequestEmail(to: string, r: { name: string; email: string; company: string | null; url: string; role: string; useCase: string }, reviewUrl: string): OutgoingEmail {
  const who = `${r.name} <${r.email}>${r.company ? ` · ${r.company}` : ""}`;
  const lines = [who, `${r.role} · ${r.url}`, "", r.useCase];
  return {
    to,
    subject: `Access request: ${r.name}${r.company ? ` (${r.company})` : ""}`,
    text: `New access request on Postflare:\n\n${lines.join("\n")}\n\nReview it: ${reviewUrl}\n`,
    html: layout(
      "New access request",
      `${p(who, ";font-weight:600;color:#18181b")}${p(`${r.role} · ${r.url}`)}${p(r.useCase, ";white-space:pre-wrap")}
${button(reviewUrl, "Review")}`,
    ),
  };
}

/** Support chat: a staff reply the customer has not seen in the widget (docs/support-spec.md "Notifications"). */
export function supportReplyEmail(to: string, opts: { team: string; staffName: string; number: number; reply: string; url: string | null }): OutgoingEmail {
  const intro = `${opts.staffName} from ${opts.team} replied to your message (#${opts.number}):`;
  const outro = opts.url ? "Open the page again to continue the chat." : "Reply in the chat on our website to continue.";
  return {
    to,
    subject: `${opts.team}: new reply to your message (#${opts.number})`,
    text: `${intro}\n\n${opts.reply}\n\n${outro}${opts.url ? `\n${opts.url}` : ""}\n`,
    html: layout(
      `New reply from ${escapeHtml(opts.team)}`,
      `${p(intro)}${p(opts.reply, ";white-space:pre-wrap;border-left:3px solid #e4e4e7;padding-left:12px")}${
        opts.url ? button(opts.url, "Continue the chat") : p(outro, ";font-size:13px")
      }`,
    ),
  };
}
