// MCP server entry point.
// Boots an McpServer, registers all V0 tools, attaches stdio transport.
// Wired from bin/headless-tracker.ts when invoked without subcommand args
// (the default mode for claude_desktop_config.json).
//
// Day 5 V0: 2 tools (get_holdings, refresh_data) — proves the integration
// end-to-end. Day 6 adds the remaining 4 (get_pnl, get_polymarket_positions,
// get_transactions, get_allocations).

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

const SERVER_NAME = "headless-tracker";
const SERVER_VERSION = "0.5.0-day5";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
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

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep alive until stdin closes (claude_desktop kills the process on session end).
  // No setInterval needed — connect() returns immediately, the transport keeps the
  // event loop busy via stdin's readable stream.
}

// Allow running this module directly via `bun run src/mcp/server.ts` for debugging,
// in addition to being imported by bin/headless-tracker.ts.
if (import.meta.main) {
  runStdioServer().catch((e: Error) => {
    process.stderr.write(`MCP server fatal: ${e.message}\n${e.stack ?? ""}\n`);
    process.exit(1);
  });
}
