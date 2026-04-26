import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../../src/accounts.ts";
import { Cache } from "../../../src/cache.ts";
import { Orchestrator } from "../../../src/mcp/orchestrator.ts";
import { executeGetAllocations } from "../../../src/mcp/tools/get_allocations.ts";
import { ok } from "../../../src/types.ts";
import { StubConnector, StubVault, makeHolding } from "../../helpers/stub-connector.ts";

let cache: Cache;
let accountStore: AccountStore;
let vault: StubVault;
let orch: Orchestrator;

beforeEach(() => {
  cache = new Cache({ dbPath: ":memory:" });
  accountStore = new AccountStore({ dbPath: ":memory:" });
  vault = new StubVault();

  accountStore.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
  accountStore.upsert({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });
  accountStore.upsert({ id: "polymarket:0xdef", connectorId: "polymarket", label: "P", createdAt: 3 });
  vault.set("bybit", "UNIFIED", { x: 1 });
  vault.set("metamask", "0xabc", { x: 1 });
  vault.set("polymarket", "0xdef", { x: 1 });

  orch = new Orchestrator({
    accountStore, cache, vault: vault as never,
    connectorOverrides: {
      bybit: new StubConnector({
        id: "bybit",
        holdingsResult: ok([
          makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", value: 30000, assetClass: "crypto" }),
          makeHolding({ accountId: "bybit:UNIFIED", symbol: "ETH", value: 5000, assetClass: "crypto" }),
        ]),
      }),
      metamask: new StubConnector({
        id: "metamask",
        holdingsResult: ok([
          makeHolding({ accountId: "metamask:0xabc", symbol: "ETH", value: 2500, assetClass: "crypto", metadata: { chainId: 1, chainName: "Ethereum" } }),
          makeHolding({ accountId: "metamask:0xabc", symbol: "USDC", value: 1500, assetClass: "crypto", metadata: { chainId: 137, chainName: "Polygon" } }),
        ]),
      }),
      polymarket: new StubConnector({
        id: "polymarket",
        holdingsResult: ok([
          makeHolding({ accountId: "polymarket:0xdef", symbol: "trump-2024:Yes", value: 1000, assetClass: "prediction" }),
        ]),
      }),
    },
  });
});

afterEach(() => {
  cache.close();
  accountStore.close();
});

describe("executeGetAllocations", () => {
  test("default groups by asset_class with correct percentages", async () => {
    // total: 30000 + 5000 + 2500 + 1500 + 1000 = 40000
    // crypto: 39000 (97.5%), prediction: 1000 (2.5%)
    const result = await executeGetAllocations({}, orch);
    expect(result.groupedBy).toBe("asset_class");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.label).toBe("crypto");
    expect(result.rows[0]!.currentValue).toBe(39000);
    expect(result.rows[0]!.percentOfTotal).toBeCloseTo(97.5, 1);
    expect(result.rows[1]!.label).toBe("prediction");
    expect(result.rows[1]!.percentOfTotal).toBeCloseTo(2.5, 1);
    expect(result.meta.totalCurrentValue).toBe(40000);
  });

  test("groupBy=connector splits by connectorId prefix of accountId", async () => {
    const result = await executeGetAllocations({ by: "connector" }, orch);
    const labels = result.rows.map((r) => r.label).sort();
    expect(labels).toEqual(["bybit", "metamask", "polymarket"]);
  });

  test("groupBy=symbol returns one row per unique symbol", async () => {
    const result = await executeGetAllocations({ by: "symbol" }, orch);
    // ETH appears in both bybit (5000) and metamask (2500) → grouped together = 7500
    const eth = result.rows.find((r) => r.label === "ETH");
    expect(eth).toBeDefined();
    expect(eth!.currentValue).toBe(7500);
    expect(eth!.holdingCount).toBe(2);
  });

  test("groupBy=chain uses metadata.chainName, falls back to 'n/a' for non-EVM", async () => {
    const result = await executeGetAllocations({ by: "chain" }, orch);
    const labels = result.rows.map((r) => r.label).sort();
    expect(labels).toContain("Ethereum");
    expect(labels).toContain("Polygon");
    expect(labels).toContain("n/a (non-EVM)");              // bybit + polymarket
  });

  test("top: 2 truncates to 2 biggest rows", async () => {
    const result = await executeGetAllocations({ by: "symbol", top: 2 }, orch);
    expect(result.rows).toHaveLength(2);
    expect(result.meta.truncatedTo).toBe(2);
    // Sorted desc — biggest two should be BTC (30000) and ETH (7500).
    expect(result.rows[0]!.label).toBe("BTC");
    expect(result.rows[1]!.label).toBe("ETH");
  });

  test("rows are sorted descending by currentValue", async () => {
    const result = await executeGetAllocations({ by: "symbol" }, orch);
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1]!.currentValue).toBeGreaterThanOrEqual(result.rows[i]!.currentValue);
    }
  });
});
