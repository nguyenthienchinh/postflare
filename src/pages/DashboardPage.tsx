import { Link } from "react-router";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  PenSquare,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";
import { AnalyticsTile } from "../components/analytics/AnalyticsTile";
import { PostRow } from "../components/posts/PostRow";
import { usePostActions } from "../components/posts/PostDrawer";
import { Button, IconButton } from "../components/ui/Button";
import { Card, CardHeader, EmptyState, PageHeader, Skeleton, StatusBadge } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { cn, truncate } from "../lib/format";
import { useSession } from "../lib/session";
import { formatDateTime, relativeTime } from "../lib/time";
import { useFetch } from "../lib/useFetch";
import { useComposer } from "./composer/ComposerProvider";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function DashboardPage() {
  const { can, canInstance, user, workspace } = useSession();
  const canRead = can("posts.read");
  const canWrite = can("posts.write");
  const overview = useFetch(canRead ? "overview" : null, api.overview, ["posts", "accounts"]);
  const { providers, accounts, tz, loading } = useApp();
  const composer = useComposer();
  const actions = usePostActions();
  const o = overview.data;

  const totalPosts = o ? Object.values(o.counts).reduce((a, b) => a + (b ?? 0), 0) : 0;
  const platformReady = providers.some((p) => p.configured && p.appFields.some((f) => f.required)) || accounts.length > 0;
  // Only the steps this user can actually do: platforms are instance admin work, the rest needs write access here.
  const steps = [
    ...(canInstance("instance.platforms.manage")
      ? [{ done: platformReady, title: "Configure a platform", description: "Add your developer app credentials (not needed for Bluesky, Mastodon, Telegram, webhooks…).", to: "/platforms", cta: "Open platforms" }]
      : []),
    ...(can("accounts.manage")
      ? [{ done: accounts.length > 0, title: "Connect an account", description: "Link the profiles, pages and channels you want to post to.", to: "/accounts", cta: "Connect account" }]
      : []),
    ...(canWrite ? [{ done: totalPosts > 0, title: "Schedule your first post", description: "Write once, customize per platform, and pick a time.", cta: "Create post" }] : []),
  ] as Array<{ done: boolean; title: string; description: string; to?: string; cta: string }>;
  const showChecklist = !!o && !loading.accounts && steps.length > 0 && steps.some((s) => !s.done);
  const firstName = user.name.split(/\s+/)[0];
  const reconnect = accounts.filter((a) => a.status === "reconnect");
  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const showAnalytics =
    !!o?.counts.published && (!can("accounts.read") || accounts.some((a) => providerMap.get(a.provider)?.analytics.post || providerMap.get(a.provider)?.analytics.account));

  const stats = [
    { key: "scheduled", label: "Scheduled", icon: CalendarClock, color: "text-sky-600 bg-sky-50 dark:bg-sky-950/50 dark:text-sky-400" },
    { key: "published", label: "Published", icon: Send, color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/50 dark:text-emerald-400" },
    { key: "failed", label: "Failed", icon: XCircle, color: "text-red-600 bg-red-50 dark:bg-red-950/50 dark:text-red-400" },
    { key: "draft", label: "Drafts", icon: FileText, color: "text-zinc-600 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300" },
  ] as const;

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={`Here is what is happening in ${workspace?.name ?? "your workspace"}.`}
        actions={
          canWrite && (
            <Button variant="primary" icon={<PenSquare className="size-4" />} onClick={() => composer.open({})}>
              New post
            </Button>
          )
        }
      />

      {reconnect.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          <AlertTriangle className="size-5 shrink-0 text-amber-500" />
          <span className="flex-1">
            <strong className="font-semibold">{reconnect.map((a) => a.name).join(", ")}</strong> {reconnect.length === 1 ? "needs" : "need"} to be reconnected. Scheduled posts for{" "}
            {reconnect.length === 1 ? "it" : "them"} will fail until then.
          </span>
          <Link to="/accounts" className="inline-flex items-center gap-1 font-medium text-amber-800 hover:underline dark:text-amber-300">
            Fix now <ArrowRight className="size-4" />
          </Link>
        </div>
      )}

      {canRead && !!o?.counts.needs_check && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          <AlertTriangle className="size-5 shrink-0 text-amber-500" />
          <span className="flex-1">
            <strong className="font-semibold">
              {o.counts.needs_check} {o.counts.needs_check === 1 ? "post needs" : "posts need"} a check.
            </strong>{" "}
            We couldn't confirm whether the platform accepted {o.counts.needs_check === 1 ? "it" : "them"}. Check the profile, then mark as published or retry.
          </span>
          <Link to="/posts?status=needs_check" className="inline-flex items-center gap-1 font-medium text-amber-800 hover:underline dark:text-amber-300">
            Review <ArrowRight className="size-4" />
          </Link>
        </div>
      )}

      {showChecklist && (
        <Card className="mb-6 overflow-hidden">
          <div className="border-b border-zinc-100 bg-gradient-to-r from-brand-50 to-rose-50 px-5 py-4 dark:border-zinc-800 dark:from-brand-950/40 dark:to-rose-950/30">
            <h2 className="text-sm font-semibold">Get started</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {steps.filter((s) => s.done).length} of {steps.length} done.{steps.length === 3 ? " Three steps to your first scheduled post." : ""}
            </p>
          </div>
          <ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {steps.map((s, i) => {
              const current = !s.done && steps.slice(0, i).every((x) => x.done);
              return (
                <li key={s.title} className="flex items-center gap-4 px-5 py-4">
                  {s.done ? <CheckCircle2 className="size-6 shrink-0 text-emerald-500" /> : <Circle className={cn("size-6 shrink-0", current ? "text-brand-500" : "text-zinc-300 dark:text-zinc-600")} />}
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm font-medium", s.done && "text-zinc-400 line-through")}>{s.title}</p>
                    {!s.done && <p className="text-sm text-zinc-500 dark:text-zinc-400">{s.description}</p>}
                  </div>
                  {!s.done &&
                    (s.to ? (
                      <Link
                        to={s.to}
                        className={cn(
                          "inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs font-medium",
                          current ? "bg-brand-600 text-white hover:bg-brand-700" : "text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800",
                        )}
                      >
                        {s.cta}
                      </Link>
                    ) : (
                      <Button size="sm" variant={current ? "primary" : "secondary"} onClick={() => composer.open({})}>
                        {s.cta}
                      </Button>
                    ))}
                </li>
              );
            })}
          </ol>
        </Card>
      )}

      {!canRead ? (
        <Card>
          <EmptyState icon={<FileText />} title="Nothing to show here" description="Your role in this workspace does not include viewing posts." />
        </Card>
      ) : (
      <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.key} to={`/posts?status=${s.key}`} className="group">
            <Card className="flex items-center gap-4 p-4 transition group-hover:ring-zinc-300 dark:group-hover:ring-zinc-700">
              <div className={cn("flex size-10 items-center justify-center rounded-lg", s.color)}>
                <s.icon className="size-5" />
              </div>
              <div>
                {o ? <p className="text-2xl font-semibold tabular-nums tracking-tight">{o.counts[s.key] ?? 0}</p> : <Skeleton className="mb-1 h-7 w-10" />}
                <p className="text-sm text-zinc-500 dark:text-zinc-400">{s.label}</p>
              </div>
            </Card>
          </Link>
        ))}
      </div>

      {showAnalytics && <AnalyticsTile />}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader
            title="Upcoming"
            description="Next scheduled posts"
            action={
              <Link to="/calendar" className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                Calendar
              </Link>
            }
          />
          {!o ? (
            <ListSkeleton />
          ) : !o.upcoming.length ? (
            <EmptyState
              icon={<CalendarClock />}
              title="Nothing scheduled"
              description="Posts you schedule will show up here."
              action={
                canWrite && (
                  <Button size="sm" variant="primary" onClick={() => composer.open({})}>
                    Schedule a post
                  </Button>
                )
              }
            />
          ) : (
            <div className="divide-y divide-zinc-100 py-1 dark:divide-zinc-800">
              {o.upcoming.map((p) => (
                <PostRow
                  key={p.id}
                  post={p}
                  meta={
                    p.status === "publishing" ? (
                      <StatusBadge status="publishing" />
                    ) : (
                      <span title={p.scheduledAt ? formatDateTime(p.scheduledAt, tz) : undefined}>
                        {p.scheduledAt ? `${formatDateTime(p.scheduledAt, tz, { weekday: "short" })} · ${relativeTime(p.scheduledAt)}` : ""}
                      </span>
                    )
                  }
                />
              ))}
            </div>
          )}
        </Card>

        <Card className="min-w-0">
          <CardHeader
            title="Recent results"
            description="Latest published and failed posts"
            action={
              <Link to="/posts" className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                All posts
              </Link>
            }
          />
          {!o ? (
            <ListSkeleton />
          ) : !o.recent.length ? (
            <EmptyState icon={<Send />} title="No results yet" description="Published and failed posts appear here with links and errors." />
          ) : (
            <div className="divide-y divide-zinc-100 py-1 dark:divide-zinc-800">
              {o.recent.map((p) => (
                <PostRow
                  key={p.id}
                  post={p}
                  meta={
                    p.status === "failed" ? (
                      <span className="truncate text-red-600 dark:text-red-400" title={p.error ?? undefined}>
                        Failed{p.error ? `: ${truncate(p.error, 70)}` : ""}
                      </span>
                    ) : p.status === "needs_check" ? (
                      <span className="truncate text-amber-700 dark:text-amber-400" title={p.error ?? undefined}>
                        Needs check: open it to mark as published or retry
                      </span>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">Published {relativeTime(p.publishedAt ?? p.updatedAt)}</span>
                    )
                  }
                  trailing={
                    p.status === "failed" && canWrite ? (
                      <IconButton label="Retry" size="sm" onClick={() => actions.retry(p)}>
                        <RotateCcw className="size-4" />
                      </IconButton>
                    ) : p.externalUrl ? (
                      <a
                        href={p.externalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex size-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        aria-label="Open on platform"
                        title="Open on platform"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    ) : null
                  }
                />
              ))}
            </div>
          )}
        </Card>
      </div>
      </>
      )}
    </>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-4 p-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
