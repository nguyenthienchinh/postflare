import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Building2, Clock, LinkIcon, LogOut, UserPlus } from "lucide-react";
import { InitialsAvatar } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Form";
import { Skeleton } from "../components/ui/Misc";
import { ApiError, api, errorMessage } from "../lib/api";
import { rememberWorkspace } from "../lib/session";
import type { InvitationLookupDTO, MeDTO } from "../lib/types";
import { AuthShell, FormError } from "./AuthPage";

/** `/invite/:token`: public page to accept an invitation (signed out: create an account; signed in: join). */
export function InvitePage({ authenticated, onLoggedOut }: { authenticated: boolean; onLoggedOut: () => void }) {
  const { token = "" } = useParams();
  const [invite, setInvite] = useState<InvitationLookupDTO | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [me, setMe] = useState<MeDTO | null>(null);

  useEffect(() => {
    api.invitations
      .lookup(token)
      .then(setInvite)
      .catch((err) => setLookupError(err instanceof ApiError && err.status === 404 ? "This invitation link is not valid. Ask for a new one." : errorMessage(err)));
  }, [token]);

  useEffect(() => {
    if (!authenticated) return setMe(null);
    api.me.get().then(setMe, () => setMe(null));
  }, [authenticated]);

  /** Signed in now (cookie set by the server): start the app in the joined workspace. */
  function enter(workspaceId: string) {
    rememberWorkspace(workspaceId);
    window.location.assign("/");
  }

  if (lookupError) {
    return (
      <AuthShell title="Invitation not found">
        <Unavailable icon={<LinkIcon className="size-5" />} message={lookupError} authenticated={authenticated} />
      </AuthShell>
    );
  }
  if (!invite || (authenticated && !me)) {
    return (
      <AuthShell title="Invitation">
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </AuthShell>
    );
  }

  const target = invite.workspaceName ?? invite.newWorkspaceName ?? "a workspace";
  const summary = (
    <div className="mb-6 flex items-center gap-3 rounded-xl bg-zinc-50 p-3.5 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:ring-zinc-800">
      <InitialsAvatar name={target} square size="lg" />
      <div className="min-w-0 text-sm">
        <p className="truncate font-semibold">{target}</p>
        <p className="text-zinc-500 dark:text-zinc-400">
          {invite.workspaceName ? (
            <>
              Join as <strong className="font-medium text-zinc-700 dark:text-zinc-200">{invite.workspaceRole?.name ?? "member"}</strong>
            </>
          ) : (
            "A new workspace that you will own"
          )}
        </p>
      </div>
    </div>
  );
  const subtitle = (
    <>
      <strong className="font-medium text-zinc-700 dark:text-zinc-200">{invite.invitedBy}</strong> invited you to Postflare
      {invite.workspaceName ? ` to work in “${invite.workspaceName}”.` : "."}
    </>
  );

  if (invite.accepted || invite.expired) {
    return (
      <AuthShell title={invite.accepted ? "Invitation already used" : "Invitation expired"} subtitle={subtitle}>
        {summary}
        <Unavailable
          icon={<Clock className="size-5" />}
          message={invite.accepted ? "This link has already been used. Sign in instead, or ask for a new invitation." : `Ask ${invite.invitedBy} for a new link: invitations are valid for 7 days.`}
          authenticated={authenticated}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="You're invited" subtitle={subtitle}>
      {summary}
      {authenticated && me ? (
        <JoinAsCurrentUser token={token} me={me} invite={invite} onJoined={enter} onLoggedOut={onLoggedOut} />
      ) : (
        <CreateAccountForm token={token} invite={invite} onJoined={enter} />
      )}
    </AuthShell>
  );
}

function Unavailable({ icon, message, authenticated }: { icon: React.ReactNode; message: string; authenticated: boolean }) {
  return (
    <div className="space-y-5">
      <div className="flex gap-3 text-sm text-zinc-600 dark:text-zinc-400">
        <span className="mt-0.5 text-zinc-400">{icon}</span>
        <p>{message}</p>
      </div>
      <Link
        to={authenticated ? "/" : "/login"}
        className="flex h-11 w-full items-center justify-center rounded-lg bg-brand-600 text-sm font-medium text-white hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600"
      >
        {authenticated ? "Go to Postflare" : "Sign in"}
      </Link>
    </div>
  );
}

function JoinAsCurrentUser({
  token,
  me,
  invite,
  onJoined,
  onLoggedOut,
}: {
  token: string;
  me: MeDTO;
  invite: InvitationLookupDTO;
  onJoined: (workspaceId: string) => void;
  onLoggedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrongEmail = !!invite.email && invite.email.toLowerCase() !== me.user.email.toLowerCase();

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.invitations.accept({ token });
      onJoined(res.workspaceId);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function signOut() {
    await api.auth.logout().catch(() => {});
    onLoggedOut();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <InitialsAvatar name={me.user.name} seed={me.user.id} />
        <div className="min-w-0">
          <p className="truncate font-medium">{me.user.name}</p>
          <p className="truncate text-zinc-500">{me.user.email}</p>
        </div>
      </div>
      {wrongEmail && <FormError tone="amber">This invitation is for {invite.email}. Sign out and accept it with that account.</FormError>}
      {error && <FormError>{error}</FormError>}
      <Button variant="primary" size="lg" className="w-full" icon={<UserPlus className="size-4" />} loading={busy} disabled={wrongEmail} onClick={join}>
        Join as {me.user.name}
      </Button>
      <Button variant="ghost" className="w-full" icon={<LogOut className="size-4" />} onClick={signOut}>
        Not you? Sign out
      </Button>
    </div>
  );
}

function CreateAccountForm({ token, invite, onJoined }: { token: string; invite: InvitationLookupDTO; onJoined: (workspaceId: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invite.email ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setExists(false);
    if (!name.trim()) return setError("Enter your name.");
    if (password.length < 8) return setError("Use at least 8 characters for the password.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    try {
      const res = await api.invitations.accept({ token, name: name.trim(), email: email.trim(), password });
      onJoined(res.workspaceId);
    } catch (err) {
      setExists(err instanceof ApiError && err.status === 409);
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const signIn = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Your name">
        {(id) => <Input id={id} autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />}
      </Field>
      <Field label="Email" help={invite.email ? "This invitation is for this address." : undefined}>
        {(id) => (
          <Input
            id={id}
            type="email"
            autoComplete="email"
            value={email}
            readOnly={!!invite.email}
            disabled={!!invite.email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        )}
      </Field>
      <Field label="Password">
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required />}
      </Field>
      <Field label="Confirm password">
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
      </Field>
      {error && (
        <FormError>
          {error}
          {exists && (
            <>
              {" "}
              <a href={signIn} className="font-medium underline">
                Sign in
              </a>
            </>
          )}
        </FormError>
      )}
      <Button type="submit" variant="primary" size="lg" className="w-full" icon={<Building2 className="size-4" />} loading={busy} disabled={!email || !password}>
        Create account & join
      </Button>
      <p className="text-center text-sm text-zinc-500">
        Already have an account?{" "}
        <a href={signIn} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Sign in
        </a>
      </p>
    </form>
  );
}
