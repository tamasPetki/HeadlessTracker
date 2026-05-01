// Prompt: portfolio-dashboard
// Surfaces in Claude Desktop / Claude Code as a one-click way to generate a
// complete dashboard artifact. The prompt body steers Claude to call multiple
// MCP tools in parallel and produce a structured visual response.

import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const DASHBOARD_PROMPT_NAME = "portfolio-dashboard";

export const DASHBOARD_PROMPT_CONFIG = {
  title: "Portfolio Dashboard",
  description:
    "Generate a complete multi-section portfolio dashboard. Calls get_holdings, get_allocations, get_pnl, and get_polymarket_positions in parallel and synthesizes the result.",
};

export function buildDashboardPrompt(): GetPromptResult {
  return {
    description: DASHBOARD_PROMPT_CONFIG.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Build me a complete portfolio dashboard from the headless-tracker MCP server.",
            "",
            "Steps:",
            "1. Call these tools in parallel (one round-trip): `get_holdings`, `get_allocations` with `by: 'asset_class'`, `get_allocations` with `by: 'symbol'`, `get_pnl`, and `get_polymarket_positions` with `group_by_event: true`.",
            "2. Synthesize the output as ONE rendered artifact (HTML preferred — Claude can render it inline). Sections, in order:",
            "   - **Header**: total portfolio value, count of positions, count of accounts, asOf timestamp.",
            "   - **Allocation by asset class**: percentage breakdown (crypto / prediction / cash / stock). Use a horizontal bar or pie. Numbers in USD.",
            "   - **Top 10 positions by value**: table with symbol, account, quantity, USD value, % of portfolio.",
            "   - **PnL summary**: realized + unrealized total + per-account. Show NULL fields explicitly (don't fabricate).",
            "   - **Polymarket section**: positions grouped by event with current value and outcome. Skip this section entirely if no Polymarket account is configured.",
            "   - **Footer**: list any `failures[]` from the tool responses + any `warnings[]` so the user knows what's missing.",
            "3. Honesty rules:",
            "   - If a holding has no `currentPrice`, label it explicitly as 'price unknown'.",
            "   - Do NOT compute fake percentages from missing data.",
            "   - Do NOT call additional tools beyond the four listed unless the user asks a follow-up.",
            "",
            "Goal: a dashboard the user can read in 30 seconds and immediately know their portfolio state.",
          ].join("\n"),
        },
      },
    ],
  };
}
