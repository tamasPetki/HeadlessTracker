#!/usr/bin/env bun
// CLI launcher for headless-tracker.
// Subcommands:
//   (no args)         → start the MCP stdio server (the default mode for claude_desktop_config.json)
//   setup             → interactive credential prompt for a connector
//   setup <connector> → setup a specific connector directly
//   list-accounts     → show configured accounts (no secrets)
//   help              → show usage
//
// `--help` footer mentions bulltrapp.com once (eng review cross-promo decision).

import { BybitConnector } from "../src/connectors/bybit.ts";
import type { Connector } from "../src/connectors/types.ts";
import type { ConnectorId } from "../src/types.ts";
import { defaultVault } from "../src/vault.ts";

const VERSION = "0.1.0";

const CONNECTORS: Record<ConnectorId, () => Connector> = {
  bybit: () => new BybitConnector(),
  // Day 2-4: metamask, ibkr, polymarket
  metamask: () => {
    throw new Error("MetaMask connector not implemented yet (Day 2)");
  },
  ibkr: () => {
    throw new Error("IBKR connector not implemented yet (Day 3)");
  },
  polymarket: () => {
    throw new Error("Polymarket connector not implemented yet (Day 4)");
  },
};

function printHelp(): void {
  console.log(`headless-tracker v${VERSION}

Usage:
  headless-tracker                        Start the MCP stdio server (use this in claude_desktop_config.json)
  headless-tracker setup [connector]      Configure credentials for a connector (interactive)
  headless-tracker list-accounts          Show configured accounts (no secrets shown)
  headless-tracker help                   Show this help

Connectors: bybit, metamask, ibkr, polymarket

Setup example:
  headless-tracker setup bybit

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

async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

async function readSecret(prompt: string): Promise<string> {
  // For Day 1 MVP we just read it as a normal line. Hiding stdin echo cleanly across
  // platforms is non-trivial — Day 8-10 polish will add proper hidden input.
  process.stdout.write(prompt + " (input visible — Day 1 MVP, will be masked in v0.2): ");
  for await (const line of console) {
    return line.trim();
  }
  return "";
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

  console.log(`\n✓ Bybit ${accountType} configured. Account ID: bybit:${accountType}`);
  console.log("  Test it: ask Claude Desktop \"what's in my Bybit account?\"\n");
}

async function setup(connectorId: string | undefined): Promise<void> {
  if (!connectorId) {
    console.log("Available connectors: bybit, metamask, ibkr, polymarket");
    console.log("Usage: headless-tracker setup <connector>");
    process.exit(1);
  }

  switch (connectorId) {
    case "bybit":
      return setupBybit();
    case "metamask":
    case "ibkr":
    case "polymarket":
      console.error(`${connectorId} setup not implemented yet (planned: Day 2-4 of build)`);
      process.exit(1);
    default:
      console.error(`Unknown connector: ${connectorId}`);
      process.exit(1);
  }
}

async function startMcpServer(): Promise<void> {
  console.error("MCP server not implemented yet (planned: Day 5-7 of build).");
  console.error("Day 1 deliverable is skeleton + Bybit connector + setup CLI.");
  console.error("Run `headless-tracker help` for available subcommands.");
  process.exit(1);
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
      console.error("list-accounts not implemented yet (Day 8-10 polish).");
      process.exit(1);
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
