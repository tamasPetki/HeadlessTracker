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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SETTINGS_TOOL_NAME = "render_settings";
export const SETTINGS_RESOURCE_URI = "ui://headless-tracker/settings";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_HTML_PATH = join(HERE, "..", "..", "..", "..", "dist", "mcp-apps", "settings.html");

let cachedHtml: string | null = null;
async function loadHtml(): Promise<string> {
  if (cachedHtml !== null) return cachedHtml;
  cachedHtml = await readFile(BUNDLED_HTML_PATH, "utf-8");
  return cachedHtml;
}

export const RENDER_SETTINGS_DESCRIPTION = [
  "Render the Settings panel as an MCP App (live UI panel) — the GUI alternative to the CLI setup flow.",
  "Use when the user asks: 'set up an account', 'add Bybit', 'add MetaMask wallet', 'connect Polymarket',",
  "'show settings', 'list my accounts', 'remove this connection', 'add a custom token', 'add another wallet address'.",
  "Four tabs:",
  "  - Accounts: read-only list with Remove buttons (one-way confirm dialog).",
  "  - Add Account: forms for Bybit / MetaMask / Polymarket with explicit security disclosure.",
  "  - Wallets: add an additional wallet address to an existing MetaMask account.",
  "  - Custom Tokens: list + add/remove ERC-20 tokens per chain.",
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
        tab: z.enum(["accounts", "add-account", "wallets", "tokens"]).optional(),
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
