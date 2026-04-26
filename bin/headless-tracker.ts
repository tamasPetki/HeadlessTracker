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

import { defaultAccountStore } from "../src/accounts.ts";
import { BybitConnector } from "../src/connectors/bybit.ts";
import { MetaMaskConnector, SUPPORTED_CHAINS, type SupportedChainId } from "../src/connectors/metamask.ts";
import { PolymarketConnector } from "../src/connectors/polymarket.ts";
import { runStdioServer } from "../src/mcp/server.ts";
import type { Account } from "../src/types.ts";
import { defaultVault } from "../src/vault.ts";

const VERSION = "0.7.0-burn-in";

function printHelp(): void {
  console.log(`headless-tracker v${VERSION}

Usage:
  headless-tracker                        Start the MCP stdio server (use this in claude_desktop_config.json)
  headless-tracker setup [connector]      Configure credentials for a connector (interactive)
  headless-tracker list-accounts          Show configured accounts (no secrets shown)
  headless-tracker help                   Show this help

Connectors: bybit, metamask, polymarket

Setup examples:
  headless-tracker setup bybit
  headless-tracker setup metamask
  headless-tracker setup polymarket

claude_desktop_config.json snippet:
  {
    "mcpServers": {
      "headless-tracker": {
        "command": "bunx",
        "args": ["headless-tracker"]
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
  const accountTypeRaw = await readLine("Account type (UNIFIED/CONTRACT/SPOT/FUND) [UNIFIED]: ");
  const accountType = (accountTypeRaw || "UNIFIED").toUpperCase() as "UNIFIED" | "CONTRACT" | "SPOT" | "FUND";

  if (!["UNIFIED", "CONTRACT", "SPOT", "FUND"].includes(accountType)) {
    console.error(`Invalid account type: ${accountType}`);
    process.exit(1);
  }

  const connector = new BybitConnector();
  console.log("\nValidating credentials...");
  const validation = await connector.validateCredentials({ apiKey, apiSecret, accountType });
  if (!validation.ok) {
    console.error(`Validation failed: ${validation.error.message}`);
    process.exit(1);
  }

  const vault = defaultVault();
  const setResult = await vault.set("bybit", accountType, { apiKey, apiSecret, accountType });
  if (!setResult.ok) {
    console.error(`Vault write failed: ${setResult.error.message}`);
    process.exit(1);
  }

  // Register Account in the SQLite registry (Day 2 addition).
  const accounts = defaultAccountStore();
  const account: Account = {
    id: `bybit:${accountType}`,
    connectorId: "bybit",
    label: `Bybit ${accountType}`,
    createdAt: Date.now(),
    metadata: { accountType },
  };
  accounts.upsert(account);

  console.log(`\n✓ Bybit ${accountType} configured. Account ID: bybit:${accountType}`);
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
  console.log("  Available:");
  for (const [id, info] of Object.entries(SUPPORTED_CHAINS)) {
    console.log(`    ${id.padStart(5, " ")}  ${info.name} (${info.nativeSymbol})`);
  }
  const chainsRaw = await readLine("\nChain IDs (e.g. '1,137,8453' for ETH+Polygon+Base): ");
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
  });
  if (!validation.ok) {
    console.error(`Validation failed: ${validation.error.message}`);
    process.exit(1);
  }

  // Account ID uses lowercased address (canonical form, avoids checksum mismatches).
  const accountIdentifier = address.toLowerCase();

  const vault = defaultVault();
  const setResult = await vault.set("metamask", accountIdentifier, {
    address,
    etherscanApiKey,
    chainIds,
    trackCommonTokens,
  });
  if (!setResult.ok) {
    console.error(`Vault write failed: ${setResult.error.message}`);
    process.exit(1);
  }

  const accounts = defaultAccountStore();
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
    },
  };
  accounts.upsert(account);

  console.log(`\n✓ MetaMask configured. Account ID: metamask:${accountIdentifier}`);
  console.log(`  Tracking: ${chainNames}`);
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

  const vault = defaultVault();
  const setResult = await vault.set("polymarket", accountIdentifier, {
    proxyWallet,
    sizeThreshold,
  });
  if (!setResult.ok) {
    console.error(`Vault write failed: ${setResult.error.message}`);
    process.exit(1);
  }

  const accounts = defaultAccountStore();
  const labelShort = `${proxyWallet.slice(0, 6)}...${proxyWallet.slice(-4)}`;
  const account: Account = {
    id: `polymarket:${accountIdentifier}`,
    connectorId: "polymarket",
    label: `Polymarket ${labelShort}`,
    createdAt: Date.now(),
    metadata: { proxyWallet, sizeThreshold },
  };
  accounts.upsert(account);

  console.log(`\n✓ Polymarket configured. Account ID: polymarket:${accountIdentifier}`);
  console.log("  Test it: ask Claude Desktop \"show my Polymarket positions\"\n");
}

async function setup(connectorId: string | undefined): Promise<void> {
  if (!connectorId) {
    console.log("Available connectors: bybit, metamask, polymarket");
    console.log("Usage: headless-tracker setup <connector>");
    process.exit(1);
  }

  switch (connectorId) {
    case "bybit":
      return setupBybit();
    case "metamask":
      return setupMetaMask();
    case "polymarket":
      return setupPolymarket();
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
    case "setup":
      return setup(args[1]);
    case "list-accounts":
      return listAccounts();
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
