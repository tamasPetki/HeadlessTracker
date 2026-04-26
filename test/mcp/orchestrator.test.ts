// Orchestrator tests — verifies the eng review 4A fixes (parallel + dedup) and
// the cache/vault/connector wiring.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../src/accounts.ts";
import { Cache } from "../../src/cache.ts";
import { Orchestrator } from "../../src/mcp/orchestrator.ts";
import type { Account } from "../../src/types.ts";
import { err, ok } from "../../src/types.ts";
import { StubConnector, StubVault, makeHolding } from "../helpers/stub-connector.ts";

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

function setupAccount(account: Account, creds: Record<string, unknown> = { apiKey: "x" }): void {
  accountStore.upsert(account);
  vault.set(account.connectorId, account.id.slice(account.connectorId.length + 1), creds);
}

describe("Orchestrator", () => {
  test("getHoldings returns aggregated holdings across multiple accounts", async () => {
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    setupAccount({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });

    const bybitStub = new StubConnector({
      id: "bybit",
      holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC", quantity: 0.5 })]),
    });
    const mmStub = new StubConnector({
      id: "metamask",
      holdingsResult: ok([makeHolding({ accountId: "metamask:0xabc", symbol: "ETH", quantity: 2 })]),
    });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: { bybit: bybitStub, metamask: mmStub },
    });

    const result = await orch.getHoldings(undefined);
    expect(result.data).toHaveLength(2);
    expect(result.data.map((h) => h.symbol).sort()).toEqual(["BTC", "ETH"]);
    expect(result.failures).toHaveLength(0);
  });

  test("getHoldings calls multiple connectors in parallel (not sequentially)", async () => {
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    setupAccount({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });
    setupAccount({ id: "polymarket:0xdef", connectorId: "polymarket", label: "P", createdAt: 3 });

    const DELAY = 100;
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({ id: "bybit", delayMs: DELAY, holdingsResult: ok([]) }),
        metamask: new StubConnector({ id: "metamask", delayMs: DELAY, holdingsResult: ok([]) }),
        polymarket: new StubConnector({ id: "polymarket", delayMs: DELAY, holdingsResult: ok([]) }),
      },
    });

    const start = Date.now();
    await orch.getHoldings(undefined);
    const elapsed = Date.now() - start;
    // Sequential would be ~3 × DELAY = 300ms. Parallel should be ~100ms (+ overhead).
    // Generous bound to absorb CI/loop variance.
    expect(elapsed).toBeLessThan(DELAY * 2);
  });

  test("cache hit returns cached value without calling connector again", async () => {
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    const stub = new StubConnector({
      id: "bybit",
      holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC" })]),
    });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: { bybit: stub },
    });

    await orch.getHoldings(undefined);
    await orch.getHoldings(undefined);
    await orch.getHoldings(undefined);
    expect(stub.callCount.holdings).toBe(1);
  });

  test("force=true bypasses cache and re-fetches", async () => {
    // Note: opts.force is a private internal flag, exercised here via refresh().
    // The orchestrator's public force-refresh path is: refresh(connectorId) → next
    // getHoldings call sees no cache and re-fetches.
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    const stub = new StubConnector({ id: "bybit", holdingsResult: ok([]) });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: { bybit: stub },
    });

    await orch.getHoldings(undefined);
    expect(stub.callCount.holdings).toBe(1);
    await orch.getHoldings(undefined);
    expect(stub.callCount.holdings).toBe(1);   // cache hit

    orch.refresh("bybit");                      // explicit invalidation
    await orch.getHoldings(undefined);
    expect(stub.callCount.holdings).toBe(2);   // re-fetched
  });

  test("in-flight Promise dedup: 5 simultaneous calls produce 1 connector call", async () => {
    // Eng review 4A.2 — when MCP host fans out, multiple in-flight requests for
    // the same cache key should share one Promise.
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    const stub = new StubConnector({
      id: "bybit",
      delayMs: 50,                              // long enough for the 5 callers to race
      holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED" })]),
    });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: { bybit: stub },
    });

    // Fire 5 concurrent calls. They should all resolve from the same single fetch.
    const results = await Promise.all([
      orch.getHoldings(undefined),
      orch.getHoldings(undefined),
      orch.getHoldings(undefined),
      orch.getHoldings(undefined),
      orch.getHoldings(undefined),
    ]);
    expect(stub.callCount.holdings).toBe(1);
    for (const r of results) {
      expect(r.data).toHaveLength(1);
    }
  });

  test("partial failure: one account succeeds, another errors — both surface", async () => {
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    setupAccount({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED" })]),
        }),
        metamask: new StubConnector({
          id: "metamask",
          holdingsResult: err("auth_failed", "Etherscan API key invalid"),
        }),
      },
    });

    const result = await orch.getHoldings(undefined);
    expect(result.data).toHaveLength(1);            // bybit succeeded
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.accountId).toBe("metamask:0xabc");
    expect(result.failures[0]!.error).toContain("auth_failed");
  });

  test("falls back to stale (TTL-expired) cache when connector errors out", async () => {
    // Important behavior distinction:
    //   - cache.invalidate() truly DELETES the row → no fallback possible
    //   - TTL expiry leaves the row in place with stale=true → fallback works
    // This test exercises the TTL-stale fallback path explicitly.
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    let callIndex = 0;
    const stub = new StubConnector({
      id: "bybit",
      holdingsResult: () => {
        callIndex++;
        if (callIndex === 1) return ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC" })]);
        return err("rate_limited", "API rate limit hit");
      },
    });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: { bybit: stub },
    });

    // First call populates cache.
    const first = await orch.getHoldings(undefined);
    expect(first.data).toHaveLength(1);

    // Manually expire the cache entry by re-writing it with TTL=0
    // (simulates "more than 120s have passed" without actually waiting).
    cache.set("bybit", "bybit:UNIFIED:holdings", first.data, 0);
    // Spin until the clock has moved past the TTL.
    const start = Date.now();
    while (Date.now() === start) { /* sub-millisecond busy wait */ }

    // Next call: cache is stale → connector is invoked → connector errors →
    // orchestrator falls back to the still-present stale cache value.
    const second = await orch.getHoldings(undefined);
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.symbol).toBe("BTC");
    expect(stub.callCount.holdings).toBe(2);  // confirms the fetch was attempted
  });

  test("getHoldings with empty AccountStore returns empty result, no failures", async () => {
    const orch = new Orchestrator({ accountStore, cache, vault: vault as never });
    const result = await orch.getHoldings(undefined);
    expect(result.data).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  test("refresh(connector) only invalidates that connector's cache", async () => {
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    setupAccount({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });

    const bybitStub = new StubConnector({ id: "bybit", holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED" })]) });
    const mmStub = new StubConnector({ id: "metamask", holdingsResult: ok([makeHolding({ accountId: "metamask:0xabc" })]) });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: { bybit: bybitStub, metamask: mmStub },
    });

    await orch.getHoldings(undefined);
    expect(bybitStub.callCount.holdings).toBe(1);
    expect(mmStub.callCount.holdings).toBe(1);

    orch.refresh("bybit");                              // only bybit invalidated
    await orch.getHoldings(undefined);
    expect(bybitStub.callCount.holdings).toBe(2);      // re-fetched
    expect(mmStub.callCount.holdings).toBe(1);         // still cached
  });
});
