// Tool: get_holdings
// The single most important tool — answers "what do I own?" / "what's in my portfolio?"
// across all configured accounts (Bybit, MetaMask wallets, Polymarket positions).
//
// Description quality matters (eng review 1E): the LLM picks tools by reading the
// description, so it's verbose and lists trigger phrases the user is likely to use.

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { ConnectorId, Holding } from "../../types.ts";

export const GET_HOLDINGS_TOOL_NAME = "get_holdings";

export const GET_HOLDINGS_DESCRIPTION = [
  "Returns current portfolio holdings across all connected accounts.",
  "Use this when the user asks: 'what do I own', 'show my portfolio', 'current positions',",
  "'what's my balance', 'show my holdings', 'how much BTC do I have', or wants any snapshot",
  "of crypto/stock/prediction-market positions.",
  "",
  "Each holding includes: symbol, asset class (crypto / stock / prediction / cash), quantity,",
  "current price, USD value, and connector-specific metadata (e.g. chain for EVM, market title",
  "for Polymarket, accountType for Bybit).",
  "",
  "Inputs (both optional):",
  "  - account_id: scope to one account, e.g. 'metamask:0xabc123...' or 'bybit:UNIFIED'.",
  "    Omit to query ALL configured accounts.",
  "  - asset_class: scope to one of 'crypto' / 'stock' / 'prediction' / 'cash'.",
  "    'prediction' = Polymarket conditional tokens. Omit for all classes.",
  "",
  "Results are cached per-connector (crypto wallets 60s, exchanges 120s, Polymarket 30s).",
  "Use 'refresh_data' tool first if the user explicitly asks for fresh / latest data.",
].join(" ");

// Schema kept simple (no chained .describe()) to avoid TS2589 inference depth
// errors in @modelcontextprotocol/sdk's tool() generic. Descriptions for each
// argument live in GET_HOLDINGS_DESCRIPTION above instead.
export const GET_HOLDINGS_INPUT_SCHEMA = {
  account_id: z.string().optional(),
  asset_class: z.enum(["crypto", "stock", "prediction", "cash"]).optional(),
};

export interface GetHoldingsArgs {
  account_id?: string;
  asset_class?: "crypto" | "stock" | "prediction" | "cash";
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
      return {
        accountId: h.accountId,
        symbol: h.symbol,
        assetClass: h.assetClass,
        quantity: h.quantity,
        avgCost: h.avgCost,
        currentPrice: h.currentPrice,
        value: h.value,
        valueCurrency: h.valueCurrency,
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
      },
      asOf: new Date().toISOString(),
    },
  };
}
