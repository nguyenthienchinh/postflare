import { useState } from "react";
import { Link } from "react-router";
import { LogIn } from "lucide-react";
import { Button } from "../components/ui/Button";
import { api, errorMessage } from "../lib/api";
import { AuthShell, FormError } from "./AuthPage";

/**
 * `/auth/link#<token>`: opened from a sign-in link email. The token stays in the fragment (never sent in a URL, so not
 * in logs) and is only used up by the button press: email link scanners that open the page do not sign anyone in.
 */
export function MagicLinkPage() {
  const [token] = useState(() => window.location.hash.slice(1));
  const [error, setError] = useState<string | null>(
    token ? null : "This sign-in link is incomplete. Open it again from the email, or request a new one.",
  );
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await api.auth.verifyMagicLink(token);
      // A full reload: the link may sign in a different user than the current session.
      window.location.replace("/");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in to Postflare" subtitle="Continue with the link from your email.">
      <div className="space-y-4">
        {error && <FormError>{error}</FormError>}
        {token && (
          <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={signIn}>
            <LogIn className="size-4" /> Sign in
          </Button>
        )}
        <Link to="/login" className="block text-center text-sm font-medium text-brand-600 hover:text-brand-700">
          Back to sign in
        </Link>
      </div>
    </AuthShell>
  );
}
