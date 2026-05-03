// CoinGecko price service — spot + historical.
//
// Why this exists: connectors return holdings with the price the upstream API gave
// us at fetch time (e.g. Bybit ticker, Polymarket /positions). For time-windowed
// PnL ("how am I doing over the last 7 days?") we need historical prices, and
// for connectors that don't ship prices (some MetaMask paths) we need a spot
// price source. Both come from CoinGecko's free /simple/price + /coins/{id}/history.
//
// Design points:
//   - Static symbol → coin-id map (BTC → bitcoin) for the common cases. Unknown
//     symbol → null. No dynamic /coins/list lookup; HT's use case is the top ~50
//     assets, not arbitrary long-tail tokens.
//   - Result<T> + AbortSignal everywhere, matches the connector idiom.
//   - CoinGecko free tier is 5-15 req/sec. `getPrices()` deduplicates a batch
//     into one request. Historical prices are cached by date string in the
//     SQLite Cache (the past doesn't change, so 7-day TTL is safe).
//   - No prefetch / warm-up. Tools call when they need data.

import { Cache, defaultCache } from "./cache.ts";
import { err, ok, type Result } from "./types.ts";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const FETCH_TIMEOUT_MS = 10_000;
const SPOT_TTL_SEC = 60;
const HISTORICAL_TTL_SEC = 7 * 24 * 60 * 60;

// Module-internal cache namespace — separate from any ConnectorId so price cache
// entries don't show up under a connector's slot in `invalidate(connectorId)`.
// Cache.get/set/invalidate were widened to ConnectorId | string for this.
const CACHE_NS = "_prices";
function spotKey(coinId: string): string { return `spot:${coinId}`; }
function histKey(coinId: string, dateStr: string): string { return `hist:${coinId}:${dateStr}`; }
const MARKETS_CACHE_KEY = "markets:top250";
const MARKETS_TTL_SEC = 7 * 24 * 60 * 60;
const MARKETS_PAGE_SIZE = 250;

// Static symbol → CoinGecko id mapping. Curated for ambiguity-resolution and
// fast-path lookup: when multiple coins share a symbol on CoinGecko (e.g.
// "JUP" → Jupiter the Solana DEX vs "Jupiter Project" — different coins
// entirely), the static entry pins the one HT users actually mean. For
// symbols not in this map, the PriceService falls back to a cached
// /coins/markets top-250-by-market-cap lookup (7-day TTL) so the long tail
// is auto-resolved without manual maintenance. Add an entry here only when
// you need to override the dynamic resolution (e.g. ambiguous symbols where
// the highest-cap match isn't the right one).
const COINGECKO_IDS: Record<string, string> = {
  // Majors
  BTC: "bitcoin",
  WBTC: "wrapped-bitcoin",
  ETH: "ethereum",
  WETH: "weth",
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  // L1s
  SOL: "solana",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
  ADA: "cardano",
  DOT: "polkadot",
  XRP: "ripple",
  TON: "the-open-network",
  TRX: "tron",
  SUI: "sui",
  APT: "aptos",
  NEAR: "near",
  FTM: "fantom",
  CRO: "crypto-com-chain",
  ATOM: "cosmos",
  // L2s
  POL: "matic-network",
  MATIC: "matic-network",
  ARB: "arbitrum",
  OP: "optimism",
  // DeFi blue chips
  LINK: "chainlink",
  UNI: "uniswap",
  AAVE: "aave",
  // Resolutions for symbols where the highest-cap CoinGecko match collides
  // (we verified each on the search API; rank pinned to the right one).
  JUP: "jupiter-exchange-solana",        // not "jupiter" (Jupiter Project, rank 4399)
  HYPE: "hyperliquid",
  ENA: "ethena",
  DEEP: "deep",                           // DeepBook (Sui)
  PUMP: "pump-fun",                       // Pump.fun, not "pump" or "big-pump"
  SPEC: "spectral",
  MON: "monad",
  VVV: "venice-token",
};

export interface PriceData {
  usd: number;
  usd24hChange?: number;
  // epoch ms — when CoinGecko was queried (or cache hit timestamp)
  fetchedAt: number;
  source: "coingecko" | "cache";
}

// Synchronous static-only lookup. Used for the fast path where we don't want
// to await a network call (e.g. a hot tool handler). For full coverage including
// long-tail symbols, callers should use PriceService.resolveCoinId() which falls
// back to the cached top-250-by-market-cap list.
export function symbolToCoinGeckoId(symbol: string): string | null {
  return COINGECKO_IDS[symbol.toUpperCase()] ?? null;
}

// Shape of one row returned by /coins/markets (we only consume the fields we need).
interface CoinMarketRow {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
}

export interface PriceServiceOptions {
  cache?: Cache;
  apiKey?: string; // optional CoinGecko demo key; defaults to env COINGECKO_API_KEY
}

export class PriceService {
  private cache: Cache;
  private apiKey?: string;

  constructor(opts: PriceServiceOptions = {}) {
    this.cache = opts.cache ?? defaultCache();
    this.apiKey = opts.apiKey ?? process.env.COINGECKO_API_KEY;
  }

  // Resolve a symbol to a CoinGecko coin id. Two-tier:
  //   1. Static map (fast, deterministic, hand-curated for ambiguous symbols)
  //   2. Cached top-250-by-market-cap list (one upstream call, 7-day TTL)
  // Returns null when neither resolves. Honors AbortSignal end-to-end.
  //
  // Why top-250: covers the vast majority of what users actually hold in
  // exchange/wallet portfolios, and the /coins/markets endpoint returns the
  // rank info we need to pick the dominant coin when symbols collide. Outside
  // the top 250 (e.g. brand-new tokens, micro-caps), the user can extend
  // COINGECKO_IDS manually — that path stays open.
  async resolveCoinId(symbol: string, signal?: AbortSignal): Promise<string | null> {
    const upper = symbol.toUpperCase();
    const fromStatic = COINGECKO_IDS[upper];
    if (fromStatic) return fromStatic;
    const map = await this.loadMarketsMap(signal);
    return map?.[upper] ?? null;
  }

  // Internal: lazy-load top-250 coins by market cap, build symbol → id map,
  // cache in SQLite for 7 days. The /coins/markets endpoint returns coins
  // already sorted by market_cap_desc; for symbol collisions we keep the
  // first-seen entry (which is the highest-cap one).
  private async loadMarketsMap(signal?: AbortSignal): Promise<Record<string, string> | null> {
    const cached = this.cache.get<Record<string, string>>(CACHE_NS, MARKETS_CACHE_KEY);
    // For the markets snapshot, even "stale" data is far more useful than
    // nothing — the list of top-250 coins changes slowly, so we accept the
    // stale entry while refreshing in the background isn't worth the
    // complexity here. Treat any cache hit as good.
    if (cached) return cached.value;

    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${MARKETS_PAGE_SIZE}&page=1&sparkline=false`;
    const res = await this.fetch<CoinMarketRow[]>(url, signal);
    if (!res.ok) return null;
    // Defensive: CoinGecko sometimes returns an object on rate-limit instead
    // of an array even with a 200. Treat non-array as empty so we don't crash.
    if (!Array.isArray(res.value)) return null;

    const map: Record<string, string> = {};
    for (const row of res.value) {
      const sym = row.symbol?.toUpperCase();
      if (!sym) continue;
      // First-seen wins: rows are pre-sorted by market_cap_desc, so the
      // highest-cap coin for each symbol claims the slot.
      if (!map[sym]) map[sym] = row.id;
    }
    this.cache.set(CACHE_NS, MARKETS_CACHE_KEY, map, MARKETS_TTL_SEC);
    return map;
  }

  // Single-coin spot price. Returns null on cache miss + API failure (caller
  // decides whether to surface or fall back to connector-supplied price).
  async getPrice(coinId: string, signal?: AbortSignal): Promise<Result<PriceData | null>> {
    const cached = this.cache.get<PriceData>(CACHE_NS, spotKey(coinId));
    if (cached && !cached.stale) {
      return ok({ ...cached.value, source: "cache" });
    }
    const batch = await this.fetchSpot([coinId], signal);
    if (!batch.ok) return batch;
    return ok(batch.value[coinId] ?? null);
  }

  // Batched spot lookup. Deduplicates input coinIds. Honors cache hits and
  // only fetches the misses. Returns a record keyed by coinId — missing coins
  // are simply absent from the map (not present with a 0 value).
  async getPrices(
    coinIds: string[],
    signal?: AbortSignal
  ): Promise<Result<Record<string, PriceData>>> {
    const unique = Array.from(new Set(coinIds));
    const out: Record<string, PriceData> = {};
    const toFetch: string[] = [];

    for (const id of unique) {
      const cached = this.cache.get<PriceData>(CACHE_NS, spotKey(id));
      if (cached && !cached.stale) {
        out[id] = { ...cached.value, source: "cache" };
      } else {
        toFetch.push(id);
      }
    }

    if (toFetch.length === 0) return ok(out);

    const fresh = await this.fetchSpot(toFetch, signal);
    if (!fresh.ok) {
      // Partial failure: return whatever cache hits we already have, plus the error.
      // Caller can use Object.keys(out) to know which ones we got and decide.
      // For now we surface the error so the orchestrator can decide; if some
      // callers want partial-on-error, they can ignore err and read out via a
      // future variant. Keep the contract honest.
      return fresh;
    }
    for (const [k, v] of Object.entries(fresh.value)) out[k] = v;
    return ok(out);
  }

  // Historical price for a specific UTC date. CoinGecko historical endpoint
  // expects DD-MM-YYYY format. The past doesn't change, so we cache for 7 days
  // (long enough to amortize repeated queries; short enough to bound stale
  // CoinGecko data corrections).
  async getHistoricalPrice(
    coinId: string,
    date: Date,
    signal?: AbortSignal
  ): Promise<Result<number | null>> {
    const dateStr = formatDate(date);
    const key = histKey(coinId, dateStr);

    const cached = this.cache.get<number>(CACHE_NS, key);
    // Historical prices don't go stale meaningfully — even a "stale" cache hit
    // is correct since the past is immutable. We treat any cache hit as fresh
    // for historical, only re-fetching if the entry is missing entirely.
    if (cached !== null) {
      return ok(cached.value);
    }

    const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/history?date=${dateStr}&localization=false`;
    const res = await this.fetch<{ market_data?: { current_price?: { usd?: number } } }>(url, signal);
    if (!res.ok) return res;

    const price = res.value?.market_data?.current_price?.usd;
    if (typeof price !== "number" || !Number.isFinite(price)) {
      return ok(null);
    }
    this.cache.set(CACHE_NS, key, price, HISTORICAL_TTL_SEC);
    return ok(price);
  }

  // Internal: hit /simple/price for a list of coin ids in one request.
  private async fetchSpot(
    coinIds: string[],
    signal?: AbortSignal
  ): Promise<Result<Record<string, PriceData>>> {
    if (coinIds.length === 0) return ok({});
    const ids = coinIds.join(",");
    const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`;

    const res = await this.fetch<Record<string, { usd?: number; usd_24h_change?: number }>>(url, signal);
    if (!res.ok) return res;

    const now = Date.now();
    const out: Record<string, PriceData> = {};
    for (const id of coinIds) {
      const row = res.value[id];
      if (!row || typeof row.usd !== "number" || !Number.isFinite(row.usd)) continue;
      const data: PriceData = {
        usd: row.usd,
        usd24hChange: typeof row.usd_24h_change === "number" ? row.usd_24h_change : undefined,
        fetchedAt: now,
        source: "coingecko",
      };
      out[id] = data;
      this.cache.set(CACHE_NS, spotKey(id), data, SPOT_TTL_SEC);
    }
    return ok(out);
  }

  // Internal: timeout-bounded fetch returning Result<T>. Maps HTTP status codes
  // to ConnectorErrorKind so the orchestrator's error surfacing is uniform with
  // the other connectors.
  private async fetch<T>(url: string, externalSignal?: AbortSignal): Promise<Result<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const onCallerAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.apiKey) headers["x-cg-demo-api-key"] = this.apiKey;

      const res = await fetch(url, { signal: controller.signal, headers });
      if (res.status === 429) {
        return err("rate_limited", `CoinGecko rate-limited: ${url}`);
      }
      if (!res.ok) {
        return err("upstream_error", `CoinGecko HTTP ${res.status}: ${url}`);
      }
      const json = (await res.json()) as T;
      return ok(json);
    } catch (e) {
      const isAbort = e instanceof Error && e.name === "AbortError";
      return err(
        isAbort ? "network_timeout" : "network_error",
        `CoinGecko fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

// CoinGecko historical date format: DD-MM-YYYY in UTC.
function formatDate(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

// Module-level default singleton — most callers can just use `defaultPriceService()`.
let _defaultPriceService: PriceService | null = null;
export function defaultPriceService(): PriceService {
  if (!_defaultPriceService) {
    _defaultPriceService = new PriceService();
  }
  return _defaultPriceService;
}
