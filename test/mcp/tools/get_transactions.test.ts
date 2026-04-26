import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../../src/accounts.ts";
import { Cache } from "../../../src/cache.ts";
import { Orchestrator } from "../../../src/mcp/orchestrator.ts";
import { executeGetTransactions } from "../../../src/mcp/tools/get_transactions.ts";
import type { Transaction } from "../../../src/types.ts";
import { ok } from "../../../src/types.ts";
import { StubConnector, StubVault } from "../../helpers/stub-connector.ts";

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

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    accountId: "bybit:UNIFIED",
    txId: "1",
    type: "trade",
    timestamp: 1700000000000,
    ...overrides,
  };
}

describe("executeGetTransactions", () => {
  test("returns transactions sorted newest-first across accounts", async () => {
    accountStore.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    accountStore.upsert({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2 });
    vault.set("bybit", "UNIFIED", { x: 1 });
    vault.set("metamask", "0xabc", { x: 1 });

    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          transactionsResult: ok([
            makeTx({ accountId: "bybit:UNIFIED", txId: "old", timestamp: 1000 }),
            makeTx({ accountId: "bybit:UNIFIED", txId: "new", timestamp: 3000 }),
          ]),
        }),
        metamask: new StubConnector({
          id: "metamask",
          transactionsResult: ok([
            makeTx({ accountId: "metamask:0xabc", txId: "mid", timestamp: 2000 }),
          ]),
        }),
      },
    });

    const result = await executeGetTransactions({}, orch);
    expect(result.transactions.map((t) => t.txId)).toEqual(["new", "mid", "old"]);
  });

  test("since='7d' shorthand resolves to ~7 days ago in epoch ms", async () => {
    accountStore.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    vault.set("bybit", "UNIFIED", { x: 1 });

    let receivedSince: number | undefined;
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          transactionsResult: (_ctx) => {
            // The connector is called via fetchTransactions(ctx, since); we can't
            // observe `since` from the Connector signature directly without extending
            // StubConnector. Instead we verify resolution via the meta.sinceResolved.
            return ok([]);
          },
        }),
      },
    });

    const result = await executeGetTransactions({ since: "7d" }, orch);
    expect(result.meta.sinceResolved).not.toBeNull();
    expect(result.meta.sinceInputRaw).toBe("7d");
    const sinceMs = new Date(result.meta.sinceResolved!).getTime();
    const sevenDaysMs = 7 * 24 * 3600 * 1000;
    const elapsedFromSeven = Math.abs(Date.now() - sinceMs - sevenDaysMs);
    expect(elapsedFromSeven).toBeLessThan(2000);            // within 2 seconds of "7 days ago"
  });

  test("since='24h' shorthand resolves to ~24 hours ago", async () => {
    accountStore.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    vault.set("bybit", "UNIFIED", { x: 1 });
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: { bybit: new StubConnector({ id: "bybit", transactionsResult: ok([]) }) },
    });

    const result = await executeGetTransactions({ since: "24h" }, orch);
    const sinceMs = new Date(result.meta.sinceResolved!).getTime();
    const dayMs = 24 * 3600 * 1000;
    expect(Math.abs(Date.now() - sinceMs - dayMs)).toBeLessThan(2000);
  });

  test("since accepts numeric epoch ms input", async () => {
    accountStore.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    vault.set("bybit", "UNIFIED", { x: 1 });
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: { bybit: new StubConnector({ id: "bybit", transactionsResult: ok([]) }) },
    });

    const result = await executeGetTransactions({ since: "1700000000000" }, orch);
    expect(result.meta.sinceResolved).toBe(new Date(1700000000000).toISOString());
  });

  test("returns ISO timestamps in transaction output", async () => {
    accountStore.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1 });
    vault.set("bybit", "UNIFIED", { x: 1 });
    const orch = new Orchestrator({
      accountStore, cache, vault: vault as never,
      connectorOverrides: {
        bybit: new StubConnector({
          id: "bybit",
          transactionsResult: ok([makeTx({ timestamp: 1700000000000 })]),
        }),
      },
    });

    const result = await executeGetTransactions({}, orch);
    expect(result.transactions[0]!.timestamp).toBe(new Date(1700000000000).toISOString());
  });

  test("coverage caveats are surfaced in meta", async () => {
    const orch = new Orchestrator({ accountStore, cache, vault: vault as never });
    const result = await executeGetTransactions({}, orch);
    expect(result.meta.coverage.polymarket).toBe("not_implemented_in_v0");
    expect(result.meta.coverage.metamask).toBe("native_and_erc20_transfers");
    expect(result.meta.coverage.bybit).toBe("full");
  });
});
