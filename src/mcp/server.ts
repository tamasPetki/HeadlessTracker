// MCP server entry point.
// Boots an McpServer, registers all V0 tools, attaches stdio transport.
// Wired from bin/headless-tracker.ts when invoked without subcommand args
// (the default mode for claude_desktop_config.json).
//
// V0.6 (Day 6): all 6 tools wired:
//   get_holdings, refresh_data, get_pnl, get_polymarket_positions,
//   get_transactions, get_allocations.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  GET_HOLDINGS_TOOL_NAME,
  GET_HOLDINGS_DESCRIPTION,
  GET_HOLDINGS_INPUT_SCHEMA,
  executeGetHoldings,
} from "./tools/get_holdings.ts";
import {
  REFRESH_DATA_TOOL_NAME,
  REFRESH_DATA_DESCRIPTION,
  REFRESH_DATA_INPUT_SCHEMA,
  executeRefreshData,
} from "./tools/refresh_data.ts";
import {
  GET_PNL_TOOL_NAME,
  GET_PNL_DESCRIPTION,
  GET_PNL_INPUT_SCHEMA,
  executeGetPnl,
} from "./tools/get_pnl.ts";
import {
  GET_POLYMARKET_POSITIONS_TOOL_NAME,
  GET_POLYMARKET_POSITIONS_DESCRIPTION,
  GET_POLYMARKET_POSITIONS_INPUT_SCHEMA,
  executeGetPolymarketPositions,
} from "./tools/get_polymarket_positions.ts";
import {
  GET_TRANSACTIONS_TOOL_NAME,
  GET_TRANSACTIONS_DESCRIPTION,
  GET_TRANSACTIONS_INPUT_SCHEMA,
  executeGetTransactions,
} from "./tools/get_transactions.ts";
import {
  GET_ALLOCATIONS_TOOL_NAME,
  GET_ALLOCATIONS_DESCRIPTION,
  GET_ALLOCATIONS_INPUT_SCHEMA,
  executeGetAllocations,
} from "./tools/get_allocations.ts";
import {
  DASHBOARD_PROMPT_NAME,
  DASHBOARD_PROMPT_CONFIG,
  buildDashboardPrompt,
} from "./prompts/dashboard.ts";
import {
  WEEKLY_REVIEW_PROMPT_NAME,
  WEEKLY_REVIEW_PROMPT_CONFIG,
  buildWeeklyReviewPrompt,
} from "./prompts/weekly_review.ts";
import {
  RISK_CHECK_PROMPT_NAME,
  RISK_CHECK_PROMPT_CONFIG,
  buildRiskCheckPrompt,
} from "./prompts/risk_check.ts";
import { registerDashboardApp } from "./apps/dashboard/register.ts";
import { registerSettingsApp } from "./apps/settings/register.ts";
import {
  LIST_ACCOUNTS_TOOL_NAME,
  LIST_ACCOUNTS_DESCRIPTION,
  LIST_ACCOUNTS_INPUT_SCHEMA,
  executeListAccounts,
} from "./tools/list_accounts.ts";
import {
  SETUP_CONNECTOR_TOOL_NAME,
  SETUP_CONNECTOR_DESCRIPTION,
  SETUP_CONNECTOR_INPUT_SCHEMA,
  executeSetupConnector,
} from "./tools/setup_connector.ts";
import {
  ADD_WALLET_ADDRESS_TOOL_NAME,
  ADD_WALLET_ADDRESS_DESCRIPTION,
  ADD_WALLET_ADDRESS_INPUT_SCHEMA,
  executeAddWalletAddress,
  REMOVE_ACCOUNT_TOOL_NAME,
  REMOVE_ACCOUNT_DESCRIPTION,
  REMOVE_ACCOUNT_INPUT_SCHEMA,
  executeRemoveAccount,
} from "./tools/account_admin.ts";
import {
  ADD_CUSTOM_TOKEN_TOOL_NAME,
  ADD_CUSTOM_TOKEN_DESCRIPTION,
  ADD_CUSTOM_TOKEN_INPUT_SCHEMA,
  executeAddCustomToken,
  REMOVE_CUSTOM_TOKEN_TOOL_NAME,
  REMOVE_CUSTOM_TOKEN_DESCRIPTION,
  REMOVE_CUSTOM_TOKEN_INPUT_SCHEMA,
  executeRemoveCustomToken,
  LIST_CUSTOM_TOKENS_TOOL_NAME,
  LIST_CUSTOM_TOKENS_DESCRIPTION,
  LIST_CUSTOM_TOKENS_INPUT_SCHEMA,
  executeListCustomTokens,
} from "./tools/token_admin.ts";

const SERVER_NAME = "headless-tracker";
const SERVER_VERSION = "0.12.0";

// Surfaces in the InitializeResult.instructions field, which Claude Desktop
// (and most MCP hosts) inject into the system prompt. Cuts wasted tool_search
// roundtrips on lazy-loading hosts: when the user asks "what do I own", the
// model already knows which tool maps to that intent and can call it directly
// instead of doing a metadata-discovery hop first.
//
// Aim: under 2KB. Sectioned for skimmability. Don't repeat each tool's full
// description (those load on demand) — just the routing hints + caveats the
// model can't infer from the schema alone.
const SERVER_INSTRUCTIONS = `headless-tracker is a local-first PORTFOLIO TRACKER for crypto holdings, prediction markets, and on-chain wallets (Bybit exchange + MetaMask multi-chain + Polymarket + Solana wallets). All tools and apps in this server are scoped to that domain.

DOMAIN ANCHOR (avoid cross-server confusion): if the user's request is about anything OTHER than crypto/wallet/portfolio/exchange data — Vercel deployments, Sentry errors, Grafana metrics, GitHub activity, browser settings, app settings, OS preferences, email accounts, social accounts — DO NOT call headless-tracker tools. Defer to the appropriate MCP server. When the user says generic things like 'open dashboard' or 'open settings' WITHOUT context implying portfolio, ask for clarification before invoking render_dashboard / render_settings.

WHAT YOU CAN ANSWER WITHOUT EXTRA TOOL DISCOVERY (call the named tool directly):

- "what do I own" / "my holdings" / "current positions" / "balance" → get_holdings
  - Optional: account_id, asset_class, currency (USD|EUR|GBP|HUF — display-converted via live FX)
- "how am I doing" / "P&L" / "profit" / "up or down" → get_pnl
  - For honest realized P&L from transaction history, pass include_history=true
  - method=fifo (default) or method=average; Polymarket realizedPnl is null without include_history
  - timeframe=24h|7d|30d|ytd|all; non-'all' enables a windowDelta block (current basket at historical prices vs now — does NOT account for trades within the window)
- "show my Polymarket bets" / "election bets" / "prediction markets" → get_polymarket_positions (use group_by_event=true)
- "recent trades" / "transactions" → get_transactions with since='7d' / '24h' / etc.
- "how is my portfolio split" / "biggest positions" / "allocation" → get_allocations (by=asset_class|connector|account|chain|symbol)
- "refresh" / "fetch fresh data" → refresh_data (rarely needed; per-connector cache TTL is 30s-120s and fan-out auto-refreshes)
- "show my dashboard" / "render dashboard" / "open dashboard" → render_dashboard (MCP App; renders a live interactive 3-tab panel — Portfolio / Weekly / Risk — when the host supports MCP Apps)
- "set up an account" / "add Bybit" / "connect MetaMask" / "connect Solana" / "remove this connection" / "show my accounts" / "add a custom token" / "track another wallet" → render_settings (MCP App; live Settings panel with Accounts / Add Account / Wallets / Custom Tokens tabs)
- "list my accounts" → list_accounts (read-only, no UI; for inline answers)
- The Settings UI is preferred for credential entry — keeps secrets out of the chat transcript. If the user pastes credentials inline, point them at render_settings rather than calling setup_connector with the inline values.

PARALLELIZE: when the user wants a complete picture, call multiple data tools in ONE round-trip (in-flight Promise dedup deduplicates repeated calls per cache key; no penalty for overlap). The portfolio-dashboard / weekly-review / risk-check preset prompts demonstrate the canonical fan-outs.

CREDENTIAL HANDLING: NEVER echo, log, paraphrase, or repeat any apiKey / apiSecret / etherscanApiKey value back to the user. After a successful setup_connector call, confirm only the account label and id, not the secrets.

HONESTY RULES (do NOT fabricate around these):
- realizedPnl: null means cost basis is unknown — NOT zero. Don't report it as $0; explain the gap.
- windowDelta is approximate: current basket at historical prices, doesn't reflect trades within the window. Surface the caveat.
- skippedSymbols in windowDelta: tokens outside CoinGecko top 250 — name them, don't pretend they're priced.
- failures[] in any tool result: show the user, don't silently drop them.

CURRENCY: storage is USD-equivalent; pass currency=HUF/EUR/GBP to get_holdings for display conversion. The fx.source field tells you whether the rate is live or fallback (warn the user on fallback).`;

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Note: using the `tool()` API (marked @deprecated in SDK 1.29 in favor of
  // `registerTool()`), because `registerTool()`'s generic signature triggers
  // TS2589 "Type instantiation is excessively deep" when both InputArgs and
  // OutputArgs have to be inferred. `tool()` works identically at runtime with
  // simpler generics. Revisit once the SDK stabilizes the registerTool overloads.

  server.tool(
    GET_HOLDINGS_TOOL_NAME,
    GET_HOLDINGS_DESCRIPTION,
    GET_HOLDINGS_INPUT_SCHEMA,
    async (args) => {
      const result = await executeGetHoldings(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    REFRESH_DATA_TOOL_NAME,
    REFRESH_DATA_DESCRIPTION,
    REFRESH_DATA_INPUT_SCHEMA,
    async (args) => {
      const result = await executeRefreshData(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    GET_PNL_TOOL_NAME,
    GET_PNL_DESCRIPTION,
    GET_PNL_INPUT_SCHEMA,
    async (args) => {
      const result = await executeGetPnl(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    GET_POLYMARKET_POSITIONS_TOOL_NAME,
    GET_POLYMARKET_POSITIONS_DESCRIPTION,
    GET_POLYMARKET_POSITIONS_INPUT_SCHEMA,
    async (args) => {
      const result = await executeGetPolymarketPositions(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    GET_TRANSACTIONS_TOOL_NAME,
    GET_TRANSACTIONS_DESCRIPTION,
    GET_TRANSACTIONS_INPUT_SCHEMA,
    async (args) => {
      const result = await executeGetTransactions(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    GET_ALLOCATIONS_TOOL_NAME,
    GET_ALLOCATIONS_DESCRIPTION,
    GET_ALLOCATIONS_INPUT_SCHEMA,
    async (args) => {
      const result = await executeGetAllocations(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Preset prompts. Surface in Claude Desktop / Claude Code as one-click
  // templates for the most common multi-tool queries. The handlers are
  // pure (no upstream API calls) — they just emit the prompt text. Claude
  // executes the tools described inside the prompt body.
  server.registerPrompt(DASHBOARD_PROMPT_NAME, DASHBOARD_PROMPT_CONFIG, () => buildDashboardPrompt());
  server.registerPrompt(WEEKLY_REVIEW_PROMPT_NAME, WEEKLY_REVIEW_PROMPT_CONFIG, () => buildWeeklyReviewPrompt());
  server.registerPrompt(RISK_CHECK_PROMPT_NAME, RISK_CHECK_PROMPT_CONFIG, () => buildRiskCheckPrompt());

  // Account / setup admin tools. Backing for the Settings MCP App's tabs +
  // available standalone for the LLM when the user asks "what accounts are
  // configured", "add a Bybit account", etc.
  server.tool(
    LIST_ACCOUNTS_TOOL_NAME,
    LIST_ACCOUNTS_DESCRIPTION,
    LIST_ACCOUNTS_INPUT_SCHEMA,
    async (args) => {
      const result = executeListAccounts(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    SETUP_CONNECTOR_TOOL_NAME,
    SETUP_CONNECTOR_DESCRIPTION,
    SETUP_CONNECTOR_INPUT_SCHEMA,
    async (args) => {
      const result = await executeSetupConnector(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    ADD_WALLET_ADDRESS_TOOL_NAME,
    ADD_WALLET_ADDRESS_DESCRIPTION,
    ADD_WALLET_ADDRESS_INPUT_SCHEMA,
    async (args) => {
      const result = await executeAddWalletAddress(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    REMOVE_ACCOUNT_TOOL_NAME,
    REMOVE_ACCOUNT_DESCRIPTION,
    REMOVE_ACCOUNT_INPUT_SCHEMA,
    async (args) => {
      const result = await executeRemoveAccount(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    ADD_CUSTOM_TOKEN_TOOL_NAME,
    ADD_CUSTOM_TOKEN_DESCRIPTION,
    ADD_CUSTOM_TOKEN_INPUT_SCHEMA,
    async (args) => {
      const result = executeAddCustomToken(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    REMOVE_CUSTOM_TOKEN_TOOL_NAME,
    REMOVE_CUSTOM_TOKEN_DESCRIPTION,
    REMOVE_CUSTOM_TOKEN_INPUT_SCHEMA,
    async (args) => {
      const result = executeRemoveCustomToken(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    LIST_CUSTOM_TOKENS_TOOL_NAME,
    LIST_CUSTOM_TOKENS_DESCRIPTION,
    LIST_CUSTOM_TOKENS_INPUT_SCHEMA,
    async (args) => {
      const result = executeListCustomTokens(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Interactive dashboard MCP App — registers `render_dashboard` tool +
  // bundled UI resource. Hosts that support the io.modelcontextprotocol/ui
  // extension (Claude Desktop, Goose, ChatGPT, VS Code, etc.) render the
  // tool's output as a sandboxed iframe with live tabs and refresh.
  registerDashboardApp(server);

  // Settings MCP App — `render_settings` tool with 4 tabs (Accounts / Add /
  // Wallets / Custom Tokens). GUI alternative to the CLI setup flow with an
  // explicit security disclosure surfacing the credential trust path.
  registerSettingsApp(server);

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep alive until stdin closes (claude_desktop kills the process on session end).
}

// Allow running this module directly via `bun run src/mcp/server.ts` for debugging.
if (import.meta.main) {
  runStdioServer().catch((e: Error) => {
    process.stderr.write(`MCP server fatal: ${e.message}\n${e.stack ?? ""}\n`);
    process.exit(1);
  });
}
