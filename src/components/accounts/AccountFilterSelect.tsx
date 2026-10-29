import { providerDisplayName } from "@shared/providerNames";
import { Select } from "../ui/Form";
import { groupFilterValue } from "../../lib/accountGroups";
import { useApp } from "../../lib/app";

/**
 * "All accounts" / a group / one account, for the Posts and Calendar filters. A group's value is `group:<id>`
 * (lib/accountGroups.ts parseAccountFilter).
 */
export function AccountFilterSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const { accounts, groups, providerMap } = useApp();
  const names = new Map<string, number>();
  for (const a of accounts) names.set(a.name, (names.get(a.name) ?? 0) + 1);
  // Same name on several platforms ("Party Games" on Instagram and YouTube): add the platform.
  const label = (a: (typeof accounts)[number]) => ((names.get(a.name) ?? 0) > 1 ? `${a.name} · ${providerDisplayName(a.provider, providerMap)}` : a.name);
  const options = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {label(a)}
    </option>
  ));
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Filter by account or group" className={className}>
      <option value="">All accounts</option>
      {groups.length > 0 ? (
        <>
          <optgroup label="Groups">
            {groups.map((g) => (
              <option key={g.id} value={groupFilterValue(g.id)}>
                {g.name} ({g.accountCount})
              </option>
            ))}
          </optgroup>
          <optgroup label="Accounts">{options}</optgroup>
        </>
      ) : (
        options
      )}
    </Select>
  );
}
