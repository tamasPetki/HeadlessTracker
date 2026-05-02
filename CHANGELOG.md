# Changelog

All notable changes to headless-tracker. Versions follow [SemVer](https://semver.org/).

## v0.10.2 — 2026-05-02

User feedback: the asset-class donut on the Portfolio tab was degenerate. With only crypto connectors today (Bybit + MetaMask + Polymarket), most users see one ~100% slice for "crypto" with maybe a sliver of "prediction" — no signal. Replaced with a more useful breakdown.

### Changed

- **Portfolio tab — "Allocation by asset class" → "Allocation by symbol"**: removed the degenerate asset-class donut. Replaced with a per-symbol allocation donut showing the top 7 positions + a single "Other (N)" slice rolling up the long tail. Real percentage breakdown across what the user actually holds; no slice will be 100% unless the portfolio is genuinely a single position.
- **`bucketTopN()` helper** added in `iframe.ts` — sorts rows desc, keeps the top N, aggregates the rest into one "Other" slice. Skips the bucketing if `<=N` rows or the tail sums to zero.
- The previous "Top 10 by symbol" bar chart was removed since the donut now shows the same data more clearly as a percentage breakdown. The "Top positions by value" table is retained — it shows ranked values + per-account split, which the donut doesn't.
- README dashboard section updated to describe the new layout.
- `SERVER_VERSION` 0.10.1 → 0.10.2; package.json bump.

### Forward note

When a stock or brokerage connector lands (IBKR / Schwab / etc.), the asset-class donut becomes meaningful again — easy to re-add then.

### Tests

- 233 tests pass unchanged. Bundle 403.2KB → 402.6KB (down a hair from removing one section's HTML template).

## v0.10.1 — 2026-05-02

Visual polish on the v0.10.0 dashboard. No behavior change, no new tools, no breaking schema.

### Added

- **Donut chart** for percentage breakdowns. New `pieChart()` helper in `src/mcp/apps/dashboard/iframe.ts` renders an SVG donut + side legend (color swatch, label, value, percent). Pure SVG, no chart library — keeps the bundle within ~2KB of the v0.10.0 size.
- 8-color slice palette tuned for both light and dark themes. Colors cycle if there are more slices than colors.

### Changed

- **Portfolio tab — "Allocation by asset class"**: replaced the horizontal bar chart with a donut + legend. Asset class is the canonical "share of whole" view; pie/donut is the natural framing for that.
- **Risk tab — "By venue"**: same swap. Venue concentration is also a percentage breakdown — donut reads more clearly than bars at the same data density.
- Bar charts retained where they make sense: top-positions-by-symbol (Portfolio tab) is a ranked-by-value view, not a percentage breakdown — bars stay better there.
- README: hoisted the dashboard section to the top of the doc (right after "What it does"), so first-time readers see the live-UI feature immediately. Step 5 in the setup flow shrunk to a "now try it" pointer that links back to the top section.
- `SERVER_VERSION` 0.10.0 → 0.10.1; package.json bump.

### Tests

- 233 tests pass unchanged (only HTML-string content changed, no test assertions touched). Bundle 397.5KB → 403.2KB (within tolerance, sanity-guard threshold of 1MB still holds).

## v0.10.0 — 2026-05-02

The big one: **interactive dashboard MCP App**. The user can now ask Claude "show my dashboard" and get a live, interactive 3-tab UI panel rendered directly in the chat (Portfolio / Weekly / Risk, currency switcher USD/EUR/GBP/HUF, refresh button). This uses the [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) extension (`io.modelcontextprotocol/ui`) which Claude Desktop, ChatGPT, Goose, and VS Code all support.

Two-commit increment: SDK upgrade (`v0.10 #1`) + dashboard implementation (`v0.10 #2`).

### Added

- **`render_dashboard` MCP App tool** — registered with `_meta.ui.resourceUri` pointing at the bundled HTML resource. Optional `currency` and `tab` args set the initial view.
- **Bundled dashboard UI** — `src/mcp/apps/dashboard/iframe.ts` (browser-side TS using `@modelcontextprotocol/ext-apps`), `shell.html` (template with inline CSS, no external deps), and `register.ts` (server-side helper). Bundled via `bun run build:apps` into `dist/mcp-apps/dashboard.html` (~400KB single file, committed so `bunx` users don't need a build step).
- **Three live tabs in the iframe**:
  - **Portfolio** — total value, positions count, accounts, asset-class allocation chart, top 10 positions table, top 10 by symbol chart, warnings + failures sections. Calls `get_holdings` / `get_allocations` / `get_pnl` in parallel with the chosen currency.
  - **Weekly** — 7-day window delta KPIs (historical value, current value, delta, percent), recent trades table (last 50 from `since=7d`), skipped-symbols disclosure. Calls `get_pnl` with `timeframe=7d` and `get_transactions` with `since=7d`.
  - **Risk** — concentration audit (single-position, venue, stablecoin reserve, prediction-market overweight) with PASS / WARN / ALERT scoring, by-venue bar chart. Calls `get_holdings` + 3× `get_allocations`.
- **`bun run build:apps`** script — `scripts/build-mcp-apps.ts`. Bundles iframe.ts via `Bun.build` (browser target, ESM, minified), inlines into shell.html, writes `dist/mcp-apps/dashboard.html`. Wired into `prepublishOnly` so npm publishes always include a fresh build.
- **`resources: {}` capability** advertised by the McpServer (added alongside the existing `tools: {}` and `prompts: {}`).
- **`.gitignore` exception** for `dist/mcp-apps/` so the bundled artifact ships with the package; rest of `dist/` stays ignored.
- **`package.json` files field** now includes `dist/mcp-apps/` and `CHANGELOG.md`.

### Changed

- **`@modelcontextprotocol/sdk` upgraded `^1.0.4` → `^1.29.0`** in `v0.10 #1`. The bumped SDK ships the resource registration helpers `ext-apps` relies on. Existing 224 tests passed unchanged on the new SDK — the deprecated `server.tool()` API still works at runtime, and the TS2589 generic-depth issue noted in `src/mcp/server.ts:60-63` doesn't trigger because we kept the simpler `tool()` form (not `registerTool()`).
- **Added `@modelcontextprotocol/ext-apps@^1.7.1`** as a runtime dep. Server-side helpers (`registerAppTool` / `registerAppResource` / `RESOURCE_MIME_TYPE`) and the browser-side `App` class.
- **`SERVER_VERSION` constant** in `src/mcp/server.ts`: 0.9.2 → 0.10.0.
- **README** — new "Use the interactive dashboard (MCP App)" section, status line bumped to 233 tests + 7 MCP tools + interactive dashboard. Existing prompt cookbook section retained as fallback for hosts that don't render MCP Apps.
- **E2E test** `test/e2e/mcp-stdio.test.ts:163` — assertion updated from "exactly the 6 V0 tools" to "the V0 data tools + render_dashboard MCP App" (7 tools total).

### Tests

- 9 new tests in `test/mcp/apps/dashboard.test.ts`: tool name + URI scheme stability, description quality, server-construction smoke, bundled-artifact existence, doctype + script tag presence, postMessage protocol marker (`ui/initialize`) survives minification, bundle size sanity guard (< 1MB).
- 224 → 233 tests, typecheck clean.

### Build-script gotcha worth remembering

`String.prototype.replace(pattern, replacement)` interprets `$&`, `$1`, etc. in the replacement string specially. The bundled JS happened to contain `\\$&` (a regex backreference used inside `String.prototype.replace` for character-class escaping). When my first build script passed `bundledJs` directly, those `$&` patterns expanded to inject `__BUNDLED_JS__` mid-bundle, ballooning the output to 553KB and breaking the placeholder check. Fix: pass replacement as a function (`shell.replace("__BUNDLED_JS__", () => escapedJs)`) which sidesteps pattern interpretation entirely. Output now 401KB, clean. Logged here so I don't re-introduce it.

### Deferred (not in this release)

- Per-account `windowDelta` (the dashboard's Weekly tab pulls total-only).
- Wiring `prices.ts` into `get_holdings` for snapshot consistency.
- Larger Bulltrapp connector ports (Solana, Bitcoin xpub, Coinbase, Binance, Kraken, KuCoin).
- Bundle size optimization — 401KB is dominated by `zod` + transitive MCP SDK deps. Could shave with a stripped-down browser-only client, but not worth it until the 401KB causes a real problem.
- Dark/light theme: the iframe uses `prefers-color-scheme` from the host's CSS env. The MCP Apps spec also exposes host theme via `onhostcontextchanged` — could be wired up to react more reliably to runtime theme switches.

## v0.9.2 — 2026-05-01

Adds **MCP prompts** — preset prompt templates the server exposes alongside its tools. They show up as slash-command-style entries in Claude Desktop's prompt picker (and in Claude Code) so the user doesn't have to remember which tools to call together for the common workflows. Pure additive: zero changes to existing tools or CLI behavior.

### Added

- **3 MCP prompts** registered via `server.registerPrompt()`:
  - `portfolio-dashboard` — calls `get_holdings` + `get_allocations` + `get_pnl` + `get_polymarket_positions` in parallel and renders a complete multi-section dashboard (HTML artifact when the client supports it).
  - `weekly-review` — calls `get_pnl` with `timeframe=7d`, `get_holdings`, and `get_transactions` with `since=7d`. Surfaces the windowDelta approximation caveat honestly (current basket at historical prices, NOT trades within the window).
  - `risk-check` — concentration / venue / stablecoin reserve / prediction-market overweight / chain-concentration audit, each scored PASS / WARN / ALERT.
- New `src/mcp/prompts/` directory with one file per prompt (`dashboard.ts`, `weekly_review.ts`, `risk_check.ts`). Each file exports the prompt name, a config object (title + description), and a builder function returning `GetPromptResult`. Pure functions — no upstream API calls in the prompt handlers themselves; Claude executes the tools described in the prompt body.
- `prompts: {}` capability in the McpServer constructor.
- README "Prompt cookbook" section with 6 copy-paste prompts (dashboard, weekly review, risk check, tax season, HUF view, Polymarket bet review). The first three mirror the registered prompts; the rest are for users who want to paste a prompt directly without going through the picker.

### Changed

- README status line: 210 → 224 tests, mentions 3 MCP prompts.
- `SERVER_VERSION` constant in `src/mcp/server.ts`: 0.8.0 → 0.9.2 (was stale through v0.9.0 / v0.9.1 — caught and fixed in this release).

### Tests

- New `test/mcp/prompts.test.ts` with 14 tests (per-prompt: stable name, config has title + description, builder returns single user-message + text content, prompt body steers toward the right tools, honesty/caveat language is present; plus one server-construction smoke test that verifies registerPrompt() args don't throw at construction time). 210 → 224 tests, typecheck clean.

### Why MCP prompts and not a separate plugin

Looked at three options for "preset workflows": a Claude Code plugin / skill bundle, MCP prompts, README-only copy-paste. MCP prompts won because they ship inside the existing server (no second install), work in both Claude Desktop and Claude Code, and the protocol already supports them. The README cookbook is the third (zero-code) option and ships alongside.

## v0.9.1 — 2026-05-01

Builds on the v0.9.0 `prices.ts` foundation: makes the `timeframe` field on `get_pnl` functional instead of informational.

### Added

- **`get_pnl --timeframe=24h|7d|30d|ytd`** (MCP + CLI) now returns a `windowDelta` block in the result. Computes "current basket valued at historical prices vs now" using CoinGecko's `/coins/{id}/history` endpoint. Honest about the approximation: the value ignores trades within the window (it's "if I held this exact basket N days ago"). Polymarket positions and crypto without a CoinGecko mapping are counted in `skippedSymbols` with human-readable reasons in `skippedReasons`.
- New helper `computeWindowDelta()` + `timeframeToDate()` in `src/mcp/tools/get_pnl.ts`. CoinGecko free-tier historical is daily granularity, so `24h` resolves to "yesterday UTC". The `PriceService` cache de-dupes per `(coinId, date)`, so multiple holdings of the same symbol across accounts share one fetch.
- CLI: `show pnl --timeframe=7d` prints a "Window delta" block with historical/current value, delta + percentage, priced/skipped counts, and (for ≤5 skips) the per-symbol reasons.

### Changed

- `executeGetPnl()` signature now accepts an optional `priceService` parameter (third arg) for testability. Defaults to `defaultPriceService()` so existing callers are unaffected.
- `get_pnl` tool description: removed the "INFORMATIONAL ONLY" warning on `timeframe`. Replaced with the approximation caveat so the LLM communicates "current basket at historical prices, NOT trades within the window" honestly.
- `timeframeNote` text now reflects the functional behavior when `timeframe ≠ all`.

### Tests

- 8 new tests in `test/mcp/tools/get_pnl.test.ts` (windowDelta with timeframe='all'/none → null, 7d delta math, 24h date resolution, Polymarket skip path, unknown-symbol skip + reason, multi-holding fetch dedup, fetch failure → graceful skip not throw). Updated 1 existing test that asserted the old "informational only" note. 202 → 210 across this release. Typecheck clean.

### Deferred (still not in this release)

- Per-account `windowDelta` (currently total-only). Easy follow-up if a real query needs it.
- Wiring `prices.ts` into `get_holdings` for snapshot consistency (still uses connector-supplied prices).
- Larger Bulltrapp ports (Solana, Bitcoin xpub, Coinbase, Binance, Kraken, KuCoin connectors).

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
