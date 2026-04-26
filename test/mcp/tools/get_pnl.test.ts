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
});
