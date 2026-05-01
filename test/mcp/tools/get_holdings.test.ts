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

// Currency conversion path is exercised against the real fetchFxRates() in fx.ts.
// We stub fetch directly so no network is hit and we can simulate fallback behavior.
describe("executeGetHoldings — currency conversion", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("currency='USD' (default) → no FX fetch, no fx meta", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await executeGetHoldings({}, orch);
    expect(fetchCalls).toBe(0);
    expect(result.meta.scope.currency).toBe("USD");
    expect(result.meta.fx).toBeUndefined();
    // Holdings unchanged.
    expect(result.holdings.find((h) => h.symbol === "BTC")?.value).toBe(30000);
  });

  test("currency='HUF' converts USD values + populates meta.fx", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ rates: { EUR: 0.92, GBP: 0.79, HUF: 380 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await executeGetHoldings({ currency: "HUF" }, orch);
    expect(result.meta.scope.currency).toBe("HUF");
    expect(result.meta.fx).toBeDefined();
    expect(result.meta.fx!.targetCurrency).toBe("HUF");
    expect(result.meta.fx!.source).toBe("exchangerate-api");
    expect(result.meta.fx!.rateUsdToTarget).toBe(380);

    const btc = result.holdings.find((h) => h.symbol === "BTC")!;
    expect(btc.value).toBe(30000 * 380);
    expect(btc.valueCurrency).toBe("HUF");
  });

  test("currency='EUR' divides USD by EUR rate (1 USD = 0.92 EUR)", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ rates: { EUR: 0.92, GBP: 0.79, HUF: 380 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await executeGetHoldings({ currency: "EUR" }, orch);
    const btc = result.holdings.find((h) => h.symbol === "BTC")!;
    expect(btc.value).toBeCloseTo(30000 * 0.92, 4);
    expect(btc.valueCurrency).toBe("EUR");
  });

  test("FX fallback path surfaces a warning", async () => {
    // Both upstream APIs fail → fetchFxRates returns ok({source: 'fallback'}).
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("nope", { status: 502 });
    }) as unknown as typeof fetch;

    const result = await executeGetHoldings({ currency: "HUF" }, orch);
    expect(result.meta.fx?.source).toBe("fallback");
    expect(result.warnings.some((w) => w.includes("static fallback"))).toBe(true);
    // Conversion still happens with fallback rate (380 HUF default).
    const btc = result.holdings.find((h) => h.symbol === "BTC")!;
    expect(btc.value).toBe(30000 * 380);
  });

  test("does NOT mutate cached Holding objects (subsequent USD call returns USD)", async () => {
    // Critical: the currency conversion must happen at response-build time, NOT
    // by mutating the orchestrator's cached Holdings — otherwise the next call
    // would see HUF-tagged values where it expected USD.
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ rates: { EUR: 0.92, GBP: 0.79, HUF: 380 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const hufResult = await executeGetHoldings({ currency: "HUF" }, orch);
    expect(hufResult.holdings.find((h) => h.symbol === "BTC")?.value).toBe(30000 * 380);

    const usdResult = await executeGetHoldings({}, orch);
    expect(usdResult.meta.scope.currency).toBe("USD");
    expect(usdResult.meta.fx).toBeUndefined();
    // Underlying value still the original USD number.
    expect(usdResult.holdings.find((h) => h.symbol === "BTC")?.value).toBe(30000);
    expect(usdResult.holdings.find((h) => h.symbol === "BTC")?.valueCurrency).toBe("USD");
  });
});
