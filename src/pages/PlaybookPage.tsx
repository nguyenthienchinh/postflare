import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Archive, ArrowLeft, Bot, Copy, ListChecks, Pencil, PenSquare } from "lucide-react";
import { Markdown } from "../components/Markdown";
import { PlaybookEditor } from "../components/playbooks/PlaybookEditor";
import { ConfidenceBadge, LiftBar } from "../components/playbooks/PlaybookRanking";
import { Num } from "../components/analytics/bits";
import { Button } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Select } from "../components/ui/Form";
import { Badge, Card, CardHeader, CopyButton, EmptyState, Skeleton } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../lib/app";
import { percent, plural } from "../lib/format";
import { FORMAT_LABEL, GOAL_LABEL, platformLabel } from "../lib/playbooks";
import { useSession } from "../lib/session";
import { invalidate, useFetch } from "../lib/useFetch";
import { useComposer } from "./composer/ComposerProvider";

export function PlaybookPage() {
  const { id = "" } = useParams();
  const [version, setVersion] = useState<number | undefined>(undefined);
  const pb = useFetch(`playbook:${id}:${version ?? ""}`, () => api.playbooks.get(id, { version }), ["playbooks"]);
  const stats = useFetch("playbook-stats:90::", () => api.playbooks.stats({ days: 90 }), ["posts", "analytics", "playbooks"]);
  const { providerMap } = useApp();
  const { can } = useSession();
  const composer = useComposer();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = pb.data;
  const stat = stats.data?.playbooks.find((x) => x.playbookId === p?.id);

  if (pb.error) {
    return (
      <Card>
        <EmptyState title="Playbook not found" description={pb.error.message} action={<Link to="/playbooks" className="text-sm font-medium text-brand-600">Back to playbooks</Link>} />
      </Card>
    );
  }
  if (!p) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  const duplicate = async () => {
    setBusy(true);
    try {
      const copy = await api.playbooks.duplicate(p.id);
      invalidate("playbooks");
      toast.success("Duplicated", "Edit your copy: every save is a new version.");
      navigate(`/playbooks/${encodeURIComponent(copy.id)}`);
      setVersion(undefined);
      setEditing(true);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!(await confirm({ title: `Archive ${p.name}?`, message: "It leaves the library. Posts written with it keep their attribution and stay in the ranking.", confirmLabel: "Archive", danger: true }))) return;
    try {
      await api.playbooks.archive(p.id);
      invalidate("playbooks");
      navigate("/playbooks");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <Link to="/playbooks" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Playbooks
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{p.name}</h1>
            {p.builtin ? <Badge>Built-in</Badge> : <Badge tone="violet">Custom</Badge>}
            {p.archived && <Badge tone="amber">Archived</Badge>}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">{p.summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
            <Badge tone="brand">{GOAL_LABEL[p.goal]}</Badge>
            {p.formats.map((f) => (
              <Badge key={f}>{FORMAT_LABEL[f]}</Badge>
            ))}
            <span className="ml-1">{[...new Set(p.platforms.map((x) => platformLabel(x, providerMap)))].join(" · ")}</span>
            <span className="ml-1 font-mono">
              {p.id}@{p.version}
            </span>
            {p.basedOn && <span>· based on {p.basedOn}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.versions.length > 1 && (
            <Select value={String(p.version)} onChange={(e) => setVersion(Number(e.target.value) === p.latestVersion ? undefined : Number(e.target.value))} className="w-36" aria-label="Version">
              {[...p.versions].reverse().map((v) => (
                <option key={v} value={v}>
                  Version {v}
                  {v === p.latestVersion ? " (latest)" : ""}
                </option>
              ))}
            </Select>
          )}
          <CopyButton text={p.prompt} label="Copy agent prompt" className="h-9 text-sm" />
          {can("posts.write") && !p.archived && (
            <Button variant="primary" icon={<PenSquare className="size-4" />} onClick={() => composer.open({ playbook: { id: p.id, version: p.version } })}>
              Use in composer
            </Button>
          )}
          {can("playbooks.manage") &&
            (p.builtin ? (
              <Button icon={<Copy className="size-4" />} onClick={duplicate} loading={busy}>
                Duplicate & edit
              </Button>
            ) : (
              <>
                {!p.archived && p.version === p.latestVersion && (
                  <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                )}
                <Button icon={<Copy className="size-4" />} onClick={duplicate} loading={busy}>
                  Duplicate
                </Button>
                {!p.archived && (
                  <Button variant="ghost" icon={<Archive className="size-4" />} onClick={archive}>
                    Archive
                  </Button>
                )}
              </>
            ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="p-5 sm:p-7">
          <Markdown source={p.body} doc />
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Performance" description="Last 90 days, vs each account's usual" />
            <div className="p-5">
              {stat ? (
                <div className="space-y-3 text-sm">
                  <LiftBar row={stat} max={Math.max(0.25, Math.abs(stat.lift ?? 0))} />
                  <dl className="grid grid-cols-3 gap-3">
                    <div>
                      <dt className="text-xs text-zinc-500">Eng. rate</dt>
                      <dd className="font-semibold tabular-nums">{stat.medianEngagementRate === null ? "–" : percent(stat.medianEngagementRate, 2)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-500">Views</dt>
                      <dd className="font-semibold tabular-nums">
                        <Num value={stat.medianViews} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-500">Posts</dt>
                      <dd className="font-semibold tabular-nums">{stat.posts}</dd>
                    </div>
                  </dl>
                  <ConfidenceBadge value={stat.confidence} />
                  {stat.variants.length > 0 && (
                    <div className="space-y-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">A/B variants</p>
                      {stat.variants.map((v) => (
                        <div key={v.variant ?? "none"} className="flex items-center justify-between gap-2">
                          <span className="w-16 shrink-0 text-xs text-zinc-600 dark:text-zinc-400">{v.variant ?? "(none)"}</span>
                          <LiftBar row={v} max={Math.max(0.25, ...stat.variants.map((x) => Math.abs(x.lift ?? 0)))} />
                          <span className="text-xs tabular-nums text-zinc-500">{plural(v.posts, "post")}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-zinc-500">Correlational: topics, timing and media differ between posts.</p>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No published posts with metrics written with this playbook yet.</p>
              )}
            </div>
          </Card>
          {p.inputs.length > 0 && (
            <Card>
              <CardHeader title="Know before writing" />
              <ul className="list-disc space-y-1 py-4 pl-10 pr-5 text-sm text-zinc-700 marker:text-zinc-400 dark:text-zinc-300">
                {p.inputs.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <CardHeader title={<span className="flex items-center gap-1.5"><ListChecks className="size-4 text-zinc-400" /> Checklist</span>} />
            <ul className="space-y-1.5 p-5 text-sm text-zinc-700 dark:text-zinc-300">
              {p.checklist.map((c) => (
                <li key={c} className="flex gap-2">
                  <span aria-hidden className="mt-[3px] size-3.5 shrink-0 rounded border border-zinc-300 dark:border-zinc-600" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title={<span className="flex items-center gap-1.5"><Bot className="size-4 text-zinc-400" /> Agent prompt</span>} description="The recipe, your accounts and their limits, and how to attribute the post." action={<CopyButton text={p.prompt} />} />
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words p-5 font-mono text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">{p.prompt}</pre>
          </Card>
        </div>
      </div>
      {editing && !p.builtin && (
        <PlaybookEditor
          playbook={p}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setVersion(undefined);
          }}
        />
      )}
    </>
  );
}
