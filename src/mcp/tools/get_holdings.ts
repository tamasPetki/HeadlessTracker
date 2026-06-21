// Tool: get_holdings
// The single most important tool — answers "what do I own?" / "what's in my portfolio?"
// across all configured accounts (Bybit, MetaMask wallets, Polymarket positions).
//
// Description quality matters (eng review 1E): the LLM picks tools by reading the
// description, so it's verbose and lists trigger phrases the user is likely to use.

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { ConnectorId, Holding } from "../../types.ts";
import {
  convert,
  fetchFxRates,
  rateFromUsd,
  type Currency,
  type FxRates,
  type FxSource,
} from "../../fx.ts";

export const GET_HOLDINGS_TOOL_NAME = "get_holdings";

export const GET_HOLDINGS_DESCRIPTION = [
  "Returns current portfolio holdings across all connected accounts.",
  "Use this when the user asks: 'what do I own', 'show my portfolio', 'current positions',",
  "'what's my balance', 'show my holdings', 'how much BTC do I have', or wants any snapshot",
  "of crypto/stock/prediction-market positions.",
  "For Polymarket-specific questions (which markets, outcomes, resolution or redeemable status),",
  "prefer get_polymarket_positions. This tool is the flat LIST of what you own. For how that value is DIVIDED — ranked splits, percentages, concentration, or any 'how much is in X vs Y' / asset-class composition question (e.g. stablecoins vs crypto), prefer get_allocations, even if the user says 'how much'.",
  "",
  "Each holding includes: symbol, asset class (crypto / stock / prediction / cash), quantity,",
  "current price, USD value, and connector-specific metadata (e.g. chain for EVM, market title",
  "for Polymarket, accountType for Bybit).",
  "",
  "Inputs (all optional):",
  "  - account_id: scope to one account, e.g. 'metamask:0xabc123...' or 'bybit:UNIFIED'.",
  "    Omit to query ALL configured accounts.",
  "  - asset_class: scope to one of 'crypto' / 'stock' / 'prediction' / 'cash'.",
  "    'prediction' = Polymarket conditional tokens; 'cash' = stablecoins (USDC/USDT) + fiat. Omit for all classes.",
  "  - currency: 'USD' | 'EUR' | 'GBP' | 'HUF'. Default 'USD'. When set to anything",
  "    other than USD, value/currentPrice/avgCost are converted via live FX rates",
  "    (free API + fallback). The conversion source and fetchedAt are surfaced in",
  "    `meta.fx`. Underlying connector data is unchanged — this is a display-layer",
  "    convenience for users thinking in EUR/HUF/GBP.",
  "",
  "Results are cached per-connector (crypto wallets 60s, exchanges 120s, Polymarket 30s).",
  "Use 'refresh_data' tool first if the user explicitly asks for fresh / latest data.",
  "Returns position data only. Not financial advice.",
].join(" ");

// Per-parameter .describe() so the JSON Schema that MCP clients (and directory
// indexers like Glama) read carries machine-readable parameter semantics, not
// just the prose blob above. (An earlier note here claimed .describe() tripped
// TS2589 in the SDK's tool() generic; it no longer does — verified by tsc.)
export const GET_HOLDINGS_INPUT_SCHEMA = {
  account_id: z
    .string()
    .optional()
    .describe(
      "Scope to one account by id, e.g. 'metamask:0xabc123...' or 'bybit:UNIFIED'. Omit to query ALL configured accounts. Get valid ids from list_accounts."
    ),
  asset_class: z
    .enum(["crypto", "stock", "prediction", "cash"])
    .optional()
    .describe(
      "Scope to one asset class. 'prediction' = Polymarket conditional tokens; 'cash' = stablecoin/fiat balances. Omit for all classes."
    ),
  currency: z
    .enum(["USD", "EUR", "GBP", "HUF"])
    .optional()
    .describe(
      "Display currency for value/currentPrice/avgCost (default 'USD'). Non-USD converts via live FX; the rate and source appear in meta.fx. Display-only — underlying data is unchanged."
    ),
};

export interface GetHoldingsArgs {
  account_id?: string;
  asset_class?: "crypto" | "stock" | "prediction" | "cash";
  currency?: Currency;
}

export interface GetHoldingsResult {
  holdings: Array<{
    accountId: string;
    symbol: string;
    assetClass: string;
    quantity: number;
    avgCost?: number;
    currentPrice?: number;
    value?: number;
    valueCurrency: string;
    metadata?: Record<string, unknown>;
    fetchedAt: string;          // ISO 8601 — easier for the LLM to reason about than epoch ms
  }>;
  failures: Array<{
    accountId: string;
    error: string;
  }>;
  warnings: string[];           // per-chain soft-skips, etc. (e.g. "BSC requires Etherscan Pro")
  meta: {
    accountsConfigured: number;     // total accounts in the registry (independent of filter)
    accountsQueried: number;        // accounts the request actually targeted (= 1 if account_id filter, else accountsConfigured)
    accountsWithData: number;       // queried accounts that returned at least one matching holding
    accountsWithEmptyResults: number; // queried accounts that returned ok but no matching holdings (vs errors)
    accountsWithErrors: number;
    scope: {                        // explicit filter context, so "0 results" is interpretable
      accountIdFilter: string | null;
      assetClassFilter: string | null;
      currency: Currency;            // currency the response is denominated in (default "USD")
    };
    // FX info — present iff currency was non-USD. Surfaces the source so the
    // caller can warn the user if rates came from the static fallback (stale).
    fx?: {
      targetCurrency: Currency;
      source: FxSource;
      // 1 USD = N targetCurrency. Useful for the LLM to explain the conversion.
      rateUsdToTarget: number;
      fetchedAt: string;
    };
    asOf: string;
  };
}

export async function executeGetHoldings(
  args: GetHoldingsArgs,
  orchestrator: Orchestrator = defaultOrchestrator()
): Promise<GetHoldingsResult> {
  const accountIds = args.account_id ? [args.account_id] : undefined;
  const aggregate = await orchestrator.getHoldings(accountIds);

  const filtered: Holding[] = args.asset_class
    ? aggregate.data.filter((h) => h.assetClass === args.asset_class)
    : aggregate.data;

  // Drain per-connector warnings that connectors stash in metadata.__chainWarnings
  // as a side-channel (Result<T> can't carry top-level warnings without changing
  // the Connector interface). The orchestrator has full visibility into all the
  // raw Holdings returned (not just filtered ones), so we read warnings from
  // aggregate.data, not filtered.
  const warnings: string[] = [];
  for (const h of aggregate.data) {
    const w = h.metadata?.__chainWarnings;
    if (Array.isArray(w)) {
      for (const msg of w) if (typeof msg === "string") warnings.push(msg);
    }
  }

  // Currency conversion (display layer). USD is the storage default — only fetch
  // FX rates when the caller wants something else. On any failure the FX module
  // returns hardcoded fallback rates with source: "fallback", which we surface as
  // a warning so the LLM/user knows the displayed numbers may be a few percent off.
  // The conversion itself happens at response-build time (the .map() below) so
  // we never mutate cache-shared Holding objects.
  const targetCurrency: Currency = args.currency ?? "USD";
  let fxMeta: GetHoldingsResult["meta"]["fx"] | undefined;
  let convertedRates: FxRates | null = null;
  if (targetCurrency !== "USD") {
    const fxResult = await fetchFxRates();
    if (fxResult.ok) {
      convertedRates = fxResult.value;
      fxMeta = {
        targetCurrency,
        source: fxResult.value.source,
        rateUsdToTarget: rateFromUsd(targetCurrency, fxResult.value),
        fetchedAt: new Date(fxResult.value.fetchedAt).toISOString(),
      };
      if (fxResult.value.source === "fallback") {
        warnings.push(
          `FX rates are from the static fallback (both upstream APIs failed). Converted values may be a few percent off.`
        );
      }
    }
  }

  const accountsConfigured = orchestrator.listAccounts().length;
  const accountsQueried = accountIds ? accountIds.length : accountsConfigured;
  const accountsWithData = new Set(filtered.map((h) => h.accountId)).size;

  // "Empty result" = the orchestrator returned ok([]) for that account but no
  // holding matched the filter (or the connector returned no holdings at all).
  const queriedAccountIds = new Set<string>(
    accountIds ?? orchestrator.listAccounts().map((a) => a.id)
  );
  const accountsWithErrorsSet = new Set(aggregate.failures.map((f) => f.accountId));
  const accountsWithDataSet = new Set(filtered.map((h) => h.accountId));
  let accountsWithEmptyResults = 0;
  for (const id of queriedAccountIds) {
    if (accountsWithErrorsSet.has(id)) continue;
    if (!accountsWithDataSet.has(id)) accountsWithEmptyResults++;
  }

  return {
    holdings: filtered.map((h) => {
      // Strip __chainWarnings from outgoing metadata — they're surfaced in the
      // top-level `warnings` field, no need to leak the side-channel marker.
      const { __chainWarnings: _w, ...cleanMeta } = (h.metadata ?? {}) as Record<string, unknown>;
      // Apply FX conversion at response-build time (no mutation of cache-shared objects).
      // Only USD-denominated holdings convert; anything else (rare) keeps its tag.
      const shouldConvert = convertedRates !== null && h.valueCurrency === "USD";
      const value = shouldConvert && h.value !== undefined
        ? convert(h.value, "USD", targetCurrency, convertedRates!)
        : h.value;
      const currentPrice = shouldConvert && h.currentPrice !== undefined
        ? convert(h.currentPrice, "USD", targetCurrency, convertedRates!)
        : h.currentPrice;
      const avgCost = shouldConvert && h.avgCost !== undefined
        ? convert(h.avgCost, "USD", targetCurrency, convertedRates!)
        : h.avgCost;
      const valueCurrency = shouldConvert ? targetCurrency : h.valueCurrency;
      return {
        accountId: h.accountId,
        symbol: h.symbol,
        assetClass: h.assetClass,
        quantity: h.quantity,
        avgCost,
        currentPrice,
        value,
        valueCurrency,
        metadata: Object.keys(cleanMeta).length > 0 ? cleanMeta : undefined,
        fetchedAt: new Date(h.fetchedAt).toISOString(),
      };
    }),
    failures: aggregate.failures,
    warnings,
    meta: {
      accountsConfigured,
      accountsQueried,
      accountsWithData,
      accountsWithEmptyResults,
      accountsWithErrors: aggregate.failures.length,
      scope: {
        accountIdFilter: args.account_id ?? null,
        assetClassFilter: args.asset_class ?? null,
        currency: targetCurrency,
      },
      ...(fxMeta ? { fx: fxMeta } : {}),
      asOf: new Date().toISOString(),
    },
  };
}
