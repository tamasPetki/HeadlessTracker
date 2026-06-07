// Tool: get_polymarket_positions
// Specialized version of get_holdings filtered to Polymarket. Justified as a
// dedicated tool (not just `get_holdings({asset_class: "prediction"})`) because:
//   1. Tool selection accuracy — LLMs pick faster when the tool name explicitly
//      matches "Polymarket" / "prediction market" prompts.
//   2. Polymarket positions are conditional tokens with rich market metadata
//      (event slug, outcome name, redeemable flag) that benefit from a
//      Polymarket-native output shape, not a generic Holding[].
//   3. Event grouping — we can bundle related Yes/No outcomes for the same
//      market into one entry, which a generic holdings list can't.

import { z } from "zod";

import { defaultOrchestrator, type Orchestrator } from "../orchestrator.ts";
import type { Holding } from "../../types.ts";

export const GET_POLYMARKET_POSITIONS_TOOL_NAME = "get_polymarket_positions";

export const GET_POLYMARKET_POSITIONS_DESCRIPTION = [
  "Returns Polymarket prediction-market positions, grouped by event when possible.",
  "Use this when the user asks about their Polymarket bets specifically:",
  "  'show my Polymarket positions', 'how am I doing on Polymarket', 'what bets do I have',",
  "  'show my prediction market positions', 'election bets', 'sports bets', etc.",
  "",
  "For general portfolio queries that mention Polymarket alongside crypto/stocks,",
  "prefer get_holdings (with optional asset_class='prediction' filter).",
  "",
  "Each position includes:",
  "  - market title (human-readable question, e.g. 'Will X win the 2024 election?')",
  "  - outcome ('Yes' / 'No' / specific candidate name)",
  "  - quantity (conditional tokens held, each worth 0-1 USDC)",
  "  - currentPrice (0-1, market's current implied probability)",
  "  - currentValue (USD), avgCost (USD per token), cashPnl (realized + unrealized)",
  "  - redeemable (true if market resolved and you can claim payout)",
  "  - mergeable (true if you can merge Yes+No tokens for guaranteed USDC)",
  "  - endDate (when the market resolves)",
  "",
  "Inputs (optional):",
  "  - account_id: scope to one Polymarket account (if you have multiple).",
  "  - group_by_event: 'true' (default) groups Yes+No outcomes for the same market;",
  "    'false' returns one row per asset.",
  "  - resolved_only: 'true' returns only redeemable positions (markets that have resolved).",
  "    Default 'false' returns everything.",
  "Returns position data only. Not financial advice.",
].join(" ");

export const GET_POLYMARKET_POSITIONS_INPUT_SCHEMA = {
  account_id: z
    .string()
    .optional()
    .describe("Scope to one Polymarket account if several are configured. Omit for all."),
  group_by_event: z
    .boolean()
    .optional()
    .describe(
      "Default true: groups Yes+No outcomes of the same market into one event row. Set false for one row per asset/outcome."
    ),
  resolved_only: z
    .boolean()
    .optional()
    .describe(
      "Default false (return all positions). Set true to return only redeemable positions in markets that have already resolved."
    ),
};

export interface GetPolymarketPositionsArgs {
  account_id?: string;
  group_by_event?: boolean;
  resolved_only?: boolean;
}

interface PolymarketPositionView {
  accountId: string;
  marketTitle: string;
  marketSlug: string;
  eventId: string | null;
  eventSlug: string | null;
  outcome: string;
  quantity: number;
  avgCost: number | null;
  currentPrice: number;
  currentValue: number;
  initialValue: number | null;
  cashPnl: number | null;
  percentPnl: number | null;
  realizedPnl: number | null;
  redeemable: boolean;
  mergeable: boolean;
  endDate: string | null;
  negativeRisk: boolean;
}

interface EventGroupView {
  eventId: string | null;
  eventSlug: string | null;
  marketTitle: string;
  endDate: string | null;
  totalCurrentValue: number;
  totalCashPnl: number;
  positions: PolymarketPositionView[];
}

export interface GetPolymarketPositionsResult {
  positions?: PolymarketPositionView[];      // present when group_by_event=false
  events?: EventGroupView[];                  // present when group_by_event=true (default)
  meta: {
    totalPositions: number;
    totalCurrentValue: number;
    totalCashPnl: number;
    redeemableCount: number;
    mergeableCount: number;
    asOf: string;
  };
  failures: Array<{ accountId: string; error: string }>;
}

function toView(h: Holding): PolymarketPositionView {
  const meta = (h.metadata ?? {}) as Record<string, unknown>;
  return {
    accountId: h.accountId,
    marketTitle: typeof meta.title === "string" ? meta.title : h.symbol,
    marketSlug: typeof meta.slug === "string" ? meta.slug : "",
    eventId: typeof meta.eventId === "string" ? meta.eventId : null,
    eventSlug: typeof meta.eventSlug === "string" ? meta.eventSlug : null,
    outcome: typeof meta.outcome === "string" ? meta.outcome : "?",
    quantity: h.quantity,
    avgCost: h.avgCost ?? null,
    currentPrice: h.currentPrice ?? 0,
    currentValue: h.value ?? 0,
    initialValue: typeof meta.initialValue === "number" ? meta.initialValue : null,
    cashPnl: typeof meta.cashPnl === "number" ? meta.cashPnl : null,
    percentPnl: typeof meta.percentPnl === "number" ? meta.percentPnl : null,
    realizedPnl: typeof meta.realizedPnl === "number" ? meta.realizedPnl : null,
    redeemable: meta.redeemable === true,
    mergeable: meta.mergeable === true,
    endDate: typeof meta.endDate === "string" ? meta.endDate : null,
    negativeRisk: meta.negativeRisk === true,
  };
}

export async function executeGetPolymarketPositions(
  args: GetPolymarketPositionsArgs,
  orchestrator: Orchestrator = defaultOrchestrator()
): Promise<GetPolymarketPositionsResult> {
  // Filter to Polymarket-only accounts.
  let accountIds: string[] | undefined;
  if (args.account_id) {
    accountIds = [args.account_id];
  } else {
    const polyAccounts = orchestrator.listAccounts("polymarket");
    accountIds = polyAccounts.map((a) => a.id);
  }

  if (accountIds && accountIds.length === 0) {
    return {
      positions: [],
      meta: {
        totalPositions: 0,
        totalCurrentValue: 0,
        totalCashPnl: 0,
        redeemableCount: 0,
        mergeableCount: 0,
        asOf: new Date().toISOString(),
      },
      failures: [],
    };
  }

  const aggregate = await orchestrator.getHoldings(accountIds);

  let positions = aggregate.data
    .filter((h) => h.assetClass === "prediction")
    .map(toView);

  if (args.resolved_only) {
    positions = positions.filter((p) => p.redeemable);
  }

  const totalCurrentValue = positions.reduce((s, p) => s + p.currentValue, 0);
  const totalCashPnl = positions.reduce((s, p) => s + (p.cashPnl ?? 0), 0);
  const redeemableCount = positions.filter((p) => p.redeemable).length;
  const mergeableCount = positions.filter((p) => p.mergeable).length;

  const meta = {
    totalPositions: positions.length,
    totalCurrentValue,
    totalCashPnl,
    redeemableCount,
    mergeableCount,
    asOf: new Date().toISOString(),
  };

  // Default: group by event.
  const groupByEvent = args.group_by_event !== false;
  if (!groupByEvent) {
    return { positions, meta, failures: aggregate.failures };
  }

  const eventMap = new Map<string, EventGroupView>();
  for (const p of positions) {
    // Group key: prefer eventId, then eventSlug, then marketSlug.
    const key = p.eventId ?? p.eventSlug ?? p.marketSlug ?? p.marketTitle;
    const existing = eventMap.get(key);
    if (existing) {
      existing.positions.push(p);
      existing.totalCurrentValue += p.currentValue;
      existing.totalCashPnl += p.cashPnl ?? 0;
    } else {
      eventMap.set(key, {
        eventId: p.eventId,
        eventSlug: p.eventSlug,
        marketTitle: p.marketTitle,
        endDate: p.endDate,
        totalCurrentValue: p.currentValue,
        totalCashPnl: p.cashPnl ?? 0,
        positions: [p],
      });
    }
  }

  return {
    events: Array.from(eventMap.values()).sort((a, b) => b.totalCurrentValue - a.totalCurrentValue),
    meta,
    failures: aggregate.failures,
  };
}
