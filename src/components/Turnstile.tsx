import { useEffect, useRef } from "react";

/** Cloudflare Turnstile's widget API (explicit rendering): https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/ */
interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

/** Loads api.js once, on demand (only pages that show the widget pay for it). */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load")));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Could not load the bot check (challenges.cloudflare.com)"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Cloudflare Turnstile widget (bot check). `onToken` gets the token once solved and null when it expires or fails
 * (the widget refreshes expired tokens by itself). Change `resetKey` after each failed submit: tokens are single use.
 * The theme follows the system color scheme, like the app.
 */
export function Turnstile({
  siteKey,
  action,
  onToken,
  onError,
  resetKey = 0,
}: {
  siteKey: string;
  action: "signup" | "magic_link" | "login" | "app_login" | "apply";
  onToken: (token: string | null) => void;
  onError?: (message: string) => void;
  resetKey?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  // The latest callbacks without re-rendering the widget when the parent re-renders.
  const cb = useRef({ onToken, onError });
  cb.current = { onToken, onError };

  useEffect(() => {
    let cancelled = false;
    // A new widget has no token yet (an earlier one may have been spent).
    cb.current.onToken(null);
    loadTurnstile().then(
      (ts) => {
        if (cancelled || !ref.current) return;
        widget.current = ts.render(ref.current, {
          sitekey: siteKey,
          action,
          theme: "auto",
          size: "flexible",
          callback: (token: string) => cb.current.onToken(token),
          "expired-callback": () => cb.current.onToken(null),
          "timeout-callback": () => cb.current.onToken(null),
          "error-callback": () => {
            cb.current.onToken(null);
            cb.current.onError?.("The bot check could not run. Reload the page and try again.");
          },
        });
      },
      (err: Error) => cb.current.onError?.(err.message),
    );
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, action]);

  useEffect(() => {
    if (!resetKey || !widget.current) return;
    cb.current.onToken(null);
    window.turnstile?.reset(widget.current);
  }, [resetKey]);

  // The managed widget is ~65px tall: reserve the space so the form does not jump when it appears.
  return <div ref={ref} className="min-h-[65px]" />;
}
