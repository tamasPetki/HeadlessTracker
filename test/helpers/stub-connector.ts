// Test helper: configurable stub Connector that records calls and returns canned data.
// Used by orchestrator + tool tests to avoid hitting real APIs / mocking fetch.

import type { Connector, ConnectorContext, ConnectorCredentials } from "../../src/connectors/types.ts";
import type { ConnectorId, Holding, Result, Transaction } from "../../src/types.ts";
import { err, ok } from "../../src/types.ts";

export interface StubConnectorOptions {
  id: ConnectorId;
  defaultCacheTtlSec?: number;
  // Per-call result. Function form lets tests vary responses across calls.
  holdingsResult?: Result<Holding[]> | ((ctx: ConnectorContext, callIndex: number) => Result<Holding[]> | Promise<Result<Holding[]>>);
  transactionsResult?: Result<Transaction[]> | ((ctx: ConnectorContext, callIndex: number) => Result<Transaction[]> | Promise<Result<Transaction[]>>);
  validationResult?: Result<void>;
  // Artificial latency in ms — useful for testing dedup (multiple callers race the same Promise).
  delayMs?: number;
}

export class StubConnector implements Connector {
  readonly id: ConnectorId;
  readonly displayName: string;
  readonly defaultCacheTtlSec: number;

  callCount = { holdings: 0, transactions: 0, validate: 0 };
  callContexts: { holdings: ConnectorContext[]; transactions: ConnectorContext[] } = {
    holdings: [],
    transactions: [],
  };

  constructor(private opts: StubConnectorOptions) {
    this.id = opts.id;
    this.displayName = `Stub(${opts.id})`;
    this.defaultCacheTtlSec = opts.defaultCacheTtlSec ?? 60;
  }

  async validateCredentials(_creds: ConnectorCredentials): Promise<Result<void>> {
    this.callCount.validate++;
    return this.opts.validationResult ?? ok(undefined);
  }

  async fetchHoldings(ctx: ConnectorContext): Promise<Result<Holding[]>> {
    const callIndex = this.callCount.holdings;
    this.callCount.holdings++;
    this.callContexts.holdings.push(ctx);
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (typeof this.opts.holdingsResult === "function") {
      return await this.opts.holdingsResult(ctx, callIndex);
    }
    return this.opts.holdingsResult ?? ok([]);
  }

  async fetchTransactions(ctx: ConnectorContext): Promise<Result<Transaction[]>> {
    const callIndex = this.callCount.transactions;
    this.callCount.transactions++;
    this.callContexts.transactions.push(ctx);
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (typeof this.opts.transactionsResult === "function") {
      return await this.opts.transactionsResult(ctx, callIndex);
    }
    return this.opts.transactionsResult ?? ok([]);
  }
}

// Stub vault that just returns whatever credentials were registered for an account.
// Conforms to the real Vault interface (Promise<Result<...>> on set/get/remove)
// so production code calling `await vault.set(...)` doesn't blow up under stub.
export class StubVault {
  private store = new Map<string, ConnectorCredentials>();

  async set(
    connectorId: ConnectorId,
    accountIdentifier: string,
    creds: ConnectorCredentials
  ): Promise<Result<void>> {
    this.store.set(`${connectorId}:${accountIdentifier}`, creds);
    return ok(undefined);
  }

  async get(connectorId: ConnectorId, accountIdentifier: string): Promise<Result<ConnectorCredentials>> {
    const key = `${connectorId}:${accountIdentifier}`;
    const creds = this.store.get(key);
    if (!creds) return err("not_found", `No credentials for ${key}`);
    return ok(creds);
  }

  async remove(connectorId: ConnectorId, accountIdentifier: string): Promise<Result<void>> {
    this.store.delete(`${connectorId}:${accountIdentifier}`);
    return ok(undefined);
  }
}

export function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    accountId: "stub:1",
    symbol: "BTC",
    assetClass: "crypto",
    quantity: 1,
    valueCurrency: "USD",
    fetchedAt: Date.now(),
    ...overrides,
  };
}
