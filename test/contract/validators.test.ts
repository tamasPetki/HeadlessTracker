// Tests for the upstream-contract canary's pure validators.
//
// These run in normal `bun test` (no network — the live runner is guarded by
// `import.meta.main`, so importing the script here is side-effect free). They
// pin the contract in both directions: the validators must ACCEPT the shape we
// currently parse, and REJECT the shapes that have actually drifted on us.
//
// The headline case is `validateJupiterV3` against the retired v2 shape: that is
// the regression test for the v1.0.13 "$0 Solana balance" bug. If someone ever
// "simplifies" the validator and stops rejecting the data-wrapped v2 shape, this
// test fails — and the canary that would catch the next such migration stays
// honest.

import { describe, expect, test } from "bun:test";
import {
  validateJupiterV3,
  validateCoinGeckoSimplePrice,
  validateCoinGeckoMarkets,
  validateCoinGeckoHistory,
  validateSolanaGetBalance,
  validateSolanaTokenAccounts,
  validatePolymarketPositions,
  validateFxRates,
  validateBybitEnvelope,
  validateBinanceTicker,
  classify,
} from "../../scripts/contract-check.ts";

const okVerdict = () => ({ ok: true, detail: "shape ok" });
const badVerdict = () => ({ ok: false, detail: "shape WRONG" });

const WSOL = "So11111111111111111111111111111111111111112";

describe("validateJupiterV3", () => {
  test("accepts the current v3 flat shape", () => {
    expect(validateJupiterV3({ [WSOL]: { usdPrice: 142.5, priceChange24h: -1.2 } }, WSOL).ok).toBe(true);
  });

  // The actual bug: v2 nested under `data` with a STRING price. The connector
  // read `usdPrice` off the top-level mint key and got undefined -> $0 values.
  test("REJECTS the retired v2 data-wrapped shape (the $0-bug regression)", () => {
    const v2 = { data: { [WSOL]: { id: WSOL, type: "derivedPrice", price: "142.5" } } };
    const v = validateJupiterV3(v2, WSOL);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("v2");
  });

  test("rejects a non-numeric usdPrice", () => {
    expect(validateJupiterV3({ [WSOL]: { usdPrice: "142.5" } }, WSOL).ok).toBe(false);
  });

  test("rejects a missing mint entry", () => {
    expect(validateJupiterV3({ SomeOtherMint: { usdPrice: 1 } }, WSOL).ok).toBe(false);
  });
});

describe("validateCoinGeckoSimplePrice", () => {
  test("accepts { id: { usd } }", () => {
    expect(validateCoinGeckoSimplePrice({ bitcoin: { usd: 64000, usd_24h_change: 2.1 } }, "bitcoin").ok).toBe(true);
  });
  test("rejects missing usd", () => {
    expect(validateCoinGeckoSimplePrice({ bitcoin: { usd_24h_change: 2.1 } }, "bitcoin").ok).toBe(false);
  });
});

describe("validateCoinGeckoMarkets", () => {
  test("accepts an array of rows with id/symbol/market_cap_rank", () => {
    expect(validateCoinGeckoMarkets([{ id: "bitcoin", symbol: "btc", market_cap_rank: 1 }]).ok).toBe(true);
  });
  test("rejects a non-array (the rate-limit object CoinGecko sometimes returns)", () => {
    expect(validateCoinGeckoMarkets({ status: { error_code: 429 } }).ok).toBe(false);
  });
  test("rejects rows missing market_cap_rank", () => {
    expect(validateCoinGeckoMarkets([{ id: "bitcoin", symbol: "btc" }]).ok).toBe(false);
  });
});

describe("validateCoinGeckoHistory", () => {
  test("accepts nested market_data.current_price.usd", () => {
    expect(validateCoinGeckoHistory({ market_data: { current_price: { usd: 42000 } } }).ok).toBe(true);
  });
  test("rejects a flattened shape", () => {
    expect(validateCoinGeckoHistory({ current_price: { usd: 42000 } }).ok).toBe(false);
  });
});

describe("validateSolanaGetBalance", () => {
  test("accepts result.value as lamports number (0 is valid — unfunded)", () => {
    expect(validateSolanaGetBalance({ context: { slot: 1 }, value: 0 }).ok).toBe(true);
  });
  test("rejects a missing value", () => {
    expect(validateSolanaGetBalance({ context: { slot: 1 } }).ok).toBe(false);
  });
});

describe("validateSolanaTokenAccounts", () => {
  test("accepts an empty wallet (envelope only)", () => {
    expect(validateSolanaTokenAccounts({ value: [] }).ok).toBe(true);
  });
  test("accepts the jsonParsed item shape", () => {
    const item = {
      pubkey: "x",
      account: { data: { parsed: { info: { mint: "Es9v...", tokenAmount: { amount: "1", decimals: 6, uiAmount: 1.0, uiAmountString: "1" } } } } },
    };
    expect(validateSolanaTokenAccounts({ value: [item] }).ok).toBe(true);
  });
  test("rejects an item missing the parsed.info path", () => {
    expect(validateSolanaTokenAccounts({ value: [{ pubkey: "x", account: { data: "base64blob" } }] }).ok).toBe(false);
  });
  test("rejects a non-array value", () => {
    expect(validateSolanaTokenAccounts({ value: {} }).ok).toBe(false);
  });
});

describe("validatePolymarketPositions", () => {
  test("accepts an empty wallet (envelope only)", () => {
    expect(validatePolymarketPositions([]).ok).toBe(true);
  });
  test("accepts a position with the consumed fields", () => {
    expect(validatePolymarketPositions([{ size: 100, curPrice: 0.62, title: "Will X happen?", outcome: "Yes" }]).ok).toBe(true);
  });
  test("rejects a position missing a consumed field", () => {
    expect(validatePolymarketPositions([{ size: 100, curPrice: 0.62, title: "Will X happen?" }]).ok).toBe(false);
  });
  test("rejects a non-array", () => {
    expect(validatePolymarketPositions({ positions: [] }).ok).toBe(false);
  });
});

describe("validateFxRates", () => {
  test("accepts { rates: { EUR, GBP, HUF } }", () => {
    expect(validateFxRates({ rates: { EUR: 0.92, GBP: 0.79, HUF: 360 } }).ok).toBe(true);
  });
  test("rejects a missing currency", () => {
    expect(validateFxRates({ rates: { EUR: 0.92, GBP: 0.79 } }).ok).toBe(false);
  });
});

describe("validateBybitEnvelope", () => {
  test("accepts { retCode: 0, result: { list: [] } }", () => {
    expect(validateBybitEnvelope({ retCode: 0, retMsg: "OK", result: { list: [{ symbol: "BTCUSDT" }] } }).ok).toBe(true);
  });
  test("rejects a non-zero retCode", () => {
    expect(validateBybitEnvelope({ retCode: 10001, result: { list: [] } }).ok).toBe(false);
  });
  test("rejects a non-array result.list", () => {
    expect(validateBybitEnvelope({ retCode: 0, result: { list: {} } }).ok).toBe(false);
  });
});

describe("validateBinanceTicker", () => {
  test("accepts { symbol, price: numeric-string }", () => {
    expect(validateBinanceTicker({ symbol: "BTCUSDT", price: "64000.50" }).ok).toBe(true);
  });
  test("rejects a numeric (non-string) price", () => {
    expect(validateBinanceTicker({ symbol: "BTCUSDT", price: 64000.5 }).ok).toBe(false);
  });
});

// The failure-philosophy classifier. The headline guard is that a keyless 401/403
// stays WARN, not FAIL — the regression test for the 2026-06 false alarm, where a
// shared-CI rate-limit 401 was misread as "CoinGecko moved history behind a key."
describe("classify (canary failure philosophy)", () => {
  test("2xx + correct shape -> PASS", () => {
    expect(classify({ status: 200 }, okVerdict).status).toBe("PASS");
  });
  test("2xx + WRONG shape -> FAIL (the genuine-drift signal)", () => {
    const c = classify({ status: 200 }, badVerdict);
    expect(c.status).toBe("FAIL");
    expect(c.detail).toContain("WRONG");
  });
  test("404 / 410 (endpoint gone) -> FAIL", () => {
    expect(classify({ status: 404 }, okVerdict).status).toBe("FAIL");
    expect(classify({ status: 410 }, okVerdict).status).toBe("FAIL");
  });
  test("401 / 403 on a keyless endpoint -> WARN, never FAIL (false-alarm regression)", () => {
    for (const status of [401, 403]) {
      const c = classify({ status }, badVerdict); // even with a bad verdict, the 4xx short-circuits
      expect(c.status).toBe("WARN");
      expect(c.detail).toContain("throttle");
    }
  });
  test("429 (rate-limited) -> WARN", () => {
    expect(classify({ status: 429 }, okVerdict).status).toBe("WARN");
  });
  test("network error -> WARN", () => {
    expect(classify({ status: 0, netErr: "ECONNRESET" }, okVerdict).status).toBe("WARN");
  });
  test("other non-2xx (e.g. 500) -> WARN", () => {
    expect(classify({ status: 500 }, okVerdict).status).toBe("WARN");
  });
});
