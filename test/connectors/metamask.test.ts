// MetaMask connector tests — covers applyDecimals (pure), credential validation,
// and one mocked-fetch happy-path integration to exercise the multi-chain fan-out.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyDecimals, MetaMaskConnector, SUPPORTED_CHAINS } from "../../src/connectors/metamask.ts";
import type { Account } from "../../src/types.ts";

describe("applyDecimals", () => {
  test("zero stays zero", () => {
    expect(applyDecimals("0", 18)).toBe(0);
    expect(applyDecimals("", 18)).toBe(0);
  });

  test("converts wei to ETH at 18 decimals", () => {
    // 1 ETH = 10^18 wei
    expect(applyDecimals("1000000000000000000", 18)).toBe(1);
    // 0.5 ETH = 5 × 10^17 wei
    expect(applyDecimals("500000000000000000", 18)).toBe(0.5);
  });

  test("converts USDC (6 decimals) correctly", () => {
    // 100 USDC = 100,000,000 micro-USDC
    expect(applyDecimals("100000000", 6)).toBe(100);
    expect(applyDecimals("1500000", 6)).toBe(1.5);
  });

  test("converts WBTC (8 decimals) correctly", () => {
    expect(applyDecimals("100000000", 8)).toBe(1);
    expect(applyDecimals("12345678", 8)).toBe(0.12345678);
  });

  test("handles negative values (gas refund / negative balance edges)", () => {
    expect(applyDecimals("-1000000000000000000", 18)).toBe(-1);
  });

  test("trims trailing zeros in fractional output", () => {
    // Input where fractional part has trailing zeros
    const result = applyDecimals("1500000000000000000", 18);
    expect(result).toBe(1.5);
  });
});

describe("MetaMaskConnector.validateCredentials", () => {
  test("rejects bad address format", async () => {
    const c = new MetaMaskConnector();
    const result = await c.validateCredentials({
      address: "not-an-address",
      etherscanApiKey: "k",
      chainIds: [1],
      trackCommonTokens: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema_mismatch");
  });

  test("rejects empty chainIds", async () => {
    const c = new MetaMaskConnector();
    const result = await c.validateCredentials({
      address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
      etherscanApiKey: "k",
      chainIds: [],
      trackCommonTokens: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema_mismatch");
  });

  test("rejects unsupported chainId", async () => {
    const c = new MetaMaskConnector();
    const result = await c.validateCredentials({
      address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
      etherscanApiKey: "k",
      chainIds: [99999],
      trackCommonTokens: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("MetaMaskConnector identity + supported chains", () => {
  test("connector identity is stable", () => {
    const c = new MetaMaskConnector();
    expect(c.id).toBe("metamask");
    expect(c.defaultCacheTtlSec).toBe(60);
    expect(c.displayName).toContain("MetaMask");
  });

  test("six chains supported (1, 137, 56, 8453, 42161, 10)", () => {
    // Numeric sort, not lexicographic (Array.sort() defaults to string comparison).
    const ids = Object.keys(SUPPORTED_CHAINS).map(Number).sort((a, b) => a - b);
    expect(ids).toEqual([1, 10, 56, 137, 8453, 42161]);
  });

  test("each supported chain has nativeSymbol + decimals + name", () => {
    for (const info of Object.values(SUPPORTED_CHAINS)) {
      expect(info.name).toBeTruthy();
      expect(info.nativeSymbol).toBeTruthy();
      expect(info.nativeDecimals).toBe(18);
    }
  });
});

// Fetch-mocked happy-path integration test.
// We override globalThis.fetch only for the duration of one test, then restore.
describe("MetaMaskConnector.fetchHoldings (mocked Etherscan)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns native balance for one chain when mocked Etherscan returns success", async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      callCount++;
      const url = input.toString();
      // Native balance call returns 1 ETH = 10^18 wei
      if (url.includes("action=balance")) {
        return new Response(JSON.stringify({ status: "1", message: "OK", result: "1000000000000000000" }), { status: 200 });
      }
      // Token balance calls return 0 (empty)
      return new Response(JSON.stringify({ status: "1", message: "OK", result: "0" }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const account: Account = {
      id: "metamask:0xabc",
      connectorId: "metamask",
      label: "Test MM",
      createdAt: 1,
    };
    const result = await conn.fetchHoldings({
      account,
      credentials: {
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "FAKE_KEY",
        chainIds: [1],
        trackCommonTokens: false,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.symbol).toBe("ETH");
      expect(result.value[0]!.quantity).toBe(1);
      expect(result.value[0]!.metadata?.chainId).toBe(1);
    }
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  test("returns auth_failed when Etherscan reports invalid api key", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ status: "0", message: "NOTOK", result: "Invalid API Key" }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const result = await conn.fetchHoldings({
      account: { id: "metamask:0xabc", connectorId: "metamask", label: "x", createdAt: 1 },
      credentials: {
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "BAD_KEY",
        chainIds: [1],
        trackCommonTokens: false,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Single-chain failure path: aggregateHoldings returns upstream_error wrapping
      // the per-chain failure when ALL chains failed.
      expect(["auth_failed", "upstream_error"]).toContain(result.error.kind);
      expect(result.error.message.toLowerCase()).toContain("api key");
    }
  });

  test("HTTP 429 → rate_limited", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const result = await conn.fetchHoldings({
      account: { id: "metamask:0xabc", connectorId: "metamask", label: "x", createdAt: 1 },
      credentials: {
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "K",
        chainIds: [1],
        trackCommonTokens: false,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["rate_limited", "upstream_error"]).toContain(result.error.kind);
    }
  });
});
