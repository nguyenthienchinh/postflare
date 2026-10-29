import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router";
import { AlertTriangle, ArrowUpCircle, Bot, CheckCircle2, ExternalLink, FlaskConical, Globe, HardDrive, Info, Lock, Mail, RefreshCw, Scale, Send, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { PlatformAccessPicker } from "../components/accounts/PlatformAccessPicker";
import { StorageUsage } from "../components/media/StorageUsage";
import { Button } from "../components/ui/Button";
import { Field, Input, Select, Switch, Textarea } from "../components/ui/Form";
import { Badge, CodeBlock, PageHeader, Skeleton } from "../components/ui/Misc";
import { useConfirm } from "../components/ui/Confirm";
import { Section } from "../components/ui/Section";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { browserTimezone, timezones } from "../lib/time";
import { useUpdateStatus } from "../lib/updates";
import { useSession } from "../lib/session";
import { invalidate, useFetch } from "../lib/useFetch";
import { cn } from "../lib/format";
import type { SignupMode } from "../lib/types";
import type { AdminLegalDTO } from "@shared/types";
import { CHANGELOG_URL, COMMIT, REPO_URL, UPDATING_URL, VERSION, releaseUrl } from "@shared/version";

/** Admin → Instance settings: public URL and default timezone (API keys moved to the profile), integrations, sign-in links by email, sign-up mode, bot protection, legal & contact, version and updates. */
export function InstanceSettingsPage() {
  const { hash } = useLocation();
  // Links from the sidebar (#about, #updating) land on the section.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);
  return (
    <>
      <PageHeader title="Instance settings" description="Settings shared by every user and workspace of this Postflare instance." />
      <div className="space-y-6">
        <GeneralSection />
        <IntegrationsSection />
        <WorkspacePlatformsSection />
        <EmailSection />
        <SignupSection />
        <TurnstileSection />
        <LegalSection />
        <StorageSection />
        <AboutSection />
        <UpdatingSection />
      </div>
    </>
  );
}

const linkClass = "inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400";

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

const formatDate = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function AboutSection() {
  const { data: status, loading } = useUpdateStatus();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const server = status?.current ?? VERSION;
  const commit = status?.commit ?? COMMIT;

  async function checkNow() {
    setBusy(true);
    try {
      const res = await api.updates.check();
      invalidate("updates");
      if (res.error) toast.error(res.error);
      else toast.success(res.updateAvailable ? `Postflare v${res.latest} is available` : "You are on the latest version");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="about" className="scroll-mt-6">
      <Section icon={<Info />} title="About" description="The Postflare version this instance runs, and its release notes.">
        <dl className="grid max-w-xl grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
          <dt className="text-zinc-500">Version</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium">v{server}</span>
            {status?.updateAvailable ? (
              <a href="#updating">
                <Badge tone="brand">
                  <ArrowUpCircle className="size-3" /> v{status.latest} available
                </Badge>
              </a>
            ) : status?.latest ? (
              <Badge tone="green">Latest</Badge>
            ) : null}
          </dd>
          <dt className="text-zinc-500">Commit</dt>
          <dd className="font-mono">{commit === "dev" ? "dev" : <ExtLink href={`${REPO_URL}/commit/${commit}`}>{commit}</ExtLink>}</dd>
          {server !== VERSION && (
            <>
              <dt className="text-zinc-500">Web app</dt>
              <dd className="text-amber-700 dark:text-amber-300">
                v{VERSION} (older than the server: <button className={linkClass} onClick={() => window.location.reload()}>reload the page</button>)
              </dd>
            </>
          )}
          <dt className="text-zinc-500">Release notes</dt>
          <dd className="flex flex-wrap gap-x-4 gap-y-1">
            <ExtLink href={releaseUrl(server)}>v{server}</ExtLink>
            <ExtLink href={CHANGELOG_URL}>Changelog</ExtLink>
            <ExtLink href={`${REPO_URL}/releases`}>All releases</ExtLink>
          </dd>
          <dt className="text-zinc-500">Update check</dt>
          <dd className="text-zinc-600 dark:text-zinc-300">
            {loading && !status ? (
              <Skeleton className="h-5 w-48" />
            ) : !status?.enabled ? (
              <>Off (<code className="font-mono text-xs">UPDATE_CHECK=&quot;false&quot;</code>)</>
            ) : (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  Daily, from <code className="font-mono text-xs">{status.repo}</code>
                  {status.checkedAt ? `; last checked ${formatDate(status.checkedAt)}` : "; not checked yet"}
                  {status.error ? ` (${status.error})` : ""}
                </span>
                <Button size="sm" variant="outline" loading={busy} icon={<RefreshCw className="size-3.5" />} onClick={checkNow}>
                  Check now
                </Button>
              </span>
            )}
          </dd>
        </dl>
      </Section>
    </div>
  );
}

function UpdatingSection() {
  const { data: status } = useUpdateStatus();
  const available = !!status?.updateAvailable;
  return (
    <div id="updating" className="scroll-mt-6">
      <Section
        icon={<ArrowUpCircle />}
        title="Updating"
        description="Updating means deploying the new code: database migrations run automatically on the first request."
        className={available ? "ring-2 ring-brand-300 dark:ring-brand-800" : undefined}
      >
        <div className="max-w-2xl space-y-4 text-sm text-zinc-600 dark:text-zinc-300">
          {available && status ? (
            <p className="rounded-lg bg-brand-50 px-3 py-2 text-brand-900 dark:bg-brand-950/40 dark:text-brand-100">
              <strong className="font-semibold">Postflare v{status.latest}</strong> is available (you run v{status.current}
              {status.publishedAt ? `; released ${new Date(status.publishedAt).toLocaleDateString()}` : ""}). Read the{" "}
              <ExtLink href={status.url ?? releaseUrl(status.latest!)}>release notes</ExtLink> for breaking changes first.
            </p>
          ) : (
            <p>You are notified here and in the sidebar when a new version is released.</p>
          )}
          <div>
            <h3 className="mb-1 font-semibold text-zinc-800 dark:text-zinc-100">Deployed with the &ldquo;Deploy to Cloudflare&rdquo; button</h3>
            <p>
              Your copy of the repository on GitHub has a <em>Postflare update</em> workflow that opens a pull request with each new
              release (weekly, or run it by hand from the Actions tab). Merge it and Workers Builds deploys the update. The workflow
              needs <em>Settings → Actions → General → Allow GitHub Actions to create and approve pull requests</em>.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-zinc-800 dark:text-zinc-100">Deployed from a clone</h3>
            <CodeBlock code={`git fetch --tags && git checkout v${status?.latest ?? "<version>"}   # or: git pull\nnpm ci\nnpm run deploy`} />
          </div>
          <p>
            Before a big upgrade, note a D1 restore point (<code className="font-mono text-xs">npx wrangler d1 time-travel info DB</code>).
            Details: <ExtLink href={UPDATING_URL}>Updating</ExtLink>.
          </p>
        </div>
      </Section>
    </div>
  );
}

function GeneralSection() {
  const { settings } = useApp();
  const toast = useToast();
  const [publicUrl, setPublicUrl] = useState("");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!settings) return;
    setPublicUrl(settings.publicUrl);
    setTimezone(settings.timezone || browserTimezone);
  }, [settings]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.settings.save({ ...(settings?.publicUrlLocked ? {} : { publicUrl: publicUrl.trim() }), timezone });
      toast.success("Settings saved");
      invalidate("settings", "providers");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={<Globe />} title="General" description="Where this instance lives and the default timezone of the calendar and composer.">
      {!settings ? (
        <div className="space-y-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <form onSubmit={save} className="max-w-xl space-y-5">
          <Field
            label="Public URL"
            help={
              settings.publicUrlLocked
                ? "Set by the PUBLIC_URL environment variable."
                : "Used to build OAuth redirect URIs and the public links platforms download your media from. Changing it means updating the redirect URI in every developer app."
            }
          >
            {(id) => (
              <div className="flex items-center gap-2">
                <Input id={id} type="url" value={publicUrl} disabled={settings.publicUrlLocked} onChange={(e) => setPublicUrl(e.target.value)} />
                {settings.publicUrlLocked && (
                  <Badge>
                    <Lock className="size-3" /> Locked
                  </Badge>
                )}
              </div>
            )}
          </Field>
          <Field label="Timezone" help={`Dates in the calendar and composer use this zone. Your browser is on ${browserTimezone}.`}>
            {(id) => (
              <Select id={id} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {timezones().map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                    {tz === browserTimezone ? " (browser)" : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
            {settings.encryptionKeyFromSecret !== undefined && (
              <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                <ShieldCheck className="size-3.5 text-emerald-500" />
                Tokens encrypted with {settings.encryptionKeyFromSecret ? "the SECRET_KEY secret" : "an auto-generated key"}
              </span>
            )}
          </div>
        </form>
      )}
    </Section>
  );
}

/** "Enable experimental integrations": platforms on unofficial APIs (status "experimental") are hidden until turned on. */
function IntegrationsSection() {
  const { settings, providers } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const enabled = !!settings?.experimentalIntegrations;
  const experimental = providers.filter((p) => p.status === "experimental");

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await api.settings.save({ experimentalIntegrations: next });
      toast.success(next ? "Experimental integrations enabled" : "Experimental integrations disabled");
      invalidate("settings", "providers");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="integrations" className="scroll-mt-6">
      <Section
        icon={<FlaskConical />}
        title="Integrations"
        description="Experimental integrations use unofficial APIs. They are hidden from the connect dialog until you turn them on."
      >
        {!settings ? (
          <Skeleton className="h-9 w-full max-w-xl" />
        ) : (
          <div className="max-w-xl space-y-4 text-sm">
            <label className="flex items-start gap-3">
              <Switch id="experimental-integrations" checked={enabled} disabled={busy} onChange={toggle} label="Enable experimental integrations" />
              <span>
                <span className="block font-medium text-zinc-900 dark:text-zinc-100">Enable experimental integrations</span>
                <span className="mt-0.5 block text-zinc-500">
                  {experimental.length ? `${experimental.map((p) => p.name).join(", ")}. ` : ""}
                  When off, new accounts cannot be connected; already connected ones keep publishing.
                </span>
              </span>
            </label>
            <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                These integrations rely on unofficial, undocumented APIs (often your session cookies). They can break without notice and
                may conflict with the platform&rsquo;s terms of service, which could put the connected account at risk. Use at your own risk.
              </span>
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}

/** "Platforms for new workspaces": copied into each workspace created from now on (Admin → Billing → Workspaces changes one). */
function WorkspacePlatformsSection() {
  const { settings } = useApp();
  const toast = useToast();
  const saved = settings?.workspaceProviders ?? null;
  const [value, setValue] = useState<string[] | null>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(saved), [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(value === null ? null : [...value].sort()) !== JSON.stringify(saved === null ? null : [...saved].sort());

  async function save() {
    setBusy(true);
    try {
      await api.settings.save({ workspaceProviders: value });
      toast.success("Platforms for new workspaces saved");
      invalidate("settings");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="workspace-platforms" className="scroll-mt-6">
      <Section
        icon={<Globe />}
        title="Platforms for new workspaces"
        description="What workspaces created from now on (sign-ups, approved access requests, new workspaces) may connect and post to. Existing workspaces keep theirs: change one in Admin → Billing → Workspaces."
      >
        {!settings ? (
          <Skeleton className="h-9 w-full max-w-xl" />
        ) : (
          <div className="max-w-xl space-y-4">
            <PlatformAccessPicker value={value} onChange={setValue} disabled={busy} />
            <div className="flex justify-end">
              <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>
                Save
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

const EMAIL_SETUP = `// wrangler.local.jsonc
"send_email": [{ "name": "EMAIL", "remote": true }],
"vars": { "EMAIL_FROM": "Postflare <login@example.com>" }`;

/** Sign-in links by email (Cloudflare Email Sending): off by default, needs the EMAIL binding and EMAIL_FROM. */
function EmailSection() {
  const toast = useToast();
  const { data, setData } = useFetch("admin-email", api.admin.email, ["settings"]);
  const [busy, setBusy] = useState<"toggle" | "test" | null>(null);

  async function toggle(next: boolean) {
    setBusy("toggle");
    try {
      const res = await api.admin.setEmail(next);
      setData(() => res);
      toast.success(next ? "Sign-in links by email turned on" : "Sign-in links by email turned off");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    try {
      const res = await api.admin.testEmail();
      toast.success(`Test email sent to ${res.to}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div id="email" className="scroll-mt-6">
      <Section icon={<Mail />} title="Sign-in links by email" description="Users can request a one-time sign-in link instead of typing their password.">
        {!data ? (
          <Skeleton className="h-9 w-full max-w-xl" />
        ) : (
          <div className="max-w-xl space-y-4 text-sm">
            <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Needs Cloudflare Workers Paid ($5/month) and a domain onboarded to Cloudflare Email Sending. On the Free plan emails only reach your
                account&rsquo;s verified addresses.
              </span>
            </p>
            <label className="flex items-start gap-3">
              <Switch
                id="magic-link-enabled"
                checked={data.configured && data.enabled}
                disabled={!data.configured || busy !== null}
                onChange={toggle}
                label="Sign-in links by email"
              />
              <span>
                <span className="block font-medium text-zinc-900 dark:text-zinc-100">Offer &ldquo;Email me a sign-in link&rdquo; on the sign-in page</span>
                <span className="mt-0.5 block text-zinc-500">
                  {data.configured ? (
                    <>
                      Sent from <code className="font-mono text-xs">{data.from}</code>. Links work once, for 15 minutes; turning this off ends the ones
                      already sent.
                    </>
                  ) : (
                    "Email is not set up on this instance yet."
                  )}
                </span>
              </span>
            </label>
            {data.configured ? (
              <Button size="sm" variant="outline" loading={busy === "test"} disabled={busy !== null} icon={<Send className="size-3.5" />} onClick={sendTest}>
                Send test email
              </Button>
            ) : (
              <div className="space-y-2 text-zinc-600 dark:text-zinc-300">
                <p className="font-medium text-zinc-800 dark:text-zinc-100">To set it up:</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>
                    Onboard your domain to Cloudflare Email Sending: <code className="font-mono text-xs">npx wrangler email sending enable example.com</code>
                  </li>
                  <li>
                    Add the <code className="font-mono text-xs">send_email</code> binding <code className="font-mono text-xs">EMAIL</code> and the{" "}
                    <code className="font-mono text-xs">EMAIL_FROM</code> var in <code className="font-mono text-xs">wrangler.local.jsonc</code>:
                  </li>
                </ol>
                <CodeBlock code={EMAIL_SETUP} />
                <p>Then deploy and come back here to turn it on.</p>
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

const SIGNUP_MODES: Array<{ mode: SignupMode; title: string; text: string }> = [
  { mode: "off", title: "Invitation only", text: "Only people you invite get an account. The sign-in page offers no sign-up." },
  {
    mode: "apply",
    title: "Request access",
    text: "People apply on /apply with their details and use case. You approve each one in Admin → Requests: they get an invitation into a workspace of their own.",
  },
  { mode: "open", title: "Open sign-up", text: "Anyone can create an account on /signup and gets the Member role and a workspace of their own." },
];

/** Sign-up (off by default): invitation only, request access (reviewed by an admin), or open public sign-up. */
function SignupSection() {
  const toast = useToast();
  const { data, setData } = useFetch("admin-signup", api.admin.signup, ["settings"]);
  const turnstile = useFetch("admin-turnstile", api.admin.turnstile, ["settings"]);
  const [busy, setBusy] = useState(false);

  async function choose(mode: SignupMode) {
    if (mode === data?.mode) return;
    setBusy(true);
    try {
      const res = await api.admin.setSignup(mode);
      setData(() => res);
      invalidate("requests");
      toast.success(mode === "off" ? "Sign-up is invitation only" : mode === "apply" ? "People can now request access" : "Public sign-up turned on");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="signup" className="scroll-mt-6">
      <Section icon={<UserPlus />} title="Sign-up" description="How new people get an account on this instance.">
        {!data ? (
          <Skeleton className="h-9 w-full max-w-xl" />
        ) : (
          <div className="max-w-xl space-y-4 text-sm">
            <div role="radiogroup" aria-label="Sign-up" className="space-y-2">
              {SIGNUP_MODES.map((m) => (
                <label
                  key={m.mode}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg p-3 ring-1 transition",
                    data.mode === m.mode ? "bg-brand-50/60 ring-brand-300 dark:bg-brand-500/10 dark:ring-brand-500/40" : "ring-zinc-200 hover:bg-zinc-50 dark:ring-zinc-800 dark:hover:bg-zinc-800/40",
                    busy && "cursor-wait opacity-70",
                  )}
                >
                  <input type="radio" name="signup-mode" className="mt-0.5 accent-brand-600" checked={data.mode === m.mode} disabled={busy} onChange={() => void choose(m.mode)} />
                  <span>
                    <span className="block font-medium text-zinc-900 dark:text-zinc-100">{m.title}</span>
                    <span className="mt-0.5 block text-zinc-500">{m.text}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-zinc-500">
              {data.mode === "apply"
                ? `At most 5 requests per network per hour and 3 per email per day. Instance admins get a push on the iPhone app${data.emailConfigured ? " and an email" : ""} for each new request.`
                : data.mode === "open"
                  ? data.emailConfigured
                    ? "New accounts confirm their email address with a link that works for 24 hours. At most 5 sign-ups per network per hour."
                    : "Accounts are active right away (no email confirmation). At most 5 sign-ups per network per hour."
                  : "Invite people from Admin → Users."}{" "}
              {data.mode !== "off" && (
                <>
                  With <Link to="/admin/billing" className={linkClass}>billing</Link> on, new workspaces start a free trial.
                </>
              )}
            </p>
            {data.mode === "open" && !data.emailConfigured && (
              <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  Email is not set up, so sign-ups are not verified: anyone can register any address. A public instance should set up email first (see{" "}
                  <a href="#email" className="font-medium underline">
                    Sign-in links by email
                  </a>
                  ).
                </span>
              </p>
            )}
            {data.mode === "apply" && !data.emailConfigured && (
              <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  Email is not set up: applicants are not emailed when you approve them. Admin → Requests shows the invitation link to send yourself (see{" "}
                  <a href="#email" className="font-medium underline">
                    Sign-in links by email
                  </a>
                  ).
                </span>
              </p>
            )}
            {data.mode !== "off" && turnstile.data && !turnstile.data.configured && (
              <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {data.mode === "open"
                    ? "Sign-up is open without a bot check: scripts can create accounts and send confirmation emails from your domain."
                    : "The request form has no bot check: scripts can fill your review queue."}{" "}
                  Set up{" "}
                  <a href="#bot-protection" className="font-medium underline">
                    Bot protection
                  </a>{" "}
                  before opening {data.mode === "open" ? "sign-up" : "requests"} on a hosted instance.
                </span>
              </p>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

/** Bot protection (Cloudflare Turnstile): site key + secret key, stored here (secret encrypted) or set by the env. */
function TurnstileSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, setData } = useFetch("admin-turnstile", api.admin.turnstile, ["settings"]);
  const [siteKey, setSiteKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    if (data) setSiteKey(data.siteKey ?? "");
  }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    try {
      const res = await api.admin.saveTurnstile({ ...(data?.siteKeyFromEnv ? {} : { siteKey: siteKey.trim() }), ...(secretKey.trim() ? { secretKey: secretKey.trim() } : {}) });
      setData(() => res);
      setSecretKey("");
      setTest(null);
      toast.success(res.configured ? "Bot protection is on" : "Saved");
      invalidate("settings");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy("test");
    try {
      const res = await api.admin.testTurnstile(secretKey.trim() || undefined);
      setTest(
        res.ok
          ? { ok: true, message: res.testing ? "Turnstile test secret: every check passes, so it does not stop bots. Use it for local testing only." : "Cloudflare accepted the secret key." }
          : { ok: false, message: res.error },
      );
    } catch (err) {
      setTest({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!(await confirm({ title: "Remove bot protection?", message: "Sign-up and sign-in links will no longer ask for the bot check.", confirmLabel: "Remove", danger: true }))) return;
    setBusy("remove");
    try {
      const res = await api.admin.removeTurnstile();
      setData(() => res);
      setSiteKey("");
      setSecretKey("");
      setTest(null);
      toast.success(res.configured ? "Stored keys removed (the deployment still sets them)" : "Bot protection removed");
      invalidate("settings");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  const envNote = "Set by the deployment";
  const stored = !!data && ((!data.siteKeyFromEnv && !!data.siteKey) || (!data.secretFromEnv && data.secretSet));

  return (
    <div id="bot-protection" className="scroll-mt-6">
      <Section
        icon={<Bot />}
        title="Bot protection (Cloudflare Turnstile)"
        description="A free, privacy-friendly bot check on sign-up and access requests, on sign-in links by email, and on sign-in after 3 failed attempts."
      >
        {!data ? (
          <Skeleton className="h-9 w-full max-w-xl" />
        ) : (
          <form onSubmit={save} className="max-w-xl space-y-5 text-sm">
            <div className="flex items-center gap-2">
              {data.configured ? (
                <Badge tone="green">
                  <CheckCircle2 className="size-3" /> On
                </Badge>
              ) : (
                <Badge>Off</Badge>
              )}
              <span className="text-zinc-500">{data.configured ? "Visitors solve the check before these forms are accepted." : "Nothing is checked until both keys are set."}</span>
            </div>
            <div className="space-y-1 text-zinc-600 dark:text-zinc-300">
              <p>
                Create a widget in the <ExtLink href="https://dash.cloudflare.com/?to=/:account/turnstile">Cloudflare dashboard → Turnstile</ExtLink> (free): add this
                instance&rsquo;s hostname <code className="font-mono text-xs">{window.location.hostname}</code>, keep the Managed mode, then paste its keys here.
                Without it, do not open sign-up or access requests on a hosted instance.
              </p>
            </div>
            <Field label="Site key" help={data.siteKeyFromEnv ? `${envNote} (TURNSTILE_SITE_KEY var).` : "Public: shown to the browser."}>
              {(id) => (
                <div className="flex items-center gap-2">
                  <Input id={id} value={data.siteKeyFromEnv ? (data.siteKey ?? "") : siteKey} disabled={data.siteKeyFromEnv} onChange={(e) => setSiteKey(e.target.value)} placeholder="0x4AAAAAAA…" autoComplete="off" />
                  {data.siteKeyFromEnv && (
                    <Badge>
                      <Lock className="size-3" /> Locked
                    </Badge>
                  )}
                </div>
              )}
            </Field>
            <Field
              label="Secret key"
              help={
                data.secretFromEnv
                  ? `${envNote} (TURNSTILE_SECRET_KEY secret).`
                  : data.secretSet
                    ? "Set (stored encrypted, never shown again). Leave empty to keep it."
                    : "Stored encrypted; never shown again."
              }
            >
              {(id) => (
                <div className="flex items-center gap-2">
                  <Input
                    id={id}
                    type="password"
                    autoComplete="off"
                    value={secretKey}
                    disabled={data.secretFromEnv}
                    onChange={(e) => setSecretKey(e.target.value)}
                    placeholder={data.secretFromEnv || data.secretSet ? "•••••••• (set)" : "0x4AAAAAAA…"}
                  />
                  {data.secretFromEnv && (
                    <Badge>
                      <Lock className="size-3" /> Locked
                    </Badge>
                  )}
                </div>
              )}
            </Field>
            {test && (
              <p
                className={
                  test.ok
                    ? "flex gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900"
                    : "flex gap-2 rounded-lg bg-red-50 px-3 py-2 text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900"
                }
              >
                {test.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
                <span>{test.message}</span>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {!(data.siteKeyFromEnv && data.secretFromEnv) && (
                <Button type="submit" variant="primary" loading={busy === "save"} disabled={busy !== null}>
                  Save
                </Button>
              )}
              <Button variant="outline" loading={busy === "test"} disabled={busy !== null || (!secretKey.trim() && !data.secretSet)} icon={<ShieldCheck className="size-3.5" />} onClick={runTest}>
                Test
              </Button>
              {stored && (
                <Button variant="ghost" loading={busy === "remove"} disabled={busy !== null} icon={<Trash2 className="size-3.5" />} onClick={remove}>
                  Remove
                </Button>
              )}
            </div>
          </form>
        )}
      </Section>
    </div>
  );
}

const EMPTY_LEGAL: AdminLegalDTO = { operatorName: null, contactEmail: null, postalAddress: null, country: null, effectiveDate: null };

/** Who runs the instance: filled into /privacy/, /terms/ and /data-deletion/ (generic wording while empty). */
function LegalSection() {
  const toast = useToast();
  const { data, setData } = useFetch("admin-legal", api.admin.legal, ["settings"]);
  const [form, setForm] = useState<AdminLegalDTO>(EMPTY_LEGAL);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  const set = (key: keyof AdminLegalDTO) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const val = (key: keyof AdminLegalDTO) => form[key] ?? "";

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.admin.saveLegal({
        operatorName: val("operatorName"),
        contactEmail: val("contactEmail"),
        postalAddress: val("postalAddress"),
        country: val("country"),
        effectiveDate: val("effectiveDate"),
      });
      setData(() => res);
      toast.success("Legal pages updated");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="legal" className="scroll-mt-6">
      <Section
        icon={<Scale />}
        title="Legal & contact"
        description="Who runs this instance and how to reach them, shown on the Privacy Policy, Terms of Service and Data Deletion pages."
      >
        {!data ? (
          <Skeleton className="h-9 w-full max-w-xl" />
        ) : (
          <form onSubmit={save} className="max-w-xl space-y-5 text-sm">
            <p className="text-zinc-600 dark:text-zinc-300">
              While these are empty the pages use the generic self-host wording (&ldquo;contact its operator&rdquo;). Subscription terms appear only while billing is on. Preview:{" "}
              <a className={linkClass} href="/privacy/" target="_blank" rel="noreferrer">
                Privacy <ExternalLink className="size-3" />
              </a>{" "}
              ·{" "}
              <a className={linkClass} href="/terms/" target="_blank" rel="noreferrer">
                Terms <ExternalLink className="size-3" />
              </a>{" "}
              ·{" "}
              <a className={linkClass} href="/data-deletion/" target="_blank" rel="noreferrer">
                Data deletion <ExternalLink className="size-3" />
              </a>
            </p>
            <Field label="Operator name" help="The person or company that runs this instance, e.g. “Jane Doe” or “Acme Ltd”.">
              {(id) => <Input id={id} value={val("operatorName")} onChange={set("operatorName")} maxLength={200} placeholder="Jane Doe" />}
            </Field>
            <Field label="Contact email" help="For privacy questions, data deletion and support requests.">
              {(id) => <Input id={id} type="email" value={val("contactEmail")} onChange={set("contactEmail")} maxLength={254} placeholder="privacy@example.com" />}
            </Field>
            <Field label="Postal address" help="Optional. Some laws and app reviews ask for one.">
              {(id) => <Textarea id={id} rows={3} value={val("postalAddress")} onChange={set("postalAddress")} maxLength={500} />}
            </Field>
            <Field label="Country" help="Optional. Shown with the operator and used as the governing law of the Terms.">
              {(id) => <Input id={id} value={val("country")} onChange={set("country")} maxLength={100} placeholder="Germany" />}
            </Field>
            <Field label="Effective date" help="Optional. Shown as “Last updated”; empty uses the date of the current wording.">
              {(id) => <Input id={id} type="date" value={val("effectiveDate")} onChange={set("effectiveDate")} className="max-w-48" />}
            </Field>
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
          </form>
        )}
      </Section>
    </div>
  );
}

/** Media retention (daily cleanup of unused media) and how much R2 storage the instance uses. */
function StorageSection() {
  const { settings } = useApp();
  const { can } = useSession();
  const toast = useToast();
  const usage = useFetch(can("media.read") ? "media-usage" : null, api.media.usage, ["media", "settings"]);
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings) setDays(String(settings.mediaRetentionDays ?? 30));
  }, [settings]);
  const n = Number(days);
  const invalid = days.trim() === "" || !Number.isInteger(n) || n < 0 || n > 3650;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    try {
      await api.settings.save({ mediaRetentionDays: n });
      toast.success("Settings saved");
      invalidate("settings");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="storage" className="scroll-mt-6">
      <Section icon={<HardDrive />} title="Storage" description="Uploaded media lives in your R2 bucket. Old files nobody needs anymore are cleaned up once a day.">
        {!settings ? (
          <Skeleton className="h-9 w-full max-w-xl" />
        ) : (
          <div className="max-w-xl space-y-6">
            {usage.data && <StorageUsage usage={usage.data} show={usage.data.instance ? "instance" : "workspace"} />}
            <form onSubmit={save} className="space-y-5">
              <Field
                label="Media retention (days)"
                error={invalid ? "Enter a whole number from 0 to 3650" : undefined}
                help={
                  <>
                    A daily job deletes media older than this that no scheduled, draft, failed or needs-check post uses. Media of
                    posts published to platforms that link to the copy here instead of storing their own (DEV, Hashnode, Medium, Listmonk, Nostr,
                    Farcaster, Discord embeds, webhooks) is kept. Unfinished uploads are removed after 2 days, and files sent through upload links
                    that were never used in a post after 7 days. 0 keeps everything forever.
                  </>
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={3650}
                    step={1}
                    value={days}
                    invalid={invalid}
                    onChange={(e) => setDays(e.target.value)}
                    className="w-32"
                  />
                )}
              </Field>
              <Button type="submit" variant="primary" loading={busy} disabled={invalid || n === (settings.mediaRetentionDays ?? 30)}>
                Save
              </Button>
            </form>
          </div>
        )}
      </Section>
    </div>
  );
}
