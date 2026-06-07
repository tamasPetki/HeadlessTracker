// Server-side wiring for the settings MCP App.
//
// Registers ONE tool (`render_settings`) with `_meta.ui.resourceUri` pointing
// at the bundled HTML resource. When the host calls the tool, the iframe
// renders with four tabs: Accounts / Add Account / Wallets / Custom Tokens.
//
// The bundled HTML is produced by `scripts/build-mcp-apps.ts` and lives at
// `dist/mcp-apps/settings.html`. Loaded lazily on first read; cached for the
// lifetime of the process.

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { packageRoot } from "../../../package-root.ts";

export const SETTINGS_TOOL_NAME = "render_settings";
export const SETTINGS_RESOURCE_URI = "ui://headless-tracker/settings";

const BUNDLED_HTML_PATH = join(packageRoot(), "dist", "mcp-apps", "settings.html");

let cachedHtml: string | null = null;
async function loadHtml(): Promise<string> {
  if (cachedHtml !== null) return cachedHtml;
  cachedHtml = await readFile(BUNDLED_HTML_PATH, "utf-8");
  return cachedHtml;
}

export const RENDER_SETTINGS_DESCRIPTION = [
  "Render the PORTFOLIO TRACKER Settings panel as an MCP App (live UI panel) — the GUI alternative to the CLI setup flow for headless-tracker (Bybit / MetaMask / Polymarket connections).",
  "Use when the user asks: 'open my portfolio settings', 'add a Bybit account', 'connect my MetaMask wallet to the tracker',",
  "'show my tracker accounts', 'remove this exchange connection', 'add a custom ERC-20 token', 'add another wallet address to track'.",
  "Four tabs:",
  "  - Accounts: read-only list of configured tracker accounts with Remove buttons (one-way confirm dialog).",
  "  - Add Account: forms for Bybit / MetaMask / Polymarket with explicit security disclosure.",
  "  - Wallets: add an additional wallet address to an existing MetaMask tracker account.",
  "  - Custom Tokens: list + add/remove ERC-20 tokens per chain.",
  "",
  "DO NOT call this tool when the user means: app settings (Claude Desktop / VS Code / browser), system preferences, OS settings, account settings on websites, profile settings, notification settings, theme/appearance, or any settings UI from a different MCP server. It's specifically the headless-tracker portfolio-tracker setup panel. If the request is ambiguous (just 'open settings'), ask which settings.",
  "",
  "BEHAVIOR CONTRACT FOR YOU (the LLM):",
  "If the user pastes credentials directly in chat, prefer pointing them at this Settings UI rather than calling setup_connector with the inline values — the form keeps secrets out of the conversation transcript.",
  "After the user uses the form, the tool result is cosmetic confirmation; do NOT echo or paraphrase any credential values that may appear in the conversation.",
  "",
  "Inputs (optional):",
  "  - tab: 'accounts' | 'add-account' | 'wallets' | 'tokens' — initial active tab.",
].join(" ");

export function registerSettingsApp(server: McpServer): void {
  registerAppTool(
    server,
    SETTINGS_TOOL_NAME,
    {
      title: "Settings",
      description: RENDER_SETTINGS_DESCRIPTION,
      inputSchema: {
        tab: z
          .enum(["accounts", "add-account", "wallets", "tokens"])
          .optional()
          .describe("Initial active tab (default 'accounts'). The user can switch tabs live in the panel."),
      },
      _meta: { ui: { resourceUri: SETTINGS_RESOURCE_URI } },
    },
    async (args: { tab?: string }) => {
      const detail = args.tab ? ` (tab=${args.tab})` : "";
      return {
        content: [
          {
            type: "text",
            text: `Settings panel rendered${detail}. Use the tabs to manage accounts, wallets, and custom tokens.`,
          },
        ],
      };
    },
  );

  registerAppResource(
    server,
    SETTINGS_RESOURCE_URI,
    SETTINGS_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await loadHtml();
      return {
        contents: [
          { uri: SETTINGS_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html },
        ],
      };
    },
  );
}
