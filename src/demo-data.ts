// Sample portfolio for `headless-tracker demo` — lets anyone see what the tool
// (and the AI host querying it) returns WITHOUT configuring any connector or
// supplying API keys. This is illustrative data with fixed example prices; it
// is NOT live and NOT tied to any real account. The numbers exist only to make
// the "what do I own across everything" experience concrete in one command.
//
// Kept as a separate, typed module (not inlined in the CLI) so the dataset is
// importable and unit-testable, and so the shape can't silently drift from the
// real Holding contract.

import type { Account, Holding } from "./types.ts";

// Deterministic snapshot time so the demo and its tests don't depend on the clock.
const DEMO_FETCHED_AT = Date.parse("2026-06-01T12:00:00Z");

// Six sample accounts — one per connector — so the demo tells the full
// multi-venue story (exchanges + EVM wallet + Solana wallet + Hyperliquid perp/
// spot + prediction market). Addresses are obviously-sample, not real wallets.
export const DEMO_ACCOUNTS: Account[] = [
  { id: "bybit:UNIFIED", connectorId: "bybit", label: "Bybit UNIFIED", createdAt: DEMO_FETCHED_AT, metadata: { accountType: "UNIFIED" } },
  { id: "binance:spot", connectorId: "binance", label: "Binance Spot", createdAt: DEMO_FETCHED_AT, metadata: {} },
  { id: "metamask:0xd8d2…f1a3", connectorId: "metamask", label: "MetaMask 0xd8d2…f1a3 (Ethereum)", createdAt: DEMO_FETCHED_AT, metadata: { chain: "ethereum" } },
  { id: "solana:7vfC…Wd9k", connectorId: "solana", label: "Solana 7vfC…Wd9k", createdAt: DEMO_FETCHED_AT, metadata: {} },
  { id: "hyperliquid:0x3f9a…2c41", connectorId: "hyperliquid", label: "Hyperliquid 0x3f9a…2c41", createdAt: DEMO_FETCHED_AT, metadata: { address: "0x3f9a…2c41" } },
  { id: "polymarket:0x9c1a…7b20", connectorId: "polymarket", label: "Polymarket 0x9c1a…7b20", createdAt: DEMO_FETCHED_AT, metadata: {} },
];

// Helper to cut boilerplate; value is stated explicitly (= quantity * currentPrice)
// rather than computed, so the dataset reads as a fixed snapshot.
function h(
  accountId: string,
  symbol: string,
  assetClass: Holding["assetClass"],
  quantity: number,
  currentPrice: number,
  value: number,
  metadata?: Record<string, unknown>,
): Holding {
  return { accountId, symbol, assetClass, quantity, currentPrice, value, valueCurrency: "USD", fetchedAt: DEMO_FETCHED_AT, metadata };
}

export const DEMO_HOLDINGS: Holding[] = [
  // Bybit UNIFIED — exchange spot+derivatives wallet
  h("bybit:UNIFIED", "BTC", "crypto", 0.42, 61200, 25704),
  h("bybit:UNIFIED", "ETH", "crypto", 3.5, 2980, 10430),
  h("bybit:UNIFIED", "USDT", "cash", 4200, 1, 4200),
  // Binance Spot
  h("binance:spot", "SOL", "crypto", 95, 152, 14440),
  h("binance:spot", "BNB", "crypto", 11, 590, 6490),
  h("binance:spot", "USDC", "cash", 3000, 1, 3000),
  // MetaMask — Ethereum mainnet wallet
  h("metamask:0xd8d2…f1a3", "ETH", "crypto", 1.8, 2980, 5364, { chain: "ethereum" }),
  h("metamask:0xd8d2…f1a3", "WBTC", "crypto", 0.15, 61000, 9150, { chain: "ethereum", contract: "0x2260…c599" }),
  h("metamask:0xd8d2…f1a3", "LINK", "crypto", 420, 13.5, 5670, { chain: "ethereum", contract: "0x5149…ca1f" }),
  h("metamask:0xd8d2…f1a3", "USDC", "cash", 6500, 1, 6500, { chain: "ethereum" }),
  // Solana wallet
  h("solana:7vfC…Wd9k", "SOL", "crypto", 60, 152, 9120),
  h("solana:7vfC…Wd9k", "JUP", "crypto", 1800, 0.92, 1656),
  h("solana:7vfC…Wd9k", "USDC", "cash", 1200, 1, 1200),
  // Hyperliquid — perp account equity (collateral + unrealized PnL, reported as
  // the account's net USD value) plus a spot token balance. Open perp positions
  // are tracked too in the real connector (with full exposure detail in
  // metadata), but their notional is deliberately NOT summed into net worth.
  h("hyperliquid:0x3f9a…2c41", "USDC", "cash", 8200, 1, 8200, { venue: "hyperliquid", marketType: "perp", kind: "perp-account-equity", note: "perp account equity" }),
  h("hyperliquid:0x3f9a…2c41", "HYPE", "crypto", 120, 32, 3840, { venue: "hyperliquid", marketType: "spot" }),
  // Polymarket — prediction-market positions (price = market-implied probability)
  h("polymarket:0x9c1a…7b20", "RATE-CUT-2026 (YES)", "prediction", 1500, 0.62, 930, { market: "Will the Fed cut rates in 2026?", outcome: "YES" }),
  h("polymarket:0x9c1a…7b20", "BTC-100K-2026 (YES)", "prediction", 800, 0.34, 272, { market: "Bitcoin above $100k by Dec 2026?", outcome: "YES" }),
];

// Sum of stated values — the single source of truth the demo prints and tests assert.
export const DEMO_TOTAL_USD: number = DEMO_HOLDINGS.reduce((s, x) => s + (x.value ?? 0), 0);

// Example natural-language questions an AI host can answer over this data, each
// mapped to the MCP tool it would call. Drives the "ask your AI" section so the
// demo sells the agent experience, not just a CLI table.
export const DEMO_PROMPTS: { ask: string; tool: string }[] = [
  { ask: "What do I own across everything?", tool: "get_holdings" },
  { ask: "How is my portfolio split between crypto, cash and prediction markets?", tool: "get_allocations" },
  { ask: "Show my Polymarket positions grouped by event.", tool: "get_polymarket_positions" },
  { ask: "Am I up or down, and by how much?", tool: "get_pnl" },
];
