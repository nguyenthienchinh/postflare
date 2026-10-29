import type { ReactNode } from "react";
import { cn } from "../../lib/format";
import { Card } from "./Misc";

/** Settings-style card: icon, title and description on the left, content on the right. */
export function Section({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("grid gap-6 p-5 sm:p-6 lg:grid-cols-[260px_minmax(0,1fr)]", className)}>
      <div>
        <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 [&_svg]:size-[18px]">{icon}</div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </Card>
  );
}

/** Shown in place of a page the current role cannot open. */
export function Notice({ tone = "zinc", children, className }: { tone?: "zinc" | "amber" | "red"; children: ReactNode; className?: string }) {
  const tones = {
    zinc: "bg-zinc-50 text-zinc-700 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800",
    amber: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
    red: "bg-red-50 text-red-800 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900",
  };
  return <div className={cn("rounded-xl px-4 py-3 text-sm ring-1", tones[tone], className)}>{children}</div>;
}
