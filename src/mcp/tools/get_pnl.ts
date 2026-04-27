// Tool: get_pnl
// Aggregates profit/loss across all accounts.
//
// V0 caveat: we DON'T compute time-windowed P&L (e.g. "P&L since 7 days ago")
// because we don't have price history. We surface what each connector already
// gives us in metadata:
//   - Bybit:      unrealisedPnl + cumRealisedPnl (per coin)
//   - Polymarket: cashPnl, realizedPnl, percentPnl (per position)
//   - MetaMask:   no native P&L (would need cost-basis tracking from tx history)
//
// The 'timeframe' input is accepted but currently informational — V0 always
// returns point-in-time P&L. The description tells the LLM to communicate this
// honestly to the user instead of fabricating a 7d delta.

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { Holding, Transaction } from "../../types.ts";
import { computeCostBasis } from "../../cost_basis.ts";

export const GET_PNL_TOOL_NAME = "get_pnl";

export const GET_PNL_DESCRIPTION = [
  "Returns aggregate profit/loss across all configured accounts.",
  "Use this when the user asks: 'how am I doing', 'what's my P&L', 'am I up or down',",
  "'show profit', 'show losses', or wants any portfolio performance summary.",
  "",
  "Returned fields per account and across the total:",
  "  - currentValue (USD) — current portfolio value",
  "  - costBasis (USD)    — sum of avgCost * quantity (where the connector tracks it)",
  "  - unrealizedPnl (USD) — currentValue - costBasis (for positions still held)",
  "  - realizedPnl (USD)   — already-closed P&L from connector metadata",
  "  - notes               — caveats per connector (e.g. MetaMask doesn't track cost basis)",
  "",
  "Inputs (optional):",
  "  - account_id: scope to one account.",
  "  - timeframe: '24h' | '7d' | '30d' | 'ytd' | 'all'. CURRENTLY INFORMATIONAL ONLY.",
  "    V0 returns point-in-time P&L based on what each connector reports.",
  "    True time-windowed P&L requires price history we don't yet store.",
  "    If the user asks for time-windowed P&L, EXPLAIN this honestly — don't fabricate.",
  "  - include_history (boolean, default false): also pulls transactions and runs",
  "    a FIFO cost-basis ledger over them, returning `realizedFromHistory` per",
  "    account + total. Costs an extra round-trip per account but unlocks honest",
  "    realized PnL on tokens born on-chain (LP rewards, swaps, native airdrops).",
  "    Tokens that arrived via wallet transfer-in (no price) get `unknownSalesCount`",
  "    not inflated knownRealized — explicit honesty about what cost basis we know.",
].join(" ");

export const GET_PNL_INPUT_SCHEMA = {
  account_id: z.string().optional(),
  timeframe: z.enum(["24h", "7d", "30d", "ytd", "all"]).optional(),
  include_history: z.boolean().optional(),
};

export interface GetPnlArgs {
  account_id?: string;
  timeframe?: "24h" | "7d" | "30d" | "ytd" | "all";
  // When true, also fetches transactions and runs FIFO cost-basis through
  // them. Surfaces a `realizedFromHistory` block per account. Costs an extra
  // round-trip per account (transactions endpoint), so it's opt-in.
  include_history?: boolean;
}

interface AccountPnl {
  accountId: string;
  currentValue: number;
  costBasis: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  // Populated only when args.include_history=true. Surfaces the on-chain /
  // exchange-history derived realized PnL via FIFO cost basis.
  // - knownRealized: sum of realized PnL where every consumed lot had a
  //   known cost basis (priced BUY/TRADE).
  // - unknownSalesCount: sales whose realized PnL is unknown because at
  //   least one consumed lot came from an unpriced source (e.g. a wallet
  //   transfer-in). These are NOT counted in knownRealized — that would
  //   inflate the number.
  // - orphanCount: SELLs without sufficient prior history (incomplete
  //   transaction window).
  realizedFromHistory: {
    knownRealized: number;
    unknownSalesCount: number;
    orphanCount: number;
  } | null;
  notes: string[];
}

export interface GetPnlResult {
  total: {
    currentValue: number;
    costBasis: number;
    unrealizedPnl: number;
    realizedPnl: number;
    // Populated only when args.include_history=true. Sum across accounts.
    realizedFromHistory: {
      knownRealized: number;
      unknownSalesCount: number;
      orphanCount: number;
    } | null;
  };
  byAccount: AccountPnl[];
  failures: Array<{ accountId: string; error: string }>;
  timeframeRequested: string | null;
  timeframeNote: string;
  asOf: string;
}

function pnlForAccount(holdings: Holding[]): AccountPnl {
  const accountId = holdings[0]?.accountId ?? "unknown";
  let currentValue = 0;
  let costBasis = 0;
  let costBasisKnown = 0;          // count of holdings where avgCost was present
  let realizedPnl = 0;
  const notes: string[] = [];

  let hasMetamask = false;
  let hasPolymarket = false;
  let hasBybit = false;

  for (const h of holdings) {
    if (h.value !== undefined) currentValue += h.value;
    if (h.avgCost !== undefined && h.quantity !== undefined) {
      costBasis += h.avgCost * h.quantity;
      costBasisKnown++;
    }
    // Connector-specific P&L extraction from metadata.
    const meta = h.metadata ?? {};
    if (typeof meta.realizedPnl === "number") realizedPnl += meta.realizedPnl;
    if (typeof meta.cumRealisedPnl === "string") realizedPnl += parseFloat(meta.cumRealisedPnl) || 0;
    if (typeof meta.cashPnl === "number") {
      // For Polymarket "cashPnl" represents realized + unrealized combined.
      // We surface it as realized for simplicity; LLM can reason from currentValue diff.
      realizedPnl += meta.cashPnl;
    }
    // Sniff which connector this is for note generation.
    if (typeof meta.chainId === "number") hasMetamask = true;
    if (typeof meta.eventSlug === "string" || meta.outcome) hasPolymarket = true;
    if (typeof meta.accountType === "string" && (meta.accountType === "UNIFIED" || meta.accountType === "SPOT" || meta.accountType === "CONTRACT" || meta.accountType === "FUND")) hasBybit = true;
  }

  const unknownCostHoldings = holdings.length - costBasisKnown;
  if (unknownCostHoldings > 0) {
    notes.push(
      `${unknownCostHoldings} holding(s) without cost basis — unrealized P&L excludes them.`
    );
  }
  if (hasMetamask) {
    notes.push("MetaMask connector does not yet track cost basis (V0 limitation).");
  }
  if (hasPolymarket) {
    notes.push("Polymarket cashPnl combines realized + unrealized; surfaced as realizedPnl here.");
  }
  if (hasBybit) {
    notes.push("Bybit cumRealisedPnl from V5 metadata included in realizedPnl.");
  }

  return {
    accountId,
    currentValue,
    costBasis: costBasisKnown > 0 ? costBasis : null,
    unrealizedPnl: costBasisKnown > 0 ? currentValue - costBasis : null,
    realizedPnl: realizedPnl !== 0 ? realizedPnl : null,
    realizedFromHistory: null,                         // populated by caller iff include_history=true
    notes,
  };
}

export async function executeGetPnl(
  args: GetPnlArgs,
  orchestrator: Orchestrator = defaultOrchestrator()
): Promise<GetPnlResult> {
  const accountIds = args.account_id ? [args.account_id] : undefined;
  const aggregate = await orchestrator.getHoldings(accountIds);

  // Group by accountId.
  const byAccountMap = new Map<string, Holding[]>();
  for (const h of aggregate.data) {
    const arr = byAccountMap.get(h.accountId) ?? [];
    arr.push(h);
    byAccountMap.set(h.accountId, arr);
  }

  const byAccount: AccountPnl[] = [];
  for (const [, holdings] of byAccountMap) {
    byAccount.push(pnlForAccount(holdings));
  }

  // Optional: pull transactions and run FIFO cost basis. Requires an extra
  // round-trip per account (transactions endpoint) and is opt-in. Unknown-cost
  // sales (e.g. on-chain ERC-20 transfers without price) propagate as
  // `unknownSalesCount`, NOT inflated into knownRealized — that's the whole
  // point of the "honest cost basis" framing.
  if (args.include_history) {
    const txAggregate = await orchestrator.getTransactions(accountIds, undefined);
    const byAccountTx = new Map<string, Transaction[]>();
    for (const t of txAggregate.data) {
      const arr = byAccountTx.get(t.accountId) ?? [];
      arr.push(t);
      byAccountTx.set(t.accountId, arr);
    }
    for (const account of byAccount) {
      const txs = byAccountTx.get(account.accountId) ?? [];
      const cb = computeCostBasis(txs);
      account.realizedFromHistory = {
        knownRealized: cb.totals.realizedKnown,
        unknownSalesCount: cb.totals.realizedUnknownCount,
        orphanCount: cb.totals.orphanCount,
      };
      if (cb.totals.realizedUnknownCount > 0) {
        account.notes.push(
          `${cb.totals.realizedUnknownCount} sale(s) had unknown cost basis (deposits / transfers without price). Realized PnL excludes them.`
        );
      }
      if (cb.totals.orphanCount > 0) {
        account.notes.push(
          `${cb.totals.orphanCount} orphan event(s) — sells exceeded the known transaction history window.`
        );
      }
    }
  }

  // Aggregate totals — only count costBasis/unrealized where we have it.
  let totalCurrent = 0;
  let totalCostBasis = 0;
  let totalUnrealized = 0;
  let totalRealized = 0;
  for (const a of byAccount) {
    totalCurrent += a.currentValue;
    if (a.costBasis !== null) totalCostBasis += a.costBasis;
    if (a.unrealizedPnl !== null) totalUnrealized += a.unrealizedPnl;
    if (a.realizedPnl !== null) totalRealized += a.realizedPnl;
  }

  // Aggregate the history block across accounts (only if any account has it set).
  let totalHistory: GetPnlResult["total"]["realizedFromHistory"] = null;
  if (args.include_history) {
    let knownRealized = 0;
    let unknownSalesCount = 0;
    let orphanCount = 0;
    for (const a of byAccount) {
      if (a.realizedFromHistory) {
        knownRealized += a.realizedFromHistory.knownRealized;
        unknownSalesCount += a.realizedFromHistory.unknownSalesCount;
        orphanCount += a.realizedFromHistory.orphanCount;
      }
    }
    totalHistory = { knownRealized, unknownSalesCount, orphanCount };
  }

  return {
    total: {
      currentValue: totalCurrent,
      costBasis: totalCostBasis,
      unrealizedPnl: totalUnrealized,
      realizedPnl: totalRealized,
      realizedFromHistory: totalHistory,
    },
    byAccount,
    failures: aggregate.failures,
    timeframeRequested: args.timeframe ?? null,
    timeframeNote:
      args.timeframe && args.timeframe !== "all"
        ? `Timeframe '${args.timeframe}' requested but V0 returns point-in-time P&L only. Time-windowed deltas need price history we don't yet store.`
        : "Point-in-time aggregate P&L from connector metadata.",
    asOf: new Date().toISOString(),
  };
}
