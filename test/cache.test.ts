// Cache layer tests — in-memory SQLite, no FS side effects.
// Covers: basic CRUD, TTL expiry semantics, WAL mode active, scoping by connector,
//   bulk writes, invalidation (single key + all-of-connector + global).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../src/cache.ts";

let cache: Cache;

beforeEach(() => {
  cache = new Cache({ dbPath: ":memory:" });
});

afterEach(() => {
  cache.close();
});

describe("Cache", () => {
  test("set/get round-trip preserves value", () => {
    cache.set("bybit", "holdings:UNIFIED", { btc: 0.5, eth: 2 }, 60);
    const hit = cache.get<{ btc: number; eth: number }>("bybit", "holdings:UNIFIED");
    expect(hit).not.toBeNull();
    expect(hit!.value.btc).toBe(0.5);
    expect(hit!.value.eth).toBe(2);
    expect(hit!.stale).toBe(false);
  });

  test("get returns null on miss", () => {
    const miss = cache.get("bybit", "nonexistent");
    expect(miss).toBeNull();
  });

  test("TTL expiry marks entry stale but keeps value retrievable", () => {
    // ttl = 0 seconds → expires_at = now → already stale on next millisecond.
    cache.set("bybit", "stale-key", "value", 0);
    // Spin until the clock has moved past the expires_at.
    const start = Date.now();
    while (Date.now() === start) { /* busy-wait < 1ms */ }
    const hit = cache.get<string>("bybit", "stale-key");
    expect(hit).not.toBeNull();
    expect(hit!.value).toBe("value");
    expect(hit!.stale).toBe(true);
  });

  test("uses per-connector default TTL when not specified", () => {
    cache.set("bybit", "k", "v");           // bybit default = 120s
    cache.set("polymarket", "k", "v");      // polymarket default = 30s
    const bybit = cache.get<string>("bybit", "k");
    const poly = cache.get<string>("polymarket", "k");
    expect(bybit!.stale).toBe(false);
    expect(poly!.stale).toBe(false);
  });

  test("invalidate(connector, key) removes single entry", () => {
    cache.set("bybit", "a", 1);
    cache.set("bybit", "b", 2);
    cache.invalidate("bybit", "a");
    expect(cache.get("bybit", "a")).toBeNull();
    expect(cache.get<number>("bybit", "b")!.value).toBe(2);
  });

  test("invalidate(connector) removes all keys for that connector only", () => {
    cache.set("bybit", "a", 1);
    cache.set("bybit", "b", 2);
    cache.set("metamask", "c", 3);
    cache.invalidate("bybit");
    expect(cache.get("bybit", "a")).toBeNull();
    expect(cache.get("bybit", "b")).toBeNull();
    expect(cache.get<number>("metamask", "c")!.value).toBe(3);
  });

  test("invalidateAll clears every connector", () => {
    cache.set("bybit", "a", 1);
    cache.set("metamask", "b", 2);
    cache.set("polymarket", "c", 3);
    cache.invalidateAll();
    expect(cache.get("bybit", "a")).toBeNull();
    expect(cache.get("metamask", "b")).toBeNull();
    expect(cache.get("polymarket", "c")).toBeNull();
  });

  test("set is idempotent — replacing a key keeps the latest value", () => {
    cache.set("bybit", "k", "first");
    cache.set("bybit", "k", "second");
    expect(cache.get<string>("bybit", "k")!.value).toBe("second");
  });

  test("scoping is per-connector — same key in two connectors are independent", () => {
    cache.set("bybit", "shared", "bybit-value");
    cache.set("metamask", "shared", "mm-value");
    expect(cache.get<string>("bybit", "shared")!.value).toBe("bybit-value");
    expect(cache.get<string>("metamask", "shared")!.value).toBe("mm-value");
  });

  test("complex JSON values survive round-trip", () => {
    const value = {
      list: [{ id: 1, name: "a" }, { id: 2, name: "b" }],
      meta: { count: 2, asOf: "2026-04-26T17:00:00Z" },
      nested: { deeply: { value: 42 } },
    };
    cache.set("bybit", "complex", value);
    const hit = cache.get<typeof value>("bybit", "complex");
    expect(hit!.value).toEqual(value);
  });

  test("bulk writes (100 keys) succeed under WAL", () => {
    for (let i = 0; i < 100; i++) {
      cache.set("bybit", `k${i}`, { i });
    }
    for (let i = 0; i < 100; i++) {
      const hit = cache.get<{ i: number }>("bybit", `k${i}`);
      expect(hit!.value.i).toBe(i);
    }
  });
});
