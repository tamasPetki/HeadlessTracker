// Tool: get_allocations
// Aggregates current portfolio value into groups for breakdown analysis.
// "What % of my portfolio is crypto vs stocks vs prediction markets?"
// "How is my crypto split across chains?"
// "Which wallet holds the most value?"

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { Holding } from "../../types.ts";

export const GET_ALLOCATIONS_TOOL_NAME = "get_allocations";

export const GET_ALLOCATIONS_DESCRIPTION = [
  "Returns portfolio allocation breakdown — current USD value grouped by a chosen dimension.",
  "Use this whenever the user asks how their money is DIVIDED or COMPOSED — any 'how much is in X vs Y', percentage, or share-of-total question, even when phrased as 'how much do I have in...'.",
  "Examples: 'how is my portfolio split', 'allocation breakdown', 'what % is in crypto', 'how much of my money is in stablecoins vs crypto', 'stablecoins vs crypto', 'what percentage is in stablecoins', 'how exposed am I to volatile coins vs stable', 'chain breakdown', 'show my biggest position', 'concentration'.",
  "",
  "Groups available:",
  "  - 'asset_class' (default): crypto / stock / prediction / cash (cash = stablecoins like USDC/USDT + fiat)",
  "  - 'connector':            bybit / metamask / polymarket",
  "  - 'account':              one row per configured account",
  "  - 'chain':                EVM chain (Ethereum / Polygon / etc.) — only meaningful for MetaMask holdings",
  "  - 'symbol':               BTC / ETH / individual market — best for top-N concentration analysis",
  "",
  "Each group row includes: label, currentValue (USD), percentOfTotal, holdingCount.",
  "Sorted descending by currentValue.",
  "",
  "Inputs:",
  "  - by: which dimension to group by (see above). Default 'asset_class'.",
  "  - top: limit to top N rows (e.g. top: 10 for biggest positions). Default no limit.",
  "Returns position data only. Not financial advice.",
].join(" ");

export const GET_ALLOCATIONS_INPUT_SCHEMA = {
  by: z
    .enum(["asset_class", "connector", "account", "chain", "symbol"])
    .optional()
    .describe(
      "Dimension to group USD value by (default 'asset_class'). 'chain' is only meaningful for MetaMask holdings; 'symbol' is best for top-N concentration analysis."
    ),
  top: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Limit to the top N rows by value (e.g. 10 for biggest positions). Omit for no limit."),
};

export interface GetAllocationsArgs {
  by?: "asset_class" | "connector" | "account" | "chain" | "symbol";
  top?: number;
}

interface AllocationRow {
  label: string;
  currentValue: number;
  percentOfTotal: number;
  holdingCount: number;
}

export interface GetAllocationsResult {
  groupedBy: string;
  rows: AllocationRow[];
  meta: {
    totalCurrentValue: number;
    totalHoldings: number;
    rowCount: number;
    truncatedTo: number | null;
    asOf: string;
  };
  failures: Array<{ accountId: string; error: string }>;
}

function groupKey(h: Holding, by: string): string {
  switch (by) {
    case "asset_class":
      return h.assetClass;
    case "connector": {
      // Account.id is "{connectorId}:{rest}" — slice prefix.
      const colon = h.accountId.indexOf(":");
      return colon > 0 ? h.accountId.slice(0, colon) : h.accountId;
    }
    case "account":
      return h.accountId;
    case "chain": {
      const meta = h.metadata ?? {};
      if (typeof meta.chainName === "string") return meta.chainName;
      if (typeof meta.chainId === "number") return `chain:${meta.chainId}`;
      // Non-EVM holdings (Bybit, Polymarket) get a "n/a" bucket.
      return "n/a (non-EVM)";
    }
    case "symbol":
    default:
      return h.symbol;
  }
}

export async function executeGetAllocations(
  args: GetAllocationsArgs,
  orchestrator: Orchestrator = defaultOrchestrator()
): Promise<GetAllocationsResult> {
  const by = args.by ?? "asset_class";
  const aggregate = await orchestrator.getHoldings(undefined);

  const buckets = new Map<string, { value: number; count: number }>();
  let totalValue = 0;

  for (const h of aggregate.data) {
    const key = groupKey(h, by);
    const v = h.value ?? 0;
    totalValue += v;
    const existing = buckets.get(key) ?? { value: 0, count: 0 };
    existing.value += v;
    existing.count += 1;
    buckets.set(key, existing);
  }

  let rows: AllocationRow[] = Array.from(buckets.entries())
    .map(([label, { value, count }]) => ({
      label,
      currentValue: value,
      percentOfTotal: totalValue > 0 ? (value / totalValue) * 100 : 0,
      holdingCount: count,
    }))
    .sort((a, b) => b.currentValue - a.currentValue);

  const beforeTrunc = rows.length;
  if (args.top && rows.length > args.top) {
    rows = rows.slice(0, args.top);
  }

  return {
    groupedBy: by,
    rows,
    meta: {
      totalCurrentValue: totalValue,
      totalHoldings: aggregate.data.length,
      rowCount: rows.length,
      truncatedTo: args.top && beforeTrunc > args.top ? args.top : null,
      asOf: new Date().toISOString(),
    },
    failures: aggregate.failures,
  };
}
