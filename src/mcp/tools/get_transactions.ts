// Tool: get_transactions
// Returns transaction history across configured accounts.
//
// V0 connector coverage:
//   - Bybit:      full (trades, deposits/withdrawals, fees, interest from V5 transaction-log)
//   - MetaMask:   native ETH/MATIC/BNB transfers + ERC-20 transfers across all selected chains
//   - Polymarket: stub (returns []), endpoint discovery is Day 8-10 polish work
//
// `since` accepts both:
//   - epoch ms (number) — passed straight through to connectors
//   - human shorthand ('24h', '7d', '30d') — converted to epoch ms

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { Transaction } from "../../types.ts";

export const GET_TRANSACTIONS_TOOL_NAME = "get_transactions";

export const GET_TRANSACTIONS_DESCRIPTION = [
  "Returns transaction history (trades, deposits, withdrawals, fees, ERC-20 token transfers) across configured accounts.",
  "Use this when the user asks: 'what trades did I make', 'show my transactions',",
  "'transaction history', 'recent buys', 'recent sells', 'show my deposits',",
  "'when did I buy X', 'what did I do this week', etc.",
  "",
  "Each transaction includes:",
  "  - type: trade / buy / sell / deposit / withdraw / fee / interest / reward / transfer / resolve",
  "  - symbol, quantity, price (per-unit at time of transaction)",
  "  - fee + feeCurrency",
  "  - timestamp (ISO 8601)",
  "  - metadata (connector-specific: chain, hash, market, etc.)",
  "",
  "Inputs (optional):",
  "  - account_id: scope to one account.",
  "  - since: shorthand ('24h', '7d', '30d', '90d') OR epoch ms (e.g. 1700000000000).",
  "    Default: ~last 50 transactions per account regardless of date.",
  "",
  "Coverage caveats (V0):",
  "  - Bybit: full transaction log",
  "  - MetaMask: native chain transfers + ERC-20 token transfers (USDC, USDT, etc.)",
  "  - Polymarket: NOT YET — endpoint discovery is Day 8-10 polish.",
  "    If user asks for Polymarket trades specifically, tell them this honestly.",
].join(" ");

export const GET_TRANSACTIONS_INPUT_SCHEMA = {
  account_id: z.string().optional(),
  since: z.string().optional(),
};

export interface GetTransactionsArgs {
  account_id?: string;
  since?: string;
}

export interface GetTransactionsResult {
  transactions: Array<{
    accountId: string;
    txId: string;
    type: string;
    symbol?: string;
    quantity?: number;
    price?: number;
    fee?: number;
    feeCurrency?: string;
    valueCurrency?: string;
    timestamp: string;          // ISO 8601
    metadata?: Record<string, unknown>;
  }>;
  failures: Array<{ accountId: string; error: string }>;
  warnings: string[];           // per-chain soft-skips, etc.
  meta: {
    sinceResolved: string | null;     // ISO 8601 of the resolved cutoff
    sinceInputRaw: string | null;
    totalTransactions: number;
    accountsConfigured: number;
    accountsQueried: number;
    accountsWithData: number;
    accountsWithEmptyResults: number;     // succeeded but returned no transactions in window
    accountsWithErrors: number;
    scope: {
      accountIdFilter: string | null;
      sinceFilter: string | null;
    };
    asOf: string;
    coverage: {
      polymarket: "not_implemented_in_v0";
      metamask: "native_and_erc20_transfers";
      bybit: "full";
    };
  };
}

function resolveSinceMs(input: string | undefined): number | undefined {
  if (!input) return undefined;
  // Numeric input → epoch ms.
  const asNumber = Number(input);
  if (!Number.isNaN(asNumber) && asNumber > 0) return asNumber;
  // Shorthand: '24h', '7d', '30d', '90d', 'NN' followed by 'h' or 'd'.
  const match = input.trim().match(/^(\d+)\s*([hd])$/i);
  if (match) {
    const n = parseInt(match[1]!, 10);
    const unit = match[2]!.toLowerCase();
    const multiplier = unit === "h" ? 3600 * 1000 : 24 * 3600 * 1000;
    return Date.now() - n * multiplier;
  }
  return undefined;
}

export async function executeGetTransactions(
  args: GetTransactionsArgs,
  orchestrator: Orchestrator = defaultOrchestrator()
): Promise<GetTransactionsResult> {
  const sinceMs = resolveSinceMs(args.since);
  const accountIds = args.account_id ? [args.account_id] : undefined;
  const aggregate = await orchestrator.getTransactions(accountIds, sinceMs);

  // Sort newest-first across accounts.
  const sorted = [...aggregate.data].sort((a, b) => b.timestamp - a.timestamp);

  // Drain per-connector chain warnings out of metadata side-channel.
  const warnings: string[] = [];
  for (const t of aggregate.data) {
    const w = t.metadata?.__chainWarnings;
    if (Array.isArray(w)) {
      for (const msg of w) if (typeof msg === "string") warnings.push(msg);
    }
  }

  const accountsConfigured = orchestrator.listAccounts().length;
  const accountsQueried = accountIds ? accountIds.length : accountsConfigured;
  const accountsWithDataSet = new Set(sorted.map((t) => t.accountId));
  const accountsWithErrorsSet = new Set(aggregate.failures.map((f) => f.accountId));
  const queriedAccountIds = new Set<string>(
    accountIds ?? orchestrator.listAccounts().map((a) => a.id)
  );
  let accountsWithEmptyResults = 0;
  for (const id of queriedAccountIds) {
    if (accountsWithErrorsSet.has(id)) continue;
    if (!accountsWithDataSet.has(id)) accountsWithEmptyResults++;
  }

  return {
    transactions: sorted.map((t: Transaction) => {
      const { __chainWarnings: _w, ...cleanMeta } = (t.metadata ?? {}) as Record<string, unknown>;
      return {
        accountId: t.accountId,
        txId: t.txId,
        type: t.type,
        symbol: t.symbol,
        quantity: t.quantity,
        price: t.price,
        fee: t.fee,
        feeCurrency: t.feeCurrency,
        valueCurrency: t.valueCurrency,
        timestamp: new Date(t.timestamp).toISOString(),
        metadata: Object.keys(cleanMeta).length > 0 ? cleanMeta : undefined,
      };
    }),
    failures: aggregate.failures,
    warnings,
    meta: {
      sinceResolved: sinceMs ? new Date(sinceMs).toISOString() : null,
      sinceInputRaw: args.since ?? null,
      totalTransactions: sorted.length,
      accountsConfigured,
      accountsQueried,
      accountsWithData: accountsWithDataSet.size,
      accountsWithEmptyResults,
      accountsWithErrors: aggregate.failures.length,
      scope: {
        accountIdFilter: args.account_id ?? null,
        sinceFilter: args.since ?? null,
      },
      asOf: new Date().toISOString(),
      coverage: {
        polymarket: "not_implemented_in_v0",
        metamask: "native_and_erc20_transfers",
        bybit: "full",
      },
    },
  };
}
