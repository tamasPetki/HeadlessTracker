// Polymarket connector tests — covers credential validation + mocked fetch
// for happy path, schema mismatch, and rate-limit response handling.

import { afterEach, describe, expect, test } from "bun:test";
import { PolymarketConnector } from "../../src/connectors/polymarket.ts";

describe("PolymarketConnector.validateCredentials shape check", () => {
  test("rejects credentials missing proxyWallet", async () => {
    const c = new PolymarketConnector();
    const result = await c.validateCredentials({});
    expect(result.ok).toBe(false);
  });

  test("rejects malformed proxyWallet", async () => {
    const c = new PolymarketConnector();
    const result = await c.validateCredentials({ proxyWallet: "not-an-address" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema_mismatch");
  });
});

describe("PolymarketConnector identity", () => {
  test("connector identity is stable", () => {
    const c = new PolymarketConnector();
    expect(c.id).toBe("polymarket");
    expect(c.defaultCacheTtlSec).toBe(30);
    expect(c.displayName).toContain("Polymarket");
  });

});

describe("PolymarketConnector.fetchTransactions (mocked /trades)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function makeTrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      proxyWallet: "0xabc",
      side: "BUY",
      asset: "12345",
      conditionId: "0xcond1",
      size: 10,
      price: 0.5,
      timestamp: 1700000000,
      title: "Will X happen?",
      slug: "x-happen",
      outcome: "Yes",
      outcomeIndex: 0,
      transactionHash: "0xhash1",
      ...overrides,
    };
  }

  test("maps /trades response to Transaction[] with correct shape", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify([
          makeTrade({ side: "BUY", size: 10, price: 0.5, timestamp: 1700000200, transactionHash: "0xa" }),
          makeTrade({ side: "SELL", size: 5, price: 0.6, timestamp: 1700000100, transactionHash: "0xb", outcome: "No", outcomeIndex: 1 }),
        ]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchTransactions({
      account: { id: "polymarket:0xabc", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      const buy = result.value[0]!;
      expect(buy.type).toBe("buy");
      expect(buy.symbol).toBe("x-happen:Yes");
      expect(buy.quantity).toBe(10);
      expect(buy.price).toBe(0.5);
      // Polymarket gives epoch SECONDS — connector converts to ms.
      expect(buy.timestamp).toBe(1700000200 * 1000);
      // txId disambiguates by conditionId so multi-market txs don't collide.
      expect(buy.txId).toBe("polymarket:0xa:0xcond1");
      const sell = result.value[1]!;
      expect(sell.type).toBe("sell");
      expect(sell.symbol).toBe("x-happen:No");
    }
  });

  test("client-side `since` filter drops trades older than cutoff", async () => {
    // Data-api ignores time-bound query params, so we filter client-side. Confirm
    // that older trades surfaced by the API are filtered before reaching the orchestrator.
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify([
          makeTrade({ timestamp: 1700000300, transactionHash: "0xnew" }),
          makeTrade({ timestamp: 1700000100, transactionHash: "0xold" }),
        ]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    // since = 1700000200 (seconds) → in milliseconds = 1700000200000
    const result = await conn.fetchTransactions(
      {
        account: { id: "polymarket:0xabc", connectorId: "polymarket", label: "p", createdAt: 1 },
        credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
      },
      1700000200 * 1000
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.txId).toContain("0xnew");
    }
  });

  test("paginates via offset until short page", async () => {
    // PAGE_SIZE = 100 in connector. We return a full page first (= 100 trades),
    // then a short page (= 5 trades) to terminate. Total 105.
    let calls = 0;
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      calls++;
      const url = input.toString();
      const offset = parseInt(new URL(url).searchParams.get("offset") ?? "0", 10);
      if (offset === 0) {
        const page = Array.from({ length: 100 }, (_, i) =>
          makeTrade({ timestamp: 1700000000 + i, transactionHash: `0x${i.toString(16)}` })
        );
        return new Response(JSON.stringify(page), { status: 200 });
      }
      // page 2: 5 entries → triggers "short page → stop" condition.
      const page = Array.from({ length: 5 }, (_, i) =>
        makeTrade({ timestamp: 1699000000 + i, transactionHash: `0xpage2_${i}` })
      );
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchTransactions({
      account: { id: "polymarket:0xabc", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    if (result.ok) expect(result.value).toHaveLength(105);
  });

  test("HTTP 429 from /trades → rate_limited", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("slow down", { status: 429 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchTransactions({
      account: { id: "polymarket:0xabc", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("rate_limited");
  });
});

describe("PolymarketConnector.fetchHoldings (mocked data-api)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("parses positions response into Holdings with rich metadata", async () => {
    const fakePositions = [
      {
        proxyWallet: "0xabc",
        asset: "12345",
        conditionId: "0xcond1",
        size: 100,
        avgPrice: 0.5,
        initialValue: 50,
        currentValue: 60,
        cashPnl: 10,
        percentPnl: 0.2,
        curPrice: 0.6,
        redeemable: false,
        mergeable: false,
        title: "Will X happen?",
        slug: "x-happen",
        eventId: "ev1",
        eventSlug: "events/ev1",
        outcome: "Yes",
        outcomeIndex: 0,
        endDate: "2026-12-31",
      },
    ];

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify(fakePositions), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchHoldings({
      account: { id: "polymarket:0xabc", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      const h = result.value[0]!;
      expect(h.symbol).toBe("x-happen:Yes");
      expect(h.quantity).toBe(100);
      expect(h.avgCost).toBe(0.5);
      expect(h.currentPrice).toBe(0.6);
      expect(h.value).toBe(60);
      expect(h.assetClass).toBe("prediction");
      const meta = h.metadata as Record<string, unknown>;
      expect(meta.title).toBe("Will X happen?");
      expect(meta.eventId).toBe("ev1");
      expect(meta.cashPnl).toBe(10);
      expect(meta.outcome).toBe("Yes");
    }
  });

  test("empty array response returns ok([])", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchHoldings({
      account: { id: "polymarket:0x1", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  test("non-array JSON response returns schema_mismatch error", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response('{"error":"bad request"}', { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchHoldings({
      account: { id: "polymarket:0x1", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema_mismatch");
  });

  test("HTTP 429 → rate_limited", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchHoldings({
      account: { id: "polymarket:0x1", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("rate_limited");
  });

  test("symbol fallback to conditionId:outcomeIndex when slug missing", async () => {
    const fakePositions = [{
      proxyWallet: "0xabc",
      asset: "12345",
      conditionId: "0xcondX",
      size: 1,
      avgPrice: 0.5,
      initialValue: 1,
      currentValue: 1,
      curPrice: 1,
      title: "no slug",
      slug: "",                    // explicitly empty
      outcome: "Yes",
      outcomeIndex: 1,
    }];
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify(fakePositions), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchHoldings({
      account: { id: "polymarket:0x1", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]!.symbol).toBe("0xcondX:1");
    }
  });

  test("drops settled-loss dust (currentValue below the default $0.01 threshold)", async () => {
    const fakePositions = [
      { proxyWallet: "0xabc", asset: "1", conditionId: "0xreal", size: 50, avgPrice: 0.5,
        initialValue: 25, currentValue: 25, curPrice: 0.5, title: "Real open bet",
        slug: "real-bet", outcome: "Yes", outcomeIndex: 0, redeemable: false },
      // Resolved loss: huge token count, $0 value, still returned by the data-api.
      { proxyWallet: "0xabc", asset: "2", conditionId: "0xlost", size: 3000, avgPrice: 0.3,
        initialValue: 90, currentValue: 0, curPrice: 0, title: "Lost bet",
        slug: "lost-bet", outcome: "No", outcomeIndex: 1, redeemable: true },
      // Sub-cent dust.
      { proxyWallet: "0xabc", asset: "3", conditionId: "0xdust", size: 10, avgPrice: 0.1,
        initialValue: 1, currentValue: 0.004, curPrice: 0.0004, title: "Dust",
        slug: "dust", outcome: "Yes", outcomeIndex: 0, redeemable: true },
    ];
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify(fakePositions), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchHoldings({
      account: { id: "polymarket:0xabc", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.symbol).toBe("real-bet:Yes");
      expect(result.value[0]!.value).toBe(25);
    }
  });

  test("dustThresholdUsd is user-tuneable (raising it drops more positions)", async () => {
    const fakePositions = [
      { proxyWallet: "0xabc", asset: "1", conditionId: "0xbig", size: 50, avgPrice: 0.5,
        initialValue: 25, currentValue: 25, curPrice: 0.5, title: "Big", slug: "big",
        outcome: "Yes", outcomeIndex: 0 },
      { proxyWallet: "0xabc", asset: "2", conditionId: "0xsmall", size: 1, avgPrice: 0.5,
        initialValue: 0.5, currentValue: 0.5, curPrice: 0.5, title: "Small", slug: "small",
        outcome: "Yes", outcomeIndex: 0 },
    ];
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify(fakePositions), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new PolymarketConnector();
    const result = await conn.fetchHoldings({
      account: { id: "polymarket:0xabc", connectorId: "polymarket", label: "p", createdAt: 1 },
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12", dustThresholdUsd: 1 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.symbol).toBe("big:Yes");
    }
  });
});
