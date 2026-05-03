// Tool: get_pnl
// Aggregates profit/loss across all accounts.
//
// Surfaces what each connector already gives us in metadata:
//   - Bybit:      unrealisedPnl + cumRealisedPnl (per coin)
//   - Polymarket: cashPnl, realizedPnl, percentPnl (per position)
//   - MetaMask:   no native P&L (would need cost-basis tracking from tx history)
//
// When `timeframe` is set (e.g. '7d') we ALSO return a `windowDelta` block:
// the value of each crypto holding's *current quantity* at the historical
// price `timeframe` ago, vs the same holdings' current value. This is
// "if I held this exact basket N days ago, how much have I gained?" — NOT
// the full windowed PnL (it ignores trades within the window). Surfaced
// honestly so the LLM can communicate the caveat. CoinGecko free-tier
// historical is daily granularity, so 24h means "yesterday's close".

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { Holding, Transaction } from "../../types.ts";
import { computeCostBasisWithMethod, type CostBasisMethod } from "../../cost_basis.ts";
import { defaultPriceService, PriceService } from "../../prices.ts";
import {
  convert,
  fetchFxRates,
  rateFromUsd,
  type Currency,
  type FxRates,
  type FxSource,
} from "../../fx.ts";

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
  "  - timeframe: '24h' | '7d' | '30d' | 'ytd' | 'all'. When set to anything other",
  "    than 'all', the result includes a `windowDelta` block computed from CoinGecko",
  "    historical prices. APPROXIMATION CAVEAT: it values your CURRENT basket at",
  "    historical prices vs current prices — it does NOT account for trades within",
  "    the window. Communicate this honestly to the user. Polymarket positions and",
  "    tokens without a CoinGecko mapping are skipped (counted in `skippedSymbols`).",
  "    CoinGecko free-tier historical is daily granularity, so '24h' = 'yesterday's close'.",
  "  - include_history (boolean, default false): also pulls transactions and runs",
  "    a cost-basis ledger over them, returning `realizedFromHistory` per",
  "    account + total. Costs an extra round-trip per account but unlocks honest",
  "    realized PnL on tokens born on-chain (LP rewards, swaps, native airdrops).",
  "    Tokens that arrived via wallet transfer-in (no price) get `unknownSalesCount`",
  "    not inflated knownRealized — explicit honesty about what cost basis we know.",
  "    POLYMARKET-SPECIFIC: when include_history=true, the Polymarket account's",
  "    realizedPnl is replaced by the cost-basis-from-/trades number. Default mode leaves",
  "    Polymarket realizedPnl null because the connector's cashPnl mixes realized",
  "    + unrealized — set include_history=true to get the real realized number.",
  "  - method ('fifo' | 'average', default 'fifo'): cost basis method used when",
  "    include_history=true. FIFO consumes oldest lot first per sell; Average Cost",
  "    pools all priced acquisitions and sells out at the running average. If the",
  "    user mentions 'average cost' / 'avg cost' / 'weighted', use 'average'.",
  "    Both methods preserve the 'honest unknown' rule: any sell drawing from an",
  "    unpriced deposit/transfer returns realizedPnl=null, NOT a fabricated number.",
  "    Has NO effect when include_history=false.",
  "  - currency ('USD' | 'EUR' | 'GBP' | 'HUF', default 'USD'): when set to anything",
  "    other than USD, ALL numeric fields (currentValue, costBasis, realizedPnl,",
  "    unrealizedPnl, windowDelta numbers, realizedFromHistory.knownRealized) are",
  "    converted via live FX rates. The fx.source + fetchedAt are surfaced in `meta.fx`.",
  "    Use this for currency-consistent rendering when the user asked their dashboard",
  "    to be in HUF/EUR/GBP — otherwise per-tab currencies will mismatch.",
].join(" ");

export const GET_PNL_INPUT_SCHEMA = {
  account_id: z.string().optional(),
  timeframe: z.enum(["24h", "7d", "30d", "ytd", "all"]).optional(),
  include_history: z.boolean().optional(),
  method: z.enum(["fifo", "average"]).optional(),
  currency: z.enum(["USD", "EUR", "GBP", "HUF"]).optional(),
};

export interface GetPnlArgs {
  account_id?: string;
  timeframe?: "24h" | "7d" | "30d" | "ytd" | "all";
  // When true, also fetches transactions and runs cost-basis through them.
  // Surfaces a `realizedFromHistory` block per account. Costs an extra
  // round-trip per account (transactions endpoint), so it's opt-in.
  include_history?: boolean;
  // Cost basis method. Default 'fifo'. Only meaningful when include_history=true.
  method?: CostBasisMethod;
  // Display currency for all numeric fields. Default 'USD' (no conversion).
  currency?: Currency;
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

// Time-windowed delta: "current basket valued at historical prices vs now".
// Per-account null when no priceable holdings (e.g. Polymarket-only).
export interface WindowDelta {
  timeframe: "24h" | "7d" | "30d" | "ytd";
  asOfDate: string;                 // ISO 8601 date of the historical snapshot
  historicalValue: number;          // sum(quantity × historicalPrice) for priced holdings
  currentValueAtSnapshot: number;   // sum(holding.value) for the same priced holdings
  delta: number;                    // currentValueAtSnapshot - historicalValue
  deltaPercent: number;             // delta / historicalValue × 100 (0 if historicalValue=0)
  pricedSymbols: number;
  skippedSymbols: number;
  skippedReasons: string[];         // e.g. "FOO: no CoinGecko mapping"
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
    // Populated only when args.timeframe is set and not 'all'.
    windowDelta: WindowDelta | null;
  };
  byAccount: AccountPnl[];
  failures: Array<{ accountId: string; error: string }>;
  timeframeRequested: string | null;
  timeframeNote: string;
  // Echoes back the cost-basis method actually used. null when include_history=false.
  costBasisMethod: CostBasisMethod | null;
  // Currency the response is denominated in (default "USD").
  currency: Currency;
  // FX info — present iff currency was non-USD. Surfaces source so callers
  // can warn the user when rates came from the static fallback (stale).
  fx?: {
    targetCurrency: Currency;
    source: FxSource;
    rateUsdToTarget: number;
    fetchedAt: string;
  };
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
    // Connector-specific realized PnL extraction from metadata.
    // Bybit's cumRealisedPnl is a true realized-only field, safe to add.
    // MetaMask doesn't surface realized at the holding level.
    // Polymarket's `cashPnl` mixes realized + unrealized — DO NOT use it here.
    // For honest realized PnL on Polymarket, callers must opt into
    // include_history=true so we can compute it from the /trades ledger.
    const meta = h.metadata ?? {};
    if (typeof meta.realizedPnl === "number") realizedPnl += meta.realizedPnl;
    if (typeof meta.cumRealisedPnl === "string") realizedPnl += parseFloat(meta.cumRealisedPnl) || 0;
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
    notes.push("Polymarket realized PnL is null by default. Pass include_history=true to compute it from /trades history (FIFO).");
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
  orchestrator: Orchestrator = defaultOrchestrator(),
  priceService: PriceService = defaultPriceService()
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
  const method: CostBasisMethod = args.method ?? "fifo";
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
      const cb = computeCostBasisWithMethod(txs, method);
      account.realizedFromHistory = {
        knownRealized: cb.totals.realizedKnown,
        unknownSalesCount: cb.totals.realizedUnknownCount,
        orphanCount: cb.totals.orphanCount,
      };
      // Polymarket: the canonical realized PnL is the cost-basis-from-trades number.
      // Promote it into account.realizedPnl (overriding the null we left there
      // in pnlForAccount). Bybit and MetaMask keep whatever pnlForAccount set
      // because their metadata-based realized is already trusted.
      if (account.accountId.startsWith("polymarket:")) {
        const previousRealized = account.realizedPnl ?? 0;
        account.realizedPnl = cb.totals.realizedKnown;
        // Drop the "by default null" note now that we have an actual number.
        account.notes = account.notes.filter((n) => !n.includes("Polymarket realized PnL is null by default"));
        const methodLabel = method === "average" ? "Average Cost" : "FIFO";
        account.notes.push(
          `Polymarket realizedPnl computed from ${cb.realizedSales.length} trade event(s) via ${methodLabel} over /trades.`
        );
        // Fold the previous (probably zero) into nothing — the cost basis replaces it.
        void previousRealized;
      }
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

  // Time-windowed delta. Active iff timeframe is set and != 'all'.
  // Approximation: values current quantities at historical prices. Doesn't
  // account for trades within the window. Polymarket positions are skipped
  // (no CoinGecko mapping for prediction shares). The skippedReasons list lets
  // the LLM tell the user what's not in the number.
  let windowDelta: WindowDelta | null = null;
  let timeframeNote: string;
  if (args.timeframe && args.timeframe !== "all") {
    windowDelta = await computeWindowDelta(aggregate.data, args.timeframe, priceService);
    timeframeNote =
      `Window delta for '${args.timeframe}' values your CURRENT basket at historical prices ` +
      `(${windowDelta.asOfDate.slice(0, 10)}) vs now. Does NOT account for trades within the window. ` +
      `${windowDelta.pricedSymbols} symbol(s) priced, ${windowDelta.skippedSymbols} skipped.`;
  } else {
    timeframeNote = "Point-in-time aggregate P&L from connector metadata.";
  }

  // Currency conversion (display layer). Storage is USD-equivalent; if the
  // caller asked for HUF/EUR/GBP, we fetch FX rates and convert all numeric
  // fields end-to-end. fetchFxRates always returns ok() — worst case is the
  // hardcoded fallback rates with `source: "fallback"`, which we surface in
  // meta.fx so the caller can warn the user.
  const targetCurrency: Currency = args.currency ?? "USD";
  let fxMeta: GetPnlResult["fx"] | undefined;
  if (targetCurrency !== "USD") {
    const fxResult = await fetchFxRates();
    if (fxResult.ok) {
      const rates = fxResult.value;
      fxMeta = {
        targetCurrency,
        source: rates.source,
        rateUsdToTarget: rateFromUsd(targetCurrency, rates),
        fetchedAt: new Date(rates.fetchedAt).toISOString(),
      };
      // Convert in place. Each call: USD → targetCurrency, null preserved.
      const c = (v: number | null): number | null =>
        v === null ? null : convert(v, "USD", targetCurrency, rates);
      const cnn = (v: number): number => convert(v, "USD", targetCurrency, rates);

      totalCurrent = cnn(totalCurrent);
      totalCostBasis = cnn(totalCostBasis);
      totalUnrealized = cnn(totalUnrealized);
      totalRealized = cnn(totalRealized);
      if (totalHistory) {
        totalHistory = { ...totalHistory, knownRealized: cnn(totalHistory.knownRealized) };
      }
      if (windowDelta) {
        windowDelta = {
          ...windowDelta,
          historicalValue: cnn(windowDelta.historicalValue),
          currentValueAtSnapshot: cnn(windowDelta.currentValueAtSnapshot),
          delta: cnn(windowDelta.delta),
          // deltaPercent is a ratio (delta/historical) — currency-invariant, do NOT convert.
        };
      }
      for (const a of byAccount) {
        a.currentValue = cnn(a.currentValue);
        a.costBasis = c(a.costBasis);
        a.unrealizedPnl = c(a.unrealizedPnl);
        a.realizedPnl = c(a.realizedPnl);
        if (a.realizedFromHistory) {
          a.realizedFromHistory = { ...a.realizedFromHistory, knownRealized: cnn(a.realizedFromHistory.knownRealized) };
        }
      }
      if (rates.source === "fallback") {
        // Annotate the topmost set of notes so it surfaces. Pick byAccount[0]
        // if present, else add a synthetic note (we don't have a top-level
        // notes array). The dashboard / CLI surfaces fx.source directly too.
        // No-op here — callers read fx.source directly and decide.
      }
    }
  }

  return {
    total: {
      currentValue: totalCurrent,
      costBasis: totalCostBasis,
      unrealizedPnl: totalUnrealized,
      realizedPnl: totalRealized,
      realizedFromHistory: totalHistory,
      windowDelta,
    },
    byAccount,
    failures: aggregate.failures,
    timeframeRequested: args.timeframe ?? null,
    timeframeNote,
    costBasisMethod: args.include_history ? method : null,
    currency: targetCurrency,
    ...(fxMeta ? { fx: fxMeta } : {}),
    asOf: new Date().toISOString(),
  };
}

// Resolve a timeframe label to a UTC Date for the historical snapshot.
// CoinGecko free historical is daily granularity, so we trim time-of-day
// to start-of-UTC-day for stable cache keys.
function timeframeToDate(timeframe: "24h" | "7d" | "30d" | "ytd"): Date {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  switch (timeframe) {
    case "24h": return new Date(todayUtc - 1 * 24 * 60 * 60 * 1000);
    case "7d":  return new Date(todayUtc - 7 * 24 * 60 * 60 * 1000);
    case "30d": return new Date(todayUtc - 30 * 24 * 60 * 60 * 1000);
    case "ytd": return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  }
}

async function computeWindowDelta(
  holdings: Holding[],
  timeframe: "24h" | "7d" | "30d" | "ytd",
  priceService: PriceService
): Promise<WindowDelta> {
  const date = timeframeToDate(timeframe);

  // Collect priceable crypto holdings. Skip non-crypto (predictions/cash/stocks)
  // and crypto where we can't resolve to a CoinGecko id.
  // Resolution is two-tier: static map → cached top-250-by-market-cap list. A
  // single dynamic markets fetch covers all symbols in this loop.
  interface PriceableHolding {
    coinId: string;
    quantity: number;
    currentValue: number;
  }
  const priceable: PriceableHolding[] = [];
  const skippedReasons: string[] = [];

  for (const h of holdings) {
    if (h.assetClass !== "crypto") continue;
    if (h.quantity === undefined || h.quantity <= 0) continue;
    if (h.value === undefined) continue;
    const coinId = await priceService.resolveCoinId(h.symbol);
    if (!coinId) {
      skippedReasons.push(`${h.symbol}: not in CoinGecko top 250 — add to COINGECKO_IDS in src/prices.ts to track`);
      continue;
    }
    priceable.push({ coinId, quantity: h.quantity, currentValue: h.value });
  }

  // De-dupe coin ids and fetch historical prices in parallel. The PriceService
  // caches per (coin, date), so multiple holdings of the same symbol share one fetch.
  const uniqueCoins = Array.from(new Set(priceable.map((p) => p.coinId)));
  const priceMap = new Map<string, number>();
  await Promise.all(
    uniqueCoins.map(async (coinId) => {
      const r = await priceService.getHistoricalPrice(coinId, date);
      if (r.ok && r.value !== null) {
        priceMap.set(coinId, r.value);
      }
    })
  );

  let historicalValue = 0;
  let currentValueAtSnapshot = 0;
  let pricedSymbols = 0;

  for (const p of priceable) {
    const histPrice = priceMap.get(p.coinId);
    if (histPrice === undefined) {
      skippedReasons.push(`${p.coinId}: historical price unavailable for ${timeframe} ago`);
      continue;
    }
    historicalValue += p.quantity * histPrice;
    currentValueAtSnapshot += p.currentValue;
    pricedSymbols++;
  }

  const delta = currentValueAtSnapshot - historicalValue;
  return {
    timeframe,
    asOfDate: date.toISOString(),
    historicalValue,
    currentValueAtSnapshot,
    delta,
    deltaPercent: historicalValue > 0 ? (delta / historicalValue) * 100 : 0,
    pricedSymbols,
    skippedSymbols: skippedReasons.length,
    skippedReasons,
  };
}
