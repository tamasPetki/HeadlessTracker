// Tool: list_accounts
// Read-only listing of configured accounts. Surfaces what was set up via the
// CLI / Settings UI. NEVER returns credentials — those live in the OS keychain
// and aren't accessed from this path.
//
// Used by the Settings MCP App's Accounts tab (iframe makes a tool call), and
// available to the LLM for "what's configured" questions.

import { z } from "zod";

import { defaultAccountStore, type AccountStore } from "../../accounts.ts";

export const LIST_ACCOUNTS_TOOL_NAME = "list_accounts";

export const LIST_ACCOUNTS_DESCRIPTION = [
  "Lists configured PORTFOLIO TRACKER accounts (Bybit exchange / Binance exchange / MetaMask wallets / Polymarket / Solana wallets / Hyperliquid) without exposing credentials.",
  "Use when the user asks: 'what tracker accounts are configured', 'show my portfolio accounts', 'list my exchange connections', 'which crypto exchanges are linked', 'which wallets am I tracking', 'what addresses am I tracking'.",
  "Returns: id, connectorId (bybit | binance | metamask | polymarket | solana | hyperliquid), label, createdAt, and connector-specific public metadata (e.g. chainIds and addresses for MetaMask, accountType for Bybit, address for Solana/Hyperliquid, key fingerprint for Binance).",
  "Credentials are NEVER returned — they stay in the OS keychain.",
  "DO NOT call this tool when the user means: email accounts, social media accounts, GitHub accounts, cloud accounts, OS user accounts, or any 'accounts' from a different domain or MCP server. It's specifically the headless-tracker exchange/wallet connections.",
].join(" ");

export const LIST_ACCOUNTS_INPUT_SCHEMA = {
  connector: z
    .enum(["bybit", "binance", "metamask", "polymarket", "solana", "hyperliquid"])
    .optional()
    .describe("Filter to accounts of one connector. Omit to list every configured account."),
};

export interface ListAccountsArgs {
  connector?: "bybit" | "binance" | "metamask" | "polymarket" | "solana" | "hyperliquid";
}

export interface ListedAccount {
  id: string;
  connectorId: string;
  label: string;
  createdAt: string;            // ISO 8601
  metadata: Record<string, unknown>;
}

export interface ListAccountsResult {
  accounts: ListedAccount[];
  meta: { total: number; asOf: string };
}

export function executeListAccounts(
  args: ListAccountsArgs,
  store: AccountStore = defaultAccountStore()
): ListAccountsResult {
  const accounts = args.connector ? store.listByConnector(args.connector) : store.list();
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      connectorId: a.connectorId,
      label: a.label,
      createdAt: new Date(a.createdAt).toISOString(),
      metadata: a.metadata ?? {},
    })),
    meta: {
      total: accounts.length,
      asOf: new Date().toISOString(),
    },
  };
}
