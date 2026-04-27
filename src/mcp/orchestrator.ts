// Orchestrator — wires Account registry + Vault + Connector + Cache.
// Eng review 4A.1 (parallel fetch): get holdings across N accounts via Promise.all.
// Eng review 4A.2 (in-flight dedup): when MCP host fans out tool calls, multiple
//   simultaneous requests for the same cache key share one Promise. Stops
//   3x duplicated upstream API calls per Claude conversation.
// Eng review 1F (per-connector TTL): cache layer enforces TTL, force=true bypasses.

import { defaultAccountStore, type AccountStore } from "../accounts.ts";
import { Cache, defaultCache } from "../cache.ts";
import { BybitConnector } from "../connectors/bybit.ts";
import { MetaMaskConnector } from "../connectors/metamask.ts";
import { PolymarketConnector } from "../connectors/polymarket.ts";
import type { Connector, ConnectorContext } from "../connectors/types.ts";
import { defaultVault, type Vault } from "../vault.ts";
import type { Account, ConnectorId, Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";

const CONNECTOR_FACTORIES: Record<ConnectorId, () => Connector> = {
  bybit: () => new BybitConnector(),
  metamask: () => new MetaMaskConnector(),
  polymarket: () => new PolymarketConnector(),
};

export interface OrchestratorOptions {
  accountStore?: AccountStore;
  vault?: Vault;
  cache?: Cache;
  // Pre-populated connector instances. Bypasses the lazy factory.
  // Used by tests to inject stubs without mocking the module.
  connectorOverrides?: Partial<Record<ConnectorId, Connector>>;
}

interface FetchOptions {
  force?: boolean;       // bypass cache, force fresh fetch
  signal?: AbortSignal;
}

// Aggregated result type — partial failures are surfaced separately so callers
// can decide whether to show "missing data" warnings vs hard errors.
export interface AggregateResult<T> {
  data: T[];
  failures: Array<{ accountId: string; error: string }>;
}

export class Orchestrator {
  private accountStore: AccountStore;
  private vault: Vault;
  private cache: Cache;
  private connectors: Map<ConnectorId, Connector> = new Map();
  // In-flight Promise dedup (eng review 4A.2). Keyed by cache key.
  private inFlight: Map<string, Promise<unknown>> = new Map();

  constructor(opts: OrchestratorOptions = {}) {
    this.accountStore = opts.accountStore ?? defaultAccountStore();
    this.vault = opts.vault ?? defaultVault();
    this.cache = opts.cache ?? defaultCache();
    if (opts.connectorOverrides) {
      for (const [id, conn] of Object.entries(opts.connectorOverrides)) {
        if (conn) this.connectors.set(id as ConnectorId, conn);
      }
    }
  }

  private getConnector(id: ConnectorId): Connector {
    let c = this.connectors.get(id);
    if (!c) {
      c = CONNECTOR_FACTORIES[id]();
      this.connectors.set(id, c);
    }
    return c;
  }

  /**
   * Fetch holdings across one or many accounts.
   * If accountIds is empty/undefined, fetches all configured accounts.
   * Per-account fetches run in parallel (eng review 4A.1).
   */
  async getHoldings(
    accountIds: string[] | undefined,
    opts: FetchOptions = {}
  ): Promise<AggregateResult<Holding>> {
    const accounts = this.resolveAccounts(accountIds);
    return this.aggregate(accounts, "holdings", opts, (ctx, conn) =>
      conn.fetchHoldings(ctx)
    );
  }

  async getTransactions(
    accountIds: string[] | undefined,
    since: number | undefined,
    opts: FetchOptions = {}
  ): Promise<AggregateResult<Transaction>> {
    const accounts = this.resolveAccounts(accountIds);
    const cacheKeyExtra = since ? `:since=${since}` : "";
    return this.aggregate(accounts, `transactions${cacheKeyExtra}`, opts, (ctx, conn) =>
      conn.fetchTransactions(ctx, since)
    );
  }

  /**
   * Invalidate cache for one connector (all keys) or all connectors.
   */
  refresh(connectorId?: ConnectorId): void {
    if (connectorId) {
      this.cache.invalidate(connectorId);
    } else {
      this.cache.invalidateAll();
    }
  }

  listAccounts(connectorId?: ConnectorId): Account[] {
    return connectorId ? this.accountStore.listByConnector(connectorId) : this.accountStore.list();
  }

  private resolveAccounts(accountIds: string[] | undefined): Account[] {
    if (!accountIds || accountIds.length === 0) {
      return this.accountStore.list();
    }
    const accounts: Account[] = [];
    for (const id of accountIds) {
      const a = this.accountStore.get(id);
      if (a) accounts.push(a);
    }
    return accounts;
  }

  /**
   * Generic per-account fan-out + cache check + in-flight dedup wrapper.
   * Single source of truth for the "fetch via connector with caching" pattern.
   */
  private async aggregate<T>(
    accounts: Account[],
    kind: string,
    opts: FetchOptions,
    fetcher: (ctx: ConnectorContext, conn: Connector) => Promise<Result<T[]>>
  ): Promise<AggregateResult<T>> {
    if (accounts.length === 0) {
      return { data: [], failures: [] };
    }

    const perAccount = await Promise.all(
      accounts.map(async (account) => {
        const result = await this.fetchForAccount(account, kind, opts, fetcher);
        return { account, result };
      })
    );

    const data: T[] = [];
    const failures: AggregateResult<T>["failures"] = [];
    for (const { account, result } of perAccount) {
      if (!result.ok) {
        failures.push({ accountId: account.id, error: `${result.error.kind}: ${result.error.message}` });
        continue;
      }
      data.push(...result.value);
    }
    return { data, failures };
  }

  private async fetchForAccount<T>(
    account: Account,
    kind: string,
    opts: FetchOptions,
    fetcher: (ctx: ConnectorContext, conn: Connector) => Promise<Result<T[]>>
  ): Promise<Result<T[]>> {
    const cacheKey = `${account.id}:${kind}`;
    const connector = this.getConnector(account.connectorId);

    // Cache lookup unless force-refresh requested.
    if (!opts.force) {
      const cached = this.cache.get<T[]>(account.connectorId, cacheKey);
      if (cached && !cached.stale) {
        return ok(cached.value);
      }
    }

    // In-flight dedup: if another caller is already fetching this key, await theirs.
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing as Promise<Result<T[]>>;
    }

    const promise = (async (): Promise<Result<T[]>> => {
      try {
        const credsResult = await this.vault.get(
          account.connectorId,
          this.accountIdentifier(account)
        );
        if (!credsResult.ok) return credsResult;

        // Merge account.metadata.customTokens into the credentials so the
        // connector sees them via creds.customTokens (its existing interface)
        // without ever storing token contracts in the secret vault. Tokens
        // are public on-chain data, not secrets — Account.metadata is the
        // right home for them.
        const customTokens = account.metadata?.customTokens;
        const credentials =
          customTokens && typeof customTokens === "object"
            ? { ...credsResult.value, customTokens }
            : credsResult.value;

        const ctx: ConnectorContext = {
          account,
          credentials,
          signal: opts.signal,
        };

        const fetchResult = await fetcher(ctx, connector);

        if (fetchResult.ok) {
          this.cache.set(account.connectorId, cacheKey, fetchResult.value);
        } else {
          // On rate_limited / network failure, fall back to stale cache if we have it.
          const cached = this.cache.get<T[]>(account.connectorId, cacheKey);
          if (cached) {
            return ok(cached.value);
          }
        }

        return fetchResult;
      } finally {
        this.inFlight.delete(cacheKey);
      }
    })();

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Recover the per-connector account-identifier from Account.id.
   * Account.id is "{connectorId}:{accountIdentifier}" — slice off the prefix.
   * Handles connector ids that don't contain ":" (all current ones).
   */
  private accountIdentifier(account: Account): string {
    const prefix = `${account.connectorId}:`;
    return account.id.startsWith(prefix) ? account.id.slice(prefix.length) : account.id;
  }
}

let _defaultOrchestrator: Orchestrator | null = null;
export function defaultOrchestrator(): Orchestrator {
  if (!_defaultOrchestrator) {
    _defaultOrchestrator = new Orchestrator();
  }
  return _defaultOrchestrator;
}
