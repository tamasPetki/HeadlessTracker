// Tests for the in-house Bybit V5 signed-fetch client that replaced the
// `bybit-api` SDK. The SDK call path was previously untestable without heavy
// module mocking (see bybit.test.ts header); a fetch-based client lets us pin
// the exact request the connector commits to, plus the full response parse.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { BybitRestClient } from "../../src/connectors/bybit-rest.ts";
import { BybitConnector } from "../../src/connectors/bybit.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Replace fetch with a recorder that returns `body` for every call.
function mockFetch(body: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
  globalThis.fetch = mock(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as { headers: Record<string, string> } });
    return {
      ok,
      status,
      statusText: ok ? "OK" : "ERR",
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("BybitRestClient.serializeParams", () => {
  test("insertion order, URI-encoded values, omits undefined/null", () => {
    expect(
      BybitRestClient.serializeParams({ accountType: "UNIFIED", startTime: undefined, limit: 50 })
    ).toBe("accountType=UNIFIED&limit=50");
    expect(BybitRestClient.serializeParams({ a: "x y", b: 1 })).toBe("a=x%20y&b=1");
    expect(BybitRestClient.serializeParams({ a: "x", b: null })).toBe("a=x");
  });
});

describe("BybitRestClient.sign", () => {
  test("HMAC-SHA256 hex over timestamp+key+recvWindow+query, in that order", () => {
    const expected = createHmac("sha256", "secret")
      .update("1700000000000" + "k" + "5000" + "accountType=UNIFIED")
      .digest("hex");
    expect(BybitRestClient.sign("secret", "1700000000000", "k", "5000", "accountType=UNIFIED")).toBe(expected);
  });
});

describe("BybitRestClient request shape", () => {
  test("getWalletBalance signs exactly what it sends, with the documented V5 headers", async () => {
    const calls = mockFetch({ retCode: 0, retMsg: "OK", result: { list: [] } });
    const client = new BybitRestClient({ key: "mykey", secret: "mysecret" });
    const resp = await client.getWalletBalance({ accountType: "UNIFIED" });

    expect(resp.retCode).toBe(0);
    expect(calls.length).toBe(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED");

    const h = init.headers;
    expect(h["X-BAPI-API-KEY"]).toBe("mykey");
    expect(h["X-BAPI-RECV-WINDOW"]).toBe("5000");
    expect(h["X-BAPI-SIGN-TYPE"]).toBe("2");
    expect(typeof h["X-BAPI-TIMESTAMP"]).toBe("string");

    // The sign must match an independent recomputation over the SAME query the
    // URL carries, using the SAME timestamp the client stamped.
    const expectedSign = createHmac("sha256", "mysecret")
      .update(h["X-BAPI-TIMESTAMP"]! + "mykey" + "5000" + "accountType=UNIFIED")
      .digest("hex");
    expect(h["X-BAPI-SIGN"]).toBe(expectedSign);
  });

  test("getTransactionLog omits undefined startTime from URL and signature", async () => {
    const calls = mockFetch({ retCode: 0, retMsg: "OK", result: { list: [] } });
    const client = new BybitRestClient({ key: "k", secret: "s" });
    await client.getTransactionLog({ accountType: "UNIFIED", startTime: undefined, limit: 50 });
    expect(calls[0]!.url).toBe("https://api.bybit.com/v5/account/transaction-log?accountType=UNIFIED&limit=50");
  });

  test("testnet routes to the testnet host", async () => {
    const calls = mockFetch({ retCode: 0, retMsg: "OK", result: { list: [] } });
    const client = new BybitRestClient({ key: "k", secret: "s", testnet: true });
    await client.getWalletBalance({ accountType: "SPOT" });
    expect(calls[0]!.url.startsWith("https://api-testnet.bybit.com/")).toBe(true);
  });

  test("maps a gateway HTTP 401 to an auth retCode (so it surfaces as auth_failed)", async () => {
    mockFetch({}, false, 401);
    const client = new BybitRestClient({ key: "bad", secret: "bad" });
    const r = await client.getWalletBalance({ accountType: "UNIFIED" });
    expect(r.retCode).toBe(10003);
  });

  test("throws on a 5xx transport failure", async () => {
    mockFetch({}, false, 503);
    const client = new BybitRestClient({ key: "k", secret: "s" });
    await expect(client.getWalletBalance({ accountType: "UNIFIED" })).rejects.toThrow(/Bybit HTTP 503/);
  });
});

describe("BybitConnector end-to-end parse via mocked fetch", () => {
  test("fetchHoldings parses wallet-balance JSON into Holdings and skips zero balances", async () => {
    mockFetch({
      retCode: 0,
      retMsg: "OK",
      result: {
        list: [
          {
            accountType: "UNIFIED",
            coin: [
              { coin: "BTC", walletBalance: "0.5", usdValue: "30000", equity: "0.5" },
              { coin: "ZERO", walletBalance: "0", usdValue: "0" },
            ],
          },
        ],
      },
    });
    const c = new BybitConnector();
    const ctx = {
      account: { id: "bybit:UNIFIED", connectorId: "bybit", label: "Bybit", createdAt: 0, metadata: {} },
      credentials: { apiKey: "k", apiSecret: "s", accountType: "UNIFIED" },
    } as unknown as Parameters<BybitConnector["fetchHoldings"]>[0];

    const res = await c.fetchHoldings(ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.length).toBe(1);
      expect(res.value[0]!.symbol).toBe("BTC");
      expect(res.value[0]!.quantity).toBe(0.5);
      expect(res.value[0]!.value).toBe(30000);
      expect(res.value[0]!.currentPrice).toBe(60000);
    }
  });

  test("fetchHoldings maps a non-zero retCode to an error", async () => {
    mockFetch({ retCode: 10003, retMsg: "API key is invalid", result: { list: [] } });
    const c = new BybitConnector();
    const ctx = {
      account: { id: "bybit:UNIFIED", connectorId: "bybit", label: "Bybit", createdAt: 0, metadata: {} },
      credentials: { apiKey: "bad", apiSecret: "bad", accountType: "UNIFIED" },
    } as unknown as Parameters<BybitConnector["fetchHoldings"]>[0];

    const res = await c.fetchHoldings(ctx);
    expect(res.ok).toBe(false);
  });
});
