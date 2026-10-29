import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Ban, ExternalLink, Film, Image as ImageIcon, Layers, ListChecks, Pencil, PenSquare, RotateCcw, Search, Trash2 } from "lucide-react";
import { AccountFilterSelect } from "../components/accounts/AccountFilterSelect";
import { AccountAvatar } from "../components/ProviderLogo";
import { EDITABLE, usePostActions, usePostDrawer } from "../components/posts/PostDrawer";
import { Button, IconButton } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Form";
import { Card, EmptyState, PageHeader, Skeleton, StatusBadge } from "../components/ui/Misc";
import { parseAccountFilter } from "../lib/accountGroups";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { cn, truncate } from "../lib/format";
import { getMedia } from "../lib/mediaCache";
import { usePlaybookList } from "../lib/playbooks";
import { useSession } from "../lib/session";
import { formatDateTime, relativeTime } from "../lib/time";
import type { PostDTO, PostStatus } from "../lib/types";
import { useFetch } from "../lib/useFetch";
import { useComposer } from "./composer/ComposerProvider";

const FILTERS: Array<{ value: "" | PostStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "draft", label: "Drafts" },
  { value: "published", label: "Published" },
  { value: "needs_check", label: "Needs check" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

export function PostsPage() {
  const canWrite = useSession().can("posts.write");
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "") as "" | PostStatus;
  // An account id or `group:<id>` (AccountFilterSelect).
  const accountFilter = params.get("account") ?? "";
  const { accountId, groupId: accountGroupId } = parseAccountFilter(accountFilter);
  const playbookId = params.get("playbook") ?? "";
  const playbooks = usePlaybookList();
  const [q, setQ] = useState("");
  const { accounts, accountMap, providerMap, tz } = useApp();
  const composer = useComposer();
  const posts = useFetch(`posts:${accountFilter}`, () => api.posts.list({ order: "desc", limit: 1000, accountId, accountGroupId }), ["posts"]);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of posts.data ?? []) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [posts.data]);

  const groupSizes = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of posts.data ?? []) m.set(p.groupId, (m.get(p.groupId) ?? 0) + 1);
    return m;
  }, [posts.data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (posts.data ?? []).filter((p) => {
      if (status && p.status !== status && !(status === "scheduled" && p.status === "publishing")) return false;
      if (playbookId && (playbookId === "none" ? !!p.playbookId : playbookId === "any" ? !p.playbookId : p.playbookId !== playbookId)) return false;
      if (!needle) return true;
      const a = accountMap.get(p.accountId);
      return (
        p.content.toLowerCase().includes(needle) ||
        a?.name.toLowerCase().includes(needle) ||
        a?.username?.toLowerCase().includes(needle) ||
        p.thread.some((t) => t.content.toLowerCase().includes(needle))
      );
    });
  }, [posts.data, status, q, accountMap, playbookId]);
  // Playbooks used by these posts (plus the selected one), for the filter.
  const usedPlaybooks = useMemo(() => {
    const ids = new Set((posts.data ?? []).map((p) => p.playbookId).filter((x): x is string => !!x));
    if (playbookId && playbookId !== "none" && playbookId !== "any") ids.add(playbookId);
    return [...ids].map((id) => ({ id, name: playbooks.data?.find((p) => p.id === id)?.name ?? id })).sort((a, b) => a.name.localeCompare(b.name));
  }, [posts.data, playbooks.data, playbookId]);

  return (
    <>
      <PageHeader
        title="Posts"
        description="Everything you have scheduled, drafted and published."
        actions={
          canWrite && (
            <Button variant="primary" icon={<PenSquare className="size-4" />} onClick={() => composer.open({})}>
              New post
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
          {FILTERS.map((f) => {
            const n = f.value ? (counts[f.value] ?? 0) + (f.value === "scheduled" ? (counts.publishing ?? 0) : 0) : (posts.data?.length ?? 0);
            // Rare state: only offer the filter when there is something to check.
            if (f.value === "needs_check" && !n && status !== f.value) return null;
            return (
              <button
                key={f.value}
                onClick={() => setParam("status", f.value)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  status === f.value
                    ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
                )}
              >
                {f.label}
                {posts.data && (
                  <span className={cn("text-xs tabular-nums", status === f.value ? "opacity-70" : "text-zinc-400", f.value === "failed" && n > 0 && status !== f.value && "text-red-500", f.value === "needs_check" && n > 0 && status !== f.value && "text-amber-600")}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex flex-1 gap-2 lg:justify-end">
          <div className="relative flex-1 lg:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search posts…" className="pl-9" aria-label="Search posts" />
          </div>
          {(usedPlaybooks.length > 0 || playbookId) && (
            <Select value={playbookId} onChange={(e) => setParam("playbook", e.target.value)} className="w-44" aria-label="Filter by playbook">
              <option value="">Any playbook</option>
              <option value="any">With a playbook</option>
              <option value="none">Without a playbook</option>
              {usedPlaybooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          {accounts.length > 0 && (
            <AccountFilterSelect value={accountFilter} onChange={(v) => setParam("account", v)} className="w-44" />
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        {!posts.data ? (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            ))}
          </div>
        ) : !filtered.length ? (
          <EmptyState
            icon={<ListChecks />}
            title={posts.data.length ? "No posts match your filters" : "No posts yet"}
            description={posts.data.length ? "Try another status, account or search." : "Create your first post and it will show up here."}
            action={
              posts.data.length ? (
                <Button
                  onClick={() => {
                    setQ("");
                    setParams({}, { replace: true });
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                canWrite && (
                  <Button variant="primary" onClick={() => composer.open({})}>
                    Create post
                  </Button>
                )
              )
            }
          />
        ) : (
          <>
            <table className="hidden w-full table-fixed text-sm md:table">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800">
                  <th className="py-2.5 pl-5 pr-3 font-medium">Post</th>
                  <th className="w-36 px-3 py-2.5 font-medium">Status</th>
                  <th className="w-44 px-3 py-2.5 font-medium">Date</th>
                  <th className="w-36 py-2.5 pl-3 pr-5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {filtered.map((p) => (
                  <TableRow key={p.id} post={p} groupSize={groupSizes.get(p.groupId) ?? 1} />
                ))}
              </tbody>
            </table>
            <div className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
              {filtered.map((p) => {
                const a = accountMap.get(p.accountId);
                return <MobileRow key={p.id} post={p} account={a} provider={a ? providerMap.get(a.provider) : undefined} tz={tz} />;
              })}
            </div>
          </>
        )}
      </Card>
      {posts.data && posts.data.length >= 1000 && <p className="mt-3 text-center text-xs text-zinc-400">Showing the latest 1000 posts.</p>}
    </>
  );
}

function dateLabel(p: PostDTO, tz: string) {
  const ts = p.status === "published" ? (p.publishedAt ?? p.updatedAt) : p.status === "draft" ? p.updatedAt : (p.scheduledAt ?? p.createdAt);
  return {
    main: formatDateTime(ts, tz, { year: new Date(ts).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }),
    sub: p.status === "draft" ? `edited ${relativeTime(ts)}` : relativeTime(ts),
  };
}

function MediaIcons({ post }: { post: PostDTO }) {
  if (!post.media.length) return null;
  const video = post.media.some((id) => getMedia(id)?.kind === "video");
  return (
    <span className="inline-flex items-center gap-0.5 text-zinc-400">
      {video ? <Film className="size-3.5" /> : <ImageIcon className="size-3.5" />}
      {post.media.length > 1 && <span className="text-[11px]">{post.media.length}</span>}
    </span>
  );
}

function RowActions({ post }: { post: PostDTO }) {
  const actions = usePostActions();
  const composer = useComposer();
  const canWrite = useSession().can("posts.write");
  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      {canWrite && EDITABLE.includes(post.status) && (
        <IconButton label="Edit" size="sm" onClick={() => composer.open({ postId: post.id })}>
          <Pencil className="size-4" />
        </IconButton>
      )}
      {canWrite && post.status === "failed" && (
        <IconButton label="Retry" size="sm" onClick={() => actions.retry(post)}>
          <RotateCcw className="size-4" />
        </IconButton>
      )}
      {canWrite && post.status === "scheduled" && (
        <IconButton label="Cancel" size="sm" onClick={() => actions.cancel(post)}>
          <Ban className="size-4" />
        </IconButton>
      )}
      {post.externalUrl && (
        <a
          href={post.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="flex size-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          aria-label="Open on platform"
          title="Open on platform"
        >
          <ExternalLink className="size-4" />
        </a>
      )}
      {canWrite && post.status !== "publishing" && (
        <IconButton label="Delete" size="sm" variant="danger" onClick={() => actions.remove(post)}>
          <Trash2 className="size-4" />
        </IconButton>
      )}
    </div>
  );
}

function TableRow({ post, groupSize }: { post: PostDTO; groupSize: number }) {
  const { accountMap, providerMap, tz } = useApp();
  const { openPost } = usePostDrawer();
  const a = accountMap.get(post.accountId);
  const provider = a ? providerMap.get(a.provider) : undefined;
  const d = dateLabel(post, tz);
  return (
    <tr className="group cursor-pointer transition hover:bg-zinc-50 dark:hover:bg-zinc-800/40" onClick={() => openPost(post.id)}>
      <td className="py-3 pl-5 pr-3">
        <div className="flex items-center gap-3">
          <AccountAvatar account={a} provider={provider} size="md" />
          <div className="min-w-0 flex-1">
            <button type="button" className="block max-w-full truncate text-left font-medium text-zinc-900 group-hover:text-brand-700 focus:outline-none dark:text-zinc-100 dark:group-hover:text-brand-300">
              {post.content ? truncate(post.content.replace(/\s+/g, " "), 140) : <span className="italic text-zinc-400">{post.media.length ? "Media post" : "Empty post"}</span>}
            </button>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="truncate">
                {a?.name ?? "Deleted account"}
                {provider && <span className="text-zinc-400"> · {provider.name}</span>}
              </span>
              <MediaIcons post={post} />
              {groupSize > 1 && (
                <span className="inline-flex items-center gap-0.5 text-zinc-400" title={`Part of a ${groupSize}-account post`}>
                  <Layers className="size-3.5" />
                  {groupSize}
                </span>
              )}
            </div>
            {post.status === "failed" && post.error && <p className="mt-1 truncate text-xs text-red-600 dark:text-red-400">{post.error}</p>}
            {post.status === "needs_check" && post.error && <p className="mt-1 truncate text-xs text-amber-700 dark:text-amber-400">{post.error}</p>}
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <StatusBadge status={post.status} />
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <div className="text-zinc-700 dark:text-zinc-300">{d.main}</div>
        <div className="text-xs text-zinc-400">{d.sub}</div>
      </td>
      <td className="py-3 pl-3 pr-5">
        <RowActions post={post} />
      </td>
    </tr>
  );
}

function MobileRow({
  post,
  account,
  provider,
  tz,
}: {
  post: PostDTO;
  account: ReturnType<typeof useApp>["accounts"][number] | undefined;
  provider: ReturnType<typeof useApp>["providers"][number] | undefined;
  tz: string;
}) {
  const { openPost } = usePostDrawer();
  const d = dateLabel(post, tz);
  return (
    <div className="p-4" onClick={() => openPost(post.id)}>
      <div className="flex items-start gap-3">
        <AccountAvatar account={account} provider={provider} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{account?.name ?? "Deleted account"}</span>
            <StatusBadge status={post.status} />
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-zinc-700 dark:text-zinc-300">{post.content || <span className="italic text-zinc-400">Media post</span>}</p>
          {post.status === "failed" && post.error && <p className="mt-1 line-clamp-2 text-xs text-red-600 dark:text-red-400">{post.error}</p>}
          {post.status === "needs_check" && post.error && <p className="mt-1 line-clamp-2 text-xs text-amber-700 dark:text-amber-400">{post.error}</p>}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-zinc-500">{d.main}</span>
            <RowActions post={post} />
          </div>
        </div>
      </div>
    </div>
  );
}
