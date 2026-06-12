// Security invariant: a connector's output must NEVER carry the credential.
//
// SECURITY.md claims the secret "never enters the model's context" — the MCP
// tools emit only normalized holdings, constructed field by field, never an
// upstream-response passthrough. This test enforces that claim as a regression
// guard. To make it adversarial, the mocked upstream *echoes the API key and
// secret back* in junk fields. A faithful connector reads only the fields it
// names and drops the rest, so the canaries must appear nowhere in the output.
//
// The day someone adds `metadata: { ...rawResponse }` to a connector — the exact
// failure mode that lets a secret (or an echoed secret) reach the model — this
// test goes red.
//
// Only Bybit and Binance take a secret. The other three connectors (MetaMask,
// Solana, Polymarket) authenticate with a PUBLIC on-chain address — there is no
// secret to leak — so they are intentionally out of scope here.

import { afterEach, describe, expect, test } from "bun:test";
import { BinanceConnector } from "../../src/connectors/binance.ts";
import { BybitConnector } from "../../src/connectors/bybit.ts";
import type { Account } from "../../src/types.ts";

const API_KEY = "LEAKCANARY_APIKEY_3f9ad17c0b42";
const API_SECRET = "LEAKCANARY_SECRET_8b2c5e0149af";

// Both canaries must appear nowhere in the serialized connector output, even
// though the (adversarial) upstream response echoes them straight back.
function assertNoLeak(serialized: string): void {
  expect(serialized).not.toContain(API_KEY);
  expect(serialized).not.toContain(API_SECRET);
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("security invariant: credential never appears in connector output", () => {
  test("Binance fetchHoldings drops an upstream that echoes the credential", async () => {
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/v3/account")) {
        // Adversarial: upstream echoes our key/secret in unexpected fields.
        return new Response(
          JSON.stringify({
            balances: [{ asset: "BTC", free: "0.5", locked: "0" }],
            canTrade: true,
            canWithdraw: false,
            accountType: "SPOT",
            echoedApiKey: API_KEY,
            debug: { signedWith: API_SECRET },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        return new Response(
          JSON.stringify([
            {
              symbol: "BTCUSDT",
              lastPrice: "60000",
              priceChangePercent: "1.0",
              note: `served-for-${API_KEY}`,
            },
          ]),
          { status: 200 }
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const account: Account = { id: "binance:canary", connectorId: "binance", label: "x", createdAt: 1 };
    const r = await new BinanceConnector().fetchHoldings({
      account,
      credentials: { apiKey: API_KEY, apiSecret: API_SECRET },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThan(0); // guard against a vacuously-empty pass
    assertNoLeak(JSON.stringify(r.value));
  });

  test("Bybit fetchHoldings drops an upstream that echoes the credential", async () => {
    globalThis.fetch = (async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes("wallet-balance")) {
        return new Response(
          JSON.stringify({
            retCode: 0,
            retMsg: "OK",
            echoedApiKey: API_KEY, // adversarial top-level echo
            result: {
              list: [
                {
                  accountType: "UNIFIED",
                  apiSecretEcho: API_SECRET, // adversarial nested echo
                  coin: [
                    {
                      coin: "BTC",
                      walletBalance: "0.5",
                      usdValue: "30000",
                      equity: "0.5",
                      unrealisedPnl: "0",
                      cumRealisedPnl: "0",
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: "OK", result: { list: [] } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const account: Account = { id: "bybit:canary", connectorId: "bybit", label: "x", createdAt: 1 };
    const r = await new BybitConnector().fetchHoldings({
      account,
      credentials: { apiKey: API_KEY, apiSecret: API_SECRET, accountType: "UNIFIED" },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThan(0);
    assertNoLeak(JSON.stringify(r.value));
  });
});
