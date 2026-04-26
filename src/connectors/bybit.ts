// Bybit V5 connector — first end-to-end vertical (Day 1).
// Implements src/connectors/types.ts:Connector. Uses official `bybit-api` SDK
// for HMAC signing, retry/backoff, and V5 endpoint coverage.
//
// Account model: Bybit users typically have a single UNIFIED trading account
// (post-2023 migration), but classic users may still have SPOT + DERIVATIVES + FUNDING
// as separate sub-accounts. We model each as its own Account row with accountType
// in the credentials. Default setup probes UNIFIED first, falls back to SPOT.
//
// V5 docs: https://bybit-exchange.github.io/docs/v5/intro

import { RestClientV5 } from "bybit-api";

import type { Connector, ConnectorContext, ConnectorCredentials } from "./types.ts";
import type { Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";

interface BybitCreds extends ConnectorCredentials {
  apiKey: string;
  apiSecret: string;
  // "UNIFIED" (post-2023 standard), "CONTRACT" (perp/futures legacy), "SPOT" (legacy spot),
  // "FUND" (funding wallet). Most users want UNIFIED.
  accountType: "UNIFIED" | "CONTRACT" | "SPOT" | "FUND";
  // testnet=true uses api-testnet.bybit.com, useful for setup validation.
  testnet?: boolean;
}

function isBybitCreds(c: ConnectorCredentials): c is BybitCreds {
  return (
    typeof c.apiKey === "string" &&
    typeof c.apiSecret === "string" &&
    typeof c.accountType === "string" &&
    ["UNIFIED", "CONTRACT", "SPOT", "FUND"].includes(c.accountType as string)
  );
}

function clientFor(creds: BybitCreds): RestClientV5 {
  return new RestClientV5({
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

    try {
      const resp = await client.getWalletBalance({ accountType: creds.accountType });
      if (ctx.signal?.aborted) return err("network_timeout", "Aborted by caller");
      if (resp.retCode !== 0) {
        const { kind, message } = mapBybitError(resp.retCode, resp.retMsg);
        return err(kind, message);
      }

      // V5 wallet-balance response shape: { result: { list: [{ accountType, totalEquity, coin: [...] }] } }
      const list = resp.result?.list ?? [];
      if (list.length === 0) return ok([]);

      const now = Date.now();
      const holdings: Holding[] = [];

      for (const account of list) {
        for (const coin of account.coin ?? []) {
          const qty = parseFloat(coin.walletBalance ?? "0");
          if (qty === 0) continue; // skip dust / zero balance

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

      return ok(holdings);
    } catch (e) {
      return err("network_error", `Bybit fetchHoldings failed: ${(e as Error).message}`, { cause: e });
    }
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

    try {
      // V5 transaction-log: /v5/account/transaction-log
      // Returns trades, settlements, transfers, fees in one stream.
      const resp = await client.getTransactionLog({
        accountType: creds.accountType,
        startTime: since,
        limit: 50,
      });
      if (ctx.signal?.aborted) return err("network_timeout", "Aborted by caller");
      if (resp.retCode !== 0) {
        const { kind, message } = mapBybitError(resp.retCode, resp.retMsg);
        return err(kind, message);
      }

      const txs: Transaction[] = [];
      for (const item of resp.result?.list ?? []) {
        // Bybit V5 transaction type enum is large (70+ variants). Map the high-signal
        // ones; anything else falls through to "trade" as a reasonable default.
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
          txId: item.transactionTime + ":" + (item.tradeId ?? item.symbol ?? "unknown"),
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
            cashFlow: item.cashFlow,
            change: item.change,
            funding: item.funding,
          },
        });
      }

      return ok(txs);
    } catch (e) {
      return err("network_error", `Bybit fetchTransactions failed: ${(e as Error).message}`, { cause: e });
    }
  }
}
