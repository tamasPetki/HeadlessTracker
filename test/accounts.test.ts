// AccountStore tests — in-memory SQLite, no FS side effects.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../src/accounts.ts";

let store: AccountStore;

beforeEach(() => {
  store = new AccountStore({ dbPath: ":memory:" });
});

afterEach(() => {
  store.close();
});

describe("AccountStore", () => {
  test("upsert + get round-trip preserves all fields", () => {
    const now = Date.now();
    store.upsert({
      id: "bybit:UNIFIED",
      connectorId: "bybit",
      label: "Bybit UNIFIED",
      createdAt: now,
      metadata: { accountType: "UNIFIED" },
    });
    const got = store.get("bybit:UNIFIED");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("bybit:UNIFIED");
    expect(got!.connectorId).toBe("bybit");
    expect(got!.label).toBe("Bybit UNIFIED");
    expect(got!.createdAt).toBe(now);
    expect(got!.metadata).toEqual({ accountType: "UNIFIED" });
  });

  test("get returns null on miss", () => {
    expect(store.get("nonexistent")).toBeNull();
  });

  test("upsert replaces existing account with same id", () => {
    store.upsert({
      id: "bybit:UNIFIED",
      connectorId: "bybit",
      label: "First",
      createdAt: 1000,
    });
    store.upsert({
      id: "bybit:UNIFIED",
      connectorId: "bybit",
      label: "Second",
      createdAt: 2000,
      metadata: { accountType: "UNIFIED" },
    });
    const got = store.get("bybit:UNIFIED");
    expect(got!.label).toBe("Second");
    expect(got!.createdAt).toBe(2000);
    expect(got!.metadata).toEqual({ accountType: "UNIFIED" });
  });

  test("list returns accounts ordered by createdAt ASC", () => {
    store.upsert({ id: "c", connectorId: "polymarket", label: "C", createdAt: 3000 });
    store.upsert({ id: "a", connectorId: "bybit", label: "A", createdAt: 1000 });
    store.upsert({ id: "b", connectorId: "metamask", label: "B", createdAt: 2000 });
    const all = store.list();
    expect(all.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  test("listByConnector filters and preserves order", () => {
    store.upsert({ id: "metamask:0xabc", connectorId: "metamask", label: "MM A", createdAt: 1000 });
    store.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "Bybit", createdAt: 2000 });
    store.upsert({ id: "metamask:0xdef", connectorId: "metamask", label: "MM B", createdAt: 3000 });
    const mm = store.listByConnector("metamask");
    expect(mm.map((a) => a.id)).toEqual(["metamask:0xabc", "metamask:0xdef"]);
    const bybit = store.listByConnector("bybit");
    expect(bybit.map((a) => a.id)).toEqual(["bybit:UNIFIED"]);
    expect(store.listByConnector("polymarket")).toEqual([]);
  });

  test("remove returns true when account existed, false otherwise", () => {
    store.upsert({ id: "x", connectorId: "bybit", label: "X", createdAt: 1 });
    expect(store.remove("x")).toBe(true);
    expect(store.get("x")).toBeNull();
    expect(store.remove("x")).toBe(false);
  });

  test("metadata defaults to empty object when not provided", () => {
    store.upsert({ id: "min", connectorId: "bybit", label: "Minimal", createdAt: 1 });
    const got = store.get("min");
    expect(got!.metadata).toEqual({});
  });

  test("metadata survives JSON round-trip including nested objects", () => {
    const meta = {
      address: "0xabc",
      chainIds: [1, 137],
      trackCommonTokens: true,
      nested: { foo: "bar", count: 42 },
    };
    store.upsert({
      id: "complex",
      connectorId: "metamask",
      label: "Complex",
      createdAt: 1,
      metadata: meta,
    });
    expect(store.get("complex")!.metadata).toEqual(meta);
  });
});
