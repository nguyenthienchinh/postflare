import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { ArrowLeft, CheckCircle2, Globe, LifeBuoy, Lock, MessageSquare, RotateCcw, Search, Send, Settings2, StickyNote, Trash2, UserRound } from "lucide-react";
import { InitialsAvatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select, Switch, Textarea } from "../../components/ui/Form";
import { Badge, CodeBlock, EmptyState, PageHeader, Skeleton, Tabs } from "../../components/ui/Misc";
import { Notice } from "../../components/ui/Section";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app";
import { cn } from "../../lib/format";
import { useVisiblePoll } from "../../lib/poll";
import { useSession } from "../../lib/session";
import { formatDateTime, relativeTime } from "../../lib/time";
import type { SupportMessageDTO, SupportStatus, SupportTicketDTO } from "../../lib/types";
import { invalidate, useFetch } from "../../lib/useFetch";

type Filter = SupportStatus | "all";

const STATUS_META: Record<SupportStatus, { label: string; tone: "green" | "amber" | "zinc" }> = {
  open: { label: "Open", tone: "green" },
  pending: { label: "Waiting on customer", tone: "amber" },
  closed: { label: "Closed", tone: "zinc" },
};

const who = (t: SupportTicketDTO) => t.name || t.user?.name || t.email || "Visitor";

/** Admin → Support: the support chat inbox (docs/support-spec.md). `?id=` opens a conversation. */
export function SupportPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>("open");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const list = useFetch(`support:${filter}:${mine}:${query}`, () => api.support.list({ status: filter, mine, q: query || undefined }), ["support"]);
  const settings = useFetch("support-settings", api.support.settings, ["support", "settings"]);
  const openId = params.get("id");

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useVisiblePoll(() => list.refetch(), 20_000, true);

  const select = (id: string | null) => setParams(id ? { id } : {}, { replace: !!openId === !!id });
  const counts = list.data?.counts;
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Support"
        description="Chats from the support bubble on your pages. Every chat is a ticket: reply, leave internal notes, assign and close."
        actions={
          <Button icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)}>
            Chat settings
          </Button>
        }
      />
      {settings.data && !settings.data.enabled && (
        <Notice tone="amber" className="mb-4">
          The chat bubble is off, so visitors can&rsquo;t write. Turn it on in{" "}
          <button className="font-medium underline" onClick={() => setSettingsOpen(true)}>
            Chat settings
          </button>
          .
        </Notice>
      )}
      <div className="grid min-h-[calc(100vh-14rem)] overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 lg:grid-cols-[360px_1fr] dark:bg-zinc-900 dark:ring-zinc-800">
        <section className={cn("flex min-w-0 flex-col border-zinc-200 lg:border-r dark:border-zinc-800", openId && "hidden lg:flex")}>
          <div className="space-y-2.5 border-b border-zinc-100 p-3 dark:border-zinc-800">
            <Tabs<Filter>
              className="w-full [&>button]:flex-1 [&>button]:justify-center"
              value={filter}
              onChange={setFilter}
              tabs={[
                { value: "open", label: "Open", count: counts?.open },
                { value: "pending", label: "Waiting", count: counts?.pending },
                { value: "closed", label: "Closed" },
                { value: "all", label: "All" },
              ]}
            />
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, text or #12" className="pl-8" aria-label="Search" />
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
                <Switch checked={mine} onChange={setMine} label="Mine" />
                Mine
              </label>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!list.data ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : !items.length ? (
              <EmptyState icon={<MessageSquare />} title={filter === "open" ? "No open chats" : "Nothing here"} description={query ? "No conversation matches the search." : "New chats show up here."} className="py-14" />
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {items.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => select(t.id)}
                      className={cn(
                        "flex w-full gap-3 px-3 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-800/40",
                        openId === t.id && "bg-brand-50/60 hover:bg-brand-50/80 dark:bg-brand-950/30",
                      )}
                    >
                      <InitialsAvatar name={who(t)} seed={t.id} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cn("truncate text-sm", t.staffUnread ? "font-semibold" : "font-medium")}>{who(t)}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-zinc-400">{relativeTime(t.lastMessageAt)}</span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          <span className={cn("truncate text-xs", t.staffUnread ? "text-zinc-800 dark:text-zinc-100" : "text-zinc-500")}>
                            {t.lastAuthor === "staff" && <span className="text-zinc-400">You: </span>}
                            {t.lastMessagePreview}
                          </span>
                          {t.staffUnread > 0 && <span className="ml-auto size-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-400">
                          #{t.number}
                          {filter === "all" && <Badge tone={STATUS_META[t.status].tone}>{STATUS_META[t.status].label}</Badge>}
                          {t.assignee && <span className="truncate">· {t.assignee.name}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className={cn("min-w-0", !openId && "hidden lg:block")}>
          {openId ? (
            <Conversation key={openId} id={openId} onBack={() => select(null)} onChanged={() => void list.refetch()} />
          ) : (
            <EmptyState icon={<LifeBuoy />} title="Pick a conversation" description="Choose a chat on the left to read and answer it." className="h-full py-24" />
          )}
        </section>
      </div>
      <SupportSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

function Conversation({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const { tz } = useApp();
  const { user } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const thread = useFetch(`support-thread:${id}`, () => api.support.get(id), []);
  const staff = useFetch("support-staff", api.support.staff, []);
  const [text, setText] = useState("");
  const [note, setNote] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const conv = thread.data?.conversation;
  const messages = thread.data?.messages ?? [];
  const lastId = messages[messages.length - 1]?.id;

  useVisiblePoll(() => thread.refetch(), 5000, true);
  // Opening marks it read: refresh the list and the nav badge once.
  useEffect(() => {
    if (thread.data) invalidate("support");
  }, [!!thread.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Block body: Chrome's scrollIntoView returns a Promise, which React would take for the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

  async function send(status?: SupportStatus) {
    const body = text.trim();
    if (!body || !conv) return;
    setBusy(status ?? (note ? "note" : "reply"));
    try {
      const r = await api.support.reply(id, { body, note, status: note ? undefined : status });
      thread.setData((d) => (d ? { conversation: r.conversation, messages: [...d.messages, r.message] } : d));
      setText("");
      setNote(false);
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function update(body: { status?: SupportStatus; assigneeId?: string | null }) {
    try {
      const r = await api.support.update(id, body);
      thread.setData((d) => (d ? { ...d, conversation: r.conversation } : d));
      onChanged();
      invalidate("support");
    } catch (err) {
      toast.error(err);
    }
  }

  async function remove() {
    if (!(await confirm({ title: "Delete this conversation?", message: "Use this for spam. It cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.support.remove(id);
      invalidate("support");
      onBack();
    } catch (err) {
      toast.error(err);
    }
  }

  if (!conv)
    return thread.error ? (
      <EmptyState title="Conversation not found" description={thread.error.message} className="py-24" />
    ) : (
      <div className="space-y-3 p-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-2/3" />
        <Skeleton className="ml-auto h-16 w-1/2" />
      </div>
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  return (
    <div className="grid h-full min-h-[calc(100vh-14rem)] xl:grid-cols-[1fr_260px]">
      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <button onClick={onBack} className="-ml-1 rounded-md p-1 text-zinc-500 hover:bg-zinc-100 lg:hidden dark:hover:bg-zinc-800" aria-label="Back">
            <ArrowLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">
              {who(conv)} <span className="font-normal text-zinc-400">#{conv.number}</span>
            </h2>
            <p className="truncate text-xs text-zinc-500">{conv.subject}</p>
          </div>
          <Badge tone={STATUS_META[conv.status].tone} dot>
            {STATUS_META[conv.status].label}
          </Badge>
          {conv.status === "closed" ? (
            <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => update({ status: "open" })}>
              Reopen
            </Button>
          ) : (
            <Button size="sm" icon={<CheckCircle2 className="size-3.5" />} onClick={() => update({ status: "closed" })}>
              Close
            </Button>
          )}
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-zinc-50/60 px-4 py-4 dark:bg-zinc-950/30">
          {messages.map((m) => (
            <Message key={m.id} m={m} tz={tz} customer={who(conv)} />
          ))}
          <div ref={end} />
        </div>
        <form onSubmit={submit} className={cn("space-y-2 border-t p-3", note ? "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20" : "border-zinc-100 dark:border-zinc-800")}>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder={note ? "Internal note (only staff see it)…" : `Reply to ${who(conv)}…`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label={note ? "Internal note" : "Reply"}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
              <Switch checked={note} onChange={setNote} label="Internal note" />
              <StickyNote className="size-3.5" /> Internal note
            </label>
            <span className="hidden text-[11px] text-zinc-400 sm:inline">⌘↵ to send</span>
            <div className="flex-1" />
            {!note && (
              <Button type="button" disabled={!text.trim() || !!busy} loading={busy === "closed"} onClick={() => send("closed")}>
                Reply &amp; close
              </Button>
            )}
            <Button type="submit" variant="primary" icon={<Send className="size-4" />} disabled={!text.trim() || !!busy} loading={busy === "reply" || busy === "note"}>
              {note ? "Add note" : "Reply"}
            </Button>
          </div>
          {!note && conv.email && <p className="text-[11px] text-zinc-400">If {who(conv)} is not in the chat, the reply is also emailed to {conv.email}.</p>}
        </form>
      </div>
      <aside className="space-y-4 border-t border-zinc-100 p-4 text-sm xl:border-l xl:border-t-0 dark:border-zinc-800">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Assignee</p>
          <Select value={conv.assignee?.id ?? ""} onChange={(e) => update({ assigneeId: e.target.value || null })} aria-label="Assignee">
            <option value="">Unassigned</option>
            {(staff.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.id === user.id ? " (you)" : ""}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Customer</p>
          <p className="flex items-center gap-2 font-medium">
            <UserRound className="size-4 text-zinc-400" /> {who(conv)}
          </p>
          {conv.email && (
            <a href={`mailto:${conv.email}`} className="block truncate text-brand-600 hover:underline dark:text-brand-400">
              {conv.email}
            </a>
          )}
          {conv.user ? (
            <p className="text-xs text-zinc-500">
              Postflare user {conv.user.email}
              {conv.workspace && <> · workspace {conv.workspace.name}</>}
            </p>
          ) : (
            <p className="text-xs text-zinc-500">Not signed in</p>
          )}
        </div>
        <dl className="space-y-1.5 text-xs">
          {conv.pageUrl && (
            <Info label="Page">
              <a href={conv.pageUrl} target="_blank" rel="noreferrer" className="break-all text-brand-600 hover:underline dark:text-brand-400">
                {conv.pageUrl.replace(/^https?:\/\//, "")}
              </a>
            </Info>
          )}
          {conv.country && (
            <Info label="Country">
              <Globe className="mr-1 inline size-3" />
              {conv.country}
            </Info>
          )}
          {conv.userAgent && <Info label="Browser">{browserOf(conv.userAgent)}</Info>}
          <Info label="Started">{formatDateTime(conv.createdAt, tz, { year: "numeric" })}</Info>
          <Info label="Customer seen">{conv.customerSeenAt ? relativeTime(conv.customerSeenAt) : "never"}</Info>
        </dl>
        <div className="flex flex-wrap gap-2 pt-1">
          {conv.status !== "pending" && conv.status !== "closed" && (
            <Button size="sm" onClick={() => update({ status: "pending" })}>
              Mark waiting
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" icon={<Trash2 className="size-3.5" />} onClick={remove}>
            Delete
          </Button>
        </div>
      </aside>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-zinc-700 dark:text-zinc-300">{children}</dd>
    </div>
  );
}

function Message({ m, tz, customer }: { m: SupportMessageDTO; tz: string; customer: string }) {
  const mine = m.author !== "customer";
  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
          m.author === "customer" && "rounded-bl-md bg-white ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700",
          m.author === "staff" && "rounded-br-md bg-brand-500 text-white",
          m.author === "note" && "rounded-br-md bg-amber-100 text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-100 dark:ring-amber-900",
        )}
      >
        {m.author === "note" && (
          <span className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">
            <Lock className="size-3" /> Internal note
          </span>
        )}
        {m.body}
      </div>
      <span className="mx-1 mt-1 text-[11px] text-zinc-400">
        {m.author === "customer" ? customer : (m.authorName ?? "Staff")} · {formatDateTime(m.createdAt, tz)}
      </span>
    </div>
  );
}

/** "Safari on iOS" from a user agent. */
function browserOf(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function SupportSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const settings = useFetch(open ? "support-settings" : null, api.support.settings, ["support", "settings"]);
  const [enabled, setEnabled] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [greeting, setGreeting] = useState("");
  const [busy, setBusy] = useState(false);
  const s = settings.data;
  useEffect(() => {
    if (!s) return;
    setEnabled(s.enabled);
    setTeamName(s.teamName);
    setGreeting(s.greeting);
  }, [s]);
  const dirty = useMemo(() => !!s && (enabled !== s.enabled || teamName.trim() !== s.teamName || greeting.trim() !== s.greeting), [s, enabled, teamName, greeting]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.support.saveSettings({ enabled, teamName: teamName.trim(), greeting: greeting.trim() });
      toast.success(enabled ? "Support chat is on" : "Support chat saved");
      invalidate("support");
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Chat settings" description="The support bubble on the landing page, the sign-in page, the app and any site that embeds it.">
      <form onSubmit={save}>
        <div className="space-y-5 p-5">
          {!s ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <label className="flex items-start gap-3 text-sm">
                <Switch checked={enabled} onChange={setEnabled} label="Show the chat bubble" />
                <span>
                  <span className="block font-medium text-zinc-900 dark:text-zinc-100">Show the chat bubble</span>
                  <span className="block text-zinc-500">Signed-in users who answer chats never see it themselves.</span>
                </span>
              </label>
              <Field label="Team name" help="Header of the chat window.">
                {(id) => <Input id={id} value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={60} />}
              </Field>
              <Field label="Greeting" help="Shown above the first message.">
                {(id) => <Textarea id={id} value={greeting} onChange={(e) => setGreeting(e.target.value)} rows={2} maxLength={300} />}
              </Field>
              <Field label="Embed on another website" help="Paste before </body>. Any element with a data-support-open attribute opens the chat.">
                {() => <CodeBlock code={s.snippet} />}
              </Field>
              {!s.emailConfigured && (
                <Notice tone="zinc">Email is not configured on this instance, so customers who leave are not emailed your replies: they see them when they come back.</Notice>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
