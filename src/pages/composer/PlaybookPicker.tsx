import { useState } from "react";
import { Link } from "react-router";
import { BookOpenText, Bot, ChevronDown, ExternalLink } from "lucide-react";
import { Markdown } from "../../components/Markdown";
import { Input, Select } from "../../components/ui/Form";
import { CopyButton, Skeleton } from "../../components/ui/Misc";
import { api } from "../../lib/api";
import { cn } from "../../lib/format";
import { GOAL_LABEL, usePlaybookList } from "../../lib/playbooks";
import { useFetch } from "../../lib/useFetch";

export interface PlaybookRef {
  id: string;
  version: number;
}

/** "Playbook" field of the composer: which recipe the post follows (attribution for the ranking) and its A/B label. */
export function PlaybookPicker({
  value,
  variant,
  onChange,
  onVariant,
  onNavigate,
}: {
  value: PlaybookRef | null;
  variant: string;
  onChange: (v: PlaybookRef | null) => void;
  onVariant: (v: string) => void;
  onNavigate?: () => void;
}) {
  const list = usePlaybookList();
  const items = list.data ?? [];
  const current = value ? items.find((p) => p.id === value.id) : undefined;
  const builtins = items.filter((p) => p.builtin);
  const custom = items.filter((p) => !p.builtin);
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          <BookOpenText className="size-3.5" /> Playbook
        </h3>
        {value && (
          <Link to={`/playbooks/${encodeURIComponent(value.id)}`} onClick={onNavigate} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            Open <ExternalLink className="size-3" />
          </Link>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select
          value={value?.id ?? ""}
          onChange={(e) => {
            const p = items.find((x) => x.id === e.target.value);
            onChange(p ? { id: p.id, version: p.version } : null);
          }}
          className="flex-1"
          aria-label="Playbook"
        >
          <option value="">No playbook</option>
          {value && !current && (
            <option value={value.id}>
              {value.id} v{value.version}
            </option>
          )}
          {custom.length > 0 && (
            <optgroup label="This workspace">
              {custom.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (v{p.version})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Built-in">
            {builtins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {GOAL_LABEL[p.goal]}
              </option>
            ))}
          </optgroup>
        </Select>
        {value && (
          <Input value={variant} onChange={(e) => onVariant(e.target.value.slice(0, 32))} placeholder="A/B variant (optional)" className="sm:w-48" aria-label="A/B variant" />
        )}
      </div>
      {value && current && current.version !== value.version && (
        <p className="mt-1.5 text-xs text-zinc-500">
          Uses version {value.version}; the latest is {current.version}.{" "}
          <button type="button" className="font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => onChange({ id: value.id, version: current.version })}>
            Switch to latest
          </button>
        </p>
      )}
    </section>
  );
}

/** Side panel of the composer: the playbook's checklist (ticked locally), and its recipe and agent prompt. */
export function PlaybookPanel({ value }: { value: PlaybookRef }) {
  const pb = useFetch(`playbook:${value.id}:${value.version}`, () => api.playbooks.get(value.id, { version: value.version }), ["playbooks"]);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [show, setShow] = useState<"" | "recipe" | "prompt">("");
  const p = pb.data;
  if (pb.error) return <p className="text-xs text-red-600">{pb.error.message}</p>;
  if (!p) return <Skeleton className="h-40 w-full rounded-xl" />;
  const n = p.checklist.filter((c) => done[c]).length;
  return (
    <div className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{p.name}</p>
          <p className="text-xs text-zinc-500">
            {GOAL_LABEL[p.goal]} · v{p.version} · checklist {n}/{p.checklist.length}
          </p>
        </div>
        <CopyButton text={p.prompt} label="Prompt" />
      </div>
      <ul className="space-y-1">
        {p.checklist.map((c) => (
          <li key={c}>
            <label className="flex cursor-pointer gap-2 rounded-md px-1 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/50">
              <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-brand-600" checked={!!done[c]} onChange={(e) => setDone((d) => ({ ...d, [c]: e.target.checked }))} />
              <span className={cn(done[c] && "text-zinc-400 line-through")}>{c}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
        {(["recipe", "prompt"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setShow((s) => (s === k ? "" : k))}
            className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800", show === k && "bg-zinc-100 dark:bg-zinc-800")}
            aria-expanded={show === k}
          >
            {k === "prompt" ? <Bot className="size-3.5" /> : <BookOpenText className="size-3.5" />}
            {k === "prompt" ? "Agent prompt" : "Recipe"}
            <ChevronDown className={cn("size-3 transition", show === k && "rotate-180")} />
          </button>
        ))}
      </div>
      {show === "recipe" && (
        <div className="max-h-96 overflow-y-auto pr-1 [&_div]:text-xs">
          <Markdown source={p.body} doc />
        </div>
      )}
      {show === "prompt" && <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">{p.prompt}</pre>}
    </div>
  );
}
