import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Check, Inbox } from "lucide-react";
import { ProviderLogo } from "../components/ProviderLogo";
import { Turnstile } from "../components/Turnstile";
import { Button } from "../components/ui/Button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/Form";
import { ApiError, api, errorMessage } from "../lib/api";
import { PLATFORMS, ROLE_LABELS, USE_CASE_MAX, USE_CASE_MIN, VOLUME_LABELS } from "../lib/accessRequests";
import { cn } from "../lib/format";
import type { AccessRequestPlatform, AccessRequestRole, AccessRequestVolume } from "../lib/types";
import { AuthShell, FormError } from "./AuthPage";

/**
 * `/apply` (signup_mode apply, signed out): "Request access". The answer is the same whether or not the email applied
 * before or has an account, so the confirmation never says more than "we'll email you". `turnstileSiteKey`: the bot
 * check is on and its token (action "apply") goes with the form.
 */
export function ApplyPage({ turnstileSiteKey }: { turnstileSiteKey?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [role, setRole] = useState<AccessRequestRole | "">("");
  const [platforms, setPlatforms] = useState<AccessRequestPlatform[]>([]);
  const [accounts, setAccounts] = useState("");
  const [volume, setVolume] = useState<AccessRequestVolume | "">("");
  const [useCase, setUseCase] = useState("");
  const [referral, setReferral] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<{ message: string; tone: "red" | "amber" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  const toggle = (p: AccessRequestPlatform) => setPlatforms((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]));
  const useCaseLength = useCase.trim().length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!role) return setError({ message: "Choose what describes you best.", tone: "red" });
    if (!platforms.length) return setError({ message: "Choose at least one platform you plan to use.", tone: "red" });
    if (useCaseLength < USE_CASE_MIN) return setError({ message: `Tell us a bit more about how you'll use Postflare (at least ${USE_CASE_MIN} characters).`, tone: "red" });
    if (!consent) return setError({ message: "Agree to the Terms and the Privacy Policy to continue.", tone: "red" });
    if (turnstileSiteKey && !captcha) return setError({ message: "Wait for the bot check to finish.", tone: "amber" });
    setBusy(true);
    try {
      await api.auth.apply({
        name: name.trim(),
        email: email.trim(),
        ...(company.trim() ? { company: company.trim() } : {}),
        url: url.trim(),
        role,
        platforms,
        ...(accounts !== "" ? { accounts: Number(accounts) } : {}),
        ...(volume ? { volume } : {}),
        useCase: useCase.trim(),
        ...(referral.trim() ? { referral: referral.trim() } : {}),
        consent: true,
        ...(turnstileSiteKey && captcha ? { turnstileToken: captcha } : {}),
      });
      setSentTo(email.trim());
      window.scrollTo({ top: 0 });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError({ message: status === 404 ? "Requests for access are closed right now." : errorMessage(err), tone: status === 429 || status === 404 ? "amber" : "red" });
      if (turnstileSiteKey) setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthShell title="Thanks, we got your request">
        <div className="flex gap-3 rounded-xl bg-zinc-50 p-3.5 text-sm text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-zinc-800">
          <Inbox className="mt-0.5 size-5 shrink-0 text-brand-500" />
          <p>
            We review every request by hand, usually within a few days. We&rsquo;ll email you at{" "}
            <span className="font-medium break-all text-zinc-900 dark:text-zinc-100">{sentTo}</span>.
          </p>
        </div>
        <p className="mt-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          <Link to="/" className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400" reloadDocument>
            Back to the home page
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      wide
      title="Request access"
      subtitle="Postflare is open by application while we grow. Tell us a little about you and how you'd use it: we read every request."
      footer={
        <p className="mt-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">
            Sign in
          </Link>
        </p>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" required>
            {(id) => <Input id={id} autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" maxLength={100} required />}
          </Field>
          <Field label="Email" required>
            {(id) => <Input id={id} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" maxLength={254} required />}
          </Field>
          <Field label="Company or brand">
            {(id) => <Input id={id} autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Optional" maxLength={100} />}
          </Field>
          <Field label="Website or main social profile" required>
            {(id) => <Input id={id} type="text" inputMode="url" autoComplete="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.com or tiktok.com/@you" maxLength={300} required />}
          </Field>
        </div>

        <Field label="What describes you best?" required>
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value as AccessRequestRole)} required>
              <option value="" disabled>
                Choose one
              </option>
              {(Object.keys(ROLE_LABELS) as AccessRequestRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Platforms you plan to use<span className="ml-0.5 text-red-500">*</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => {
              const on = platforms.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(p.id)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full pl-1 pr-3 text-sm ring-1 ring-inset transition",
                    on
                      ? "bg-brand-50 font-medium text-brand-800 ring-brand-300 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-500/40"
                      : "bg-white text-zinc-700 ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800",
                  )}
                >
                  {on ? (
                    <span className="inline-flex size-6 items-center justify-center rounded-full bg-brand-600 text-white">
                      <Check className="size-3.5" />
                    </span>
                  ) : (
                    <ProviderLogo provider={p} size="sm" className="size-6 rounded-full" />
                  )}
                  {p.name}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Accounts to connect">
            {(id) => <Input id={id} type="number" inputMode="numeric" min={0} max={1000} step={1} value={accounts} onChange={(e) => setAccounts(e.target.value)} placeholder="e.g. 3" />}
          </Field>
          <Field label="Posts per month">
            {(id) => (
              <Select id={id} value={volume} onChange={(e) => setVolume(e.target.value as AccessRequestVolume)}>
                <option value="">Not sure yet</option>
                {(Object.keys(VOLUME_LABELS) as AccessRequestVolume[]).map((v) => (
                  <option key={v} value={v}>
                    {VOLUME_LABELS[v]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Field
          label="How will you use Postflare?"
          required
          help={
            <span className="flex justify-between gap-3">
              <span>What you publish, for whom, and what you need from a scheduler.</span>
              <span className={cn("shrink-0 tabular-nums", useCaseLength > 0 && useCaseLength < USE_CASE_MIN && "text-amber-600 dark:text-amber-400")}>
                {useCaseLength}/{USE_CASE_MAX}
              </span>
            </span>
          }
        >
          {(id) => (
            <Textarea
              id={id}
              rows={4}
              value={useCase}
              onChange={(e) => setUseCase(e.target.value)}
              maxLength={USE_CASE_MAX}
              placeholder="We're a two-person studio launching a habit tracker app. We'd post short videos to TikTok and Reels three times a week."
              required
            />
          )}
        </Field>

        <Field label="How did you hear about Postflare?">
          {(id) => <Input id={id} value={referral} onChange={(e) => setReferral(e.target.value)} placeholder="Optional" maxLength={200} />}
        </Field>

        <label className="flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-300">
          <Checkbox className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
          <span>
            I agree to the{" "}
            <a href="/terms/" target="_blank" className="font-medium text-zinc-900 underline hover:text-brand-600 dark:text-zinc-100 dark:hover:text-brand-400">
              Terms of Service
            </a>{" "}
            and the{" "}
            <a href="/privacy/" target="_blank" className="font-medium text-zinc-900 underline hover:text-brand-600 dark:text-zinc-100 dark:hover:text-brand-400">
              Privacy Policy
            </a>
            , and to being contacted about this request.
          </span>
        </label>

        {turnstileSiteKey && (
          <Turnstile siteKey={turnstileSiteKey} action="apply" onToken={setCaptcha} onError={(message) => setError({ message, tone: "red" })} resetKey={captchaReset} />
        )}
        {error && <FormError tone={error.tone}>{error.message}</FormError>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!!turnstileSiteKey && !captcha}>
          Request access
        </Button>
      </form>
    </AuthShell>
  );
}
