// Bybit V5 connector — first end-to-end vertical (Day 1).
// Implements src/connectors/types.ts:Connector. Uses a tiny in-house signed-fetch
// client (./bybit-rest.ts) instead of the `bybit-api` SDK: we only need two
// read-only GET endpoints, and the SDK pulled its whole webpack build toolchain
// (via optionalDependencies) into every install. Zero added dependencies now.
//
// Account model: Bybit users typically have a single UNIFIED trading account
// (post-2023 migration), but classic users may still have SPOT + DERIVATIVES + FUNDING
// as separate sub-accounts. We model each as its own Account row with accountType
// in the credentials. Default setup probes UNIFIED first, falls back to SPOT.
//
// V5 docs: https://bybit-exchange.github.io/docs/v5/intro

import { BybitRestClient } from "./bybit-rest.ts";

import type { Connector, ConnectorContext, ConnectorCredentials } from "./types.ts";
import type { Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";

export type BybitAccountType = "UNIFIED" | "CONTRACT" | "SPOT" | "FUND";

const VALID_ACCOUNT_TYPES: ReadonlyArray<BybitAccountType> = ["UNIFIED", "CONTRACT", "SPOT", "FUND"];

interface BybitCreds extends ConnectorCredentials {
  apiKey: string;
  apiSecret: string;
  // Legacy single-type field. New code should populate accountTypes[]; we keep
  // accountType for back-compat with v0.7.x vaults. Used as the primary
  // identifier when deriving account IDs (`bybit:UNIFIED`, etc.).
  accountType: BybitAccountType;
  // v0.13.2+: additional account types this credential should fan out across
  // in fetchHoldings / fetchTransactions. A Bybit API key always covers all
  // account types the user has enabled — this just tells us WHICH ones to
  // query. If absent, we query only `accountType`. Common pattern: tracking
  // UNIFIED + FUND together so funding-wallet balances aren't invisible.
  accountTypes?: BybitAccountType[];
  // testnet=true uses api-testnet.bybit.com, useful for setup validation.
  testnet?: boolean;
}

function isBybitCreds(c: ConnectorCredentials): c is BybitCreds {
  if (typeof c.apiKey !== "string" || typeof c.apiSecret !== "string") return false;
  if (typeof c.accountType !== "string" || !VALID_ACCOUNT_TYPES.includes(c.accountType as BybitAccountType)) {
    return false;
  }
  if (c.accountTypes !== undefined) {
    if (!Array.isArray(c.accountTypes)) return false;
    if (c.accountTypes.length === 0) return false;
    for (const t of c.accountTypes) {
      if (typeof t !== "string" || !VALID_ACCOUNT_TYPES.includes(t as BybitAccountType)) return false;
    }
  }
  return true;
}

// Resolve the set of account types this credential should fan out across.
// Always includes the primary `accountType`; merges in any additional ones
// the user opted into via `accountTypes[]`. Deduped, primary-first ordering.
function getAccountTypes(creds: BybitCreds): BybitAccountType[] {
  const out: BybitAccountType[] = [creds.accountType];
  if (creds.accountTypes) {
    for (const t of creds.accountTypes) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

function clientFor(creds: BybitCreds): BybitRestClient {
  return new BybitRestClient({
    key: creds.apiKey,
    secret: creds.apiSecret,
    testnet: creds.testnet ?? false,
  });
}

// Bybit V5 returns retCode 0 on success, non-zero on logical errors.
// Map common retCodes to our ConnectorError kinds. Unknown codes → upstream_error.
// Exported for unit-testability — the SDK call path is hard to mock cleanly.
export function mapBybitError(retCode: number, retMsg: string): { kind: Parameters<typeof err>[0]; message: string } {
  // 10003: api key invalid, 10004: bad sign, 10005: permission denied
  if ([10003, 10004, 10005, 33004, 110001].includes(retCode)) {
    return { kind: "auth_failed", message: `Bybit auth failed (${retCode}): ${retMsg}` };
  }
  // 10006: too many visits / rate limit
  if (retCode === 10006 || retCode === 10018) {
    return { kind: "rate_limited", message: `Bybit rate limit hit: ${retMsg}` };
  }
  // 10016: server error / 10002: time mismatch (often network/server issue)
  if (retCode === 10016 || retCode === 10002) {
    return { kind: "upstream_error", message: `Bybit upstream error (${retCode}): ${retMsg}` };
  }
  return { kind: "upstream_error", message: `Bybit error (${retCode}): ${retMsg}` };
}

export class BybitConnector implements Connector {
  readonly id = "bybit" as const;
  readonly displayName = "Bybit (V5)";
  readonly defaultCacheTtlSec = 120;

  async validateCredentials(
    creds: ConnectorCredentials,
    signal?: AbortSignal
  ): Promise<Result<void>> {
    if (!isBybitCreds(creds)) {
      return err(
        "schema_mismatch",
        "Bybit credentials must include { apiKey, apiSecret, accountType: 'UNIFIED'|'CONTRACT'|'SPOT'|'FUND' }"
      );
    }
    const client = clientFor(creds);
    try {
      const resp = await client.getWalletBalance({ accountType: creds.accountType });
      if (signal?.aborted) return err("network_timeout", "Aborted by caller");
      if (resp.retCode !== 0) {
        const { kind, message } = mapBybitError(resp.retCode, resp.retMsg);
        return err(kind, message);
      }
      return ok(undefined);
    } catch (e) {
      return err("network_error", `Bybit reachability check failed: ${(e as Error).message}`, { cause: e });
    }
  }

  async fetchHoldings(ctx: ConnectorContext): Promise<Result<Holding[]>> {
    if (!isBybitCreds(ctx.credentials)) {
      return err("schema_mismatch", "Bybit credentials malformed");
    }
    const creds = ctx.credentials;
    const client = clientFor(creds);
    const types = getAccountTypes(creds);
    const now = Date.now();
    const holdings: Holding[] = [];
    const errors: string[] = [];

    // Fan out per accountType. A single API key covers all enabled types,
    // but Bybit's getWalletBalance requires a separate call per type. Run in
    // parallel — Bybit V5's per-key rate limit (10 req/sec for /v5/account/*)
    // easily handles 4 simultaneous calls.
    const perType = await Promise.all(
      types.map(async (accountType) => {
        try {
          const resp = await client.getWalletBalance({ accountType });
          return { accountType, resp, err: null as Error | null };
        } catch (e) {
          return { accountType, resp: null, err: e as Error };
        }
      })
    );
    if (ctx.signal?.aborted) return err("network_timeout", "Aborted by caller");

    for (const { accountType, resp, err: thrown } of perType) {
      if (thrown) {
        errors.push(`${accountType}: ${thrown.message}`);
        continue;
      }
      if (!resp || resp.retCode !== 0) {
        const { kind, message } = mapBybitError(resp?.retCode ?? -1, resp?.retMsg ?? "no response");
        // Per-type permission errors are common when the API key only has
        // certain account types enabled (e.g. read-only on UNIFIED but not
        // FUND). Tag with the type so the user can see which one needs perms.
        errors.push(`${accountType} (${kind}): ${message}`);
        continue;
      }
      for (const account of resp.result?.list ?? []) {
        for (const coin of account.coin ?? []) {
          const qty = parseFloat(coin.walletBalance ?? "0");
          if (qty === 0) continue;
          const usdValue = parseFloat(coin.usdValue ?? "0");
          const currentPrice = qty > 0 ? usdValue / qty : undefined;
          holdings.push({
            accountId: ctx.account.id,
            symbol: coin.coin,
            assetClass: "crypto",
            quantity: qty,
            currentPrice,
            value: usdValue,
            valueCurrency: "USD",
            metadata: {
              accountType: account.accountType,
              equity: coin.equity,
              unrealisedPnl: coin.unrealisedPnl,
              cumRealisedPnl: coin.cumRealisedPnl,
            },
            fetchedAt: now,
          });
        }
      }
    }

    // Partial-success policy mirrors MetaMask: hard error only when EVERY
    // accountType failed. Otherwise return what we got and surface the
    // per-type errors via metadata on the first holding.
    if (holdings.length === 0 && errors.length > 0) {
      return err("upstream_error", `All Bybit account types failed: ${errors.join("; ")}`);
    }
    if (errors.length > 0 && holdings.length > 0) {
      const first = holdings[0]!;
      first.metadata = { ...(first.metadata ?? {}), __chainWarnings: errors };
    }

    return ok(holdings);
  }

  async fetchTransactions(
    ctx: ConnectorContext,
    since?: number
  ): Promise<Result<Transaction[]>> {
    if (!isBybitCreds(ctx.credentials)) {
      return err("schema_mismatch", "Bybit credentials malformed");
    }
    const creds = ctx.credentials;
    const client = clientFor(creds);
    const types = getAccountTypes(creds);
    const txs: Transaction[] = [];
    const errors: string[] = [];

    // V5 transaction-log: /v5/account/transaction-log — returns trades,
    // settlements, transfers, fees in one stream. Note: FUND wallet
    // transactions are NOT exposed via this endpoint (Bybit limits it to
    // UNIFIED + CONTRACT). For FUND we'd need /v5/asset/transfer-record
    // which we'll wire up later if needed; for now FUND silent-skips here
    // so PnL-from-history stays accurate for trading types only.
    const txTypes = types.filter((t) => t === "UNIFIED" || t === "CONTRACT");

    const perType = await Promise.all(
      txTypes.map(async (accountType) => {
        try {
          const resp = await client.getTransactionLog({
            accountType,
            startTime: since,
            limit: 50,
          });
          return { accountType, resp, err: null as Error | null };
        } catch (e) {
          return { accountType, resp: null, err: e as Error };
        }
      })
    );
    if (ctx.signal?.aborted) return err("network_timeout", "Aborted by caller");

    for (const { accountType, resp, err: thrown } of perType) {
      if (thrown) {
        errors.push(`${accountType}: ${thrown.message}`);
        continue;
      }
      if (!resp || resp.retCode !== 0) {
        const { kind, message } = mapBybitError(resp?.retCode ?? -1, resp?.retMsg ?? "no response");
        errors.push(`${accountType} (${kind}): ${message}`);
        continue;
      }
      for (const item of resp.result?.list ?? []) {
        const mapped: Transaction["type"] =
          item.type === "TRADE" ? "trade" :
          item.type === "TRANSFER_IN" ? "deposit" :
          item.type === "TRANSFER_OUT" ? "withdraw" :
          item.type === "INTEREST" ? "interest" :
          item.type === "AIRDROP" ? "reward" :
          item.type === "FEE_REFUND" ? "fee" :
          "trade";

        txs.push({
          accountId: ctx.account.id,
          txId: `${accountType}:${item.transactionTime}:${item.tradeId ?? item.symbol ?? "unknown"}`,
          type: mapped,
          symbol: item.symbol,
          quantity: item.qty ? parseFloat(item.qty) : undefined,
          price: item.tradePrice ? parseFloat(item.tradePrice) : undefined,
          fee: item.fee ? parseFloat(item.fee) : undefined,
          feeCurrency: item.currency,
          valueCurrency: item.currency ?? "USD",
          timestamp: parseInt(item.transactionTime, 10),
          metadata: {
            type: item.type,
            sourceAccountType: accountType,
            cashFlow: item.cashFlow,
            change: item.change,
            funding: item.funding,
          },
        });
      }
    }

    if (txs.length === 0 && errors.length > 0) {
      return err("upstream_error", `All Bybit account types failed: ${errors.join("; ")}`);
    }
    return ok(txs);
  }
}
