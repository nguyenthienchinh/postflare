import { useState } from "react";
import { AppWindow, Info, Link2 } from "lucide-react";
import { CAMPAIGN_DATA_NOTE } from "@shared/types";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { CopyButton, Skeleton } from "../ui/Misc";
import { Notice } from "../ui/Section";
import { useToast } from "../ui/Toast";
import { api } from "../../lib/api";
import { cn, compactNumber, fullNumber, money } from "../../lib/format";
import type { AccountDTO, AppDTO, CampaignLinkDTO, CampaignResultsDTO } from "../../lib/types";
import { useFetch } from "../../lib/useFetch";

export function AppIcon({ app, className }: { app: Pick<AppDTO, "name" | "iconUrl">; className?: string }) {
  return app.iconUrl ? (
    <img src={app.iconUrl} alt="" className={cn("size-8 shrink-0 rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-700", className)} />
  ) : (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400 dark:bg-zinc-800", className)}>
      <AppWindow className="size-4" />
    </span>
  );
}

/** The note shown next to App Store numbers (delay, privacy thresholds, estimate). */
export function CampaignNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex gap-1.5 text-xs text-zinc-500", className)}>
      <Info className="mt-px size-3.5 shrink-0" />
      {CAMPAIGN_DATA_NOTE}
    </p>
  );
}

/** Clicks · installs · redownloads · proceeds of a tracked link. */
export function CampaignNumbers({ c, className }: { c: CampaignResultsDTO; className?: string }) {
  const item = (label: string, value: string, title?: string) => (
    <div title={title}>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
  const pending = c.downloads === null;
  return (
    <dl className={cn("grid grid-cols-2 gap-3 sm:grid-cols-4", className)}>
      {item("Clicks", fullNumber(c.clicks), "Postflare counts clicks on the tracked link (crawlers and link previews excluded).")}
      {item("Installs", pending ? "–" : fullNumber(c.downloads!), "First-time App Store downloads (Apple App Analytics)")}
      {item("Redownloads", pending ? "–" : fullNumber(c.redownloads ?? 0))}
      {item("Proceeds", pending ? "–" : money(c.proceeds ?? 0, c.currency), "Apple's estimate of proceeds from purchases by these users")}
    </dl>
  );
}

/** Compact "12 clicks · 3 installs · €4.20" for tables. */
export function campaignSummary(c: CampaignResultsDTO | null | undefined): string {
  if (!c) return "";
  const parts = [`${compactNumber(c.clicks)} clicks`];
  if (c.downloads !== null) parts.push(`${compactNumber(c.downloads)} installs`);
  if (c.proceeds) parts.push(money(c.proceeds, c.currency, { compact: true }));
  return parts.join(" · ");
}

/** Tracked link of a post (post drawer). */
export function PostCampaign({ link }: { link: CampaignLinkDTO }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-zinc-100 px-2 py-1.5 text-xs dark:bg-zinc-800">{link.trackedUrl}</code>
        <CopyButton text={link.trackedUrl} />
      </div>
      <p className="text-xs text-zinc-500">
        Campaign token <code>{link.ct}</code> · opens <a className="underline" href={link.appStoreUrl} target="_blank" rel="noreferrer">the App Store</a>
        {link.asOf ? ` · App Store data up to ${link.asOf}` : ""}
      </p>
      <CampaignNumbers c={link} />
      <CampaignNote />
    </div>
  );
}

/** Get / copy the bio link of an account for each app (Accounts page, composer hint). */
export function BioLinkDialog({ account, open, onClose }: { account: AccountDTO; open: boolean; onClose: () => void }) {
  const apps = useFetch(open ? "apps" : null, api.apps.list, ["campaigns"]);
  const links = useFetch(open ? `bio:${account.id}` : null, () => api.campaigns.links({ accountId: account.id, kind: "bio" }), ["campaigns"]);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const byApp = new Map((links.data ?? []).map((l) => [l.appId, l]));
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={`Bio link · ${account.name}`} description="Put it in the profile: clicks and App Store installs are tracked (campaign token pf-<platform>-bio).">
      <div className="space-y-3 p-5">
        {!apps.data || !links.data ? (
          <Skeleton className="h-16 w-full" />
        ) : !apps.data.length ? (
          <Notice>Add your apps in Workspace settings → Apps first.</Notice>
        ) : (
          apps.data.map((app) => {
            const l = byApp.get(app.id);
            return (
              <div key={app.id} className="space-y-2 rounded-xl p-3 ring-1 ring-zinc-200 dark:ring-zinc-800">
                <div className="flex items-center gap-2">
                  <AppIcon app={app} className="size-6" />
                  <span className="flex-1 truncate text-sm font-medium">{app.name}</span>
                  {!l && (
                    <Button
                      size="sm"
                      icon={<Link2 className="size-3.5" />}
                      loading={busy === app.id}
                      onClick={async () => {
                        setBusy(app.id);
                        try {
                          await api.campaigns.bioLink(account.id, app.id);
                          await links.refetch();
                        } catch (err) {
                          toast.error(err);
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Create link
                    </Button>
                  )}
                </div>
                {l && (
                  <>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-md bg-zinc-100 px-2 py-1.5 text-xs dark:bg-zinc-800">{l.trackedUrl}</code>
                      <CopyButton text={l.trackedUrl} />
                    </div>
                    <p className="text-xs text-zinc-500">{campaignSummary(l)}</p>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </Dialog>
  );
}
