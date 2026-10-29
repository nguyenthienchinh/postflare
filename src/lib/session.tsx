import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, setApiWorkspace, WORKSPACE_NOT_FOUND_EVENT } from "./api";
import { resetMediaCache } from "./mediaCache";
import type { InstancePermission, MeDTO, MeWorkspace, WorkspacePermission } from "./types";

const STORAGE_KEY = "postflare:workspace";

export function rememberWorkspace(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled */
  }
}

function storedWorkspace(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Workspace to start in: an OAuth callback's `workspaceId`, else the last one used here, else the server's choice. */
function initialWorkspace(me: MeDTO): string | null {
  const has = (id: string | null | undefined) => !!id && me.workspaces.some((w) => w.id === id);
  const fromUrl = new URLSearchParams(window.location.search).get("workspaceId");
  if (has(fromUrl)) return fromUrl;
  const stored = storedWorkspace();
  if (has(stored)) return stored;
  return me.currentWorkspaceId ?? me.workspaces.find((w) => !w.viaAdmin)?.id ?? me.workspaces[0]?.id ?? null;
}

export interface Session {
  me: MeDTO;
  user: MeDTO["user"];
  workspaces: MeWorkspace[];
  /** Current workspace, null when the user has none. */
  workspace: MeWorkspace | null;
  can: (permission: WorkspacePermission) => boolean;
  canInstance: (permission: InstancePermission) => boolean;
  /** Switch the current workspace; every workspace-scoped view remounts and refetches. */
  switchWorkspace: (id: string) => void;
  /** Reload /api/me (after renaming/creating/leaving workspaces, profile changes...). */
  refresh: () => Promise<MeDTO | undefined>;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({
  children,
  onLogout,
  fallback,
}: {
  children: ReactNode;
  onLogout: () => void;
  fallback: (error: string | null, retry: () => void) => ReactNode;
}) {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const wsRef = useRef<string | null>(null);

  // The header must be in place before child effects fire their first requests (children's effects run first).
  const applyWorkspace = useCallback((id: string | null, persist: boolean) => {
    if (wsRef.current !== id) resetMediaCache();
    wsRef.current = id;
    setApiWorkspace(id);
    rememberWorkspace(id);
    setWorkspaceId(id);
    if (persist && id) void api.me.setWorkspace(id).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.me.get();
      setMe(data);
      setError(null);
      return data;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    }
  }, []);

  // First load: pick the starting workspace.
  useEffect(() => {
    let cancelled = false;
    setApiWorkspace(null);
    api.me
      .get()
      .then((data) => {
        if (cancelled) return;
        const id = initialWorkspace(data);
        applyWorkspace(id, !!id && id !== data.currentWorkspaceId);
        setMe(data);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [applyWorkspace]);

  // The current workspace disappeared (deleted, removed from it...): fall back to the first one still available.
  useEffect(() => {
    const onMissing = async () => {
      setApiWorkspace(null);
      const data = await refresh();
      if (!data) return;
      const next = data.workspaces.some((w) => w.id === wsRef.current)
        ? wsRef.current
        : (data.workspaces.find((w) => !w.viaAdmin)?.id ?? data.workspaces[0]?.id ?? null);
      applyWorkspace(next, !!next);
    };
    window.addEventListener(WORKSPACE_NOT_FOUND_EVENT, onMissing);
    return () => window.removeEventListener(WORKSPACE_NOT_FOUND_EVENT, onMissing);
  }, [refresh, applyWorkspace]);

  // When a refreshed /me no longer lists the current workspace, move on to another one.
  useEffect(() => {
    if (!me) return;
    if (workspaceId && me.workspaces.some((w) => w.id === workspaceId)) return;
    const next = me.workspaces.find((w) => !w.viaAdmin)?.id ?? me.workspaces[0]?.id ?? null;
    if (next !== workspaceId) applyWorkspace(next, !!next);
  }, [me, workspaceId, applyWorkspace]);

  const value = useMemo<Session | null>(() => {
    if (!me) return null;
    const workspace = me.workspaces.find((w) => w.id === workspaceId) ?? null;
    const wsPerms = new Set<string>(workspace?.permissions ?? []);
    const instPerms = new Set<string>(me.instancePermissions);
    return {
      me,
      user: me.user,
      workspaces: me.workspaces,
      workspace,
      can: (p) => wsPerms.has(p),
      canInstance: (p) => instPerms.has(p),
      switchWorkspace: (id) => {
        if (id === wsRef.current) return;
        applyWorkspace(id, true);
      },
      refresh,
      logout: async () => {
        await api.auth.logout().catch(() => {});
        // Demo visitors go back to the landing page (served at / when signed out).
        if (me.user.demo) {
          window.location.assign("/");
          return;
        }
        setApiWorkspace(null);
        resetMediaCache();
        onLogout();
      },
    };
  }, [me, workspaceId, applyWorkspace, refresh, onLogout]);

  if (!value) return <>{fallback(error, () => void refresh().then((d) => d && applyWorkspace(initialWorkspace(d), false)))}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/** Up to two initials of a name ("Ada Lovelace" -> "AL"). */
export function initials(name: string): string {
  // Parenthesized words ("Acme Studio (demo)") and words without letters or digits ("&") do not make initials.
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((w) => !w.startsWith("("))
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ""))
    .filter(Boolean);
  if (!parts.length) return "?";
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? "") : (Array.from(parts[0])[1] ?? "");
  return (first + last).toUpperCase();
}

export const isPlaceholderEmail = (email: string) => email.toLowerCase().endsWith("@postflare.local");

/** The user still has to set a real email (never the live demo's shared user). */
export const needsEmail = (user: MeDTO["user"]) => !user.demo && isPlaceholderEmail(user.email);
