import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { Gate, InstanceGate } from "./components/Gate";
import { Layout } from "./components/Layout";
import { Logo } from "./components/Logo";
import { PostDrawerProvider } from "./components/posts/PostDrawer";
import { ConfirmProvider } from "./components/ui/Confirm";
import { ToastProvider } from "./components/ui/Toast";
import { api, UNAUTHORIZED_EVENT } from "./lib/api";
import { AppDataProvider } from "./lib/app";
import { BillingProvider } from "./lib/billing";
import { SessionProvider, useSession } from "./lib/session";
import type { AuthStatus } from "./lib/types";
import { AccountsPage } from "./pages/AccountsPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { BillingAdminPage } from "./pages/admin/BillingPage";
import { OverviewPage } from "./pages/admin/OverviewPage";
import { RolesPage } from "./pages/admin/RolesPage";
import { UsersPage } from "./pages/admin/UsersPage";
import { ApplyPage } from "./pages/ApplyPage";
import { AuthPage } from "./pages/AuthPage";
import { RequestsPage } from "./pages/admin/RequestsPage";
import { SupportPage } from "./pages/admin/SupportPage";
import { CalendarPage } from "./pages/CalendarPage";
import { ComposerProvider } from "./pages/composer/ComposerProvider";
import { DashboardPage } from "./pages/DashboardPage";
import { InvitePage } from "./pages/InvitePage";
import { MagicLinkPage } from "./pages/MagicLinkPage";
import { MediaPage } from "./pages/MediaPage";
import { PlatformsPage } from "./pages/PlatformsPage";
import { PlaybookPage } from "./pages/PlaybookPage";
import { PlaybooksPage } from "./pages/PlaybooksPage";
import { PostsPage } from "./pages/PostsPage";
import { SignupPage } from "./pages/SignupPage";
import { VerifySignupPage } from "./pages/VerifySignupPage";
import { ProfilePage } from "./pages/ProfilePage";
import { InstanceSettingsPage } from "./pages/SettingsPage";
import { WorkspaceSettingsPage } from "./pages/WorkspaceSettingsPage";

/** Same-origin path from `?next=` (used to come back to an invitation after signing in). */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const check = useCallback(() => {
    api.auth
      .status()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    check();
    const onUnauthorized = () => setStatus((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [check]);

  const onLogout = useCallback(
    () =>
      setStatus((s) => ({
        setup: true,
        authenticated: false,
        ...(s?.magicLink ? { magicLink: true as const } : {}),
        ...(s?.signup ? { signup: true as const } : {}),
        ...(s?.signupMode ? { signupMode: s.signupMode } : {}),
        ...(s?.turnstileSiteKey ? { turnstileSiteKey: s.turnstileSiteKey } : {}),
        ...(s?.appLogin ? { appLogin: true as const } : {}),
        ...(s?.pushLogin ? { pushLogin: true as const } : {}),
        ...(s?.appStoreUrl ? { appStoreUrl: s.appStoreUrl } : {}),
      })),
    [],
  );

  return (
    <ToastProvider>
      <ConfirmProvider>
        {error && !status ? (
          <Splash>
            <p className="text-sm text-zinc-500">Cannot reach the server: {error}</p>
            <button className="mt-3 text-sm font-medium text-brand-600" onClick={check}>
              Try again
            </button>
          </Splash>
        ) : !status ? (
          <Splash />
        ) : (
          <Routes>
            {/* Public: works signed out (create an account) and signed in (join as the current user). */}
            <Route path="/invite/:token" element={<InvitePage authenticated={status.setup && status.authenticated} onLoggedOut={onLogout} />} />
            {/* Public: opened from a sign-in link email (signed in too: the link may be for another user). */}
            <Route path="/auth/link" element={<MagicLinkPage />} />
            {/* Public sign-up (hosted mode, off by default): the form, and the email confirmation link. */}
            <Route path="/signup" element={status.setup && !status.authenticated && status.signup ? <SignupPage onDone={() => window.location.assign("/")} turnstileSiteKey={status.turnstileSiteKey} /> : <Navigate to="/" replace />} />
            <Route path="/auth/verify" element={<VerifySignupPage />} />
            {/* "Request access" (signup_mode apply): the application form; the open mode sends people to /signup instead. */}
            <Route
              path="/apply"
              element={
                status.setup && !status.authenticated && status.signupMode === "apply" ? (
                  <ApplyPage turnstileSiteKey={status.turnstileSiteKey} />
                ) : (
                  <Navigate to={status.setup && !status.authenticated && status.signup ? "/signup" : "/"} replace />
                )
              }
            />
            <Route
              path="*"
              element={
                !status.setup || !status.authenticated ? (
                  <AuthPage
                    mode={status.setup ? "login" : "setup"}
                    setupToken={!!status.setupToken}
                    magicLink={!!status.magicLink}
                    signup={!!status.signup}
                    apply={status.signupMode === "apply"}
                    turnstileSiteKey={status.turnstileSiteKey}
                    appLogin={!!status.appLogin}
                    pushLogin={!!status.pushLogin}
                    appStoreUrl={status.appStoreUrl}
                    onDone={() => {
                      const next = nextPath();
                      if (window.location.pathname === "/login" || window.location.pathname === "/setup" || next !== "/") navigate(next, { replace: true });
                      setStatus((s) => ({ ...s, setup: true, authenticated: true }));
                    }}
                  />
                ) : (
                  <SessionProvider
                    onLogout={onLogout}
                    fallback={(err, retry) =>
                      err ? (
                        <Splash>
                          <p className="text-sm text-zinc-500">Could not load your account: {err}</p>
                          <button className="mt-3 text-sm font-medium text-brand-600" onClick={retry}>
                            Try again
                          </button>
                        </Splash>
                      ) : (
                        <Splash />
                      )
                    }
                  >
                    <WorkspaceScope />
                  </SessionProvider>
                )
              }
            />
          </Routes>
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}

/**
 * Everything below is keyed by the current workspace: switching remounts it, which drops every cached
 * request (useFetch state, account/provider lists, open composer or drawer) and refetches for the new workspace.
 */
function WorkspaceScope() {
  const { workspace, logout } = useSession();
  return (
    <AppDataProvider key={workspace?.id ?? "none"}>
      <BillingProvider>
        <ComposerProvider>
          <PostDrawerProvider>
            <Routes>
              <Route element={<Layout onLogout={logout} />}>
                <Route index element={<Gate>{<DashboardPage />}</Gate>} />
                <Route path="calendar" element={<Gate permission="posts.read">{<CalendarPage />}</Gate>} />
                <Route path="posts" element={<Gate permission="posts.read">{<PostsPage />}</Gate>} />
                <Route path="analytics" element={<Gate permission="posts.read">{<AnalyticsPage />}</Gate>} />
                <Route path="playbooks" element={<Gate permission="posts.read">{<PlaybooksPage />}</Gate>} />
                <Route path="playbooks/:id" element={<Gate permission="posts.read">{<PlaybookPage />}</Gate>} />
                <Route path="accounts" element={<Gate permission="accounts.read">{<AccountsPage />}</Gate>} />
                <Route path="media" element={<Gate permission="media.read">{<MediaPage />}</Gate>} />
                <Route path="workspace" element={<Gate>{<WorkspaceSettingsPage />}</Gate>} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="admin" element={<InstanceGate permission="instance.overview.view">{<OverviewPage />}</InstanceGate>} />
                <Route path="admin/users" element={<InstanceGate permission="instance.users.manage">{<UsersPage />}</InstanceGate>} />
                <Route path="admin/requests" element={<InstanceGate permission="instance.users.manage">{<RequestsPage />}</InstanceGate>} />
                <Route path="admin/support" element={<InstanceGate permission="instance.support.manage">{<SupportPage />}</InstanceGate>} />
                <Route path="admin/roles" element={<InstanceGate permission="instance.users.manage">{<RolesPage />}</InstanceGate>} />
                <Route path="admin/settings" element={<InstanceGate permission="instance.settings.manage">{<InstanceSettingsPage />}</InstanceGate>} />
                <Route path="admin/billing" element={<InstanceGate permission="instance.settings.manage">{<BillingAdminPage />}</InstanceGate>} />
                <Route path="platforms" element={<InstanceGate permission="instance.platforms.manage">{<PlatformsPage />}</InstanceGate>} />
                <Route path="platforms/:id" element={<InstanceGate permission="instance.platforms.manage">{<PlatformsPage />}</InstanceGate>} />
                <Route path="settings" element={<SettingsRedirect />} />
                <Route path="login" element={<Navigate to={nextPath()} replace />} />
                <Route path="setup" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </PostDrawerProvider>
        </ComposerProvider>
      </BillingProvider>
    </AppDataProvider>
  );
}

/** Old /settings URL: instance settings for admins, the profile (API keys) for everyone else. */
function SettingsRedirect() {
  const { canInstance } = useSession();
  return <Navigate to={canInstance("instance.settings.manage") ? "/admin/settings" : "/profile"} replace />;
}

export function Splash({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center">
      <Logo className="size-10 animate-pulse" />
      {children && <div className="mt-4 text-center">{children}</div>}
    </div>
  );
}
