import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import {
  AlertTriangle,
  BarChart3,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  Folder,
  FolderInput,
  FolderPlus,
  Layers,
  LayoutGrid,
  Link2,
  List,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { BioLinkDialog } from "../components/campaigns/bits";
import { providerDisplayName } from "@shared/providerNames";
import { MetricsStatusBadge } from "../components/analytics/bits";
import { GroupBadge, GroupDialog, GroupDot, ManageGroupsDialog, MoveToGroupItems, useMoveToGroup } from "../components/accounts/AccountGroups";
import { ConnectDialog } from "../components/accounts/ConnectDialog";
import { AccountAvatar, ProviderLogo } from "../components/ProviderLogo";
import { ProviderStatusBadge } from "../components/ProviderStatusBadge";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Checkbox, Input } from "../components/ui/Form";
import { Menu } from "../components/ui/Menu";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Tabs } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { ACCOUNTS_VIEWS, buildSections, selectionState, type AccountSection, type AccountsView } from "../lib/accountGroups";
import { api, planLimitError } from "../lib/api";
import { useApp } from "../lib/app";
import { cn, compactNumber, fullNumber } from "../lib/format";
import { useSession } from "../lib/session";
import { formatDate, relativeTime } from "../lib/time";
import type { AccountDTO, AccountGroupDTO, Provider } from "../lib/types";
import { invalidate, useFetch } from "../lib/useFetch";
import { useComposer } from "./composer/ComposerProvider";

const VIEW_TABS: Array<{ value: AccountsView; label: ReactNode }> = [
  { value: "platform", label: <><LayoutGrid className="size-3.5" />Platform</> },
  { value: "group", label: <><Folder className="size-3.5" />Group</> },
  { value: "all", label: <><List className="size-3.5" />All</> },
];

/** localStorage-backed state (per user: the key includes the user id). */
function useStored<T>(key: string, initial: T, parse: (raw: string) => T | undefined): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (parse(raw) ?? initial);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, typeof v === "string" ? v : JSON.stringify(v));
      } catch {
        /* storage full or disabled */
      }
    },
    [key],
  );
  return [value, set];
}

export function AccountsPage() {
  const { accounts, providerMap, groups, groupMap, loading } = useApp();
  const session = useSession();
  const canManage = session.can("accounts.manage");
  const canRead = session.can("posts.read");
  // Bio links (tracked App Store links for profiles) are offered once the workspace has apps.
  const apps = useFetch(canRead ? "apps" : null, api.apps.list, ["campaigns"]);
  const hasApps = !!apps.data?.length;
  const [params, setParams] = useSearchParams();
  const [connect, setConnect] = useState<{ provider: string | null } | null>(null);
  const toast = useToast();
  const handled = useRef(false);

  const uid = session.user.id;
  const [view, setView] = useStored<AccountsView>(`pf:accounts-view:${uid}`, "platform", (r) => (ACCOUNTS_VIEWS.includes(r as AccountsView) ? (r as AccountsView) : undefined));
  const [collapsedList, setCollapsedList] = useStored<string[]>(`pf:accounts-collapsed:${uid}`, [], (r) => {
    const v = JSON.parse(r);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  });
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const [q, setQ] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manageOpen, setManageOpen] = useState(false);
  const [newGroupFor, setNewGroupFor] = useState<string[] | null>(null);
  const move = useMoveToGroup();

  // Return from an OAuth flow.
  useEffect(() => {
    if (handled.current) return;
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    handled.current = true;
    if (connected) {
      const provider = params.get("provider");
      const n = Number(connected);
      toast.success(`${provider ? providerDisplayName(provider, providerMap) : "Account"} connected`, n > 1 ? `${n} accounts added` : undefined);
      invalidate("accounts");
    } else if (error && params.get("planLimit")) {
      // Over the plan's account limit: the upgrade dialog instead of an error toast (next tick: PlanLimitDialog's
      // listener is registered after this page's effects on a fresh load).
      const limit = params.get("planLimit");
      setTimeout(() => planLimitError(402, { error, code: "plan_limit", limit, used: null, max: null, upgradeUrl: "" }), 0);
    } else if (error) {
      toast.error("Connection failed", error);
    }
    setParams({}, { replace: true });
  }, [params, providerMap, setParams, toast]);

  // Forget selected accounts that are gone (removed elsewhere).
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(accounts.map((a) => a.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [accounts]);

  // Fallback names: right after an OAuth redirect the accounts can load before the provider catalog.
  const providerName = useCallback((id: string) => providerDisplayName(id, providerMap), [providerMap]);
  const sections = useMemo(() => buildSections(accounts, view, { groups, providerName, query: q }), [accounts, view, groups, providerName, q]);
  const visible = useMemo(() => sections.flatMap((s) => s.accounts), [sections]);
  const searching = !!q.trim();
  const sectioned = view !== "all";

  const toggleCollapsed = (key: string) => setCollapsedList(collapsed.has(key) ? collapsedList.filter((k) => k !== key) : [...collapsedList, key]);
  const allCollapsed = sectioned && sections.length > 0 && sections.every((s) => collapsed.has(s.key));
  const setAllCollapsed = (on: boolean) => {
    const keys = new Set(sections.map((s) => s.key));
    setCollapsedList(on ? [...new Set([...collapsedList, ...keys])] : collapsedList.filter((k) => !keys.has(k)));
  };

  const toggleSelected = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const moveSelected = async (groupId: string | null) => {
    if (await move([...selected], groupId)) stopSelecting();
  };

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Profiles, pages and channels Postflare can publish to."
        actions={
          canManage && (
            <>
              {accounts.length > 0 && (
                <Button icon={<Folder className="size-4" />} onClick={() => setManageOpen(true)}>
                  Groups
                </Button>
              )}
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setConnect({ provider: null })}>
                Connect account
              </Button>
            </>
          )
        }
      />
      {loading.accounts ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-11 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
              <Skeleton className="mt-5 h-8 w-full" />
            </Card>
          ))}
        </div>
      ) : !accounts.length ? (
        <Card>
          <EmptyState
            icon={<Users />}
            title="No accounts connected"
            description={
              canManage
                ? "Connect X, LinkedIn, Instagram, Bluesky, YouTube, TikTok, Discord and 30 more platforms."
                : "Nobody has connected an account to this workspace yet. Your role cannot connect accounts."
            }
            action={
              canManage && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setConnect({ provider: null })}>
                  Connect your first account
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-full sm:basis-auto sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or @username…" className="pl-9" aria-label="Search accounts" type="search" />
            </div>
            <Tabs tabs={VIEW_TABS} value={view} onChange={setView} />
            <div className="flex-1" />
            {sectioned && sections.length > 1 && !searching && (
              <IconButton label={allCollapsed ? "Expand all" : "Collapse all"} onClick={() => setAllCollapsed(!allCollapsed)}>
                {allCollapsed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
              </IconButton>
            )}
            {canManage && (
              <Button variant={selecting ? "secondary" : "ghost"} icon={<ListChecks className="size-4" />} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
                {selecting ? "Done" : "Select"}
              </Button>
            )}
          </div>

          {selecting && (
            <div className="sticky top-2 z-30 mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-white/95 px-3 py-2 shadow-md ring-1 ring-zinc-200 backdrop-blur dark:bg-zinc-900/95 dark:ring-zinc-700">
              <Checkbox
                aria-label="Select all shown accounts"
                checked={visible.length > 0 && visible.every((a) => selected.has(a.id))}
                indeterminate={selected.size > 0 && !visible.every((a) => selected.has(a.id))}
                onChange={(e) => toggleSelected(visible.map((a) => a.id), e.target.checked)}
              />
              <span className="text-sm font-medium tabular-nums">
                {selected.size ? `${selected.size} selected` : "Select accounts"}
              </span>
              <div className="flex-1" />
              <Menu
                trigger={(props) => (
                  <Button {...props} size="sm" variant="primary" icon={<FolderInput className="size-3.5" />} disabled={!selected.size}>
                    Move to group
                  </Button>
                )}
              >
                {(close) => <MoveToGroupItems close={close} onPick={moveSelected} onNew={() => setNewGroupFor([...selected])} />}
              </Menu>
              <Button size="sm" variant="ghost" onClick={stopSelecting}>
                Cancel
              </Button>
            </div>
          )}

          {view === "group" && !groups.length && !searching && (
            <div className="mb-4 flex flex-col gap-3 rounded-xl border border-dashed border-zinc-300 px-4 py-3 text-sm sm:flex-row sm:items-center dark:border-zinc-700">
              <Folder className="hidden size-5 shrink-0 text-zinc-400 sm:block" />
              <p className="flex-1 text-zinc-600 dark:text-zinc-400">
                Group accounts by brand or project, e.g. one app with its Instagram and YouTube. Each account can be in one group.
              </p>
              {canManage && (
                <Button size="sm" icon={<FolderPlus className="size-3.5" />} onClick={() => setNewGroupFor([])}>
                  New group
                </Button>
              )}
            </div>
          )}

          {!visible.length && (searching || view !== "group") ? (
            <Card>
              <EmptyState icon={<Search />} title="No accounts match" description={`Nothing named or @${q.trim().replace(/^@/, "")}.`} action={<Button onClick={() => setQ("")}>Clear search</Button>} />
            </Card>
          ) : !sectioned ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {sections[0].accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  provider={providerMap.get(a.provider)}
                  group={a.groupId ? groupMap.get(a.groupId) : undefined}
                  onReconnect={() => setConnect({ provider: a.provider })}
                  hasApps={hasApps}
                  selecting={selecting}
                  selected={selected.has(a.id)}
                  onSelect={(on) => toggleSelected([a.id], on)}
                  onNewGroup={() => setNewGroupFor([a.id])}
                />
              ))}
              {canManage && !searching && <ConnectTile onClick={() => setConnect({ provider: null })} />}
            </div>
          ) : (
            <div className="space-y-6">
              {sections.map((s) => {
                const open = searching || !collapsed.has(s.key);
                const state = selectionState(s.accounts, selected);
                return (
                  <section key={s.key} aria-label={s.title}>
                    <div className="mb-3 flex items-center gap-2">
                      {selecting && s.accounts.length > 0 && (
                        <Checkbox
                          aria-label={`Select all in ${s.title}`}
                          checked={state === "all"}
                          indeterminate={state === "some"}
                          onChange={(e) => toggleSelected(s.accounts.map((a) => a.id), e.target.checked)}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(s.key)}
                        aria-expanded={open}
                        disabled={searching}
                        className="group -mx-1.5 flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-zinc-100 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-zinc-800/70"
                      >
                        <ChevronRight className={cn("size-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-90", searching && "opacity-0")} />
                        <SectionIcon section={s} provider={s.provider ? providerMap.get(s.provider) : undefined} />
                        <h2 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{s.title}</h2>
                        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{s.accounts.length}</span>
                      </button>
                      {s.kind === "group" && canManage && s.group && (
                        <IconButton label={`Edit ${s.title}`} size="sm" onClick={() => setManageOpen(true)} className="opacity-70 hover:opacity-100">
                          <Pencil className="size-3.5" />
                        </IconButton>
                      )}
                      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                    </div>
                    {open &&
                      (s.accounts.length ? (
                        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                          {s.accounts.map((a) => (
                            <AccountCard
                              key={a.id}
                              account={a}
                              provider={providerMap.get(a.provider)}
                              group={view === "platform" && a.groupId ? groupMap.get(a.groupId) : undefined}
                              onReconnect={() => setConnect({ provider: a.provider })}
                              hasApps={hasApps}
                              selecting={selecting}
                              selected={selected.has(a.id)}
                              onSelect={(on) => toggleSelected([a.id], on)}
                              onNewGroup={() => setNewGroupFor([a.id])}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-5 text-center text-sm text-zinc-500 dark:border-zinc-800">
                          No accounts in this group yet.{canManage && " Use an account's “Move to group” or Select to add some."}
                        </p>
                      ))}
                  </section>
                );
              })}
              {canManage && !searching && (
                <button
                  onClick={() => setConnect({ provider: null })}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-200 py-4 text-sm font-medium text-zinc-500 transition hover:border-brand-300 hover:bg-brand-50/40 hover:text-brand-700 dark:border-zinc-800 dark:hover:border-brand-800 dark:hover:bg-brand-950/20 dark:hover:text-brand-300"
                >
                  <Plus className="size-4" />
                  Connect another account
                </button>
              )}
            </div>
          )}
        </>
      )}
      <ConnectDialog open={!!connect} onClose={() => setConnect(null)} initialProvider={connect?.provider} />
      <ManageGroupsDialog open={manageOpen} onClose={() => setManageOpen(false)} />
      <GroupDialog
        open={!!newGroupFor}
        onClose={() => setNewGroupFor(null)}
        onSaved={async (g) => {
          const ids = newGroupFor ?? [];
          if (!ids.length) return void toast.success(`${g.name} created`);
          if (await move(ids, g.id, ids.length === 1 ? accounts.find((a) => a.id === ids[0])?.name : undefined)) stopSelecting();
        }}
      />
    </>
  );
}

function SectionIcon({ section, provider }: { section: AccountSection; provider: Provider | undefined }) {
  if (section.kind === "platform") return <ProviderLogo provider={provider} size="sm" />;
  if (section.kind === "group") return <GroupDot color={section.group?.color} className="size-3" />;
  return <Layers className="size-4 shrink-0 text-zinc-400" />;
}

function ConnectTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-200 text-sm font-medium text-zinc-500 transition hover:border-brand-300 hover:bg-brand-50/40 hover:text-brand-700 dark:border-zinc-800 dark:hover:border-brand-800 dark:hover:bg-brand-950/20 dark:hover:text-brand-300"
    >
      <Plus className="size-5" />
      Connect another account
    </button>
  );
}

function AccountCard({
  account: a,
  provider,
  group,
  onReconnect,
  hasApps,
  selecting,
  selected,
  onSelect,
  onNewGroup,
}: {
  account: AccountDTO;
  provider: Provider | undefined;
  /** Shown as a badge (views where the section does not already say it). */
  group?: AccountGroupDTO;
  onReconnect: () => void;
  hasApps?: boolean;
  selecting?: boolean;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onNewGroup: () => void;
}) {
  const move = useMoveToGroup();
  const [bioOpen, setBioOpen] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const composer = useComposer();
  const { tz } = useApp();
  const { can } = useSession();
  const canManage = can("accounts.manage");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
      invalidate("accounts");
    } catch (err) {
      toast.error(err);
      invalidate("accounts");
    } finally {
      setBusy(null);
    }
  };

  const hasAnalytics = !!provider && (provider.analytics.post || provider.analytics.account);
  const followers = a.metricsStatus.metrics?.followers;
  const followerLabel = a.provider === "youtube" || a.provider === "reddit" ? "subscribers" : "followers";
  const refreshStats = async () => {
    setBusy("stats");
    try {
      const res = await api.analytics.refresh({ accountId: a.id });
      const st = res.account?.metricsStatus;
      if (st?.status === "reconnect_required") toast.error("Reconnect to enable analytics", st.message ?? undefined);
      else if (st?.status === "error") toast.error("Could not refresh stats", st.message ?? undefined);
      else toast.success(`${a.name} stats refreshed`, res.account?.postsRefreshed ? `${res.account.postsRefreshed} posts updated` : undefined);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      invalidate("accounts", "analytics");
    }
  };

  const expired = a.expiresAt !== null && a.expiresAt < Date.now();
  const expiringSoon = a.expiresAt !== null && !expired && a.expiresAt < Date.now() + 3 * 864e5;

  return (
    <Card
      className={cn("relative flex flex-col transition-shadow", a.status === "disabled" && !selected && "opacity-70", selected && "ring-2 ring-brand-500 dark:ring-brand-400")}
      onClick={selecting ? (e) => !(e.target as HTMLElement).closest("a,button,input") && onSelect?.(!selected) : undefined}
    >
      <div className={cn("flex items-start gap-3 p-5 pb-4", selecting && "cursor-pointer")}>
        {selecting && (
          <Checkbox aria-label={`Select ${a.name}`} checked={!!selected} onChange={(e) => onSelect?.(e.target.checked)} className="mt-3.5 shrink-0" />
        )}
        <AccountAvatar account={a} provider={provider} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{a.name}</h3>
          </div>
          {a.username && (
            <p className="truncate text-sm text-zinc-500">
              {a.profileUrl ? (
                <a href={a.profileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200">
                  @{a.username.replace(/^@/, "")}
                  <ExternalLink className="size-3" />
                </a>
              ) : (
                `@${a.username.replace(/^@/, "")}`
              )}
            </p>
          )}
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
            <ProviderLogo provider={provider} size="xs" />
            {provider?.name ?? providerDisplayName(a.provider)}
            {provider?.status === "experimental" && <ProviderStatusBadge provider={provider} className="px-1.5 py-0 text-[10px]" />}
          </p>
          {group && <GroupBadge group={group} className="mt-1.5" />}
        </div>
        {a.status === "active" ? (
          <Badge tone="green" dot>
            Active
          </Badge>
        ) : a.status === "disabled" ? (
          <Badge tone="zinc">Disabled</Badge>
        ) : (
          <Badge tone="amber">
            <AlertTriangle className="size-3" /> Reconnect
          </Badge>
        )}
      </div>

      {hasAnalytics && (
        <div className="mx-5 mb-3 flex items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
          {followers !== undefined ? (
            <p className="min-w-0 truncate text-sm" title={`${fullNumber(followers)} ${followerLabel}`}>
              <span className="font-semibold text-zinc-900 dark:text-zinc-50">{compactNumber(followers)}</span>{" "}
              <span className="text-zinc-500 dark:text-zinc-400">{followerLabel}</span>
            </p>
          ) : (
            <p className="text-sm text-zinc-400">No stats yet</p>
          )}
          <MetricsStatusBadge status={a.metricsStatus} />
        </div>
      )}
      {!hasAnalytics && (
        <div className="mx-5 mb-3">
          <MetricsStatusBadge status={a.metricsStatus} />
        </div>
      )}

      <div className="flex-1 space-y-1 px-5 pb-4 text-xs text-zinc-500">
        {a.status === "reconnect" && (
          <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {a.statusMessage || "Access was revoked or expired. Reconnect to keep publishing."}
          </p>
        )}
        {a.status !== "reconnect" && a.statusMessage && <p>{a.statusMessage}</p>}
        {a.metricsStatus.status === "reconnect_required" && a.status !== "reconnect" && (
          <p className="text-amber-700 dark:text-amber-400">
            Reconnect to enable analytics.{" "}
            {canManage && (
              <button type="button" onClick={onReconnect} className="font-medium underline-offset-2 hover:underline">
                Reconnect now
              </button>
            )}
          </p>
        )}
        {a.metricsStatus.status === "error" && a.metricsStatus.message && <p className="text-red-600 dark:text-red-400">Analytics: {a.metricsStatus.message}</p>}
        {a.expiresAt !== null && (
          <p className={cn(expired && "text-red-600 dark:text-red-400", expiringSoon && "text-amber-600 dark:text-amber-400")}>
            Token {expired ? "expired" : "expires"} {relativeTime(a.expiresAt)}
            {provider?.auth === "oauth2" && !expired && " · refreshed automatically"}
          </p>
        )}
        <p>
          Connected {formatDate(a.createdAt, tz)}
          {a.reconnectedAt !== null && a.reconnectedAt > a.createdAt && <> · Reconnected {formatDate(a.reconnectedAt, tz)}</>}
        </p>
      </div>

      <div className="flex items-center gap-1 border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
        {a.status === "reconnect" ? (
          canManage && (
            <Button size="sm" variant="primary" icon={<Zap className="size-3.5" />} onClick={onReconnect}>
              Reconnect
            </Button>
          )
        ) : (
          can("posts.write") && (
            <Button size="sm" variant="ghost" disabled={a.status === "disabled"} onClick={() => composer.open({ accountIds: [a.id] })}>
              New post
            </Button>
          )
        )}
        <div className="flex-1" />
        {hasApps && (
          <IconButton label="Bio link (tracked App Store link for the profile)" size="sm" onClick={() => setBioOpen(true)}>
            <Link2 className="size-4" />
          </IconButton>
        )}
        {hasAnalytics && can("posts.write") && a.metricsStatus.status !== "not_supported" && (
          <IconButton label="Refresh stats" size="sm" disabled={!!busy} onClick={refreshStats}>
            {busy === "stats" ? <Loader2 className="size-4 animate-spin" /> : <BarChart3 className="size-4" />}
          </IconButton>
        )}
        {canManage && (
        <>
        <Menu
          trigger={(props) => (
            <IconButton {...props} label="Move to group…" size="sm">
              <FolderInput className="size-4" />
            </IconButton>
          )}
        >
          {(close) => <MoveToGroupItems close={close} current={a.groupId} onPick={(groupId) => void move([a.id], groupId, a.name)} onNew={onNewGroup} />}
        </Menu>
        <IconButton
          label="Check connection & refresh token"
          size="sm"
          disabled={!!busy}
          onClick={() => run("refresh", () => api.accounts.refresh(a.id), `${a.name} is working`)}
        >
          <RefreshCw className={cn("size-4", busy === "refresh" && "animate-spin")} />
        </IconButton>
        {a.status !== "reconnect" && (
          <IconButton label="Reconnect" size="sm" onClick={onReconnect}>
            <Zap className="size-4" />
          </IconButton>
        )}
        <IconButton
          label={a.status === "disabled" ? "Enable" : "Disable"}
          size="sm"
          disabled={!!busy}
          onClick={() =>
            run(
              "status",
              () => api.accounts.setStatus(a.id, a.status === "disabled" ? "active" : "disabled"),
              a.status === "disabled" ? `${a.name} enabled` : `${a.name} disabled`,
            )
          }
        >
          <Power className={cn("size-4", a.status === "disabled" && "text-emerald-600")} />
        </IconButton>
        <IconButton
          label="Remove"
          size="sm"
          variant="danger"
          disabled={!!busy}
          onClick={async () => {
            if (
              await confirm({
                title: `Remove ${a.name}?`,
                message: "All of its posts (scheduled, drafts and history) are deleted from Postflare. Published posts stay on the platform.",
                confirmLabel: "Remove account",
                danger: true,
              })
            )
              await run("remove", () => api.accounts.remove(a.id), `${a.name} removed`).then(() => invalidate("posts"));
          }}
        >
          <Trash2 className="size-4" />
        </IconButton>
        </>
        )}
        {!canManage && <span className="h-8" />}
      </div>
      {bioOpen && <BioLinkDialog account={a} open onClose={() => setBioOpen(false)} />}
    </Card>
  );
}
