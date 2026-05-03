// Binance connector tests — credential validation + mocked-fetch integration
// to exercise spot balances, batch ticker, soft-skip-on-futures-401 path.

import { afterEach, describe, expect, test } from "bun:test";
import { BinanceConnector } from "../../src/connectors/binance.ts";
import type { Account } from "../../src/types.ts";

describe("BinanceConnector identity", () => {
  test("connector identity is stable", () => {
    const c = new BinanceConnector();
    expect(c.id).toBe("binance");
    expect(c.defaultCacheTtlSec).toBe(120);
    expect(c.displayName).toContain("Binance");
  });
});

describe("BinanceConnector.validateCredentials", () => {
  test("rejects missing apiKey", async () => {
    const c = new BinanceConnector();
    const r = await c.validateCredentials({ apiSecret: "s" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("schema_mismatch");
  });

  test("rejects missing apiSecret", async () => {
    const c = new BinanceConnector();
    const r = await c.validateCredentials({ apiKey: "k" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("schema_mismatch");
  });

  test("accepts valid creds when account endpoint returns 200", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ balances: [], canTrade: true, canWithdraw: false, accountType: "SPOT" }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    try {
      const c = new BinanceConnector();
      const r = await c.validateCredentials({ apiKey: "k", apiSecret: "s" });
      expect(r.ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("maps HTTP 401 → auth_failed", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ code: -2014, msg: "API-key format invalid." }),
        { status: 401 }
      );
    }) as unknown as typeof fetch;
    try {
      const c = new BinanceConnector();
      const r = await c.validateCredentials({ apiKey: "bad", apiSecret: "s" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("auth_failed");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("maps HTTP 429 → rate_limited", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ code: -1003, msg: "Too many requests" }),
        { status: 429 }
      );
    }) as unknown as typeof fetch;
    try {
      const c = new BinanceConnector();
      const r = await c.validateCredentials({ apiKey: "k", apiSecret: "s" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("rate_limited");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("BinanceConnector.fetchHoldings (mocked Binance API)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns BTC + USDT holdings with batch ticker pricing", async () => {
    let accountCalls = 0;
    let tickerCalls = 0;
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/v3/account")) {
        accountCalls++;
        return new Response(
          JSON.stringify({
            balances: [
              { asset: "BTC", free: "0.5", locked: "0" },
              { asset: "USDT", free: "1000", locked: "0" },
              { asset: "ZERO", free: "0", locked: "0" },
            ],
            canTrade: true,
            canWithdraw: false,
            accountType: "SPOT",
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        tickerCalls++;
        return new Response(
          JSON.stringify([
            { symbol: "BTCUSDT", lastPrice: "60000", priceChangePercent: "1.5" },
          ]),
          { status: 200 }
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const conn = new BinanceConnector();
    const account: Account = {
      id: "binance:key-abc",
      connectorId: "binance",
      label: "Test Binance",
      createdAt: 1,
    };
    const r = await conn.fetchHoldings({
      account,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    expect(r.ok).toBe(true);
    expect(accountCalls).toBe(1);
    expect(tickerCalls).toBe(1);
    if (!r.ok) return;

    const symbols = r.value.map((h) => h.symbol).sort();
    expect(symbols).toEqual(["BTC", "USDT"]);

    const btc = r.value.find((h) => h.symbol === "BTC")!;
    expect(btc.quantity).toBe(0.5);
    expect(btc.currentPrice).toBe(60000);
    expect(btc.value).toBe(30000);
    expect(btc.metadata?.accountType).toBe("SPOT");
    expect(btc.metadata?.priceChange24h).toBe(1.5);

    const usdt = r.value.find((h) => h.symbol === "USDT")!;
    // Stablecoin → priced at $1, no API call needed
    expect(usdt.quantity).toBe(1000);
    expect(usdt.currentPrice).toBe(1);
    expect(usdt.value).toBe(1000);
  });

  test("missing ticker price → currentPrice undefined (honest unknown)", async () => {
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/v3/account")) {
        return new Response(
          JSON.stringify({
            balances: [{ asset: "WEIRDCOIN", free: "100", locked: "0" }],
            canTrade: true,
            canWithdraw: false,
            accountType: "SPOT",
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        // Empty array: no WEIRDCOINUSDT pair exists.
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const conn = new BinanceConnector();
    const r = await conn.fetchHoldings({
      account: { id: "binance:k", connectorId: "binance", label: "x", createdAt: 1 },
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    const h = r.value[0]!;
    expect(h.symbol).toBe("WEIRDCOIN");
    expect(h.quantity).toBe(100);
    expect(h.currentPrice).toBeUndefined();
    expect(h.value).toBeUndefined();
  });

  test("includeFutures + futures auth_failed → soft skip with warning, spot still returned", async () => {
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/v3/account")) {
        return new Response(
          JSON.stringify({
            balances: [{ asset: "BTC", free: "1", locked: "0" }],
            canTrade: true,
            canWithdraw: false,
            accountType: "SPOT",
          }),
          { status: 200 }
        );
      }
      if (url.includes("/fapi/v2/account")) {
        return new Response(
          JSON.stringify({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }),
          { status: 401 }
        );
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        return new Response(
          JSON.stringify([{ symbol: "BTCUSDT", lastPrice: "60000", priceChangePercent: "0" }]),
          { status: 200 }
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const conn = new BinanceConnector();
    const r = await conn.fetchHoldings({
      account: { id: "binance:k", connectorId: "binance", label: "x", createdAt: 1 },
      credentials: { apiKey: "k", apiSecret: "s", includeFutures: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1); // BTC spot only
    const btc = r.value[0]!;
    expect(btc.symbol).toBe("BTC");
    // Soft-skip warning surfaces in metadata of first holding
    const warnings = btc.metadata?.__chainWarnings as string[] | undefined;
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings![0]).toContain("Futures soft-skipped");
  });

  test("includeFutures: futures wallet + open positions surface as separate holdings", async () => {
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/v3/account")) {
        return new Response(
          JSON.stringify({
            balances: [{ asset: "USDT", free: "100", locked: "0" }],
            canTrade: true,
            canWithdraw: false,
            accountType: "SPOT",
          }),
          { status: 200 }
        );
      }
      if (url.includes("/fapi/v2/account")) {
        return new Response(
          JSON.stringify({
            totalWalletBalance: "500",
            totalUnrealizedProfit: "10",
            assets: [
              { asset: "USDT", walletBalance: "500", unrealizedProfit: "10", marginBalance: "510", availableBalance: "490" },
            ],
            positions: [
              {
                symbol: "BTCUSDT",
                positionAmt: "0.1",
                entryPrice: "55000",
                markPrice: "60000",
                unRealizedProfit: "500",
                leverage: "10",
                marginType: "cross",
                liquidationPrice: "30000",
                notional: "6000",
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        // No non-stable assets in spot; assetsNeedingPrice empty for spot. But
        // futures USDT is also stable. So this might not even be called.
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const conn = new BinanceConnector();
    const r = await conn.fetchHoldings({
      account: { id: "binance:k", connectorId: "binance", label: "x", createdAt: 1 },
      credentials: { apiKey: "k", apiSecret: "s", includeFutures: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 3 holdings: SPOT USDT, FUTURES_WALLET USDT, FUTURES_POSITION BTCUSDT
    expect(r.value).toHaveLength(3);
    const types = r.value.map((h) => h.metadata?.accountType).sort();
    expect(types).toEqual(["FUTURES_POSITION", "FUTURES_WALLET", "SPOT"]);

    const pos = r.value.find((h) => h.metadata?.accountType === "FUTURES_POSITION")!;
    expect(pos.symbol).toBe("BTCUSDT");
    expect(pos.quantity).toBe(0.1);
    expect(pos.currentPrice).toBe(60000);
    expect(pos.value).toBe(6000);
    expect(pos.metadata?.side).toBe("LONG");
    expect(pos.metadata?.unrealizedPnl).toBe(500);
    expect(pos.metadata?.leverage).toBe(10);
  });

  test("HTTP 429 on spot bubbles up as rate_limited (no fallback data)", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ code: -1003, msg: "Way too many" }), { status: 429 });
    }) as unknown as typeof fetch;

    const conn = new BinanceConnector();
    const r = await conn.fetchHoldings({
      account: { id: "binance:k", connectorId: "binance", label: "x", createdAt: 1 },
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("rate_limited");
  });

  test("returns ok([]) for fully empty account", async () => {
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/v3/account")) {
        return new Response(
          JSON.stringify({ balances: [], canTrade: true, canWithdraw: false, accountType: "SPOT" }),
          { status: 200 }
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const conn = new BinanceConnector();
    const r = await conn.fetchHoldings({
      account: { id: "binance:k", connectorId: "binance", label: "x", createdAt: 1 },
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});

describe("BinanceConnector.fetchTransactions", () => {
  test("returns ok([]) — Binance tx history deferred", async () => {
    const conn = new BinanceConnector();
    const r = await conn.fetchTransactions({
      account: { id: "binance:k", connectorId: "binance", label: "x", createdAt: 1 },
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});
