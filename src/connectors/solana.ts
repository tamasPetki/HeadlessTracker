// Solana wallet connector — read-only on-chain wallet tracking.
// Uses Solana public RPC (or user-supplied premium RPC) for balances + Jupiter
// Price API v2 for SPL token prices. No API key required for the default RPC,
// but public mainnet-beta is rate-limited (~100 req / 10s). Power users can
// supply their own Helius / QuickNode / Triton RPC URL.
//
// V0 scope:
//   - Native SOL balance via getBalance
//   - SPL token balances via getTokenAccountsByOwner (Token program v1 only;
//     Token-2022 deferred — different program id, distinct schema)
//   - Prices: Jupiter Price API v2 for all mints in one batch call. Mints with
//     no Jupiter price are dropped (no DexScreener fallback in v0; deferred)
//   - Multi-wallet per Account (addresses[]), mirroring the MetaMask pattern
//   - fetchTransactions: returns ok([]) — Solana transaction history requires
//     getSignaturesForAddress + per-signature getParsedTransaction, which
//     rate-limits the public RPC fast. Deferred to v0.13+.
//
// API docs:
//   - Solana RPC: https://solana.com/docs/rpc
//   - Jupiter Price API v2: https://dev.jup.ag/docs/price-api/v2

import type { Connector, ConnectorContext, ConnectorCredentials } from "./types.ts";
import type { Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const LAMPORTS_PER_SOL = 1_000_000_000; // 9 decimals

// Wrapped-SOL is treated as native SOL by Jupiter, but the SPL token account
// for it is the canonical "wSOL" mint. We treat it as a regular SPL token in
// the holdings list (separate from the native lamports balance).
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Pinned metadata for the most common SPL mints. Used when Jupiter returns a
// price but no symbol/name. Decimals come from the on-chain token account
// response, so we don't need them here.
const KNOWN_MINTS: Record<string, { symbol: string; name: string }> = {
  [WSOL_MINT]: { symbol: "SOL", name: "Wrapped SOL" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD" },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", name: "Marinade Staked SOL" },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": { symbol: "WETH", name: "Wrapped Ether (Wormhole)" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: { symbol: "PYTH", name: "Pyth Network" },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: { symbol: "JTO", name: "Jito" },
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: { symbol: "RNDR", name: "Render" },
  WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk: { symbol: "WEN", name: "Wen" },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat" },
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": { symbol: "JLP", name: "Jupiter Perps LP" },
};

// Solana base58 addresses are 32-44 chars from the base58 alphabet (no 0/O/I/l).
const ADDRESS_RX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface SolanaCreds extends ConnectorCredentials {
  // Multi-wallet support: one Account can track several Solana addresses.
  // Mirrors MetaMask v0.8 pattern. Single-address legacy form via `address` is
  // also accepted and lifted to `addresses[]` at runtime.
  address?: string;
  addresses?: string[];
  // Optional: user-supplied RPC URL (Helius, QuickNode, Triton). Defaults to
  // public mainnet-beta if omitted. Premium RPC strongly recommended for
  // multi-wallet setups — public mainnet-beta rate-limits aggressively.
  rpcUrl?: string;
  // Hide tokens whose USD value is below this threshold. Defaults to 0.5 USD
  // to suppress dust + airdrop spam (Solana wallets accumulate junk fast).
  dustThresholdUsd?: number;
}

function getAddresses(creds: SolanaCreds): string[] {
  if (Array.isArray(creds.addresses) && creds.addresses.length > 0) {
    return creds.addresses;
  }
  if (typeof creds.address === "string" && creds.address.length > 0) {
    return [creds.address];
  }
  return [];
}

function isSolanaCreds(c: ConnectorCredentials): c is SolanaCreds {
  const single = typeof c.address === "string" && ADDRESS_RX.test(c.address);
  const list =
    Array.isArray(c.addresses) &&
    c.addresses.length > 0 &&
    (c.addresses as unknown[]).every((a) => typeof a === "string" && ADDRESS_RX.test(a));
  return single || list;
}

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  signal?: AbortSignal
): Promise<Result<T>> {
  let resp: Response;
  try {
    resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return err("network_timeout", "Solana RPC request aborted");
    }
    return err("network_error", `Solana RPC fetch failed: ${(e as Error).message}`, { cause: e });
  }

  if (!resp.ok) {
    if (resp.status === 429) return err("rate_limited", "Solana RPC rate limit hit (HTTP 429)");
    if (resp.status === 401 || resp.status === 403) {
      return err("auth_failed", `Solana RPC auth failed (HTTP ${resp.status})`);
    }
    return err("upstream_error", `Solana RPC HTTP ${resp.status}`);
  }

  let json: RpcResponse<T>;
  try {
    json = (await resp.json()) as RpcResponse<T>;
  } catch (e) {
    return err("schema_mismatch", "Solana RPC returned non-JSON", { cause: e });
  }

  if (json.error) {
    // -32005 is RPC node behind / blockhash not found etc — treat as upstream.
    return err("upstream_error", `Solana RPC error ${json.error.code}: ${json.error.message}`);
  }
  if (json.result === undefined || json.result === null) {
    return err("upstream_error", "Solana RPC returned no result");
  }
  return ok(json.result);
}

// Price API v3 response: flat object keyed by mint, `usdPrice` as a number.
// (v2 wrapped entries under `data` with a string `price`; v2 was retired and
// now 404s — see https://dev.jup.ag/docs/price-api/v3.)
interface JupiterPriceResponse {
  [mint: string]: { usdPrice?: number; priceChange24h?: number } | undefined;
}

// Fetch USD prices for a batch of mint addresses from Jupiter Price API v3.
// Returns a Map mint→price (USD). Mints with no price are simply absent.
// Jupiter accepts comma-separated ids; v3 caps a request at 50 ids, so we
// batch into chunks of 50.
async function fetchJupiterPrices(
  mints: string[],
  signal?: AbortSignal
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;

  const BATCH = 50;
  for (let i = 0; i < mints.length; i += BATCH) {
    const slice = mints.slice(i, i + BATCH);
    const url = `${JUPITER_PRICE_API}?ids=${slice.join(",")}`;
    let resp: Response;
    try {
      resp = await fetch(url, { signal });
    } catch {
      // If Jupiter is down, we just skip — prices end up null, which our
      // "honest unknown" contract handles cleanly.
      continue;
    }
    if (!resp.ok) continue;
    let json: JupiterPriceResponse;
    try {
      json = (await resp.json()) as JupiterPriceResponse;
    } catch {
      continue;
    }
    for (const mint of slice) {
      const entry = json[mint];
      if (!entry || entry.usdPrice == null) continue;
      const price = entry.usdPrice;
      if (Number.isFinite(price) && price > 0) {
        out.set(mint, price);
      }
    }
  }
  return out;
}

interface ParsedTokenAccount {
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          owner: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number | null;
            uiAmountString: string;
          };
        };
      };
    };
  };
  pubkey: string;
}

export class SolanaConnector implements Connector {
  readonly id = "solana" as const;
  readonly displayName = "Solana wallet (RPC + Jupiter)";
  readonly defaultCacheTtlSec = 60;

  async validateCredentials(
    creds: ConnectorCredentials,
    signal?: AbortSignal
  ): Promise<Result<void>> {
    if (!isSolanaCreds(creds)) {
      return err(
        "schema_mismatch",
        "Solana credentials must include a base58 address (or addresses[])"
      );
    }
    const addresses = getAddresses(creds);
    if (addresses.length === 0) {
      return err("schema_mismatch", "At least one Solana address must be provided");
    }
    const rpcUrl = typeof creds.rpcUrl === "string" && creds.rpcUrl.length > 0 ? creds.rpcUrl : DEFAULT_RPC;

    // Cheapest reachability check: getBalance on the first address. Returns 0
    // for unfunded addresses (still a valid response — not an error).
    const result = await rpcCall<{ value: number }>(
      rpcUrl,
      "getBalance",
      [addresses[0]!],
      signal
    );
    if (!result.ok) return result;
    return ok(undefined);
  }

  async fetchHoldings(ctx: ConnectorContext): Promise<Result<Holding[]>> {
    if (!isSolanaCreds(ctx.credentials)) {
      return err("schema_mismatch", "Solana credentials malformed");
    }
    const creds = ctx.credentials;
    const addresses = getAddresses(creds);
    const rpcUrl =
      typeof creds.rpcUrl === "string" && creds.rpcUrl.length > 0 ? creds.rpcUrl : DEFAULT_RPC;
    const dustThreshold = typeof creds.dustThresholdUsd === "number" ? creds.dustThresholdUsd : 0.5;
    const now = Date.now();

    // Per-wallet fan-out. Each wallet does 2 RPC calls (getBalance +
    // getTokenAccountsByOwner). Public RPC handles a single wallet fine, but
    // multi-wallet setups SHOULD use a premium endpoint.
    const perAddress = await Promise.all(
      addresses.map(async (address) => {
        const [solRes, splRes] = await Promise.all([
          rpcCall<{ value: number }>(rpcUrl, "getBalance", [address], ctx.signal),
          rpcCall<{ value: ParsedTokenAccount[] }>(
            rpcUrl,
            "getTokenAccountsByOwner",
            [address, { programId: SPL_TOKEN_PROGRAM }, { encoding: "jsonParsed" }],
            ctx.signal
          ),
        ]);
        return { address, solRes, splRes };
      })
    );

    // Collect all unique non-zero mints across all wallets, then batch-fetch
    // prices once. Native SOL price comes from the wSOL Jupiter entry.
    const mintsToPrice = new Set<string>([WSOL_MINT]);
    for (const { splRes } of perAddress) {
      if (!splRes.ok) continue;
      for (const acc of splRes.value.value) {
        const info = acc.account.data.parsed.info;
        const ui = info.tokenAmount.uiAmount;
        if (ui != null && ui > 0) {
          mintsToPrice.add(info.mint);
        }
      }
    }

    const prices = await fetchJupiterPrices(Array.from(mintsToPrice), ctx.signal);
    const solPrice = prices.get(WSOL_MINT);

    const holdings: Holding[] = [];
    const errors: string[] = [];

    for (const { address, solRes, splRes } of perAddress) {
      if (!solRes.ok) {
        const tag = addresses.length > 1 ? ` (${address.slice(0, 6)}...${address.slice(-4)})` : "";
        errors.push(`getBalance${tag}: ${solRes.error.message}`);
        continue;
      }
      const sol = solRes.value.value / LAMPORTS_PER_SOL;
      if (sol > 0) {
        const value = solPrice != null ? sol * solPrice : undefined;
        holdings.push({
          accountId: ctx.account.id,
          symbol: "SOL",
          assetClass: "crypto",
          quantity: sol,
          currentPrice: solPrice,
          value,
          valueCurrency: "USD",
          metadata: { native: true, address, chain: "solana" },
          fetchedAt: now,
        });
      }

      if (!splRes.ok) {
        const tag = addresses.length > 1 ? ` (${address.slice(0, 6)}...${address.slice(-4)})` : "";
        errors.push(`getTokenAccountsByOwner${tag}: ${splRes.error.message}`);
        continue;
      }

      for (const acc of splRes.value.value) {
        const info = acc.account.data.parsed.info;
        const qty = info.tokenAmount.uiAmount;
        if (qty == null || qty <= 0) continue;

        const mint = info.mint;
        const known = KNOWN_MINTS[mint];
        const price = prices.get(mint);
        const value = price != null ? qty * price : undefined;

        // Dust filter: if no price OR value below threshold AND not a known
        // major mint, skip. Known mints (USDC, USDT, SOL, JUP) always show.
        if (!known) {
          if (value == null) continue;
          if (value < dustThreshold) continue;
        }

        holdings.push({
          accountId: ctx.account.id,
          // Symbol fallback chain: pinned known mint → mint suffix as opaque ID
          // ("4k3Dyj…cT" stays informative without claiming a fake ticker)
          symbol: known?.symbol ?? `SPL-${mint.slice(0, 4)}…${mint.slice(-4)}`,
          assetClass: "crypto",
          quantity: qty,
          currentPrice: price,
          value,
          valueCurrency: "USD",
          metadata: {
            mint,
            decimals: info.tokenAmount.decimals,
            address,
            chain: "solana",
            tokenName: known?.name,
          },
          fetchedAt: now,
        });
      }
    }

    if (holdings.length === 0 && errors.length > 0) {
      return err("upstream_error", `Solana fetch failed: ${errors.join("; ")}`);
    }

    if (errors.length > 0 && holdings.length > 0) {
      const first = holdings[0]!;
      first.metadata = { ...(first.metadata ?? {}), __chainWarnings: errors };
    }

    return ok(holdings);
  }

  // Solana transaction history requires getSignaturesForAddress (cheap) +
  // getParsedTransaction (one RPC call per signature, expensive). Public
  // mainnet-beta rate-limits this aggressively at ~5 req/s sustained — a
  // 100-tx history takes 20+ seconds. Deferred until v0.13 when we can wire
  // a premium-RPC opt-in similar to Etherscan Pro. For now: empty list with
  // a metadata-only marker on a synthetic placeholder is too cute; we just
  // return ok([]) and let PnL surface its "missing transactions" banner.
  async fetchTransactions(
    _ctx: ConnectorContext,
    _since?: number
  ): Promise<Result<Transaction[]>> {
    return ok([]);
  }
}
