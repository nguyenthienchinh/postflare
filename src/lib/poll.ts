import { useEffect, useRef, useState } from "react";

/**
 * Calls `fn` every `ms` while `active`, paused while the tab is hidden (and once right when it becomes visible again).
 * `fn` returning true stops the polling.
 */
export function useVisiblePoll(fn: () => Promise<boolean | void>, ms: number, active: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const tick = async () => {
      timer = undefined;
      if (stopped || document.hidden || running) return;
      running = true;
      try {
        if (await ref.current()) stopped = true;
      } catch {
        /* the next tick retries */
      } finally {
        running = false;
      }
      if (!stopped && !document.hidden) timer = setTimeout(tick, ms);
    };
    const onVisibility = () => {
      if (!document.hidden && !timer && !stopped) void tick();
    };
    timer = setTimeout(tick, ms);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms, active]);
}

/** The current time, re-rendering every `ms` (countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "2:05" */
export const countdown = (msLeft: number) => {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
