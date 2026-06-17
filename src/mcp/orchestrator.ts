// Orchestrator — wires Account registry + Vault + Connector + Cache.
// Eng review 4A.1 (parallel fetch): get holdings across N accounts via Promise.all.
// Eng review 4A.2 (in-flight dedup): when MCP host fans out tool calls, multiple
//   simultaneous requests for the same cache key share one Promise. Stops
//   3x duplicated upstream API calls per Claude conversation.
// Eng review 1F (per-connector TTL): cache layer enforces TTL, force=true bypasses.

import { defaultAccountStore, type AccountStore } from "../accounts.ts";
import { Cache, defaultCache } from "../cache.ts";
import { BinanceConnector } from "../connectors/binance.ts";
import { BybitConnector } from "../connectors/bybit.ts";
import { HyperliquidConnector } from "../connectors/hyperliquid.ts";
import { MetaMaskConnector } from "../connectors/metamask.ts";
import { PolymarketConnector } from "../connectors/polymarket.ts";
import { SolanaConnector } from "../connectors/solana.ts";
import type { Connector, ConnectorContext } from "../connectors/types.ts";
import { defaultVault, type Vault } from "../vault.ts";
import type { Account, ConnectorId, Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";
import { captureException, captureMessage } from "../observability/sentry.ts";

const CONNECTOR_FACTORIES: Record<ConnectorId, () => Connector> = {
  bybit: () => new BybitConnector(),
  binance: () => new BinanceConnector(),
  metamask: () => new MetaMaskConnector(),
  polymarket: () => new PolymarketConnector(),
  solana: () => new SolanaConnector(),
  hyperliquid: () => new HyperliquidConnector(),
};

// A connector operation must finish within this deadline. Every connector
// honors ctx.signal (connectors/types.ts says they MUST), but until now nothing
// ever SET a timeout on that signal: the tool handlers call getHoldings() with
// no signal, so a hung upstream (TCP connected, response never arrives) would
// block the MCP tool call forever — the host just spins. We bound each
// per-account fetch with a timeout signal (combined with any caller signal), so
// a hang degrades to a per-account network_timeout failure instead of an
// indefinite stall, the same graceful-degradation contract as a thrown error.
// Generous by default to fit the slowest legitimate connector (MetaMask fans
// out across up to 6 chains); override via env for unusual multi-chain setups.
const DEFAULT_REQUEST_TIMEOUT_MS =
  Number(process.env.HEADLESS_TRACKER_REQUEST_TIMEOUT_MS) || 30_000;

// Backoff before the single retry on a transient network_error (below). Short:
// a network_error fails fast at the network layer (connection refused, DNS,
// dropped connection), so a brief pause is enough to clear a blip without eating
// much of the request deadline.
const DEFAULT_RETRY_BACKOFF_MS = 250;

// A delay that resolves early if the signal aborts, so a retry backoff never
// outlives a cancelled or timed-out request.
function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

export interface OrchestratorOptions {
  accountStore?: AccountStore;
  vault?: Vault;
  cache?: Cache;
  // Pre-populated connector instances. Bypasses the lazy factory.
  // Used by tests to inject stubs without mocking the module.
  connectorOverrides?: Partial<Record<ConnectorId, Connector>>;
  // Per-account fetch deadline in ms. Defaults to DEFAULT_REQUEST_TIMEOUT_MS
  // (env-overridable). Exposed so tests can use a short timeout.
  requestTimeoutMs?: number;
  // Backoff before the single transient-error retry. Defaults to
  // DEFAULT_RETRY_BACKOFF_MS. Exposed so tests can set 0 for speed.
  retryBackoffMs?: number;
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
  private requestTimeoutMs: number;
  private retryBackoffMs: number;

  constructor(opts: OrchestratorOptions = {}) {
    this.accountStore = opts.accountStore ?? defaultAccountStore();
    this.vault = opts.vault ?? defaultVault();
    this.cache = opts.cache ?? defaultCache();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
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

        // Bound the fetch with a timeout, combined with any caller-supplied
        // signal. Connectors honor ctx.signal, so passing this in lets a
        // well-behaved connector abort its own in-flight request. The timer
        // behind AbortSignal.timeout is unref'd, so it never keeps the process
        // (or a test runner) alive past a fast success.
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        const signal = opts.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal;

        const ctx: ConnectorContext = {
          account,
          credentials,
          signal,
        };

        // Race the connector against the deadline. Passing `signal` above is not
        // enough on its own: a connector that doesn't thread the signal all the
        // way into its fetch (or any future one that regresses) would still hang
        // forever, and a hung fetch must never stall the user's tool call. The
        // race is the airtight backstop — the caller can never wait past the
        // deadline regardless of per-connector correctness. The orphaned fetcher
        // gets a no-op .catch so a late rejection (after the race has settled)
        // doesn't surface as an unhandledRejection.
        const fetcherPromise = this.fetchWithRetry(fetcher, ctx, connector, signal);
        fetcherPromise.catch(() => {});
        const deadline = new Promise<Result<T[]>>((resolve) => {
          const onTimeout = () =>
            resolve(
              err(
                "network_timeout",
                `${account.connectorId} ${kind.split(":")[0]} timed out after ${this.requestTimeoutMs}ms`
              )
            );
          if (timeoutSignal.aborted) onTimeout();
          else timeoutSignal.addEventListener("abort", onTimeout, { once: true });
        });

        let fetchResult = await Promise.race([fetcherPromise, deadline]);

        // If our deadline (not the caller) aborted, a connector that honored the
        // signal reports a generic "aborted" network_timeout; normalize it to the
        // clearer deadline message so the surfaced failure is actionable.
        if (
          !fetchResult.ok &&
          fetchResult.error.kind === "network_timeout" &&
          timeoutSignal.aborted &&
          !opts.signal?.aborted
        ) {
          fetchResult = err(
            "network_timeout",
            `${account.connectorId} ${kind.split(":")[0]} timed out after ${this.requestTimeoutMs}ms`
          );
        }

        if (fetchResult.ok) {
          this.cache.set(account.connectorId, cacheKey, fetchResult.value);
        } else {
          // An unexpected upstream shape is a developer signal (the API changed,
          // or our parser is wrong), not a user-fixable state like auth/rate-limit.
          // Report it; no-op unless SENTRY_DSN is set.
          if (fetchResult.error.kind === "schema_mismatch") {
            await captureMessage(`schema_mismatch: ${fetchResult.error.message}`, {
              connector: account.connectorId,
              operation: kind.split(":")[0],
            });
          }
          // On rate_limited / network failure, fall back to stale cache if we have it.
          const cached = this.cache.get<T[]>(account.connectorId, cacheKey);
          if (cached) {
            return ok(cached.value);
          }
        }

        return fetchResult;
      } catch (e) {
        // A connector THREW (an unexpected bug, not a handled err()). Before, this
        // rejected the whole Promise.all and took down every account's fetch at
        // once. Report it to Sentry (no-op unless SENTRY_DSN is set) and degrade to
        // a per-account failure so the other accounts/connectors still return data.
        await captureException(e, {
          connector: account.connectorId,
          operation: kind.split(":")[0],
        });
        return err(
          "unknown",
          `${account.connectorId} ${kind.split(":")[0]} failed unexpectedly: ${(e as Error).message}`
        );
      } finally {
        this.inFlight.delete(cacheKey);
      }
    })();

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Run the connector fetch, retrying once on a transient `network_error`.
   *
   * Only `network_error` is retried: it is returned uniformly (and only) when
   * `fetch` itself throws — DNS failure, connection refused, a dropped
   * connection — which is exactly the kind of blip a single retry clears. We do
   * NOT retry `upstream_error` (it mixes transient 5xx with non-transient 4xx
   * and upstream logical errors), `rate_limited` (prices.ts already backs off on
   * 429; retrying would just hammer a limited endpoint), `auth_failed`, or
   * `schema_mismatch` (none of which fix themselves). The backoff is abortable,
   * and the whole call is wrapped by the deadline race in fetchForAccount, so
   * the retry can never push total time past the request timeout.
   */
  private async fetchWithRetry<T>(
    fetcher: (ctx: ConnectorContext, conn: Connector) => Promise<Result<T[]>>,
    ctx: ConnectorContext,
    connector: Connector,
    signal: AbortSignal
  ): Promise<Result<T[]>> {
    let result = await fetcher(ctx, connector);
    if (!result.ok && result.error.kind === "network_error" && !signal.aborted) {
      await delayAbortable(this.retryBackoffMs, signal);
      if (!signal.aborted) result = await fetcher(ctx, connector);
    }
    return result;
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
