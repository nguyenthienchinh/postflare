import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, Ban, BookOpenText, CheckCircle2, Copy, ExternalLink, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app";
import { cn } from "../../lib/format";
import { useSession } from "../../lib/session";
import { playbookLabel, usePlaybookList } from "../../lib/playbooks";
import { formatDateTime, relativeTime } from "../../lib/time";
import type { FieldDef, PostDTO, PostWithLogs } from "../../lib/types";
import { invalidate, useFetch } from "../../lib/useFetch";
import { useComposer } from "../../pages/composer/ComposerProvider";
import { PostPerformance } from "../analytics/PostPerformance";
import { PostCampaign } from "../campaigns/bits";
import { AccountAvatar } from "../ProviderLogo";
import { Button } from "../ui/Button";
import { useConfirm } from "../ui/Confirm";
import { Dialog, Drawer } from "../ui/Dialog";
import { Field, Input } from "../ui/Form";
import { Skeleton, StatusBadge } from "../ui/Misc";
import { useToast } from "../ui/Toast";
import { PlatformPreview } from "./PlatformPreview";

interface DrawerApi {
  openPost: (ids: string | string[]) => void;
}
const Ctx = createContext<DrawerApi | null>(null);

export function PostDrawerProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const openPost = useCallback((v: string | string[]) => setIds(Array.isArray(v) ? v : [v]), []);
  const api = useMemo(() => ({ openPost }), [openPost]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {ids && <PostDrawer ids={ids} onClose={() => setIds(null)} />}
    </Ctx.Provider>
  );
}

export function usePostDrawer(): DrawerApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePostDrawer outside provider");
  return ctx;
}

export const EDITABLE: PostDTO["status"][] = ["draft", "scheduled", "failed", "cancelled"];

/** Shared post actions with confirmation + toasts. */
export function usePostActions() {
  const toast = useToast();
  const confirm = useConfirm();
  const run = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast.success(success);
      invalidate("posts");
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    }
  };
  return {
    retry: (p: PostDTO) => run(() => api.posts.retry(p.id), "Retry queued"),
    /** needs_check: the post is live on the platform. */
    markPublished: (p: PostDTO, url: string | null) => run(() => api.posts.resolve(p.id, { published: true, url }), "Marked as published"),
    /** needs_check: the post is not live, publish it again now. */
    retryAnyway: async (p: PostDTO) =>
      (await confirm({
        title: "Retry anyway?",
        message: "This may publish a duplicate if the platform did accept the first attempt. Check your profile first.",
        confirmLabel: "Retry anyway",
        danger: true,
      })) && run(() => api.posts.resolve(p.id, { published: false }), "Publishing again"),
    cancel: async (p: PostDTO) =>
      (await confirm({ title: "Cancel this post?", message: "It will not be published. You can retry or edit it later.", confirmLabel: "Cancel post", danger: true })) &&
      run(() => api.posts.cancel(p.id), "Post cancelled"),
    remove: async (p: PostDTO) =>
      (await confirm({
        title: "Delete this post?",
        message: p.status === "published" ? "It is removed from Postflare only; the post stays live on the platform." : "This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      })) && run(() => api.posts.remove(p.id), "Post deleted"),
  };
}

function PostDrawer({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [active, setActive] = useState(ids[0]);
  const { accountMap, providerMap } = useApp();
  const post = useFetch(`post:${active}`, () => api.posts.get(active), ["posts"]);
  const group = useFetch(ids.length > 1 ? `group:${ids.join()}` : null, () => Promise.all(ids.map((id) => api.posts.get(id))), ["posts"]);
  const p = post.data;

  // Poll while the post is in flight.
  useEffect(() => {
    if (p?.status !== "publishing") return;
    const t = setInterval(() => void post.refetch(), 4000);
    return () => clearInterval(t);
  }, [p?.status, post]);

  const account = p ? accountMap.get(p.accountId) : undefined;
  const provider = account ? providerMap.get(account.provider) : undefined;

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        p ? (
          <div className="flex items-center gap-3">
            <AccountAvatar account={account} provider={provider} size="md" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{account?.name ?? "Deleted account"}</div>
              <div className="truncate text-xs font-normal text-zinc-500">{provider?.name}</div>
            </div>
          </div>
        ) : (
          "Post"
        )
      }
      footer={p && <Actions post={p} onClose={onClose} />}
    >
      {ids.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-zinc-200 px-5 py-2.5 dark:border-zinc-800">
          {ids.map((id) => {
            const gp = group.data?.find((x) => x.id === id);
            const a = gp ? accountMap.get(gp.accountId) : undefined;
            return (
              <button
                key={id}
                onClick={() => setActive(id)}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 text-xs font-medium ring-1 transition",
                  id === active
                    ? "bg-brand-50 text-brand-800 ring-brand-300 dark:bg-brand-950/50 dark:text-brand-200 dark:ring-brand-800"
                    : "text-zinc-600 ring-zinc-200 hover:bg-zinc-50 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800",
                )}
              >
                <AccountAvatar account={a} provider={a ? providerMap.get(a.provider) : undefined} size="sm" showProvider={false} className="!size-5" />
                {a?.name ?? "…"}
              </button>
            );
          })}
        </div>
      )}
      {!p ? (
        <div className="space-y-4 p-5">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <PostBody post={p} />
      )}
    </Drawer>
  );
}

/** "Written with <playbook> v1 · variant A", linking to the playbook. */
function PlaybookLine({ post }: { post: PostDTO }) {
  const list = usePlaybookList();
  return (
    <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-800">
      <BookOpenText className="size-4 shrink-0 text-zinc-400" aria-hidden />
      <span className="text-zinc-500">Written with</span>
      <Link to={`/playbooks/${encodeURIComponent(post.playbookId!)}`} className="truncate font-medium text-brand-600 hover:underline dark:text-brand-400">
        {playbookLabel(list.data, post.playbookId!, post.playbookVersion)}
      </Link>
      {post.variant && <span className="shrink-0 rounded bg-zinc-200 px-1.5 text-xs font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">Variant {post.variant}</span>}
    </div>
  );
}

/** A stored setting as the composer shows it: option labels, Yes/No for checkboxes. */
function settingValue(field: FieldDef | undefined, v: unknown): string {
  const label = (x: unknown) => field?.options?.find((o) => o.value === String(x))?.label ?? String(x);
  if (Array.isArray(v)) return v.map(label).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v && typeof v === "object") return JSON.stringify(v);
  return label(v);
}

function PostBody({ post }: { post: PostWithLogs }) {
  const { tz, accountMap, providerMap } = useApp();
  const account = accountMap.get(post.accountId);
  const provider = providerMap.get(account?.provider ?? "");
  const fields = provider?.settingsFields ?? [];
  const settings = Object.entries(post.settings).filter(([, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
  const when = post.publishedAt ?? post.scheduledAt;
  return (
    <div className="space-y-6 p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusBadge status={post.status} />
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {post.status === "published" && post.publishedAt
            ? `Published ${formatDateTime(post.publishedAt, tz, { year: "numeric" })}`
            : post.status === "draft"
              ? `Draft · created ${formatDateTime(post.createdAt, tz)}`
              : when
                ? `${post.status === "scheduled" ? "Scheduled for" : ""} ${formatDateTime(when, tz, { weekday: "short", year: "numeric" })}`
                : null}
        </span>
        {post.attempts > 1 && <span className="text-xs text-zinc-400">{post.attempts} attempts</span>}
      </div>

      {post.status === "needs_check" ? (
        <div className="flex gap-3 rounded-lg bg-amber-50 p-3.5 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1.5">
            <p className="whitespace-pre-wrap break-words">
              {post.error || "We couldn't confirm whether the platform accepted the post. Check your profile, then mark it as published or retry."}
            </p>
            <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
              It is not retried automatically, so it cannot be posted twice by accident.
            </p>
          </div>
        </div>
      ) : post.error && (
        <div className="flex gap-3 rounded-lg bg-red-50 p-3.5 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <p className="whitespace-pre-wrap break-words">{post.error}</p>
        </div>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Preview</h3>
        {account && provider ? (
          <PlatformPreview
            key={post.id}
            account={account}
            provider={provider}
            post={post}
            time={post.status === "published" && post.publishedAt ? relativeTime(post.publishedAt) : post.status === "draft" ? "Draft" : when ? formatDateTime(when, tz) : ""}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{post.content || <span className="italic text-zinc-400">No text</span>}</p>
        )}
      </section>

      {post.playbookId && <PlaybookLine post={post} />}

      {post.status === "published" && <PostPerformance post={post} />}

      {post.campaign && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Tracked App Store link</h3>
          <PostCampaign link={post.campaign} />
        </section>
      )}

      {settings.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Settings</h3>
          <dl className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
            {settings.map(([k, v]) => (
              <div key={k} className="flex gap-4 px-3 py-2 text-sm">
                <dt className="w-32 shrink-0 text-zinc-500">{fields.find((f) => f.key === k)?.label ?? k}</dt>
                <dd className="min-w-0 break-words">{settingValue(fields.find((f) => f.key === k), v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">Publishing log</h3>
        {post.logs.length === 0 ? (
          <p className="text-sm text-zinc-400">No activity yet.</p>
        ) : (
          <ol className="relative space-y-3 border-l border-zinc-200 pl-5 dark:border-zinc-700">
            {post.logs.map((l) => (
              <li key={l.id} className="relative">
                <span
                  className={cn(
                    "absolute -left-[25px] top-1.5 size-2 rounded-full ring-4 ring-white dark:ring-zinc-900",
                    l.level === "error" ? "bg-red-500" : l.level === "warn" ? "bg-amber-500" : "bg-zinc-400",
                  )}
                />
                <p
                  className={cn(
                    "whitespace-pre-wrap break-words text-sm",
                    l.level === "error" && "text-red-700 dark:text-red-300",
                    l.level === "warn" && "text-amber-700 dark:text-amber-300",
                  )}
                >
                  {l.message}
                </p>
                <time className="text-xs text-zinc-400">{formatDateTime(l.createdAt, tz, { second: "2-digit" })}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="font-mono text-[11px] text-zinc-400">{post.id}</p>
    </div>
  );
}

function Actions({ post, onClose }: { post: PostDTO; onClose: () => void }) {
  const actions = usePostActions();
  const composer = useComposer();
  const [busy, setBusy] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const canWrite = useSession().can("posts.write");
  const wrap = (key: string, fn: () => Promise<unknown>) => async () => {
    setBusy(key);
    await fn();
    setBusy(null);
  };
  if (!canWrite) {
    return post.externalUrl ? (
      <a
        href={post.externalUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
      >
        <ExternalLink className="size-4" /> Open
      </a>
    ) : (
      <p className="text-xs text-zinc-500">Your role can view posts but not change them.</p>
    );
  }
  return (
    <>
      {EDITABLE.includes(post.status) && (
        <Button
          variant="primary"
          icon={<Pencil className="size-4" />}
          onClick={() => {
            onClose();
            composer.open({ postId: post.id });
          }}
        >
          Edit
        </Button>
      )}
      {(post.status === "failed" || post.status === "cancelled") && (
        <Button icon={<RotateCcw className="size-4" />} loading={busy === "retry"} onClick={wrap("retry", () => actions.retry(post))}>
          {post.status === "failed" ? "Retry now" : "Publish now"}
        </Button>
      )}
      {post.status === "needs_check" && (
        <>
          <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setMarking(true)}>
            Mark as published
          </Button>
          <Button icon={<RotateCcw className="size-4" />} loading={busy === "resolve"} onClick={wrap("resolve", () => actions.retryAnyway(post))}>
            Retry anyway
          </Button>
          <MarkPublishedDialog open={marking} onClose={() => setMarking(false)} onSubmit={(url) => actions.markPublished(post, url)} />
        </>
      )}
      {post.status === "scheduled" && (
        <Button icon={<Ban className="size-4" />} loading={busy === "cancel"} onClick={wrap("cancel", () => actions.cancel(post))}>
          Cancel
        </Button>
      )}
      {post.externalUrl && (
        <a
          href={post.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
        >
          <ExternalLink className="size-4" /> Open
        </a>
      )}
      <div className="flex-1" />
      <Button
        variant="ghost"
        icon={<Copy className="size-4" />}
        onClick={() => {
          onClose();
          composer.open({ duplicate: post });
        }}
      >
        Duplicate
      </Button>
      {post.status !== "publishing" && (
        <Button
          variant="ghost"
          className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
          icon={<Trash2 className="size-4" />}
          onClick={async () => {
            if (await actions.remove(post)) onClose();
          }}
        >
          Delete
        </Button>
      )}
    </>
  );
}

/** needs_check → published, with the link to the live post when the user has it. */
function MarkPublishedDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (url: string | null) => Promise<boolean> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = url.trim();
  const invalid = !!trimmed && !/^https?:\/\/\S+$/i.test(trimmed);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    const ok = await onSubmit(trimmed || null);
    setBusy(false);
    if (ok) {
      setUrl("");
      onClose();
    }
  }
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Mark as published" description="Only do this if the post is live on the platform.">
      <form onSubmit={submit}>
        <div className="p-5">
          <Field label="Post URL" help="Optional. Link to the live post, so it can be opened from Postflare." error={invalid ? "Enter an http(s) URL" : undefined}>
            {(id) => (
              <Input id={id} data-autofocus type="url" value={url} invalid={invalid} onChange={(e) => setUrl(e.target.value)} placeholder="https://" maxLength={2048} />
            )}
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={invalid}>
            Mark as published
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
