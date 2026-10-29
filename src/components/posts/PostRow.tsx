import type { ReactNode } from "react";
import { useApp } from "../../lib/app";
import { cn, truncate } from "../../lib/format";
import type { PostDTO } from "../../lib/types";
import { AccountAvatar } from "../ProviderLogo";
import { usePostDrawer } from "./PostDrawer";

/** Compact clickable row: avatar, excerpt, meta line, trailing slot. */
export function PostRow({ post, meta, trailing, className }: { post: PostDTO; meta?: ReactNode; trailing?: ReactNode; className?: string }) {
  const { accountMap, providerMap } = useApp();
  const { openPost } = usePostDrawer();
  const account = accountMap.get(post.accountId);
  const provider = account ? providerMap.get(account.provider) : undefined;
  return (
    <div className={cn("group flex items-start gap-3 px-5 py-3 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/40", className)}>
      <AccountAvatar account={account} provider={provider} size="md" className="mt-0.5" />
      <button type="button" onClick={() => openPost(post.id)} className="min-w-0 flex-1 text-left focus:outline-none">
        <p className="truncate text-sm font-medium text-zinc-900 group-hover:text-brand-700 dark:text-zinc-100 dark:group-hover:text-brand-300">
          {post.content ? truncate(post.content.replace(/\s+/g, " "), 120) : <span className="italic text-zinc-400">{post.media.length ? "Media post" : "Empty post"}</span>}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="truncate">{account?.name ?? "Deleted account"}</span>
          {meta && <span aria-hidden>·</span>}
          {meta}
        </div>
      </button>
      {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
    </div>
  );
}
