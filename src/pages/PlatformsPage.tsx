import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, BookOpen, CheckCircle2, ExternalLink, Plug, Search, Trash2 } from "lucide-react";
import { CATEGORY_LABELS, CATEGORY_ORDER, ConnectDialog } from "../components/accounts/ConnectDialog";
import { Markdown } from "../components/Markdown";
import { ProviderLogo } from "../components/ProviderLogo";
import { PROVIDER_STATUS, ProviderStatusBadge } from "../components/ProviderStatusBadge";
import { Notice } from "../components/ui/Section";
import { SettingsForm, fieldErrors } from "../components/SettingsForm";
import { Button } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Input } from "../components/ui/Form";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, Tabs } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { cn, plural } from "../lib/format";
import type { Provider } from "../lib/types";
import { invalidate, useFetch } from "../lib/useFetch";

const needsApp = (p: Provider) => p.appFields.some((f) => f.required);

export function PlatformsPage() {
  const { id } = useParams();
  const { providers, providerMap, accounts, loading } = useApp();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "configured" | "todo">("all");
  const selected = id ? providerMap.get(id) : undefined;

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) m.set(a.provider, (m.get(a.provider) ?? 0) + 1);
    return m;
  }, [accounts]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = providers.filter(
      (p) =>
        (!needle || p.name.toLowerCase().includes(needle)) &&
        (filter === "all" || (filter === "configured" ? p.configured && needsApp(p) : needsApp(p) && !p.configured)),
    );
    return CATEGORY_ORDER.map((c) => ({ category: c, items: list.filter((p) => p.category === c) })).filter((g) => g.items.length);
  }, [providers, q, filter]);

  const configuredCount = providers.filter((p) => needsApp(p) && p.configured).length;

  return (
    <>
      <PageHeader
        title="Platforms"
        description={`Developer apps for OAuth platforms. ${configuredCount} configured, ${providers.filter((p) => !needsApp(p)).length} need no setup.`}
      />
      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className={cn("flex max-h-[calc(100vh-180px)] flex-col overflow-hidden lg:sticky lg:top-8", selected && "hidden lg:flex")}>
          <div className="space-y-3 border-b border-zinc-100 p-3 dark:border-zinc-800">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="pl-9" aria-label="Search platforms" />
            </div>
            <Tabs
              className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
              value={filter}
              onChange={setFilter}
              tabs={[
                { value: "all", label: "All" },
                { value: "configured", label: "Ready" },
                { value: "todo", label: "To set up" },
              ]}
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loading.providers ? (
              <div className="space-y-2 p-2">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.category} className="mb-3">
                  <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{CATEGORY_LABELS[g.category]}</p>
                  {g.items.map((p) => (
                    <Link
                      key={p.id}
                      to={`/platforms/${p.id}`}
                      title={p.enabled ? undefined : "Experimental integrations are off (Instance settings)"}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition",
                        p.id === id ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
                        !p.enabled && "opacity-60",
                      )}
                    >
                      <ProviderLogo provider={p} size="md" />
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className="truncate font-medium">{p.name}</span>
                        <ProviderStatusBadge provider={p} className="px-1.5 py-0 text-[10px]" />
                      </span>
                      {counts.get(p.id) ? <span className="text-xs tabular-nums text-zinc-400">{counts.get(p.id)}</span> : null}
                      {!needsApp(p) ? (
                        <span className="size-2 rounded-full bg-zinc-300 dark:bg-zinc-600" title="No setup needed" />
                      ) : p.configured ? (
                        <span className="size-2 rounded-full bg-emerald-500" title="Configured" />
                      ) : (
                        <span className="size-2 rounded-full bg-amber-400" title="Needs setup" />
                      )}
                    </Link>
                  ))}
                </div>
              ))
            )}
          </div>
        </Card>

        <div className={cn(!selected && "hidden lg:block")}>
          {selected ? (
            <PlatformDetail key={selected.id} provider={selected} accountCount={counts.get(selected.id) ?? 0} />
          ) : id && !loading.providers ? (
            <Card>
              <EmptyState icon={<Plug />} title="Unknown platform" description={`There is no platform called “${id}”.`} />
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon={<Plug />}
                title="Select a platform"
                description="OAuth platforms (X, LinkedIn, Meta, Google, TikTok…) need your own developer app. Pick one to see step-by-step instructions."
              />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function PlatformDetail({ provider: p, accountCount }: { provider: Provider; accountCount: number }) {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const config = useFetch(p.appFields.length ? `platform:${p.id}` : null, () => api.platforms.get(p.id));
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [connect, setConnect] = useState(false);
  useEffect(() => {
    if (config.data) setValues(config.data.values);
  }, [config.data]);

  const redirectUri = config.data?.redirectUri ?? p.redirectUri;
  const baseUrl = new URL(redirectUri).origin;
  const errors = fieldErrors(p.appFields, values);
  const app = needsApp(p);

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      await api.platforms.save(p.id, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === undefined || v === null ? "" : String(v)])));
      toast.success(`${p.name} saved`, "You can now connect accounts.");
      invalidate("providers");
      void config.refetch();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !(await confirm({
        title: `Remove the ${p.name} app?`,
        message: "Connected accounts stay, but new connections and token refreshes will fail until you configure it again.",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await api.platforms.remove(p.id);
      toast.success(`${p.name} app removed`);
      setValues({});
      invalidate("providers");
      void config.refetch();
    } catch (err) {
      toast.error(err);
    }
  }

  const cap = p.capabilities;
  return (
    <div className="space-y-6">
      <button onClick={() => navigate("/platforms")} className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 lg:hidden dark:hover:text-zinc-100">
        <ArrowLeft className="size-4" /> All platforms
      </button>
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <ProviderLogo provider={p} size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{p.name}</h2>
              <ProviderStatusBadge provider={p} showVerified />
              {!app ? <Badge>No app needed</Badge> : p.configured ? <Badge tone="green" dot>Configured</Badge> : <Badge tone="amber" dot>Needs setup</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-zinc-500">
              {CATEGORY_LABELS[p.category]} · {p.auth === "oauth2" ? "OAuth" : "Credentials"} · {plural(accountCount, "account")} connected
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              <Badge>{cap.maxLength.toLocaleString()} chars</Badge>
              {cap.media.images > 0 && <Badge>{plural(cap.media.images, "image")}</Badge>}
              {cap.media.videos > 0 && <Badge>{plural(cap.media.videos, "video")}</Badge>}
              {cap.media.required && <Badge tone="amber">Media required</Badge>}
              {cap.thread && <Badge tone="violet">{cap.threadLabel ?? "Follow-ups"}</Badge>}
            </div>
          </div>
          <Button variant={p.configured && p.enabled ? "primary" : "secondary"} disabled={!p.configured || !p.enabled} onClick={() => setConnect(true)}>
            Connect account
          </Button>
        </div>
        {(p.status !== "verified" || p.statusNote) && (
          <Notice tone={p.status === "experimental" ? "amber" : "zinc"} className="mt-4">
            {p.statusNote && <strong className="font-medium">{p.statusNote}. </strong>}
            {PROVIDER_STATUS[p.status].help}
            {!p.enabled && (
              <>
                {" "}
                New connections are off:{" "}
                <Link to="/admin/settings#integrations" className="font-medium underline">
                  enable experimental integrations
                </Link>
                {accountCount > 0 && "; connected accounts keep publishing"}.
              </>
            )}
          </Notice>
        )}
      </Card>

      {p.appFields.length > 0 && (
        <Card>
          <div className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <h3 className="text-sm font-semibold">Redirect URI</h3>
            <p className="mt-0.5 text-sm text-zinc-500">Add this exact URL to the allowed callback / redirect URLs of your {p.name} app.</p>
            <div className="mt-3 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs dark:bg-zinc-800">{redirectUri}</code>
              <CopyButton text={redirectUri} />
            </div>
            {p.dataDeletionUri && (
              <>
                <h3 className="mt-4 text-sm font-semibold">Data deletion callback URL</h3>
                <p className="mt-0.5 text-sm text-zinc-500">
                  Paste this in your Meta app&rsquo;s <em>Data deletion request URL</em> (choose &ldquo;Data deletion callback URL&rdquo;). Meta calls it when someone removes the app and asks for their data to be deleted; their connected accounts are then removed here.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs dark:bg-zinc-800">{p.dataDeletionUri}</code>
                  <CopyButton text={p.dataDeletionUri} />
                </div>
              </>
            )}
          </div>
          <div className="grid gap-6 p-5 xl:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Setup steps</h3>
                {p.docsUrl && (
                  <a href={p.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                    <BookOpen className="size-4" /> Developer portal <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
              {p.setupNotes ? (
                <Markdown source={p.setupNotes} vars={{ redirectUri, baseUrl }} />
              ) : (
                <p className="text-sm text-zinc-500">Create an app in the {p.name} developer portal, set the redirect URI above and paste the credentials here.</p>
              )}
            </div>
            <form onSubmit={save} className="min-w-0 rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-200 dark:bg-zinc-950/40 dark:ring-zinc-800">
              <h3 className="mb-4 text-sm font-semibold">App credentials</h3>
              {config.loading && !config.data ? (
                <div className="space-y-3">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (
                <SettingsForm
                  className="!grid-cols-1"
                  fields={p.appFields}
                  values={values}
                  onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
                  errors={errors}
                  showErrors={touched}
                />
              )}
              <div className="mt-5 flex items-center gap-2">
                <Button type="submit" variant="primary" loading={busy}>
                  {p.configured ? "Save changes" : "Save"}
                </Button>
                {p.configured && app && (
                  <Button variant="ghost" className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" icon={<Trash2 className="size-4" />} onClick={remove}>
                    Remove
                  </Button>
                )}
                {p.configured && app && (
                  <span className="ml-auto hidden items-center gap-1 whitespace-nowrap text-xs text-emerald-600 sm:flex dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5" /> Stored encrypted
                  </span>
                )}
              </div>
            </form>
          </div>
        </Card>
      )}

      {p.appFields.length === 0 && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold">No developer app needed</h3>
          <p className="mt-1 text-sm text-zinc-500">
            {p.auth === "credentials"
              ? `Connect ${p.name} directly with ${p.credentialFields.map((f) => f.label.toLowerCase()).join(", ") || "its credentials"}.`
              : `Connect ${p.name} directly from the Accounts page.`}
          </p>
          {p.setupNotes && (
            <div className="mt-4">
              <Markdown source={p.setupNotes} vars={{ redirectUri, baseUrl }} />
            </div>
          )}
        </Card>
      )}
      <ConnectDialog open={connect} onClose={() => setConnect(false)} initialProvider={p.id} />
    </div>
  );
}
