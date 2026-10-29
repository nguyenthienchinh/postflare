import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { BookOpenText, Plus, Search, Terminal } from "lucide-react";
import { PLAYBOOK_FORMATS, PLAYBOOK_GOALS, matchesPlatform } from "@shared/playbooks";
import { PlaybookEditor } from "../components/playbooks/PlaybookEditor";
import { ConfidenceBadge, PlaybookRanking } from "../components/playbooks/PlaybookRanking";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Form";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Tabs } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { cn } from "../lib/format";
import { FORMAT_LABEL, GOAL_LABEL, PLATFORM_GROUPS, liftText, platformChip, usePlaybookList } from "../lib/playbooks";
import { useSession } from "../lib/session";
import type { PlaybookStatsDTO, PlaybookSummaryDTO } from "../lib/types";
import { useDebounced, useFetch } from "../lib/useFetch";

type Tab = "library" | "ranking";
type Source = "" | "builtin" | "custom";

export function PlaybooksPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") === "ranking" ? "ranking" : "library") as Tab;
  const { can } = useSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === "ranking") next.set("tab", t);
    else next.delete("tab");
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Playbooks"
        description="Recipes for posts that perform. Your AI agent finds them over MCP and the CLI; posts written with one are ranked by their results."
        actions={
          can("playbooks.manage") && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New playbook
            </Button>
          )
        }
      />
      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "library", label: "Library" },
          { value: "ranking", label: "Ranking" },
        ]}
      />
      {tab === "library" ? <Library /> : <PlaybookRanking />}
      {creating && <PlaybookEditor playbook={null} onClose={() => setCreating(false)} onSaved={(p) => navigate(`/playbooks/${encodeURIComponent(p.id)}`)} />}
    </>
  );
}

function Library() {
  const { providerMap, providers, accounts } = useApp();
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("");
  const [goal, setGoal] = useState("");
  const [format, setFormat] = useState("");
  const [source, setSource] = useState<Source>("");
  const query = useDebounced(q.trim(), 200);
  const all = usePlaybookList();
  // Text search runs on the server (scored over the whole body); the other filters are applied here.
  const searched = useFetch(query ? `playbooks:q:${query}` : null, () => api.playbooks.list({ q: query }), ["playbooks"]);
  const stats = useFetch("playbook-stats:90::", () => api.playbooks.stats({ days: 90 }), ["posts", "analytics", "playbooks"]);
  const byId = useMemo(() => new Map((stats.data?.playbooks ?? []).map((p) => [p.playbookId!, p])), [stats.data]);
  const connected = useMemo(() => [...new Set(accounts.map((a) => a.provider))], [accounts]);

  const base = query ? searched.data : all.data;
  const list = useMemo(
    () =>
      (base ?? []).filter(
        (p) =>
          (!platform || matchesPlatform(p.platforms, platform)) &&
          (!goal || p.goal === goal) &&
          (!format || p.formats.includes(format as never)) &&
          (!source || (source === "builtin") === p.builtin),
      ),
    [base, platform, goal, format, source],
  );

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: launch, game clip, thread…" className="pl-9" aria-label="Search playbooks" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-48" aria-label="Platform">
            <option value="">All platforms</option>
            <optgroup label="Groups">
              {Object.entries(PLATFORM_GROUPS)
                .filter(([k]) => k !== "all")
                .map(([k, g]) => (
                  <option key={k} value={k}>
                    {g.label}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Platforms">
              {providers
                .filter((p) => connected.includes(p.id) || ["x", "bluesky", "threads", "instagram_standalone", "tiktok", "youtube", "linkedin", "facebook", "pinterest", "reddit", "mastodon"].includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </optgroup>
          </Select>
          <Select value={goal} onChange={(e) => setGoal(e.target.value)} className="w-36" aria-label="Goal">
            <option value="">Any goal</option>
            {PLAYBOOK_GOALS.map((g) => (
              <option key={g} value={g}>
                {GOAL_LABEL[g]}
              </option>
            ))}
          </Select>
          <Select value={format} onChange={(e) => setFormat(e.target.value)} className="w-36" aria-label="Format">
            <option value="">Any format</option>
            {PLAYBOOK_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </Select>
          <Select value={source} onChange={(e) => setSource(e.target.value as Source)} className="w-44" aria-label="Source">
            <option value="">Built-in & custom</option>
            <option value="builtin">Built-in</option>
            <option value="custom">Custom</option>
          </Select>
        </div>
      </div>

      {!base ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : !list.length ? (
        <Card>
          <EmptyState icon={<BookOpenText />} title="No playbook matches" description="Try other words or fewer filters." />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => (
            <PlaybookCard key={p.id} p={p} providerMap={providerMap} stat={byId.get(p.id)} />
          ))}
        </div>
      )}

      <Card className="mt-6 flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <Terminal className="size-[18px]" />
        </div>
        <div className="min-w-0 text-sm text-zinc-600 dark:text-zinc-400">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">Using an AI agent?</p>
          <p>
            MCP: <code className="font-mono text-xs">search_playbooks</code> → <code className="font-mono text-xs">get_playbook</code> → <code className="font-mono text-xs">create_post</code> with{" "}
            <code className="font-mono text-xs">playbookId</code>. CLI: <code className="font-mono text-xs">pf playbooks search launch</code>,{" "}
            <code className="font-mono text-xs">pf playbooks show &lt;id&gt; --prompt</code>, <code className="font-mono text-xs">pf post --playbook &lt;id&gt;@1</code>.
          </p>
        </div>
      </Card>
    </>
  );
}

function PlaybookCard({ p, providerMap, stat }: { p: PlaybookSummaryDTO; providerMap: ReturnType<typeof useApp>["providerMap"]; stat?: PlaybookStatsDTO["playbooks"][number] }) {
  return (
    <Link
      to={`/playbooks/${encodeURIComponent(p.id)}`}
      className="group flex flex-col rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 transition hover:ring-zinc-300 hover:shadow dark:bg-zinc-900 dark:ring-zinc-800 dark:hover:ring-zinc-700"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-zinc-900 group-hover:text-brand-600 dark:text-zinc-50 dark:group-hover:text-brand-400">{p.name}</h3>
        {p.builtin ? <Badge>Built-in</Badge> : <Badge tone="violet">Custom · v{p.version}</Badge>}
      </div>
      <p className="mt-1.5 line-clamp-3 flex-1 text-sm text-zinc-600 dark:text-zinc-400">{p.summary || <span className="italic text-zinc-400">No summary</span>}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge tone="brand">{GOAL_LABEL[p.goal]}</Badge>
        {p.formats.map((f) => (
          <Badge key={f}>{FORMAT_LABEL[f]}</Badge>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
        <span className="truncate">{[...new Set(p.platforms.map((x) => platformChip(x, providerMap)))].join(" · ") || "Any platform"}</span>
        {stat && (
          <span className={cn("flex shrink-0 items-center gap-1.5")} title={`${stat.posts} posts in the last 90 days`}>
            <span className="font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">{liftText(stat.lift)}</span>
            <ConfidenceBadge value={stat.confidence} />
          </span>
        )}
      </div>
    </Link>
  );
}
