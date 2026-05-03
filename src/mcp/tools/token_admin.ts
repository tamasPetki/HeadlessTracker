// Tools: add_custom_token, remove_custom_token, list_custom_tokens
//
// MCP wrappers around the existing `src/tokens.ts` module. Custom ERC-20
// tokens are public on-chain identifiers (contract address + symbol +
// decimals) — NO secrets, NO keychain. They live in `Account.metadata.customTokens`
// in the AccountStore SQLite.
//
// Used by the Settings MCP App's Tokens tab + the LLM when the user mentions
// a project token by name.

import { z } from "zod";

import { defaultAccountStore, type AccountStore } from "../../accounts.ts";
import { addCustomToken, listCustomTokens, removeCustomToken } from "../../tokens.ts";

// ============================================================================
// add_custom_token
// ============================================================================

export const ADD_CUSTOM_TOKEN_TOOL_NAME = "add_custom_token";

export const ADD_CUSTOM_TOKEN_DESCRIPTION = [
  "Adds a project-specific ERC-20 token to a MetaMask account's tracked-tokens list.",
  "The bundled common tokens (USDC, USDT, WETH, WBTC, LINK, DAI) are tracked by default; this is for additional tokens like project / governance tokens.",
  "Use when the user asks: 'track ARB token', 'add UNI to my wallet', 'monitor a custom ERC-20'.",
  "Token data is PUBLIC on-chain (contract + symbol + decimals) — NO secrets, NO keychain involved.",
  "Inputs:",
  "  - account_id: target MetaMask account (e.g. 'metamask:0xabc...')",
  "  - chain_id: numeric (1=Ethereum, 137=Polygon, 56=BSC, 8453=Base, 42161=Arbitrum, 10=Optimism)",
  "  - contract: 0x-prefixed contract address (40 hex)",
  "  - symbol: 1-20 chars",
  "  - decimals: 0-36 integer",
].join(" ");

export const ADD_CUSTOM_TOKEN_INPUT_SCHEMA = {
  account_id: z.string(),
  chain_id: z.number().int().positive(),
  contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  symbol: z.string().min(1).max(20),
  decimals: z.number().int().min(0).max(36),
};

export interface AddCustomTokenArgs {
  account_id: string;
  chain_id: number;
  contract: string;
  symbol: string;
  decimals: number;
}

export interface AddCustomTokenResult {
  ok: boolean;
  action?: "added" | "updated";
  error?: string;
}

export function executeAddCustomToken(
  args: AddCustomTokenArgs,
  store: AccountStore = defaultAccountStore()
): AddCustomTokenResult {
  const result = addCustomToken(store, args.account_id, args.chain_id, {
    contract: args.contract,
    symbol: args.symbol,
    decimals: args.decimals,
  });
  if (!result.ok) return { ok: false, error: result.error.message };
  return { ok: true, action: result.value.action };
}

// ============================================================================
// remove_custom_token
// ============================================================================

export const REMOVE_CUSTOM_TOKEN_TOOL_NAME = "remove_custom_token";

export const REMOVE_CUSTOM_TOKEN_DESCRIPTION = [
  "Removes a custom ERC-20 token from a MetaMask account's tracked-tokens list. Public on-chain data, no keychain involvement.",
  "Use when the user asks: 'stop tracking ARB', 'remove that token from MetaMask', 'untrack a project token'.",
  "Inputs:",
  "  - account_id: target MetaMask account (e.g. 'metamask:0xabc...')",
  "  - chain_id: numeric (1=Ethereum, 137=Polygon, 56=BSC, 8453=Base, 42161=Arbitrum, 10=Optimism)",
  "  - contract: 0x-prefixed contract address (40 hex)",
  "Returns ok or a not_found error if the token wasn't tracked under that account+chain.",
].join(" ");

export const REMOVE_CUSTOM_TOKEN_INPUT_SCHEMA = {
  account_id: z.string(),
  chain_id: z.number().int().positive(),
  contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
};

export interface RemoveCustomTokenArgs {
  account_id: string;
  chain_id: number;
  contract: string;
}

export interface RemoveCustomTokenResult {
  ok: boolean;
  error?: string;
}

export function executeRemoveCustomToken(
  args: RemoveCustomTokenArgs,
  store: AccountStore = defaultAccountStore()
): RemoveCustomTokenResult {
  const result = removeCustomToken(store, args.account_id, args.chain_id, args.contract);
  if (!result.ok) return { ok: false, error: result.error.message };
  return { ok: true };
}

// ============================================================================
// list_custom_tokens
// ============================================================================

export const LIST_CUSTOM_TOKENS_TOOL_NAME = "list_custom_tokens";

export const LIST_CUSTOM_TOKENS_DESCRIPTION = [
  "Lists custom ERC-20 tokens tracked by MetaMask accounts. Public data; no secrets involved.",
  "Use when the user asks: 'which custom tokens am I tracking', 'show my project tokens'.",
  "Inputs (optional): account_id to filter to one account.",
].join(" ");

export const LIST_CUSTOM_TOKENS_INPUT_SCHEMA = {
  account_id: z.string().optional(),
};

export interface ListCustomTokensArgs {
  account_id?: string;
}

export interface ListCustomTokensResult {
  tokens: Array<{
    accountId: string;
    chainId: number;
    chainName: string;
    contract: string;
    symbol: string;
    decimals: number;
  }>;
  meta: { total: number };
}

export function executeListCustomTokens(
  args: ListCustomTokensArgs,
  store: AccountStore = defaultAccountStore()
): ListCustomTokensResult {
  const rows = listCustomTokens(store, args.account_id);
  return {
    tokens: rows.map((r) => ({
      accountId: r.accountId,
      chainId: r.chainId,
      chainName: r.chainName,
      contract: r.token.contract,
      symbol: r.token.symbol,
      decimals: r.token.decimals,
    })),
    meta: { total: rows.length },
  };
}
