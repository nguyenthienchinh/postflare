import { useEffect, useState, type FormEvent } from "react";
import { AppWindow, Download, Link2, Plus, RefreshCw, Trash2, Unplug } from "lucide-react";
import { Button, IconButton } from "../ui/Button";
import { useConfirm } from "../ui/Confirm";
import { Field, Input, Switch } from "../ui/Form";
import { Badge, Skeleton } from "../ui/Misc";
import { Notice, Section } from "../ui/Section";
import { useToast } from "../ui/Toast";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { relativeTime } from "../../lib/time";
import type { CampaignSettingsDTO } from "../../lib/types";
import { invalidate, useFetch } from "../../lib/useFetch";
import { AppIcon } from "./bits";

/** Workspace settings → App Store campaigns: provider token, auto-insert, Revflare connection, apps. */
export function CampaignSections() {
  const settings = useFetch("campaign-settings", api.campaigns.settings, ["campaigns"]);
  return (
    <>
      <CampaignSettingsSection data={settings.data} />
      <AppsSection revflare={!!settings.data?.revflare.keyConfigured} />
    </>
  );
}

function CampaignSettingsSection({ data }: { data: CampaignSettingsDTO | undefined }) {
  const { can, workspace } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const editable = can("workspace.manage");
  const [pt, setPt] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    setPt(data.providerToken ?? "");
    setUrl(data.revflare.url ?? "");
  }, [data]);

  if (!data) {
    return (
      <Section icon={<Link2 />} title="App Store campaigns" description="Tracked links and installs per post.">
        <Skeleton className="h-24 w-full" />
      </Section>
    );
  }

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const saveToken = (e: FormEvent) => {
    e.preventDefault();
    void run("pt", async () => {
      await api.campaigns.save({ providerToken: pt.trim() || null });
      toast.success("Provider token saved");
      invalidate("campaigns");
    });
  };
  const saveRevflare = (e: FormEvent) => {
    e.preventDefault();
    void run("rf", async () => {
      await api.campaigns.save({ revflareUrl: url.trim(), ...(key.trim() ? { revflareKey: key.trim() } : {}) });
      setKey("");
      toast.success("Revflare connected", "Campaign numbers sync within the hour, then every 6 hours.");
      invalidate("campaigns");
    });
  };
  const test = () =>
    run("test", async () => {
      const r = await api.campaigns.test({ ...(url.trim() ? { revflareUrl: url.trim() } : {}), ...(key.trim() ? { revflareKey: key.trim() } : {}) });
      if (r.ok) toast.success("Connection works", `${r.apps ?? 0} App Store app${r.apps === 1 ? "" : "s"} in Revflare${r.currency ? ` · ${r.currency}` : ""}`);
      else toast.error(r.error ?? "Connection failed");
    });
  const sync = () =>
    run("sync", async () => {
      const r = await api.campaigns.sync();
      toast.success("Synced", `${r.campaigns ?? 0} Postflare campaign tokens${r.asOf ? `, data up to ${r.asOf}` : ""}`);
      invalidate("campaigns", "analytics");
    });
  const disconnect = async () => {
    const ok = await confirm({ title: "Disconnect Revflare?", message: "The API key is deleted. Numbers already synced stay.", confirmLabel: "Disconnect", danger: true });
    if (ok) void run("rm", async () => {
      await api.campaigns.save({ revflareKey: null });
      invalidate("campaigns");
    });
  };
  const rf = data.revflare;

  return (
    <Section
      icon={<Link2 />}
      title="App Store campaigns"
      description={
        <>
          Posts about one of your apps get a tracked link (<code className="text-xs">{data.linkBase}…</code>) that counts clicks and opens the App Store with a campaign
          token per post and platform. Apple reports downloads and proceeds per token in App Analytics; connect Revflare to see them here.
        </>
      }
    >
      <div className="space-y-6">
        <form onSubmit={saveToken} className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
          <Field
            label="Apple provider token (pt)"
            className="flex-1"
            help={
              <>
                App Store Connect → Analytics → Acquisition → Campaigns → “Generate a campaign link”: the <code>pt=</code> number of the link. One per developer account.
              </>
            }
          >
            {(id) => <Input id={id} value={pt} onChange={(e) => setPt(e.target.value)} placeholder="123456" disabled={!editable} inputMode="numeric" maxLength={40} />}
          </Field>
          {editable && (
            <Button type="submit" variant="primary" loading={busy === "pt"} disabled={(pt.trim() || null) === data.providerToken}>
              Save
            </Button>
          )}
        </form>
        {!data.providerToken && <Notice tone="amber">Without a provider token posts can be tagged with an app, but they get no tracked link.</Notice>}

        <label className="flex max-w-xl cursor-pointer items-start gap-3">
          <Switch
            checked={data.autoLink}
            disabled={!editable || busy === "auto"}
            label="Insert tracked links automatically"
            onChange={(v) =>
              void run("auto", async () => {
                await api.campaigns.save({ autoLink: v });
                invalidate("campaigns");
              })
            }
          />
          <span className="text-sm">
            <span className="block font-medium">Insert tracked links automatically</span>
            <span className="block text-zinc-500">
              When a post is saved, App Store links of its app are replaced by the tracked link, or it is appended when the post has no link (within each platform's
              length limit). Instagram and TikTok captions are never changed: use the account's bio link there. Can be changed per post.
            </span>
          </span>
        </label>

        <form onSubmit={saveRevflare} className="max-w-xl space-y-3 border-t border-zinc-100 pt-5 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Revflare</h3>
            {rf.keyConfigured ? (
              rf.status === "error" ? (
                <Badge tone="red">Error</Badge>
              ) : rf.status === "ok" ? (
                <Badge tone="green">Connected</Badge>
              ) : (
                <Badge tone="blue">Waiting for the first sync</Badge>
              )
            ) : workspace?.demo && rf.status === "ok" ? (
              <Badge tone="violet">Sample data</Badge>
            ) : (
              <Badge>Not connected</Badge>
            )}
          </div>
          <p className="text-xs text-zinc-500">
            Optional. A Revflare API key (Revflare → Settings → API keys; any role that can read, viewer is enough) lets Postflare read Apple's App Analytics numbers per
            campaign token. Revflare needs App Analytics reports enabled for your apps.
          </p>
          {rf.message && <Notice tone={rf.status === "error" ? "red" : "zinc"}>{rf.message}</Notice>}
          {(rf.syncedAt || rf.nextSyncAt) && (
            <p className="text-xs text-zinc-500">
              {rf.syncedAt ? `Last sync ${relativeTime(rf.syncedAt)}` : "Not synced yet"}
              {rf.nextSyncAt && rf.keyConfigured ? ` · next ${relativeTime(rf.nextSyncAt)}` : ""}
              {rf.currency ? ` · proceeds in ${rf.currency}` : ""}
            </p>
          )}
          {editable && !workspace?.demo && (
            <>
              <Field label="Revflare URL">{(id) => <Input id={id} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://revflare.example.com" />}</Field>
              <Field label="API key" help={rf.keyConfigured ? "Configured. Leave empty to keep it, or paste a new one." : "Starts with rf_. Stored encrypted, never shown again."}>
                {(id) => (
                  <Input id={id} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={rf.keyConfigured ? "••••••••" : "rf_…"} />
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" loading={busy === "rf"} disabled={!url.trim() || (!rf.keyConfigured && !key.trim())}>
                  Save
                </Button>
                <Button onClick={() => void test()} loading={busy === "test"} disabled={!url.trim() || (!rf.keyConfigured && !key.trim())}>
                  Test connection
                </Button>
                {rf.keyConfigured && (
                  <>
                    <Button icon={<RefreshCw className="size-4" />} onClick={() => void sync()} loading={busy === "sync"}>
                      Sync now
                    </Button>
                    <Button variant="ghost" icon={<Unplug className="size-4" />} onClick={() => void disconnect()} loading={busy === "rm"}>
                      Disconnect
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </form>
      </div>
    </Section>
  );
}

function AppsSection({ revflare }: { revflare: boolean }) {
  const { can, workspace } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const editable = can("workspace.manage");
  const apps = useFetch("apps", api.apps.list, ["campaigns"]);
  const [storeId, setStoreId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy("add");
    try {
      const a = await api.apps.add(storeId.trim(), name.trim() || undefined);
      toast.success(`${a.name} added`);
      setStoreId("");
      setName("");
      invalidate("campaigns");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function importApps() {
    setBusy("import");
    try {
      const r = await api.apps.import();
      toast.success(`${r.imported} app${r.imported === 1 ? "" : "s"} imported from Revflare`);
      invalidate("campaigns");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section icon={<AppWindow />} title="Apps" description="The App Store apps posts can be about. Pick one in the composer (or pass appId / --app) to get tracked links.">
      <div className="space-y-4">
        {!apps.data ? (
          <Skeleton className="h-16 w-full" />
        ) : apps.data.length ? (
          <ul className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
            {apps.data.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                <AppIcon app={a} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className="truncate text-xs text-zinc-500">
                    id{a.appStoreId}
                    {a.revflareAppId ? " · from Revflare" : ""}
                  </p>
                </div>
                {editable && (
                  <IconButton
                    label={`Remove ${a.name}`}
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (!(await confirm({ title: `Remove ${a.name}?`, message: "Posts lose the app tag. Tracked links already published keep working.", confirmLabel: "Remove", danger: true }))) return;
                      try {
                        await api.apps.remove(a.id);
                        invalidate("campaigns");
                      } catch (err) {
                        toast.error(err);
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">No apps yet.</p>
        )}
        {editable && !workspace?.demo && (
          <div className="space-y-3">
            {revflare && (
              <Button icon={<Download className="size-4" />} onClick={() => void importApps()} loading={busy === "import"}>
                Import from Revflare
              </Button>
            )}
            <form onSubmit={add} className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="App Store id" className="sm:w-44" help="The number after id in apps.apple.com links.">
                {(id) => <Input id={id} value={storeId} onChange={(e) => setStoreId(e.target.value)} placeholder="1234567890" inputMode="numeric" />}
              </Field>
              <Field label="Name" className="flex-1" help="Optional: looked up on the App Store.">
                {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />}
              </Field>
              <Button type="submit" icon={<Plus className="size-4" />} loading={busy === "add"} disabled={!/^(id)?\d{5,12}$/.test(storeId.trim())}>
                Add app
              </Button>
            </form>
          </div>
        )}
      </div>
    </Section>
  );
}
