// Connector interface — every connector implements this.
// Eng review 1A: enforces uniform method signatures, return shapes, error handling
// across Bybit, MetaMask, IBKR, Polymarket. Adding a 5th connector requires
// implementing this interface, nothing else.

import type { Account, ConnectorId, Holding, Result, Transaction } from "../types.ts";

export interface ConnectorCredentials {
  // Free-form per connector, but always serializable to JSON for vault storage.
  // Bybit: { apiKey, apiSecret }
  // MetaMask: { address } (no secret — public chain reads only)
  // IBKR: { flexQueryToken, queryId }
  // Polymarket: { walletAddress, optional polygonRpcUrl }
  [key: string]: unknown;
}

export interface ConnectorContext {
  // Cache-key namespace, used for SQLite cache scoping.
  // Implementation passes this so the connector doesn't have to know about the cache.
  account: Account;
  credentials: ConnectorCredentials;
  // AbortSignal for caller-side timeout/cancellation. Connectors MUST honor it.
  signal?: AbortSignal;
}

export interface Connector {
  // Connector identifier — must match Account.connectorId for any account this connector serves.
  readonly id: ConnectorId;

  // Human-readable display name, e.g. "Bybit (V5 unified account)".
  readonly displayName: string;

  // Default cache TTL in seconds for this connector (eng review 1F).
  // Crypto wallets: 60s, exchanges: 120s, IBKR: 300s, Polymarket: 30s.
  readonly defaultCacheTtlSec: number;

  // Validate that the supplied credentials look right (shape + reachability).
  // Used during `setup` flow before persisting to the vault.
  validateCredentials(creds: ConnectorCredentials, signal?: AbortSignal): Promise<Result<void>>;

  // Fetch current holdings for one account.
  // Returns ok([]) for an empty portfolio (NOT err("empty")) — empty is a valid state.
  // Returns err("auth_failed" | "rate_limited" | ...) on actual failures.
  fetchHoldings(ctx: ConnectorContext): Promise<Result<Holding[]>>;

  // Fetch transactions for one account, optionally bounded by epoch ms.
  // since=undefined means "as much history as the API gives us reasonably".
  fetchTransactions(ctx: ConnectorContext, since?: number): Promise<Result<Transaction[]>>;
}
