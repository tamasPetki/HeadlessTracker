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
import { HyperliquidConnector } from "../../connectors/hyperliquid.ts";
import { MetaMaskConnector } from "../../connectors/metamask.ts";
import { SUPPORTED_CHAINS, type SupportedChainId } from "../../connectors/metamask-chains.ts";
import { PolymarketConnector } from "../../connectors/polymarket.ts";
import { SolanaConnector } from "../../connectors/solana.ts";
import { defaultVault, type Vault } from "../../vault.ts";
import { finalizeAccountSetup } from "../../setup-finalize.ts";
import type { Account } from "../../types.ts";

export const SETUP_CONNECTOR_TOOL_NAME = "setup_connector";

export const SETUP_CONNECTOR_DESCRIPTION = [
  "Creates a new account by writing READ-ONLY credentials to the OS keychain.",
  "Use when the user asks: 'add a Bybit account', 'connect Binance', 'connect my MetaMask wallet', 'set up Polymarket', 'connect my Solana wallet', 'track my Hyperliquid', 'add my Hyperliquid wallet', 'add new exchange'.",
  "",
  "BEHAVIOR CONTRACT FOR YOU (the LLM):",
  "- After this tool succeeds, confirm ONLY the account label and account_id back to the user.",
  "- NEVER echo, log, paraphrase, or repeat the credential values (apiKey, apiSecret, etherscanApiKey) in your response.",
  "- If the user pastes credentials inline in chat, suggest they use the Settings UI (render_settings tool) form instead — the form keeps secrets out of the conversation transcript.",
  "",
  "Credentials are validated against the upstream API before they're persisted; if validation fails, nothing is written.",
  "Storage: OS keychain (macOS Keychain / Linux Secret Service / Windows Credential Vault) via @napi-rs/keyring. Same path as the CLI setup flow.",
  "",
  "All six connectors use READ-ONLY credentials by design (Bybit 'Read' only, Binance 'Enable Reading' only, Etherscan is a public-data rate-limit token, Polymarket proxy wallet is already public, Solana/Hyperliquid addresses are public on-chain identifiers — Hyperliquid needs no key or signature at all).",
  "",
  "Inputs (one of bybit / binance / metamask / polymarket / solana / hyperliquid required):",
  "  - connector: 'bybit' | 'binance' | 'metamask' | 'polymarket' | 'solana' | 'hyperliquid'",
  "  - bybit: { apiKey, apiSecret, accountType: 'UNIFIED'|'CONTRACT'|'SPOT'|'FUND' (primary, also the account ID), accountTypes?: array of additional types to fan out across (e.g. ['FUND'] alongside UNIFIED so funding-wallet balances are tracked too) }",
  "  - binance: { apiKey, apiSecret, includeFutures (optional bool, default false), recvWindow (optional ms) }",
  "  - metamask: { address, etherscanApiKey, chainIds (number[]), trackCommonTokens (bool), hasEtherscanPro (bool) }",
  "  - polymarket: { proxyWallet (0x...), sizeThreshold (default 0.01) }",
  "  - solana: { address (base58), rpcUrl (optional premium RPC), dustThresholdUsd (optional, default 0.5) }",
  "  - hyperliquid: { address (0x... EVM address you trade from), dustThresholdUsd (optional, default 0.5). No API key — public address only. Tracks perp account equity + open positions + spot balances. }",
].join(" ");

const BYBIT_CREDS = z.object({
  apiKey: z.string().min(1).describe("Bybit API key with READ permission only."),
  apiSecret: z.string().min(1).describe("Bybit API secret paired with the key."),
  // Primary type determines the account ID (`bybit:UNIFIED`, etc.) and is
  // also the type validate-credentials probes. UNIFIED is the v0.13+ default.
  accountType: z
    .enum(["UNIFIED", "CONTRACT", "SPOT", "FUND"])
    .describe("Primary account type; also becomes the account id (e.g. bybit:UNIFIED). UNIFIED is the modern default."),
  // Optional: extra types to fan out across in fetchHoldings/fetchTransactions.
  // Common pattern: ["FUND"] alongside UNIFIED so funding-wallet balances
  // (USDT parking, etc.) aren't invisible. Same API key covers all types
  // the user has enabled.
  accountTypes: z
    .array(z.enum(["UNIFIED", "CONTRACT", "SPOT", "FUND"]))
    .optional()
    .describe("Optional extra account types to also fetch (e.g. ['FUND'] so funding-wallet balances aren't missed). Same key covers all enabled types."),
});

const BINANCE_CREDS = z.object({
  apiKey: z.string().min(1).describe("Binance API key with 'Enable Reading' only."),
  apiSecret: z.string().min(1).describe("Binance API secret paired with the key."),
  includeFutures: z.boolean().optional().describe("Default false. Set true to also pull USDM futures balances."),
  recvWindow: z.number().int().positive().optional().describe("Optional Binance recvWindow in ms (request validity window)."),
});

const METAMASK_CREDS = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe("Public EVM wallet address (0x + 40 hex). Not a secret."),
  etherscanApiKey: z.string().min(1).describe("Etherscan API key — a public-data rate-limit token, used across all EVM chains via Etherscan V2."),
  chainIds: z.array(z.number().int()).min(1).describe("EVM chain ids to track (e.g. [1,137,8453] for Ethereum/Polygon/Base)."),
  trackCommonTokens: z.boolean().optional().describe("Default true: also track the bundled common ERC-20s (USDC/USDT/WETH/WBTC/LINK/DAI)."),
  hasEtherscanPro: z.boolean().optional().describe("Default false. Set true if the Etherscan key is a Pro plan (raises rate limits / unlocks some chains)."),
});

const POLYMARKET_CREDS = z.object({
  proxyWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe("Public Polymarket proxy wallet address (0x + 40 hex). Not a secret."),
  sizeThreshold: z.number().nonnegative().optional().describe("Hide positions with token count below this (default 0.01). For $0 dust by value, see dustThresholdUsd in connector config."),
});

const SOLANA_CREDS = z.object({
  address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).describe("Public Solana wallet address (base58, 32-44 chars). Not a secret."),
  rpcUrl: z.string().url().optional().describe("Optional premium RPC URL. Omit to use the public mainnet-beta RPC (fine for single wallets)."),
  dustThresholdUsd: z.number().nonnegative().optional().describe("Hide token positions worth less than this USD value (default 0.5)."),
});

const HYPERLIQUID_CREDS = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe("Public EVM address you trade from on Hyperliquid (0x + 40 hex). Not a secret — no API key or signature needed."),
  dustThresholdUsd: z.number().nonnegative().optional().describe("Hide spot token positions worth less than this USD value (default 0.5). Perp account equity always shows."),
});

export const SETUP_CONNECTOR_INPUT_SCHEMA = {
  connector: z
    .enum(["bybit", "binance", "metamask", "polymarket", "solana", "hyperliquid"])
    .describe(
      "Which connector to set up. Provide the matching credential object below (e.g. connector='bybit' requires the 'bybit' object). All credentials are READ-ONLY by design."
    ),
  bybit: BYBIT_CREDS.optional().describe(
      "Bybit credentials (required when connector='bybit'). Read-only API key/secret + account type."
    ),
  binance: BINANCE_CREDS.optional().describe(
      "Binance credentials (required when connector='binance'). Read-only API key/secret."
    ),
  metamask: METAMASK_CREDS.optional().describe(
      "MetaMask/EVM config (required when connector='metamask'). Public address + Etherscan rate-limit key + chains."
    ),
  polymarket: POLYMARKET_CREDS.optional().describe(
      "Polymarket config (required when connector='polymarket'). Public proxy wallet address; no secret."
    ),
  solana: SOLANA_CREDS.optional().describe(
      "Solana config (required when connector='solana'). Public base58 address; no secret."
    ),
  hyperliquid: HYPERLIQUID_CREDS.optional().describe(
      "Hyperliquid config (required when connector='hyperliquid'). Public EVM address; no key or signature."
    ),
};

export interface SetupConnectorArgs {
  connector: "bybit" | "binance" | "metamask" | "polymarket" | "solana" | "hyperliquid";
  bybit?: z.infer<typeof BYBIT_CREDS>;
  binance?: z.infer<typeof BINANCE_CREDS>;
  metamask?: z.infer<typeof METAMASK_CREDS>;
  polymarket?: z.infer<typeof POLYMARKET_CREDS>;
  solana?: z.infer<typeof SOLANA_CREDS>;
  hyperliquid?: z.infer<typeof HYPERLIQUID_CREDS>;
}

export interface SetupConnectorResult {
  ok: boolean;
  accountId?: string;
  label?: string;
  error?: string;
  /** Present when the account was registered but the OS keychain was unavailable; explains the env-var fallback. */
  warning?: string;
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
  if (args.connector === "hyperliquid") {
    if (!args.hyperliquid) return { ok: false, error: "hyperliquid credentials required" };
    return setupHyperliquid(args.hyperliquid, vault, store);
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

  // Persist creds; accountTypes (if any) extend the fan-out scope at fetch time.
  const fullCreds: Record<string, unknown> = {
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    accountType: creds.accountType,
  };
  if (creds.accountTypes && creds.accountTypes.length > 0) {
    fullCreds.accountTypes = creds.accountTypes;
  }
  // Account ID stays based on the primary type so existing v0.7-v0.13 vaults
  // round-trip cleanly. Label reflects the full fan-out so the user can see
  // what's being tracked at a glance.
  const allTypes = creds.accountTypes && creds.accountTypes.length > 0
    ? Array.from(new Set([creds.accountType, ...creds.accountTypes]))
    : [creds.accountType];
  const accountId = `bybit:${creds.accountType}`;
  const label = allTypes.length === 1
    ? `Bybit ${creds.accountType}`
    : `Bybit ${allTypes.join("+")}`;
  const account: Account = {
    id: accountId,
    connectorId: "bybit",
    label,
    createdAt: Date.now(),
    metadata: { accountType: creds.accountType, accountTypes: allTypes },
  };
  const fin = await finalizeAccountSetup(vault, store, "bybit", creds.accountType, fullCreds, account);
  return { ok: fin.ok, accountId, label, warning: fin.warning };
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
  const fin = await finalizeAccountSetup(vault, store, "metamask", accountIdentifier, fullCreds, account);
  return { ok: fin.ok, accountId, label, warning: fin.warning };
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
  const fin = await finalizeAccountSetup(vault, store, "binance", accountIdentifier, fullCreds, account);
  return { ok: fin.ok, accountId, label, warning: fin.warning };
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
  const fin = await finalizeAccountSetup(vault, store, "solana", accountIdentifier, fullCreds, account);
  return { ok: fin.ok, accountId, label, warning: fin.warning };
}

async function setupHyperliquid(
  creds: z.infer<typeof HYPERLIQUID_CREDS>,
  vault: Vault,
  store: AccountStore
): Promise<SetupConnectorResult> {
  const fullCreds: Record<string, unknown> = { address: creds.address };
  if (typeof creds.dustThresholdUsd === "number") fullCreds.dustThresholdUsd = creds.dustThresholdUsd;
  const conn = new HyperliquidConnector();
  const validation = await conn.validateCredentials(fullCreds);
  if (!validation.ok) return { ok: false, error: `Hyperliquid validation failed: ${validation.error.message}` };

  // EVM address — lowercase for a stable account id (same convention as MetaMask).
  const accountIdentifier = creds.address.toLowerCase();
  const accountId = `hyperliquid:${accountIdentifier}`;
  const labelShort = `${creds.address.slice(0, 6)}...${creds.address.slice(-4)}`;
  const label = `Hyperliquid ${labelShort}`;
  const account: Account = {
    id: accountId,
    connectorId: "hyperliquid",
    label,
    createdAt: Date.now(),
    metadata: { address: creds.address, dustThresholdUsd: creds.dustThresholdUsd },
  };
  const fin = await finalizeAccountSetup(vault, store, "hyperliquid", accountIdentifier, fullCreds, account);
  return { ok: fin.ok, accountId, label, warning: fin.warning };
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
  const fin = await finalizeAccountSetup(vault, store, "polymarket", accountIdentifier, fullCreds, account);
  return { ok: fin.ok, accountId, label, warning: fin.warning };
}
