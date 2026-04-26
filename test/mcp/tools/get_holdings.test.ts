import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../../src/accounts.ts";
import { Cache } from "../../../src/cache.ts";
import { Orchestrator } from "../../../src/mcp/orchestrator.ts";
import { executeGetHoldings } from "../../../src/mcp/tools/get_holdings.ts";
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

  // 3 accounts, varied asset classes
  accountStore.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
  accountStore.upsert({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });
  accountStore.upsert({ id: "polymarket:0xdef", connectorId: "polymarket", label: "P", createdAt: 3 });
  vault.set("bybit", "UNIFIED", { apiKey: "x" });
  vault.set("metamask", "0xabc", { address: "0xabc" });
  vault.set("polymarket", "0xdef", { proxyWallet: "0xdef" });

  orch = new Orchestrator({
    accountStore,
    cache,
    vault: vault as never,
    connectorOverrides: {
      bybit: new StubConnector({
        id: "bybit",
        holdingsResult: ok([
          makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 0.5, value: 30000 }),
          makeHolding({ accountId: "bybit:UNIFIED", symbol: "ETH", quantity: 2, value: 5000 }),
        ]),
      }),
      metamask: new StubConnector({
        id: "metamask",
        holdingsResult: ok([
          makeHolding({ accountId: "metamask:0xabc", symbol: "ETH", quantity: 1, value: 2500 }),
        ]),
      }),
      polymarket: new StubConnector({
        id: "polymarket",
        holdingsResult: ok([
          makeHolding({
            accountId: "polymarket:0xdef",
            symbol: "trump-2024:Yes",
            assetClass: "prediction",
            quantity: 100,
            value: 60,
          }),
        ]),
      }),
    },
  });
});

afterEach(() => {
  cache.close();
  accountStore.close();
});

describe("executeGetHoldings", () => {
  test("returns holdings from all accounts when no filter", async () => {
    const result = await executeGetHoldings({}, orch);
    expect(result.holdings).toHaveLength(4);
    expect(result.meta.totalAccounts).toBe(3);
    expect(result.meta.accountsWithErrors).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test("account_id filter scopes to one account", async () => {
    const result = await executeGetHoldings({ account_id: "bybit:UNIFIED" }, orch);
    expect(result.holdings).toHaveLength(2);
    expect(result.holdings.every((h) => h.accountId === "bybit:UNIFIED")).toBe(true);
  });

  test("asset_class filter excludes other classes", async () => {
    const result = await executeGetHoldings({ asset_class: "prediction" }, orch);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]!.symbol).toBe("trump-2024:Yes");
  });

  test("account_id + asset_class can both apply", async () => {
    const result = await executeGetHoldings(
      { account_id: "bybit:UNIFIED", asset_class: "crypto" },
      orch
    );
    expect(result.holdings).toHaveLength(2);
    expect(result.holdings.every((h) => h.assetClass === "crypto")).toBe(true);
  });

  test("returns ISO 8601 timestamps for fetchedAt (not epoch ms)", async () => {
    const result = await executeGetHoldings({}, orch);
    for (const h of result.holdings) {
      expect(h.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });
});
