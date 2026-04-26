// Polymarket connector — read-only prediction market positions.
// Uses the public data-api: https://data-api.polymarket.com/positions?user=0x...
// No API key, no signing — the data-api is anonymous-public for any address.
//
// "user" parameter is the Polymarket PROXY wallet address (a CREATE2-deterministic
// Safe deployed for each Polymarket account). It is NOT the user's MetaMask EOA.
// The user finds it in Polymarket > Settings > Wallet > Address.
//
// V0.3 scope (this file):
//   - fetchHoldings: full implementation, returns one Holding per position with
//     rich metadata (title, slug, eventId, redeemable/mergeable flags, P&L)
//   - fetchTransactions: stubbed — returns ok([]). The /trades?user=X endpoint
//     consistently returned empty in API probing; the right endpoint or query
//     parameter for "user's own trades" is not yet identified. Day 8-10 polish
//     will resolve this.
//
// API docs (sparse but functional): https://docs.polymarket.com/

import type { Connector, ConnectorContext, ConnectorCredentials } from "./types.ts";
import type { Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";

const DATA_API_BASE = "https://data-api.polymarket.com";

interface PolymarketCreds extends ConnectorCredentials {
  proxyWallet: string;       // 0x... 40 hex chars — Polymarket-issued proxy wallet
  // sizeThreshold filters out dust positions. Polymarket UI default is 1.0;
  // we go lower (0.01) so even small positions show up. User-tuneable.
  sizeThreshold?: number;
}

function isPolymarketCreds(c: ConnectorCredentials): c is PolymarketCreds {
  return (
    typeof c.proxyWallet === "string" &&
    /^0x[a-fA-F0-9]{40}$/.test(c.proxyWallet)
  );
}

// Shape of one /positions response item — captured from API probing 2026-04.
// Keeping fields permissive (mostly optional) to tolerate Polymarket adding new
// fields without breaking parse. Required fields are the ones we actually use.
interface PolymarketPosition {
  proxyWallet: string;
  asset: string;              // ERC-1155 token id (huge integer string)
  conditionId: string;        // 0x... market condition hash
  size: number;               // tokens held
  avgPrice: number;           // average buy price, 0-1 (USDC per token)
  initialValue: number;       // USD invested
  currentValue: number;       // current USD value
  cashPnl?: number;
  percentPnl?: number;
  totalBought?: number;
  realizedPnl?: number;
  percentRealizedPnl?: number;
  curPrice: number;           // current token price 0-1
  redeemable?: boolean;
  mergeable?: boolean;
  title: string;              // human-readable market question
  slug: string;
  icon?: string;
  eventId?: string;
  eventSlug?: string;
  outcome: string;            // "Yes" | "No" | other
  outcomeIndex?: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;           // ISO date "2026-03-04"
  negativeRisk?: boolean;
}

export class PolymarketConnector implements Connector {
  readonly id = "polymarket" as const;
  readonly displayName = "Polymarket (data-api)";
  readonly defaultCacheTtlSec = 30;

  async validateCredentials(
    creds: ConnectorCredentials,
    signal?: AbortSignal
  ): Promise<Result<void>> {
    if (!isPolymarketCreds(creds)) {
      return err(
        "schema_mismatch",
        "Polymarket credentials must include { proxyWallet: '0x...' }"
      );
    }

    // The data-api is anonymous; "validation" just confirms the API is reachable
    // and the address has a well-formed response (which is empty for unknown wallets,
    // but that's still a valid response — not an auth failure).
    const url = new URL(`${DATA_API_BASE}/positions`);
    url.searchParams.set("user", creds.proxyWallet);
    url.searchParams.set("limit", "1");

    try {
      const resp = await fetch(url.toString(), { signal });
      if (signal?.aborted) return err("network_timeout", "Aborted by caller");
      if (resp.status === 429) return err("rate_limited", "Polymarket rate limit hit");
      if (!resp.ok) return err("upstream_error", `Polymarket data-api HTTP ${resp.status}`);

      // Just verify we can parse JSON.
      const json = await resp.json();
      if (!Array.isArray(json)) {
        return err("schema_mismatch", "Polymarket data-api returned non-array response");
      }
      return ok(undefined);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return err("network_timeout", "Polymarket request aborted");
      }
      return err(
        "network_error",
        `Polymarket reachability check failed: ${(e as Error).message}`,
        { cause: e }
      );
    }
  }

  async fetchHoldings(ctx: ConnectorContext): Promise<Result<Holding[]>> {
    if (!isPolymarketCreds(ctx.credentials)) {
      return err("schema_mismatch", "Polymarket credentials malformed");
    }
    const creds = ctx.credentials;
    const sizeThreshold = creds.sizeThreshold ?? 0.01;
    const now = Date.now();

    const url = new URL(`${DATA_API_BASE}/positions`);
    url.searchParams.set("user", creds.proxyWallet);
    url.searchParams.set("sizeThreshold", String(sizeThreshold));
    url.searchParams.set("limit", "500"); // generous upper bound, paginates if needed

    let resp: Response;
    try {
      resp = await fetch(url.toString(), { signal: ctx.signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return err("network_timeout", "Polymarket request aborted");
      }
      return err(
        "network_error",
        `Polymarket fetchHoldings failed: ${(e as Error).message}`,
        { cause: e }
      );
    }

    if (resp.status === 429) {
      const retryAfter = resp.headers.get("Retry-After");
      return err("rate_limited", "Polymarket rate limit hit", {
        retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
      });
    }
    if (!resp.ok) {
      return err("upstream_error", `Polymarket data-api HTTP ${resp.status}`);
    }

    let positions: PolymarketPosition[];
    try {
      const json = await resp.json();
      if (!Array.isArray(json)) {
        return err("schema_mismatch", "Polymarket /positions returned non-array");
      }
      positions = json as PolymarketPosition[];
    } catch (e) {
      return err("schema_mismatch", "Polymarket /positions returned invalid JSON", { cause: e });
    }

    const holdings: Holding[] = positions.map((p) => ({
      accountId: ctx.account.id,
      // Symbol format: "{slug}:{outcome}". Readable for the LLM, deterministic, unique
      // per position. Falls back to conditionId+outcomeIndex if slug missing.
      symbol: p.slug
        ? `${p.slug}:${p.outcome ?? "?"}`
        : `${p.conditionId}:${p.outcomeIndex ?? "?"}`,
      assetClass: "prediction" as const,
      quantity: p.size,
      avgCost: p.avgPrice,         // per-token, 0-1
      currentPrice: p.curPrice,    // per-token, 0-1
      value: p.currentValue,       // USD
      valueCurrency: "USD",
      metadata: {
        title: p.title,
        slug: p.slug,
        eventId: p.eventId,
        eventSlug: p.eventSlug,
        conditionId: p.conditionId,
        asset: p.asset,
        outcome: p.outcome,
        outcomeIndex: p.outcomeIndex,
        oppositeOutcome: p.oppositeOutcome,
        endDate: p.endDate,
        redeemable: p.redeemable,
        mergeable: p.mergeable,
        negativeRisk: p.negativeRisk,
        cashPnl: p.cashPnl,
        percentPnl: p.percentPnl,
        realizedPnl: p.realizedPnl,
        percentRealizedPnl: p.percentRealizedPnl,
        initialValue: p.initialValue,
        totalBought: p.totalBought,
        icon: p.icon,
      },
      fetchedAt: now,
    }));

    return ok(holdings);
  }

  async fetchTransactions(
    _ctx: ConnectorContext,
    _since?: number
  ): Promise<Result<Transaction[]>> {
    // V0.3: stubbed. The /trades?user=X endpoint returned empty for all probed
    // addresses, including known whales. Identifying the correct endpoint or
    // query parameter for user-scoped trade history is Day 8-10 polish work.
    // Until then, we surface positions only (which already include avg/realized P&L
    // metadata, covering most "how am I doing" questions).
    return ok([]);
  }
}
