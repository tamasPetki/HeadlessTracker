// Settings admin tools — list_accounts, setup_connector, account_admin, token_admin.
// Uses StubVault + AccountStore on :memory: so no keychain side effects.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../../../src/accounts.ts";
import { executeListAccounts } from "../../../src/mcp/tools/list_accounts.ts";
import { executeSetupConnector } from "../../../src/mcp/tools/setup_connector.ts";
import { executeAddWalletAddress, executeRemoveAccount } from "../../../src/mcp/tools/account_admin.ts";
import {
  executeAddCustomToken,
  executeListCustomTokens,
  executeRemoveCustomToken,
} from "../../../src/mcp/tools/token_admin.ts";
import { StubVault } from "../../helpers/stub-connector.ts";

const realFetch = globalThis.fetch;
let store: AccountStore;
let vault: StubVault;

beforeEach(() => {
  store = new AccountStore({ dbPath: ":memory:" });
  vault = new StubVault();
});

afterEach(() => {
  store.close();
  globalThis.fetch = realFetch;
});

// ============================================================================
// list_accounts
// ============================================================================

describe("list_accounts", () => {
  test("empty registry → empty list, total=0", () => {
    const r = executeListAccounts({}, store);
    expect(r.accounts).toEqual([]);
    expect(r.meta.total).toBe(0);
  });

  test("returns all configured accounts, no credentials leaked", () => {
    store.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "Bybit UNIFIED", createdAt: 1000, metadata: { accountType: "UNIFIED" } });
    store.upsert({ id: "metamask:0xabc", connectorId: "metamask", label: "MetaMask 0xabc", createdAt: 2000, metadata: { addresses: ["0xabc"], chainIds: [1, 137] } });

    const r = executeListAccounts({}, store);
    expect(r.accounts).toHaveLength(2);
    expect(r.meta.total).toBe(2);

    // No credential fields should appear in the metadata exposed to callers.
    for (const a of r.accounts) {
      const json = JSON.stringify(a);
      expect(json).not.toContain("apiKey");
      expect(json).not.toContain("apiSecret");
      expect(json).not.toContain("etherscanApiKey");
    }
  });

  test("connector filter narrows results", () => {
    store.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1, metadata: {} });
    store.upsert({ id: "metamask:0xabc", connectorId: "metamask", label: "M", createdAt: 2, metadata: {} });

    const onlyBybit = executeListAccounts({ connector: "bybit" }, store);
    expect(onlyBybit.accounts).toHaveLength(1);
    expect(onlyBybit.accounts[0]!.connectorId).toBe("bybit");
  });
});

// ============================================================================
// setup_connector
// ============================================================================

describe("setup_connector — Polymarket (no upstream call mocking needed since validation hits a public endpoint)", () => {
  test("missing credentials block returns ok=false with clear error", async () => {
    const r = await executeSetupConnector(
      { connector: "polymarket" },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("polymarket credentials required");
  });

  test("invalid wallet shape rejected by Zod-equivalent regex check", async () => {
    // We rely on the schema validator at the MCP boundary in production; here
    // we directly invoke executeSetupConnector. The connector's
    // validateCredentials catches the same case.
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify([]), { status: 200 })
    ) as unknown as typeof fetch;

    const r = await executeSetupConnector(
      {
        connector: "polymarket",
        polymarket: { proxyWallet: "0xnotvalid" },
      },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    // Either the regex check or the connector-level validation must catch it.
    expect(typeof r.error).toBe("string");
  });

  test("happy path: polymarket setup writes to vault + AccountStore", async () => {
    // Polymarket's validateCredentials probes the public data-api. Mock the
    // /positions endpoint to return an empty list (= valid wallet, no positions).
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify([]), { status: 200 })
    ) as unknown as typeof fetch;

    const wallet = "0x" + "a".repeat(40);
    const r = await executeSetupConnector(
      {
        connector: "polymarket",
        polymarket: { proxyWallet: wallet, sizeThreshold: 0.05 },
      },
      { vault: vault as never, store }
    );

    expect(r.ok).toBe(true);
    expect(r.accountId).toBe(`polymarket:${wallet.toLowerCase()}`);
    expect(r.label).toContain("Polymarket");

    // AccountStore was populated.
    const stored = store.get(r.accountId!);
    expect(stored).not.toBeNull();
    expect(stored!.connectorId).toBe("polymarket");
    expect(stored!.metadata?.proxyWallet).toBe(wallet);

    // Vault got the credential.
    const credsResult = await vault.get("polymarket", wallet.toLowerCase());
    expect(credsResult.ok).toBe(true);
  });
});

describe("setup_connector — Binance (mocked /api/v3/account)", () => {
  test("missing credentials block returns ok=false with clear error", async () => {
    const r = await executeSetupConnector(
      { connector: "binance" },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("binance credentials required");
  });

  test("happy path: binance setup writes to vault + AccountStore", async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({ balances: [], canTrade: true, canWithdraw: false, accountType: "SPOT" }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const apiKey = "AbCdEfGhIjKl1234567890";
    const r = await executeSetupConnector(
      { connector: "binance", binance: { apiKey, apiSecret: "topsecret", includeFutures: false } },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(true);
    expect(r.accountId).toBe(`binance:key-${apiKey.slice(0, 6)}`);
    expect(r.label).toContain("Binance Spot");

    const stored = store.get(r.accountId!);
    expect(stored).not.toBeNull();
    expect(stored!.connectorId).toBe("binance");
    // Critical: NO apiSecret in metadata. Only the public-safe fingerprint.
    const meta = JSON.stringify(stored!.metadata ?? {});
    expect(meta).not.toContain("topsecret");
    expect(meta).toContain(apiKey.slice(0, 6));

    // Vault stored the full credentials.
    const credsResult = await vault.get("binance", `key-${apiKey.slice(0, 6)}`);
    expect(credsResult.ok).toBe(true);
    if (credsResult.ok) {
      expect((credsResult.value as { apiSecret: string }).apiSecret).toBe("topsecret");
    }
  });

  test("includeFutures=true reflected in label + metadata", async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({ balances: [], canTrade: true, canWithdraw: false, accountType: "SPOT" }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const r = await executeSetupConnector(
      { connector: "binance", binance: { apiKey: "abcdef0", apiSecret: "s", includeFutures: true } },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(true);
    expect(r.label).toContain("Spot+Futures");
    const stored = store.get(r.accountId!);
    expect(stored!.metadata?.includeFutures).toBe(true);
  });
});

describe("setup_connector — Solana (mocked RPC validation)", () => {
  test("missing credentials block returns ok=false with clear error", async () => {
    const r = await executeSetupConnector(
      { connector: "solana" },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("solana credentials required");
  });

  test("happy path: solana setup writes to vault + AccountStore", async () => {
    // Mock the RPC getBalance call to succeed.
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 0 } }), { status: 200 })
    ) as unknown as typeof fetch;

    const addr = "vaPrxbCkFJiy4ksy76C8gpW5G2NJfnaC7XrjvW3KWdb";
    const r = await executeSetupConnector(
      { connector: "solana", solana: { address: addr, dustThresholdUsd: 0.1 } },
      { vault: vault as never, store }
    );

    expect(r.ok).toBe(true);
    // Critical: Solana addresses are case-sensitive — no lowercase mangling.
    expect(r.accountId).toBe(`solana:${addr}`);
    expect(r.label).toContain("Solana");

    const stored = store.get(r.accountId!);
    expect(stored).not.toBeNull();
    expect(stored!.connectorId).toBe("solana");
    expect(stored!.metadata?.address).toBe(addr);

    // Vault got the credential under the case-preserving identifier.
    const credsResult = await vault.get("solana", addr);
    expect(credsResult.ok).toBe(true);
    if (credsResult.ok) {
      expect((credsResult.value as { address: string }).address).toBe(addr);
    }
  });
});

// ============================================================================
// add_wallet_address
// ============================================================================

describe("add_wallet_address", () => {
  test("rejects unknown account_id", async () => {
    const r = await executeAddWalletAddress(
      { account_id: "metamask:0xnope", address: "0x" + "b".repeat(40) },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Account not found");
  });

  test("rejects when account is not metamask (e.g. bybit)", async () => {
    store.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1, metadata: {} });
    const r = await executeAddWalletAddress(
      { account_id: "bybit:UNIFIED", address: "0x" + "b".repeat(40) },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("MetaMask");
  });

  test("appends new address to MetaMask account's addresses[] list", async () => {
    const initialAddr = "0x" + "a".repeat(40);
    const newAddr = "0x" + "b".repeat(40);
    const accountId = `metamask:${initialAddr.toLowerCase()}`;

    store.upsert({ id: accountId, connectorId: "metamask", label: "M", createdAt: 1, metadata: { address: initialAddr } });
    vault.set("metamask", initialAddr.toLowerCase(), {
      address: initialAddr,
      etherscanApiKey: "fakekey",
      chainIds: [1],
      trackCommonTokens: true,
      hasEtherscanPro: false,
    });

    const r = await executeAddWalletAddress(
      { account_id: accountId, address: newAddr },
      { vault: vault as never, store }
    );

    expect(r.ok).toBe(true);
    expect(r.addresses).toEqual([initialAddr, newAddr]);

    // The vault was migrated from legacy `address` field to `addresses[]`.
    const credsResult = await vault.get("metamask", initialAddr.toLowerCase());
    expect(credsResult.ok).toBe(true);
    if (credsResult.ok) {
      const creds = credsResult.value as { addresses?: string[]; address?: string };
      expect(creds.addresses).toEqual([initialAddr, newAddr]);
      expect(creds.address).toBeUndefined(); // legacy field removed
    }
  });

  test("rejects duplicate address (case-insensitive)", async () => {
    const addr = "0x" + "a".repeat(40);
    const accountId = `metamask:${addr.toLowerCase()}`;
    store.upsert({ id: accountId, connectorId: "metamask", label: "M", createdAt: 1, metadata: { addresses: [addr] } });
    vault.set("metamask", addr.toLowerCase(), { addresses: [addr], etherscanApiKey: "fakekey", chainIds: [1] });

    const r = await executeAddWalletAddress(
      { account_id: accountId, address: addr.toUpperCase() },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already tracked");
  });

  test("Solana: appends new address (case-sensitive base58, no lowercase)", async () => {
    const initial = "vaPrxbCkFJiy4ksy76C8gpW5G2NJfnaC7XrjvW3KWdb";
    const newAddr = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
    const accountId = `solana:${initial}`;
    store.upsert({ id: accountId, connectorId: "solana", label: "Sol", createdAt: 1, metadata: { address: initial } });
    vault.set("solana", initial, { address: initial });

    const r = await executeAddWalletAddress(
      { account_id: accountId, address: newAddr },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(true);
    expect(r.addresses).toEqual([initial, newAddr]);

    const credsResult = await vault.get("solana", initial);
    expect(credsResult.ok).toBe(true);
    if (credsResult.ok) {
      const creds = credsResult.value as { addresses?: string[]; address?: string };
      // Critical: addresses preserved as-is (case-sensitive). No lowercase.
      expect(creds.addresses).toEqual([initial, newAddr]);
      expect(creds.address).toBeUndefined();
    }
  });

  test("Solana: rejects EVM-format 0x address as malformed", async () => {
    const addr = "vaPrxbCkFJiy4ksy76C8gpW5G2NJfnaC7XrjvW3KWdb";
    const accountId = `solana:${addr}`;
    store.upsert({ id: accountId, connectorId: "solana", label: "Sol", createdAt: 1, metadata: { address: addr } });
    vault.set("solana", addr, { address: addr });

    const r = await executeAddWalletAddress(
      { account_id: accountId, address: "0x" + "b".repeat(40) },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Invalid Solana address");
  });

  test("MetaMask: rejects base58 (Solana-format) address as malformed", async () => {
    const addr = "0x" + "a".repeat(40);
    const accountId = `metamask:${addr.toLowerCase()}`;
    store.upsert({ id: accountId, connectorId: "metamask", label: "M", createdAt: 1, metadata: { addresses: [addr] } });
    vault.set("metamask", addr.toLowerCase(), { addresses: [addr] });

    const r = await executeAddWalletAddress(
      { account_id: accountId, address: "vaPrxbCkFJiy4ksy76C8gpW5G2NJfnaC7XrjvW3KWdb" },
      { vault: vault as never, store }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Invalid EVM address");
  });
});

// ============================================================================
// remove_account
// ============================================================================

describe("remove_account", () => {
  test("rejects unknown account_id", async () => {
    const r = await executeRemoveAccount({ account_id: "bybit:GHOST" }, { vault: vault as never, store });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Account not found");
  });

  test("removes from AccountStore + vault", async () => {
    store.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1, metadata: {} });
    vault.set("bybit", "UNIFIED", { apiKey: "k", apiSecret: "s", accountType: "UNIFIED" });

    const r = await executeRemoveAccount({ account_id: "bybit:UNIFIED" }, { vault: vault as never, store });
    expect(r.ok).toBe(true);
    expect(r.removedAccountId).toBe("bybit:UNIFIED");

    expect(store.get("bybit:UNIFIED")).toBeNull();
    const credsResult = await vault.get("bybit", "UNIFIED");
    expect(credsResult.ok).toBe(false);
  });
});

// ============================================================================
// add_custom_token / remove_custom_token / list_custom_tokens
// ============================================================================

describe("custom token tools", () => {
  test("list returns empty when nothing configured", () => {
    const r = executeListCustomTokens({}, store);
    expect(r.tokens).toEqual([]);
    expect(r.meta.total).toBe(0);
  });

  test("add → list → remove round-trip", () => {
    const accountId = "metamask:0xabc";
    store.upsert({ id: accountId, connectorId: "metamask", label: "M", createdAt: 1, metadata: {} });

    const addResult = executeAddCustomToken(
      { account_id: accountId, chain_id: 1, contract: "0x" + "1".repeat(40), symbol: "FOO", decimals: 18 },
      store
    );
    expect(addResult.ok).toBe(true);
    expect(addResult.action).toBe("added");

    const listResult = executeListCustomTokens({}, store);
    expect(listResult.tokens).toHaveLength(1);
    expect(listResult.tokens[0]!.symbol).toBe("FOO");
    expect(listResult.tokens[0]!.chainId).toBe(1);

    const removeResult = executeRemoveCustomToken(
      { account_id: accountId, chain_id: 1, contract: "0x" + "1".repeat(40) },
      store
    );
    expect(removeResult.ok).toBe(true);

    const finalList = executeListCustomTokens({}, store);
    expect(finalList.tokens).toHaveLength(0);
  });

  test("add to non-metamask account is rejected", () => {
    store.upsert({ id: "bybit:UNIFIED", connectorId: "bybit", label: "B", createdAt: 1, metadata: {} });
    const r = executeAddCustomToken(
      { account_id: "bybit:UNIFIED", chain_id: 1, contract: "0x" + "1".repeat(40), symbol: "FOO", decimals: 18 },
      store
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("MetaMask");
  });

  test("invalid chain_id rejected with helpful list of supported chains", () => {
    const accountId = "metamask:0xabc";
    store.upsert({ id: accountId, connectorId: "metamask", label: "M", createdAt: 1, metadata: {} });
    const r = executeAddCustomToken(
      { account_id: accountId, chain_id: 999_999, contract: "0x" + "1".repeat(40), symbol: "FOO", decimals: 18 },
      store
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Supported");
  });
});
