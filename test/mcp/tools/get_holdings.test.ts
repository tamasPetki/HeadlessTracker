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
    expect(result.meta.accountsConfigured).toBe(3);
    expect(result.meta.accountsQueried).toBe(3);
    expect(result.meta.accountsWithErrors).toBe(0);
    expect(result.meta.scope.accountIdFilter).toBeNull();
    expect(result.meta.scope.assetClassFilter).toBeNull();
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("meta.scope reflects active filter (P3 fix)", async () => {
    const result = await executeGetHoldings(
      { account_id: "bybit:UNIFIED", asset_class: "crypto" },
      orch
    );
    expect(result.meta.accountsConfigured).toBe(3);    // total in registry
    expect(result.meta.accountsQueried).toBe(1);       // narrowed by filter
    expect(result.meta.scope.accountIdFilter).toBe("bybit:UNIFIED");
    expect(result.meta.scope.assetClassFilter).toBe("crypto");
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

  test("REGRESSION P2: native multi-chain holding (POL) survives asset_class='crypto' filter", async () => {
    // From burn-in feedback: Tomi observed POL appearing in unfiltered get_holdings
    // but disappearing under (account_id + asset_class:crypto) filter. Possible cause:
    // assetClass field not set consistently for native tokens vs ERC-20.
    // This test pins the expected behavior for both native and ERC-20 holdings on
    // multiple chains.
    cache.close();
    accountStore.close();
    cache = new Cache({ dbPath: ":memory:" });
    accountStore = new AccountStore({ dbPath: ":memory:" });
    vault = new StubVault();
    accountStore.upsert({ id: "metamask:0x9b73", connectorId: "metamask", label: "M", createdAt: 1 });
    vault.set("metamask", "0x9b73", { address: "0x9b73" });

    orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        metamask: new StubConnector({
          id: "metamask",
          holdingsResult: ok([
            // Native ETH on Ethereum
            makeHolding({ accountId: "metamask:0x9b73", symbol: "ETH", assetClass: "crypto", quantity: 1.5, metadata: { chainId: 1, chainName: "Ethereum", native: true } }),
            // Native POL on Polygon
            makeHolding({ accountId: "metamask:0x9b73", symbol: "POL", assetClass: "crypto", quantity: 100, metadata: { chainId: 137, chainName: "Polygon", native: true } }),
            // ERC-20 USDC on Ethereum
            makeHolding({ accountId: "metamask:0x9b73", symbol: "USDC", assetClass: "crypto", quantity: 500, value: 500, currentPrice: 1, metadata: { chainId: 1, contract: "0xabc" } }),
          ]),
        }),
      },
    });

    // Unfiltered call: all 3 holdings should be present.
    const unfiltered = await executeGetHoldings({}, orch);
    expect(unfiltered.holdings).toHaveLength(3);
    const symbols = unfiltered.holdings.map((h) => h.symbol).sort();
    expect(symbols).toEqual(["ETH", "POL", "USDC"]);

    // Account-scoped + asset_class:crypto: ALL 3 should still pass.
    // POL must not be silently dropped because it lacks currentPrice/value.
    const filtered = await executeGetHoldings(
      { account_id: "metamask:0x9b73", asset_class: "crypto" },
      orch
    );
    expect(filtered.holdings).toHaveLength(3);
    const filteredSymbols = filtered.holdings.map((h) => h.symbol).sort();
    expect(filteredSymbols).toEqual(["ETH", "POL", "USDC"]);
    expect(filteredSymbols).toContain("POL");
  });

  test("returns ISO 8601 timestamps for fetchedAt (not epoch ms)", async () => {
    const result = await executeGetHoldings({}, orch);
    for (const h of result.holdings) {
      expect(h.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });
});
