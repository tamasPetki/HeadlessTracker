// Custom token list management — pure-function unit tests against an in-memory
// AccountStore. Avoids touching the user's real ~/.headless-tracker/accounts.db.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../src/accounts.ts";
import {
  addCustomToken,
  listCustomTokens,
  readCustomTokens,
  removeCustomToken,
  validateToken,
} from "../src/tokens.ts";

let store: AccountStore;

beforeEach(() => {
  store = new AccountStore({ dbPath: ":memory:" });
  // 1 metamask account, 1 bybit account (the bybit one tests the connector-mismatch path).
  store.upsert({
    id: "metamask:0xabc",
    connectorId: "metamask",
    label: "MM Test",
    createdAt: 1,
  });
  store.upsert({
    id: "bybit:UNIFIED",
    connectorId: "bybit",
    label: "Bybit Test",
    createdAt: 2,
  });
});

afterEach(() => {
  store.close();
});

describe("validateToken", () => {
  test("rejects unsupported chain-id", () => {
    const r = validateToken(99999, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("Invalid chain-id");
  });

  test("rejects malformed contract", () => {
    const r = validateToken(1, "not-an-address", "USDC", 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("contract");
  });

  test("rejects empty symbol", () => {
    const r = validateToken(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "", 6);
    expect(r.ok).toBe(false);
  });

  test("rejects symbol > 20 chars", () => {
    const r = validateToken(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "x".repeat(21), 6);
    expect(r.ok).toBe(false);
  });

  test("rejects negative decimals", () => {
    const r = validateToken(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", -1);
    expect(r.ok).toBe(false);
  });

  test("rejects decimals > 36", () => {
    const r = validateToken(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", 37);
    expect(r.ok).toBe(false);
  });

  test("accepts valid params", () => {
    const r = validateToken(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", 6);
    expect(r.ok).toBe(true);
  });
});

describe("addCustomToken", () => {
  test("adds a new token to a metamask account", () => {
    const r = addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.action).toBe("added");

    // Verify persistence.
    const account = store.get("metamask:0xabc")!;
    const tokens = readCustomTokens(account);
    expect(tokens["1"]).toHaveLength(1);
    expect(tokens["1"]![0]!.symbol).toBe("USDC");
  });

  test("updates existing token (case-insensitive contract match)", () => {
    addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    // Same contract, different case + new symbol.
    const r = addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC2",
      decimals: 6,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.action).toBe("updated");

    const account = store.get("metamask:0xabc")!;
    const tokens = readCustomTokens(account);
    expect(tokens["1"]).toHaveLength(1);
    expect(tokens["1"]![0]!.symbol).toBe("USDC2");
  });

  test("rejects when account not found", () => {
    const r = addCustomToken(store, "metamask:nope", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("not_found");
  });

  test("rejects non-metamask account (Bybit)", () => {
    const r = addCustomToken(store, "bybit:UNIFIED", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("MetaMask");
  });

  test("supports tokens on multiple chains for one account", () => {
    addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    addCustomToken(store, "metamask:0xabc", 137, {
      contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      decimals: 6,
    });
    const account = store.get("metamask:0xabc")!;
    const tokens = readCustomTokens(account);
    expect(Object.keys(tokens).sort()).toEqual(["1", "137"]);
  });

  test("preserves other metadata fields when writing customTokens", () => {
    // Existing accounts may have their own metadata (e.g. hasEtherscanPro).
    // Adding a custom token must not clobber it.
    store.upsert({
      id: "metamask:0xabc",
      connectorId: "metamask",
      label: "MM Test",
      createdAt: 1,
      metadata: { hasEtherscanPro: true, chainIds: [1, 137] },
    });
    addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    const account = store.get("metamask:0xabc")!;
    expect(account.metadata?.hasEtherscanPro).toBe(true);
    expect(account.metadata?.chainIds).toEqual([1, 137]);
    expect(account.metadata?.customTokens).toBeDefined();
  });
});

describe("listCustomTokens", () => {
  test("returns empty for fresh store", () => {
    expect(listCustomTokens(store)).toEqual([]);
  });

  test("returns tokens sorted by chain-id (numeric, not lexicographic)", () => {
    addCustomToken(store, "metamask:0xabc", 137, {
      contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      decimals: 6,
    });
    addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    const list = listCustomTokens(store);
    expect(list.map((r) => r.chainId)).toEqual([1, 137]);
  });

  test("filters to one account when accountId given", () => {
    // Add another metamask account just to verify filtering.
    store.upsert({
      id: "metamask:0xdef",
      connectorId: "metamask",
      label: "MM 2",
      createdAt: 3,
    });
    addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    addCustomToken(store, "metamask:0xdef", 1, {
      contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      decimals: 6,
    });
    const filtered = listCustomTokens(store, "metamask:0xabc");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.token.symbol).toBe("USDC");
  });
});

describe("removeCustomToken", () => {
  beforeEach(() => {
    addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    });
    addCustomToken(store, "metamask:0xabc", 1, {
      contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      decimals: 6,
    });
  });

  test("removes one token, leaves others", () => {
    const r = removeCustomToken(store, "metamask:0xabc", 1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(r.ok).toBe(true);
    const account = store.get("metamask:0xabc")!;
    const tokens = readCustomTokens(account);
    expect(tokens["1"]).toHaveLength(1);
    expect(tokens["1"]![0]!.symbol).toBe("USDT");
  });

  test("removes the chain key entirely when last token on chain is removed", () => {
    removeCustomToken(store, "metamask:0xabc", 1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    removeCustomToken(store, "metamask:0xabc", 1, "0xdAC17F958D2ee523a2206206994597C13D831ec7");
    const account = store.get("metamask:0xabc")!;
    const tokens = readCustomTokens(account);
    expect(tokens["1"]).toBeUndefined();
  });

  test("case-insensitive contract matching", () => {
    const r = removeCustomToken(store, "metamask:0xabc", 1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(r.ok).toBe(true);
  });

  test("rejects when token not found", () => {
    const r = removeCustomToken(store, "metamask:0xabc", 1, "0x0000000000000000000000000000000000000001");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("not_found");
  });
});
