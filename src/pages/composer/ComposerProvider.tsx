import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useSession } from "../../lib/session";
import type { PostDTO } from "../../lib/types";

export interface ComposerOptions {
  /** Prefill the schedule time (ms). */
  at?: number;
  /** Edit an existing post. */
  postId?: string;
  /** Start a new post from an existing one. */
  duplicate?: PostDTO;
  accountIds?: string[];
  /** Write the post with this playbook (attribution + checklist and prompt in the side panel). */
  playbook?: { id: string; version: number };
}

interface ComposerApi {
  open: (o: ComposerOptions) => void;
}

const Ctx = createContext<ComposerApi | null>(null);
const Composer = lazy(() => import("./Composer"));

export function ComposerProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<(ComposerOptions & { key: number }) | null>(null);
  const canWrite = useSession().can("posts.write");
  // Without posts.write the composer never opens (its buttons are hidden too).
  const open = useCallback((o: ComposerOptions) => canWrite && setOpts({ ...o, key: Date.now() }), [canWrite]);
  const api = useMemo(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {opts && (
        <Suspense fallback={null}>
          <Composer key={opts.key} options={opts} onClose={() => setOpts(null)} />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}

export function useComposer(): ComposerApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useComposer outside ComposerProvider");
  return ctx;
}
