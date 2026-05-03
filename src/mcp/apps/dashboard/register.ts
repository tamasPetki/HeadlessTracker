// Server-side wiring for the dashboard MCP App.
//
// Registers ONE tool (`render_dashboard`) with `_meta.ui.resourceUri` pointing
// at the bundled HTML resource. When the host (Claude Desktop / etc.) calls
// the tool, it auto-fetches the resource and renders it as a sandboxed iframe
// in the chat panel — that iframe is the live dashboard.
//
// The bundled HTML is produced by `scripts/build-mcp-apps.ts` and lives at
// `dist/mcp-apps/dashboard.html`. We read it lazily on the first read of the
// resource (server boot stays cheap; the file is read once and cached for the
// lifetime of the process).

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const DASHBOARD_TOOL_NAME = "render_dashboard";
export const DASHBOARD_RESOURCE_URI = "ui://headless-tracker/dashboard";

// Resolve the bundled HTML relative to THIS source file. Works whether the
// package is run via `bun run` from the dev tree or installed via `bunx` —
// both keep src/mcp/apps/dashboard/register.ts at the same depth from the
// dist/mcp-apps/dashboard.html artifact.
const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_HTML_PATH = join(HERE, "..", "..", "..", "..", "dist", "mcp-apps", "dashboard.html");

let cachedHtml: string | null = null;
async function loadHtml(): Promise<string> {
  if (cachedHtml !== null) return cachedHtml;
  cachedHtml = await readFile(BUNDLED_HTML_PATH, "utf-8");
  return cachedHtml;
}

export const RENDER_DASHBOARD_DESCRIPTION = [
  "Render an interactive PORTFOLIO TRACKER dashboard as an MCP App (live UI panel) — for crypto holdings, P&L, prediction markets, on-chain wallets.",
  "Use this when the user asks: 'show my portfolio dashboard', 'open my dashboard', 'render the portfolio panel',",
  "or wants a live interactive view of holdings / weekly portfolio review / risk audit.",
  "Three tabs (Portfolio / Weekly / Risk) with currency switcher (USD/EUR/GBP/HUF) and refresh button.",
  "The iframe makes its own tool calls (get_holdings / get_pnl / get_allocations / get_transactions / get_polymarket_positions / refresh_data)",
  "as the user clicks tabs and refresh — no extra prompting from you needed once it's open.",
  "If the host doesn't render MCP Apps, the tool still returns a textual confirmation but the user won't get the live UI.",
  "",
  "DO NOT call this tool when the user means a different kind of dashboard (Vercel deploys, Sentry errors, Grafana metrics, GitHub activity, analytics events, etc.). It's specifically the headless-tracker portfolio dashboard. If the request is ambiguous, ask the user to clarify which dashboard they mean.",
  "",
  "Inputs (both optional):",
  "  - currency: 'USD' | 'EUR' | 'GBP' | 'HUF'. Initial display currency. User can switch live.",
  "  - tab: 'portfolio' | 'weekly' | 'risk'. Initial active tab. User can switch live.",
].join(" ");

export function registerDashboardApp(server: McpServer): void {
  registerAppTool(
    server,
    DASHBOARD_TOOL_NAME,
    {
      title: "Portfolio Dashboard",
      description: RENDER_DASHBOARD_DESCRIPTION,
      inputSchema: {
        currency: z.enum(["USD", "EUR", "GBP", "HUF"]).optional(),
        tab: z.enum(["portfolio", "weekly", "risk"]).optional(),
      },
      _meta: { ui: { resourceUri: DASHBOARD_RESOURCE_URI } },
    },
    async (args: { currency?: string; tab?: string }) => {
      // The tool handler returns a small textual ack. The actual UI is
      // rendered from the linked resource — the iframe makes its own follow-up
      // tool calls for the real data.
      const opts: string[] = [];
      if (args.currency) opts.push(`currency=${args.currency}`);
      if (args.tab) opts.push(`tab=${args.tab}`);
      const detail = opts.length > 0 ? ` (${opts.join(", ")})` : "";
      return {
        content: [
          {
            type: "text",
            text: `Dashboard rendered${detail}. The interactive UI is in the panel — switch tabs / change currency / refresh from there.`,
          },
        ],
      };
    },
  );

  registerAppResource(
    server,
    DASHBOARD_RESOURCE_URI,
    DASHBOARD_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await loadHtml();
      return {
        contents: [
          { uri: DASHBOARD_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html },
        ],
      };
    },
  );
}
