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
  meta: {
    totalAccounts: number;
    accountsWithData: number;
    accountsWithErrors: number;
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

  const accountsWithData = new Set(filtered.map((h) => h.accountId)).size;

  return {
    holdings: filtered.map((h) => ({
      accountId: h.accountId,
      symbol: h.symbol,
      assetClass: h.assetClass,
      quantity: h.quantity,
      avgCost: h.avgCost,
      currentPrice: h.currentPrice,
      value: h.value,
      valueCurrency: h.valueCurrency,
      metadata: h.metadata,
      fetchedAt: new Date(h.fetchedAt).toISOString(),
    })),
    failures: aggregate.failures,
    meta: {
      totalAccounts: orchestrator.listAccounts().length,
      accountsWithData,
      accountsWithErrors: aggregate.failures.length,
      asOf: new Date().toISOString(),
    },
  };
}
