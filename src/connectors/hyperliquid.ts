// Hyperliquid connector — read-only perp + spot tracking by wallet address.
// Uses the public Hyperliquid `info` endpoint: a single POST API, no key, no
// signing. Everything is keyed by the user's EVM address (the same address they
// trade from on Hyperliquid). https://hyperliquid.gitbook.io/hyperliquid-docs
//
// V1 scope (this file):
//   - Perp account (clearinghouseState):
//       * account EQUITY as a single cash-like Holding (marginSummary.accountValue),
//         which is the honest net-worth contribution of a margin account
//         (collateral + unrealized PnL). This is what goes into the portfolio total.
//       * each open position as an INFORMATIONAL Holding (value intentionally
//         omitted to avoid double-counting the notional against the equity above).
//         szi is signed (negative = short); full exposure detail (notional,
//         unrealized PnL, entry, liq price, leverage) lives in metadata so the
//         LLM can answer "what are my open positions / am I long or short".
//   - Spot balances (spotClearinghouseState): one Holding per token, priced from
//     spotMetaAndAssetCtxs markPx (TOKEN/USDC pairs; USDC itself = 1.0). Tokens
//     with no USDC pair get value=undefined (honest-unknown, same as Solana).
//   - Multi-address per Account (addresses[]), mirroring the MetaMask/Solana pattern.
//   - fetchTransactions: recent fills (userFills, capped at the API's 2000) with a
//     client-side `since` filter.
//
// Deferred (not V1): HYPE staking balances, vault deposits, sub-accounts. Noted
// here so the omission is a decision, not an oversight.
//
// Why equity-as-cash instead of summing position notionals: a 20x position has
// ~20x its margin in notional. Adding positionValue to the portfolio total would
// wildly overstate net worth. accountValue already nets collateral + unrealized
// PnL into the one number a tracker should report. See decisions.md.

import type { Connector, ConnectorContext, ConnectorCredentials } from "./types.ts";
import type { AssetClass, Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";

const INFO_URL = "https://api.hyperliquid.xyz/info";

// EVM address: 0x + 40 hex chars.
const ADDRESS_RX = /^0x[a-fA-F0-9]{40}$/;

// Spot tokens we treat as cash (stablecoins) rather than crypto. USDC is the
// canonical Hyperliquid quote asset; the others appear as bridged spot tokens.
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "USDE", "USDHL", "FEUSD", "DAI"]);

// Recent-fills cap. userFills returns at most the latest 2000 fills; we don't
// paginate further in V1 (mirrors the bounded-history philosophy in the
// Polymarket connector's MAX_PAGES).
const MAX_FILLS = 2000;

interface HyperliquidCreds extends ConnectorCredentials {
  // Single-address legacy form; lifted to addresses[] at runtime.
  address?: string;
  // Multi-wallet: one Account can track several Hyperliquid addresses.
  addresses?: string[];
  // Hide spot tokens whose USD value is below this threshold (default 0.5) to
  // suppress airdrop/dust spam. Stablecoins and the perp account always show.
  dustThresholdUsd?: number;
}

function getAddresses(creds: HyperliquidCreds): string[] {
  if (Array.isArray(creds.addresses) && creds.addresses.length > 0) {
    return creds.addresses;
  }
  if (typeof creds.address === "string" && creds.address.length > 0) {
    return [creds.address];
  }
  return [];
}

function isHyperliquidCreds(c: ConnectorCredentials): c is HyperliquidCreds {
  const single = typeof c.address === "string" && ADDRESS_RX.test(c.address);
  const list =
    Array.isArray(c.addresses) &&
    c.addresses.length > 0 &&
    (c.addresses as unknown[]).every((a) => typeof a === "string" && ADDRESS_RX.test(a));
  return single || list;
}

// Parse a numeric string field defensively. Hyperliquid returns all numbers as
// strings; a malformed/missing one becomes NaN, which callers guard on.
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v);
  return NaN;
}

// POST a typed `info` request. The info API is anonymous; failures are network
// or rate-limit, never auth.
async function infoCall<T>(body: unknown, signal?: AbortSignal): Promise<Result<T>> {
  let resp: Response;
  try {
    resp = await fetch(INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return err("network_timeout", "Hyperliquid request aborted");
    }
    return err("network_error", `Hyperliquid fetch failed: ${(e as Error).message}`, { cause: e });
  }

  if (resp.status === 429) {
    const retryAfter = resp.headers.get("Retry-After");
    return err("rate_limited", "Hyperliquid rate limit hit (HTTP 429)", {
      retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
    });
  }
  if (!resp.ok) {
    return err("upstream_error", `Hyperliquid info HTTP ${resp.status}`);
  }

  try {
    return ok((await resp.json()) as T);
  } catch (e) {
    return err("schema_mismatch", "Hyperliquid info returned non-JSON", { cause: e });
  }
}

// ---- Response shapes (captured from API probing 2026-06-17) ----
// Kept permissive: only the fields we read are required.

interface PerpPosition {
  coin: string;
  szi: string; // signed; negative = short
  leverage?: { type?: string; value?: number };
  entryPx?: string;
  positionValue?: string; // notional USD, always positive
  unrealizedPnl?: string;
  returnOnEquity?: string;
  liquidationPx?: string | null;
  marginUsed?: string;
}

interface ClearinghouseState {
  marginSummary?: {
    accountValue?: string;
    totalNtlPos?: string;
    totalRawUsd?: string;
    totalMarginUsed?: string;
  };
  withdrawable?: string;
  assetPositions?: Array<{ type?: string; position?: PerpPosition }>;
}

interface SpotBalance {
  coin: string;
  token: number;
  total: string;
  hold?: string;
  entryNtl?: string;
}

interface SpotClearinghouseState {
  balances?: SpotBalance[];
}

interface SpotAssetCtx {
  coin: string; // pair name, e.g. "PURR/USDC"
  markPx?: string;
  midPx?: string;
}

// Fetch a name→USD-price map for spot tokens from spotMetaAndAssetCtxs. Only the
// pairs quoted in USDC give a direct USD price; others are skipped (value stays
// unknown). Returns an empty map on any failure — pricing is best-effort.
async function fetchSpotPrices(signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  out.set("USDC", 1);
  const res = await infoCall<[unknown, SpotAssetCtx[]]>({ type: "spotMetaAndAssetCtxs" }, signal);
  if (!res.ok || !Array.isArray(res.value) || res.value.length < 2) return out;
  const ctxs = res.value[1];
  if (!Array.isArray(ctxs)) return out;
  for (const ctx of ctxs) {
    const name = ctx?.coin;
    if (typeof name !== "string") continue;
    const [base, quote] = name.split("/");
    if (!base || quote !== "USDC") continue; // only USDC-quoted pairs give USD price
    const px = num(ctx.markPx ?? ctx.midPx);
    if (Number.isFinite(px) && px > 0 && !out.has(base)) out.set(base, px);
  }
  return out;
}

interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: string; // "B" = buy, "A" = sell (ask)
  time: number; // epoch ms
  dir?: string;
  closedPnl?: string;
  hash?: string;
  oid?: number;
  tid?: number;
  crossed?: boolean;
  startPosition?: string;
  fee?: string;
  feeToken?: string;
}

export class HyperliquidConnector implements Connector {
  readonly id = "hyperliquid" as const;
  readonly displayName = "Hyperliquid (perp + spot, address-only)";
  readonly defaultCacheTtlSec = 60;

  async validateCredentials(
    creds: ConnectorCredentials,
    signal?: AbortSignal
  ): Promise<Result<void>> {
    if (!isHyperliquidCreds(creds)) {
      return err(
        "schema_mismatch",
        "Hyperliquid credentials must include an EVM address (0x...) or addresses[]"
      );
    }
    const addresses = getAddresses(creds);
    if (addresses.length === 0) {
      return err("schema_mismatch", "At least one Hyperliquid address must be provided");
    }
    // Cheapest reachability check: clearinghouseState on the first address. An
    // empty/unfunded account still returns a valid object (accountValue "0.0").
    const res = await infoCall<ClearinghouseState>(
      { type: "clearinghouseState", user: addresses[0] },
      signal
    );
    if (!res.ok) return res;
    return ok(undefined);
  }

  async fetchHoldings(ctx: ConnectorContext): Promise<Result<Holding[]>> {
    if (!isHyperliquidCreds(ctx.credentials)) {
      return err("schema_mismatch", "Hyperliquid credentials malformed");
    }
    const creds = ctx.credentials;
    const addresses = getAddresses(creds);
    const dustThreshold =
      typeof creds.dustThresholdUsd === "number" ? creds.dustThresholdUsd : 0.5;
    const now = Date.now();

    // Per-address fan-out: perp state + spot state in parallel for each address.
    const perAddress = await Promise.all(
      addresses.map(async (address) => {
        const [perpRes, spotRes] = await Promise.all([
          infoCall<ClearinghouseState>(
            { type: "clearinghouseState", user: address },
            ctx.signal
          ),
          infoCall<SpotClearinghouseState>(
            { type: "spotClearinghouseState", user: address },
            ctx.signal
          ),
        ]);
        return { address, perpRes, spotRes };
      })
    );

    // Only fetch the spot price table if some address actually holds spot tokens
    // beyond USDC — avoids a needless call for pure-perp users.
    const needsSpotPrices = perAddress.some(
      ({ spotRes }) =>
        spotRes.ok &&
        (spotRes.value.balances ?? []).some((b) => b.coin !== "USDC" && num(b.total) > 0)
    );
    const spotPrices = needsSpotPrices ? await fetchSpotPrices(ctx.signal) : new Map([["USDC", 1]]);

    const holdings: Holding[] = [];
    const errors: string[] = [];
    const tag = (address: string) =>
      addresses.length > 1 ? ` (${address.slice(0, 6)}...${address.slice(-4)})` : "";

    for (const { address, perpRes, spotRes } of perAddress) {
      // --- Perp account ---
      if (!perpRes.ok) {
        errors.push(`clearinghouseState${tag(address)}: ${perpRes.error.message}`);
      } else {
        const state = perpRes.value;
        const equity = num(state.marginSummary?.accountValue);
        const positions = state.assetPositions ?? [];

        if (Number.isFinite(equity) && equity > 0) {
          holdings.push({
            accountId: ctx.account.id,
            symbol: "USDC",
            assetClass: "cash",
            quantity: equity,
            currentPrice: 1,
            value: equity,
            valueCurrency: "USD",
            metadata: {
              venue: "hyperliquid",
              marketType: "perp",
              kind: "perp-account-equity",
              withdrawable: num(state.withdrawable),
              totalMarginUsed: num(state.marginSummary?.totalMarginUsed),
              totalNotionalPos: num(state.marginSummary?.totalNtlPos),
              openPositions: positions.length,
              address,
            },
            fetchedAt: now,
          });
        }

        for (const ap of positions) {
          const p = ap.position;
          if (!p || typeof p.coin !== "string") continue;
          const szi = num(p.szi);
          if (!Number.isFinite(szi) || szi === 0) continue;
          const notional = num(p.positionValue);
          const markPx =
            Number.isFinite(notional) && szi !== 0 ? notional / Math.abs(szi) : undefined;
          holdings.push({
            accountId: ctx.account.id,
            symbol: p.coin,
            assetClass: "crypto",
            quantity: szi, // signed: negative = short
            currentPrice: markPx,
            // value intentionally omitted — the notional is NOT net worth; the
            // position's contribution is already inside perp-account-equity above.
            value: undefined,
            valueCurrency: "USD",
            metadata: {
              venue: "hyperliquid",
              marketType: "perp",
              kind: "perp-position",
              side: szi < 0 ? "short" : "long",
              notionalUsd: Number.isFinite(notional) ? notional : undefined,
              unrealizedPnl: num(p.unrealizedPnl),
              entryPx: num(p.entryPx),
              liquidationPx: p.liquidationPx != null ? num(p.liquidationPx) : undefined,
              leverage: p.leverage?.value,
              leverageType: p.leverage?.type,
              marginUsed: num(p.marginUsed),
              returnOnEquity: num(p.returnOnEquity),
              address,
            },
            fetchedAt: now,
          });
        }
      }

      // --- Spot balances ---
      if (!spotRes.ok) {
        errors.push(`spotClearinghouseState${tag(address)}: ${spotRes.error.message}`);
        continue;
      }
      for (const bal of spotRes.value.balances ?? []) {
        const qty = num(bal.total);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const isStable = STABLE_SYMBOLS.has(bal.coin);
        const price = spotPrices.get(bal.coin) ?? (isStable ? 1 : undefined);
        const value = price != null ? qty * price : undefined;

        // Dust filter: drop non-stable tokens worth less than the threshold (or
        // unpriceable and not stable). Stablecoins always show.
        if (!isStable) {
          if (value == null) continue;
          if (value < dustThreshold) continue;
        }

        const assetClass: AssetClass = isStable ? "cash" : "crypto";
        holdings.push({
          accountId: ctx.account.id,
          symbol: bal.coin,
          assetClass,
          quantity: qty,
          currentPrice: price,
          value,
          valueCurrency: "USD",
          metadata: {
            venue: "hyperliquid",
            marketType: "spot",
            kind: "spot",
            token: bal.token,
            hold: num(bal.hold),
            entryNtl: num(bal.entryNtl),
            address,
          },
          fetchedAt: now,
        });
      }
    }

    // If every address failed both calls, surface the error. If some data came
    // through, attach warnings to the first holding (same pattern as Solana).
    if (holdings.length === 0 && errors.length > 0) {
      return err("upstream_error", `Hyperliquid fetch failed: ${errors.join("; ")}`);
    }
    if (errors.length > 0 && holdings.length > 0) {
      const first = holdings[0]!;
      first.metadata = { ...(first.metadata ?? {}), __chainWarnings: errors };
    }
    return ok(holdings);
  }

  async fetchTransactions(
    ctx: ConnectorContext,
    since?: number
  ): Promise<Result<Transaction[]>> {
    if (!isHyperliquidCreds(ctx.credentials)) {
      return err("schema_mismatch", "Hyperliquid credentials malformed");
    }
    const addresses = getAddresses(ctx.credentials);
    const all: Transaction[] = [];

    for (const address of addresses) {
      const res = await infoCall<Fill[]>({ type: "userFills", user: address }, ctx.signal);
      if (!res.ok) {
        // One bad address shouldn't blank the rest; skip it. If ALL fail and we
        // collected nothing, return the last error below.
        if (addresses.length === 1) return res as Result<Transaction[]>;
        continue;
      }
      const fills = Array.isArray(res.value) ? res.value.slice(0, MAX_FILLS) : [];
      for (const f of fills) {
        if (since !== undefined && f.time < since) continue;
        const fee = num(f.fee);
        all.push({
          accountId: ctx.account.id,
          // tid is the unique trade id; hash can repeat across a batched tx.
          txId: `hyperliquid:${f.hash ?? "nohash"}:${f.tid ?? f.oid ?? f.time}`,
          type: f.side === "B" ? "buy" : "sell",
          symbol: f.coin,
          quantity: num(f.sz),
          price: num(f.px),
          fee: Number.isFinite(fee) ? fee : undefined,
          feeCurrency: f.feeToken,
          valueCurrency: "USD",
          timestamp: f.time, // already epoch ms
          metadata: {
            venue: "hyperliquid",
            dir: f.dir,
            closedPnl: num(f.closedPnl),
            crossed: f.crossed,
            startPosition: f.startPosition,
            oid: f.oid,
            hash: f.hash,
            address,
          },
        });
      }
    }

    return ok(all);
  }
}
