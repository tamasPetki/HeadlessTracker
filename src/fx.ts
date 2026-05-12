// Foreign exchange rate service.
//
// Why this exists: HeadlessTracker stores values in valueCurrency (USD/USDT mostly).
// Users who think in EUR/HUF want display conversion at query time. This module
// fetches USD-base rates from a free API (with one fallback) and gives callers a
// pure `convert()` for display layer.
//
// Design points:
//   - Pure functions over a fetched FxRates snapshot. No global state — caller
//     decides cache strategy.
//   - Result<T> error contract matches src/connectors/types.ts. No throws on
//     network failure; the caller decides whether to use stale or fallback.
//   - No Sentry, no telemetry, no Next.js fetch hints. Plain fetch + AbortSignal.
//   - HUF is included on purpose: maintainer's local currency.

import { err, ok, type Result } from "./types.ts";

export type Currency = "USD" | "EUR" | "GBP" | "HUF";

export const SUPPORTED_CURRENCIES: readonly Currency[] = ["USD", "EUR", "GBP", "HUF"] as const;

export interface FxRates {
  // All rates expressed as 1 USD = N units of <Currency>. USD is always 1.
  USD: number;
  EUR: number;
  GBP: number;
  HUF: number;
  // epoch ms when the rates were fetched / sourced (NOT when the API last updated).
  fetchedAt: number;
  // "exchangerate-api" | "frankfurter" | "fallback" — for the caller to surface
  // a "rates may be stale" badge if needed.
  source: FxSource;
}

export type FxSource = "exchangerate-api" | "frankfurter" | "fallback";

// Hard-coded fallback rates — used when both upstream APIs fail. Picked from the
// approximate market on 2026-04-01; the caller should treat `source: "fallback"`
// as "rates are weeks/months stale, may be wrong by a few percent". The point is
// to never fabricate near-current rates while pretending they're current.
const FALLBACK_RATES: FxRates = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  HUF: 380,
  fetchedAt: 0,
  source: "fallback",
};

const PRIMARY_URL = "https://api.exchangerate-api.com/v4/latest/USD";
const FALLBACK_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,HUF";

const FETCH_TIMEOUT_MS = 8000;

interface ExchangerateApiResponse {
  rates: { EUR?: number; GBP?: number; HUF?: number };
}

interface FrankfurterResponse {
  rates: { EUR?: number; GBP?: number; HUF?: number };
}

// Fetch live rates. Tries primary first, falls back to frankfurter.dev on any
// failure. If both fail, returns FALLBACK_RATES with `source: "fallback"`.
// Result is always ok() — the caller decides whether stale fallback is usable.
export async function fetchFxRates(signal?: AbortSignal): Promise<Result<FxRates>> {
  const primary = await tryFetch<ExchangerateApiResponse>(PRIMARY_URL, signal);
  if (primary.ok) {
    const r = primary.value.rates;
    if (isCompleteRates(r)) {
      return ok({
        USD: 1,
        EUR: r.EUR!,
        GBP: r.GBP!,
        HUF: r.HUF!,
        fetchedAt: Date.now(),
        source: "exchangerate-api",
      });
    }
  }

  const fallback = await tryFetch<FrankfurterResponse>(FALLBACK_URL, signal);
  if (fallback.ok) {
    const r = fallback.value.rates;
    if (isCompleteRates(r)) {
      return ok({
        USD: 1,
        EUR: r.EUR!,
        GBP: r.GBP!,
        HUF: r.HUF!,
        fetchedAt: Date.now(),
        source: "frankfurter",
      });
    }
  }

  return ok({ ...FALLBACK_RATES, fetchedAt: Date.now() });
}

function isCompleteRates(r: { EUR?: number; GBP?: number; HUF?: number }): boolean {
  return (
    typeof r.EUR === "number" && Number.isFinite(r.EUR) && r.EUR > 0 &&
    typeof r.GBP === "number" && Number.isFinite(r.GBP) && r.GBP > 0 &&
    typeof r.HUF === "number" && Number.isFinite(r.HUF) && r.HUF > 0
  );
}

// Convert a value from one currency to another using the supplied snapshot.
// Pure — does not fetch. Round-trip USD via the snapshot.
export function convert(amount: number, from: Currency, to: Currency, rates: FxRates): number {
  if (from === to) return amount;
  // Convert source → USD → target.
  const usdAmount = from === "USD" ? amount : amount / rates[from];
  return to === "USD" ? usdAmount : usdAmount * rates[to];
}

// Convenience: get the rate from USD to target. 1 USD = N target.
export function rateFromUsd(target: Currency, rates: FxRates): number {
  return rates[target];
}

// Internal: timeout-bounded fetch returning Result<T>. Network-level errors
// don't propagate — the orchestrator above tries the next source.
async function tryFetch<T>(url: string, externalSignal?: AbortSignal): Promise<Result<T>> {
  // Short-circuit if the caller already cancelled before we even start this attempt.
  // Without this check, an already-aborted signal won't re-fire its "abort" event
  // for a newly registered listener, causing the fetch to hang until FETCH_TIMEOUT_MS.
  if (externalSignal?.aborted) {
    return err("network_timeout", `${url} → aborted`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // If caller passed a signal, abort the inner fetch when they abort.
  const onCallerAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return err("upstream_error", `${url} → HTTP ${res.status}`);
    }
    const json = (await res.json()) as T;
    return ok(json);
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    return err(
      isAbort ? "network_timeout" : "network_error",
      `${url} → ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onCallerAbort);
  }
}
