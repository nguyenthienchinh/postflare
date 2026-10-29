import { Api, type FetchLike } from "./api.js";
import { serverVersion } from "./compat.js";
import type { CommandDef, Parsed } from "./args.js";
import { resolveAuth, type ResolvedAuth } from "./config.js";
import { resolveAccounts, usesGroups } from "./resolve.js";
import type { AccountDTO, AccountGroupDTO, ProviderInfo } from "./types.js";

export interface Deps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Reads piped stdin (null when there is none). Injected in tests. */
  readStdin?: (implicit: boolean) => Promise<string | null>;
  /** Interactive prompt (login). */
  prompt?: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  now?: () => Date;
}

export class Ctx {
  readonly json: boolean;
  private _api?: Api;
  private _auth?: ResolvedAuth;
  private _accounts?: Promise<AccountDTO[]>;
  private _providers?: Promise<ProviderInfo[]>;
  private _groups?: Promise<AccountGroupDTO[]>;

  constructor(
    readonly parsed: Parsed,
    readonly deps: Deps,
  ) {
    this.json = !!parsed.values.json;
  }

  get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  get now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  get profileFlag(): string | undefined {
    return typeof this.parsed.values.profile === "string" ? this.parsed.values.profile : undefined;
  }

  get auth(): ResolvedAuth {
    return (this._auth ??= resolveAuth(this.profileFlag, this.env));
  }

  get api(): Api {
    if (!this._api) {
      this._api = new Api(this.auth.url, this.auth.key, this.deps.fetch);
      // Server compatibility check, in parallel with the command (main.ts prints its warning at the end).
      if (!this.env.POSTFLARE_NO_VERSION_CHECK) void serverVersion(this._api);
    }
    return this._api;
  }

  /** The API client if the command used one (for the compatibility warning). */
  get usedApi(): Api | undefined {
    return this._api;
  }

  accounts(): Promise<AccountDTO[]> {
    return (this._accounts ??= this.api.get<AccountDTO[]>("/accounts"));
  }

  groups(): Promise<AccountGroupDTO[]> {
    return (this._groups ??= this.api.get<AccountGroupDTO[]>("/account-groups"));
  }

  /** --account selectors → accounts; loads the account groups only when a `group:<name>` selector is used. */
  async resolveAccounts(selectors: string[]): Promise<AccountDTO[]> {
    const [accounts, groups] = await Promise.all([this.accounts(), usesGroups(selectors) ? this.groups() : undefined]);
    return resolveAccounts(selectors, accounts, groups);
  }

  providers(): Promise<ProviderInfo[]> {
    return (this._providers ??= this.api.get<ProviderInfo[]>("/providers"));
  }

  async provider(id: string): Promise<ProviderInfo> {
    const p = (await this.providers()).find((x) => x.id === id);
    if (!p) throw new Error(`Unknown platform ${id}`);
    return p;
  }
}

export interface Command extends CommandDef {
  run(ctx: Ctx, args: Parsed): Promise<void>;
}
