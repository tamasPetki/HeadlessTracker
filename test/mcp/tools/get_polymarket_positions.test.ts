import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../../src/accounts.ts";
import { Cache } from "../../../src/cache.ts";
import { Orchestrator } from "../../../src/mcp/orchestrator.ts";
import { executeGetPolymarketPositions } from "../../../src/mcp/tools/get_polymarket_positions.ts";
import { ok } from "../../../src/types.ts";
import { StubConnector, StubVault, makeHolding } from "../../helpers/stub-connector.ts";

let cache: Cache;
let accountStore: AccountStore;
let vault: StubVault;
let orch: Orchestrator;

const positionA = makeHolding({
  accountId: "polymarket:0x1",
  symbol: "trump-2024:Yes",
  assetClass: "prediction",
  quantity: 100,
  currentPrice: 0.6,
  value: 60,
  metadata: {
    title: "Will Trump win 2024?",
    slug: "trump-2024",
    eventId: "ev1",
    eventSlug: "election-2024",
    outcome: "Yes",
    outcomeIndex: 0,
    redeemable: false,
    mergeable: false,
    cashPnl: 10,
    endDate: "2024-11-05",
  },
});

const positionB = makeHolding({
  accountId: "polymarket:0x1",
  symbol: "trump-2024:No",
  assetClass: "prediction",
  quantity: 50,
  currentPrice: 0.4,
  value: 20,
  metadata: {
    title: "Will Trump win 2024?",
    slug: "trump-2024-no",
    eventId: "ev1",                          // same event as positionA
    eventSlug: "election-2024",
    outcome: "No",
    redeemable: false,
    mergeable: true,
    cashPnl: -5,
    endDate: "2024-11-05",
  },
});

const positionC = makeHolding({
  accountId: "polymarket:0x1",
  symbol: "seattle-temp:Yes",
  assetClass: "prediction",
  quantity: 12,
  currentPrice: 1,
  value: 12,
  metadata: {
    title: "Seattle temp 54-55F?",
    slug: "seattle-temp",
    eventId: "ev2",
    eventSlug: "weather-march-4",
    outcome: "Yes",
    redeemable: true,
    mergeable: false,
    cashPnl: 12,
    endDate: "2026-03-04",
  },
});

beforeEach(() => {
  cache = new Cache({ dbPath: ":memory:" });
  accountStore = new AccountStore({ dbPath: ":memory:" });
  vault = new StubVault();

  accountStore.upsert({ id: "polymarket:0x1", connectorId: "polymarket", label: "P", createdAt: 1 });
  vault.set("polymarket", "0x1", { proxyWallet: "0x1" });

  orch = new Orchestrator({
    accountStore,
    cache,
    vault: vault as never,
    connectorOverrides: {
      polymarket: new StubConnector({
        id: "polymarket",
        holdingsResult: ok([positionA, positionB, positionC]),
      }),
    },
  });
});

afterEach(() => {
  cache.close();
  accountStore.close();
});

describe("executeGetPolymarketPositions", () => {
  test("default group_by_event=true bundles same-event Yes+No into one group", async () => {
    const result = await executeGetPolymarketPositions({}, orch);
    expect(result.events).toBeDefined();
    expect(result.events).toHaveLength(2);                  // ev1 (2 positions) + ev2 (1 position)
    const ev1 = result.events!.find((e) => e.eventId === "ev1");
    expect(ev1).toBeDefined();
    expect(ev1!.positions).toHaveLength(2);
    expect(ev1!.totalCurrentValue).toBe(80);                // 60 + 20
    expect(ev1!.totalCashPnl).toBe(5);                      // 10 + (-5)
  });

  test("group_by_event=false returns flat positions array", async () => {
    const result = await executeGetPolymarketPositions({ group_by_event: false }, orch);
    expect(result.positions).toBeDefined();
    expect(result.positions).toHaveLength(3);
    expect(result.events).toBeUndefined();
  });

  test("resolved_only=true filters to redeemable positions", async () => {
    const result = await executeGetPolymarketPositions(
      { group_by_event: false, resolved_only: true },
      orch
    );
    expect(result.positions).toHaveLength(1);
    expect(result.positions![0]!.marketTitle).toBe("Seattle temp 54-55F?");
  });

  test("meta totals reflect all positions before grouping", async () => {
    const result = await executeGetPolymarketPositions({}, orch);
    expect(result.meta.totalPositions).toBe(3);
    expect(result.meta.totalCurrentValue).toBe(92);         // 60 + 20 + 12
    expect(result.meta.totalCashPnl).toBe(17);              // 10 + (-5) + 12
    expect(result.meta.redeemableCount).toBe(1);
    expect(result.meta.mergeableCount).toBe(1);
  });

  test("returns empty result when no Polymarket account configured", async () => {
    // Replace orch with one that has no Polymarket account.
    cache.close();
    accountStore.close();
    cache = new Cache({ dbPath: ":memory:" });
    accountStore = new AccountStore({ dbPath: ":memory:" });
    vault = new StubVault();
    accountStore.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    const empty = new Orchestrator({ accountStore, cache, vault: vault as never });

    const result = await executeGetPolymarketPositions({}, empty);
    expect(result.meta.totalPositions).toBe(0);
    expect(result.positions).toEqual([]);
  });
});
