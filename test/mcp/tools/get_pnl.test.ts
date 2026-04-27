import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../../src/accounts.ts";
import { Cache } from "../../../src/cache.ts";
import { Orchestrator } from "../../../src/mcp/orchestrator.ts";
import { executeGetPnl } from "../../../src/mcp/tools/get_pnl.ts";
import { ok } from "../../../src/types.ts";
import { StubConnector, StubVault, makeHolding } from "../../helpers/stub-connector.ts";

let cache: Cache;
let accountStore: AccountStore;
let vault: StubVault;

beforeEach(() => {
  cache = new Cache({ dbPath: ":memory:" });
  accountStore = new AccountStore({ dbPath: ":memory:" });
  vault = new StubVault();
});

afterEach(() => {
  cache.close();
  accountStore.close();
});

function setupAccount(id: string, connectorId: "bybit" | "metamask" | "polymarket"): void {
  accountStore.upsert({ id, connectorId, label: id, createdAt: 1 });
  vault.set(connectorId, id.slice(connectorId.length + 1), { x: 1 });
}

describe("executeGetPnl", () => {
  test("aggregates currentValue + costBasis + unrealized P&L correctly", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, avgCost: 25000, currentPrice: 30000, value: 30000 }),
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "ETH", quantity: 2, avgCost: 2000, currentPrice: 2500, value: 5000 }),
          ]),
        }),
      },
    });

    const result = await executeGetPnl({}, orch);
    expect(result.total.currentValue).toBe(35000);
    expect(result.total.costBasis).toBe(29000);             // 25000 + 4000
    expect(result.total.unrealizedPnl).toBe(6000);          // 35000 - 29000
  });

  test("timeframe param is informational only — flagged in timeframeNote", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: { bybit: new StubConnector({ id: "bybit", holdingsResult: ok([]) }) },
    });

    const result7d = await executeGetPnl({ timeframe: "7d" }, orch);
    expect(result7d.timeframeRequested).toBe("7d");
    expect(result7d.timeframeNote).toContain("V0 returns point-in-time");

    const resultAll = await executeGetPnl({ timeframe: "all" }, orch);
    expect(resultAll.timeframeNote).not.toContain("V0 returns point-in-time");
  });

  test("MetaMask holdings without cost basis surface in notes (V0 limitation)", async () => {
    setupAccount("metamask:0xabc", "metamask");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        metamask: new StubConnector({
          id: "metamask",
          holdingsResult: ok([
            // MetaMask holdings have no avgCost, plus chainId metadata sniffer.
            makeHolding({ accountId: "metamask:0xabc", symbol: "ETH", quantity: 1, value: 2500, metadata: { chainId: 1 } }),
          ]),
        }),
      },
    });

    const result = await executeGetPnl({}, orch);
    const notes = result.byAccount[0]!.notes.join(" ");
    expect(notes).toContain("MetaMask connector does not yet track cost basis");
  });

  test("byAccount totals stay separate from aggregate total", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    setupAccount("metamask:0xabc", "metamask");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", value: 1000, avgCost: 800, quantity: 1 })]),
        }),
        metamask: new StubConnector({
          id: "metamask",
          holdingsResult: ok([makeHolding({ accountId: "metamask:0xabc", value: 500 })]),
        }),
      },
    });

    const result = await executeGetPnl({}, orch);
    expect(result.byAccount).toHaveLength(2);
    expect(result.total.currentValue).toBe(1500);
    expect(result.total.costBasis).toBe(800);              // only bybit had cost
  });

  test("include_history=true populates realizedFromHistory via FIFO cost basis", async () => {
    // BUY 100 @ 1.0, SELL 50 @ 1.05 → realized 2.50.
    setupAccount("bybit:UNIFIED", "bybit");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "USDC", quantity: 50, value: 50, currentPrice: 1, avgCost: 1 })]),
          transactionsResult: ok([
            { accountId: "bybit:UNIFIED", txId: "buy1", type: "buy", symbol: "USDC", quantity: 100, price: 1.0, timestamp: 1000 },
            { accountId: "bybit:UNIFIED", txId: "sell1", type: "sell", symbol: "USDC", quantity: 50, price: 1.05, timestamp: 2000 },
          ]),
        }),
      },
    });

    const without = await executeGetPnl({}, orch);
    expect(without.total.realizedFromHistory).toBeNull();
    expect(without.byAccount[0]!.realizedFromHistory).toBeNull();

    const withHistory = await executeGetPnl({ include_history: true }, orch);
    expect(withHistory.total.realizedFromHistory).not.toBeNull();
    expect(withHistory.total.realizedFromHistory!.knownRealized).toBeCloseTo(2.5, 6);
    expect(withHistory.total.realizedFromHistory!.unknownSalesCount).toBe(0);
    expect(withHistory.total.realizedFromHistory!.orphanCount).toBe(0);
    expect(withHistory.byAccount[0]!.realizedFromHistory!.knownRealized).toBeCloseTo(2.5, 6);
  });

  test("include_history surfaces unknown-cost-basis sales in notes (MetaMask deposit-then-sell)", async () => {
    // MetaMask: deposit (no price) followed by a synthetic SELL. Realized PnL
    // should be null in cost_basis output → reflected as unknownSalesCount=1
    // and surfaced in the account's notes.
    setupAccount("metamask:0xabc", "metamask");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        metamask: new StubConnector({
          id: "metamask",
          holdingsResult: ok([makeHolding({ accountId: "metamask:0xabc", symbol: "FOO", quantity: 50, value: 100, metadata: { chainId: 1 } })]),
          transactionsResult: ok([
            { accountId: "metamask:0xabc", txId: "dep1", type: "deposit", symbol: "FOO", quantity: 100, timestamp: 1000 },
            { accountId: "metamask:0xabc", txId: "sell1", type: "sell", symbol: "FOO", quantity: 50, price: 2.0, timestamp: 2000 },
          ]),
        }),
      },
    });

    const result = await executeGetPnl({ include_history: true }, orch);
    const account = result.byAccount[0]!;
    expect(account.realizedFromHistory!.knownRealized).toBe(0);
    expect(account.realizedFromHistory!.unknownSalesCount).toBe(1);
    expect(account.notes.join(" ")).toContain("unknown cost basis");
  });
});
