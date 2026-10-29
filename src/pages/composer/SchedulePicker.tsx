import { CalendarClock, Clock } from "lucide-react";
import { useApp } from "../../lib/app";
import { cn } from "../../lib/format";
import { addDays, formatDateTime, fromLocalInput, relativeTime, toLocalInput, zonedParts, zonedTime } from "../../lib/time";

/** Next round time at least 15 minutes away. */
export function defaultScheduleTime(): number {
  const d = new Date(Date.now() + 75 * 60000);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

export function SchedulePicker({ value, onChange }: { value: number; onChange: (ts: number) => void }) {
  const { tz } = useApp();
  const now = Date.now();
  const p = zonedParts(now, tz);
  const tomorrow9 = zonedTime(p.year, p.month, p.day + 1, 9, 0, tz);
  const daysToMonday = ((8 - p.weekday) % 7) || 7;
  const monday9 = zonedTime(p.year, p.month, p.day + daysToMonday, 9, 0, tz);
  const picks = [
    { label: "In 1 hour", ts: Math.ceil((now + 3600000) / 300000) * 300000 },
    { label: "Tomorrow 9:00", ts: tomorrow9 },
    { label: "Tomorrow 18:00", ts: zonedTime(p.year, p.month, p.day + 1, 18, 0, tz) },
    { label: "Monday 9:00", ts: monday9 },
    { label: "Next week", ts: addDays(value, 7, tz) },
  ];
  const past = value < now;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="relative">
        <CalendarClock className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
        <input
          type="datetime-local"
          aria-label="Schedule date and time"
          value={toLocalInput(value, tz)}
          onChange={(e) => {
            const ts = fromLocalInput(e.target.value, tz);
            if (ts !== null) onChange(ts);
          }}
          className={cn(
            "h-9 rounded-lg bg-white pl-8 pr-2 text-sm shadow-sm ring-1 ring-inset ring-zinc-300 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:bg-zinc-900 dark:ring-zinc-700 dark:[color-scheme:dark]",
            past && "ring-amber-400 dark:ring-amber-600",
          )}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {picks.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => onChange(q.ts)}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-100 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            title={formatDateTime(q.ts, tz, { weekday: "short" })}
          >
            {q.label}
          </button>
        ))}
      </div>
      <span className={cn("flex items-center gap-1 text-xs", past ? "text-amber-600 dark:text-amber-400" : "text-zinc-500")}>
        <Clock className="size-3.5" />
        {past ? "In the past: publishes right away" : relativeTime(value)} · {tz.replace(/_/g, " ")}
      </span>
    </div>
  );
}
