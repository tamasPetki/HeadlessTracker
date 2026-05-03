// Tool: refresh_data
// Forces a fresh fetch from the upstream API, bypassing the cache.
// Use when the user explicitly says "refresh", "update", "get the latest",
// or implies they need real-time data ("right now", "this moment").

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { ConnectorId } from "../../types.ts";

export const REFRESH_DATA_TOOL_NAME = "refresh_data";

export const REFRESH_DATA_DESCRIPTION = [
  "Invalidates the PORTFOLIO TRACKER cache (Bybit/Binance/MetaMask/Polymarket/Solana holdings + transactions) and forces a fresh fetch from upstream APIs on the next call.",
  "Use this when the user asks: 'refresh my portfolio', 'update my holdings', 'get the latest portfolio prices',",
  "'fetch fresh portfolio data', 'check current crypto prices', or implies real-time freshness is required FOR THE TRACKER.",
  "",
  "Optionally scope to a single connector (bybit, binance, metamask, polymarket, solana).",
  "Without a scope, invalidates everything tracker-related.",
  "",
  "DO NOT call this tool when the user means: refreshing a webpage, refreshing an OAuth token, refreshing browser cache, refreshing data from a non-tracker MCP server. It only invalidates the headless-tracker SQLite cache.",
  "",
  "After calling this, follow up with get_holdings or another data tool to actually",
  "fetch the fresh data — refresh_data only marks the cache as stale, it does not",
  "trigger fetches on its own.",
].join(" ");

// Schema kept simple (no chained .describe()) to avoid TS2589 inference depth
// errors in @modelcontextprotocol/sdk's tool() generic. Argument descriptions
// live in REFRESH_DATA_DESCRIPTION instead.
export const REFRESH_DATA_INPUT_SCHEMA = {
  connector: z.enum(["bybit", "binance", "metamask", "polymarket", "solana"]).optional(),
};

export interface RefreshDataArgs {
  connector?: ConnectorId;
}

export interface RefreshDataResult {
  refreshed: ConnectorId[] | "all";
  asOf: string;
  hint: string;
}

export async function executeRefreshData(
  args: RefreshDataArgs,
  orchestrator: Orchestrator = defaultOrchestrator()
): Promise<RefreshDataResult> {
  if (args.connector) {
    orchestrator.refresh(args.connector);
    return {
      refreshed: [args.connector],
      asOf: new Date().toISOString(),
      hint: `Cache cleared for ${args.connector}. Call get_holdings (or another data tool) to fetch fresh data.`,
    };
  }
  orchestrator.refresh();
  return {
    refreshed: "all",
    asOf: new Date().toISOString(),
    hint: "Cache cleared for all connectors. Call get_holdings (or another data tool) to fetch fresh data.",
  };
}
