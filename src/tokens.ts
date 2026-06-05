// Custom ERC-20 token list management. Tokens are stored in
// `Account.metadata.customTokens` as a per-chain map. The orchestrator merges
// them into the connector's credentials at fetch time so MetaMaskConnector
// sees them via its existing `creds.customTokens` interface (no schema change).
//
// Tokens are public on-chain identifiers (contract address + symbol +
// decimals). They are NOT secrets, so they don't go in the keyring vault —
// AccountStore's SQLite already has WAL retry and is the right home.

import type { AccountStore } from "./accounts.ts";
import { SUPPORTED_CHAINS, type SupportedChainId } from "./connectors/metamask-chains.ts";
import type { Account, Result } from "./types.ts";
import { err, ok } from "./types.ts";

export interface CustomToken {
  contract: string;
  symbol: string;
  decimals: number;
}

// Keyed by chainId-as-string because JSON object keys are always strings.
// At read time we coerce back to number when needed.
export type CustomTokensMap = Record<string, CustomToken[]>;

const CONTRACT_RX = /^0x[a-fA-F0-9]{40}$/;

export function readCustomTokens(account: Account): CustomTokensMap {
  const raw = account.metadata?.customTokens;
  if (!raw || typeof raw !== "object") return {};
  return raw as CustomTokensMap;
}

function writeCustomTokens(store: AccountStore, account: Account, tokens: CustomTokensMap): void {
  store.upsert({
    ...account,
    metadata: { ...(account.metadata ?? {}), customTokens: tokens },
  });
}

export function validateToken(
  chainId: number,
  contract: string,
  symbol: string,
  decimals: number
): Result<void> {
  if (!Number.isFinite(chainId) || !(chainId in SUPPORTED_CHAINS)) {
    const supported = Object.keys(SUPPORTED_CHAINS).map(Number).sort((a, b) => a - b).join(", ");
    return err("schema_mismatch", `Invalid chain-id: ${chainId}. Supported: ${supported}`);
  }
  if (!CONTRACT_RX.test(contract)) {
    return err("schema_mismatch", `Invalid contract address: ${contract}. Expected 0x + 40 hex chars.`);
  }
  if (!symbol || symbol.length === 0 || symbol.length > 20) {
    return err("schema_mismatch", `Invalid symbol: '${symbol}'. Must be 1-20 chars.`);
  }
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
    return err("schema_mismatch", `Invalid decimals: ${decimals}. Must be 0-36.`);
  }
  return ok(undefined);
}

export interface AddTokenResult {
  action: "added" | "updated";
}

export function addCustomToken(
  store: AccountStore,
  accountId: string,
  chainId: number,
  token: CustomToken
): Result<AddTokenResult> {
  const validation = validateToken(chainId, token.contract, token.symbol, token.decimals);
  if (!validation.ok) return validation;

  const account = store.get(accountId);
  if (!account) {
    return err("not_found", `Account not found: ${accountId}`);
  }
  if (account.connectorId !== "metamask") {
    return err("schema_mismatch", `Custom tokens are only supported for MetaMask accounts. ${accountId} uses '${account.connectorId}'.`);
  }

  const tokens = readCustomTokens(account);
  const chainKey = String(chainId);
  const list = tokens[chainKey] ?? [];
  const lc = token.contract.toLowerCase();
  const existingIdx = list.findIndex((t) => t.contract.toLowerCase() === lc);
  let action: "added" | "updated";
  if (existingIdx >= 0) {
    list[existingIdx] = token;
    action = "updated";
  } else {
    list.push(token);
    action = "added";
  }
  tokens[chainKey] = list;
  writeCustomTokens(store, account, tokens);
  return ok({ action });
}

export interface ListedToken {
  accountId: string;
  chainId: SupportedChainId;
  chainName: string;
  token: CustomToken;
}

export function listCustomTokens(store: AccountStore, accountId?: string): ListedToken[] {
  const accounts = accountId ? [store.get(accountId)].filter((a): a is Account => a !== undefined) : store.list();
  const result: ListedToken[] = [];
  for (const account of accounts) {
    const tokens = readCustomTokens(account);
    for (const chainKey of Object.keys(tokens).sort((a, b) => Number(a) - Number(b))) {
      const cId = Number(chainKey) as SupportedChainId;
      const info = SUPPORTED_CHAINS[cId];
      const chainName = info ? info.name : `chain ${chainKey}`;
      for (const token of tokens[chainKey]!) {
        result.push({ accountId: account.id, chainId: cId, chainName, token });
      }
    }
  }
  return result;
}

export function removeCustomToken(
  store: AccountStore,
  accountId: string,
  chainId: number,
  contract: string
): Result<void> {
  if (!Number.isFinite(chainId)) {
    return err("schema_mismatch", `Invalid chain-id: ${chainId}`);
  }

  const account = store.get(accountId);
  if (!account) {
    return err("not_found", `Account not found: ${accountId}`);
  }

  const tokens = readCustomTokens(account);
  const chainKey = String(chainId);
  const list = tokens[chainKey] ?? [];
  const lc = contract.toLowerCase();
  const filtered = list.filter((t) => t.contract.toLowerCase() !== lc);
  if (filtered.length === list.length) {
    return err("not_found", `No matching token for chain ${chainId} contract ${contract} on ${accountId}`);
  }
  if (filtered.length === 0) {
    delete tokens[chainKey];
  } else {
    tokens[chainKey] = filtered;
  }
  writeCustomTokens(store, account, tokens);
  return ok(undefined);
}
