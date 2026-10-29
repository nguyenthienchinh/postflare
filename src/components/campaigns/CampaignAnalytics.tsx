import { Link2 } from "lucide-react";
import { AccountAvatar, ProviderLogo } from "../ProviderLogo";
import { Card, CardHeader } from "../ui/Misc";
import { api } from "../../lib/api";
import { compactNumber, fullNumber, money } from "../../lib/format";
import type { AccountDTO, AnalyticsBreakdown, AnalyticsSummaryDTO, Provider } from "../../lib/types";
import { useFetch } from "../../lib/useFetch";
import { CampaignNote, campaignSummary } from "./bits";

/**
 * Analytics → App Store campaigns: tracked posts of the range, their clicks, installs and proceeds (revenue per
 * post), per platform and per account, plus the bio links (all time).
 */
export function CampaignAnalytics({
  s,
  providerMap,
  accounts,
  accountId,
}: {
  s: AnalyticsSummaryDTO;
  providerMap: Map<string, Provider>;
  accounts: AccountDTO[];
  accountId?: string;
}) {
  const t = s.totals;
  const bio = useFetch(`bio-links:${accountId ?? ""}`, () => api.campaigns.links({ kind: "bio", accountId }), ["campaigns", "analytics"]);
  const cur = s.currency;
  const tiles = [
    { label: "Tracked posts", value: fullNumber(t.campaignPosts) },
    { label: "Clicks", value: compactNumber(t.clicks), caption: t.campaignPosts ? `${(t.clicks / t.campaignPosts).toFixed(1)} per post` : undefined },
    { label: "Installs", value: compactNumber(t.downloads), caption: t.redownloads ? `+ ${compactNumber(t.redownloads)} redownloads` : t.clicks ? `${((t.downloads / t.clicks) * 100).toFixed(0)}% of clicks` : undefined },
    { label: "Proceeds", value: money(t.proceeds, cur, { compact: true }), caption: cur ? `Apple's estimate, ${cur}` : undefined },
    { label: "Revenue per post", value: t.campaignPosts ? money(t.proceeds / t.campaignPosts, cur) : "–" },
  ];
  const rows = (list: AnalyticsBreakdown[]) => list.filter((r) => r.campaignPosts > 0).sort((a, b) => b.proceeds - a.proceeds || b.downloads - a.downloads || b.clicks - a.clicks);
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const table = (title: string, list: AnalyticsBreakdown[], kind: "provider" | "account") =>
    list.length > 0 && (
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500 dark:text-zinc-400">
            <tr className="border-b border-zinc-100 dark:border-zinc-800">
              <th className="py-2 pr-3 font-medium">{title}</th>
              <th className="px-3 py-2 text-right font-medium">Posts</th>
              <th className="px-3 py-2 text-right font-medium">Clicks</th>
              <th className="px-3 py-2 text-right font-medium">Installs</th>
              <th className="px-3 py-2 text-right font-medium">Proceeds</th>
              <th className="py-2 pl-3 text-right font-medium">Per post</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.map((r) => {
              const account = r.accountId ? accountMap.get(r.accountId) : undefined;
              const provider = providerMap.get(r.provider);
              return (
                <tr key={r.key}>
                  <td className="py-2 pr-3">
                    <span className="flex min-w-0 items-center gap-2">
                      {kind === "account" && account ? <AccountAvatar account={account} provider={provider} size="sm" /> : <ProviderLogo provider={provider} size="sm" />}
                      <span className="truncate">{r.name}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fullNumber(r.campaignPosts)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fullNumber(r.clicks)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fullNumber(r.downloads)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.proceeds, cur)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">{money(r.proceeds / r.campaignPosts, cur)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

  return (
    <Card className="min-w-0">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Link2 className="size-4 text-zinc-400" /> App Store campaigns
          </span>
        }
        description="Posts of this period with a tracked App Store link: Postflare clicks and Apple's installs and proceeds for their campaign tokens."
      />
      <div className="space-y-6 p-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {tiles.map((tile) => (
            <div key={tile.label} className="min-w-0 rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
              <p className="truncate text-xs text-zinc-500">{tile.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{tile.value}</p>
              {tile.caption && <p className="truncate text-xs text-zinc-500">{tile.caption}</p>}
            </div>
          ))}
        </div>
        <div className="grid min-w-0 gap-6 2xl:grid-cols-2">
          {table("Platform", rows(s.byProvider), "provider")}
          {table("Account", rows(s.byAccount), "account")}
        </div>
        {!!bio.data?.length && (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Bio links (all time)</h3>
            <ul className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
              {bio.data.map((l) => {
                const a = l.accountId ? accountMap.get(l.accountId) : undefined;
                return (
                  <li key={l.code} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                    {a ? <AccountAvatar account={a} provider={providerMap.get(a.provider)} size="sm" /> : <ProviderLogo provider={providerMap.get(l.provider)} size="sm" />}
                    <span className="min-w-0 flex-1 truncate">
                      {a?.name ?? l.provider} <code className="ml-1 text-xs text-zinc-500">{l.ct}</code>
                    </span>
                    <span className="text-xs tabular-nums text-zinc-500">{campaignSummary(l)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <CampaignNote />
      </div>
    </Card>
  );
}
