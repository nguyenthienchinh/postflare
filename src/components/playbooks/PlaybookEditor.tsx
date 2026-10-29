import { useState } from "react";
import { PLAYBOOK_FORMATS, PLAYBOOK_GOALS, PLAYBOOK_SECTIONS } from "@shared/playbooks";
import { api, errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import { FORMAT_LABEL, GOAL_LABEL } from "../../lib/playbooks";
import type { PlaybookDTO, PlaybookFormat, PlaybookGoal } from "../../lib/types";
import { invalidate } from "../../lib/useFetch";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Select, Textarea } from "../ui/Form";
import { useToast } from "../ui/Toast";

const TEMPLATE = PLAYBOOK_SECTIONS.map((s) => `## ${s}\n\n${s === "Checklist" ? "- [ ] " : ""}`).join("\n");
const splitList = (s: string, sep: RegExp) =>
  s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Create or edit a custom playbook. Saving an edit stores a NEW version (posts keep the version they were written
 * with); built-ins are never edited here (they are duplicated first).
 */
export function PlaybookEditor({ playbook, onClose, onSaved }: { playbook: PlaybookDTO | null; onClose: () => void; onSaved: (p: PlaybookDTO) => void }) {
  const toast = useToast();
  const [name, setName] = useState(playbook?.name ?? "");
  const [slug, setSlug] = useState(playbook?.slug ?? "");
  const [summary, setSummary] = useState(playbook?.summary ?? "");
  const [goal, setGoal] = useState<PlaybookGoal>(playbook?.goal ?? "engagement");
  const [platforms, setPlatforms] = useState((playbook?.platforms ?? []).join(", "));
  const [formats, setFormats] = useState<PlaybookFormat[]>(playbook?.formats ?? []);
  const [tags, setTags] = useState((playbook?.tags ?? []).join(", "));
  const [inputs, setInputs] = useState((playbook?.inputs ?? []).join("\n"));
  const [body, setBody] = useState(playbook?.body ?? TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  async function save() {
    setBusy(true);
    setErrors([]);
    const input = {
      name,
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      summary,
      goal,
      platforms: splitList(platforms, /[,\s]+/),
      formats,
      tags: splitList(tags.toLowerCase(), /,/),
      inputs: splitList(inputs, /\n/),
      body,
    };
    try {
      const saved = playbook ? await api.playbooks.update(playbook.id, input) : await api.playbooks.create(input);
      invalidate("playbooks");
      toast.success(playbook ? (saved.version > playbook.latestVersion ? `Saved as version ${saved.version}` : "Saved") : "Playbook created");
      onSaved(saved);
    } catch (err) {
      const e = err as { errors?: string[] };
      setErrors(e.errors?.length ? e.errors : [errorMessage(err)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={playbook ? `Edit ${playbook.name}` : "New playbook"}
      description={
        playbook
          ? `Saving creates version ${playbook.latestVersion + 1}. Posts written with version ${playbook.latestVersion} or older keep pointing at their version.`
          : "A recipe your team and AI agents follow to write a kind of post. Use the seven sections of the built-in playbooks."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            {playbook ? "Save new version" : "Create playbook"}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Field label="Name" required>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Weekly devlog clip" />}
          </Field>
          <Field label="Slug" help="Kebab-case handle for agents and the CLI (default: from the name).">
            {(id) => <Input id={id} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="weekly-devlog-clip" />}
          </Field>
          <Field label="Summary" help="One sentence: what it is for.">
            {(id) => <Textarea id={id} value={summary} onChange={(e) => setSummary(e.target.value.replace(/\n/g, " "))} rows={2} maxLength={300} />}
          </Field>
          <Field label="Goal">
            {(id) => (
              <Select id={id} value={goal} onChange={(e) => setGoal(e.target.value as PlaybookGoal)}>
                {PLAYBOOK_GOALS.map((g) => (
                  <option key={g} value={g}>
                    {GOAL_LABEL[g]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div>
            <p className="mb-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">Formats</p>
            <div className="flex flex-wrap gap-1.5">
              {PLAYBOOK_FORMATS.map((f) => {
                const on = formats.includes(f);
                return (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFormats((l) => (on ? l.filter((x) => x !== f) : [...l, f]))}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition",
                      on ? "bg-zinc-900 text-white ring-zinc-900 dark:bg-white dark:text-zinc-900" : "text-zinc-600 ring-zinc-200 hover:bg-zinc-100 dark:text-zinc-300 dark:ring-zinc-700",
                    )}
                  >
                    {FORMAT_LABEL[f]}
                  </button>
                );
              })}
            </div>
          </div>
          <Field label="Platforms" help="Provider ids or groups: short-video, microblog, professional, visual, all.">
            {(id) => <Input id={id} value={platforms} onChange={(e) => setPlatforms(e.target.value)} placeholder="tiktok, instagram_standalone, x" />}
          </Field>
          <Field label="Tags" help="Comma separated.">
            {(id) => <Input id={id} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="mobile-app, devlog" />}
          </Field>
          <Field label="Inputs" help="One per line: what the writer must know or ask first.">
            {(id) => <Textarea id={id} value={inputs} onChange={(e) => setInputs(e.target.value)} rows={4} placeholder={"app name\nthe feature\nstore link"} />}
          </Field>
        </div>
        <div className="flex min-h-[420px] flex-col">
          <Field label="Recipe (Markdown)" required className="flex flex-1 flex-col [&>textarea]:flex-1">
            {(id) => <Textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[420px] flex-1 font-mono text-xs leading-relaxed" spellCheck={false} />}
          </Field>
          {errors.length > 0 && (
            <div className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">
              {errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
