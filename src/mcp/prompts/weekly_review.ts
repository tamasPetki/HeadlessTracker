// Prompt: weekly-review
// 7-day delta + recent trades + observations. Run on Sundays / Fridays /
// whenever the user wants a "how am I doing this week" report.

import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const WEEKLY_REVIEW_PROMPT_NAME = "weekly-review";

export const WEEKLY_REVIEW_PROMPT_CONFIG = {
  title: "Weekly Review",
  description:
    "7-day portfolio review: window delta, biggest movers, recent trades, observations. Calls get_pnl with timeframe=7d, get_holdings, and get_transactions with since=7d.",
};

export function buildWeeklyReviewPrompt(): GetPromptResult {
  return {
    description: WEEKLY_REVIEW_PROMPT_CONFIG.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Give me a weekly portfolio review using the headless-tracker MCP server.",
            "",
            "Steps:",
            "1. Call these tools in parallel: `get_pnl` with `timeframe: '7d'`, `get_holdings`, and `get_transactions` with `since: '7d'`.",
            "2. Produce a markdown report with these sections:",
            "   - **7-day window delta**: pull `total.windowDelta` from the get_pnl response. Show historicalValue, current value, delta in USD AND percent. State plainly the approximation: 'this is your CURRENT basket valued at 7-day-old prices vs now — it does NOT account for trades within the window'.",
            "   - **Biggest movers**: identify the top 3 individual holdings by absolute USD change (current value vs holding the same quantity 7d ago). If we don't have that per-holding info, call out the gap honestly. Highlight gainers and losers separately.",
            "   - **Trades this week**: count + list of buys/sells from the get_transactions response. Group by exchange/wallet. Total volume in USD if available.",
            "   - **Skipped from window delta**: list `total.windowDelta.skippedReasons` if non-empty so the user knows which positions weren't included (Polymarket positions, custom tokens without a CoinGecko mapping).",
            "   - **One observation**: a single short paragraph naming the most useful thing to know — e.g. 'BTC drove most of the gain', 'concentrated in 2 positions', 'no realized PnL this week, only paper'. Be specific. Avoid generic platitudes.",
            "3. Tone: short, factual, no hype. The user is checking in on their own money, not reading marketing copy.",
            "",
            "If the user has no transactions in the window OR no priced holdings (Polymarket-only portfolio), say so plainly and skip the empty sections rather than fabricating content.",
          ].join("\n"),
        },
      },
    ],
  };
}
