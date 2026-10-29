import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { CalendarClock, KeyRound, Lock, Mail, MailCheck, RefreshCw, ShieldX, Smartphone, Sparkles, Users } from "lucide-react";
import { QrCode } from "../components/QrCode";
import { Wordmark } from "../components/Logo";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Form";
import { Turnstile } from "../components/Turnstile";
import { ApiError, api, errorMessage } from "../lib/api";
import { countdown, useNow, useVisiblePoll } from "../lib/poll";
import type { AppLoginStartDTO } from "../lib/types";

/**
 * `magicLink`: the instance can email sign-in links, offered next to the password. `signup`: public sign-up is on;
 * `apply`: people request access instead (/apply).
 * `turnstileSiteKey`: the bot check is on: always for sign-in links, for the password once the server answers
 * `captchaRequired` (3 recent failures). Never for the first-run setup. `appLogin`: "Sign in with the iPhone app" (QR,
 * plus "Send a request to my iPhone" with `pushLogin`), docs/app-login-spec.md.
 */
export function AuthPage({
  mode,
  setupToken: askToken = false,
  magicLink = false,
  signup = false,
  apply = false,
  turnstileSiteKey,
  appLogin = false,
  pushLogin = false,
  appStoreUrl,
  onDone,
}: {
  mode: "setup" | "login";
  setupToken?: boolean;
  magicLink?: boolean;
  signup?: boolean;
  /** signupMode apply: "Request access" instead of "Create an account". */
  apply?: boolean;
  turnstileSiteKey?: string;
  appLogin?: boolean;
  pushLogin?: boolean;
  appStoreUrl?: string;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<{ message: string; tone: "red" | "amber" } | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = mode === "setup";
  const [useLink, setUseLink] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const linkMode = !setup && magicLink && useLink;
  const [loginCaptcha, setLoginCaptcha] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const captchaAction = setup || !turnstileSiteKey ? null : linkMode ? "magic_link" : loginCaptcha ? "login" : null;
  const [withApp, setWithApp] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (setup && !name.trim()) return setError({ message: "Enter your name.", tone: "red" });
    if (setup && password.length < 8) return setError({ message: "Use at least 8 characters for the password.", tone: "red" });
    if (setup && password !== confirm) return setError({ message: "Passwords do not match.", tone: "red" });
    if (captchaAction && !captcha) return setError({ message: "Wait for the bot check to finish.", tone: "amber" });
    const turnstileToken = captchaAction ? (captcha ?? undefined) : undefined;
    setBusy(true);
    try {
      if (linkMode) {
        await api.auth.magicLink(email.trim(), turnstileToken);
        return setSentTo(email.trim());
      }
      if (setup) await api.auth.setup({ name: name.trim(), email: email.trim(), password, workspaceName: workspaceName.trim() || undefined, ...(askToken ? { setupToken: token.trim() } : {}) });
      else await api.auth.login(email.trim(), password, turnstileToken);
      onDone();
    } catch (err) {
      // 429: throttled, 403: disabled account: both are not "wrong password" and deserve a calmer tone.
      const status = err instanceof ApiError ? err.status : 0;
      setError({ message: errorMessage(err), tone: status === 429 || status === 403 ? "amber" : "red" });
      // After 3 failed sign-ins the server wants the bot check too: show the widget, the next try sends its token.
      if (!setup && !linkMode && err instanceof ApiError && (err.captchaRequired || err.code === "captcha")) setLoginCaptcha(true);
      // Tokens are single use: a new one for the next try.
      if (captchaAction) setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (withApp && !setup) {
    return (
      <AuthShell title="Sign in with the iPhone app" subtitle="Approve this sign-in in Postflare on your iPhone. No password needed.">
        <AppLoginPanel pushLogin={pushLogin} appStoreUrl={appStoreUrl} turnstileSiteKey={turnstileSiteKey} email={email} onDone={onDone} />
        <Button variant="ghost" className="mt-4 w-full" onClick={() => setWithApp(false)}>
          <KeyRound className="size-4" />
          Sign in with a password instead
        </Button>
      </AuthShell>
    );
  }

  if (sentTo) {
    return (
      <AuthShell title="Check your email">
        <div className="flex gap-3 rounded-xl bg-zinc-50 p-3.5 text-sm text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-zinc-800">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-brand-500" />
          <p>
            If an account exists for <span className="font-medium text-zinc-900 dark:text-zinc-100">{sentTo}</span>, a sign-in link is on its way. It works
            once, for 15 minutes.
          </p>
        </div>
        <Button variant="ghost" className="mt-4 w-full" onClick={() => setSentTo(null)}>
          Use a different email
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={setup ? "Welcome to Postflare" : "Sign in"}
      subtitle={
        setup
          ? "Create the first account. You become the admin of this instance."
          : linkMode
            ? "We will email you a link to sign in."
            : "Sign in with your email and password."
      }
      footer={
        setup && (
          <ul className="mt-8 space-y-3 px-2 text-sm text-zinc-500 dark:text-zinc-400">
            <li className="flex gap-3">
              <Lock className="mt-0.5 size-4 shrink-0 text-brand-500" /> Self-hosted on your Cloudflare account. Tokens are encrypted at rest.
            </li>
            <li className="flex gap-3">
              <Users className="mt-0.5 size-4 shrink-0 text-brand-500" /> Invite people later, each with their own workspace or a role in yours.
            </li>
            <li className="flex gap-3">
              <CalendarClock className="mt-0.5 size-4 shrink-0 text-brand-500" /> Schedule to 30+ platforms from one composer.
            </li>
            <li className="flex gap-3">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-500" /> REST API and MCP server for AI agents.
            </li>
          </ul>
        )
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {setup && (
          <Field label="Your name">
            {(id) => <Input id={id} autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" required />}
          </Field>
        )}
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              autoFocus={!setup}
              autoComplete={setup ? "email" : "username"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          )}
        </Field>
        {!linkMode && (
          <Field label="Password">
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={setup ? "At least 8 characters" : "••••••••"}
                required
              />
            )}
          </Field>
        )}
        {setup && (
          <>
            <Field label="Confirm password">
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
            </Field>
            <Field label="Workspace name" help="Accounts, posts and media live in a workspace. You can rename it later.">
              {(id) => <Input id={id} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="My workspace" maxLength={100} />}
            </Field>
            {askToken && (
              <Field label="Setup token" help="The SETUP_TOKEN secret of this deployment.">
                {(id) => <Input id={id} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />}
              </Field>
            )}
          </>
        )}
        {captchaAction && turnstileSiteKey && (
          <Turnstile
            key={captchaAction}
            siteKey={turnstileSiteKey}
            action={captchaAction}
            onToken={setCaptcha}
            onError={(message) => setError({ message, tone: "red" })}
            resetKey={captchaReset}
          />
        )}
        {error && <FormError tone={error.tone}>{error.message}</FormError>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email || (!linkMode && !password) || (!!captchaAction && !captcha)}>
          {setup ? "Create account & continue" : linkMode ? "Email me a sign-in link" : "Sign in"}
        </Button>
        {!setup && magicLink && (
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setUseLink(!useLink);
              setError(null);
            }}
          >
            {linkMode ? <KeyRound className="size-4" /> : <Mail className="size-4" />}
            {linkMode ? "Sign in with a password instead" : "Email me a sign-in link instead"}
          </Button>
        )}
        {!setup && appLogin && (
          <Button variant="ghost" className="w-full" onClick={() => setWithApp(true)}>
            <Smartphone className="size-4" />
            Sign in with the iPhone app
          </Button>
        )}
        {!setup && signup && (
          <p className="border-t border-zinc-100 pt-4 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            New to Postflare?{" "}
            <Link to="/signup" className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">
              Create an account
            </Link>
          </p>
        )}
        {!setup && !signup && apply && (
          <p className="border-t border-zinc-100 pt-4 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            Don&rsquo;t have an account?{" "}
            <Link to="/apply" className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">
              Request access
            </Link>
          </p>
        )}
      </form>
    </AuthShell>
  );
}

type AppLoginState = "starting" | "waiting" | "signing_in" | "denied" | "expired" | "error";

/**
 * The QR code (or the number of a push request) of a web login request, polled every 2 s while the tab is visible
 * until the app approves it: the approving poll answer carries the session cookie.
 */
function AppLoginPanel({
  pushLogin,
  appStoreUrl,
  turnstileSiteKey,
  email: initialEmail,
  onDone,
}: {
  pushLogin: boolean;
  appStoreUrl?: string;
  turnstileSiteKey?: string;
  email: string;
  onDone: () => void;
}) {
  const [req, setReq] = useState<AppLoginStartDTO | null>(null);
  const [state, setState] = useState<AppLoginState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [pushForm, setPushForm] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const now = useNow(1000);
  const current = useRef<AppLoginStartDTO | null>(null);

  const cancelCurrent = useCallback(() => {
    const r = current.current;
    current.current = null;
    if (r) void api.auth.appLogin.cancel(r.id, r.secret).catch(() => {});
  }, []);

  const start = useCallback(
    async (body: Parameters<typeof api.auth.appLogin.start>[0]) => {
      cancelCurrent();
      setError(null);
      setBusy(true);
      try {
        const r = await api.auth.appLogin.start(body);
        current.current = r;
        setReq(r);
        setState("waiting");
        return true;
      } catch (err) {
        setError(errorMessage(err));
        setState("error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [cancelCurrent],
  );

  useEffect(() => {
    void start({ kind: "qr" });
    return cancelCurrent;
  }, [start, cancelCurrent]);

  const expired = !!req && state === "waiting" && req.expiresAt <= now;
  useEffect(() => {
    if (expired) setState("expired");
  }, [expired]);

  useVisiblePoll(
    async () => {
      if (!req) return true;
      const r = await api.auth.appLogin.poll(req.id, req.secret);
      if (r.status === "pending") return false;
      current.current = null;
      if (r.status === "signed_in") {
        setState("signing_in");
        onDone();
      } else setState(r.status === "denied" ? "denied" : "expired");
      return true;
    },
    2000,
    !!req && state === "waiting",
  );

  async function sendPush(e: FormEvent) {
    e.preventDefault();
    if (turnstileSiteKey && !captcha) return setError("Wait for the bot check to finish.");
    const ok = await start({ kind: "push", email: email.trim(), ...(turnstileSiteKey && captcha ? { turnstileToken: captcha } : {}) });
    if (turnstileSiteKey) setCaptchaReset((n) => n + 1);
    if (ok) setPushForm(false);
  }

  const newCode = () => void start({ kind: "qr" });

  if (pushForm) {
    return (
      <form onSubmit={sendPush} className="space-y-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">We send a sign-in request to the iPhones signed in to your account. Then pick the number shown here in the app.</p>
        <Field label="Email">
          {(id) => <Input id={id} type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />}
        </Field>
        {turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} action="app_login" onToken={setCaptcha} onError={setError} resetKey={captchaReset} />}
        {error && <FormError>{error}</FormError>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email.trim() || (!!turnstileSiteKey && !captcha)}>
          Send to my iPhone
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => (setPushForm(false), newCode())}>
          Show the QR code instead
        </Button>
      </form>
    );
  }

  const left = req ? countdown(req.expiresAt - now) : "";
  return (
    <div className="space-y-4">
      {state === "denied" ? (
        <div className="flex gap-3 rounded-xl bg-red-50 p-3.5 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">
          <ShieldX className="mt-0.5 size-5 shrink-0" />
          <p>The sign-in was denied in the app{req?.number ? " (a different number was picked)" : ""}. Start again if that was you.</p>
        </div>
      ) : state === "signing_in" ? (
        <p className="py-8 text-center text-sm font-medium text-emerald-700 dark:text-emerald-400">Approved. Signing you in…</p>
      ) : req?.number ? (
        <div className="rounded-xl bg-zinc-50 p-5 text-center ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:ring-zinc-800">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">If {email.trim() || "this email"} has the app with notifications on, open the request and tap</p>
          <p className="my-2 font-mono text-5xl font-semibold tabular-nums" aria-live="polite">
            {req.number}
          </p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">in the app.</p>
        </div>
      ) : (
        <div className="flex justify-center">
          <div className="relative">
            {req?.qr ? <QrCode value={req.qr} size={208} label="QR code to sign in with the Postflare iPhone app" /> : <div className="size-52 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />}
            {(state === "expired" || state === "error") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-white/90 text-sm font-medium text-zinc-700 backdrop-blur-sm dark:bg-zinc-900/90 dark:text-zinc-200">
                {state === "expired" ? "Expired" : "Not available"}
              </div>
            )}
          </div>
        </div>
      )}
      {state === "waiting" && !req?.number && (
        <ol className="space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
          <li>1. Open Postflare on your iPhone → Settings → “Sign in on a computer”, or point the Camera app at the code.</li>
          <li>2. Check where the request comes from, then approve with Face ID.</li>
        </ol>
      )}
      {state === "waiting" && (
        <p className="text-center text-sm tabular-nums text-zinc-500" aria-live="polite">
          Waiting for the app… {left}
        </p>
      )}
      {error && state === "error" && <FormError>{error}</FormError>}
      {state !== "signing_in" && (
        <Button className="w-full" icon={<RefreshCw className="size-4" />} onClick={newCode} loading={busy}>
          Show a new code
        </Button>
      )}
      {pushLogin && state !== "signing_in" && (
        <Button variant="ghost" className="w-full" onClick={() => (cancelCurrent(), setReq(null), setError(null), setPushForm(true))}>
          Can't scan? Send a request to my iPhone
        </Button>
      )}
      {appStoreUrl && (
        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          No app yet?{" "}
          <a href={appStoreUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">
            Get the app
          </a>
        </p>
      )}
    </div>
  );
}

export function FormError({ tone = "red", children }: { tone?: "red" | "amber"; children: ReactNode }) {
  return (
    <p
      role="alert"
      className={
        tone === "amber"
          ? "rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900"
          : "rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900"
      }
    >
      {children}
    </p>
  );
}

/** Centered card layout shared by sign-in, setup and invitation pages. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  wide = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Longer forms (Request access): a wider card. */
  wide?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60rem_30rem_at_50%_-10%,rgba(249,115,22,0.16),transparent)] dark:bg-[radial-gradient(60rem_30rem_at_50%_-10%,rgba(249,115,22,0.12),transparent)]" />
      <div className={wide ? "w-full max-w-xl" : "w-full max-w-sm"}>
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-2xl bg-white p-7 shadow-xl shadow-zinc-900/5 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:shadow-black/30 dark:ring-zinc-800">
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</div>}
          </div>
          {children}
        </div>
        {footer}
        <nav aria-label="Legal" className="mt-6 flex justify-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
          {/* Server-rendered pages (operator details), not SPA routes: plain links. */}
          <a href="/privacy/" className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-200">
            Privacy Policy
          </a>
          <a href="/terms/" className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-200">
            Terms of Service
          </a>
          <a href="/data-deletion/" className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-200">
            Data Deletion
          </a>
        </nav>
      </div>
    </div>
  );
}
