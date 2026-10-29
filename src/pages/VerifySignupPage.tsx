import { useState } from "react";
import { Link } from "react-router";
import { MailCheck } from "lucide-react";
import { Button } from "../components/ui/Button";
import { api, errorMessage } from "../lib/api";
import { rememberWorkspace } from "../lib/session";
import { AuthShell, FormError } from "./AuthPage";

/**
 * `/auth/verify#<token>`: the sign-up confirmation link. Like /auth/link, the token stays in the fragment and is used
 * only by the button press (link scanners opening the page confirm nothing). Then a full reload into the new workspace.
 */
export function VerifySignupPage() {
  const [token] = useState(() => window.location.hash.slice(1));
  const [error, setError] = useState<string | null>(token ? null : "This confirmation link is incomplete. Open it again from the email, or sign up again.");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const { workspaceId } = await api.auth.verifySignup(token);
      rememberWorkspace(workspaceId);
      // A full reload: the new account is signed in now (and may replace another session).
      window.location.replace("/");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Confirm your email" subtitle="One click and your Postflare account is ready.">
      <div className="space-y-4">
        {error && <FormError>{error}</FormError>}
        {token && (
          <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={confirm}>
            <MailCheck className="size-4" /> Confirm and continue
          </Button>
        )}
        <Link to="/login" className="block text-center text-sm font-medium text-brand-600 hover:text-brand-700">
          Back to sign in
        </Link>
      </div>
    </AuthShell>
  );
}
