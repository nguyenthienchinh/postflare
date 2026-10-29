import { useState } from "react";
import { AppWindow, Link2 } from "lucide-react";
import { BIO_LINK_PLATFORMS, isClickable } from "@shared/campaigns";
import { BioLinkDialog } from "../../components/campaigns/bits";
import { Button } from "../../components/ui/Button";
import { Select, Switch } from "../../components/ui/Form";
import { api } from "../../lib/api";
import type { AccountDTO, Provider } from "../../lib/types";
import { useFetch } from "../../lib/useFetch";

/**
 * "About an app": tags the post with an App Store app. Clickable platforms get a tracked link (auto-inserted when
 * saving, per the workspace setting or this post's override); Instagram/TikTok get a hint to use the bio link.
 */
export function AppPicker({
  appId,
  autoLink,
  onApp,
  onAutoLink,
  accounts,
  providerOf,
}: {
  appId: string | null;
  autoLink: boolean | null;
  onApp: (id: string | null) => void;
  onAutoLink: (v: boolean | null) => void;
  accounts: AccountDTO[];
  providerOf: (a: AccountDTO) => Provider | undefined;
}) {
  const apps = useFetch("apps", api.apps.list, ["campaigns"]);
  const settings = useFetch("campaign-settings", api.campaigns.settings, ["campaigns"]);
  const [bioFor, setBioFor] = useState<AccountDTO | null>(null);
  if (!apps.data?.length && !appId) return null;
  const app = apps.data?.find((a) => a.id === appId) ?? null;
  const effective = autoLink ?? settings.data?.autoLink ?? false;
  const clickable = accounts.filter((a) => isClickable(a.provider));
  const bio = accounts.filter((a) => BIO_LINK_PLATFORMS.has(a.provider));
  const names = (list: AccountDTO[]) => [...new Set(list.map((a) => providerOf(a)?.name ?? a.provider))].join(", ");

  return (
    <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          <AppWindow className="size-3.5" /> App
        </h3>
        <Select aria-label="App Store app this post is about" value={appId ?? ""} onChange={(e) => onApp(e.target.value || null)} className="min-w-48 flex-1 sm:flex-none">
          <option value="">Not about an app</option>
          {(apps.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        {app && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={effective} onChange={(v) => onAutoLink(v === (settings.data?.autoLink ?? false) ? null : v)} label="Insert tracked link" />
            Insert tracked link
            {autoLink !== null && <span className="text-xs text-zinc-400">(this post)</span>}
          </label>
        )}
      </div>
      {app && (
        <div className="space-y-1.5 text-xs text-zinc-500">
          {!settings.data?.providerToken ? (
            <p className="text-amber-600 dark:text-amber-400">Set the Apple provider token in Workspace settings → App Store campaigns to get tracked links.</p>
          ) : clickable.length ? (
            <p className="flex gap-1.5">
              <Link2 className="mt-px size-3.5 shrink-0" />
              <span>
                Tracked link with a campaign token per post on {names(clickable)}.{" "}
                {effective
                  ? `When you save, App Store links of ${app.name} are replaced by it, or it is appended if the post has no link (only if it fits the platform's limit).`
                  : "Auto-insert is off for this post: add the link yourself after saving (shown in the post)."}
              </span>
            </p>
          ) : null}
          {bio.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span>{names(bio)} captions aren't clickable: point to the bio link instead (“link in bio”).</span>
              {bio.map((a) => (
                <Button key={a.id} size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} onClick={() => setBioFor(a)}>
                  Bio link · {a.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      {bioFor && <BioLinkDialog account={bioFor} open onClose={() => setBioFor(null)} />}
    </section>
  );
}
