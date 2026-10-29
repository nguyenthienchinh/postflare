import { useApp } from "../../lib/app";
import { cn } from "../../lib/format";
import { ProviderLogo } from "../ProviderLogo";
import { Checkbox, Switch } from "../ui/Form";

/**
 * Which platforms a workspace may use: every platform (`null`) or a chosen list of provider ids. Experimental
 * platforms are listed only while experimental integrations are on (or when already chosen).
 */
export function PlatformAccessPicker({ value, onChange, disabled }: { value: string[] | null; onChange: (v: string[] | null) => void; disabled?: boolean }) {
  const { providers } = useApp();
  const list = providers.filter((p) => p.enabled || value?.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const all = value === null;
  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-start gap-3">
        <Switch checked={all} disabled={disabled} onChange={(on) => onChange(on ? null : [])} label="Every platform" />
        <span>
          <span className="block font-medium text-zinc-900 dark:text-zinc-100">Every platform</span>
          <span className="block text-zinc-500">Turn off to choose the platforms one by one.</span>
        </span>
      </label>
      {!all && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {list.map((p) => {
            const on = value.includes(p.id);
            return (
              <label
                key={p.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 ring-1 transition",
                  on ? "bg-brand-50/60 ring-brand-200 dark:bg-brand-950/30 dark:ring-brand-900" : "ring-zinc-200 hover:bg-zinc-50 dark:ring-zinc-800 dark:hover:bg-zinc-800/40",
                )}
              >
                <Checkbox checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))} />
                <ProviderLogo provider={p} size="xs" />
                <span className="truncate">{p.name}</span>
              </label>
            );
          })}
        </div>
      )}
      {!all && !value.length && <p className="text-xs text-amber-700 dark:text-amber-300">No platform chosen: no accounts can be connected.</p>}
    </div>
  );
}

/** Short summary of an allowed-providers value ("All platforms", "YouTube, TikTok"). */
export function platformAccessLabel(value: string[] | null, names: (id: string) => string): string {
  if (value === null) return "All platforms";
  if (!value.length) return "No platforms";
  return value.map(names).join(", ");
}
