// Tool: setup_connector
//
// Creates a new account by writing READ-ONLY credentials to the OS keychain
// and registering the account in the AccountStore. Mirror of the CLI setup
// flow (`bin/headless-tracker.ts`), but callable from MCP — used by the
// Settings MCP App's "Add Account" form.
//
// Security note (also surfaced verbatim in the tool description and the
// Settings UI): credentials submitted via this tool transit Claude Desktop's
// process en route to the keychain. The LLM Claude does NOT receive the
// payload (postMessage from iframe → host → server → keychain), but the host
// process sees it. ALL three connectors use READ-ONLY credentials by design
// (Bybit "Read" only, no Withdraw; Etherscan is rate-limit token for public
// data; Polymarket proxy wallet is already public). Worst-case leak is a
// portfolio-read, never a fund movement. Users wanting a zero-trust path
// stay on the CLI (`bun run setup <connector>`).
//
// LLM behavior contract (in description): NEVER echo, log, or repeat the
// credential values back to the user. After successful setup, confirm only
// the account label and id, not the secrets.

import { z } from "zod";

import { defaultAccountStore, type AccountStore } from "../../accounts.ts";
import { BinanceConnector } from "../../connectors/binance.ts";
import { BybitConnector } from "../../connectors/bybit.ts";
import { MetaMaskConnector, SUPPORTED_CHAINS, type SupportedChainId } from "../../connectors/metamask.ts";
import { PolymarketConnector } from "../../connectors/polymarket.ts";
import { SolanaConnector } from "../../connectors/solana.ts";
import { defaultVault, type Vault } from "../../vault.ts";
import type { Account } from "../../types.ts";

export const SETUP_CONNECTOR_TOOL_NAME = "setup_connector";

export const SETUP_CONNECTOR_DESCRIPTION = [
  "Creates a new account by writing READ-ONLY credentials to the OS keychain.",
  "Use when the user asks: 'add a Bybit account', 'connect Binance', 'connect my MetaMask wallet', 'set up Polymarket', 'connect my Solana wallet', 'add new exchange'.",
  "",
  "BEHAVIOR CONTRACT FOR YOU (the LLM):",
  "- After this tool succeeds, confirm ONLY the account label and account_id back to the user.",
  "- NEVER echo, log, paraphrase, or repeat the credential values (apiKey, apiSecret, etherscanApiKey) in your response.",
  "- If the user pastes credentials inline in chat, suggest they use the Settings UI (render_settings tool) form instead — the form keeps secrets out of the conversation transcript.",
  "",
  "Credentials are validated against the upstream API before they're persisted; if validation fails, nothing is written.",
  "Storage: OS keychain (macOS Keychain / Linux Secret Service / Windows Credential Vault) via @napi-rs/keyring. Same path as the CLI setup flow.",
  "",
  "All five connectors use READ-ONLY credentials by design (Bybit 'Read' only, Binance 'Enable Reading' only, Etherscan is a public-data rate-limit token, Polymarket proxy wallet is already public, Solana addresses are public on-chain identifiers).",
  "",
  "Inputs (one of bybit / binance / metamask / polymarket / solana required):",
  "  - connector: 'bybit' | 'binance' | 'metamask' | 'polymarket' | 'solana'",
  "  - bybit: { apiKey, apiSecret, accountType: 'UNIFIED'|'CONTRACT'|'SPOT'|'FUND' }",
  "  - binance: { apiKey, apiSecret, includeFutures (optional bool, default false), recvWindow (optional ms) }",
  "  - metamask: { address, etherscanApiKey, chainIds (number[]), trackCommonTokens (bool), hasEtherscanPro (bool) }",
  "  - polymarket: { proxyWallet (0x...), sizeThreshold (default 0.01) }",
  "  - solana: { address (base58), rpcUrl (optional premium RPC), dustThresholdUsd (optional, default 0.5) }",
].join(" ");

const BYBIT_CREDS = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  accountType: z.enum(["UNIFIED", "CONTRACT", "SPOT", "FUND"]),
});

const BINANCE_CREDS = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  includeFutures: z.boolean().optional(),
  recvWindow: z.number().int().positive().optional(),
});

const METAMASK_CREDS = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  etherscanApiKey: z.string().min(1),
  chainIds: z.array(z.number().int()).min(1),
  trackCommonTokens: z.boolean().optional(),
  hasEtherscanPro: z.boolean().optional(),
});

const POLYMARKET_CREDS = z.object({
  proxyWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  sizeThreshold: z.number().nonnegative().optional(),
});

const SOLANA_CREDS = z.object({
  address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  rpcUrl: z.string().url().optional(),
  dustThresholdUsd: z.number().nonnegative().optional(),
});

export const SETUP_CONNECTOR_INPUT_SCHEMA = {
  connector: z.enum(["bybit", "binance", "metamask", "polymarket", "solana"]),
  bybit: BYBIT_CREDS.optional(),
  binance: BINANCE_CREDS.optional(),
  metamask: METAMASK_CREDS.optional(),
  polymarket: POLYMARKET_CREDS.optional(),
  solana: SOLANA_CREDS.optional(),
};

export interface SetupConnectorArgs {
  connector: "bybit" | "binance" | "metamask" | "polymarket" | "solana";
  bybit?: z.infer<typeof BYBIT_CREDS>;
  binance?: z.infer<typeof BINANCE_CREDS>;
  metamask?: z.infer<typeof METAMASK_CREDS>;
  polymarket?: z.infer<typeof POLYMARKET_CREDS>;
  solana?: z.infer<typeof SOLANA_CREDS>;
}

export interface SetupConnectorResult {
  ok: boolean;
  accountId?: string;
  label?: string;
  error?: string;
}

export interface SetupConnectorDeps {
  vault?: Vault;
  store?: AccountStore;
}

export async function executeSetupConnector(
  args: SetupConnectorArgs,
  deps: SetupConnectorDeps = {}
): Promise<SetupConnectorResult> {
  const vault = deps.vault ?? defaultVault();
  const store = deps.store ?? defaultAccountStore();

  if (args.connector === "bybit") {
    if (!args.bybit) return { ok: false, error: "bybit credentials required" };
    return setupBybit(args.bybit, vault, store);
  }
  if (args.connector === "binance") {
    if (!args.binance) return { ok: false, error: "binance credentials required" };
    return setupBinance(args.binance, vault, store);
  }
  if (args.connector === "metamask") {
    if (!args.metamask) return { ok: false, error: "metamask credentials required" };
    return setupMetaMask(args.metamask, vault, store);
  }
  if (args.connector === "polymarket") {
    if (!args.polymarket) return { ok: false, error: "polymarket credentials required" };
    return setupPolymarket(args.polymarket, vault, store);
  }
  if (args.connector === "solana") {
    if (!args.solana) return { ok: false, error: "solana credentials required" };
    return setupSolana(args.solana, vault, store);
  }
  return { ok: false, error: `unknown connector: ${args.connector}` };
}

async function setupBybit(
  creds: z.infer<typeof BYBIT_CREDS>,
  vault: Vault,
  store: AccountStore
): Promise<SetupConnectorResult> {
  const conn = new BybitConnector();
  const validation = await conn.validateCredentials(creds);
  if (!validation.ok) return { ok: false, error: `Bybit validation failed: ${validation.error.message}` };

  const setResult = await vault.set("bybit", creds.accountType, creds);
  if (!setResult.ok) return { ok: false, error: `Vault write failed: ${setResult.error.message}` };

  const accountId = `bybit:${creds.accountType}`;
  const label = `Bybit ${creds.accountType}`;
  const account: Account = {
    id: accountId,
    connectorId: "bybit",
    label,
    createdAt: Date.now(),
    metadata: { accountType: creds.accountType },
  };
  store.upsert(account);
  return { ok: true, accountId, label };
}

async function setupMetaMask(
  creds: z.infer<typeof METAMASK_CREDS>,
  vault: Vault,
  store: AccountStore
): Promise<SetupConnectorResult> {
  // Validate every chainId is supported.
  for (const cId of creds.chainIds) {
    if (!(cId in SUPPORTED_CHAINS)) {
      return { ok: false, error: `Unsupported chainId: ${cId}. Supported: ${Object.keys(SUPPORTED_CHAINS).join(", ")}` };
    }
  }
  const fullCreds = {
    address: creds.address,
    etherscanApiKey: creds.etherscanApiKey,
    chainIds: creds.chainIds,
    trackCommonTokens: creds.trackCommonTokens ?? true,
    hasEtherscanPro: creds.hasEtherscanPro ?? false,
  };
  const conn = new MetaMaskConnector();
  const validation = await conn.validateCredentials(fullCreds);
  if (!validation.ok) return { ok: false, error: `MetaMask validation failed: ${validation.error.message}` };

  const accountIdentifier = creds.address.toLowerCase();
  const setResult = await vault.set("metamask", accountIdentifier, fullCreds);
  if (!setResult.ok) return { ok: false, error: `Vault write failed: ${setResult.error.message}` };

  const accountId = `metamask:${accountIdentifier}`;
  const labelShort = `${creds.address.slice(0, 6)}...${creds.address.slice(-4)}`;
  const chainNames = creds.chainIds
    .map((id) => SUPPORTED_CHAINS[id as SupportedChainId]?.name ?? `chain ${id}`)
    .join(", ");
  const label = `MetaMask ${labelShort} (${chainNames})`;
  const account: Account = {
    id: accountId,
    connectorId: "metamask",
    label,
    createdAt: Date.now(),
    metadata: {
      address: creds.address,
      chainIds: creds.chainIds,
      trackCommonTokens: fullCreds.trackCommonTokens,
      hasEtherscanPro: fullCreds.hasEtherscanPro,
    },
  };
  store.upsert(account);
  return { ok: true, accountId, label };
}

async function setupBinance(
  creds: z.infer<typeof BINANCE_CREDS>,
  vault: Vault,
  store: AccountStore
): Promise<SetupConnectorResult> {
  const fullCreds: Record<string, unknown> = {
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    includeFutures: creds.includeFutures ?? false,
  };
  if (typeof creds.recvWindow === "number") fullCreds.recvWindow = creds.recvWindow;

  const conn = new BinanceConnector();
  const validation = await conn.validateCredentials(fullCreds);
  if (!validation.ok) return { ok: false, error: `Binance validation failed: ${validation.error.message}` };

  // Binance has a single account per API-key pair (unlike Bybit's UNIFIED/SPOT/etc.).
  // Use a fingerprint of the apiKey (first 6 chars) as the account identifier so
  // multiple Binance keys per user can coexist as separate Account rows.
  const fingerprint = creds.apiKey.slice(0, 6);
  const accountIdentifier = `key-${fingerprint}`;
  const setResult = await vault.set("binance", accountIdentifier, fullCreds);
  if (!setResult.ok) return { ok: false, error: `Vault write failed: ${setResult.error.message}` };

  const accountId = `binance:${accountIdentifier}`;
  const label = creds.includeFutures
    ? `Binance Spot+Futures (${fingerprint}…)`
    : `Binance Spot (${fingerprint}…)`;
  const account: Account = {
    id: accountId,
    connectorId: "binance",
    label,
    createdAt: Date.now(),
    metadata: {
      keyFingerprint: fingerprint,
      includeFutures: fullCreds.includeFutures,
    },
  };
  store.upsert(account);
  return { ok: true, accountId, label };
}

async function setupSolana(
  creds: z.infer<typeof SOLANA_CREDS>,
  vault: Vault,
  store: AccountStore
): Promise<SetupConnectorResult> {
  const fullCreds: Record<string, unknown> = { address: creds.address };
  if (creds.rpcUrl) fullCreds.rpcUrl = creds.rpcUrl;
  if (typeof creds.dustThresholdUsd === "number") fullCreds.dustThresholdUsd = creds.dustThresholdUsd;
  const conn = new SolanaConnector();
  const validation = await conn.validateCredentials(fullCreds);
  if (!validation.ok) return { ok: false, error: `Solana validation failed: ${validation.error.message}` };

  // Solana addresses are case-sensitive base58 — do NOT lowercase like EVM.
  const accountIdentifier = creds.address;
  const setResult = await vault.set("solana", accountIdentifier, fullCreds);
  if (!setResult.ok) return { ok: false, error: `Vault write failed: ${setResult.error.message}` };

  const accountId = `solana:${accountIdentifier}`;
  const labelShort = `${creds.address.slice(0, 4)}…${creds.address.slice(-4)}`;
  const label = `Solana ${labelShort}`;
  const account: Account = {
    id: accountId,
    connectorId: "solana",
    label,
    createdAt: Date.now(),
    metadata: {
      address: creds.address,
      rpcUrl: creds.rpcUrl,
      dustThresholdUsd: creds.dustThresholdUsd,
    },
  };
  store.upsert(account);
  return { ok: true, accountId, label };
}

async function setupPolymarket(
  creds: z.infer<typeof POLYMARKET_CREDS>,
  vault: Vault,
  store: AccountStore
): Promise<SetupConnectorResult> {
  const fullCreds = { proxyWallet: creds.proxyWallet, sizeThreshold: creds.sizeThreshold ?? 0.01 };
  const conn = new PolymarketConnector();
  const validation = await conn.validateCredentials(fullCreds);
  if (!validation.ok) return { ok: false, error: `Polymarket validation failed: ${validation.error.message}` };

  const accountIdentifier = creds.proxyWallet.toLowerCase();
  const setResult = await vault.set("polymarket", accountIdentifier, fullCreds);
  if (!setResult.ok) return { ok: false, error: `Vault write failed: ${setResult.error.message}` };

  const accountId = `polymarket:${accountIdentifier}`;
  const labelShort = `${creds.proxyWallet.slice(0, 6)}...${creds.proxyWallet.slice(-4)}`;
  const label = `Polymarket ${labelShort}`;
  const account: Account = {
    id: accountId,
    connectorId: "polymarket",
    label,
    createdAt: Date.now(),
    metadata: { proxyWallet: creds.proxyWallet, sizeThreshold: fullCreds.sizeThreshold },
  };
  store.upsert(account);
  return { ok: true, accountId, label };
}
