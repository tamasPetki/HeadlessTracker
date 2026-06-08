#!/usr/bin/env bun
// CLI launcher for headless-tracker.
// Subcommands:
//   (no args)         → start the MCP stdio server (the default mode for claude_desktop_config.json)
//   setup             → list available connectors (when no name given)
//   setup <connector> → interactive credential prompt for a connector
//   list-accounts     → show configured accounts (no secrets)
//   help              → show usage
//
// `--help` footer mentions bulltrapp.com once (eng review cross-promo decision).

import * as readline from "node:readline/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "../src/package-root.ts";
import { defaultAccountStore } from "../src/accounts.ts";
import {
  addCustomToken,
  listCustomTokens,
  removeCustomToken,
} from "../src/tokens.ts";
import { BinanceConnector } from "../src/connectors/binance.ts";
import { BybitConnector } from "../src/connectors/bybit.ts";
import { MetaMaskConnector } from "../src/connectors/metamask.ts";
import { SUPPORTED_CHAINS, type SupportedChainId } from "../src/connectors/metamask-chains.ts";
import { PolymarketConnector } from "../src/connectors/polymarket.ts";
import { SolanaConnector } from "../src/connectors/solana.ts";
import { runStdioServer } from "../src/mcp/server.ts";
import { executeGetHoldings } from "../src/mcp/tools/get_holdings.ts";
import { executeGetPnl } from "../src/mcp/tools/get_pnl.ts";
import { executeGetTransactions } from "../src/mcp/tools/get_transactions.ts";
import type { Account } from "../src/types.ts";
import { defaultVault } from "../src/vault.ts";
import { finalizeAccountSetup } from "../src/setup-finalize.ts";
import { DEMO_HOLDINGS, DEMO_PROMPTS, DEMO_TOTAL_USD } from "../src/demo-data.ts";

// Read from package.json (single source of truth) so the CLI banner can't drift
// from the published version, same as the MCP server's reported version.
const VERSION: string = (() => {
  try {
    const { version } = JSON.parse(
      readFileSync(join(packageRoot(), "package.json"), "utf8")
    ) as { version?: string };
    return version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function printHelp(): void {
  console.log(`headless-tracker v${VERSION}

Usage:
  headless-tracker                        Start the MCP stdio server (use this in claude_desktop_config.json)
  headless-tracker demo                   See a sample portfolio in one command (no accounts, no API keys)
  headless-tracker setup [connector]      Configure credentials for a connector (interactive)
  headless-tracker list-accounts          Show configured accounts (no secrets shown)
  headless-tracker show holdings [...]    Print current holdings (text table, no Claude required)
  headless-tracker show pnl [...]         Print aggregate P&L
  headless-tracker show transactions [..] Print transaction history
  headless-tracker token <add|list|rm>    Manage custom ERC-20 token list (per MetaMask account/chain)
  headless-tracker version                Print the version
  headless-tracker help                   Show this help

Connectors: bybit, binance, metamask, polymarket, solana

Setup examples:
  headless-tracker setup bybit
  headless-tracker setup binance
  headless-tracker setup metamask
  headless-tracker setup polymarket
  headless-tracker setup solana

Show examples:
  headless-tracker show holdings
  headless-tracker show holdings --account-id=bybit:UNIFIED
  headless-tracker show holdings --asset-class=crypto
  headless-tracker show holdings --currency=HUF
  headless-tracker show pnl
  headless-tracker show pnl --include-history=true --method=average
  headless-tracker show pnl --timeframe=7d
  headless-tracker show transactions --since=7d
  headless-tracker show transactions --account-id=metamask:0xabc --since=24h

claude_desktop_config.json snippet:
  {
    "mcpServers": {
      "headless-tracker": {
        "command": "npx",
        "args": ["-y", "headless-tracker"]
      }
    }
  }

Related: bulltrapp.com — hosted web portfolio tracker by the same maintainer.
`);
}

// Lazy-initialized readline interface. Allocated only on first prompt so the
// MCP stdio server mode (which owns process.stdin for JSON-RPC) is unaffected.
// Bun's `console` async iterator gets consumed after the first `for await`, so
// multiple sequential prompts need a stable readline.Interface instead.
let rl: readline.Interface | null = null;
function getReadline(): readline.Interface {
  if (rl === null) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}
function closeReadline(): void {
  if (rl !== null) {
    rl.close();
    rl = null;
  }
}

async function readLine(prompt: string): Promise<string> {
  return (await getReadline().question(prompt)).trim();
}

async function readSecret(prompt: string): Promise<string> {
  // If stdin isn't a TTY (test harness, piped input), fall back to plain readline.
  // setRawMode is unavailable / pointless in that case.
  if (!process.stdin.isTTY) {
    return readLine(prompt + " ");
  }

  // Raw-mode hidden input. Conflicts with the readline interface, so close it
  // first; the next getReadline() call (in subsequent prompts) will re-create.
  closeReadline();

  process.stdout.write(prompt + " ");

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buffer = "";

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        switch (ch) {
          case "\r":
          case "\n":
          case "": // Ctrl+D / EOT
            cleanup();
            process.stdout.write("\n");
            resolve(buffer.trim());
            return;
          case "": // Ctrl+C
            cleanup();
            process.stdout.write("\n");
            reject(new Error("aborted"));
            return;
          case "": // Backspace (DEL)
          case "\b": {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              process.stdout.write("\b \b");
            }
            break;
          }
          default:
            // Filter out other control chars (escape sequences from arrow keys, etc).
            if (ch >= " " && ch !== "") {
              buffer += ch;
              process.stdout.write("*");
            }
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function readYesNo(prompt: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n]: " : " [y/N]: ";
  const answer = (await readLine(prompt + suffix)).toLowerCase();
  if (answer === "") return defaultYes;
  return answer.startsWith("y");
}

async function setupBybit(): Promise<void> {
  console.log("\nBybit V5 setup");
  console.log("──────────────");
  console.log("Create a read-only API key at: https://www.bybit.com/app/user/api-management");
  console.log("Required permissions: 'Read' for Wallet + Trade. NO withdraw permission.\n");

  const apiKey = await readLine("API Key: ");
  const apiSecret = await readSecret("API Secret:");

  const accountTypeRaw = await readLine("Primary account type (UNIFIED/CONTRACT/SPOT/FUND) [UNIFIED]: ");
  const VALID = ["UNIFIED", "CONTRACT", "SPOT", "FUND"] as const;
  type Bt = typeof VALID[number];
  const accountType = (accountTypeRaw || "UNIFIED").toUpperCase() as Bt;
  if (!VALID.includes(accountType)) {
    console.error(`Invalid account type: ${accountType}`);
    process.exit(1);
  }

  // v0.13.2: ask whether to ALSO fan out to other account types. Most common
  // pattern: UNIFIED + FUND, so you can see both your trading wallet AND
  // your funding wallet (USDT parking, deposit holding, etc.).
  console.log("\nBybit segregates funds across multiple account types. Common pattern:");
  console.log("  - UNIFIED = main trading wallet (spot + derivatives unified, post-2023)");
  console.log("  - FUND = funding wallet (deposits, transfers, p2p settlements)");
  console.log("Same API key covers all of them. We can fan out to track multiple at once.");
  const others = VALID.filter((t) => t !== accountType);
  const extras: Bt[] = [];
  for (const t of others) {
    const yn = await readLine(`Also track ${t}? (y/N): `);
    if (yn.trim().toLowerCase() === "y") extras.push(t);
  }

  const fullCreds: Record<string, unknown> = { apiKey, apiSecret, accountType };
  if (extras.length > 0) fullCreds.accountTypes = extras;

  const connector = new BybitConnector();
  console.log("\nValidating credentials...");
  const validation = await connector.validateCredentials(fullCreds);
  if (!validation.ok) {
    console.error(`Validation failed: ${validation.error.message}`);
    process.exit(1);
  }

  const allTypes = [accountType, ...extras];
  const label = allTypes.length === 1 ? `Bybit ${accountType}` : `Bybit ${allTypes.join("+")}`;
  const account: Account = {
    id: `bybit:${accountType}`,
    connectorId: "bybit",
    label,
    createdAt: Date.now(),
    metadata: { accountType, accountTypes: allTypes },
  };
  const fin = await finalizeAccountSetup(defaultVault(), defaultAccountStore(), "bybit", accountType, fullCreds, account);

  console.log(`\n✓ ${label} configured. Account ID: bybit:${accountType}`);
  if (fin.warning) console.warn(`\n⚠  ${fin.warning}`);
  console.log("  Test it: ask Claude Desktop \"what's in my Bybit account?\"\n");
}

async function setupMetaMask(): Promise<void> {
  console.log("\nMetaMask / EVM wallet setup");
  console.log("──────────────────────────");
  console.log("Get an Etherscan V2 API key (free, supports all chains): https://etherscan.io/apis");
  console.log("V2 lets one key cover Ethereum, Polygon, Base, Arbitrum, Optimism, BSC.\n");

  const address = await readLine("Wallet address (0x...): ");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    console.error("Invalid address format. Expected 0x + 40 hex chars.");
    process.exit(1);
  }

  const etherscanApiKey = await readSecret("Etherscan API key:");

  console.log("\nWhich chains do you want to track? (comma-separated chain IDs)");
  console.log("  Available (★ = free Etherscan tier, $ = requires Etherscan Pro):");
  for (const [id, info] of Object.entries(SUPPORTED_CHAINS)) {
    const tier = info.freeTier ? "★" : "$";
    console.log(`    ${id.padStart(5, " ")}  ${tier}  ${info.name} (${info.nativeSymbol})`);
  }
  const chainsRaw = await readLine("\nChain IDs (e.g. '1,137,42161' for ETH+Polygon+Arbitrum): ");
  const chainIds = chainsRaw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));

  if (chainIds.length === 0) {
    console.error("At least one chain ID required.");
    process.exit(1);
  }
  for (const chainId of chainIds) {
    if (!(chainId in SUPPORTED_CHAINS)) {
      console.error(`Unsupported chain ID: ${chainId}`);
      process.exit(1);
    }
  }

  // Ask about Etherscan Pro only if the user picked at least one paid-tier chain.
  let hasEtherscanPro = false;
  const paidChains = chainIds.filter((id) => !SUPPORTED_CHAINS[id as SupportedChainId].freeTier);
  if (paidChains.length > 0) {
    const names = paidChains.map((id) => SUPPORTED_CHAINS[id as SupportedChainId].name).join(", ");
    console.log(`\nYou selected paid-tier chain(s): ${names}.`);
    console.log("Etherscan free tier doesn't cover these. Without Pro they will be SOFT-SKIPPED");
    console.log("at runtime (no error, but no data either — you'll see them in the warnings field).");
    hasEtherscanPro = await readYesNo("Do you have an Etherscan Pro plan?", false);
  }

  const trackCommonTokens = await readYesNo(
    "Track common ERC-20 tokens (USDC, USDT, WETH, WBTC, LINK, DAI per chain)?",
    true
  );

  const connector = new MetaMaskConnector();
  console.log("\nValidating credentials...");
  const validation = await connector.validateCredentials({
    address,
    etherscanApiKey,
    chainIds: chainIds as SupportedChainId[],
    trackCommonTokens,
    hasEtherscanPro,
  });
  if (!validation.ok) {
    console.error(`Validation failed: ${validation.error.message}`);
    process.exit(1);
  }

  // Account ID uses lowercased address (canonical form, avoids checksum mismatches).
  const accountIdentifier = address.toLowerCase();
  const fullCreds = { address, etherscanApiKey, chainIds, trackCommonTokens, hasEtherscanPro };

  const labelShort = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const chainNames = chainIds.map((id) => SUPPORTED_CHAINS[id as SupportedChainId].name).join(", ");
  const account: Account = {
    id: `metamask:${accountIdentifier}`,
    connectorId: "metamask",
    label: `MetaMask ${labelShort} (${chainNames})`,
    createdAt: Date.now(),
    metadata: {
      address,
      chainIds,
      trackCommonTokens,
      hasEtherscanPro,
    },
  };
  const fin = await finalizeAccountSetup(defaultVault(), defaultAccountStore(), "metamask", accountIdentifier, fullCreds, account);

  console.log(`\n✓ MetaMask configured. Account ID: metamask:${accountIdentifier}`);
  console.log(`  Tracking: ${chainNames}`);
  if (fin.warning) console.warn(`\n⚠  ${fin.warning}`);
  console.log("  Test it: ask Claude Desktop \"what's in my MetaMask wallet?\"\n");
}

async function setupPolymarket(): Promise<void> {
  console.log("\nPolymarket setup");
  console.log("────────────────");
  console.log("Find your Polymarket proxy wallet address:");
  console.log("  1. Open https://polymarket.com → click your profile icon");
  console.log("  2. Settings → Wallet → copy the address shown there");
  console.log("  This is NOT your MetaMask address — it's a Polymarket-issued proxy.");
  console.log("  No API key needed; the data-api is public.\n");

  const proxyWallet = await readLine("Polymarket proxy wallet (0x...): ");
  if (!/^0x[a-fA-F0-9]{40}$/.test(proxyWallet)) {
    console.error("Invalid address format. Expected 0x + 40 hex chars.");
    process.exit(1);
  }

  const sizeThresholdRaw = await readLine("Min position size to track (default 0.01, lower = more dust shown): ");
  const sizeThreshold = sizeThresholdRaw ? parseFloat(sizeThresholdRaw) : 0.01;
  if (Number.isNaN(sizeThreshold) || sizeThreshold < 0) {
    console.error(`Invalid size threshold: ${sizeThresholdRaw}`);
    process.exit(1);
  }

  const connector = new PolymarketConnector();
  console.log("\nValidating address (probing data-api)...");
  const validation = await connector.validateCredentials({ proxyWallet, sizeThreshold });
  if (!validation.ok) {
    console.error(`Validation failed: ${validation.error.message}`);
    process.exit(1);
  }

  const accountIdentifier = proxyWallet.toLowerCase();
  const fullCreds = { proxyWallet, sizeThreshold };

  const labelShort = `${proxyWallet.slice(0, 6)}...${proxyWallet.slice(-4)}`;
  const account: Account = {
    id: `polymarket:${accountIdentifier}`,
    connectorId: "polymarket",
    label: `Polymarket ${labelShort}`,
    createdAt: Date.now(),
    metadata: { proxyWallet, sizeThreshold },
  };
  const fin = await finalizeAccountSetup(defaultVault(), defaultAccountStore(), "polymarket", accountIdentifier, fullCreds, account);

  console.log(`\n✓ Polymarket configured. Account ID: polymarket:${accountIdentifier}`);
  if (fin.warning) console.warn(`\n⚠  ${fin.warning}`);
  console.log("  Test it: ask Claude Desktop \"show my Polymarket positions\"\n");
}

async function setupBinance(): Promise<void> {
  console.log("\nBinance setup");
  console.log("─────────────");
  console.log("Create a read-only API key at: https://www.binance.com/en/my/settings/api-management");
  console.log("Required permissions:");
  console.log("  ✓ Enable Reading");
  console.log("  ✗ Enable Spot & Margin Trading (LEAVE OFF)");
  console.log("  ✗ Enable Withdrawals (LEAVE OFF — never enable for tracking)");
  console.log("Optional: 'Enable Futures' if you want futures wallet + open positions tracked.\n");

  const apiKey = await readLine("API Key: ");
  const apiSecret = await readLine("API Secret: ");
  if (!apiKey || !apiSecret) {
    console.error("API key and secret are both required.");
    process.exit(1);
  }

  const includeFuturesRaw = await readLine("Include Futures wallet + positions? (y/N): ");
  const includeFutures = includeFuturesRaw.trim().toLowerCase() === "y";

  const fullCreds = { apiKey, apiSecret, includeFutures };
  const connector = new BinanceConnector();
  console.log("\nValidating credentials (probing /api/v3/account)...");
  const validation = await connector.validateCredentials(fullCreds);
  if (!validation.ok) {
    console.error(`Validation failed: ${validation.error.message}`);
    process.exit(1);
  }

  const fingerprint = apiKey.slice(0, 6);
  const accountIdentifier = `key-${fingerprint}`;
  const label = includeFutures
    ? `Binance Spot+Futures (${fingerprint}…)`
    : `Binance Spot (${fingerprint}…)`;
  const account: Account = {
    id: `binance:${accountIdentifier}`,
    connectorId: "binance",
    label,
    createdAt: Date.now(),
    metadata: { keyFingerprint: fingerprint, includeFutures },
  };
  const fin = await finalizeAccountSetup(defaultVault(), defaultAccountStore(), "binance", accountIdentifier, fullCreds, account);

  console.log(`\n✓ Binance configured. Account ID: binance:${accountIdentifier}`);
  if (fin.warning) console.warn(`\n⚠  ${fin.warning}`);
  console.log("  Test it: ask Claude Desktop \"show my Binance holdings\"\n");
}

async function setupSolana(): Promise<void> {
  console.log("\nSolana wallet setup");
  console.log("───────────────────");
  console.log("Public on-chain read — no API key required.");
  console.log("Public mainnet-beta RPC works for single wallets; for multi-wallet");
  console.log("setups, supply a premium RPC URL (Helius / QuickNode / Triton) to");
  console.log("avoid rate limits. Prices via Jupiter Price API v2.\n");

  const address = await readLine("Solana address (base58, e.g. 4k3Dyj...): ");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    console.error("Invalid address format. Expected base58, 32-44 chars.");
    process.exit(1);
  }

  const rpcUrlRaw = await readLine("Custom RPC URL (optional, ENTER for public mainnet-beta): ");
  const rpcUrl = rpcUrlRaw && rpcUrlRaw.length > 0 ? rpcUrlRaw : undefined;

  const dustRaw = await readLine("Dust threshold in USD (default 0.5; 0 = show everything): ");
  const dustThresholdUsd = dustRaw ? parseFloat(dustRaw) : 0.5;
  if (Number.isNaN(dustThresholdUsd) || dustThresholdUsd < 0) {
    console.error(`Invalid dust threshold: ${dustRaw}`);
    process.exit(1);
  }

  const fullCreds: Record<string, unknown> = { address, dustThresholdUsd };
  if (rpcUrl) fullCreds.rpcUrl = rpcUrl;

  const connector = new SolanaConnector();
  console.log("\nValidating address (probing RPC)...");
  const validation = await connector.validateCredentials(fullCreds);
  if (!validation.ok) {
    console.error(`Validation failed: ${validation.error.message}`);
    process.exit(1);
  }

  // Solana addresses are case-sensitive base58 — keep as-is, no lowercase.
  const accountIdentifier = address;
  const labelShort = `${address.slice(0, 4)}…${address.slice(-4)}`;
  const account: Account = {
    id: `solana:${accountIdentifier}`,
    connectorId: "solana",
    label: `Solana ${labelShort}`,
    createdAt: Date.now(),
    metadata: { address, rpcUrl, dustThresholdUsd },
  };
  const fin = await finalizeAccountSetup(defaultVault(), defaultAccountStore(), "solana", accountIdentifier, fullCreds, account);

  console.log(`\n✓ Solana configured. Account ID: solana:${accountIdentifier}`);
  if (fin.warning) console.warn(`\n⚠  ${fin.warning}`);
  console.log("  Test it: ask Claude Desktop \"show my Solana holdings\"\n");
}

async function setup(connectorId: string | undefined): Promise<void> {
  if (!connectorId) {
    console.log("Available connectors: bybit, binance, metamask, polymarket, solana");
    console.log("Usage: headless-tracker setup <connector>");
    process.exit(1);
  }

  switch (connectorId) {
    case "bybit":
      return setupBybit();
    case "binance":
      return setupBinance();
    case "metamask":
      return setupMetaMask();
    case "polymarket":
      return setupPolymarket();
    case "solana":
      return setupSolana();
    default:
      console.error(`Unknown connector: ${connectorId}`);
      process.exit(1);
  }
}

async function listAccounts(): Promise<void> {
  const accounts = defaultAccountStore().list();
  if (accounts.length === 0) {
    console.log("No accounts configured yet.");
    console.log("Run: headless-tracker setup <connector>  (e.g. 'setup bybit' or 'setup metamask')");
    return;
  }

  console.log(`\n${accounts.length} account${accounts.length === 1 ? "" : "s"} configured:\n`);
  for (const acc of accounts) {
    const created = new Date(acc.createdAt).toISOString().slice(0, 19).replace("T", " ");
    console.log(`  ${acc.id}`);
    console.log(`    label:    ${acc.label}`);
    console.log(`    created:  ${created}`);
    if (acc.metadata && Object.keys(acc.metadata).length > 0) {
      // Print metadata but elide anything sensitive-looking.
      const safe = { ...acc.metadata };
      for (const k of Object.keys(safe)) {
        if (/key|secret|token|password/i.test(k)) {
          safe[k] = "***";
        }
      }
      console.log(`    metadata: ${JSON.stringify(safe)}`);
    }
    console.log("");
  }
}

async function startMcpServer(): Promise<void> {
  // Stdio MCP server. All logging goes to stderr (stdout is reserved for the
  // JSON-RPC framing that the host parses).
  await runStdioServer();
}

// ──────────────────────────────────────────────────────────────────────────────
// `show` subcommands — emit human-readable text tables, NOT JSON. The MCP server
// path returns structured JSON for the LLM. CLI users get readable terminal output.
// ──────────────────────────────────────────────────────────────────────────────

// Parses `--key=value` and `--key value` flags from a positional arg list.
// Unknown flags are ignored (each show command picks the ones it cares about).
function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = "true";
      }
    }
  }
  return out;
}

// Renders a fixed-width text table. No external lib — keeps install lean.
// rows = array of arrays of strings (already stringified). headers same length as each row.
function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const formatRow = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  return [formatRow(headers), sep, ...rows.map(formatRow)].join("\n");
}

function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${abs.toFixed(0)}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

// Currency-aware money formatter. HUF gets no decimals (forint convention).
// Symbol style: USD/EUR/GBP prefix, HUF suffix (Ft is more readable than HUF prefix).
function fmtMoney(n: number | undefined, currency: "USD" | "EUR" | "GBP" | "HUF"): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (currency === "HUF") {
    // HUF is large-numbered and has no fractional convention.
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M Ft`;
    if (abs >= 1000) return `${sign}${abs.toFixed(0)} Ft`;
    return `${sign}${abs.toFixed(0)} Ft`;
  }
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  if (abs >= 1000) return `${sign}${symbol}${abs.toFixed(0)}`;
  if (abs >= 1) return `${sign}${symbol}${abs.toFixed(2)}`;
  return `${sign}${symbol}${abs.toFixed(4)}`;
}

function fmtQty(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toPrecision(6);
}

async function showHoldings(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const currencyFlag = (flags["currency"] ?? "").toUpperCase();
  const validCurrency: "USD" | "EUR" | "GBP" | "HUF" =
    currencyFlag === "EUR" || currencyFlag === "GBP" || currencyFlag === "HUF" ? currencyFlag : "USD";
  const result = await executeGetHoldings({
    account_id: flags["account-id"],
    asset_class: flags["asset-class"] as "crypto" | "stock" | "prediction" | "cash" | undefined,
    currency: validCurrency,
  });

  if (result.holdings.length === 0) {
    console.log("No holdings found.");
    if (result.meta.accountsConfigured === 0) {
      console.log("(No accounts configured. Run `headless-tracker setup <connector>` first.)");
    } else if (result.failures.length > 0) {
      console.log(`(${result.failures.length} account(s) failed to fetch — see below.)`);
    }
  } else {
    const rows = result.holdings.map((h) => [
      h.accountId,
      h.symbol,
      h.assetClass,
      fmtQty(h.quantity),
      fmtMoney(h.value, validCurrency),
      h.currentPrice !== undefined ? fmtMoney(h.currentPrice, validCurrency) : "—",
    ]);
    console.log(renderTable(["account", "symbol", "class", "qty", "value", "price"], rows));
    const total = result.holdings.reduce((s, h) => s + (h.value ?? 0), 0);
    console.log(`\nTotal: ${fmtMoney(total, validCurrency)}  (${result.holdings.length} positions across ${result.meta.accountsWithData} accounts)`);
    if (result.meta.fx) {
      const r = result.meta.fx.rateUsdToTarget.toFixed(4);
      console.log(`FX: 1 USD = ${r} ${result.meta.fx.targetCurrency} (source: ${result.meta.fx.source})`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of result.warnings) console.log(`  - ${w}`);
  }
  if (result.failures.length > 0) {
    console.log("\nFailures:");
    for (const f of result.failures) console.log(`  - ${f.accountId}: ${f.error}`);
  }
}

async function showPnl(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const tf = flags["timeframe"];
  const validTf = tf === "24h" || tf === "7d" || tf === "30d" || tf === "ytd" || tf === "all" ? tf : undefined;
  const includeHistory = flags["include-history"] === "true" || flags["include-history"] === "";
  const methodFlag = flags["method"];
  const validMethod = methodFlag === "fifo" || methodFlag === "average" ? methodFlag : undefined;
  const result = await executeGetPnl({
    account_id: flags["account-id"],
    timeframe: validTf,
    include_history: includeHistory,
    method: validMethod,
  });

  if (result.byAccount.length === 0) {
    console.log("No P&L data — no holdings yet.");
    return;
  }

  const rows = result.byAccount.map((a) => [
    a.accountId,
    fmtUsd(a.currentValue),
    a.costBasis !== null ? fmtUsd(a.costBasis) : "—",
    a.unrealizedPnl !== null ? fmtUsd(a.unrealizedPnl) : "—",
    a.realizedPnl !== null ? fmtUsd(a.realizedPnl) : "—",
  ]);
  console.log(renderTable(["account", "value", "cost basis", "unrealized", "realized"], rows));
  console.log(`\nTotals:`);
  console.log(`  current value:  ${fmtUsd(result.total.currentValue)}`);
  console.log(`  cost basis:     ${fmtUsd(result.total.costBasis)}`);
  console.log(`  unrealized PnL: ${fmtUsd(result.total.unrealizedPnl)}`);
  console.log(`  realized PnL:   ${fmtUsd(result.total.realizedPnl)}`);
  if (result.total.realizedFromHistory) {
    const h = result.total.realizedFromHistory;
    const methodLabel = result.costBasisMethod === "average" ? "Average Cost" : "FIFO";
    console.log(`\nFrom transaction history (${methodLabel} cost basis):`);
    console.log(`  realized (known cost basis): ${fmtUsd(h.knownRealized)}`);
    console.log(`  sales with unknown cost:     ${h.unknownSalesCount}`);
    console.log(`  orphan events:               ${h.orphanCount}`);
  }
  if (result.total.windowDelta) {
    const w = result.total.windowDelta;
    const sign = w.delta >= 0 ? "+" : "";
    console.log(`\nWindow delta (${w.timeframe}, since ${w.asOfDate.slice(0, 10)}):`);
    console.log(`  historical value:    ${fmtUsd(w.historicalValue)}`);
    console.log(`  current value:       ${fmtUsd(w.currentValueAtSnapshot)} (priced subset only)`);
    console.log(`  delta:               ${sign}${fmtUsd(w.delta)} (${sign}${w.deltaPercent.toFixed(2)}%)`);
    console.log(`  priced / skipped:    ${w.pricedSymbols} priced, ${w.skippedSymbols} skipped`);
    if (w.skippedSymbols > 0 && w.skippedReasons.length <= 5) {
      for (const r of w.skippedReasons) console.log(`    - ${r}`);
    } else if (w.skippedSymbols > 0) {
      console.log(`    (${w.skippedReasons.length} skipped — see JSON output for full list)`);
    }
  }
  console.log(`\n${result.timeframeNote}`);
  // Surface per-account notes (e.g. "MetaMask doesn't track cost basis").
  const allNotes = new Set<string>();
  for (const a of result.byAccount) for (const n of a.notes) allNotes.add(n);
  if (allNotes.size > 0) {
    console.log("\nNotes:");
    for (const n of allNotes) console.log(`  - ${n}`);
  }
}

async function showTransactions(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const result = await executeGetTransactions({
    account_id: flags["account-id"],
    since: flags["since"],
  });

  if (result.transactions.length === 0) {
    console.log("No transactions in the requested window.");
    if (result.meta.accountsWithEmptyResults > 0) {
      console.log(`(${result.meta.accountsWithEmptyResults} account(s) returned 0 — try a longer --since.)`);
    }
    return;
  }

  const rows = result.transactions.slice(0, 50).map((t) => [
    t.timestamp.slice(0, 19).replace("T", " "),
    t.accountId,
    t.type,
    t.symbol ?? "—",
    fmtQty(t.quantity),
    t.price !== undefined ? fmtUsd(t.price) : "—",
    t.fee !== undefined ? `${fmtQty(t.fee)} ${t.feeCurrency ?? ""}`.trim() : "—",
  ]);
  console.log(renderTable(["timestamp (UTC)", "account", "type", "symbol", "qty", "price", "fee"], rows));
  console.log(`\nShowing ${rows.length} of ${result.meta.totalTransactions} transactions${result.meta.sinceResolved ? ` since ${result.meta.sinceResolved.slice(0, 10)}` : ""}.`);

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of result.warnings) console.log(`  - ${w}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// `token` subcommands — manage custom ERC-20 token lists per (account, chain).
// Pure logic lives in src/tokens.ts. CLI handlers below are argv-parse + error
// printing; the testable surface is the tokens module.
// ──────────────────────────────────────────────────────────────────────────────

async function tokenAdd(args: string[]): Promise<void> {
  if (args.length < 5) {
    console.error("Usage: headless-tracker token add <account-id> <chain-id> <contract> <symbol> <decimals>");
    console.error("Example: headless-tracker token add metamask:0xabc 1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 USDC 6");
    process.exit(1);
  }
  const [accountId, chainIdStr, contract, symbol, decimalsStr] = args;
  const chainId = parseInt(chainIdStr!, 10);
  const decimals = parseInt(decimalsStr!, 10);

  const result = addCustomToken(defaultAccountStore(), accountId!, chainId, {
    contract: contract!,
    symbol: symbol!,
    decimals,
  });
  if (!result.ok) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.value.action === "updated") {
    console.log(`Updated ${symbol} on chain ${chainId} for ${accountId}.`);
  } else {
    console.log(`Added ${symbol} (${contract}) on chain ${chainId} for ${accountId}.`);
  }
}

async function tokenListCmd(args: string[]): Promise<void> {
  const accountId = args[0];
  if (accountId && !defaultAccountStore().get(accountId)) {
    console.error(`Account not found: ${accountId}.`);
    process.exit(1);
  }
  const listed = listCustomTokens(defaultAccountStore(), accountId);
  if (listed.length === 0) {
    console.log(accountId ? `No custom tokens for ${accountId}.` : "No custom tokens configured for any account.");
    return;
  }
  let lastAccount = "";
  for (const row of listed) {
    if (row.accountId !== lastAccount) {
      console.log(`\n${row.accountId}:`);
      lastAccount = row.accountId;
    }
    console.log(`  ${row.chainName.padEnd(18)} ${row.token.symbol.padEnd(8)} ${row.token.contract}  decimals=${row.token.decimals}`);
  }
}

async function tokenRemoveCmd(args: string[]): Promise<void> {
  if (args.length < 3) {
    console.error("Usage: headless-tracker token remove <account-id> <chain-id> <contract>");
    process.exit(1);
  }
  const [accountId, chainIdStr, contract] = args;
  const chainId = parseInt(chainIdStr!, 10);
  const result = removeCustomToken(defaultAccountStore(), accountId!, chainId, contract!);
  if (!result.ok) {
    console.error(result.error.message);
    process.exit(1);
  }
  console.log(`Removed ${contract} on chain ${chainId} from ${accountId}.`);
}

async function token(action: string | undefined, rest: string[]): Promise<void> {
  switch (action) {
    case "add":
      return tokenAdd(rest);
    case "list":
      return tokenListCmd(rest);
    case "remove":
    case "rm":
      return tokenRemoveCmd(rest);
    default:
      console.log("Usage: headless-tracker token <add|list|remove> [args...]");
      console.log("");
      console.log("  token add <account-id> <chain-id> <contract> <symbol> <decimals>");
      console.log("  token list [account-id]");
      console.log("  token remove <account-id> <chain-id> <contract>");
      console.log("");
      console.log("Examples:");
      console.log("  headless-tracker token add metamask:0xabc 1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 USDC 6");
      console.log("  headless-tracker token list metamask:0xabc");
      console.log("  headless-tracker token remove metamask:0xabc 1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
      if (action) process.exit(1);
  }
}

async function show(thing: string | undefined, rest: string[]): Promise<void> {
  switch (thing) {
    case "holdings":
      return showHoldings(rest);
    case "pnl":
      return showPnl(rest);
    case "transactions":
    case "tx":
      return showTransactions(rest);
    default:
      console.log("Usage: headless-tracker show <holdings|pnl|transactions> [flags...]");
      console.log("");
      console.log("Examples:");
      console.log("  headless-tracker show holdings");
      console.log("  headless-tracker show holdings --account-id=bybit:UNIFIED");
      console.log("  headless-tracker show pnl");
      console.log("  headless-tracker show transactions --since=7d");
      if (thing) process.exit(1);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// `demo` — zero-credential walkthrough. Renders a sample multi-venue portfolio
// (src/demo-data.ts) through the SAME table/format helpers as `show holdings`,
// so what you see here is exactly what the tool returns once you connect real,
// read-only accounts. The point: see the value in one command, no API keys.
// ──────────────────────────────────────────────────────────────────────────────

async function runDemo(): Promise<void> {
  const USD = "USD" as const;
  console.log(`\nheadless-tracker demo  ·  sample portfolio (no accounts, no API keys)`);
  console.log("─".repeat(64));
  console.log("Illustrative data, not a real account. This is exactly what your AI");
  console.log("host sees when it queries HeadlessTracker over MCP.\n");

  const rows = DEMO_HOLDINGS.map((h) => [
    h.accountId,
    h.symbol,
    h.assetClass,
    fmtQty(h.quantity),
    fmtMoney(h.value, USD),
    h.currentPrice !== undefined ? fmtMoney(h.currentPrice, USD) : "—",
  ]);
  console.log(renderTable(["account", "symbol", "class", "qty", "value", "price"], rows));

  const total = DEMO_TOTAL_USD;
  const venues = new Set(DEMO_HOLDINGS.map((h) => h.accountId)).size;
  console.log(`\nTotal: ${fmtMoney(total, USD)}  (${DEMO_HOLDINGS.length} positions across ${venues} venues)`);

  // Allocation by asset class — the "how is it split" value prop, drawn as a bar.
  const byClass = new Map<string, number>();
  for (const h of DEMO_HOLDINGS) {
    byClass.set(h.assetClass, (byClass.get(h.assetClass) ?? 0) + (h.value ?? 0));
  }
  console.log("\nAllocation by asset class:");
  for (const [cls, val] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((val / total) * 100).toFixed(1);
    const bar = "█".repeat(Math.max(1, Math.round((val / total) * 24)));
    console.log(`  ${cls.padEnd(11)} ${fmtMoney(val, USD).padStart(9)}  ${pct.padStart(5)}%  ${bar}`);
  }

  // Sell the agent experience, not just a table: each question maps to one tool.
  console.log("\nAsk your AI in plain English (each maps to one MCP tool):");
  for (const p of DEMO_PROMPTS) {
    console.log(`  "${p.ask}"`);
    console.log(`      → ${p.tool}`);
  }

  console.log("\nConnect your own (read-only keys, runs locally on your machine):");
  console.log("  headless-tracker setup bybit | binance | metamask | solana | polymarket");
  console.log("  then point Claude Desktop at it — see `headless-tracker help`.");
  console.log("\nData aggregation only — not financial advice.\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case undefined:
      return startMcpServer();
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(`headless-tracker v${VERSION}`);
      return;
    case "setup":
      return setup(args[1]);
    case "demo":
      return runDemo();
    case "list-accounts":
      return listAccounts();
    case "show":
      return show(args[1], args.slice(2));
    case "token":
      return token(args[1], args.slice(2));
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main()
  .then(() => closeReadline())
  .catch((e) => {
    closeReadline();
    console.error(`Fatal: ${(e as Error).message}`);
    process.exit(1);
  });
