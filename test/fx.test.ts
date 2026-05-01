// FX rate service tests — mocked fetch, no network.
// Covers: primary success path, primary fail → fallback, both fail → static fallback,
//   convert() round-trip, AbortSignal propagation.

import { afterEach, describe, expect, test } from "bun:test";
import {
  convert,
  fetchFxRates,
  rateFromUsd,
  SUPPORTED_CURRENCIES,
  type Currency,
  type FxRates,
} from "../src/fx.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fx.fetchFxRates", () => {
  test("primary API success → exchangerate-api source", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ rates: { EUR: 0.93, GBP: 0.78, HUF: 365 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const r = await fetchFxRates();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toBe("exchangerate-api");
      expect(r.value.USD).toBe(1);
      expect(r.value.EUR).toBe(0.93);
      expect(r.value.GBP).toBe(0.78);
      expect(r.value.HUF).toBe(365);
      expect(r.value.fetchedAt).toBeGreaterThan(0);
    }
  });

  test("primary fails → fallback (frankfurter) succeeds", async () => {
    let call = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      call++;
      if (call === 1) {
        return new Response("upstream broken", { status: 503 });
      }
      return new Response(
        JSON.stringify({ rates: { EUR: 0.91, GBP: 0.80, HUF: 390 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const r = await fetchFxRates();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toBe("frankfurter");
      expect(r.value.HUF).toBe(390);
    }
    expect(call).toBe(2);
  });

  test("both APIs fail → static fallback with source='fallback'", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("nope", { status: 502 });
    }) as unknown as typeof fetch;

    const r = await fetchFxRates();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toBe("fallback");
      // Defaults from src/fx.ts FALLBACK_RATES.
      expect(r.value.EUR).toBe(0.92);
      expect(r.value.HUF).toBe(380);
    }
  });

  test("primary returns malformed rates → falls through to fallback API", async () => {
    let call = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      call++;
      if (call === 1) {
        // Missing HUF — incomplete; should reject and try fallback.
        return new Response(JSON.stringify({ rates: { EUR: 0.93, GBP: 0.78 } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ rates: { EUR: 0.91, GBP: 0.80, HUF: 390 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const r = await fetchFxRates();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toBe("frankfurter");
    }
  });

  test("AbortSignal propagates to fetch", async () => {
    const controller = new AbortController();
    let fetchCallCount = 0;
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
      fetchCallCount++;
      // Simulate a hung fetch that respects the signal.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }) as unknown as typeof fetch;

    const promise = fetchFxRates(controller.signal);
    controller.abort();
    const r = await promise;
    // Both upstream attempts abort → fallback rates.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toBe("fallback");
    }
    expect(fetchCallCount).toBeGreaterThan(0);
  });
});

describe("fx.convert", () => {
  const rates: FxRates = {
    USD: 1,
    EUR: 0.92,
    GBP: 0.79,
    HUF: 380,
    fetchedAt: 1000,
    source: "exchangerate-api",
  };

  test("USD → USD is identity", () => {
    expect(convert(100, "USD", "USD", rates)).toBe(100);
  });

  test("USD → HUF multiplies", () => {
    expect(convert(100, "USD", "HUF", rates)).toBeCloseTo(38000, 6);
  });

  test("HUF → USD divides", () => {
    expect(convert(38000, "HUF", "USD", rates)).toBeCloseTo(100, 6);
  });

  test("EUR → HUF round-trips via USD", () => {
    // 100 EUR / 0.92 = 108.7 USD; × 380 = 41304 HUF.
    expect(convert(100, "EUR", "HUF", rates)).toBeCloseTo(100 / 0.92 * 380, 4);
  });

  test("rateFromUsd returns the underlying rate", () => {
    expect(rateFromUsd("HUF", rates)).toBe(380);
    expect(rateFromUsd("USD", rates)).toBe(1);
  });
});

describe("fx.SUPPORTED_CURRENCIES", () => {
  test("includes the four expected currencies", () => {
    const expected: Currency[] = ["USD", "EUR", "GBP", "HUF"];
    for (const c of expected) {
      expect(SUPPORTED_CURRENCIES).toContain(c);
    }
    expect(SUPPORTED_CURRENCIES).toHaveLength(4);
  });
});
