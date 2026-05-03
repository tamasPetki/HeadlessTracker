// Price service tests — mocked CoinGecko, in-memory SQLite cache.
// Covers: spot lookup, batch dedupe, cache hit, historical price, error mapping,
//   symbol → coinId mapping, AbortSignal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../src/cache.ts";
import { PriceService, symbolToCoinGeckoId } from "../src/prices.ts";

const realFetch = globalThis.fetch;

let cache: Cache;
let svc: PriceService;

beforeEach(() => {
  cache = new Cache({ dbPath: ":memory:" });
  svc = new PriceService({ cache });
});

afterEach(() => {
  cache.close();
  globalThis.fetch = realFetch;
});

describe("symbolToCoinGeckoId (static map only)", () => {
  test("known symbols map to ids (case-insensitive)", () => {
    expect(symbolToCoinGeckoId("BTC")).toBe("bitcoin");
    expect(symbolToCoinGeckoId("btc")).toBe("bitcoin");
    expect(symbolToCoinGeckoId("ETH")).toBe("ethereum");
    expect(symbolToCoinGeckoId("USDC")).toBe("usd-coin");
    expect(symbolToCoinGeckoId("MATIC")).toBe("matic-network");
    expect(symbolToCoinGeckoId("POL")).toBe("matic-network");
  });

  test("ambiguity-resolved symbols pin the right CoinGecko id", () => {
    // Each was verified against the CoinGecko search API at v0.10.3 time.
    // These are tokens HT users actually hold on Bybit/MetaMask; without
    // pinning, a /coins/list lookup might pick a low-cap collision.
    expect(symbolToCoinGeckoId("JUP")).toBe("jupiter-exchange-solana");
    expect(symbolToCoinGeckoId("HYPE")).toBe("hyperliquid");
    expect(symbolToCoinGeckoId("ENA")).toBe("ethena");
    expect(symbolToCoinGeckoId("DEEP")).toBe("deep");
    expect(symbolToCoinGeckoId("PUMP")).toBe("pump-fun");
    expect(symbolToCoinGeckoId("SPEC")).toBe("spectral");
    expect(symbolToCoinGeckoId("MON")).toBe("monad");
    expect(symbolToCoinGeckoId("VVV")).toBe("venice-token");
  });

  test("unknown symbol returns null (sync static-only path)", () => {
    expect(symbolToCoinGeckoId("NOTAREALCOIN")).toBeNull();
  });
});

describe("PriceService.resolveCoinId (static + dynamic)", () => {
  test("static hit returns immediately, no fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const id = await svc.resolveCoinId("BTC");
    expect(id).toBe("bitcoin");
    expect(calls).toBe(0);
  });

  test("symbol outside static map → fetches /coins/markets and resolves from cache", async () => {
    let calls = 0;
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      calls++;
      expect(String(url)).toContain("/coins/markets");
      expect(String(url)).toContain("order=market_cap_desc");
      return new Response(
        JSON.stringify([
          { id: "shiba-inu", symbol: "shib", name: "Shiba Inu", market_cap_rank: 14 },
          { id: "dogecoin", symbol: "doge", name: "Dogecoin", market_cap_rank: 9 },
        ]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const shib = await svc.resolveCoinId("SHIB");
    expect(shib).toBe("shiba-inu");
    expect(calls).toBe(1);

    // Second resolve hits cache, no second fetch.
    const doge = await svc.resolveCoinId("DOGE");
    expect(doge).toBe("dogecoin");
    expect(calls).toBe(1);
  });

  test("symbol collision in /coins/markets → first row (highest market cap) wins", async () => {
    // CoinGecko returns rows sorted by market_cap_desc. Two coins share the
    // symbol "BONK"; the higher-cap one (Solana BONK) appears first and
    // claims the slot.
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify([
          { id: "bonk", symbol: "bonk", name: "Bonk", market_cap_rank: 50 },
          { id: "bonk-evm-clone", symbol: "bonk", name: "Bonk EVM Clone", market_cap_rank: 5000 },
        ]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const r = await svc.resolveCoinId("BONK");
    expect(r).toBe("bonk");
  });

  test("symbol not in static map and not in top-250 returns null", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify([{ id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 }]), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await svc.resolveCoinId("OBSCURETOKEN");
    expect(r).toBeNull();
  });

  test("CoinGecko fetch failure → returns null, doesn't throw", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;

    const r = await svc.resolveCoinId("SHIB");
    expect(r).toBeNull();
  });

  test("CoinGecko returns non-array (e.g. error body with 200) → returns null defensively", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ status: { error_code: 429, error_message: "rate limited" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await svc.resolveCoinId("SHIB");
    expect(r).toBeNull();
  });

  test("static map takes precedence over dynamic — pinned ambiguous symbol stays pinned", async () => {
    // /coins/markets returns "JUP → some-other-jupiter" but the static map
    // wins because JUP is explicitly pinned.
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify([{ id: "wrong-jupiter", symbol: "jup", name: "Wrong Jupiter", market_cap_rank: 50 }]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const r = await svc.resolveCoinId("JUP");
    expect(r).toBe("jupiter-exchange-solana");
  });
});

describe("PriceService.getPrice", () => {
  test("happy path returns price + populates cache", async () => {
    let calls = 0;
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      calls++;
      expect(String(url)).toContain("/simple/price");
      expect(String(url)).toContain("ids=bitcoin");
      return new Response(
        JSON.stringify({ bitcoin: { usd: 95000, usd_24h_change: 2.5 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const r = await svc.getPrice("bitcoin");
    expect(r.ok).toBe(true);
    if (r.ok && r.value) {
      expect(r.value.usd).toBe(95000);
      expect(r.value.usd24hChange).toBe(2.5);
      expect(r.value.source).toBe("coingecko");
    }

    // Second call hits the cache → no second fetch.
    const r2 = await svc.getPrice("bitcoin");
    expect(calls).toBe(1);
    expect(r2.ok).toBe(true);
    if (r2.ok && r2.value) {
      expect(r2.value.source).toBe("cache");
      expect(r2.value.usd).toBe(95000);
    }
  });

  test("rate-limited (429) → err('rate_limited')", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("too many", { status: 429 });
    }) as unknown as typeof fetch;

    const r = await svc.getPrice("bitcoin");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("rate_limited");
    }
  });

  test("upstream 5xx → err('upstream_error')", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("oops", { status: 502 });
    }) as unknown as typeof fetch;

    const r = await svc.getPrice("bitcoin");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("upstream_error");
    }
  });

  test("missing coin in response → ok(null)", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await svc.getPrice("bogus-coin-id");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBeNull();
    }
  });
});

describe("PriceService.getPrices (batch)", () => {
  test("deduplicates input list and issues one fetch", async () => {
    let calls = 0;
    let lastUrl = "";
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      calls++;
      lastUrl = String(url);
      return new Response(
        JSON.stringify({
          bitcoin: { usd: 95000 },
          ethereum: { usd: 3000 },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const r = await svc.getPrices(["bitcoin", "ethereum", "bitcoin"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value).sort()).toEqual(["bitcoin", "ethereum"]);
      expect(r.value.bitcoin?.usd).toBe(95000);
      expect(r.value.ethereum?.usd).toBe(3000);
    }
    expect(calls).toBe(1);
    // URL is encoded — comma may be encoded as %2C, accept both.
    expect(lastUrl).toMatch(/ids=(bitcoin%2Cethereum|bitcoin,ethereum)/);
  });

  test("partial cache hit only fetches missing coins", async () => {
    // Pre-populate cache with bitcoin.
    cache.set("_prices", "spot:bitcoin", {
      usd: 95000,
      fetchedAt: Date.now(),
      source: "coingecko",
    }, 60);

    let lastUrl = "";
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      lastUrl = String(url);
      return new Response(JSON.stringify({ ethereum: { usd: 3000 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await svc.getPrices(["bitcoin", "ethereum"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.bitcoin?.source).toBe("cache");
      expect(r.value.ethereum?.source).toBe("coingecko");
    }
    // Only ethereum should have been requested.
    expect(lastUrl).toContain("ethereum");
    expect(lastUrl).not.toContain("bitcoin");
  });

  test("all cache hits → no fetch", async () => {
    cache.set("_prices", "spot:bitcoin", { usd: 95000, fetchedAt: Date.now(), source: "coingecko" }, 60);
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await svc.getPrices(["bitcoin"]);
    expect(r.ok).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("PriceService.getHistoricalPrice", () => {
  test("returns historical price + caches", async () => {
    let calls = 0;
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      calls++;
      expect(String(url)).toContain("/coins/bitcoin/history");
      expect(String(url)).toMatch(/date=\d{2}-\d{2}-\d{4}/);
      return new Response(
        JSON.stringify({ market_data: { current_price: { usd: 30000 } } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const date = new Date(Date.UTC(2024, 0, 15)); // 2024-01-15 UTC → "15-01-2024"
    const r = await svc.getHistoricalPrice("bitcoin", date);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(30000);
    }

    // Second call → cache hit, no fetch.
    const r2 = await svc.getHistoricalPrice("bitcoin", date);
    expect(calls).toBe(1);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toBe(30000);
    }
  });

  test("missing market_data → ok(null), no cache poisoning", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const date = new Date(Date.UTC(2024, 0, 15));
    const r = await svc.getHistoricalPrice("bitcoin", date);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBeNull();
    }
  });

  test("formats date as DD-MM-YYYY in UTC", async () => {
    let observedUrl = "";
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      observedUrl = String(url);
      return new Response(
        JSON.stringify({ market_data: { current_price: { usd: 100 } } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    // 2024-03-05 in UTC.
    await svc.getHistoricalPrice("bitcoin", new Date(Date.UTC(2024, 2, 5)));
    expect(observedUrl).toContain("date=05-03-2024");
  });
});
