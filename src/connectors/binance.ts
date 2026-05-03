// Binance connector — read-only Spot + (optional) Futures account tracking.
// Uses Binance's public REST API with HMAC-SHA256 signing for the signed endpoints.
//
// V0.13 scope:
//   - Spot balances via GET /api/v3/account (signed, weight=20)
//   - USD/USDT prices via GET /api/v3/ticker/24hr?type=MINI (one batch call)
//   - Optional Futures wallet balance + open positions via GET /fapi/v2/account
//     (signed). Opt-in via creds.includeFutures — many users only have spot, and
//     /fapi/v2/account 401s if the API key lacks futures permission. We treat
//     that 401 as a soft skip with a metadata warning, NOT a hard fetch failure.
//   - Stablecoins (USDT/USDC/BUSD/FDUSD/TUSD/DAI) priced at $1.
//   - Non-stable coins: priced via the user's actual holdings only — we batch the
//     symbols we need rather than fetching the whole 1500-pair ticker.
//
// V0.14+ deferred:
//   - fetchTransactions (per-symbol /myTrades calls — same rate-limit pain as
//     Solana sigs; needs careful weight budgeting)
//   - Earn / Trading Bots / Funding sub-wallets (separate /sapi/v1/asset/wallet/balance call)
//   - Margin account (/sapi/v1/margin/account)
//
// API docs:
//   - Spot REST: https://developers.binance.com/docs/binance-spot-api-docs
//   - Futures REST: https://developers.binance.com/docs/derivatives/usds-margined-futures
//   - HMAC signing: query string + body, secret key, return hex digest

import { createHmac } from "node:crypto";

import type { Connector, ConnectorContext, ConnectorCredentials } from "./types.ts";
import type { Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";

const SPOT_BASE = "https://api.binance.com";
const FUTURES_BASE = "https://fapi.binance.com";

// Treat these symbols as $1 — Binance gives us BTCUSDT prices but no
// USDTUSDT pair to look up. List is conservative; add new ones as needed.
const STABLECOINS = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP", "USDS"]);

// recvWindow in milliseconds. Binance accepts the request if
// (server_time - request_time) <= recvWindow. Our default of 5s covers the
// common case (loopback latency + clock skew); users on slow networks can
// override via creds.recvWindow.
const DEFAULT_RECV_WINDOW = 5000;

interface BinanceCreds extends ConnectorCredentials {
  apiKey: string;
  apiSecret: string;
  // If true, also fetch /fapi/v2/account (USD-margined futures wallet balance).
  // Default false — many spot-only users have API keys without futures perms,
  // and a 401 there shouldn't break holdings retrieval. When enabled and the
  // key DOES lack futures perms, we soft-skip with a metadata warning.
  includeFutures?: boolean;
  // Custom recvWindow (ms). Default 5000.
  recvWindow?: number;
}

function isBinanceCreds(c: ConnectorCredentials): c is BinanceCreds {
  return (
    typeof c.apiKey === "string" &&
    c.apiKey.length > 0 &&
    typeof c.apiSecret === "string" &&
    c.apiSecret.length > 0
  );
}

function sign(queryString: string, secret: string): string {
  return createHmac("sha256", secret).update(queryString).digest("hex");
}

interface SignedRequestOptions {
  base: string;
  path: string;
  apiKey: string;
  apiSecret: string;
  params?: Record<string, string | number>;
  recvWindow?: number;
  signal?: AbortSignal;
}

// Issue a signed GET request to a Binance endpoint. Returns the parsed JSON
// body OR a typed Result error mapped to our ConnectorError kinds.
async function signedGet<T>(opts: SignedRequestOptions): Promise<Result<T>> {
  const params = new URLSearchParams();
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      params.set(k, String(v));
    }
  }
  params.set("timestamp", String(Date.now()));
  params.set("recvWindow", String(opts.recvWindow ?? DEFAULT_RECV_WINDOW));

  const signature = sign(params.toString(), opts.apiSecret);
  params.set("signature", signature);

  const url = `${opts.base}${opts.path}?${params.toString()}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { "X-MBX-APIKEY": opts.apiKey },
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return err("network_timeout", "Binance request aborted");
    }
    return err("network_error", `Binance fetch failed: ${(e as Error).message}`, { cause: e });
  }

  if (!resp.ok) {
    // Binance returns JSON `{ code, msg }` for most errors with body.
    let body: { code?: number; msg?: string } = {};
    try {
      body = (await resp.json()) as { code?: number; msg?: string };
    } catch {
      // Non-JSON body (rare, e.g. CDN error page)
    }
    const msg = body.msg ?? `HTTP ${resp.status}`;

    if (resp.status === 429 || resp.status === 418) {
      // 418 = IP banned for repeated 429s. Treat as rate_limited so the cache
      // fallback path kicks in — there's nothing else we can do client-side.
      return err("rate_limited", `Binance rate limit hit: ${msg}`);
    }
    if (resp.status === 401 || body.code === -2014 || body.code === -2015) {
      return err("auth_failed", `Binance auth failed (HTTP ${resp.status}): ${msg}`);
    }
    if (resp.status === 403) {
      // 403 most often means "WAF blocked" or "geo restricted" or "key
      // permission denied". Map to auth_failed for clarity.
      return err("auth_failed", `Binance access forbidden: ${msg}`);
    }
    return err("upstream_error", `Binance HTTP ${resp.status}: ${msg}`);
  }

  let json: T;
  try {
    json = (await resp.json()) as T;
  } catch (e) {
    return err("schema_mismatch", "Binance returned non-JSON body", { cause: e });
  }
  return ok(json);
}

// Public (unsigned) GET — used for the ticker endpoint.
async function publicGet<T>(
  base: string,
  path: string,
  signal?: AbortSignal
): Promise<Result<T>> {
  let resp: Response;
  try {
    resp = await fetch(`${base}${path}`, { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return err("network_timeout", "Binance public request aborted");
    }
    return err("network_error", `Binance public fetch failed: ${(e as Error).message}`, { cause: e });
  }
  if (!resp.ok) {
    if (resp.status === 429 || resp.status === 418) {
      return err("rate_limited", `Binance rate limit hit: HTTP ${resp.status}`);
    }
    return err("upstream_error", `Binance public HTTP ${resp.status}`);
  }
  try {
    return ok((await resp.json()) as T);
  } catch (e) {
    return err("schema_mismatch", "Binance public returned non-JSON", { cause: e });
  }
}

interface SpotBalance {
  asset: string;
  free: string;
  locked: string;
}
interface SpotAccountResponse {
  balances: SpotBalance[];
  // Account-level flags (NOT API key permissions — these tell you whether the
  // account itself can trade, which is unrelated to read-only key scope).
  canTrade: boolean;
  canWithdraw: boolean;
  accountType: string;
}

interface TickerMini {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
}

interface FuturesAsset {
  asset: string;
  walletBalance: string;
  unrealizedProfit: string;
  marginBalance: string;
  availableBalance: string;
}
interface FuturesPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string;
  marginType: string;
  liquidationPrice: string;
  notional: string;
}
interface FuturesAccountResponse {
  assets?: FuturesAsset[];
  positions?: FuturesPosition[];
  totalWalletBalance?: string;
  totalUnrealizedProfit?: string;
}

// Fetch USDT-quoted prices for the given assets in one call. Stablecoins are
// priced at $1 and skipped from the API call. Returns a Map<asset, price>.
async function fetchAssetPrices(
  nonStableAssets: string[],
  signal?: AbortSignal
): Promise<{ prices: Map<string, number>; changes: Map<string, number>; warning?: string }> {
  const prices = new Map<string, number>();
  const changes = new Map<string, number>();

  if (nonStableAssets.length === 0) {
    return { prices, changes };
  }

  const symbols = nonStableAssets.map((a) => `${a}USDT`);
  // Batch-symbol endpoint: weight 2 for ≤20, 40 for ≤100. Above 100 we'd need
  // multiple batches OR fall back to the all-symbols endpoint (weight 80).
  // For wallets with >100 distinct assets, fall back.
  let path: string;
  if (symbols.length <= 100) {
    const symbolsParam = JSON.stringify(symbols);
    path = `/api/v3/ticker/24hr?type=MINI&symbols=${encodeURIComponent(symbolsParam)}`;
  } else {
    path = `/api/v3/ticker/24hr?type=MINI`;
  }

  const res = await publicGet<TickerMini[]>(SPOT_BASE, path, signal);
  if (!res.ok) {
    return {
      prices,
      changes,
      warning: `Failed to fetch ticker (${res.error.kind}: ${res.error.message}); USD values may be missing`,
    };
  }
  for (const t of res.value) {
    if (!t.symbol.endsWith("USDT")) continue;
    const asset = t.symbol.slice(0, -4);
    const p = parseFloat(t.lastPrice);
    const c = parseFloat(t.priceChangePercent);
    if (Number.isFinite(p) && p > 0) prices.set(asset, p);
    if (Number.isFinite(c)) changes.set(asset, c);
  }
  return { prices, changes };
}

export class BinanceConnector implements Connector {
  readonly id = "binance" as const;
  readonly displayName = "Binance (Spot + optional Futures)";
  readonly defaultCacheTtlSec = 120;

  async validateCredentials(
    creds: ConnectorCredentials,
    signal?: AbortSignal
  ): Promise<Result<void>> {
    if (!isBinanceCreds(creds)) {
      return err(
        "schema_mismatch",
        "Binance credentials must include { apiKey, apiSecret }"
      );
    }
    // Cheapest reachability check: signed /api/v3/account (weight 20).
    // This is also what we'll call in fetchHoldings, so success here = success there.
    const res = await signedGet<SpotAccountResponse>({
      base: SPOT_BASE,
      path: "/api/v3/account",
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      params: { omitZeroBalances: "true" },
      recvWindow: creds.recvWindow,
      signal,
    });
    if (!res.ok) return res;
    return ok(undefined);
  }

  async fetchHoldings(ctx: ConnectorContext): Promise<Result<Holding[]>> {
    if (!isBinanceCreds(ctx.credentials)) {
      return err("schema_mismatch", "Binance credentials malformed");
    }
    const creds = ctx.credentials;
    const now = Date.now();

    const spotRes = await signedGet<SpotAccountResponse>({
      base: SPOT_BASE,
      path: "/api/v3/account",
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      params: { omitZeroBalances: "true" },
      recvWindow: creds.recvWindow,
      signal: ctx.signal,
    });
    if (!spotRes.ok) return spotRes;

    // Aggregate Spot first, then optionally append Futures wallet balances.
    const nonZeroSpot = (spotRes.value.balances ?? []).filter((b) => {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      return free > 0 || locked > 0;
    });

    // Collect non-stable assets we need USDT prices for. Spot + futures assets
    // are merged into one ticker call to amortize the weight cost.
    const assetsNeedingPrice = new Set<string>();
    for (const b of nonZeroSpot) {
      if (!STABLECOINS.has(b.asset)) assetsNeedingPrice.add(b.asset);
    }

    // Optional Futures fetch: do BEFORE pricing so we can include futures
    // assets in the same ticker batch.
    let futuresAssets: FuturesAsset[] = [];
    let futuresPositions: FuturesPosition[] = [];
    let futuresSkipReason: string | null = null;
    if (creds.includeFutures) {
      const futRes = await signedGet<FuturesAccountResponse>({
        base: FUTURES_BASE,
        path: "/fapi/v2/account",
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        recvWindow: creds.recvWindow,
        signal: ctx.signal,
      });
      if (!futRes.ok) {
        // Soft-skip: futures perms missing or futures disabled.
        // Hard auth_failed on the spot side already short-circuited above —
        // a futures-only auth_failed here just means the key isn't authorized
        // for derivatives, which is common.
        if (futRes.error.kind === "auth_failed") {
          futuresSkipReason = `Futures soft-skipped: ${futRes.error.message}. Either disable includeFutures or grant the API key futures read.`;
        } else {
          // Network/upstream errors on futures shouldn't drop spot data.
          futuresSkipReason = `Futures soft-skipped (${futRes.error.kind}): ${futRes.error.message}`;
        }
      } else {
        futuresAssets = (futRes.value.assets ?? []).filter((a) => {
          const wallet = parseFloat(a.walletBalance ?? "0");
          const margin = parseFloat(a.marginBalance ?? "0");
          return wallet > 0 || margin > 0;
        });
        futuresPositions = (futRes.value.positions ?? []).filter(
          (p) => parseFloat(p.positionAmt ?? "0") !== 0
        );
        for (const a of futuresAssets) {
          if (!STABLECOINS.has(a.asset)) assetsNeedingPrice.add(a.asset);
        }
        for (const p of futuresPositions) {
          // Position symbols are like "BTCUSDT" — we don't need a separate
          // price lookup since markPrice comes back in the futures response.
        }
      }
    }

    const { prices, changes, warning: priceWarning } = await fetchAssetPrices(
      Array.from(assetsNeedingPrice),
      ctx.signal
    );

    const holdings: Holding[] = [];

    for (const b of nonZeroSpot) {
      const asset = b.asset;
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      const qty = free + locked;

      let price: number | undefined;
      let priceChange24h: number | undefined;
      if (STABLECOINS.has(asset)) {
        price = 1;
        priceChange24h = 0;
      } else {
        price = prices.get(asset);
        priceChange24h = changes.get(asset);
      }
      const value = price != null ? qty * price : undefined;

      holdings.push({
        accountId: ctx.account.id,
        symbol: asset,
        assetClass: "crypto",
        quantity: qty,
        currentPrice: price,
        value,
        valueCurrency: "USD",
        metadata: {
          accountType: "SPOT",
          free,
          locked,
          priceChange24h,
        },
        fetchedAt: now,
      });
    }

    for (const a of futuresAssets) {
      const qty = parseFloat(a.walletBalance ?? "0");
      const unrealized = parseFloat(a.unrealizedProfit ?? "0");
      let price: number | undefined;
      if (STABLECOINS.has(a.asset)) price = 1;
      else price = prices.get(a.asset);
      const value = price != null ? qty * price : undefined;

      holdings.push({
        accountId: ctx.account.id,
        symbol: a.asset,
        assetClass: "crypto",
        quantity: qty,
        currentPrice: price,
        value,
        valueCurrency: "USD",
        metadata: {
          accountType: "FUTURES_WALLET",
          unrealizedProfit: unrealized,
          availableBalance: parseFloat(a.availableBalance ?? "0"),
          marginBalance: parseFloat(a.marginBalance ?? "0"),
        },
        fetchedAt: now,
      });
    }

    // Open futures positions surface as their own pseudo-holdings (one per
    // open contract). Quantity is the position size (signed via metadata.side);
    // value uses markPrice × |size|. UnrealizedPnl is in metadata.
    for (const p of futuresPositions) {
      const sizeSigned = parseFloat(p.positionAmt);
      const size = Math.abs(sizeSigned);
      const markPrice = parseFloat(p.markPrice);
      const value = Number.isFinite(markPrice) && Number.isFinite(size) ? size * markPrice : undefined;
      holdings.push({
        accountId: ctx.account.id,
        symbol: p.symbol,
        assetClass: "crypto",
        quantity: size,
        currentPrice: Number.isFinite(markPrice) ? markPrice : undefined,
        value,
        valueCurrency: "USD",
        metadata: {
          accountType: "FUTURES_POSITION",
          side: sizeSigned > 0 ? "LONG" : "SHORT",
          entryPrice: parseFloat(p.entryPrice),
          unrealizedPnl: parseFloat(p.unRealizedProfit),
          leverage: parseInt(p.leverage, 10),
          marginType: (p.marginType ?? "cross").toLowerCase(),
          liquidationPrice: parseFloat(p.liquidationPrice),
          notional: Math.abs(parseFloat(p.notional)),
        },
        fetchedAt: now,
      });
    }

    // Surface warnings (price ticker partial / futures soft-skip) via the
    // first holding's metadata, mirroring MetaMask's __chainWarnings pattern.
    const warnings: string[] = [];
    if (priceWarning) warnings.push(priceWarning);
    if (futuresSkipReason) warnings.push(futuresSkipReason);
    if (warnings.length > 0 && holdings.length > 0) {
      const first = holdings[0]!;
      first.metadata = { ...(first.metadata ?? {}), __chainWarnings: warnings };
    }

    return ok(holdings);
  }

  // Transaction history requires per-symbol /myTrades calls (weight 10 each)
  // for every traded pair, which scales badly. Deferred to v0.14 with a
  // careful weight budget. For now: empty list, like Solana v0.12.
  async fetchTransactions(
    _ctx: ConnectorContext,
    _since?: number
  ): Promise<Result<Transaction[]>> {
    return ok([]);
  }
}
