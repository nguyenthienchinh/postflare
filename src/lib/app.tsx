import { createContext, useContext, useMemo, type ReactNode } from "react";
import { api } from "./api";
import { useSession } from "./session";
import { browserTimezone } from "./time";
import type { AccountDTO, AccountGroupDTO, AppSettings, Provider } from "./types";
import { sortGroups } from "./accountGroups";
import { useFetch } from "./useFetch";

interface AppData {
  providers: Provider[];
  providerMap: Map<string, Provider>;
  accounts: AccountDTO[];
  accountMap: Map<string, AccountDTO>;
  /** Account groups of the workspace, in display order. */
  groups: AccountGroupDTO[];
  groupMap: Map<string, AccountGroupDTO>;
  settings: AppSettings | undefined;
  /** Timezone used for every date in the UI: the setting if set, else the browser zone. */
  tz: string;
  loading: { providers: boolean; accounts: boolean };
  refetchAccounts: () => Promise<void>;
  refetchProviders: () => Promise<void>;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const providers = useFetch("providers", api.providers, ["providers"]);
  const { can } = useSession();
  // Keyed by workspace in App.tsx, so this remounts (and refetches) on every workspace switch.
  const accounts = useFetch(can("accounts.read") ? "accounts" : null, api.accounts.list, ["accounts"]);
  const settings = useFetch("settings", api.settings.get, ["settings"]);
  // Counts depend on the accounts: refetched with them.
  const groups = useFetch(can("accounts.read") ? "account-groups" : null, api.accountGroups.list, ["accounts"]);

  const value = useMemo<AppData>(() => {
    const p = providers.data ?? [];
    const a = accounts.data ?? [];
    const g = sortGroups(groups.data ?? []);
    return {
      providers: p,
      providerMap: new Map(p.map((x) => [x.id, x])),
      accounts: a,
      accountMap: new Map(a.map((x) => [x.id, x])),
      groups: g,
      groupMap: new Map(g.map((x) => [x.id, x])),
      settings: settings.data,
      tz: settings.data?.timezone || browserTimezone,
      loading: { providers: providers.data === undefined, accounts: accounts.loading && accounts.data === undefined },
      refetchAccounts: accounts.refetch,
      refetchProviders: providers.refetch,
    };
  }, [providers.data, accounts.data, groups.data, settings.data, accounts.refetch, providers.refetch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppData {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp outside AppDataProvider");
  return ctx;
}
