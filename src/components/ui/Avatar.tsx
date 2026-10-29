import { cn } from "../../lib/format";
import { initials } from "../../lib/session";

const PALETTE = [
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Round avatar with the initials of a person (or a rounded square for workspaces). */
export function InitialsAvatar({
  name,
  seed,
  size = "md",
  square,
  className,
}: {
  name: string;
  /** Stable value used to pick the color (defaults to the name). */
  seed?: string;
  size?: "xs" | "sm" | "md" | "lg";
  square?: boolean;
  className?: string;
}) {
  const sizes = { xs: "size-5 text-[9px]", sm: "size-7 text-[11px]", md: "size-9 text-xs", lg: "size-12 text-sm" };
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center font-semibold",
        square ? "rounded-lg" : "rounded-full",
        sizes[size],
        PALETTE[hash(seed ?? name) % PALETTE.length],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
