import { useCallback, useEffect, useRef, useState } from "react";

/** Data tags used to refetch every hook that depends on something after a mutation. */
export type Tag = "billing" | "posts" | "accounts" | "media" | "providers" | "settings" | "keys" | "roles" | "workspaces" | "members" | "invitations" | "users" | "analytics" | "updates" | "playbooks" | "campaigns" | "devices" | "requests" | "support";

const bus = new EventTarget();

export function invalidate(...tags: Tag[]) {
  for (const t of tags) bus.dispatchEvent(new Event(t));
}

export interface FetchState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => Promise<void>;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/**
 * Tiny data-fetching hook. `key` identifies the request (pass null to skip);
 * the fetcher re-runs when the key changes, on refetch(), and when one of `tags` is invalidated.
 */
export function useFetch<T>(key: string | null, fetcher: () => Promise<T>, tags: Tag[] = []): FetchState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(key !== null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const run = useCallback(async () => {
    if (key === null) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (id === seq.current) {
        setDataState(result);
        setError(undefined);
      }
    } catch (err) {
      if (id === seq.current) setError(err as Error);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void run();
  }, [run]);

  const tagKey = tags.join(",");
  useEffect(() => {
    if (!tagKey) return;
    const handler = () => void run();
    const list = tagKey.split(",");
    for (const t of list) bus.addEventListener(t, handler);
    return () => {
      for (const t of list) bus.removeEventListener(t, handler);
    };
  }, [tagKey, run]);

  const setData = useCallback((fn: (prev: T | undefined) => T | undefined) => setDataState(fn), []);
  return { data, error, loading, refetch: run, setData };
}

/** Debounce a changing value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
