import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ChevronLeft, ChevronRight, PenSquare } from "lucide-react";
import { AccountFilterSelect } from "../components/accounts/AccountFilterSelect";
import { AccountAvatar, ProviderLogo } from "../components/ProviderLogo";
import { usePostDrawer } from "../components/posts/PostDrawer";
import { Button, IconButton } from "../components/ui/Button";
import { STATUS_META, Tabs } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { parseAccountFilter, selectable } from "../lib/accountGroups";
import { api, errorMessage, isPlanLimit } from "../lib/api";
import { useApp } from "../lib/app";
import { cn, truncate } from "../lib/format";
import { useSession } from "../lib/session";
import { dayKey, formatDate, formatTime, startOfDay, zonedParts, zonedTime } from "../lib/time";
import type { PostDTO } from "../lib/types";
import { invalidate, useFetch } from "../lib/useFetch";
import { useComposer } from "./composer/ComposerProvider";

type View = "month" | "week";

interface Group {
  key: string;
  at: number;
  posts: PostDTO[];
}

const postTime = (p: PostDTO) => p.publishedAt ?? p.scheduledAt ?? p.createdAt;

/** Posts of the same group at the same time collapse into one chip. */
function groupPosts(posts: PostDTO[]): Group[] {
  const map = new Map<string, Group>();
  for (const p of posts) {
    const at = postTime(p);
    const key = `${p.groupId}:${at}:${p.status === "published" || p.status === "failed" || p.status === "needs_check" ? p.id : ""}`;
    const g = map.get(key) ?? { key, at, posts: [] };
    g.posts.push(p);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.at - b.at);
}

/** Monday of the week containing ts, at 00:00 in tz. */
function weekStart(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  const back = (p.weekday + 6) % 7;
  return zonedTime(p.year, p.month, p.day - back, 0, 0, tz);
}

export function CalendarPage() {
  const canWrite = useSession().can("posts.write");
  const { tz, accounts } = useApp();
  const composer = useComposer();
  const toast = useToast();
  const [view, setView] = useState<View>(() => (localStorage.getItem("pf:calendar-view") as View) || "month");
  const [anchor, setAnchor] = useState(() => Date.now());
  // An account id or `group:<id>` (AccountFilterSelect).
  const [accountFilter, setAccountFilter] = useState("");
  const { accountId, groupId: accountGroupId } = parseAccountFilter(accountFilter);
  // New posts from a filtered calendar start with those accounts selected.
  const filterAccountIds = accountId ? [accountId] : accountGroupId ? selectable(accounts.filter((a) => a.groupId === accountGroupId)).map((a) => a.id) : undefined;
  useEffect(() => localStorage.setItem("pf:calendar-view", view), [view]);

  const range = useMemo(() => {
    if (view === "week") {
      const from = weekStart(anchor, tz);
      const [y, m, d] = ymd(from, tz);
      return { from, to: zonedTime(y, m, d + 7, 0, 0, tz), days: 7 };
    }
    const p = zonedParts(anchor, tz);
    const first = zonedTime(p.year, p.month, 1, 0, 0, tz);
    const from = weekStart(first, tz);
    const nextMonth = zonedTime(p.year, p.month + 1, 1, 0, 0, tz);
    const days = Math.ceil((nextMonth - from) / 864e5 / 7) * 7;
    const [y, m, d] = ymd(from, tz);
    return { from, to: zonedTime(y, m, d + days, 0, 0, tz), days };
  }, [view, anchor, tz]);

  const posts = useFetch(
    `calendar:${range.from}:${range.to}:${accountFilter}`,
    () => api.posts.list({ from: range.from, to: range.to, accountId, accountGroupId, limit: 1000 }),
    ["posts"],
  );

  const days = useMemo(() => {
    const [y, m, d] = ymd(range.from, tz);
    return Array.from({ length: range.days }, (_, i) => zonedTime(y, m, d + i, 0, 0, tz));
  }, [range, tz]);

  const byDay = useMemo(() => {
    const map = new Map<string, PostDTO[]>();
    for (const p of posts.data ?? []) {
      const k = dayKey(postTime(p), tz);
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    return map;
  }, [posts.data, tz]);

  const move = (dir: number) => {
    const p = zonedParts(anchor, tz);
    setAnchor(view === "week" ? zonedTime(p.year, p.month, p.day + 7 * dir, 12, 0, tz) : zonedTime(p.year, p.month + dir, 1, 12, 0, tz));
  };

  // Keyboard: ←/→ navigate, T today.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('[role="dialog"]')) return;
      if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "ArrowRight") move(1);
      else if (e.key === "t") setAnchor(Date.now());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const dragged = useRef<Group | null>(null);

  async function reschedule(group: Group, at: number) {
    if (at <= Date.now()) {
      toast.error("Cannot move a post into the past");
      return;
    }
    const ids = new Set(group.posts.map((p) => p.id));
    posts.setData((list) => list?.map((p) => (ids.has(p.id) ? { ...p, scheduledAt: at } : p)));
    try {
      await Promise.all(group.posts.map((p) => api.posts.update(p.id, { scheduledAt: at })));
      toast.success(`Rescheduled to ${formatDate(at, tz, { weekday: "short", month: "short", day: "numeric" })}, ${formatTime(at, tz)}`);
    } catch (err) {
      if (!isPlanLimit(err)) toast.error(`Could not reschedule: ${errorMessage(err)}`); // plan limits: PlanLimitDialog
    } finally {
      invalidate("posts");
    }
  }

  const onDropDay = (day: number, hour?: number) => (e: DragEvent) => {
    e.preventDefault();
    const g = dragged.current;
    dragged.current = null;
    if (!g || !canWrite) return;
    const orig = zonedParts(g.at, tz);
    const [y, m, d] = ymd(day, tz);
    const at = zonedTime(y, m, d, hour ?? orig.hour, orig.minute, tz);
    if (at !== g.at) void reschedule(g, at);
  };

  const openAt = (day: number, hour?: number) => {
    const now = Date.now();
    const [y, m, d] = ymd(day, tz);
    let at = zonedTime(y, m, d, hour ?? 9, 0, tz);
    if (hour === undefined && at < now && dayKey(day, tz) === dayKey(now, tz)) {
      const p = zonedParts(now, tz);
      at = zonedTime(y, m, d, p.hour + 1, 0, tz);
    }
    if (at < now) return;
    composer.open({ at, accountIds: filterAccountIds });
  };

  const title =
    view === "month"
      ? formatDate(anchor, tz, { month: "long", year: "numeric" })
      : `${formatDate(range.from, tz, { month: "short", day: "numeric" })} – ${formatDate(range.to - 1, tz, { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-2 min-w-48 text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="flex items-center gap-1">
          <IconButton label="Previous" variant="secondary" onClick={() => move(-1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <Button onClick={() => setAnchor(Date.now())}>Today</Button>
          <IconButton label="Next" variant="secondary" onClick={() => move(1)}>
            <ChevronRight className="size-4" />
          </IconButton>
        </div>
        <div className="flex-1" />
        {accounts.length > 1 && (
          <AccountFilterSelect value={accountFilter} onChange={setAccountFilter} className="w-48" />
        )}
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { value: "month", label: "Month" },
            { value: "week", label: "Week" },
          ]}
        />
        {canWrite && (
          <Button variant="primary" icon={<PenSquare className="size-4" />} onClick={() => composer.open({ accountIds: filterAccountIds })}>
            New post
          </Button>
        )}
      </div>

      <div className="relative overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        {posts.loading && <div className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-brand-500" />}
        {view === "month" ? (
          <MonthGrid
            days={days}
            anchor={anchor}
            byDay={byDay}
            onDrop={onDropDay}
            onOpen={openAt}
            dragged={dragged}
            onMore={(day) => {
              setAnchor(day);
              setView("week");
            }}
          />
        ) : (
          <WeekGrid days={days} byDay={byDay} onDrop={onDropDay} onOpen={openAt} dragged={dragged} />
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
        {(["scheduled", "publishing", "published", "needs_check", "failed", "draft"] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", STATUS_META[s].dot)} />
            {STATUS_META[s].label}
          </span>
        ))}
        <span className="ml-auto hidden sm:inline">Drag scheduled posts to reschedule · click an empty slot to create · {tz.replace(/_/g, " ")}</span>
      </div>
    </div>
  );
}

function ymd(ts: number, tz: string): [number, number, number] {
  const p = zonedParts(ts, tz);
  return [p.year, p.month, p.day];
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function MonthGrid({
  days,
  anchor,
  byDay,
  onDrop,
  onOpen,
  dragged,
  onMore,
}: {
  days: number[];
  anchor: number;
  onMore: (day: number) => void;
  byDay: Map<string, PostDTO[]>;
  onDrop: (day: number, hour?: number) => (e: DragEvent) => void;
  onOpen: (day: number, hour?: number) => void;
  dragged: React.RefObject<Group | null>;
}) {
  const canWrite = useSession().can("posts.write");
  const { tz } = useApp();
  const month = zonedParts(anchor, tz).month;
  const today = dayKey(Date.now(), tz);
  const todayStart = startOfDay(Date.now(), tz);
  const [over, setOver] = useState<string | null>(null);
  return (
    <div>
      <div className="grid grid-cols-7 border-b border-zinc-200 dark:border-zinc-800">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="px-3 py-2 text-xs font-medium text-zinc-500">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day, i) => {
          const key = dayKey(day, tz);
          const p = zonedParts(day, tz);
          const groups = groupPosts(byDay.get(key) ?? []);
          const past = day < todayStart;
          const shown = groups.slice(0, 4);
          return (
            <div
              key={key}
              onDragOver={(e) => {
                if (!dragged.current || past) return;
                e.preventDefault();
                setOver(key);
              }}
              onDragLeave={() => setOver((o) => (o === key ? null : o))}
              onDrop={(e) => {
                setOver(null);
                onDrop(day)(e);
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) onOpen(day);
              }}
              className={cn(
                "group/day relative min-h-28 border-zinc-200 p-1.5 transition-colors dark:border-zinc-800 sm:min-h-32",
                i % 7 !== 6 && "border-r",
                i < days.length - 7 && "border-b",
                p.month !== month && "bg-zinc-50/70 dark:bg-zinc-950/40",
                !past && canWrite && "cursor-pointer hover:bg-brand-50/30 dark:hover:bg-brand-950/10",
                over === key && "bg-brand-50 ring-2 ring-inset ring-brand-400 dark:bg-brand-950/30",
              )}
            >
              <div className="pointer-events-none mb-1 flex items-center justify-between px-1">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs font-medium",
                    key === today ? "bg-brand-600 text-white" : p.month !== month ? "text-zinc-400 dark:text-zinc-600" : "text-zinc-700 dark:text-zinc-300",
                  )}
                >
                  {p.day}
                </span>
                {!past && <PenSquare className="size-3 text-zinc-300 opacity-0 transition group-hover/day:opacity-100 dark:text-zinc-600" />}
              </div>
              <div className="space-y-1">
                {shown.map((g) => (
                  <Chip key={g.key} group={g} dragged={dragged} />
                ))}
                {groups.length > shown.length && (
                  <button
                    type="button"
                    onClick={() => onMore(day)}
                    className="rounded px-1.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    +{groups.length - shown.length} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekGrid({
  days,
  byDay,
  onDrop,
  onOpen,
  dragged,
}: {
  days: number[];
  byDay: Map<string, PostDTO[]>;
  onDrop: (day: number, hour?: number) => (e: DragEvent) => void;
  onOpen: (day: number, hour?: number) => void;
  dragged: React.RefObject<Group | null>;
}) {
  const canWrite = useSession().can("posts.write");
  const { tz } = useApp();
  const scroller = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<string | null>(null);
  const today = dayKey(Date.now(), tz);
  const now = Date.now();
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * 56;
  }, []);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const nowParts = zonedParts(now, tz);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-zinc-200 dark:border-zinc-800">
          <div />
          {days.map((d, i) => {
            const p = zonedParts(d, tz);
            const isToday = dayKey(d, tz) === today;
            return (
              <div key={d} className="border-l border-zinc-200 px-2 py-2 text-center dark:border-zinc-800">
                <div className="text-xs font-medium text-zinc-500">{WEEKDAY_LABELS[i]}</div>
                <div className={cn("mx-auto mt-0.5 flex size-7 items-center justify-center rounded-full text-sm font-semibold", isToday && "bg-brand-600 text-white")}>{p.day}</div>
              </div>
            );
          })}
        </div>
        <div ref={scroller} className="max-h-[calc(100vh-260px)] min-h-96 overflow-y-auto">
          <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))]">
            {hours.map((h) => (
              <div key={h} className="contents">
                <div className="relative h-14 border-b border-zinc-100 pr-2 text-right dark:border-zinc-800/60">
                  <span className="relative -top-2 text-[10px] text-zinc-400">{h === 0 ? "" : formatHour(h)}</span>
                </div>
                {days.map((d) => {
                  const [y, m, dd] = ymd(d, tz);
                  const slotStart = zonedTime(y, m, dd, h, 0, tz);
                  const key = `${dayKey(d, tz)}-${h}`;
                  const groups = groupPosts((byDay.get(dayKey(d, tz)) ?? []).filter((p) => zonedParts(postTime(p), tz).hour === h));
                  const past = slotStart + 3600000 <= now;
                  const isNowRow = dayKey(d, tz) === today && nowParts.hour === h;
                  return (
                    <div
                      key={key}
                      onDragOver={(e) => {
                        if (!dragged.current || past) return;
                        e.preventDefault();
                        setOver(key);
                      }}
                      onDragLeave={() => setOver((o) => (o === key ? null : o))}
                      onDrop={(e) => {
                        setOver(null);
                        onDrop(d, h)(e);
                      }}
                      onClick={(e) => {
                        if (e.target === e.currentTarget && !past) onOpen(d, h);
                      }}
                      className={cn(
                        "relative min-h-14 space-y-1 border-b border-l border-zinc-100 p-1 dark:border-zinc-800/60",
                        past ? "bg-zinc-50/60 dark:bg-zinc-950/30" : canWrite && "cursor-pointer hover:bg-brand-50/40 dark:hover:bg-brand-950/10",
                        over === key && "bg-brand-50 ring-2 ring-inset ring-brand-400 dark:bg-brand-950/30",
                      )}
                    >
                      {isNowRow && (
                        <div className="pointer-events-none absolute inset-x-0 z-[1] h-0.5 bg-red-500" style={{ top: `${(nowParts.minute / 60) * 100}%` }}>
                          <span className="absolute -left-1 -top-[3px] size-2 rounded-full bg-red-500" />
                        </div>
                      )}
                      {groups.map((g) => (
                        <Chip key={g.key} group={g} dragged={dragged} showText />
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatHour(h: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2020, 0, 1, h));
}

function Chip({ group, dragged, showText }: { group: Group; dragged: React.RefObject<Group | null>; showText?: boolean }) {
  const { accountMap, providerMap, tz } = useApp();
  const { openPost } = usePostDrawer();
  const canWrite = useSession().can("posts.write");
  const first = group.posts[0];
  const statuses = new Set(group.posts.map((p) => p.status));
  const status = statuses.has("failed") ? "failed" : statuses.has("needs_check") ? "needs_check" : statuses.has("publishing") ? "publishing" : first.status;
  const draggable = canWrite && group.posts.every((p) => p.status === "scheduled");
  const accs = group.posts.map((p) => accountMap.get(p.accountId));
  const provider = accs[0] ? providerMap.get(accs[0].provider) : undefined;
  // Platform logos first: avatars alone don't tell YouTube from Instagram when both use the same profile picture.
  const providers = [...new Set(accs.map((a) => a?.provider).filter(Boolean) as string[])].map((id) => providerMap.get(id));
  const meta = STATUS_META[status];
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(e) => {
        dragged.current = group;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", first.id);
      }}
      onDragEnd={() => {
        dragged.current = null;
      }}
      onClick={(e) => {
        e.stopPropagation();
        openPost(group.posts.map((p) => p.id));
      }}
      title={`${accs.map((a) => a?.name ?? "Deleted account").join(", ")} · ${meta.label}\n${truncate(first.content, 200)}`}
      className={cn(
        "relative flex w-full items-center gap-1.5 overflow-hidden rounded-md bg-white py-1 pl-2 pr-1.5 text-left text-[11px] shadow-sm ring-1 ring-zinc-200 transition hover:shadow hover:ring-zinc-300 dark:bg-zinc-800 dark:ring-zinc-700 dark:hover:ring-zinc-600",
        draggable && "cursor-grab active:cursor-grabbing",
        status === "cancelled" && "opacity-50",
        status === "draft" && "bg-zinc-50 shadow-none dark:bg-zinc-800/50 [&>span:last-child]:italic",
      )}
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: provider ? `#${provider.color}` : undefined }} />
      <span className="flex shrink-0 gap-0.5">
        {providers.slice(0, 3).map((p, i) => (
          <ProviderLogo key={p?.id ?? i} provider={p} size="xs" />
        ))}
      </span>
      <span className="flex shrink-0 -space-x-1.5">
        {accs.slice(0, 3).map((a, i) => (
          <AccountAvatar key={i} account={a} size="xs" showProvider={false} provider={a ? providerMap.get(a.provider) : undefined} className="rounded-full ring-2 ring-white dark:ring-zinc-800" />
        ))}
        {accs.length > 3 && (
          <span className="flex size-5 items-center justify-center rounded-full bg-zinc-200 text-[9px] font-semibold ring-2 ring-white dark:bg-zinc-700 dark:ring-zinc-800">+{accs.length - 3}</span>
        )}
      </span>
      <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
      <span className="shrink-0 font-medium tabular-nums text-zinc-700 dark:text-zinc-200">{formatTime(group.at, tz)}</span>
      <span className={cn("min-w-0 truncate text-zinc-500 dark:text-zinc-400", !showText && "hidden xl:inline")}>{first.content.replace(/\s+/g, " ") || (first.media.length ? "Media" : "")}</span>
    </button>
  );
}
