import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../../src/accounts.ts";
import { Cache } from "../../../src/cache.ts";
import { Orchestrator } from "../../../src/mcp/orchestrator.ts";
import { executeGetPnl } from "../../../src/mcp/tools/get_pnl.ts";
import { PriceService } from "../../../src/prices.ts";
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

function setupAccount(id: string, connectorId: "bybit" | "metamask" | "polymarket" | "hyperliquid"): void {
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

  test("timeframe='7d' echoes back as timeframeRequested + functional note", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: { bybit: new StubConnector({ id: "bybit", holdingsResult: ok([]) }) },
    });

    const result7d = await executeGetPnl({ timeframe: "7d" }, orch);
    expect(result7d.timeframeRequested).toBe("7d");
    expect(result7d.timeframeNote).toContain("'7d'");
    expect(result7d.timeframeNote).toContain("historical prices");

    const resultAll = await executeGetPnl({ timeframe: "all" }, orch);
    expect(resultAll.timeframeNote).toContain("Point-in-time");
    expect(resultAll.total.windowDelta).toBeNull();
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

  test("Polymarket account: cashPnl is NOT included in default-mode realizedPnl (v0.8 #5 change)", async () => {
    // Pre-v0.8 #5: cashPnl was added to realizedPnl, but cashPnl mixes
    // realized + unrealized. That was inflating the "realized" number.
    // New behavior: default mode → realizedPnl is null for Polymarket;
    // notes tell the LLM to use include_history=true for the real number.
    setupAccount("polymarket:0xabc", "polymarket");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        polymarket: new StubConnector({
          id: "polymarket",
          holdingsResult: ok([
            // metadata.cashPnl present — must be IGNORED for realizedPnl now.
            makeHolding({
              accountId: "polymarket:0xabc",
              symbol: "trump-2024:Yes",
              assetClass: "prediction",
              quantity: 100,
              value: 60,
              metadata: { eventSlug: "trump-2024", outcome: "Yes", cashPnl: 999 },
            }),
          ]),
        }),
      },
    });

    const result = await executeGetPnl({}, orch);
    const account = result.byAccount[0]!;
    // The 999 cashPnl is intentionally excluded.
    expect(account.realizedPnl).toBeNull();
    expect(account.notes.join(" ")).toContain("include_history=true");
  });

  test("Polymarket account with include_history=true: realizedPnl computed from /trades FIFO", async () => {
    // BUY 100 trump-2024:Yes @ 0.50, SELL 100 @ 0.80 → realized $30.
    // The cashPnl value (which would have been wrong) is ignored entirely.
    setupAccount("polymarket:0xabc", "polymarket");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        polymarket: new StubConnector({
          id: "polymarket",
          holdingsResult: ok([
            makeHolding({
              accountId: "polymarket:0xabc",
              symbol: "trump-2024:Yes",
              assetClass: "prediction",
              quantity: 0,
              value: 0,
              metadata: { eventSlug: "trump-2024", outcome: "Yes", cashPnl: 999 },
            }),
          ]),
          transactionsResult: ok([
            { accountId: "polymarket:0xabc", txId: "buy1", type: "buy", symbol: "trump-2024:Yes", quantity: 100, price: 0.50, timestamp: 1000 },
            { accountId: "polymarket:0xabc", txId: "sell1", type: "sell", symbol: "trump-2024:Yes", quantity: 100, price: 0.80, timestamp: 2000 },
          ]),
        }),
      },
    });

    const result = await executeGetPnl({ include_history: true }, orch);
    const account = result.byAccount[0]!;
    // FIFO realized: 100 × (0.80 - 0.50) = $30.
    expect(account.realizedPnl).toBeCloseTo(30, 6);
    // realizedFromHistory should report the same number.
    expect(account.realizedFromHistory!.knownRealized).toBeCloseTo(30, 6);
    // Notes drop the "null by default" line and add the FIFO confirmation.
    const notesText = account.notes.join(" ");
    expect(notesText).not.toContain("null by default");
    expect(notesText).toContain("FIFO over /trades");
  });

  test("Polymarket FIFO across BUY/SELL sequence (open position + closed portion)", async () => {
    // 2 BUYs at different prices, 1 SELL covering only oldest lot.
    // Tests that a partially-closed position realizes correctly.
    setupAccount("polymarket:0xabc", "polymarket");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        polymarket: new StubConnector({
          id: "polymarket",
          holdingsResult: ok([
            makeHolding({
              accountId: "polymarket:0xabc",
              symbol: "elec-2024:Yes",
              assetClass: "prediction",
              quantity: 50,
              value: 35,
              metadata: { eventSlug: "elec-2024", outcome: "Yes" },
            }),
          ]),
          transactionsResult: ok([
            { accountId: "polymarket:0xabc", txId: "b1", type: "buy", symbol: "elec-2024:Yes", quantity: 100, price: 0.30, timestamp: 1000 },
            { accountId: "polymarket:0xabc", txId: "b2", type: "buy", symbol: "elec-2024:Yes", quantity: 50, price: 0.50, timestamp: 2000 },
            { accountId: "polymarket:0xabc", txId: "s1", type: "sell", symbol: "elec-2024:Yes", quantity: 100, price: 0.70, timestamp: 3000 },
          ]),
        }),
      },
    });

    const result = await executeGetPnl({ include_history: true }, orch);
    const account = result.byAccount[0]!;
    // Sold 100 at 0.70 = proceeds 70. Cost basis FIFO: 100 @ 0.30 = 30.
    // Realized = 70 - 30 = 40. Open lot remaining: 50 @ 0.50.
    expect(account.realizedPnl).toBeCloseTo(40, 6);
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

  test("method='average' uses Average Cost over /trades (different result vs FIFO)", async () => {
    // Two BUYs at 0.30 and 0.50, then SELL of all 150 at 0.70.
    // FIFO: cost=100×0.30 + 50×0.50 = 55. Realized = 105 - 55 = 50.
    // Average: avg=(30+25)/150 = 0.3667. Cost=150×0.3667 = 55. Realized = 50.
    // Same result for full exit. Use a partial exit to differentiate:
    // SELL only 100 — FIFO uses oldest 100 @ 0.30; Average uses avg 0.3667.
    setupAccount("polymarket:0xabc", "polymarket");
    const txs = [
      { accountId: "polymarket:0xabc", txId: "b1", type: "buy" as const, symbol: "X:Yes", quantity: 100, price: 0.30, timestamp: 1000 },
      { accountId: "polymarket:0xabc", txId: "b2", type: "buy" as const, symbol: "X:Yes", quantity: 50, price: 0.50, timestamp: 2000 },
      { accountId: "polymarket:0xabc", txId: "s1", type: "sell" as const, symbol: "X:Yes", quantity: 100, price: 0.70, timestamp: 3000 },
    ];
    const buildOrch = () => new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        polymarket: new StubConnector({
          id: "polymarket",
          holdingsResult: ok([
            makeHolding({
              accountId: "polymarket:0xabc",
              symbol: "X:Yes",
              assetClass: "prediction",
              quantity: 50,
              value: 35,
              metadata: { eventSlug: "X", outcome: "Yes" },
            }),
          ]),
          transactionsResult: ok(txs),
        }),
      },
    });

    const fifoResult = await executeGetPnl({ include_history: true, method: "fifo" }, buildOrch());
    const fifoAccount = fifoResult.byAccount[0]!;
    // FIFO: 100 @ 0.30 cost → realized = 100×0.70 - 100×0.30 = 40.
    expect(fifoAccount.realizedPnl).toBeCloseTo(40, 6);
    expect(fifoResult.costBasisMethod).toBe("fifo");

    // Reset cache so the second orchestrator doesn't hit a stale fetch.
    cache.invalidateAll();

    const avgResult = await executeGetPnl({ include_history: true, method: "average" }, buildOrch());
    const avgAccount = avgResult.byAccount[0]!;
    // Average cost: (100×0.30 + 50×0.50) / 150 = 55/150 ≈ 0.3667.
    // Realized = 100×0.70 - 100×0.3667 ≈ 70 - 36.67 = 33.33.
    expect(avgAccount.realizedPnl).toBeCloseTo(33.333333, 4);
    expect(avgResult.costBasisMethod).toBe("average");
    // Note text mentions Average Cost when method=average.
    expect(avgAccount.notes.join(" ")).toContain("Average Cost");
  });

  test("costBasisMethod is null when include_history=false", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: { bybit: new StubConnector({ id: "bybit", holdingsResult: ok([]) }) },
    });
    const result = await executeGetPnl({}, orch);
    expect(result.costBasisMethod).toBeNull();
  });

  test("default method is fifo when include_history=true and method omitted", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([]),
          transactionsResult: ok([]),
        }),
      },
    });
    const result = await executeGetPnl({ include_history: true }, orch);
    expect(result.costBasisMethod).toBe("fifo");
  });
});

// Currency conversion path. Uses fetch-mocking for the FX endpoints; doesn't
// depend on PriceService since these tests don't set a timeframe (no
// historical price fetches).
describe("executeGetPnl — currency conversion", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("currency='USD' (default) → no FX fetch, no fx meta, USD values unchanged", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    let fetchCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([
            makeHolding({
              accountId: "bybit:UNIFIED",
              symbol: "BTC",
              quantity: 1,
              avgCost: 25000,
              currentPrice: 30000,
              value: 30000,
              metadata: { accountType: "UNIFIED", cumRealisedPnl: "-1000" },
            }),
          ]),
        }),
      },
    });

    const r = await executeGetPnl({}, orch);
    expect(fetchCalls).toBe(0);
    expect(r.currency).toBe("USD");
    expect(r.fx).toBeUndefined();
    expect(r.total.currentValue).toBe(30000);
    expect(r.total.realizedPnl).toBe(-1000);
  });

  test("currency='HUF' converts ALL numeric fields + populates fx meta", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ rates: { EUR: 0.92, GBP: 0.79, HUF: 380 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([
            makeHolding({
              accountId: "bybit:UNIFIED",
              symbol: "BTC",
              quantity: 1,
              avgCost: 25000,
              currentPrice: 30000,
              value: 30000,
              metadata: { accountType: "UNIFIED", cumRealisedPnl: "-1000" },
            }),
          ]),
        }),
      },
    });

    const r = await executeGetPnl({ currency: "HUF" }, orch);
    expect(r.currency).toBe("HUF");
    expect(r.fx).toBeDefined();
    expect(r.fx!.targetCurrency).toBe("HUF");
    expect(r.fx!.rateUsdToTarget).toBe(380);
    // Value: 30000 USD × 380 = 11_400_000 HUF
    expect(r.total.currentValue).toBe(30000 * 380);
    // Cost basis: 1 × 25000 USD × 380 = 9_500_000 HUF
    expect(r.total.costBasis).toBe(25000 * 380);
    // Unrealized: 5000 USD × 380 = 1_900_000 HUF
    expect(r.total.unrealizedPnl).toBe(5000 * 380);
    // Realized: -1000 USD × 380 = -380_000 HUF
    expect(r.total.realizedPnl).toBe(-1000 * 380);
    // Per-account too
    expect(r.byAccount[0]!.currentValue).toBe(30000 * 380);
    expect(r.byAccount[0]!.realizedPnl).toBe(-1000 * 380);
  });

  test("currency='EUR' divides realized PnL by EUR rate", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ rates: { EUR: 0.92, GBP: 0.79, HUF: 380 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 30000, metadata: { accountType: "UNIFIED", cumRealisedPnl: "-1000" } }),
          ]),
        }),
      },
    });

    const r = await executeGetPnl({ currency: "EUR" }, orch);
    expect(r.total.realizedPnl).toBeCloseTo(-1000 * 0.92, 4);
  });

  test("currency='HUF' + include_history=true converts realizedFromHistory.knownRealized too", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ rates: { EUR: 0.92, GBP: 0.79, HUF: 380 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

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

    const r = await executeGetPnl({ include_history: true, currency: "HUF" }, orch);
    // Realized USD = 2.5; HUF = 2.5 × 380 = 950
    expect(r.total.realizedFromHistory!.knownRealized).toBeCloseTo(2.5 * 380, 2);
    expect(r.byAccount[0]!.realizedFromHistory!.knownRealized).toBeCloseTo(2.5 * 380, 2);
  });

  test("FX fallback path still produces a result (source: 'fallback' surfaced)", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    // Both upstream APIs fail → fx module returns hardcoded fallback rates.
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("upstream broken", { status: 502 });
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 30000 })]),
        }),
      },
    });

    const r = await executeGetPnl({ currency: "HUF" }, orch);
    expect(r.fx?.source).toBe("fallback");
    expect(r.total.currentValue).toBe(30000 * 380); // hardcoded HUF fallback rate
  });
});

// Time-windowed delta — uses a real PriceService with fetch mocked, plus a
// fresh in-memory cache per test to keep historical-price cache hits isolated.
describe("executeGetPnl — windowDelta (timeframe-driven)", () => {
  const realFetch = globalThis.fetch;
  let priceCache: Cache;
  let priceSvc: PriceService;

  beforeEach(() => {
    priceCache = new Cache({ dbPath: ":memory:" });
    // rateLimitRetries=0: the existing test cases mock fetch deterministically
    // and don't want to wait through retry backoffs. v0.13.1 added retry-on-429
    // with default 2× 2.5s backoff for prod use.
    priceSvc = new PriceService({ cache: priceCache, rateLimitRetries: 0 });
  });

  afterEach(() => {
    priceCache.close();
    globalThis.fetch = realFetch;
  });

  function mockHistoricalPrice(coinId: string, usd: number): void {
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      const u = String(url);
      if (u.includes(`/coins/${coinId}/history`)) {
        return new Response(
          JSON.stringify({ market_data: { current_price: { usd } } }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("timeframe='all' produces null windowDelta (no fetch)", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    let fetchCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 50000 })]),
        }),
      },
    });

    const r = await executeGetPnl({ timeframe: "all" }, orch, priceSvc);
    expect(r.total.windowDelta).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("no timeframe argument → windowDelta null", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 50000 })]),
        }),
      },
    });
    const r = await executeGetPnl({}, orch, priceSvc);
    expect(r.total.windowDelta).toBeNull();
  });

  test("timeframe='7d' computes delta against historical CoinGecko price", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    // Hold 1 BTC currently worth $50k; 7d ago BTC was at $40k.
    // Delta = 50000 - 40000 = +10000 (+25%).
    mockHistoricalPrice("bitcoin", 40000);
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 50000, currentPrice: 50000 }),
          ]),
        }),
      },
    });

    const r = await executeGetPnl({ timeframe: "7d" }, orch, priceSvc);
    expect(r.total.windowDelta).not.toBeNull();
    const w = r.total.windowDelta!;
    expect(w.timeframe).toBe("7d");
    expect(w.historicalValue).toBe(40000);
    expect(w.currentValueAtSnapshot).toBe(50000);
    expect(w.delta).toBe(10000);
    expect(w.deltaPercent).toBeCloseTo(25, 4);
    expect(w.pricedSymbols).toBe(1);
    expect(w.skippedSymbols).toBe(0);
    expect(r.timeframeNote).toContain("7d");
    expect(r.timeframeNote).not.toContain("INFORMATIONAL");
  });

  test("timeframe='24h' resolves to yesterday UTC", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    let observedDateParam: string | null = null;
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      const u = String(url);
      const m = u.match(/date=(\d{2}-\d{2}-\d{4})/);
      if (m) observedDateParam = m[1] ?? null;
      return new Response(
        JSON.stringify({ market_data: { current_price: { usd: 50000 } } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 50000 })]),
        }),
      },
    });

    await executeGetPnl({ timeframe: "24h" }, orch, priceSvc);
    // Should be yesterday's date in DD-MM-YYYY UTC.
    const now = new Date();
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 24 * 60 * 60 * 1000);
    const dd = String(yesterday.getUTCDate()).padStart(2, "0");
    const mm = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = yesterday.getUTCFullYear();
    const expectedDate: string = `${dd}-${mm}-${yyyy}`;
    expect(observedDateParam as string | null).toBe(expectedDate);
  });

  test("Polymarket holdings get skipped (no CoinGecko mapping for prediction shares)", async () => {
    setupAccount("polymarket:0xabc", "polymarket");
    mockHistoricalPrice("bitcoin", 40000); // unused — no BTC in this portfolio

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        polymarket: new StubConnector({
          id: "polymarket",
          holdingsResult: ok([
            makeHolding({
              accountId: "polymarket:0xabc",
              symbol: "trump-2024:Yes",
              assetClass: "prediction",
              quantity: 100,
              value: 60,
            }),
          ]),
        }),
      },
    });

    const r = await executeGetPnl({ timeframe: "7d" }, orch, priceSvc);
    const w = r.total.windowDelta!;
    expect(w.pricedSymbols).toBe(0);
    expect(w.skippedSymbols).toBe(0); // assetClass !== "crypto" filter happens before reason logging
    expect(w.historicalValue).toBe(0);
    expect(w.delta).toBe(0);
  });

  test("unknown crypto symbol gets skipped with a reason", async () => {
    setupAccount("metamask:0xabc", "metamask");
    mockHistoricalPrice("bitcoin", 40000); // unused

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        metamask: new StubConnector({
          id: "metamask",
          holdingsResult: ok([
            makeHolding({
              accountId: "metamask:0xabc",
              symbol: "OBSCURETOKEN",
              assetClass: "crypto",
              quantity: 100,
              value: 50,
              metadata: { chainId: 1 },
            }),
          ]),
        }),
      },
    });

    const r = await executeGetPnl({ timeframe: "7d" }, orch, priceSvc);
    const w = r.total.windowDelta!;
    expect(w.pricedSymbols).toBe(0);
    expect(w.skippedSymbols).toBe(1);
    expect(w.skippedReasons[0]).toContain("OBSCURETOKEN");
    // Reason text changed in v0.10.3 when dynamic top-250 fallback was added.
    expect(w.skippedReasons[0]).toMatch(/CoinGecko/i);
  });

  test("multiple holdings of same symbol share one historical price fetch", async () => {
    // BTC held in two different accounts. Should only hit the historical
    // endpoint once (PriceService caches by coinId+date).
    setupAccount("bybit:UNIFIED", "bybit");
    setupAccount("metamask:0xabc", "metamask");
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return new Response(
        JSON.stringify({ market_data: { current_price: { usd: 40000 } } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 0.5, value: 25000 })]),
        }),
        metamask: new StubConnector({
          id: "metamask",
          holdingsResult: ok([makeHolding({ accountId: "metamask:0xabc", symbol: "BTC", quantity: 0.3, value: 15000, metadata: { chainId: 1 } })]),
        }),
      },
    });

    const r = await executeGetPnl({ timeframe: "7d" }, orch, priceSvc);
    expect(calls).toBe(1);
    const w = r.total.windowDelta!;
    expect(w.pricedSymbols).toBe(2);
    // Historical: 0.5 × 40000 + 0.3 × 40000 = 32000. Current sum: 40000.
    expect(w.historicalValue).toBe(32000);
    expect(w.currentValueAtSnapshot).toBe(40000);
    expect(w.delta).toBe(8000);
  });

  test("fetch failure for historical price → that holding skipped, not errored", async () => {
    setupAccount("bybit:UNIFIED", "bybit");
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("CoinGecko down", { status: 502 });
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 50000 })]),
        }),
      },
    });

    const r = await executeGetPnl({ timeframe: "7d" }, orch, priceSvc);
    const w = r.total.windowDelta!;
    expect(w.pricedSymbols).toBe(0);
    expect(w.skippedSymbols).toBe(1);
    expect(w.skippedReasons[0]).toContain("historical price unavailable");
    // Result is still well-formed, no thrown error.
    expect(r.total.currentValue).toBe(50000);
  });

  test("rate-limited historical price → skip reason includes the actionable hint", async () => {
    // Regression for the user-reported bug where 13 mainstream coins all
    // failed historical price with the generic "unavailable" message — the
    // root cause was 429s under parallel fan-out. The fix adds retry-on-429
    // (covered in test/prices.test.ts) and surfaces the failure mode in the
    // skip reason so users can act on it.
    setupAccount("bybit:UNIFIED", "bybit");
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Too many requests", { status: 429 });
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 50000 })]),
        }),
      },
    });

    const r = await executeGetPnl({ timeframe: "7d" }, orch, priceSvc);
    const w = r.total.windowDelta!;
    expect(w.skippedSymbols).toBe(1);
    expect(w.skippedReasons[0]).toContain("rate limit");
    expect(w.skippedReasons[0]).toContain("COINGECKO_API_KEY");
  });

  test("computeWindowDelta limits concurrency on historical price fan-out", async () => {
    // Regression for the parallel-429 bug. Verifies that with 6 coins to
    // price, the historical fetcher does NOT fire all 6 at once. Concurrency
    // cap is 3 → max in-flight at any moment is 3.
    setupAccount("bybit:UNIFIED", "bybit");

    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      const u = String(url);
      if (u.includes("/coins/") && u.includes("/history")) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield to the event loop so concurrent calls can race the counter.
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response(
          JSON.stringify({ market_data: { current_price: { usd: 100 } } }),
          { status: 200 }
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 1, value: 50000 }),
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "ETH", quantity: 1, value: 3000 }),
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "SOL", quantity: 1, value: 100 }),
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "XRP", quantity: 1, value: 1 }),
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "BNB", quantity: 1, value: 600 }),
            makeHolding({ accountId: "bybit:UNIFIED", symbol: "NEAR", quantity: 1, value: 5 }),
          ]),
        }),
      },
    });

    const r = await executeGetPnl({ timeframe: "7d" }, orch, priceSvc);
    expect(r.total.windowDelta!.pricedSymbols).toBe(6);
    // Concurrency limit is 3 in computeWindowDelta. Allow ≤3 to avoid being
    // brittle to scheduler micro-timing.
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  test("Hyperliquid: realized PnL sums fills' closedPnl, NOT spot FIFO (no orphan cascade)", async () => {
    const acct = "hyperliquid:0xabc";
    setupAccount(acct, "hyperliquid");
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: {
        hyperliquid: new StubConnector({
          id: "hyperliquid",
          holdingsResult: ok([
            makeHolding({ accountId: acct, symbol: "USDC", assetClass: "cash", quantity: 10000, currentPrice: 1, value: 10000, metadata: { venue: "hyperliquid", kind: "perp-account-equity" } }),
            makeHolding({ accountId: acct, symbol: "BTC", assetClass: "crypto", quantity: -2.5, value: undefined, metadata: { venue: "hyperliquid", kind: "perp-position", side: "short", unrealizedPnl: 1200 } }),
          ]),
          transactionsResult: ok([
            { accountId: acct, txId: "hyperliquid:0xa:1", type: "sell", symbol: "BTC", quantity: 1, price: 64000, valueCurrency: "USD", timestamp: 1000, metadata: { venue: "hyperliquid", closedPnl: -50 } },
            { accountId: acct, txId: "hyperliquid:0xb:2", type: "buy", symbol: "BTC", quantity: 0.5, price: 65000, valueCurrency: "USD", timestamp: 2000, metadata: { venue: "hyperliquid", closedPnl: 300 } },
          ]),
        }),
      },
    });

    const r = await executeGetPnl({ account_id: acct, include_history: true }, orch);
    const a = r.byAccount.find((x) => x.accountId === acct)!;
    // Realized = sum of closedPnl (300 + -50 = 250), NOT a FIFO-derived number.
    expect(a.realizedPnl).toBeCloseTo(250, 6);
    // The whole point: running spot FIFO over perp fills would manufacture an
    // orphan/unknown-sale cascade. That must NOT happen.
    expect(a.realizedFromHistory!.orphanCount).toBe(0);
    expect(a.realizedFromHistory!.unknownSalesCount).toBe(0);
    expect(a.realizedFromHistory!.knownRealized).toBeCloseTo(250, 6);
    expect(a.notes.some((n) => n.includes("closedPnl"))).toBe(true);
    expect(a.notes.some((n) => n.toLowerCase().includes("orphan"))).toBe(false);
  });

  test("Hyperliquid: unrealized PnL summed from open positions' metadata (not 'no cost basis')", async () => {
    const acct = "hyperliquid:0xdef";
    setupAccount(acct, "hyperliquid");
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: {
        hyperliquid: new StubConnector({
          id: "hyperliquid",
          holdingsResult: ok([
            makeHolding({ accountId: acct, symbol: "USDC", assetClass: "cash", quantity: 5000, currentPrice: 1, value: 5000, metadata: { venue: "hyperliquid", kind: "perp-account-equity" } }),
            makeHolding({ accountId: acct, symbol: "BTC", assetClass: "crypto", quantity: -2, value: undefined, metadata: { venue: "hyperliquid", kind: "perp-position", side: "short", unrealizedPnl: 800 } }),
            makeHolding({ accountId: acct, symbol: "SOL", assetClass: "crypto", quantity: 100, value: undefined, metadata: { venue: "hyperliquid", kind: "perp-position", side: "long", unrealizedPnl: -150 } }),
          ]),
        }),
      },
    });

    const r = await executeGetPnl({ account_id: acct }, orch);
    const a = r.byAccount.find((x) => x.accountId === acct)!;
    // Unrealized = sum of open positions' live unrealizedPnl (800 + -150 = 650).
    expect(a.unrealizedPnl).toBeCloseTo(650, 6);
    // The misleading generic "no cost basis" note must be suppressed for HL.
    expect(a.notes.some((n) => n.includes("without cost basis"))).toBe(false);
    // A Hyperliquid-specific note explains the model.
    expect(a.notes.some((n) => n.toLowerCase().includes("hyperliquid"))).toBe(true);
  });
});
