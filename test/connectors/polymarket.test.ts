// Polymarket connector tests — covers credential validation + mocked fetch
// for happy path, schema mismatch, and rate-limit response handling.

import { afterEach, describe, expect, test } from "bun:test";
import { PolymarketConnector } from "../../src/connectors/polymarket.ts";
import type { Account } from "../../src/types.ts";

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

  test("fetchTransactions is V0-stub returning ok([])", async () => {
    const c = new PolymarketConnector();
    const account: Account = { id: "polymarket:0x1", connectorId: "polymarket", label: "p", createdAt: 1 };
    const result = await c.fetchTransactions({
      account,
      credentials: { proxyWallet: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
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
});
