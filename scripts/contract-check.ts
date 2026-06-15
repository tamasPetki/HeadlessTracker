// Upstream contract canary.
//
// Why this exists: every connector parses a specific shape out of a third-party
// API response. Our unit tests run against *fixtures* — they prove our parser is
// correct for the shape we recorded, but they cannot notice when the live API
// quietly changes that shape under us. That is exactly how the Jupiter Price API
// v2 -> v3 migration shipped a silent "$0 Solana balance" bug to users in
// v1.0.13: v2 was retired, the response moved from `{ data: { mint: { price:
// "1.2" } } }` to a flat `{ mint: { usdPrice: 1.2 } }`, and nothing in CI hit the
// real endpoint to catch it.
//
// This script hits the *live, keyless* endpoints each connector depends on and
// asserts the precise fields the parser consumes still exist with the right
// types. It is NOT part of `bun test` (network flakiness must never break PR CI
// or a publish). It runs:
//   - on demand:  `bun run contract`
//   - weekly in CI (.github/workflows/contract-canary.yml), which opens a GitHub
//     issue when a contract drifts — so the next breaking upstream change is
//     caught by a robot, not by a user staring at a $0 portfolio.
//
// Failure philosophy (low false-positive, by design):
//   - 2xx + shape correct        -> PASS
//   - 2xx + shape WRONG          -> FAIL  (genuine drift — the signal we want)
//   - 404 / 410 (endpoint gone)  -> FAIL  (this is what Jupiter v2 became)
//   - 429 (rate-limited)         -> WARN  (inconclusive, not drift)
//   - network error / timeout    -> WARN  (transient; weekly cadence re-checks)
// Only FAILs exit non-zero. Transient noise stays quiet so the canary is
// trustworthy when it does fire.

const TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Pure validators — exported so test/contract/validators.test.ts can assert
// they ACCEPT the current shape and REJECT the known drifted shapes (the
// regression test for the Jupiter bug lives there). Each takes already-parsed
// JSON (for RPC, the unwrapped `result`) and returns a verdict.
// ---------------------------------------------------------------------------

export interface Verdict {
  ok: boolean;
  detail: string;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Jupiter Price API v3: flat object keyed by mint, numeric `usdPrice`.
// MUST reject the retired v2 shape ({ data: { mint: { price: "..." } } }).
export function validateJupiterV3(json: unknown, mint: string): Verdict {
  if (json && typeof json === "object" && "data" in (json as object) && !(mint in (json as object))) {
    return { ok: false, detail: "looks like retired v2 shape (data-wrapped); expected flat { [mint]: { usdPrice } }" };
  }
  const entry = (json as Record<string, { usdPrice?: unknown }>)?.[mint];
  if (!entry || typeof entry !== "object") return { ok: false, detail: `no entry for mint ${mint}` };
  if (!num(entry.usdPrice)) return { ok: false, detail: `entry.usdPrice is not a finite number (got ${typeof entry.usdPrice})` };
  return { ok: true, detail: `usdPrice=${entry.usdPrice}` };
}

// CoinGecko /simple/price?ids=ID&vs_currencies=usd -> { ID: { usd: number } }
export function validateCoinGeckoSimplePrice(json: unknown, id: string): Verdict {
  const entry = (json as Record<string, { usd?: unknown }>)?.[id];
  if (!entry) return { ok: false, detail: `no entry for id ${id}` };
  if (!num(entry.usd)) return { ok: false, detail: `entry.usd is not a finite number (got ${typeof entry.usd})` };
  return { ok: true, detail: `usd=${entry.usd}` };
}

// CoinGecko /coins/markets -> [ { id, symbol, market_cap_rank } ]
export function validateCoinGeckoMarkets(json: unknown): Verdict {
  if (!Array.isArray(json)) return { ok: false, detail: `expected array, got ${typeof json}` };
  if (json.length === 0) return { ok: false, detail: "empty markets array" };
  const row = json[0] as Record<string, unknown>;
  if (typeof row.id !== "string") return { ok: false, detail: "row.id is not a string" };
  if (typeof row.symbol !== "string") return { ok: false, detail: "row.symbol is not a string" };
  if (!("market_cap_rank" in row)) return { ok: false, detail: "row.market_cap_rank field missing" };
  return { ok: true, detail: `${json.length} rows; row0=${row.id}` };
}

// CoinGecko /coins/{id}/history -> { market_data: { current_price: { usd: number } } }
export function validateCoinGeckoHistory(json: unknown): Verdict {
  const usd = (json as { market_data?: { current_price?: { usd?: unknown } } })?.market_data?.current_price?.usd;
  if (!num(usd)) return { ok: false, detail: "market_data.current_price.usd is not a finite number" };
  return { ok: true, detail: `usd=${usd}` };
}

// Solana RPC getBalance -> result.value is lamports (number)
export function validateSolanaGetBalance(result: unknown): Verdict {
  const value = (result as { value?: unknown })?.value;
  if (!num(value)) return { ok: false, detail: `result.value is not a finite number (got ${typeof value})` };
  return { ok: true, detail: `lamports=${value}` };
}

// Solana RPC getTokenAccountsByOwner (jsonParsed) -> result.value: array; each
// item exposes account.data.parsed.info.{mint, tokenAmount.uiAmount}. Item shape
// only checkable when the test wallet actually holds SPL tokens.
export function validateSolanaTokenAccounts(result: unknown): Verdict {
  const value = (result as { value?: unknown })?.value;
  if (!Array.isArray(value)) return { ok: false, detail: `result.value is not an array (got ${typeof value})` };
  if (value.length === 0) return { ok: true, detail: "envelope ok (no token accounts to shape-check)" };
  const info = (value[0] as { account?: { data?: { parsed?: { info?: Record<string, unknown> } } } })
    ?.account?.data?.parsed?.info;
  if (!info) return { ok: false, detail: "item.account.data.parsed.info path missing" };
  if (typeof info.mint !== "string") return { ok: false, detail: "info.mint is not a string" };
  const ui = (info.tokenAmount as { uiAmount?: unknown })?.uiAmount;
  if (ui !== null && !num(ui)) return { ok: false, detail: "info.tokenAmount.uiAmount is neither number nor null" };
  return { ok: true, detail: `${value.length} token accounts; item shape ok` };
}

// Polymarket /positions?user=0x... -> array; each position exposes the fields the
// connector reads. Item shape only checkable when the wallet has open positions.
export function validatePolymarketPositions(json: unknown): Verdict {
  if (!Array.isArray(json)) return { ok: false, detail: `expected array, got ${typeof json}` };
  if (json.length === 0) return { ok: true, detail: "envelope ok (no positions to shape-check)" };
  const p = json[0] as Record<string, unknown>;
  for (const [field, ty] of [["size", "number"], ["curPrice", "number"], ["title", "string"], ["outcome", "string"]] as const) {
    if (typeof p[field] !== ty) return { ok: false, detail: `position.${field} is not a ${ty} (got ${typeof p[field]})` };
  }
  return { ok: true, detail: `${json.length} positions; item shape ok` };
}

// exchangerate-api / frankfurter -> { rates: { EUR, GBP, HUF } }
export function validateFxRates(json: unknown): Verdict {
  const rates = (json as { rates?: Record<string, unknown> })?.rates;
  if (!rates) return { ok: false, detail: "rates object missing" };
  for (const c of ["EUR", "GBP", "HUF"]) {
    if (!num(rates[c])) return { ok: false, detail: `rates.${c} is not a finite number` };
  }
  return { ok: true, detail: `EUR=${rates.EUR} GBP=${rates.GBP} HUF=${rates.HUF}` };
}

// Bybit v5 envelope (shared by the private wallet-balance parser): { retCode, result: { list: [] } }
export function validateBybitEnvelope(json: unknown): Verdict {
  const j = json as { retCode?: unknown; result?: { list?: unknown } };
  if (j?.retCode !== 0) return { ok: false, detail: `retCode != 0 (got ${JSON.stringify(j?.retCode)})` };
  if (!Array.isArray(j?.result?.list)) return { ok: false, detail: "result.list is not an array" };
  return { ok: true, detail: `retCode=0; result.list len=${(j.result!.list as unknown[]).length}` };
}

// Binance public ticker -> { symbol: string, price: numeric-string }
export function validateBinanceTicker(json: unknown): Verdict {
  const j = json as { symbol?: unknown; price?: unknown };
  if (typeof j?.symbol !== "string") return { ok: false, detail: "symbol is not a string" };
  if (typeof j?.price !== "string" || !Number.isFinite(Number(j.price))) {
    return { ok: false, detail: `price is not a numeric string (got ${JSON.stringify(j?.price)})` };
  }
  return { ok: true, detail: `${j.symbol}=${j.price}` };
}

// ---------------------------------------------------------------------------
// Live runner
// ---------------------------------------------------------------------------

type Status = "PASS" | "FAIL" | "WARN";
interface CheckResult { name: string; status: Status; detail: string; }

const WSOL = "So11111111111111111111111111111111111111112";
const SOL_RPC = "https://api.mainnet-beta.solana.com";
// A long-lived, well-funded public Solana account (Coinbase hot wallet). Used
// read-only for envelope + item-shape; override with HT_CONTRACT_SOL_ADDR.
const SOL_ADDR = process.env.HT_CONTRACT_SOL_ADDR ?? "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS";
// Override with a Polymarket proxy wallet that holds positions to enable item-shape checks.
const POLY_WALLET = process.env.HT_CONTRACT_POLY_WALLET ?? "0x0000000000000000000000000000000000000000";

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; json?: unknown; netErr?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json: body };
    }
    return { status: res.status, json: await res.json() };
  } catch (e) {
    return { status: 0, netErr: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Map an HTTP result + a shape verdict into a canary status with the failure
// philosophy described at the top of the file.
function classify(http: { status: number; netErr?: string }, verdict: () => Verdict): { status: Status; detail: string } {
  if (http.netErr) return { status: "WARN", detail: `network: ${http.netErr}` };
  if (http.status === 429) return { status: "WARN", detail: "rate-limited (429) — inconclusive" };
  if (http.status === 404 || http.status === 410) return { status: "FAIL", detail: `endpoint gone (HTTP ${http.status})` };
  if (http.status < 200 || http.status >= 300) return { status: "WARN", detail: `HTTP ${http.status}` };
  const v = verdict();
  return { status: v.ok ? "PASS" : "FAIL", detail: v.detail };
}

async function rpc(method: string, params: unknown[]): Promise<{ status: number; json?: unknown; netErr?: string }> {
  return getJson(SOL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const push = (name: string, http: { status: number; json?: unknown; netErr?: string }, verdict: () => Verdict) => {
    const c = classify(http, verdict);
    results.push({ name, status: c.status, detail: c.detail });
  };

  // 1. Jupiter Price v3 — the exact endpoint of the v1.0.13 $0 bug.
  {
    const r = await getJson(`https://api.jup.ag/price/v3?ids=${WSOL}`);
    push("jupiter-price-v3", r, () => validateJupiterV3(r.json, WSOL));
  }
  // 2-4. CoinGecko
  {
    const r = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true");
    push("coingecko-simple-price", r, () => validateCoinGeckoSimplePrice(r.json, "bitcoin"));
  }
  {
    const r = await getJson("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=5&page=1&sparkline=false");
    push("coingecko-markets", r, () => validateCoinGeckoMarkets(r.json));
  }
  {
    const r = await getJson("https://api.coingecko.com/api/v3/coins/bitcoin/history?date=01-01-2024&localization=false");
    push("coingecko-history", r, () => validateCoinGeckoHistory(r.json));
  }
  // 5-6. Solana RPC
  {
    const r = await rpc("getBalance", [SOL_ADDR]);
    push("solana-getBalance", r, () => validateSolanaGetBalance((r.json as { result?: unknown })?.result));
  }
  {
    const r = await rpc("getTokenAccountsByOwner", [SOL_ADDR, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }]);
    push("solana-getTokenAccountsByOwner", r, () => validateSolanaTokenAccounts((r.json as { result?: unknown })?.result));
  }
  // 7. Polymarket
  {
    const r = await getJson(`https://data-api.polymarket.com/positions?user=${POLY_WALLET}&limit=5`);
    push("polymarket-positions", r, () => validatePolymarketPositions(r.json));
  }
  // 8. FX (primary + fallback)
  {
    const r = await getJson("https://api.exchangerate-api.com/v4/latest/USD");
    push("fx-exchangerate-api", r, () => validateFxRates(r.json));
  }
  {
    const r = await getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,HUF");
    push("fx-frankfurter-fallback", r, () => validateFxRates(r.json));
  }
  // 9-10. Exchange public envelopes (proxy for the credentialed-balance parsers)
  {
    const r = await getJson("https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT");
    push("bybit-v5-envelope", r, () => validateBybitEnvelope(r.json));
  }
  {
    const r = await getJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
    push("binance-public-ticker", r, () => validateBinanceTicker(r.json));
  }

  return results;
}

async function main(): Promise<void> {
  const results = await runChecks();
  const pad = Math.max(...results.map((r) => r.name.length));
  let fails = 0, warns = 0;
  console.log("Upstream contract canary\n");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⚠️ ";
    console.log(`${icon} ${r.name.padEnd(pad)}  ${r.status.padEnd(4)}  ${r.detail}`);
    if (r.status === "FAIL") fails++;
    if (r.status === "WARN") warns++;
  }
  console.log(`\n${results.length} checks: ${results.length - fails - warns} pass, ${fails} fail, ${warns} warn`);
  if (fails > 0) {
    console.log("\nCONTRACT DRIFT DETECTED. A parser's upstream shape changed — fix before it reaches users.");
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
