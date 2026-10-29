import { useMemo } from "react";
import { providerDisplayName } from "@shared/providerNames";
import { Check, Layers, Plus } from "lucide-react";
import { Link } from "react-router";
import { GroupDot } from "../../components/accounts/AccountGroups";
import { AccountAvatar, ProviderLogo } from "../../components/ProviderLogo";
import { pickerSections, selectable, selectionState, type AccountSection } from "../../lib/accountGroups";
import { useApp } from "../../lib/app";
import { cn } from "../../lib/format";
import type { AccountDTO } from "../../lib/types";

export function AccountPicker({
  selected,
  onToggle,
  onSelectMany,
  locked,
  onNavigate,
}: {
  selected: string[];
  onToggle: (account: AccountDTO) => void;
  /** "Select all in group": select (or deselect) these accounts at once. */
  onSelectMany?: (accounts: AccountDTO[], on: boolean) => void;
  locked?: boolean;
  onNavigate: () => void;
}) {
  const { accounts, providerMap, groups } = useApp();
  const list = locked ? accounts.filter((a) => selected.includes(a.id)) : accounts;
  // By group when the workspace has groups, else by platform.
  const sections = useMemo(() => pickerSections(list, groups, (id) => providerDisplayName(id, providerMap)), [list, groups, providerMap]);

  if (!accounts.length)
    return (
      <div className="flex items-center justify-between gap-4 rounded-xl border border-dashed border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">
        <span className="text-zinc-500">No accounts connected yet.</span>
        <Link to="/accounts" onClick={onNavigate} className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400">
          <Plus className="size-4" /> Connect an account
        </Link>
      </div>
    );

  // Labels only help when there is something to tell apart (or groups to select at once).
  const labelled = !locked && (groups.length > 0 || sections.length > 1);

  return (
    <div className={cn("flex flex-wrap items-start", labelled ? "gap-x-6 gap-y-3" : "gap-x-4 gap-y-3")}>
      {sections.map((s) => (
        <div key={s.key} role="group" aria-label={s.title} className="min-w-0">
          {labelled && <SectionLabel section={s} selected={selected} onSelectMany={onSelectMany} provider={s.provider ? providerMap.get(s.provider) : undefined} />}
          <div className="flex flex-wrap items-center gap-1.5">
            {s.accounts.map((a) => {
              const provider = providerMap.get(a.provider);
              const on = selected.includes(a.id);
              const disabled = a.status === "disabled";
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={disabled || locked}
                  onClick={() => onToggle(a)}
                  aria-pressed={on}
                  title={`${a.name}${a.username ? ` (@${a.username})` : ""} · ${provider?.name ?? providerDisplayName(a.provider)}${disabled ? " · disabled" : a.status === "reconnect" ? " · needs reconnect" : ""}`}
                  className={cn(
                    "relative rounded-full p-0.5 transition disabled:cursor-not-allowed",
                    on ? "ring-2 ring-brand-500" : "ring-2 ring-transparent hover:ring-zinc-300 dark:hover:ring-zinc-600",
                    !on && !locked && "opacity-55 grayscale-[0.6] hover:opacity-100 hover:grayscale-0",
                    disabled && "!opacity-30",
                    locked && "!cursor-default",
                  )}
                >
                  <AccountAvatar account={a} provider={provider} size="lg" />
                  {on && !locked && (
                    <span className="absolute -left-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-brand-500 text-white ring-2 ring-white dark:ring-zinc-900">
                      <Check className="size-2.5" strokeWidth={3} />
                    </span>
                  )}
                  {a.status === "reconnect" && (
                    <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full bg-amber-500 ring-2 ring-white dark:ring-zinc-900" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionLabel({
  section: s,
  selected,
  onSelectMany,
  provider,
}: {
  section: AccountSection;
  selected: string[];
  onSelectMany?: (accounts: AccountDTO[], on: boolean) => void;
  provider: Parameters<typeof ProviderLogo>[0]["provider"];
}) {
  const state = selectionState(s.accounts, selected);
  const pool = selectable(s.accounts);
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-xs">
      {s.kind === "platform" ? (
        <ProviderLogo provider={provider} size="xs" />
      ) : s.kind === "group" ? (
        <GroupDot color={s.group?.color} className="size-2" />
      ) : (
        <Layers className="size-3 text-zinc-400" />
      )}
      <span className="max-w-40 truncate font-medium text-zinc-600 dark:text-zinc-300">{s.title}</span>
      {onSelectMany && pool.length > 1 && (
        <button
          type="button"
          onClick={() => onSelectMany(pool, state !== "all")}
          className="rounded px-1 font-medium text-brand-600 hover:bg-brand-50 hover:underline dark:text-brand-400 dark:hover:bg-brand-950/40"
          title={state === "all" ? `Deselect every account in ${s.title}` : `Select every account in ${s.title}`}
        >
          {state === "all" ? "None" : "All"}
        </button>
      )}
    </div>
  );
}
