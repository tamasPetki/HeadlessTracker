// Hyperliquid connector tests — credential validation + mocked info-endpoint
// integration exercising the perp-equity-as-cash model, signed perp positions
// (value intentionally omitted to avoid double-counting), spot pricing via
// spotMetaAndAssetCtxs, the dust filter, and fill→transaction mapping.

import { afterEach, describe, expect, test } from "bun:test";
import { HyperliquidConnector } from "../../src/connectors/hyperliquid.ts";
import type { ConnectorContext } from "../../src/connectors/types.ts";
import type { Account } from "../../src/types.ts";

const ADDR = "0x7fdafde5cfb5465924316eced2d3715494c517d1";
const ADDR2 = "0x0d1d9635d0640821d15e323ac8adade2a82d8c41";

function ctxFor(creds: Record<string, unknown>): ConnectorContext {
  const account: Account = {
    id: `hyperliquid:${creds.address ?? "multi"}`,
    connectorId: "hyperliquid",
    label: "test",
    createdAt: 1_700_000_000_000,
  };
  return { account, credentials: creds };
}

// Build a fetch mock that dispatches on the info request `type` field. Each
// handler returns the JSON body for that request type; missing → {} 200.
function mockInfo(handlers: Record<string, unknown>): typeof fetch {
  return (async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const type = body.type as string;
    if (!(type in handlers)) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify(handlers[type]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("HyperliquidConnector identity", () => {
  test("connector identity is stable", () => {
    const c = new HyperliquidConnector();
    expect(c.id).toBe("hyperliquid");
    expect(c.defaultCacheTtlSec).toBe(60);
    expect(c.displayName.toLowerCase()).toContain("hyperliquid");
  });
});

describe("HyperliquidConnector.validateCredentials", () => {
  test("rejects missing address", async () => {
    const c = new HyperliquidConnector();
    const r = await c.validateCredentials({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("schema_mismatch");
  });

  test("rejects malformed (non-0x40hex) address", async () => {
    const c = new HyperliquidConnector();
    const r = await c.validateCredentials({ address: "0xnope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("schema_mismatch");
  });

  test("rejects empty addresses[] list", async () => {
    const c = new HyperliquidConnector();
    const r = await c.validateCredentials({ addresses: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("schema_mismatch");
  });

  test("accepts a valid address (mocked reachability ok)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mockInfo({
      clearinghouseState: { marginSummary: { accountValue: "0.0" }, assetPositions: [] },
    });
    try {
      const c = new HyperliquidConnector();
      const r = await c.validateCredentials({ address: ADDR });
      expect(r.ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("propagates upstream HTTP error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("err", { status: 500 })) as unknown as typeof fetch;
    try {
      const c = new HyperliquidConnector();
      const r = await c.validateCredentials({ address: ADDR });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("upstream_error");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("maps HTTP 429 to rate_limited", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("slow down", { status: 429 })) as unknown as typeof fetch;
    try {
      const c = new HyperliquidConnector();
      const r = await c.validateCredentials({ address: ADDR });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("rate_limited");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("HyperliquidConnector.fetchHoldings", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("perp account equity becomes a single USDC cash holding (value = accountValue)", async () => {
    globalThis.fetch = mockInfo({
      clearinghouseState: {
        marginSummary: { accountValue: "1500.5", totalMarginUsed: "200", totalNtlPos: "3000" },
        withdrawable: "1300.5",
        assetPositions: [],
      },
      spotClearinghouseState: { balances: [] },
    });
    const c = new HyperliquidConnector();
    const r = await c.fetchHoldings(ctxFor({ address: ADDR }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const equity = r.value.find((h) => h.metadata?.kind === "perp-account-equity");
    expect(equity).toBeDefined();
    expect(equity!.symbol).toBe("USDC");
    expect(equity!.assetClass).toBe("cash");
    expect(equity!.value).toBe(1500.5);
    expect(equity!.quantity).toBe(1500.5);
    expect(equity!.metadata?.withdrawable).toBe(1300.5);
  });

  test("open perp position is signed and carries NO value (avoids double-count), rich metadata", async () => {
    globalThis.fetch = mockInfo({
      clearinghouseState: {
        marginSummary: { accountValue: "1000" },
        assetPositions: [
          {
            type: "oneWay",
            position: {
              coin: "BTC",
              szi: "-2.5", // short
              leverage: { type: "cross", value: 20 },
              entryPx: "64000",
              positionValue: "160000",
              unrealizedPnl: "-1200",
              liquidationPx: "90000",
              marginUsed: "8000",
            },
          },
        ],
      },
      spotClearinghouseState: { balances: [] },
    });
    const c = new HyperliquidConnector();
    const r = await c.fetchHoldings(ctxFor({ address: ADDR }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pos = r.value.find((h) => h.metadata?.kind === "perp-position");
    expect(pos).toBeDefined();
    expect(pos!.symbol).toBe("BTC");
    expect(pos!.quantity).toBe(-2.5); // signed: negative = short
    expect(pos!.assetClass).toBe("crypto");
    expect(pos!.value).toBeUndefined(); // notional is NOT net worth
    expect(pos!.currentPrice).toBeCloseTo(160000 / 2.5, 4); // markPx = notional/|szi|
    expect(pos!.metadata?.side).toBe("short");
    expect(pos!.metadata?.unrealizedPnl).toBe(-1200);
    expect(pos!.metadata?.leverage).toBe(20);
  });

  test("spot balances: USDC is cash@1, priced token valued, dust dropped", async () => {
    globalThis.fetch = mockInfo({
      clearinghouseState: { marginSummary: { accountValue: "0.0" }, assetPositions: [] },
      spotClearinghouseState: {
        balances: [
          { coin: "USDC", token: 0, total: "250.0", hold: "0", entryNtl: "0" },
          { coin: "HYPE", token: 150, total: "10", hold: "0", entryNtl: "200" },
          { coin: "DUST", token: 99, total: "1000000", hold: "0", entryNtl: "0" }, // no USDC pair → unpriceable → dropped
        ],
      },
      spotMetaAndAssetCtxs: [
        {},
        [
          { coin: "HYPE/USDC", markPx: "30.0" },
          { coin: "PURR/USDC", markPx: "0.1" },
        ],
      ],
    });
    const c = new HyperliquidConnector();
    const r = await c.fetchHoldings(ctxFor({ address: ADDR }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const spot = r.value.filter((h) => h.metadata?.kind === "spot");
    const usdc = spot.find((h) => h.symbol === "USDC");
    const hype = spot.find((h) => h.symbol === "HYPE");
    const dust = spot.find((h) => h.symbol === "DUST");
    expect(usdc?.assetClass).toBe("cash");
    expect(usdc?.value).toBe(250);
    expect(hype?.assetClass).toBe("crypto");
    expect(hype?.value).toBe(300); // 10 * 30
    expect(dust).toBeUndefined(); // unpriceable non-stable → dust-dropped
  });

  test("empty/unfunded account yields no holdings (not an error)", async () => {
    globalThis.fetch = mockInfo({
      clearinghouseState: { marginSummary: { accountValue: "0.0" }, assetPositions: [] },
      spotClearinghouseState: { balances: [] },
    });
    const c = new HyperliquidConnector();
    const r = await c.fetchHoldings(ctxFor({ address: ADDR }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(0);
  });

  test("multi-address: holdings tagged per address", async () => {
    globalThis.fetch = mockInfo({
      clearinghouseState: { marginSummary: { accountValue: "100" }, assetPositions: [] },
      spotClearinghouseState: { balances: [] },
    });
    const c = new HyperliquidConnector();
    const r = await c.fetchHoldings(ctxFor({ addresses: [ADDR, ADDR2] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const equities = r.value.filter((h) => h.metadata?.kind === "perp-account-equity");
    expect(equities.length).toBe(2);
    const addrs = new Set(equities.map((e) => e.metadata?.address));
    expect(addrs.has(ADDR)).toBe(true);
    expect(addrs.has(ADDR2)).toBe(true);
  });
});

describe("HyperliquidConnector.fetchTransactions", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("maps fills: side B→buy / A→sell, fee + feeToken preserved, since filter applied", async () => {
    globalThis.fetch = mockInfo({
      userFills: [
        { coin: "BTC", px: "65000", sz: "0.1", side: "B", time: 2000, dir: "Open Long", closedPnl: "0", hash: "0xaaa", tid: 1, fee: "-0.5", feeToken: "USDC" },
        { coin: "ETH", px: "3500", sz: "2", side: "A", time: 1000, dir: "Close Long", closedPnl: "10", hash: "0xbbb", tid: 2, fee: "0.3", feeToken: "USDC" },
        { coin: "SOL", px: "150", sz: "5", side: "B", time: 100, dir: "Open Long", closedPnl: "0", hash: "0xccc", tid: 3, fee: "0.1", feeToken: "USDC" }, // before `since` → filtered
      ],
    });
    const c = new HyperliquidConnector();
    const r = await c.fetchTransactions(ctxFor({ address: ADDR }), 500);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(2); // SOL fill (time 100) filtered out by since=500
    const btc = r.value.find((t) => t.symbol === "BTC");
    const eth = r.value.find((t) => t.symbol === "ETH");
    expect(btc?.type).toBe("buy");
    expect(btc?.fee).toBe(-0.5); // maker rebate preserved as negative
    expect(btc?.feeCurrency).toBe("USDC");
    expect(btc?.timestamp).toBe(2000);
    expect(btc?.txId).toContain("0xaaa");
    expect(eth?.type).toBe("sell");
  });

  test("no fills → empty list", async () => {
    globalThis.fetch = mockInfo({ userFills: [] });
    const c = new HyperliquidConnector();
    const r = await c.fetchTransactions(ctxFor({ address: ADDR }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(0);
  });
});
