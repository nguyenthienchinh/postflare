import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  BarChart3,
  BookOpenText,
  Building2,
  CalendarDays,
  Check,
  ChevronsUpDown,
  CreditCard,
  Gauge,
  Image,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  Menu,
  PenSquare,
  Plug,
  Plus,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Users,
  UsersRound,
  X,
  type LucideIcon,
  LifeBuoy,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { cn } from "../lib/format";
import { needsEmail, useSession } from "../lib/session";
import { useUpdateStatus } from "../lib/updates";
import { useVisiblePoll } from "../lib/poll";
import { useFetch } from "../lib/useFetch";
import type { InstancePermission, WorkspacePermission } from "../lib/types";
import { useComposer } from "../pages/composer/ComposerProvider";
import { BillingBanner } from "./billing/BillingBanner";
import { PlanLimitDialog } from "./billing/PlanLimitDialog";
import { CreateWorkspaceDialog } from "./Gate";
import { Wordmark } from "./Logo";
import { InitialsAvatar } from "./ui/Avatar";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  permission?: WorkspacePermission;
  instance?: InstancePermission;
}

const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/calendar", label: "Calendar", icon: CalendarDays, permission: "posts.read" },
  { to: "/posts", label: "Posts", icon: ListChecks, permission: "posts.read" },
  { to: "/analytics", label: "Analytics", icon: BarChart3, permission: "posts.read" },
  { to: "/playbooks", label: "Playbooks", icon: BookOpenText, permission: "posts.read" },
  { to: "/accounts", label: "Accounts", icon: Users, permission: "accounts.read" },
  { to: "/media", label: "Media", icon: Image, permission: "media.read" },
  { to: "/workspace", label: "Workspace settings", icon: Settings },
];

const ADMIN_NAV: NavItem[] = [
  { to: "/admin", label: "Overview", icon: Gauge, end: true, instance: "instance.overview.view" },
  { to: "/admin/users", label: "Users", icon: UsersRound, instance: "instance.users.manage" },
  { to: "/admin/requests", label: "Requests", icon: Inbox, instance: "instance.users.manage" },
  { to: "/admin/support", label: "Support", icon: LifeBuoy, instance: "instance.support.manage" },
  { to: "/admin/roles", label: "Roles", icon: Shield, instance: "instance.users.manage" },
  { to: "/admin/settings", label: "Instance settings", icon: SlidersHorizontal, instance: "instance.settings.manage" },
  { to: "/admin/billing", label: "Billing", icon: CreditCard, instance: "instance.settings.manage" },
  { to: "/platforms", label: "Platforms", icon: Plug, instance: "instance.platforms.manage" },
];

export function Layout({ onLogout }: { onLogout: () => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const composer = useComposer();
  const { can, user } = useSession();
  const canWrite = can("posts.write");

  useEffect(() => setMobileOpen(false), [location.pathname]);

  // "n" opens the composer from anywhere (outside of inputs).
  useEffect(() => {
    if (!canWrite) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "n" || e.key === "c") {
        e.preventDefault();
        composer.open({});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composer, canWrite]);

  const sidebar = <Sidebar onCompose={canWrite ? () => composer.open({}) : undefined} onLogout={onLogout} />;
  const demo = !!user.demo;

  return (
    // --banner: height of the live-demo bar above everything (0 otherwise).
    <div className="min-h-screen" style={{ "--banner": demo ? "2.5rem" : "0px" } as React.CSSProperties}>
      {demo && <DemoBanner />}
      <aside className="fixed bottom-0 left-0 top-[var(--banner)] z-30 hidden w-64 border-r border-zinc-200 bg-white lg:block dark:border-zinc-800 dark:bg-zinc-900/60">
        {sidebar}
      </aside>

      <header className="sticky top-[var(--banner)] z-20 flex h-14 items-center justify-between border-b border-zinc-200 bg-white/90 px-4 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-900/90">
        <button
          onClick={() => setMobileOpen(true)}
          className="-ml-2 rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </button>
        <Wordmark />
        {canWrite ? (
          <button
            onClick={() => composer.open({})}
            className="-mr-2 rounded-lg p-2 text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/40"
            aria-label="New post"
          >
            <PenSquare className="size-5" />
          </button>
        ) : (
          <span className="size-9" />
        )}
      </header>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-zinc-950/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl dark:bg-zinc-900">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4 z-10 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Close menu"
            >
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <main className="pt-[var(--banner)] lg:pl-64">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {needsEmail(user) && location.pathname !== "/profile" && (
            <Link
              to="/profile"
              className="mb-6 flex items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 transition hover:bg-amber-100/70 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900 dark:hover:bg-amber-950/60"
            >
              <Mail className="size-5 shrink-0 text-amber-500" />
              <span className="flex-1">
                <strong className="font-semibold">Set your email address.</strong> You sign in with it; <code className="font-mono text-xs">{user.email}</code> is a placeholder.
              </span>
              <ArrowRight className="size-4 shrink-0" />
            </Link>
          )}
          <BillingBanner />
          <Outlet />
        </div>
      </main>
      <PlanLimitDialog />
    </div>
  );
}

/** Slim bar on top of every page of a live-demo session. */
function DemoBanner() {
  return (
    <div className="fixed inset-x-0 top-0 z-40 flex h-10 items-center gap-3 bg-gradient-to-r from-brand-500 to-rose-600 px-3 text-[13px] text-white shadow-sm sm:px-4">
      <Sparkles className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 truncate">
        <strong className="font-semibold">You&rsquo;re exploring a live demo.</strong>
        <span className="hidden md:inline"> Nothing is published to real accounts. Data resets daily.</span>
        <span className="md:hidden"> Nothing is really published.</span>
      </p>
      <span
        className="hidden shrink-0 items-center gap-1.5 rounded-full bg-white/15 py-0.5 pl-2.5 pr-1 text-xs font-medium sm:inline-flex"
        title="Hosted Postflare accounts are coming soon"
      >
        Sign up
        <span className="rounded-full bg-white px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-rose-600">Coming soon</span>
      </span>
      <a href="/landing/" className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold hover:bg-white/15">
        Back to site <ArrowRight className="size-3.5" />
      </a>
    </div>
  );
}

function NavItemLink({ item, badge }: { item: NavItem; badge?: React.ReactNode }) {
  const { to, label, icon: Icon, end } = item;
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white"
            : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={cn("size-[18px]", isActive ? "text-brand-600 dark:text-brand-400" : "text-zinc-400 dark:text-zinc-500")} />
          <span className="flex-1">{label}</span>
          {badge}
        </>
      )}
    </NavLink>
  );
}

function Sidebar({ onCompose, onLogout }: { onCompose?: () => void; onLogout: () => void }) {
  const { accounts } = useApp();
  const { workspace, can, canInstance, user } = useSession();
  const reconnect = accounts.filter((a) => a.status === "reconnect").length;
  const nav = workspace ? NAV.filter((n) => !n.permission || can(n.permission)) : [];
  const admin = ADMIN_NAV.filter((n) => n.instance && canInstance(n.instance));
  const { data: update } = useUpdateStatus();
  // Admin → Requests badge: access requests waiting for a review.
  const requests = useFetch(canInstance("instance.users.manage") ? "access-requests:count" : null, api.accessRequests.count, ["requests"]);
  const pending = requests.data?.pending ?? 0;
  // Admin → Support badge: chats with unread customer messages (rechecked every minute while the tab is visible).
  const support = useFetch(canInstance("instance.support.manage") ? "support:count" : null, api.support.count, ["support"]);
  useVisiblePoll(() => support.refetch(), 60_000, canInstance("instance.support.manage"));
  const unreadSupport = support.data?.unread ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-5">
        <Wordmark />
      </div>
      <div className="px-3 pb-2">
        <WorkspaceSwitcher />
      </div>
      {onCompose && (
        <div className="px-3 pb-2 pt-1">
          <button
            onClick={onCompose}
            className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-rose-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 transition hover:brightness-110 active:brightness-95"
          >
            <PenSquare className="size-4" />
            New post
            <span className="ml-1 rounded bg-white/20 px-1.5 text-[10px] font-medium">N</span>
          </button>
        </div>
      )}
      <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {nav.map((item) => (
          <NavItemLink
            key={item.to}
            item={item}
            badge={
              item.to === "/accounts" &&
              reconnect > 0 && (
                <span title={`${reconnect} need reconnecting`} className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3.5" />
                  {reconnect}
                </span>
              )
            }
          />
        ))}
        {admin.length > 0 && (
          <>
            <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Admin</p>
            {admin.map((item) => (
              <NavItemLink
                key={item.to}
                item={item}
                badge={
                  item.to === "/admin/settings" && update?.updateAvailable ? (
                    <span className="size-2 rounded-full bg-brand-500" title={`Postflare v${update.latest} is available`} />
                  ) : item.to === "/admin/support" && unreadSupport > 0 ? (
                    <span title={`${unreadSupport} unread`} className="min-w-5 rounded-full bg-brand-500 px-1.5 text-center text-[11px] font-semibold leading-5 text-white">
                      {unreadSupport > 99 ? "99+" : unreadSupport}
                    </span>
                  ) : item.to === "/admin/requests" && pending > 0 ? (
                    <span title={`${pending} waiting for review`} className="min-w-5 rounded-full bg-brand-500 px-1.5 text-center text-[11px] font-semibold leading-5 text-white">
                      {pending > 99 ? "99+" : pending}
                    </span>
                  ) : null
                }
              />
            ))}
          </>
        )}
      </nav>
      {update && (
        // Instance admins: running version, and a nudge when a newer release exists.
        <div className="px-3 pb-2">
          {update.updateAvailable ? (
            <Link
              to="/admin/settings#updating"
              className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-xs font-medium text-brand-800 ring-1 ring-brand-200 transition hover:bg-brand-100 dark:bg-brand-950/40 dark:text-brand-200 dark:ring-brand-900 dark:hover:bg-brand-950/70"
            >
              <ArrowUpCircle className="size-4 shrink-0" />
              <span className="flex-1">Update available: v{update.latest}</span>
            </Link>
          ) : (
            <Link to="/admin/settings#about" className="block px-3 text-[11px] text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300">
              Postflare v{update.current}
            </Link>
          )}
        </div>
      )}
      <div className="flex items-center gap-1 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <NavLink
          to="/profile"
          className={({ isActive }) =>
            cn(
              "flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 transition-colors",
              isActive ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
            )
          }
        >
          <InitialsAvatar name={user.name} seed={user.id} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{user.name}</span>
            <span className="block truncate text-xs text-zinc-500">{user.demo ? "Live demo" : needsEmail(user) ? "Profile" : user.email}</span>
          </span>
          {needsEmail(user) && <span className="size-2 shrink-0 rounded-full bg-amber-500" title="Set your email address" />}
        </NavLink>
        <button
          onClick={onLogout}
          title="Log out"
          aria-label="Log out"
          className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <LogOut className="size-[18px]" />
        </button>
      </div>
    </div>
  );
}

function WorkspaceSwitcher() {
  const { workspace, workspaces, switchWorkspace, canInstance } = useSession();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const members = workspaces.filter((w) => !w.viaAdmin);
  const viaAdmin = workspaces.filter((w) => w.viaAdmin);
  const canCreate = canInstance("instance.workspaces.create");

  const item = (w: (typeof workspaces)[number]) => (
    <button
      key={w.id}
      role="menuitemradio"
      aria-checked={w.id === workspace?.id}
      onClick={() => {
        setOpen(false);
        if (w.id !== workspace?.id) {
          switchWorkspace(w.id);
          navigate("/");
        }
      }}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      <InitialsAvatar name={w.name} seed={w.id} size="xs" square className="!rounded-md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{w.name}</span>
        <span className="block truncate text-xs text-zinc-500">{w.viaAdmin ? "Admin access" : w.role.name}</span>
      </span>
      {w.id === workspace?.id && <Check className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />}
    </button>
  );

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:ring-zinc-800 dark:hover:bg-zinc-800/60"
      >
        {workspace ? (
          <InitialsAvatar name={workspace.name} seed={workspace.id} size="sm" square />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
            <Building2 className="size-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{workspace?.name ?? "No workspace"}</span>
          <span className="block truncate text-xs text-zinc-500">{workspace ? (workspace.viaAdmin ? "Admin access" : workspace.role.name) : "Not a member yet"}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-zinc-400" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-[70vh] animate-pop overflow-y-auto rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700"
        >
          {members.length > 0 && <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Your workspaces</p>}
          {members.map(item)}
          {viaAdmin.length > 0 && (
            <>
              <p className="flex items-center gap-1 px-2 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                <KeyRound className="size-3" /> Other workspaces (admin)
              </p>
              {viaAdmin.map(item)}
            </>
          )}
          {(workspace || canCreate) && <div className="my-1.5 border-t border-zinc-100 dark:border-zinc-800" />}
          {workspace && (
            <Link
              to="/workspace"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Settings className="size-4 text-zinc-400" /> Workspace settings
            </Link>
          )}
          {canCreate && (
            <button
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Plus className="size-4 text-zinc-400" /> Create workspace
            </button>
          )}
        </div>
      )}
      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
