import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, BellRing, Bot, CheckCircle2, KeyRound, Lock, Plus, QrCode as QrIcon, RefreshCw, Smartphone, SquareTerminal, Trash2, UserRound } from "lucide-react";
import { QrCode } from "../components/QrCode";
import { InitialsAvatar } from "../components/ui/Avatar";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input } from "../components/ui/Form";
import { Badge, CodeBlock, CopyButton, PageHeader, Skeleton, Tabs } from "../components/ui/Misc";
import { Notice, Section } from "../components/ui/Section";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { countdown, useNow, useVisiblePoll } from "../lib/poll";
import type { PairingCodeDTO } from "../lib/types";
import { useApp } from "../lib/app";
import { isPlaceholderEmail, useSession } from "../lib/session";
import { formatDateTime, relativeTime } from "../lib/time";
import { invalidate, useFetch } from "../lib/useFetch";

export function ProfilePage() {
  const [token, setToken] = useState<string | null>(null);
  const { user } = useSession();
  if (user.demo) return <DemoProfile />;
  return (
    <>
      <PageHeader title="Profile" description="Your account, password and API access." />
      <div className="space-y-6">
        <ProfileSection />
        <PasswordSection />
        <IphoneSection />
        <KeysSection onCreated={setToken} />
        <CliSection />
        <DocsSection token={token} />
      </div>
    </>
  );
}

/** The live demo's shared user: read-only, no password or API keys. */
function DemoProfile() {
  const { user, workspace } = useSession();
  return (
    <>
      <PageHeader title="Profile" description="Your account, password and API access." />
      <div className="space-y-6">
        <Section icon={<UserRound />} title="Account" description="Every demo visitor shares this account. It is read-only.">
          <div className="max-w-xl space-y-4">
            <div className="flex items-center gap-3">
              <InitialsAvatar name={user.name} seed={user.id} size="lg" />
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium">{user.name}</p>
                <p className="text-zinc-500">
                  Live demo · <Badge>{workspace?.role.name ?? "Demo"}</Badge> in {workspace?.name ?? "the demo workspace"}
                </p>
              </div>
            </div>
            <Notice tone="amber">
              Changing your name, email or password and creating API keys are turned off in the live demo. Sign-up for hosted Postflare is coming soon;
              until then, you can <a className="font-medium underline" href="https://github.com/FerdiKT/postflare">deploy your own copy</a> for free on Cloudflare.
            </Notice>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">{(id) => <Input id={id} value={user.name} disabled readOnly />}</Field>
              <Field label="Email">{(id) => <Input id={id} value={user.email} disabled readOnly />}</Field>
            </div>
          </div>
        </Section>
        <DocsSection token={null} demo />
      </div>
    </>
  );
}

function ProfileSection() {
  const { user, workspaces, refresh } = useSession();
  const toast = useToast();
  const placeholder = isPlaceholderEmail(user.email);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(placeholder ? "" : user.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(user.name);
    setEmail(isPlaceholderEmail(user.email) ? "" : user.email);
  }, [user.name, user.email]);

  const dirty = name.trim() !== user.name || (email.trim() !== "" && email.trim() !== user.email);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: { name?: string; email?: string } = {};
      if (name.trim() !== user.name) body.name = name.trim();
      if (email.trim() && email.trim() !== user.email) body.email = email.trim();
      await api.me.update(body);
      await refresh();
      toast.success("Profile saved");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={<UserRound />} title="Account" description="Your name is shown to the people you work with. You sign in with your email.">
      <form onSubmit={save} className="max-w-xl space-y-4">
        <div className="flex items-center gap-3">
          <InitialsAvatar name={name || user.name} seed={user.id} size="lg" />
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium">{user.name}</p>
            <p className="text-zinc-500">
              Instance role: <Badge>{user.role.name}</Badge> · {workspaces.filter((w) => !w.viaAdmin).length} workspace(s)
            </p>
          </div>
        </div>
        {placeholder && (
          <Notice tone="amber">
            Your account still uses the placeholder address <code className="font-mono text-xs">{user.email}</code>. Set your real email: it becomes your sign-in.
          </Notice>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            {(id) => <Input id={id} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />}
          </Field>
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={placeholder ? "you@example.com" : undefined}
                invalid={placeholder && !email}
                autoFocus={placeholder}
                required={!placeholder}
              />
            )}
          </Field>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty || !name.trim()}>
          Save
        </Button>
      </form>
    </Section>
  );
}

function PasswordSection() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) return setError("Use at least 8 characters.");
    if (next !== confirmPw) return setError("Passwords do not match.");
    setBusy(true);
    try {
      await api.me.changePassword(current, next);
      toast.success("Password changed", "Other sessions were signed out.");
      setCurrent("");
      setNext("");
      setConfirmPw("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={<Lock />} title="Password" description="Changing the password signs out every other session.">
      <form onSubmit={save} className="max-w-xl space-y-4">
        <Field label="Current password">
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />}
          </Field>
          <Field label="Confirm new password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} required />}
          </Field>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <Button type="submit" variant="primary" loading={busy} disabled={!current || !next}>
          Change password
        </Button>
      </form>
    </Section>
  );
}

/** "Postflare for iPhone": pairing QR code (5 minutes, single use) and the signed-in devices with revoke. */
function IphoneSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const devices = useFetch("devices", api.devices.list, ["devices"]);
  const status = useFetch("auth-status", api.auth.status);
  const [code, setCode] = useState<PairingCodeDTO | null>(null);
  const [paired, setPaired] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const expired = !!code && code.expiresAt <= now;

  async function connect() {
    setBusy(true);
    setPaired(undefined);
    try {
      setCode(await api.devices.pairingCode());
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  // Until the app used the code (or it expired): then the device list picks up the new phone.
  useVisiblePoll(
    async () => {
      if (!code) return true;
      const s = await api.devices.pairingStatus(code.id);
      if (s.status === "pending") return false;
      if (s.status === "used") {
        setPaired(s.deviceName);
        setCode(null);
        invalidate("devices");
      }
      return true;
    },
    2000,
    !!code && !expired,
  );

  const list = devices.data?.items ?? [];
  return (
    <Section
      icon={<Smartphone />}
      title="Postflare for iPhone"
      description="Sign in on your iPhone without typing a password, get notified when posts are published or fail, and approve sign-ins on the web."
    >
      <div className="max-w-xl space-y-5">
        {paired !== undefined ? (
          <div className="flex items-start gap-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">{paired ? `${paired} is connected` : "Your iPhone is connected"}</p>
              <p className="mt-0.5">It stays signed in until you revoke it below.</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setPaired(undefined)}>
              Done
            </Button>
          </div>
        ) : !code ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<QrIcon className="size-4" />} onClick={connect} loading={busy}>
              Connect iPhone
            </Button>
            {status.data?.appStoreUrl && (
              <a className="text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400" href={status.data.appStoreUrl} target="_blank" rel="noreferrer">
                Get the app
              </a>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
            <div className="relative shrink-0">
              <QrCode value={code.url} size={192} label="QR code to sign in with the Postflare iOS app" />
              {expired && (
                <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-white/90 text-sm font-medium text-zinc-700 backdrop-blur-sm dark:bg-zinc-900/90 dark:text-zinc-200">
                  Expired
                  <Button size="sm" className="mt-2" icon={<RefreshCw className="size-3.5" />} onClick={connect} loading={busy}>
                    New code
                  </Button>
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 text-center sm:text-left">
              <ol className="space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
                <li>1. Open Postflare on your iPhone.</li>
                <li>2. Tap “Scan QR code”, or point the Camera app at the code.</li>
                <li>3. Your iPhone signs in as you.</li>
              </ol>
              <p className="mt-4 text-xs text-zinc-500">Or type this code in the app</p>
              <p className="mt-1 select-all font-mono text-2xl font-semibold tracking-[0.2em]" aria-label={`Code ${code.code.split("").join(" ")}`}>
                {code.code.slice(0, 5)}-{code.code.slice(5)}
              </p>
              <p className="mt-2 text-sm tabular-nums text-zinc-500" aria-live="polite">
                {expired ? "This code has expired." : `Waiting for your iPhone… expires in ${countdown(code.expiresAt - now)}`}
              </p>
              <div className="mt-3 flex justify-center gap-2 sm:justify-start">
                <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={connect} loading={busy}>
                  New code
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCode(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}

        <div>
          <p className="mb-2 text-sm font-medium">Your devices</p>
          {!devices.data ? (
            <Skeleton className="h-14 w-full" />
          ) : !list.length ? (
            <p className="text-sm text-zinc-500">No iPhone connected yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
              {list.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                  <Smartphone className="size-4 shrink-0 text-zinc-400" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      {d.name ?? "iPhone"}
                      <Badge tone={d.push ? "green" : "zinc"}>{d.push ? "Notifications on" : "Notifications off"}</Badge>
                    </p>
                    <p className="text-xs text-zinc-500">
                      {d.lastSeenAt ? `Last seen ${relativeTime(d.lastSeenAt)}` : "Never used"} · connected {relativeTime(d.createdAt)}
                    </p>
                  </div>
                  {d.push && devices.data?.push && (
                    <IconButton
                      label="Send a test notification"
                      size="sm"
                      onClick={async () => {
                        try {
                          await api.devices.test(d.id);
                          toast.success("Test notification sent");
                        } catch (err) {
                          toast.error(err);
                        }
                      }}
                    >
                      <BellRing className="size-4" />
                    </IconButton>
                  )}
                  <IconButton
                    label="Sign out this device"
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Sign out “${d.name ?? "iPhone"}”?`,
                        message: "The app on this device is signed out at once and stops getting notifications.",
                        confirmLabel: "Sign out",
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await api.devices.remove(d.id);
                        toast.success("Device signed out");
                        invalidate("devices");
                      } catch (err) {
                        toast.error(err);
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Section>
  );
}

function KeysSection({ onCreated }: { onCreated: (token: string) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { tz } = useApp();
  const { workspace, user, can, canInstance } = useSession();
  const allowed = !!workspace && can("apikeys.manage");
  const keys = useFetch(allowed ? "keys" : null, api.keys.list, ["keys"]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const base = usePublicUrl();

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.keys.create(name.trim());
      setCreated({ name: name.trim(), token: res.token });
      onCreated(res.token);
      setName("");
      invalidate("keys");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      icon={<KeyRound />}
      title="API keys"
      description={
        <>
          Bearer tokens for the REST API and the MCP server. A key acts as you, in{" "}
          <strong className="font-medium text-zinc-700 dark:text-zinc-300">{workspace?.name ?? "the current workspace"}</strong> only, with your role there.
        </>
      }
    >
      {!allowed ? (
        <p className="text-sm text-zinc-500">
          {workspace ? `Your role in “${workspace.name}” does not include API keys.` : "Join a workspace to create API keys."}
        </p>
      ) : (
      <>
      <form onSubmit={create} className="flex max-w-xl gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. Claude Code" aria-label="New key name" />
        <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={busy} disabled={!name.trim()}>
          Create key
        </Button>
      </form>
      <div className="mt-5">
        {!keys.data ? (
          <Skeleton className="h-16 w-full" />
        ) : !keys.data.length ? (
          <p className="text-sm text-zinc-500">No API keys yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
            {keys.data.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-4 py-3">
                <KeyRound className="size-4 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{k.name}</p>
                  <p className="text-xs text-zinc-500">
                    {k.userId !== user.id && canInstance("instance.users.manage") && <span className="font-medium text-zinc-600 dark:text-zinc-300">{k.userName ?? "Deleted user"} · </span>}
                    <code className="font-mono">{k.prefix}…</code> · created {formatDateTime(k.createdAt, tz, { year: "numeric" })} ·{" "}
                    {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : "never used"}
                  </p>
                </div>
                <IconButton
                  label="Revoke key"
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirm({ title: `Revoke “${k.name}”?`, message: "Apps using this key lose access immediately.", confirmLabel: "Revoke", danger: true }))) return;
                    try {
                      await api.keys.remove(k.id);
                      toast.success("Key revoked");
                      invalidate("keys");
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
      </>
      )}
      <Dialog
        open={!!created}
        onClose={() => setCreated(null)}
        title="API key created"
        description={created?.name}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            I saved it
          </Button>
        }
      >
        {created && (
          <div className="space-y-4 p-5">
            <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              Copy this token now. It is shown only once and cannot be recovered.
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-zinc-100 px-3 py-2.5 font-mono text-sm dark:bg-zinc-800">{created.token}</code>
              <CopyButton text={created.token} />
            </div>
            <div className="space-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
              <p className="text-sm font-medium">Use it with the CLI</p>
              <p className="text-xs text-zinc-500">Log in (asks for the key, paste it there):</p>
              <CommandLine command={`pf login --url ${base}`} />
              <p className="pt-1 text-xs text-zinc-500">Or without saving it, e.g. in CI:</p>
              <CommandLine command={`POSTFLARE_URL=${base} POSTFLARE_API_KEY=${created.token} pf accounts`} />
            </div>
            <p className="text-xs text-zinc-500">The snippets in “API & MCP” below now include this key until you leave the page.</p>
          </div>
        )}
      </Dialog>
    </Section>
  );
}

/** This instance's public URL (Settings / PUBLIC_URL), else the page's origin. */
function usePublicUrl() {
  const { settings } = useApp();
  return (settings?.publicUrl ?? window.location.origin).replace(/\/$/, "");
}

/** A one-line shell command with a copy button. */
function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
        {command}
      </code>
      <CopyButton text={command} />
    </div>
  );
}

/** Writes the SKILL.md bundled with the CLI to ~/.claude/skills/postflare (re-run after updating the CLI). */
const SKILL_INSTALL = "pf skill install";

function CliSection() {
  const { accounts } = useApp();
  const base = usePublicUrl();
  // A real selector when the first account's platform is unambiguous, else a placeholder.
  const first = accounts[0];
  const selector = first && accounts.filter((a) => a.provider === first.provider).length === 1 ? first.provider : "<account>";
  const examples = [
    "pf accounts                 # connected accounts, followers, analytics state",
    `pf post -a ${selector} --text "New feature is live" -m ./clip.mp4 --at "tomorrow 9:00"`,
    "pf posts --upcoming         # what is scheduled",
    "pf analytics --range 7d     # views, engagement, top posts",
  ].join("\n");

  return (
    <Section
      icon={<SquareTerminal />}
      title="Use with the CLI"
      description={
        <>
          <code className="font-mono text-xs">postflare</code> (alias <code className="font-mono text-xs">pf</code>) schedules posts, uploads media and reads
          analytics from your terminal, scripts and AI agents. Node.js 20+.
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Install</p>
          <CommandLine command="npm i -g postflare" />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Log in</p>
          <CommandLine command={`pf login --url ${base}`} />
          <p className="text-sm text-zinc-500">
            Asks for an API key (create one above). In CI, set <code className="font-mono text-xs">POSTFLARE_URL</code> and{" "}
            <code className="font-mono text-xs">POSTFLARE_API_KEY</code> instead of logging in.
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Examples</p>
          <CodeBlock code={examples} />
          <p className="text-sm text-zinc-500">
            <code className="font-mono text-xs">pf &lt;command&gt; --help</code> shows every option; add <code className="font-mono text-xs">--json</code> for scripts.
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Claude Code skill</p>
          <CommandLine command={SKILL_INSTALL} />
          <p className="text-sm text-zinc-500">
            Teaches Claude Code to schedule posts and write performance reports with the CLI. Installs into{" "}
            <code className="font-mono text-xs">~/.claude/skills/postflare</code> (<code className="font-mono text-xs">--dir .claude/skills</code> for one
            project); re-run it after updating the CLI. Prefer MCP? The server below works without the CLI.
          </p>
        </div>
      </div>
    </Section>
  );
}

const MCP_TOOLS = [
  "list_platforms",
  "list_accounts",
  "get_account_options",
  "upload_media_from_url",
  "create_upload_link",
  "get_upload_link",
  "list_media",
  "create_post",
  "list_posts",
  "get_post",
  "update_post",
  "cancel_post",
  "retry_post",
  "delete_post",
  "get_analytics_summary",
  "get_top_posts",
  "get_post_metrics",
  "refresh_metrics",
];

function DocsSection({ token, demo = false }: { token: string | null; demo?: boolean }) {
  const { accounts } = useApp();
  const [tab, setTab] = useState<"claude" | "json" | "curl">("claude");
  const base = usePublicUrl();
  const key = token ?? "pf_your_api_key";
  const accountId = accounts[0]?.id ?? "acc_...";
  const tomorrow = new Date(Date.now() + 864e5);
  tomorrow.setHours(9, 0, 0, 0);

  const snippets = {
    claude: `claude mcp add --transport http postflare ${base}/mcp --header "Authorization: Bearer ${key}"`,
    json: JSON.stringify({ mcpServers: { postflare: { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    curl: `curl -X POST ${base}/api/posts \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ scheduledAt: tomorrow.getTime(), posts: [{ accountId, content: "Hello from Postflare 👋", media: [] }] })}'`,
  };

  return (
    <Section icon={<Bot />} title="API & MCP" description="Let scripts and AI agents (Claude Code, Claude Desktop, Cursor…) schedule posts for you.">
      <div className="space-y-5">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "claude", label: "Claude Code" },
            { value: "json", label: "MCP JSON config" },
            { value: "curl", label: "REST (curl)" },
          ]}
        />
        <CodeBlock code={snippets[tab]} />
        {tab === "claude" && (
          <p className="text-sm text-zinc-500">
            Then ask Claude things like <em>“schedule a post about our launch on all my accounts tomorrow at 9”</em>. The MCP endpoint speaks Streamable HTTP at{" "}
            <code className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-800">{base}/mcp</code>.
          </p>
        )}
        {tab === "json" && <p className="text-sm text-zinc-500">For clients that read an <code className="font-mono text-xs">mcpServers</code> config (Claude Desktop, Cursor, Windsurf…).</p>}
        {tab === "curl" && (
          <div className="space-y-1 text-sm text-zinc-500">
            <p>
              <code className="font-mono text-xs">scheduledAt</code> is a millisecond timestamp, <code className="font-mono text-xs">"now"</code>, or{" "}
              <code className="font-mono text-xs">null</code> for a draft. One entry in <code className="font-mono text-xs">posts</code> per account; per-account{" "}
              <code className="font-mono text-xs">settings</code> and <code className="font-mono text-xs">thread</code> are optional.
            </p>
            <p>
              Other endpoints: <code className="font-mono text-xs">GET /api/accounts</code>, <code className="font-mono text-xs">GET /api/providers</code>,{" "}
              <code className="font-mono text-xs">POST /api/media/from-url</code>, <code className="font-mono text-xs">GET /api/posts</code>,{" "}
              <code className="font-mono text-xs">POST /api/posts/validate</code>.
            </p>
          </div>
        )}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">MCP tools</p>
          <div className="flex flex-wrap gap-1.5">
            {MCP_TOOLS.map((t) => (
              <code key={t} className="rounded-md bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {t}
              </code>
            ))}
          </div>
        </div>
        {!token && !demo && <p className="text-xs text-zinc-400">Create an API key above to fill it into the snippets.</p>}
      </div>
    </Section>
  );
}
