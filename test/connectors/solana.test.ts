// Solana connector tests — credential validation + mocked-RPC integration to
// exercise SOL balance + SPL token aggregation + Jupiter price fan-in.

import { afterEach, describe, expect, test } from "bun:test";
import { SolanaConnector } from "../../src/connectors/solana.ts";
import type { Account } from "../../src/types.ts";

// A real-shape base58 mainnet address (Phantom's deploy proxy, public).
// Using a real one keeps the regex checks honest — synthetic strings can pass
// regex but fail base58 decode in stricter implementations.
const REAL_ADDR = "vaPrxbCkFJiy4ksy76C8gpW5G2NJfnaC7XrjvW3KWdb";
const SECOND_ADDR = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

describe("SolanaConnector identity", () => {
  test("connector identity is stable", () => {
    const c = new SolanaConnector();
    expect(c.id).toBe("solana");
    expect(c.defaultCacheTtlSec).toBe(60);
    expect(c.displayName.toLowerCase()).toContain("solana");
  });
});

describe("SolanaConnector.validateCredentials", () => {
  test("rejects missing address", async () => {
    const c = new SolanaConnector();
    const result = await c.validateCredentials({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema_mismatch");
  });

  test("rejects malformed (non-base58) address", async () => {
    const c = new SolanaConnector();
    const result = await c.validateCredentials({ address: "not!an!address!!!!!" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema_mismatch");
  });

  test("rejects empty addresses[] list", async () => {
    const c = new SolanaConnector();
    const result = await c.validateCredentials({ addresses: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema_mismatch");
  });

  test("accepts single address (mocked RPC ok)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 0 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    try {
      const c = new SolanaConnector();
      const result = await c.validateCredentials({ address: REAL_ADDR });
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("propagates upstream RPC HTTP error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const c = new SolanaConnector();
      const result = await c.validateCredentials({ address: REAL_ADDR });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("upstream_error");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("SolanaConnector.fetchHoldings (mocked RPC + Jupiter)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns native SOL + USDC SPL holding with Jupiter prices", async () => {
    // 1 SOL = 1_000_000_000 lamports
    const ONE_SOL_LAMPORTS = 1_000_000_000;
    // Mock RPC + Jupiter API.
    globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      if (url.startsWith("https://api.jup.ag/price/v2")) {
        return new Response(
          JSON.stringify({
            data: {
              "So11111111111111111111111111111111111111112": { id: "So111…", price: "150" },
              EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { id: "EPjF…", price: "1" },
            },
          }),
          { status: 200 }
        );
      }
      // RPC POST: differentiate by the JSON-RPC method in the body.
      const body = init?.body ? JSON.parse(String(init.body)) : { method: "" };
      if (body.method === "getBalance") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: ONE_SOL_LAMPORTS } }),
          { status: 200 }
        );
      }
      if (body.method === "getTokenAccountsByOwner") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              value: [
                {
                  pubkey: "fake-pubkey",
                  account: {
                    data: {
                      parsed: {
                        info: {
                          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                          owner: REAL_ADDR,
                          tokenAmount: {
                            amount: "100000000",
                            decimals: 6,
                            uiAmount: 100,
                            uiAmountString: "100",
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const conn = new SolanaConnector();
    const account: Account = {
      id: `solana:${REAL_ADDR}`,
      connectorId: "solana",
      label: "Test SOL",
      createdAt: 1,
    };
    const result = await conn.fetchHoldings({
      account,
      credentials: { address: REAL_ADDR },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const symbols = result.value.map((h) => h.symbol).sort();
    expect(symbols).toEqual(["SOL", "USDC"]);
    const sol = result.value.find((h) => h.symbol === "SOL")!;
    expect(sol.quantity).toBe(1);
    expect(sol.currentPrice).toBe(150);
    expect(sol.value).toBe(150);
    expect(sol.assetClass).toBe("crypto");
    expect(sol.metadata?.native).toBe(true);
    expect(sol.metadata?.address).toBe(REAL_ADDR);

    const usdc = result.value.find((h) => h.symbol === "USDC")!;
    expect(usdc.quantity).toBe(100);
    expect(usdc.currentPrice).toBe(1);
    expect(usdc.value).toBe(100);
    expect(usdc.metadata?.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  test("dust filter skips low-value unknown tokens; known tokens always show", async () => {
    // Unknown mint with $0.01 value (below 0.5 dust threshold) — should be DROPPED.
    // Known mint (USDC) with $0.10 value — should still show because it's pinned.
    const UNKNOWN_MINT = "Drk2bL5UU6kfFPCQjcZmZQNVqZBhfZ9XnRmVcRfZdfZ9";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      if (url.startsWith("https://api.jup.ag/price/v2")) {
        return new Response(
          JSON.stringify({
            data: {
              "So11111111111111111111111111111111111111112": { id: "wsol", price: "0" },
              [UNKNOWN_MINT]: { id: "unk", price: "0.001" },
              EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { id: "usdc", price: "1" },
            },
          }),
          { status: 200 }
        );
      }
      const body = init?.body ? JSON.parse(String(init.body)) : { method: "" };
      if (body.method === "getBalance") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 0 } }),
          { status: 200 }
        );
      }
      if (body.method === "getTokenAccountsByOwner") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              value: [
                // Unknown token, $0.01 value — under default 0.5 USD dust threshold
                {
                  pubkey: "p1",
                  account: {
                    data: {
                      parsed: {
                        info: {
                          mint: UNKNOWN_MINT,
                          owner: REAL_ADDR,
                          tokenAmount: { amount: "10", decimals: 1, uiAmount: 10, uiAmountString: "10" },
                        },
                      },
                    },
                  },
                },
                // Known USDC, $0.10 — under threshold but shows because it's pinned
                {
                  pubkey: "p2",
                  account: {
                    data: {
                      parsed: {
                        info: {
                          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                          owner: REAL_ADDR,
                          tokenAmount: { amount: "100000", decimals: 6, uiAmount: 0.1, uiAmountString: "0.1" },
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const conn = new SolanaConnector();
    const result = await conn.fetchHoldings({
      account: { id: `solana:${REAL_ADDR}`, connectorId: "solana", label: "x", createdAt: 1 },
      credentials: { address: REAL_ADDR },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const symbols = result.value.map((h) => h.symbol);
    expect(symbols).toContain("USDC");
    // The unknown token at $0.01 below 0.5 threshold must be filtered out.
    expect(symbols.some((s) => s.startsWith("SPL-"))).toBe(false);
  });

  test("multi-wallet: fans out per address, aggregates SOL across all", async () => {
    const TWO_SOL = 2_000_000_000;
    const HALF_SOL = 500_000_000;
    let getBalanceCalls = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      if (url.startsWith("https://api.jup.ag/price/v2")) {
        return new Response(
          JSON.stringify({
            data: {
              "So11111111111111111111111111111111111111112": { id: "wsol", price: "100" },
            },
          }),
          { status: 200 }
        );
      }
      const body = init?.body ? JSON.parse(String(init.body)) : { method: "", params: [] };
      if (body.method === "getBalance") {
        getBalanceCalls++;
        const lamports = body.params[0] === REAL_ADDR ? TWO_SOL : HALF_SOL;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: lamports } }),
          { status: 200 }
        );
      }
      // Empty token accounts for both wallets
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const conn = new SolanaConnector();
    const result = await conn.fetchHoldings({
      account: { id: `solana:${REAL_ADDR}`, connectorId: "solana", label: "x", createdAt: 1 },
      credentials: { addresses: [REAL_ADDR, SECOND_ADDR] },
    });
    expect(result.ok).toBe(true);
    expect(getBalanceCalls).toBe(2);
    if (!result.ok) return;
    // Two distinct SOL holdings with addresses tagged in metadata
    const sols = result.value.filter((h) => h.symbol === "SOL");
    expect(sols).toHaveLength(2);
    const addresses = sols.map((h) => h.metadata?.address).sort();
    expect(addresses).toEqual([REAL_ADDR, SECOND_ADDR].sort());
  });

  test("returns ok([]) for fully empty wallet", async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      if (url.startsWith("https://api.jup.ag/price/v2")) {
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : { method: "" };
      if (body.method === "getBalance") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 0 } }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const conn = new SolanaConnector();
    const result = await conn.fetchHoldings({
      account: { id: `solana:${REAL_ADDR}`, connectorId: "solana", label: "x", createdAt: 1 },
      credentials: { address: REAL_ADDR },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  test("rate_limited propagates from RPC", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Too Many Requests", { status: 429 });
    }) as unknown as typeof fetch;

    const conn = new SolanaConnector();
    const result = await conn.fetchHoldings({
      account: { id: `solana:${REAL_ADDR}`, connectorId: "solana", label: "x", createdAt: 1 },
      credentials: { address: REAL_ADDR },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("upstream_error"); // wrapped via "Solana fetch failed"
  });
});

describe("SolanaConnector.fetchTransactions", () => {
  test("returns ok([]) — Solana tx history deferred", async () => {
    const conn = new SolanaConnector();
    const result = await conn.fetchTransactions({
      account: { id: `solana:${REAL_ADDR}`, connectorId: "solana", label: "x", createdAt: 1 },
      credentials: { address: REAL_ADDR },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});
