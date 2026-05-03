// Tools: add_wallet_address, remove_account
//
// Account admin operations called from the Settings MCP App.
//
// add_wallet_address: appends a wallet address to an existing MetaMask account's
// `addresses[]` list. The new address shares the same Etherscan key + chain
// selection as the parent account. Public on-chain identifier — no secrets.
//
// remove_account: deletes both the AccountStore row AND the keychain entry.
// One-way; user must explicitly confirm in the UI before this fires.

import { z } from "zod";

import { defaultAccountStore, type AccountStore } from "../../accounts.ts";
import { defaultVault, type Vault } from "../../vault.ts";
import type { ConnectorCredentials } from "../../connectors/types.ts";

// ============================================================================
// add_wallet_address
// ============================================================================

export const ADD_WALLET_ADDRESS_TOOL_NAME = "add_wallet_address";

export const ADD_WALLET_ADDRESS_DESCRIPTION = [
  "Adds an additional wallet address to an existing MetaMask account.",
  "Use when the user asks: 'add another wallet', 'track a second address', 'add MetaMask address'.",
  "The new address shares the same Etherscan API key + chain selection as the parent account.",
  "Wallet addresses are public on-chain identifiers — NO new secrets are stored. Just updates the keychain entry's `addresses[]` field.",
  "Inputs:",
  "  - account_id: id of the existing MetaMask account (e.g. 'metamask:0xabc...')",
  "  - address: 0x-prefixed 40-hex wallet address to add",
].join(" ");

export const ADD_WALLET_ADDRESS_INPUT_SCHEMA = {
  account_id: z.string(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
};

export interface AddWalletAddressArgs {
  account_id: string;
  address: string;
}

export interface AddWalletAddressResult {
  ok: boolean;
  accountId?: string;
  addresses?: string[];        // full list after the add
  error?: string;
}

export interface AccountAdminDeps {
  vault?: Vault;
  store?: AccountStore;
}

export async function executeAddWalletAddress(
  args: AddWalletAddressArgs,
  deps: AccountAdminDeps = {}
): Promise<AddWalletAddressResult> {
  const vault = deps.vault ?? defaultVault();
  const store = deps.store ?? defaultAccountStore();

  const account = store.get(args.account_id);
  if (!account) return { ok: false, error: `Account not found: ${args.account_id}` };
  if (account.connectorId !== "metamask") {
    return { ok: false, error: `Only MetaMask accounts support multi-wallet. ${args.account_id} is '${account.connectorId}'.` };
  }

  // Pull existing creds, merge the new address, write back.
  const accountIdentifier = args.account_id.slice("metamask:".length);
  const credsResult = await vault.get("metamask", accountIdentifier);
  if (!credsResult.ok) return { ok: false, error: `Could not load credentials: ${credsResult.error.message}` };

  const creds = credsResult.value as ConnectorCredentials & { address?: string; addresses?: string[] };
  const existing: string[] = Array.isArray(creds.addresses) ? [...creds.addresses] : (creds.address ? [creds.address] : []);
  const lcNew = args.address.toLowerCase();
  if (existing.some((a) => a.toLowerCase() === lcNew)) {
    return { ok: false, error: `Address already tracked under ${args.account_id}: ${args.address}` };
  }
  existing.push(args.address);

  const updatedCreds = { ...creds, addresses: existing };
  // Drop the legacy single `address` field once we move to the multi-form.
  delete (updatedCreds as Record<string, unknown>).address;

  const setResult = await vault.set("metamask", accountIdentifier, updatedCreds);
  if (!setResult.ok) return { ok: false, error: `Vault write failed: ${setResult.error.message}` };

  return { ok: true, accountId: args.account_id, addresses: existing };
}

// ============================================================================
// remove_account
// ============================================================================

export const REMOVE_ACCOUNT_TOOL_NAME = "remove_account";

export const REMOVE_ACCOUNT_DESCRIPTION = [
  "Deletes an account from the AccountStore AND its credentials from the OS keychain.",
  "ONE-WAY operation. The Settings UI requires explicit user confirmation before calling this.",
  "Use when the user asks: 'remove the Bybit account', 'disconnect Polymarket', 'forget that wallet'.",
  "Inputs:",
  "  - account_id: id of the account to remove (e.g. 'bybit:UNIFIED', 'metamask:0xabc...').",
  "Returns: ok, removedAccountId; or error if the account was not found.",
].join(" ");

export const REMOVE_ACCOUNT_INPUT_SCHEMA = {
  account_id: z.string(),
};

export interface RemoveAccountArgs {
  account_id: string;
}

export interface RemoveAccountResult {
  ok: boolean;
  removedAccountId?: string;
  error?: string;
}

export async function executeRemoveAccount(
  args: RemoveAccountArgs,
  deps: AccountAdminDeps = {}
): Promise<RemoveAccountResult> {
  const vault = deps.vault ?? defaultVault();
  const store = deps.store ?? defaultAccountStore();

  const account = store.get(args.account_id);
  if (!account) return { ok: false, error: `Account not found: ${args.account_id}` };

  // Account id format: "{connectorId}:{accountIdentifier}".
  const colonIdx = args.account_id.indexOf(":");
  if (colonIdx < 0) return { ok: false, error: `Malformed account_id: ${args.account_id}` };
  const accountIdentifier = args.account_id.slice(colonIdx + 1);

  // Best-effort keychain delete. AccountStore removal is the source of truth —
  // even if keychain removal fails (e.g. entry was already gone), drop the
  // store row so the dashboard stops showing the orphaned account.
  await vault.remove(account.connectorId, accountIdentifier);
  const removed = store.remove(args.account_id);
  if (!removed) return { ok: false, error: `AccountStore.remove returned false for ${args.account_id}` };

  return { ok: true, removedAccountId: args.account_id };
}
