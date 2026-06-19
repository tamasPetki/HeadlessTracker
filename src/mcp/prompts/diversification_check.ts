// Prompt: diversification-check
// "Am I genuinely diversified, or just holding many things that move together?"
// Groups holdings into correlation CLUSTERS (not by chain or venue) so the user
// sees their real concentration: 10 tickers across 5 venues can still be one bet.
//
// Proposed by @hermessfo on Moltbook (2026-06-19) as a "concentration risk" view
// weighted by how correlated positions actually are — the multi-exchange illusion
// being the sneaky part. Implemented from that concept; the wording is ours.

import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const DIVERSIFICATION_CHECK_PROMPT_NAME = "diversification-check";

export const DIVERSIFICATION_CHECK_PROMPT_CONFIG = {
  title: "Diversification Check",
  description:
    "Groups holdings into correlation clusters (BTC-beta, ETH, SOL, other alts, stablecoins, prediction) to reveal real concentration — whether you're genuinely diversified or holding many positions that move together. Flags the multi-venue illusion. Calls get_holdings and get_allocations.",
};

export function buildDiversificationCheckPrompt(): GetPromptResult {
  return {
    description: DIVERSIFICATION_CHECK_PROMPT_CONFIG.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Do a diversification check on my portfolio using the headless-tracker MCP server. The question I want answered: am I genuinely diversified, or do I just hold a lot of positions that all move together?",
            "",
            "Steps:",
            "1. Call in parallel: `get_holdings` and `get_allocations` with `by: 'symbol'`.",
            "2. Group every crypto holding into correlation CLUSTERS — by how the assets historically move together, NOT by chain or venue. Use these buckets:",
            "   - **BTC-beta majors**: BTC, WBTC, and large caps that closely track Bitcoin.",
            "   - **ETH & ecosystem**: ETH, staked-ETH variants, L2 tokens, and ETH-correlated DeFi (e.g. LINK, UNI, AAVE).",
            "   - **SOL & ecosystem**: SOL and Solana-native tokens (e.g. JUP, JTO).",
            "   - **Other high-beta alts**: smaller alts that ride the broad risk-on / risk-off crypto cycle.",
            "   - **Stablecoins**: USDC / USDT / DAI / etc. Effectively uncorrelated to crypto *direction* — this is your real dry powder.",
            "   - **Prediction markets / idiosyncratic**: Polymarket and event-driven positions whose outcome is largely independent of crypto price.",
            "   Put each holding in exactly one bucket. If a token is genuinely ambiguous, say so and place it in 'Other high-beta alts'.",
            "3. Compute each cluster's total USD value and % of the portfolio. Output a table: cluster, USD, %, and the holdings inside it.",
            "4. The key read — **true diversification**:",
            "   - The single LARGEST cluster's % is your REAL concentration, no matter how many tickers or venues it's spread across. State it plainly, e.g. 'X% of your book is one correlated bet (BTC-beta), spread across N tickers and M venues.'",
            "   - Call out the **multi-venue illusion** explicitly: holding correlated assets on different exchanges/wallets spreads *custody* risk, not *market* risk. Diversifying WHERE you hold is not diversifying WHAT you hold.",
            "   - State how much of the book is genuinely uncorrelated (stablecoins + prediction): that's the only part that doesn't fall together in a market-wide drawdown.",
            "5. Honesty rules:",
            "   - This is a STRUCTURAL grouping by well-known correlation behaviour, NOT a correlation coefficient computed from this portfolio's own price history. Say that. Real correlations drift, and in a sharp risk-off almost everything except stablecoins correlates toward 1.",
            "   - Use the actual numbers from the tool responses. Flag ambiguous tokens rather than bucketing them with false confidence.",
            "   - Describe the structure only. Do NOT recommend trades or tell the user what to buy, sell, or hold.",
            "",
            "Goal: in 60 seconds the user should know whether '10 positions across 5 venues' is real diversification or one bet wearing a disguise.",
          ].join("\n"),
        },
      },
    ],
  };
}
