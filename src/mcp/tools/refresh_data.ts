// Tool: refresh_data
// Forces a fresh fetch from the upstream API, bypassing the cache.
// Use when the user explicitly says "refresh", "update", "get the latest",
// or implies they need real-time data ("right now", "this moment").

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { ConnectorId } from "../../types.ts";

export const REFRESH_DATA_TOOL_NAME = "refresh_data";

export const REFRESH_DATA_DESCRIPTION = [
  "Invalidates the cache and forces a fresh fetch from upstream APIs on the next call.",
  "Use this when the user asks: 'refresh', 'update my data', 'get the latest',",
  "'fetch now', 'check current prices', or implies real-time freshness is required.",
  "",
  "Optionally scope to a single connector (bybit, metamask, polymarket).",
  "Without a scope, invalidates everything.",
  "",
  "After calling this, follow up with get_holdings or another data tool to actually",
  "fetch the fresh data — refresh_data only marks the cache as stale, it does not",
  "trigger fetches on its own.",
].join(" ");

// Schema kept simple (no chained .describe()) to avoid TS2589 inference depth
// errors in @modelcontextprotocol/sdk's tool() generic. Argument descriptions
// live in REFRESH_DATA_DESCRIPTION instead.
export const REFRESH_DATA_INPUT_SCHEMA = {
  connector: z.enum(["bybit", "metamask", "polymarket"]).optional(),
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
