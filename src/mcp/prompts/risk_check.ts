// Prompt: risk-check
// Concentration + venue exposure + stablecoin reserve check. Surfaces obvious
// risks the user might not be tracking explicitly: too much in one asset,
// too much on one exchange, no stablecoin buffer, prediction-market overweight.

import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const RISK_CHECK_PROMPT_NAME = "risk-check";

export const RISK_CHECK_PROMPT_CONFIG = {
  title: "Risk Check",
  description:
    "Concentration and risk audit: largest positions, venue exposure, stablecoin reserves, asset-class mix. Flags portfolio-level risks like single-position dominance or no stablecoin buffer.",
};

export function buildRiskCheckPrompt(): GetPromptResult {
  return {
    description: RISK_CHECK_PROMPT_CONFIG.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Do a risk check on my portfolio using the headless-tracker MCP server.",
            "",
            "Steps:",
            "1. Call in parallel: `get_holdings`, `get_allocations` with `by: 'symbol'`, `get_allocations` with `by: 'asset_class'`, `get_allocations` with `by: 'connector'`.",
            "2. Compute the portfolio total value from the holdings response, then evaluate each of these risk dimensions and report PASS / WARN / ALERT for each:",
            "   - **Single-position concentration**: ALERT if any single symbol > 40% of total, WARN if > 25%, else PASS. Name the symbol and its percentage.",
            "   - **Venue concentration**: ALERT if any single connector (bybit / metamask / polymarket) holds > 70% of total, WARN if > 50%, else PASS.",
            "   - **Stablecoin reserve**: WARN if stablecoin holdings (USDC / USDT / DAI / BUSD) are < 5% of total. ALERT if literally 0. Stablecoin reserve gives optionality to buy dips and pay fees without selling at a loss.",
            "   - **Prediction market overweight**: WARN if `prediction` asset class is > 15% of total. Polymarket positions are illiquid until resolution and many resolve to 0.",
            "   - **Chain concentration (MetaMask only)**: WARN if any single chain (Ethereum, Polygon, BSC, etc.) holds > 80% of MetaMask value. A bridge bug or chain halt can lock those funds.",
            "3. Output as a markdown table: `| Risk | Status | Detail |` plus one short summary paragraph at the end naming the single biggest risk if any ALERT triggered.",
            "4. Honesty rules:",
            "   - Use the actual numbers from the tool responses, not guesses.",
            "   - If a check can't run because data is missing (e.g. no MetaMask account → skip the chain concentration row), say that explicitly rather than scoring it PASS.",
            "   - Don't add risk dimensions beyond the five listed unless the user asks.",
            "",
            "Goal: in 60 seconds the user should know whether their portfolio has any obvious structural risk they haven't already accepted.",
          ].join("\n"),
        },
      },
    ],
  };
}
