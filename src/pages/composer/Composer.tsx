import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Layers, RotateCcw, Send, Settings2, Sparkles } from "lucide-react";
import { AccountAvatar } from "../../components/ProviderLogo";
import { Markdown } from "../../components/Markdown";
import { SettingsForm, defaultValues, fieldErrors, visibleFields } from "../../components/SettingsForm";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Switch } from "../../components/ui/Form";
import { Kbd, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api, errorMessage, isPlanLimit } from "../../lib/api";
import { useApp } from "../../lib/app";
import { cn, plural, truncate } from "../../lib/format";
import { useMediaLookup } from "../../lib/mediaCache";
import { formatDateTime } from "../../lib/time";
import type { AccountDTO, CreatePostsInput, PostDTO, Provider } from "../../lib/types";
import { invalidate } from "../../lib/useFetch";
import { uploadsInFlight } from "../../lib/useUploader";
import { AccountPicker } from "./AccountPicker";
import { AppPicker } from "./AppPicker";
import type { ComposerOptions } from "./ComposerProvider";
import { ItemEditor } from "./ItemEditor";
import { PlaybookPanel, PlaybookPicker, type PlaybookRef } from "./PlaybookPicker";
import { attributeErrors, checkAccount, effectiveItem, emptyItem, type ComposerState, type Issue, type Item } from "./model";
import { PlatformPreview } from "../../components/posts/PlatformPreview";
import { TikTokSettings } from "./TikTokSettings";
import { SchedulePicker, defaultScheduleTime } from "./SchedulePicker";

type Mode = "schedule" | "now" | "draft";

function stateFromPost(p: PostDTO): ComposerState {
  return {
    selected: [p.accountId],
    base: { content: p.content, media: [...p.media], thread: p.thread.map((t) => ({ content: t.content, media: [...t.media] })) },
    overrides: {},
    settings: { [p.accountId]: { ...p.settings } },
  };
}

export default function Composer({ options, onClose }: { options: ComposerOptions; onClose: () => void }) {
  const { accounts, accountMap, providerMap, tz } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const editing = options.postId ?? null;

  const [state, setState] = useState<ComposerState | null>(() => {
    if (editing) return null;
    if (options.duplicate) return stateFromPost(options.duplicate);
    const selected = (options.accountIds ?? []).filter((id) => accountMap.get(id)?.status !== "disabled");
    return { selected, base: emptyItem(), overrides: {}, settings: {} };
  });
  const [scheduledAt, setScheduledAt] = useState<number>(() => (options.at && options.at > Date.now() ? options.at : defaultScheduleTime()));
  const [original, setOriginal] = useState<PostDTO | null>(null);
  const [tab, setTab] = useState<string>("shared");
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<{ byAccount: Record<string, string[]>; general: string[] } | null>(null);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [playbook, setPlaybook] = useState<PlaybookRef | null>(() =>
    options.playbook ?? (options.duplicate?.playbookId ? { id: options.duplicate.playbookId, version: options.duplicate.playbookVersion ?? 1 } : null),
  );
  const [variant, setVariant] = useState(options.duplicate?.variant ?? "");
  const [appId, setAppId] = useState<string | null>(options.duplicate?.appId ?? null);
  const [autoLink, setAutoLink] = useState<boolean | null>(options.duplicate?.autoLink ?? null);
  const initial = useRef<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load the post when editing.
  useEffect(() => {
    if (!editing) return;
    api.posts
      .get(editing)
      .then((p) => {
        setOriginal(p);
        setState(stateFromPost(p));
        setPlaybook(p.playbookId ? { id: p.playbookId, version: p.playbookVersion ?? 1 } : null);
        setVariant(p.variant ?? "");
        setAppId(p.appId ?? null);
        setAutoLink(p.autoLink ?? null);
        if (p.scheduledAt && p.scheduledAt > Date.now()) setScheduledAt(p.scheduledAt);
      })
      .catch((err) => {
        toast.error(err);
        onClose();
      });
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fill defaults for accounts selected from options/duplicate once providers are known.
  useEffect(() => {
    setState((s) => {
      if (!s) return s;
      let changed = false;
      const settings = { ...s.settings };
      for (const id of s.selected) {
        const p = providerMap.get(accountMap.get(id)?.provider ?? "");
        if (p && !settings[id]) {
          settings[id] = defaultValues(p.settingsFields);
          changed = true;
        }
      }
      return changed ? { ...s, settings } : s;
    });
  }, [providerMap, accountMap, state?.selected]);

  // Dirty tracking ignores settings defaults filled in automatically; explicit setting edits flip `settingsTouched`.
  const snapshot = (s: ComposerState) => JSON.stringify([s.selected, s.base, s.overrides]);
  const [settingsTouched, setSettingsTouched] = useState(false);
  useEffect(() => {
    if (state && !initial.current) initial.current = snapshot(state);
  }, [state]);

  useEffect(() => {
    if (state && !editing) setTimeout(() => textareaRef.current?.focus(), 50);
  }, [!!state]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback((fn: (s: ComposerState) => ComposerState) => {
    setState((s) => (s ? fn(s) : s));
    setServerErrors(null);
  }, []);

  const selectedAccounts = useMemo(
    () => (state?.selected ?? []).map((id) => accountMap.get(id)).filter((a): a is AccountDTO => !!a),
    [state?.selected, accountMap],
  );
  const providerOf = useCallback((a: AccountDTO) => providerMap.get(a.provider), [providerMap]);

  const allMediaIds = useMemo(() => {
    if (!state) return [];
    const items = [state.base, ...Object.values(state.overrides)];
    return items.flatMap((i) => [...i.media, ...i.thread.flatMap((t) => t.media)]);
  }, [state]);
  const lookup = useMediaLookup(allMediaIds);

  const issues = useMemo(() => {
    const out: Record<string, Issue[]> = {};
    if (!state) return out;
    for (const a of selectedAccounts) {
      const p = providerOf(a);
      const list = checkAccount(a, p, effectiveItem(state, a.id, p), state.settings[a.id] ?? {}, lookup);
      for (const e of serverErrors?.byAccount[a.id] ?? []) if (!list.some((x) => x.message === e)) list.push({ level: "error", message: e });
      out[a.id] = list;
    }
    return out;
  }, [state, selectedAccounts, providerOf, lookup, serverErrors]);

  // Cmd/Ctrl+Enter schedules from anywhere in the composer.
  const submitRef = useRef<(m: Mode) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !document.querySelector('[role="dialog"] [role="dialog"]')) {
        e.preventDefault();
        submitRef.current("schedule");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const errorCount = Object.values(issues).reduce((n, l) => n + l.filter((i) => i.level === "error").length, 0);

  if (!state) {
    return (
      <Dialog open onClose={onClose} size="full" title="Edit post">
        <div className="space-y-4 p-6">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Dialog>
    );
  }

  const selectAccounts = (list: AccountDTO[], on: boolean) => {
    const ids = new Set(list.map((a) => a.id));
    if (!on && ids.has(tab)) setTab("shared");
    update((s) => {
      if (!on) return { ...s, selected: s.selected.filter((x) => !ids.has(x)) };
      const settings = { ...s.settings };
      for (const a of list) {
        const p = providerOf(a);
        if (!settings[a.id] && p) settings[a.id] = defaultValues(p.settingsFields);
      }
      return { ...s, selected: [...s.selected, ...list.map((a) => a.id).filter((id) => !s.selected.includes(id))], settings };
    });
  };

  const toggleAccount = (a: AccountDTO) => {
    if (state.selected.includes(a.id) && tab === a.id) setTab("shared");
    update((s) => {
      const on = s.selected.includes(a.id);
      const p = providerOf(a);
      return {
        ...s,
        selected: on ? s.selected.filter((x) => x !== a.id) : [...s.selected, a.id],
        settings: !on && !s.settings[a.id] && p ? { ...s.settings, [a.id]: defaultValues(p.settingsFields) } : s.settings,
      };
    });
  };

  const setSetting = (accountId: string, key: string, value: unknown) => {
    setSettingsTouched(true);
    update((s) => ({ ...s, settings: { ...s.settings, [accountId]: { ...s.settings[accountId], [key]: value } } }));
  };

  const sharedAccounts = selectedAccounts.filter((a) => !state.overrides[a.id]);
  const providersFor = (list: AccountDTO[]) => {
    const seen = new Map<string, Provider>();
    for (const a of list) {
      const p = providerOf(a);
      if (p) seen.set(p.id, p);
    }
    return [...seen.values()];
  };
  const threadLabelFor = (list: Provider[]) => {
    const t = list.filter((p) => p.capabilities.thread);
    if (!t.length) return null;
    const labels = new Set(t.map((p) => p.capabilities.threadLabel ?? "Follow-ups"));
    return labels.size === 1 ? [...labels][0] : "Follow-ups";
  };

  const playbookChanged = editing ? (playbook?.id ?? null) !== (original?.playbookId ?? null) || variant !== (original?.variant ?? "") : false;
  const appChanged = editing ? appId !== (original?.appId ?? null) || autoLink !== (original?.autoLink ?? null) : !!appId;
  const dirty = settingsTouched || playbookChanged || appChanged || snapshot(state) !== initial.current;
  const requestClose = async () => {
    if (dirty && !(await confirm({ title: "Discard changes?", message: "Your post has not been saved.", confirmLabel: "Discard", danger: true }))) return;
    onClose();
  };

  function buildPosts(): CreatePostsInput["posts"] {
    return selectedAccounts.map((a) => {
      const p = providerOf(a);
      const item = effectiveItem(state!, a.id, p);
      const raw = state!.settings[a.id] ?? {};
      const keys = new Set(visibleFields(p?.settingsFields ?? [], raw).map((f) => f.key));
      const settings = Object.fromEntries(Object.entries(raw).filter(([k, v]) => keys.has(k) && v !== undefined && v !== ""));
      return { accountId: a.id, content: item.content, media: item.media, settings, thread: item.thread };
    });
  }

  async function submit(mode: Mode) {
    if (!selectedAccounts.length) {
      toast.error("Select at least one account");
      return;
    }
    if (uploadsInFlight() > 0) {
      toast.info("Uploads still in progress", "Wait for them to finish before saving.");
      return;
    }
    const at: CreatePostsInput["scheduledAt"] = mode === "now" ? "now" : mode === "draft" ? null : scheduledAt;
    const posts = buildPosts();
    if (mode !== "draft" && errorCount > 0) {
      setShowErrors(true);
      const first = selectedAccounts.find((a) => issues[a.id]?.some((i) => i.level === "error"));
      if (first && (state!.overrides[first.id] || fieldErrorsFor(first))) setTab(first.id);
      toast.error(`Fix ${plural(errorCount, "issue")} before ${mode === "now" ? "publishing" : "scheduling"}`);
      return;
    }
    setBusy(mode);
    try {
      if (mode !== "draft") {
        const { errors } = await api.posts.validate({ scheduledAt: at, posts });
        if (errors.length) {
          setServerErrors(attributeErrors(errors, selectedAccounts));
          setShowErrors(true);
          toast.error("The server rejected the post", errors.slice(0, 3).join("\n"));
          return;
        }
      }
      const attribution = { playbookId: playbook?.id ?? null, playbookVersion: playbook?.version ?? null, variant: playbook && variant.trim() ? variant.trim() : null };
      if (editing) {
        const p = posts[0];
        // Attribution only when it changed (an archived playbook stays on the post).
        const changed = playbookChanged || (playbook?.version ?? null) !== (original?.playbookVersion ?? null);
        await api.posts.update(editing, {
          content: p.content,
          media: p.media,
          settings: p.settings,
          thread: p.thread,
          scheduledAt: at,
          ...(changed ? attribution : {}),
          ...(appChanged ? { appId, autoLink } : {}),
        });
      } else {
        await api.posts.create({ scheduledAt: at, posts, ...(playbook ? attribution : {}), ...(appId ? { appId, autoLink } : {}) });
      }
      const n = posts.length;
      toast.success(
        mode === "draft"
          ? editing
            ? "Draft saved"
            : `${plural(n, "draft")} saved`
          : mode === "now"
            ? `Publishing ${plural(n, "post")} now`
            : `${editing ? "Rescheduled" : `Scheduled ${plural(n, "post")}`} for ${formatDateTime(scheduledAt, tz, { weekday: "short" })}`,
      );
      invalidate("posts");
      onClose();
    } catch (err) {
      const e = err as { errors?: string[] };
      if (e.errors?.length) setServerErrors(attributeErrors(e.errors, selectedAccounts));
      if (!isPlanLimit(err)) toast.error(errorMessage(err)); // plan limits: PlanLimitDialog
    } finally {
      setBusy(null);
    }
  }

  submitRef.current = (m) => void submit(m);

  function fieldErrorsFor(a: AccountDTO): boolean {
    const p = providerOf(a);
    return !!p && Object.keys(fieldErrors(p.settingsFields, state!.settings[a.id] ?? {})).length > 0;
  }

  const activeAccount = tab !== "shared" ? accountMap.get(tab) : undefined;
  const previewAccount =
    activeAccount ?? selectedAccounts.find((a) => a.id === previewId) ?? sharedAccounts[0] ?? selectedAccounts[0];

  const title = editing
    ? `Edit ${original?.status === "draft" ? "draft" : "post"}`
    : options.duplicate
      ? "Duplicate post"
      : "Create post";

  return (
    <Dialog
      open
      onClose={requestClose}
      size="full"
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand-500" />
          {title}
        </span>
      }
      description={editing && original ? `${accountMap.get(original.accountId)?.name ?? ""} · ${original.status}` : undefined}
      footer={
        <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <SchedulePicker value={scheduledAt} onChange={setScheduledAt} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => submit("draft")} loading={busy === "draft"} disabled={!!busy && busy !== "draft"}>
              Save draft
            </Button>
            <Button onClick={() => submit("now")} loading={busy === "now"} disabled={!!busy && busy !== "now"} icon={<Send className="size-4" />}>
              Post now
            </Button>
            <Button variant="primary" onClick={() => submit("schedule")} loading={busy === "schedule"} disabled={!!busy && busy !== "schedule"}>
              {editing && original?.status === "scheduled" ? "Update schedule" : "Schedule"}
              <span className="hidden rounded bg-white/20 px-1 text-[10px] sm:inline">⌘↵</span>
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid min-h-full lg:h-full lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* Editor column */}
        <div className="min-w-0 space-y-5 p-5 lg:overflow-y-auto lg:p-6">
          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{editing ? "Account" : "Post to"}</h3>
              {!editing && accounts.length > 0 && (
                <span className="text-xs text-zinc-400">{selectedAccounts.length ? `${selectedAccounts.length} selected` : "Select one or more accounts"}</span>
              )}
            </div>
            <AccountPicker selected={state.selected} onToggle={toggleAccount} onSelectMany={selectAccounts} locked={!!editing} onNavigate={onClose} />
          </section>

          <PlaybookPicker value={playbook} variant={variant} onChange={setPlaybook} onVariant={setVariant} onNavigate={onClose} />

          <AppPicker appId={appId} autoLink={autoLink} onApp={setAppId} onAutoLink={setAutoLink} accounts={selectedAccounts} providerOf={providerOf} />

          {selectedAccounts.length > 0 && !editing && (
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Content per account">
              <TabButton active={tab === "shared"} onClick={() => setTab("shared")}>
                <Layers className="size-4" />
                All accounts
                {sharedAccounts.length !== selectedAccounts.length && <span className="text-xs text-zinc-400">{sharedAccounts.length}</span>}
              </TabButton>
              {selectedAccounts.map((a) => {
                const errs = (issues[a.id] ?? []).filter((i) => i.level === "error").length;
                return (
                  <TabButton key={a.id} active={tab === a.id} onClick={() => setTab(a.id)}>
                    <AccountAvatar account={a} provider={providerOf(a)} size="sm" className="!size-5" showProvider={false} />
                    <span className="max-w-32 truncate">{a.name}</span>
                    {state.overrides[a.id] && <span className="rounded bg-brand-100 px-1 text-[10px] font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300">Custom</span>}
                    {showErrors && errs > 0 && <span className="size-2 rounded-full bg-red-500" aria-label={`${errs} errors`} />}
                  </TabButton>
                );
              })}
            </div>
          )}

          {tab === "shared" || editing || !activeAccount ? (
            <>
              <ItemEditor
                item={state.base}
                onChange={(fn) => update((s) => ({ ...s, base: fn(s.base) }))}
                providers={providersFor(editing ? selectedAccounts : sharedAccounts.length ? sharedAccounts : selectedAccounts)}
                threadLabel={threadLabelFor(providersFor(editing ? selectedAccounts : sharedAccounts))}
                textareaRef={textareaRef}
              />
              {selectedAccounts.length > 0 && sharedAccounts.length < selectedAccounts.length && !editing && (
                <p className="text-xs text-zinc-500">
                  {plural(selectedAccounts.length - sharedAccounts.length, "account")} use customized content and are not affected by edits here.
                </p>
              )}
              <SettingsSections
                accounts={selectedAccounts}
                providerOf={providerOf}
                settings={state.settings}
                setSetting={setSetting}
                showErrors={showErrors}
                mediaOf={(a) => effectiveItem(state, a.id, providerOf(a)).media}
              />
            </>
          ) : (
            <AccountTab
              account={activeAccount}
              provider={providerOf(activeAccount)}
              state={state}
              update={update}
              setSetting={setSetting}
              showErrors={showErrors}
            />
          )}
        </div>

        {/* Preview + checks column */}
        <aside className="min-w-0 space-y-5 border-t border-zinc-200 bg-zinc-50/70 p-5 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:p-6 dark:border-zinc-800 dark:bg-zinc-950/40">
          {playbook && (
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Playbook</h3>
              <PlaybookPanel key={`${playbook.id}@${playbook.version}`} value={playbook} />
            </section>
          )}
          <section>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Preview</h3>
              {!activeAccount && selectedAccounts.length > 1 && (
                <div className="flex gap-1">
                  {selectedAccounts.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setPreviewId(a.id)}
                      className={cn("rounded-full ring-2 transition", previewAccount?.id === a.id ? "ring-brand-500" : "ring-transparent opacity-60 hover:opacity-100")}
                      title={a.name}
                    >
                      <AccountAvatar account={a} provider={providerOf(a)} size="sm" showProvider={false} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            {previewAccount && providerOf(previewAccount) ? (
              <PlatformPreview
                key={previewAccount.id}
                account={previewAccount}
                provider={providerOf(previewAccount)!}
                post={{ ...effectiveItem(state, previewAccount.id, providerOf(previewAccount)), settings: state.settings[previewAccount.id] ?? {} }}
                time={formatDateTime(scheduledAt, tz)}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-400 dark:border-zinc-700">
                Select an account to see a preview
              </div>
            )}
          </section>

          {selectedAccounts.length > 0 && (
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Checks</h3>
              <ul className="space-y-2">
                {selectedAccounts.map((a) => {
                  const list = issues[a.id] ?? [];
                  const hasErr = list.some((i) => i.level === "error");
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => !editing && setTab(a.id)}
                        className="flex w-full items-start gap-2.5 rounded-lg bg-white p-2.5 text-left ring-1 ring-zinc-200 transition hover:ring-zinc-300 dark:bg-zinc-900 dark:ring-zinc-800 dark:hover:ring-zinc-700"
                      >
                        <AccountAvatar account={a} provider={providerOf(a)} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-sm font-medium">
                            <span className="truncate">{a.name}</span>
                            {!list.length && <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />}
                          </div>
                          {list.length ? (
                            <ul className="mt-1 space-y-0.5">
                              {list.map((i, k) => (
                                <li
                                  key={k}
                                  className={cn(
                                    "flex gap-1.5 text-xs",
                                    i.level === "error" ? (showErrors || hasErr ? "text-red-600 dark:text-red-400" : "text-zinc-500") : "text-amber-600 dark:text-amber-400",
                                  )}
                                >
                                  {i.level === "error" ? <AlertCircle className="mt-px size-3.5 shrink-0" /> : <AlertTriangle className="mt-px size-3.5 shrink-0" />}
                                  {i.message}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-xs text-zinc-500">Ready to go</p>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {serverErrors?.general.length ? (
                <div className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">
                  {serverErrors.general.map((e, i) => (
                    <p key={i}>{e}</p>
                  ))}
                </div>
              ) : null}
            </section>
          )}
          <p className="hidden text-xs text-zinc-400 lg:block">
            Tip: paste or drop images straight into the editor. <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> schedules.
          </p>
        </aside>
      </div>
    </Dialog>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition",
        active
          ? "bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900"
          : "text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-100 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:bg-zinc-800",
      )}
    >
      {children}
    </button>
  );
}

function SettingsSections({
  accounts,
  providerOf,
  settings,
  setSetting,
  showErrors,
  mediaOf,
}: {
  accounts: AccountDTO[];
  providerOf: (a: AccountDTO) => Provider | undefined;
  settings: Record<string, Record<string, unknown>>;
  setSetting: (accountId: string, key: string, value: unknown) => void;
  showErrors: boolean;
  mediaOf: (a: AccountDTO) => string[];
}) {
  const withFields = accounts.filter((a) => (providerOf(a)?.settingsFields.length ?? 0) > 0);
  if (!withFields.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        <Settings2 className="size-3.5" /> Platform settings
      </h3>
      {withFields.map((a) => (
        <SettingsSection key={a.id} account={a} provider={providerOf(a)!} values={settings[a.id] ?? {}} onChange={(k, v) => setSetting(a.id, k, v)} showErrors={showErrors} media={mediaOf(a)} />
      ))}
    </section>
  );
}

function SettingsSection({
  account,
  provider,
  values,
  onChange,
  showErrors,
  media,
}: {
  account: AccountDTO;
  provider: Provider;
  values: Record<string, unknown>;
  onChange: (k: string, v: unknown) => void;
  showErrors: boolean;
  media: string[];
}) {
  const errors = fieldErrors(provider.settingsFields, values);
  const missing = Object.keys(errors).length;
  const [open, setOpen] = useState(missing > 0);
  useEffect(() => {
    if (showErrors && missing) setOpen(true);
  }, [showErrors, missing]);
  return (
    <div className="rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={open}>
        <AccountAvatar account={account} provider={provider} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{account.name}</span>
          <span className="block text-xs text-zinc-500">{provider.name} settings</span>
        </span>
        {missing > 0 && (
          <span className={cn("text-xs font-medium", showErrors ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")}>
            {plural(missing, "field")} required
          </span>
        )}
        <ChevronDown className={cn("size-4 text-zinc-400 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-zinc-100 p-4 dark:border-zinc-800">
          {isTikTok(provider) ? (
            <TikTokSettings account={account} provider={provider} values={values} onChange={onChange} errors={errors} showErrors={showErrors} media={media} />
          ) : (
            <>
              <SettingsForm fields={provider.settingsFields} values={values} onChange={onChange} accountId={account.id} errors={errors} showErrors={showErrors} />
              {provider.composerNotice && <ComposerNotice text={provider.composerNotice} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AccountTab({
  account,
  provider,
  state,
  update,
  setSetting,
  showErrors,
}: {
  account: AccountDTO;
  provider: Provider | undefined;
  state: ComposerState;
  update: (fn: (s: ComposerState) => ComposerState) => void;
  setSetting: (accountId: string, key: string, value: unknown) => void;
  showErrors: boolean;
}) {
  const override = state.overrides[account.id];
  const setOverride = (item: Item | undefined) =>
    update((s) => {
      const overrides = { ...s.overrides };
      if (item) overrides[account.id] = item;
      else delete overrides[account.id];
      return { ...s, overrides };
    });
  const values = state.settings[account.id] ?? {};
  const errors = provider ? fieldErrors(provider.settingsFields, values) : {};
  const cap = provider?.capabilities;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-zinc-100/70 px-4 py-3 dark:bg-zinc-800/40">
        <label className="flex cursor-pointer items-center gap-3">
          <Switch
            checked={!!override}
            onChange={(v) =>
              setOverride(v ? { ...state.base, media: [...state.base.media], thread: state.base.thread.map((t) => ({ ...t, media: [...t.media] })) } : undefined)
            }
            label="Customize content"
          />
          <span>
            <span className="block text-sm font-medium">Customize content for {account.name}</span>
            <span className="block text-xs text-zinc-500">{override ? "This account uses its own text and media." : "Uses the shared content from “All accounts”."}</span>
          </span>
        </label>
        {override && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setOverride(undefined)}>
            Reset to shared
          </Button>
        )}
      </div>

      {override ? (
        <ItemEditor
          item={override}
          onChange={(fn) => update((s) => ({ ...s, overrides: { ...s.overrides, [account.id]: fn(s.overrides[account.id] ?? s.base) } }))}
          providers={provider ? [provider] : []}
          threadLabel={cap?.thread ? (cap.threadLabel ?? "Follow-ups") : null}
          placeholder={`What do you want to share on ${provider?.name ?? "this account"}?`}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
          {state.base.content ? truncate(state.base.content, 280) : <span className="italic">No shared text yet.</span>}
          {state.base.media.length > 0 && <span className="ml-2 text-xs">+ {plural(state.base.media.length, "attachment")}</span>}
        </div>
      )}

      {cap && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
          <span>Up to {cap.maxLength.toLocaleString()} characters</span>
          <span>{cap.media.images ? `${cap.media.images} image${cap.media.images > 1 ? "s" : ""}` : "No images"}</span>
          <span>{cap.media.videos ? `${cap.media.videos} video${cap.media.videos > 1 ? "s" : ""}` : "No videos"}</span>
          {cap.media.required && <span className="font-medium text-amber-600 dark:text-amber-400">Media required</span>}
          {cap.text === "required" && <span>Text required</span>}
          {cap.thread && <span>{cap.threadLabel ?? "Follow-ups"} supported</span>}
          {cap.mediaNote && !override && <span className="basis-full">{cap.mediaNote}</span>}
        </div>
      )}

      {provider && provider.settingsFields.length > 0 && (
        <section className="rounded-xl bg-white p-4 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <h3 className="mb-4 flex items-center gap-1.5 text-sm font-semibold">
            <Settings2 className="size-4 text-zinc-400" /> {provider.name} settings
          </h3>
          {isTikTok(provider) ? (
            <TikTokSettings
              account={account}
              provider={provider}
              values={values}
              onChange={(k, v) => setSetting(account.id, k, v)}
              errors={errors}
              showErrors={showErrors}
              media={effectiveItem(state, account.id, provider).media}
            />
          ) : (
            <>
              <SettingsForm
                fields={provider.settingsFields}
                values={values}
                onChange={(k, v) => setSetting(account.id, k, v)}
                accountId={account.id}
                errors={errors}
                showErrors={showErrors}
              />
              {provider.composerNotice && <ComposerNotice text={provider.composerNotice} />}
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** TikTok accounts get the creator_info-driven settings (TikTok content sharing guidelines). */
const isTikTok = (p: Provider) => p.id === "tiktok" || p.id === "tiktok_business";

function ComposerNotice({ text }: { text: string }) {
  return (
    <div className="mt-4 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700">
      <div className="[&_div]:text-xs [&_div]:text-zinc-600 dark:[&_div]:text-zinc-400"><Markdown source={text} /></div>
    </div>
  );
}
