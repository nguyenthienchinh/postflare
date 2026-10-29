import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { MailCheck } from "lucide-react";
import { PricingCards } from "../components/billing/PricingCards";
import { Turnstile } from "../components/Turnstile";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Form";
import { ApiError, api, errorMessage } from "../lib/api";
import { rememberWorkspace } from "../lib/session";
import type { PublicPlanDTO } from "../lib/types";
import { AuthShell, FormError } from "./AuthPage";

/**
 * `/signup` (public sign-up on, signed out): name, email, password and workspace name. With email configured the server
 * mails a confirmation link (`/auth/verify#<token>`) and the page says so; without it the account is active at once and
 * `onDone` reloads the app into the new workspace. While billing is on, the plans are previewed under the form.
 * `turnstileSiteKey`: the bot check (Cloudflare Turnstile) is on and its token goes with the form.
 */
export function SignupPage({ onDone, turnstileSiteKey }: { onDone: () => void; turnstileSiteKey?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<{ message: string; tone: "red" | "amber" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [plans, setPlans] = useState<PublicPlanDTO[]>([]);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  useEffect(() => {
    api.billing.plans().then((p) => setPlans(p.enabled ? p.plans : []), () => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError({ message: "Enter your name.", tone: "red" });
    if (password.length < 8) return setError({ message: "Use at least 8 characters for the password.", tone: "red" });
    if (password !== confirm) return setError({ message: "Passwords do not match.", tone: "red" });
    if (turnstileSiteKey && !captcha) return setError({ message: "Wait for the bot check to finish.", tone: "amber" });
    setBusy(true);
    try {
      const res = await api.auth.signup({
        name: name.trim(),
        email: email.trim(),
        password,
        workspaceName: workspaceName.trim() || undefined,
        ...(turnstileSiteKey && captcha ? { turnstileToken: captcha } : {}),
      });
      if (res.verify) return setSentTo(email.trim());
      rememberWorkspace(res.workspaceId);
      onDone();
    } catch (err) {
      // 429: too many sign-ups from this network, 409: the email has an account (instances without email only).
      const status = err instanceof ApiError ? err.status : 0;
      setError({ message: errorMessage(err), tone: status === 429 || status === 409 ? "amber" : "red" });
      // Tokens are single use: a new one for the next try.
      if (turnstileSiteKey) setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthShell title="Check your email">
        <div className="flex gap-3 rounded-xl bg-zinc-50 p-3.5 text-sm text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-zinc-800">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-brand-500" />
          <p>
            We sent a link to <span className="font-medium text-zinc-900 dark:text-zinc-100">{sentTo}</span>. Open it to confirm your email and finish creating
            your account. It works for 24 hours.
          </p>
        </div>
        <p className="mt-4 text-center text-sm text-zinc-500">
          Wrong address?{" "}
          <button className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400" onClick={() => setSentTo(null)}>
            Sign up again
          </button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Schedule and publish to every social network from one place."
      footer={
        <>
          <p className="mt-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Already have an account?{" "}
            <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">
              Sign in
            </Link>
          </p>
          {plans.length > 0 && (
            <div className="mt-8">
              <p className="mb-3 text-center text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {plans.some((p) => p.isTrialDefault) ? `Start with a free trial of ${plans.find((p) => p.isTrialDefault)!.name}, no card needed` : "Plans"}
              </p>
              <PricingCards plans={plans} interval="month" compact />
            </div>
          )}
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name">
          {(id) => <Input id={id} autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" maxLength={100} required />}
        </Field>
        <Field label="Email">
          {(id) => <Input id={id} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />}
        </Field>
        <Field label="Password">
          {(id) => (
            <Input id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required />
          )}
        </Field>
        <Field label="Confirm password">
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
        </Field>
        <Field label="Workspace name" help="Accounts, posts and media live in a workspace. You can rename it later.">
          {(id) => <Input id={id} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="My workspace" maxLength={100} />}
        </Field>
        {turnstileSiteKey && (
          <Turnstile siteKey={turnstileSiteKey} action="signup" onToken={setCaptcha} onError={(message) => setError({ message, tone: "red" })} resetKey={captchaReset} />
        )}
        {error && <FormError tone={error.tone}>{error.message}</FormError>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email || !password || (!!turnstileSiteKey && !captcha)}>
          Create account
        </Button>
        <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
          By signing up you agree to the{" "}
          <a href="/terms/" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
            Terms
          </a>{" "}
          and the{" "}
          <a href="/privacy/" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
            Privacy Policy
          </a>
          .
        </p>
      </form>
    </AuthShell>
  );
}
