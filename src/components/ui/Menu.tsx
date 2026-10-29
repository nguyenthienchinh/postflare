import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/format";

/**
 * Small dropdown menu (same look as the workspace switcher). `trigger` gets the props to spread on its button;
 * `children` gets `close`. Closes on outside click and Escape, and opens upwards when there is no room below.
 */
export function Menu({
  trigger,
  children,
  align = "right",
  className,
  width = "w-56",
}: {
  trigger: (props: { onClick: () => void; "aria-haspopup": "menu"; "aria-expanded": boolean }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !ref.current || !panel.current) return;
    const r = ref.current.getBoundingClientRect();
    const h = panel.current.offsetHeight;
    setUp(r.bottom + h + 12 > window.innerHeight && r.top > h + 12);
    panel.current.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled)")?.focus();
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div ref={ref} className={cn("relative", className)}>
      {trigger({ onClick: () => setOpen((o) => !o), "aria-haspopup": "menu", "aria-expanded": open })}
      {open && (
        <div
          ref={panel}
          role="menu"
          onKeyDown={onKeyDown}
          className={cn(
            "absolute z-40 max-h-80 animate-pop overflow-y-auto rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700",
            width,
            align === "right" ? "right-0" : "left-0",
            up ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  icon,
  checked,
  danger,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  icon?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors focus-visible:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:bg-zinc-800",
        danger ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800",
      )}
    >
      {icon && <span className="flex size-4 shrink-0 items-center justify-center text-zinc-400 [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <Check className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{children}</p>;
}

export function MenuSeparator() {
  return <div className="my-1.5 border-t border-zinc-100 dark:border-zinc-800" />;
}
