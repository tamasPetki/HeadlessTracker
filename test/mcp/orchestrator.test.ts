// Orchestrator tests — verifies the eng review 4A fixes (parallel + dedup) and
// the cache/vault/connector wiring.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../src/accounts.ts";
import { Cache } from "../../src/cache.ts";
import { Orchestrator } from "../../src/mcp/orchestrator.ts";
import type { Account } from "../../src/types.ts";
import { err, ok } from "../../src/types.ts";
import { StubConnector, StubVault, makeHolding } from "../helpers/stub-connector.ts";
import { initSentry } from "../../src/observability/sentry.ts";

let cache: Cache;
let accountStore: AccountStore;
let vault: StubVault;

beforeEach(() => {
  cache = new Cache({ dbPath: ":memory:" });
  accountStore = new AccountStore({ dbPath: ":memory:" });
  vault = new StubVault();
  // Hermetic telemetry: even if SENTRY_DSN is present in the env, force capture
  // to a no-op so the orchestrator's error-boundary reporting never makes a
  // network call during these tests.
  initSentry(undefined);
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

  test("REGRESSION P1: getTransactions partial failure preserves successful connector data", async () => {
    // From burn-in feedback: Tomi observed that get_transactions returned
    // transactions:[] when MetaMask failed, even though Bybit should have
    // returned its trades independently. This test pins the partial-failure
    // semantics for getTransactions specifically.
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    setupAccount({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          transactionsResult: ok([
            { accountId: "bybit:UNIFIED", txId: "t1", type: "trade", timestamp: 1700000000000 },
            { accountId: "bybit:UNIFIED", txId: "t2", type: "trade", timestamp: 1700000001000 },
          ]),
        }),
        metamask: new StubConnector({
          id: "metamask",
          transactionsResult: err("upstream_error", "All chains failed: free tier not supported"),
        }),
      },
    });

    const result = await orch.getTransactions(undefined, undefined);
    expect(result.data).toHaveLength(2);                 // Bybit trades preserved
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.accountId).toBe("metamask:0xabc");
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

  test("Account.metadata.customTokens flows into the connector's credentials", async () => {
    // The CLI writes customTokens to AccountStore (Account.metadata). The
    // orchestrator must merge it into the credentials object so MetaMaskConnector
    // sees it via creds.customTokens (its existing interface). This test pins
    // the merge so neither layer drifts apart.
    accountStore.upsert({
      id: "metamask:0xabc",
      connectorId: "metamask",
      label: "MM",
      createdAt: 1,
      metadata: {
        customTokens: {
          "1": [
            { contract: "0xCustom1", symbol: "CUSTOM", decimals: 18 },
          ],
        },
      },
    });
    vault.set("metamask", "0xabc", { address: "0xabc", etherscanApiKey: "k", chainIds: [1], trackCommonTokens: false });

    let capturedCreds: Record<string, unknown> | undefined;
    const stub = new StubConnector({
      id: "metamask",
      holdingsResult: (ctx) => {
        capturedCreds = ctx.credentials as Record<string, unknown>;
        return ok([]);
      },
    });
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: { metamask: stub },
    });

    await orch.getHoldings(undefined);
    expect(capturedCreds).toBeDefined();
    expect(capturedCreds!.customTokens).toEqual({
      "1": [{ contract: "0xCustom1", symbol: "CUSTOM", decimals: 18 }],
    });
    // Original vault credentials must be preserved (not clobbered by the merge).
    expect(capturedCreds!.etherscanApiKey).toBe("k");
    expect(capturedCreds!.address).toBe("0xabc");
  });

  test("Accounts WITHOUT customTokens metadata get unmodified credentials", async () => {
    // Negative case: don't accidentally inject `customTokens: undefined` or {}.
    accountStore.upsert({ id: "metamask:0xabc", connectorId: "metamask", label: "MM", createdAt: 1 });
    vault.set("metamask", "0xabc", { address: "0xabc", etherscanApiKey: "k" });

    let capturedCreds: Record<string, unknown> | undefined;
    const stub = new StubConnector({
      id: "metamask",
      holdingsResult: (ctx) => {
        capturedCreds = ctx.credentials as Record<string, unknown>;
        return ok([]);
      },
    });
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: { metamask: stub },
    });

    await orch.getHoldings(undefined);
    expect(capturedCreds).toBeDefined();
    expect(capturedCreds!.customTokens).toBeUndefined();
  });

  test("a connector that THROWS degrades to a per-account failure; other accounts still return", async () => {
    // Reliability boundary: before the orchestrator wrapped fetchForAccount in a
    // try/catch, a connector that threw (an unexpected bug, not a handled err())
    // rejected the whole Promise.all and took down EVERY account's fetch at once.
    // Now a throw is caught, reported to Sentry (no-op here — telemetry is off),
    // and degraded to a single err("unknown") failure for that account only.
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    setupAccount({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC" })]),
        }),
        metamask: new StubConnector({
          id: "metamask",
          holdingsResult: () => {
            throw new Error("connector blew up");
          },
        }),
      },
    });

    const result = await orch.getHoldings(undefined);
    // The healthy account still returns its holding...
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.symbol).toBe("BTC");
    // ...and the throwing account becomes one isolated failure, not a total wipeout.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.accountId).toBe("metamask:0xabc");
    expect(result.failures[0]!.error).toContain("unknown");
    expect(result.failures[0]!.error).toContain("connector blew up");
  });

  test("a connector that HANGS times out at the deadline; other accounts still return", async () => {
    // The core reliability guarantee: a connector whose request never resolves
    // (a hung upstream, or a connector that doesn't thread the abort signal into
    // its fetch — bybit.ts did exactly this) must not stall the tool call. The
    // orchestrator races each fetch against requestTimeoutMs, so a hang degrades
    // to a per-account network_timeout while healthy accounts return normally.
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    setupAccount({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      requestTimeoutMs: 60, // short so the test is fast
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC" })]),
        }),
        metamask: new StubConnector({
          id: "metamask",
          // Never resolves and ignores the signal entirely — the worst case the
          // race must defend against.
          holdingsResult: () => new Promise<never>(() => {}),
        }),
      },
    });

    const start = Date.now();
    const result = await orch.getHoldings(undefined);
    const elapsed = Date.now() - start;

    // The caller never waits meaningfully past the deadline...
    expect(elapsed).toBeLessThan(1000);
    // ...the healthy account still returns...
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.symbol).toBe("BTC");
    // ...and the hung account is one isolated timeout failure, with a message
    // that names the deadline rather than a mysterious "aborted".
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.accountId).toBe("metamask:0xabc");
    expect(result.failures[0]!.error).toContain("network_timeout");
    expect(result.failures[0]!.error).toContain("timed out after 60ms");
  });

  test("a connector that HONORS the abort signal surfaces a normalized timeout", async () => {
    // When a connector does thread the signal into its fetch, the deadline
    // aborts the real request and the connector returns its own network_timeout;
    // the orchestrator normalizes that generic "aborted" into the clear
    // deadline message.
    setupAccount({ id: "polymarket:0xdef", connectorId: "polymarket", label: "P", createdAt: 1 });

    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      requestTimeoutMs: 50,
      connectorOverrides: {
        polymarket: new StubConnector({
          id: "polymarket",
          holdingsResult: (ctx) =>
            new Promise((resolve) => {
              ctx.signal?.addEventListener(
                "abort",
                () => resolve(err("network_timeout", "Aborted by caller")),
                { once: true }
              );
            }),
        }),
      },
    });

    const result = await orch.getHoldings(undefined);
    expect(result.data).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain("timed out after 50ms");
  });

  test("a fast connector under a short deadline does NOT spuriously time out", async () => {
    // Guard against the timeout firing on a healthy fetch.
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      requestTimeoutMs: 500,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          delayMs: 20, // well under the deadline
          holdingsResult: ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC" })]),
        }),
      },
    });

    const result = await orch.getHoldings(undefined);
    expect(result.failures).toHaveLength(0);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.symbol).toBe("BTC");
  });

  test("a transient network_error is retried once and succeeds on the second attempt", async () => {
    // network_error == fetch threw at the network layer (DNS / connection
    // refused / dropped connection), the one clearly-transient kind. A single
    // retry should convert a blip into a success.
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    let calls = 0;
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      retryBackoffMs: 0, // no real wait in tests
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          holdingsResult: () => {
            calls++;
            return calls === 1
              ? err("network_error", "connection refused")
              : ok([makeHolding({ accountId: "bybit:UNIFIED", symbol: "BTC" })]);
          },
        }),
      },
    });

    const result = await orch.getHoldings(undefined);
    expect(calls).toBe(2); // retried exactly once
    expect(result.failures).toHaveLength(0);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.symbol).toBe("BTC");
  });

  test("a persistent network_error is retried once then surfaces as a failure", async () => {
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    const stub = new StubConnector({
      id: "bybit",
      holdingsResult: err("network_error", "connection refused"),
    });
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      retryBackoffMs: 0,
      connectorOverrides: { bybit: stub },
    });

    const result = await orch.getHoldings(undefined);
    expect(stub.callCount.holdings).toBe(2); // one retry, no more
    expect(result.data).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain("network_error");
  });

  test("non-transient errors (auth_failed) are NOT retried", async () => {
    setupAccount({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    const stub = new StubConnector({
      id: "bybit",
      holdingsResult: err("auth_failed", "Bybit key invalid"),
    });
    const orch = new Orchestrator({
      accountStore,
      cache,
      vault: vault as never,
      retryBackoffMs: 0,
      connectorOverrides: { bybit: stub },
    });

    const result = await orch.getHoldings(undefined);
    expect(stub.callCount.holdings).toBe(1); // no retry on a non-transient error
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain("auth_failed");
  });
});
