// Core types — shared across connectors, cache, MCP layer.
// Account model (eng review 1D): Connector → Account (N) → Holding/Transaction (N).
// Account.id is namespaced: "{connectorId}:{accountIdentifier}", e.g. "bybit:UNIFIED" or "metamask:0xabc...".

export type ConnectorId = "bybit" | "metamask" | "polymarket" | "solana" | "binance";

export type AssetClass = "crypto" | "stock" | "prediction" | "cash";

export interface Account {
  id: string;                    // "{connectorId}:{accountIdentifier}"
  connectorId: ConnectorId;
  label: string;                 // human-readable, e.g. "Bybit UNIFIED" or "MetaMask 0xabc...123"
  createdAt: number;             // epoch ms
  // Connector-specific configuration that isn't credentials and isn't ephemeral.
  // Examples: { chains: [1, 137], tokens: [...] } for MetaMask;
  //           { accountType: "UNIFIED" } for Bybit (mirrored from credentials for query convenience).
  metadata?: Record<string, unknown>;
}

export interface Holding {
  accountId: string;             // FK to Account.id
  symbol: string;                // "BTC", "ETH", "AAPL", "POLY-2024-PRES-TRUMP"
  assetClass: AssetClass;
  quantity: number;
  avgCost?: number;              // per-unit cost basis in valueCurrency, if known
  currentPrice?: number;         // per-unit price in valueCurrency, if known
  value?: number;                // quantity * currentPrice (for convenience)
  valueCurrency: string;         // "USD", "USDT", "EUR" — the currency of price/value/cost fields
  metadata?: Record<string, unknown>; // connector-specific extras (chain, contract addr, expiry, market_id...)
  fetchedAt: number;             // epoch ms — when this snapshot was taken
}

export type TransactionType =
  | "buy"
  | "sell"
  | "deposit"
  | "withdraw"
  | "fee"
  | "interest"
  | "reward"
  | "transfer"
  | "trade"
  | "resolve";  // for prediction markets

export interface Transaction {
  accountId: string;
  txId: string;                  // connector-native transaction ID
  type: TransactionType;
  symbol?: string;
  quantity?: number;
  price?: number;                // per-unit price at the time of the tx
  fee?: number;
  feeCurrency?: string;
  valueCurrency?: string;
  timestamp: number;             // epoch ms
  metadata?: Record<string, unknown>;
}

// Result<T> — uniform error handling across all connectors (eng review 1A).
// Connectors NEVER throw on expected failures (auth, rate limit, network).
// Throwing is reserved for programmer errors (bad params, internal bugs).

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConnectorError };

export type ConnectorErrorKind =
  | "auth_failed"          // 401, invalid key, expired
  | "rate_limited"         // 429, returns retryAfter if known
  | "network_timeout"      // request hung past timeout
  | "network_error"        // DNS, connection refused, etc.
  | "not_found"            // account/wallet doesn't exist
  | "empty"                // valid response, no holdings/transactions
  | "upstream_error"       // 5xx from API
  | "schema_mismatch"      // API returned unexpected shape
  | "unknown";

export interface ConnectorError {
  kind: ConnectorErrorKind;
  message: string;                // human-readable, surfaced to the user
  retryAfter?: number;            // seconds, populated for rate_limited
  cause?: unknown;                // original error for debugging
}

// Helper constructors — keeps connector code clean.

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  kind: ConnectorErrorKind,
  message: string,
  extras?: { retryAfter?: number; cause?: unknown }
): Result<T> {
  return { ok: false, error: { kind, message, ...extras } };
}
