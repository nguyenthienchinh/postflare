import type { ProviderContext } from "./types";

/**
 * Workers Free plan: every workflow step is one invocation with 50 external subrequests. A single publish /
 * checkStatus / reply keeps to this many fetches, leaving room for a token refresh before it.
 */
export const MAX_FETCHES = 40;

export interface CountedContext extends ProviderContext {
  /** Fetches made through this context so far. */
  readonly used: number;
  /** Fetches still allowed in this call. */
  left(): number;
}

/** Wrap `ctx` so its fetches are counted against `limit`. Use `left()` to stop loops (uploads, polling) in time. */
export function counted(ctx: ProviderContext, limit = MAX_FETCHES): CountedContext {
  let used = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    used++;
    return ctx.fetch(input, init);
  };
  // Prototype-inherit the rest of ctx (media, log, app...) so the wrapper stays in sync with it.
  return Object.create(ctx, {
    fetch: { value: fetch },
    used: { get: () => used },
    left: { value: () => limit - used },
  }) as CountedContext;
}

/** Fetches still allowed for `ctx`: `left()` of a counted context, else MAX_FETCHES. */
export function fetchesLeft(ctx: ProviderContext): number {
  const left = (ctx as Partial<CountedContext>).left;
  return typeof left === "function" ? left() : MAX_FETCHES;
}
