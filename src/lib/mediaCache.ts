import { useEffect, useState } from "react";
import { api } from "./api";
import type { MediaDTO } from "./types";

/** Module-level cache of media DTOs by id: posts only store ids, the UI needs urls/kinds. */
const cache = new Map<string, MediaDTO>();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let loadedAll = false;

export function rememberMedia(...items: MediaDTO[]) {
  for (const m of items) cache.set(m.id, m);
  listeners.forEach((l) => l());
}

export function forgetMedia(id: string) {
  cache.delete(id);
  listeners.forEach((l) => l());
}

/** Drop everything (the media library belongs to the workspace that was current). */
export function resetMediaCache() {
  generation++;
  cache.clear();
  loading = null;
  loadedAll = false;
  listeners.forEach((l) => l());
}

export function getMedia(id: string): MediaDTO | undefined {
  return cache.get(id);
}

let generation = 0;

async function loadMore(): Promise<void> {
  const gen = generation;
  // Pages through the library (newest first) until every requested id is known or the library ends.
  let before: number | undefined;
  for (let page = 0; page < 10; page++) {
    const batch = await api.media.list(200, before);
    if (gen !== generation) return;
    rememberMedia(...batch);
    if (batch.length < 200) {
      loadedAll = true;
      return;
    }
    before = batch[batch.length - 1].createdAt;
  }
}

/** Returns a lookup for the given media ids, loading the library once when some are unknown. */
export function useMediaLookup(ids: string[]): (id: string) => MediaDTO | undefined {
  const [, force] = useState(0);
  const missing = ids.some((id) => !cache.has(id));
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (!missing || loadedAll) return;
    loading ??= loadMore().finally(() => {
      loading = null;
    });
  }, [missing]);
  return getMedia;
}
