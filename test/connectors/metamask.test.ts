// MetaMask connector tests — covers applyDecimals (pure), credential validation,
// and one mocked-fetch happy-path integration to exercise the multi-chain fan-out.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyDecimals, MetaMaskConnector } from "../../src/connectors/metamask.ts";
import { SUPPORTED_CHAINS } from "../../src/connectors/metamask-chains.ts";
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

  test("REGRESSION P2: free-tier chains (BSC, Base) are soft-skipped, free-tier chains still queried", async () => {
    // From burn-in: Tomi got "All chains failed" for chains 56 (BSC) + 8453 (Base)
    // because Etherscan V2 free tier doesn't cover them. Without this fix the
    // entire connector failed even though chains 1, 137, 42161, 10 would have worked.
    let ethCalls = 0;
    let polygonCalls = 0;
    let bscCalls = 0;
    let baseCalls = 0;
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("chainid=1&")) {
        ethCalls++;
        return new Response(JSON.stringify({ status: "1", message: "OK", result: "1000000000000000000" }), { status: 200 });
      }
      if (url.includes("chainid=137&")) {
        polygonCalls++;
        return new Response(JSON.stringify({ status: "1", message: "OK", result: "500000000000000000" }), { status: 200 });
      }
      if (url.includes("chainid=56&")) {
        bscCalls++;
        // Should never be called — BSC is non-free-tier and hasEtherscanPro=false default.
        return new Response(JSON.stringify({ status: "0", message: "NOTOK", result: "Free API access is not supported for this chain" }), { status: 200 });
      }
      if (url.includes("chainid=8453&")) {
        baseCalls++;
        return new Response(JSON.stringify({ status: "0", message: "NOTOK", result: "Free API access is not supported for this chain" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "1", message: "OK", result: "0" }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const result = await conn.fetchHoldings({
      account: { id: "metamask:0xabc", connectorId: "metamask", label: "x", createdAt: 1 },
      credentials: {
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "K",
        chainIds: [1, 137, 56, 8453],
        trackCommonTokens: false,
        // hasEtherscanPro intentionally false — default behavior
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should have ETH from chain 1 + POL from chain 137. BSC + Base soft-skipped.
      expect(result.value).toHaveLength(2);
      const symbols = result.value.map((h) => h.symbol).sort();
      expect(symbols).toEqual(["ETH", "POL"]);
      // Warnings should mention the skipped chains.
      const warnings = (result.value[0]!.metadata?.__chainWarnings as string[] | undefined) ?? [];
      expect(warnings.some((w) => w.includes("BNB Smart Chain"))).toBe(true);
      expect(warnings.some((w) => w.includes("Base"))).toBe(true);
    }
    // BSC and Base should never have been hit — they're filtered out before fetch.
    expect(bscCalls).toBe(0);
    expect(baseCalls).toBe(0);
    expect(ethCalls).toBeGreaterThan(0);
    expect(polygonCalls).toBeGreaterThan(0);
  });

  test("REGRESSION P2: hasEtherscanPro=true allows querying paid-tier chains", async () => {
    let bscCalls = 0;
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("chainid=56&")) {
        bscCalls++;
        return new Response(JSON.stringify({ status: "1", message: "OK", result: "1000000000000000000" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "1", message: "OK", result: "0" }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const result = await conn.fetchHoldings({
      account: { id: "metamask:0xabc", connectorId: "metamask", label: "x", createdAt: 1 },
      credentials: {
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "K",
        chainIds: [56],
        trackCommonTokens: false,
        hasEtherscanPro: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(bscCalls).toBe(1);
  });

  test("fetchTransactions: returns native + ERC-20 transfers from a chain", async () => {
    // Etherscan V2 returns native (txlist) and token (tokentx) actions separately;
    // fetchChainTransactions issues both and merges them. We verify both legs land
    // in the result with correct decoding (native uses chain decimals, token uses
    // tokenDecimal from the response).
    let txlistCalls = 0;
    let tokentxCalls = 0;
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("action=txlist")) {
        txlistCalls++;
        return new Response(JSON.stringify({
          status: "1", message: "OK", result: [
            {
              blockNumber: "19000000",
              timeStamp: "1700000000",
              hash: "0xnativehash",
              from: "0xabcdef1234567890abcdef1234567890abcdef12",
              to: "0xrecipient000000000000000000000000000000aa",
              value: "1000000000000000000",   // 1 ETH
              gasUsed: "21000",
              gasPrice: "20000000000",
              isError: "0",
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("action=tokentx")) {
        tokentxCalls++;
        return new Response(JSON.stringify({
          status: "1", message: "OK", result: [
            {
              blockNumber: "19000001",
              timeStamp: "1700000100",
              hash: "0xtokenhash",
              from: "0xsender0000000000000000000000000000000000",
              to: "0xabcdef1234567890abcdef1234567890abcdef12",
              value: "100000000",              // 100 USDC (6 decimals)
              contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
              tokenName: "USD Coin",
              tokenSymbol: "USDC",
              tokenDecimal: "6",
              gasUsed: "65000",
              gasPrice: "20000000000",
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "1", message: "OK", result: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const account: Account = {
      id: "metamask:0xabc",
      connectorId: "metamask",
      label: "Test",
      createdAt: 1,
    };
    const result = await conn.fetchTransactions({
      account,
      credentials: {
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "K",
        chainIds: [1],
        trackCommonTokens: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(txlistCalls).toBe(1);
    expect(tokentxCalls).toBe(1);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      const native = result.value.find((t) => t.symbol === "ETH");
      const usdc = result.value.find((t) => t.symbol === "USDC");
      expect(native).toBeDefined();
      expect(usdc).toBeDefined();
      expect(native!.quantity).toBe(1);
      expect(native!.type).toBe("withdraw");           // I sent it
      expect(native!.metadata?.asset).toBe("native");
      expect(usdc!.quantity).toBe(100);
      expect(usdc!.type).toBe("deposit");              // I received it
      expect(usdc!.fee).toBe(0);                        // recipient pays no fee
      expect(usdc!.metadata?.asset).toBe("erc20");
      expect(usdc!.metadata?.contract).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
      // ERC-20 txId disambiguates by contract to avoid clobbering native tx with same hash.
      expect(usdc!.txId).toContain("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    }
  });

  test("fetchTransactions: token-leg failure does NOT kill native data on the same chain", async () => {
    // Real-world: Etherscan tokentx call hits per-second rate limit while txlist
    // succeeded. We must still return the native txs rather than failing the whole chain.
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("action=txlist")) {
        return new Response(JSON.stringify({
          status: "1", message: "OK", result: [
            {
              blockNumber: "19000000", timeStamp: "1700000000",
              hash: "0xnative", from: "0xfrom", to: "0xabcdef1234567890abcdef1234567890abcdef12",
              value: "500000000000000000", gasUsed: "21000", gasPrice: "20000000000", isError: "0",
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("action=tokentx")) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({ status: "1", message: "OK", result: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const result = await conn.fetchTransactions({
      account: { id: "metamask:0xabc", connectorId: "metamask", label: "x", createdAt: 1 },
      credentials: {
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "K", chainIds: [1], trackCommonTokens: false,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.symbol).toBe("ETH");
    }
  });

  test("fetchTransactions: tokenDecimal=NaN entries are skipped", async () => {
    // Defensive parse: if Etherscan returns a malformed tokenDecimal we should
    // skip the row rather than emit NaN as quantity.
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("action=tokentx")) {
        return new Response(JSON.stringify({
          status: "1", message: "OK", result: [
            {
              blockNumber: "1", timeStamp: "1700000000", hash: "0xa",
              from: "0xfrom", to: "0xabcdef1234567890abcdef1234567890abcdef12",
              value: "1000", contractAddress: "0xc1",
              tokenName: "Bad", tokenSymbol: "BAD", tokenDecimal: "not-a-number",
              gasUsed: "1", gasPrice: "1",
            },
            {
              blockNumber: "2", timeStamp: "1700000001", hash: "0xb",
              from: "0xfrom", to: "0xabcdef1234567890abcdef1234567890abcdef12",
              value: "1000000", contractAddress: "0xc2",
              tokenName: "Good", tokenSymbol: "GOOD", tokenDecimal: "6",
              gasUsed: "1", gasPrice: "1",
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "1", message: "OK", result: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const result = await conn.fetchTransactions({
      account: { id: "metamask:0xabc", connectorId: "metamask", label: "x", createdAt: 1 },
      credentials: {
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "K", chainIds: [1], trackCommonTokens: false,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only GOOD survives; BAD's NaN decimals are filtered.
      const tokens = result.value.filter((t) => t.metadata?.asset === "erc20");
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.symbol).toBe("GOOD");
      expect(tokens[0]!.quantity).toBe(1);
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

  test("multi-wallet (addresses[]): fans out per-(address × chain), aggregates", async () => {
    // v0.8 #6 lift: one Account can carry several wallets sharing the same
    // Etherscan key. Verify the connector hits each address once per chain
    // and tags each holding's metadata.address with the right wallet.
    const calls: Array<{ address: string; chain: string }> = [];
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      const addr = url.searchParams.get("address")!;
      const chain = url.searchParams.get("chainid")!;
      calls.push({ address: addr.toLowerCase(), chain });
      // Different balance per address so we can tell them apart in the result.
      const wei = addr.toLowerCase() === "0xaaaa11111111111111111111111111111111aaaa".toLowerCase()
        ? "1000000000000000000"  // 1 ETH for wallet A
        : "2000000000000000000"; // 2 ETH for wallet B
      return new Response(JSON.stringify({ status: "1", message: "OK", result: wei }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const account: Account = { id: "metamask:multi", connectorId: "metamask", label: "Multi", createdAt: 1 };
    const result = await conn.fetchHoldings({
      account,
      credentials: {
        addresses: [
          "0xAAAa11111111111111111111111111111111aAAA",
          "0xBBBb22222222222222222222222222222222bBBB",
        ],
        etherscanApiKey: "K",
        chainIds: [1],
        trackCommonTokens: false,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 2 wallets × 1 chain = 2 native balance calls (no token fetches because
      // trackCommonTokens=false and no customTokens).
      expect(calls).toHaveLength(2);
      // 2 ETH holdings, one per wallet.
      expect(result.value).toHaveLength(2);
      const symbols = result.value.map((h) => h.symbol);
      expect(symbols).toEqual(["ETH", "ETH"]);
      const quantities = result.value.map((h) => h.quantity).sort();
      expect(quantities).toEqual([1, 2]);
      // Each holding's metadata.address points to the correct wallet.
      const addressesInResult = result.value.map((h) => (h.metadata?.address as string).toLowerCase()).sort();
      expect(addressesInResult).toEqual([
        "0xaaaa11111111111111111111111111111111aaaa",
        "0xbbbb22222222222222222222222222222222bbbb",
      ]);
    }
  });

  test("legacy single-address vault still works (auto-migration)", async () => {
    // v0.7.x users have credentials with `address` only (no `addresses`).
    // The connector must continue to work without manual migration.
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ status: "1", message: "OK", result: "1000000000000000000" }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const result = await conn.fetchHoldings({
      account: { id: "metamask:legacy", connectorId: "metamask", label: "Legacy", createdAt: 1 },
      credentials: {
        // Only legacy `address` field — NO `addresses`.
        address: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
        etherscanApiKey: "K",
        chainIds: [1],
        trackCommonTokens: false,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.metadata?.address).toBe("0xAbCdEf1234567890aBcDeF1234567890AbCdEf12");
    }
  });

  test("validateCredentials accepts addresses[] form", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ status: "1", message: "OK", result: "0" }), { status: 200 });
    }) as unknown as typeof fetch;

    const conn = new MetaMaskConnector();
    const result = await conn.validateCredentials({
      addresses: [
        "0xAAAa11111111111111111111111111111111aAAA",
        "0xBBBb22222222222222222222222222222222bBBB",
      ],
      etherscanApiKey: "K",
      chainIds: [1],
      trackCommonTokens: false,
    });
    expect(result.ok).toBe(true);
  });

  test("validateCredentials rejects empty addresses[] AND missing legacy address", async () => {
    const conn = new MetaMaskConnector();
    const result = await conn.validateCredentials({
      addresses: [],
      etherscanApiKey: "K",
      chainIds: [1],
      trackCommonTokens: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema_mismatch");
  });

  test("validateCredentials rejects malformed entry in addresses[]", async () => {
    const conn = new MetaMaskConnector();
    const result = await conn.validateCredentials({
      addresses: ["0xAAAa11111111111111111111111111111111aAAA", "not-an-address"],
      etherscanApiKey: "K",
      chainIds: [1],
      trackCommonTokens: false,
    });
    expect(result.ok).toBe(false);
  });
});
