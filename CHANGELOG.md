# Changelog

All notable changes to headless-tracker. Versions follow [SemVer](https://semver.org/).

## v0.9.0 — 2026-05-01

Two-commit increment porting useful, low-risk pieces from Bulltrapp (the maintainer's hosted web tracker at [bulltrapp.com](https://bulltrapp.com)) into HeadlessTracker. Additive only: no connector behavior changed, no breaking schema changes. Plan + decision audit at `~/.gstack/projects/HeadlessTracker/main-bulltrapp-port-plan-20260501-162224.md`.

### Added

- **Average Cost** as an alternative to FIFO for cost-basis math. Shares the same `CostBasisResult` shape so `get_pnl --include-history=true --method=average` is a single-flag swap. Pool-based: tracks `quantity` + `knownCost` + sticky `hasUnknown` flag per symbol. Preserves the same "honest unknown" rule as FIFO — any sell drawing from an unpriced deposit/transfer returns `realizedPnl: null`, NOT a fabricated number. Pool resets to clean once fully exited, so a fresh purchase after a full exit produces a clean known average. (`src/cost_basis.ts:computeCostBasisAverage` + `computeCostBasisWithMethod` dispatcher.)
- **FX module** for multi-currency display. `fetchFxRates()` hits `exchangerate-api.com`, falls back to `frankfurter.dev`, then to hardcoded static rates with `source: "fallback"` so the caller can warn the user. `convert(amount, from, to, rates)` is pure. Supported currencies: USD / EUR / GBP / HUF. (`src/fx.ts`)
- **Price service** for CoinGecko spot + historical lookups. `PriceService.getPrice(coinId)` and `.getPrices([...])` with batch deduplication and 60s spot TTL. `.getHistoricalPrice(coinId, date)` with 7-day TTL since the past doesn't change. Static `symbolToCoinGeckoId(symbol)` mapping for the ~28 most common tokens (BTC, ETH, USDC, SOL, BNB, MATIC/POL, etc.). Optional `COINGECKO_API_KEY` env. (`src/prices.ts`)
- **`get_pnl --method=fifo|average`** flag (MCP + CLI). Echoed back as `costBasisMethod` in the tool result so the LLM can communicate which method was used. Has no effect when `include_history=false` (the connector-metadata realized PnL doesn't depend on cost basis math).
- **`get_holdings --currency=USD|EUR|GBP|HUF`** flag (MCP + CLI). FX fetch is lazy (only happens when target currency ≠ USD). Conversion runs at response-build time so no cache-shared `Holding` objects get mutated — verified by a regression test that confirms a USD call after a HUF call still returns USD-tagged values. New `meta.fx` block surfaces `source` + `rateUsdToTarget` + `fetchedAt` so the LLM can explain stale fallback rates. CLI: `fmtMoney(n, currency)` formatter (HUF: "38000 Ft" without decimals; USD/EUR/GBP with prefix symbol).

### Changed

- `Cache.get/set/invalidate` widened from `ConnectorId` to `ConnectorId | string` so module-internal namespaces (e.g. `_prices`) can share the same SQLite WAL infrastructure without polluting connector slots. Unknown namespaces fall back to a 60s default TTL but are expected to pass explicit `ttlSec` (the price service does).
- README status line bumped to v0.9 + 202-test suite. New "Multi-currency display" and "Cost basis methods (FIFO vs Average)" sections in the CLI quick-query area.

### Tests

- 32 new tests across `test/fx.test.ts`, `test/prices.test.ts`, `test/cost_basis.test.ts` (Average Cost + dispatcher), `test/mcp/tools/get_pnl.test.ts` (--method), `test/mcp/tools/get_holdings.test.ts` (--currency including the cache-mutation regression). 162 → 194 → 202 across the two commits in this release. Typecheck clean.

### Deferred (not in this release)

- Wiring `prices.ts` into `get_pnl` to replace connector-supplied prices — still uses what the connector reports at fetch time. No behavior regression; opt-in integration is a separate ticket.
- Time-windowed P&L (`24h`/`7d`/`30d`) — historical-price plumbing is now there, but the orchestrator doesn't yet diff snapshots over a window.
- Larger Bulltrapp ports (Solana, Bitcoin xpub, Coinbase, Binance, Kraken, KuCoin connectors). Each is its own feature with secret management + setup CLI flow + tests, so they're separate plans.

## v0.8.0 — 2026-04-27

Capability scope set by `/autoplan` review (premise gate option B): promoted distribution + CLI from Phase 2+ to v0.8. 162-test suite, typecheck clean. See [ROADMAP.md](./ROADMAP.md) for the full Decision Audit Trail.

- **CLI portfolio queries** (`607da9a`): `show holdings | pnl | transactions [--account-id=X] [--asset-class=Y] [--since=7d]`. Reuses the same orchestrator the MCP server uses; presentation layer is a text table.
- **Custom ERC-20 token list** (`057baf2`): `token add | list | remove`. Stored in `Account.metadata.customTokens`, NOT the keychain (tokens are public on-chain identifiers). Orchestrator merges them into connector credentials at fetch time.
- **FIFO cost basis tracker** (`c259a3a`): `src/cost_basis.ts` + `get_pnl --include-history`. Tokens received via wallet transfer-in have no known price; lots get `costBasisKnown=false`; any SELL consuming them produces `realizedPnl: null` — NOT $0, NOT NaN.
- **Polymarket realized P&L from `/trades`** (`75d1126`): replaces the `cashPnl` mixed metric. Default mode: Polymarket realized = null with a note pointing to `include_history=true`. With history: FIFO over /trades.
- **Multi-wallet per MetaMask account** (`def9e1d`): additive `addresses?: string[]` schema. Legacy single-`address` vaults auto-upgrade at runtime.
- **Side fix**: `bun test --timeout 15000` → `--timeout=15000` in `package.json`. The space-form was silently ignored.

## v0.7.x — 2026-04 (pre-changelog)

Original 14-day plan + first burn-in round. 3 connectors, 6 MCP tools, SQLite cache + WAL, keychain vault, 110-test suite. See [ROADMAP.md](./ROADMAP.md) for the full v0.7 → v0.8 transition.
