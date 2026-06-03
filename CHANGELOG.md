# Changelog

All notable changes to headless-tracker. Versions follow [SemVer](https://semver.org/).

## v1.0.5 — 2026-06-03

Makes the docs match the capability shipped in v1.0.1. The package has run under plain Node (`npx headless-tracker`) since v1.0.1, but the README's Quick Start still told everyone to `git clone` + install Bun, and the Claude Desktop config still pointed at a local Bun clone with absolute paths. The traffic told the story: lots of repo clones, almost no one using the zero-friction path that already existed.

### Changed

- **README leads with `npx` / global install, not a Bun clone.** Quick Start is now `npm i -g headless-tracker` (or prefix `npx`), and the Claude Desktop config is just `{"command": "npx", "args": ["-y", "headless-tracker"]}` — no absolute paths, no clone, no Bun. The `git clone` + Bun path moved to the Development section where it belongs.
- **Landing page no longer claims "Requires Bun 1.3+"** for end users (it runs under Node 22.5+).

### Added

- **`headless-tracker version` (`--version` / `-v`).** Previously only `help` printed the version; `--version` fell through to "unknown command".

## v1.0.4 — 2026-06-02

Fixes onboarding on systems without an OS keychain (Docker, WSL, bare Linux servers, CI). Found while dogfooding as user #1 on a headless Linux box.

### Fixed

- **Setup no longer aborts when the OS keychain is unavailable.** Previously, if the keyring write failed (no Secret Service / D-Bus), `setup` errored out before registering the account, which also left the env-var credential fallback unreachable (the data tools enumerate registered accounts, so an unregistered account is invisible no matter what env vars are set). Setup now registers the account regardless and prints the exact `HEADLESS_TRACKER_<CONNECTOR>_<ACCOUNT>` environment variable to set, completing the env-var fallback the vault was already designed for. No secrets are written to disk. Applies to both the CLI and the `setup_connector` MCP tool.

### Added

- **README "Headless / no OS keychain" section** with the per-connector credential JSON shapes and a Claude Desktop `env`-block example.

## v1.0.3 — 2026-06-02

Lands the MCP registry listing that v1.0.2 set up. The v1.0.2 release published to npm but the registry publish was rejected (the registry caps `server.json` `description` at 100 characters and mine was longer).

### Fixed

- **MCP registry publish now succeeds.** Shortened the `server.json` description to fit the registry's 100-character limit (still leads with "Not financial advice.").
- **Idempotent npm publish in the release workflow.** The npm step now skips if the version is already published, so a re-run after a later step fails (exactly what happened with v1.0.2) no longer dies on a duplicate-version error.

## v1.0.2 — 2026-06-02

Discoverability and honesty. Lists the server in the official MCP registry so MCP hosts can find it, and corrects README drift.

### Added

- **Official MCP registry listing.** Added `server.json` (`io.github.tamasPetki/headless-tracker`) and a registry-publish step to the release workflow using GitHub OIDC, so every tagged release now publishes to npm and to the MCP registry. The workflow syncs `server.json`'s version from the git tag, so it can't drift from the package version.

### Fixed

- **README tool count and stats.** It claimed "7 MCP tools" and a "307-test suite"; the server actually exposes 15 tools (6 data + 7 account/token management + 2 MCP App panels) and the suite is 318 tests. Added the missing tools to the documented tool tables, dropped the hardcoded `v1.0.0` status (the npm badge is the source of truth), and corrected the now-inaccurate `bun:sqlite`-only and "Bun process" references since the package runs under plain Node as of v1.0.1.

## v1.0.1 — 2026-06-02

Runs under plain Node now. v1.0.0 shipped a `bun`-shebanged `.ts` entry and `bun:sqlite`, so `npx headless-tracker` on a machine without Bun failed instantly (`env: 'bun': No such file or directory`, and Node can't execute `.ts` or import `bun:sqlite`). This release makes the published binary Node-runnable while keeping Bun as the dev and test runtime.

### Fixed

- **`npx headless-tracker` works under Node.** The `bin` now points at a bundled, Node-shebanged ESM file (`dist/bin/headless-tracker.mjs`) produced by `bun build --target=node`. First-party code is bundled; every dependency stays external and is resolved from `node_modules` at run time.
- **CLI `--help` version no longer drifts.** It read a hardcoded `0.8.0`; now it reads `version` from `package.json`, same as the MCP server's reported version.

### Changed

- **SQLite driver is selected at run time** (`src/sqlite.ts`): `bun:sqlite` under Bun, `node:sqlite` under Node. No single driver loads in both runtimes (`bun:sqlite` is Bun-only, `node:sqlite` is Node-only, and Bun cannot load `better-sqlite3`'s native addon, oven-sh/bun#4290). Using the Node built-in keeps the package free of native dependencies, so there is nothing to compile or download at install.
- **Runtime asset paths resolve via `packageRoot()`** (walks up to the nearest `package.json`) instead of a hardcoded depth-from-source, so the version read and the `dist/mcp-apps/*.html` lookups work whether run from source, the bundle, or `node_modules`.
- `engines` now declares `node >=22.5.0` (for built-in `node:sqlite`).

### Added

- `mcpName: io.github.tamasPetki/headless-tracker` in `package.json` (ownership verification for the official MCP registry).

## v1.0.0 — 2026-05-28

First public npm release. No breaking changes from v0.13.2 — the version jump signals the start of the open-source, build-in-public phase under Hex (autonomous AI dev agent). The codebase at 0.13.2 was already production-grade; v1.0.0 is the honest signal for "ready to install."

### Added

- **`DISCLAIMER.md`**: full "Not financial advice" legal disclaimer, linked from README.
- **Build-in-public infrastructure**: `decisions.md` (architectural decision log) and `daily-log.md` (daily build log) committed directly into the repo and linked from README. Both are append-only public records.
- **README banners**: autonomous-agent banner (Hex identity, links to decisions + daily-log) and compliance disclaimer banner.
- **"Not financial advice" in MCP tool descriptions**: appended to all 5 data-fetching tool descriptions (`get_holdings`, `get_pnl`, `get_allocations`, `get_transactions`, `get_polymarket_positions`). LLMs read these when selecting tools, so the disclaimer appears at the point of data retrieval.
- **npm badge** in README: `[![npm version](https://img.shields.io/npm/v/headless-tracker.svg)](https://www.npmjs.com/package/headless-tracker)`.

### Changed

- `package.json` homepage and repository URLs corrected from stale `PietScarlet/headless-tracker` to `tamasPetki/HeadlessTracker`.
- `package.json` description prefixed with "Not financial advice." per compliance policy.
- `package.json` version `0.13.2` → `1.0.0`.

### No functional changes

All 317 tests pass. Connectors, MCP tools, prompts, and dashboard unchanged from v0.13.2.

## v0.13.2 — 2026-05-03

User reported: configured `bybit:UNIFIED` shows trading wallet but FUND wallet (funding/USDT parking) is invisible. Existing model required setting up Bybit twice — once per accountType — which is poor UX and rarely discovered. v0.13.2 lets a single Bybit account fan out across multiple account types using the same API key.

### Added

- **`BybitCreds.accountTypes?: BybitAccountType[]`** (optional, additive): when present, `fetchHoldings` and `fetchTransactions` fan out across the listed types in addition to the primary `accountType`. Common pattern: track UNIFIED + FUND together so funding-wallet balances aren't hidden.
- **`BybitConnector.fetchHoldings`**: parallel-`Promise.all` per resolved accountType (Bybit's per-key 10 req/sec rate limit comfortably handles 4 simultaneous calls). Per-type results merged into a single `Holding[]`. Each holding tags `metadata.accountType` (already happening), so the dashboard's `by=account` allocation breakdown still discriminates UNIFIED vs FUND vs SPOT correctly.
- **Partial-success policy** (mirrors MetaMask multi-chain): hard error only when EVERY account type fails. Otherwise per-type errors surface via `__chainWarnings` on the first holding's metadata so the user sees which types had permission/rate issues without losing the data we did fetch.
- **`fetchTransactions`**: also fans out, but only across UNIFIED + CONTRACT (Bybit's `/v5/account/transaction-log` is limited to those — FUND wallet transactions live behind `/v5/asset/transfer-record` which we'll wire up in a later release if asked). FUND-only setups silent-skip transactions, holdings still work.
- **CLI `setup bybit`**: after picking the primary type, prompts for each of the other 3 types ("Also track FUND? (y/N)" etc.). Defaults still UNIFIED-only, but the prompts make multi-type setup discoverable.
- **Settings GUI Bybit form**: replaces the single dropdown with a primary-type selector + 3 checkboxes (FUND default-checked because that's the most common addition). Hint text under the checkboxes explains the pattern.

### Changed

- **`BybitConnector.fetchHoldings` is now multi-type by default semantics**: callers that pass `creds.accountType: "UNIFIED"` without `accountTypes` still get exactly one type queried (full back-compat with v0.7-v0.13 behavior). `accountTypes` is purely additive.
- **Account ID still derives from the primary type** (`bybit:UNIFIED`), so existing v0.7+ vault entries round-trip cleanly. Adding FUND tracking to an existing UNIFIED account does NOT change the account ID.
- **Account label** now reflects the fan-out: `Bybit UNIFIED+FUND` instead of just `Bybit UNIFIED` when extras are set. Settings UI's Accounts tab shows `UNIFIED+FUND account` in the metadata summary.
- **`setup_connector` tool description** explicitly documents the `accountTypes` field with an example (`['FUND'] alongside UNIFIED`).
- `SERVER_VERSION` 0.13.1 → 0.13.2; `package.json` bump.

### Migration

Existing Bybit users keeping UNIFIED-only see no change. To add FUND tracking:
- **CLI**: re-run `bun run setup bybit` and answer "y" to "Also track FUND?". Vault entry overwrites with the new `accountTypes: ["FUND"]` field; account ID stays `bybit:UNIFIED`.
- **Settings UI**: open the Settings panel → Accounts → Remove the Bybit account → Add Account → Bybit, this time with FUND checkbox ticked. (We'll add an "edit accountTypes" tool in a later release if asked; for now, remove + re-add is the path.)

### Tests

- 3 new schema-validation tests in `test/connectors/bybit.test.ts`: rejects invalid `accountTypes` element, rejects empty array (must be omitted), rejects non-array shape. Total: 317 tests pass (was 314).
- The fan-out integration path is exercised in the manual Bybit smoke test rather than a mocked-SDK unit test (consistent with how the existing fetchHoldings happy-path is covered — the `bybit-api` SDK class hierarchy is high-effort to mock cleanly for marginal coverage).

## v0.13.1 — 2026-05-03

User reported: 13 mainstream coins (solana, ripple, binancecoin, near, sui, hyperliquid, jupiter, etc.) all skipped with `historical price unavailable for 7d ago` in the windowDelta block. Root cause was CoinGecko rate-limiting on the `/coins/{id}/history` endpoint under parallel fan-out.

### Fixed

- **Parallel fan-out → 429 silent drop**: `computeWindowDelta` was firing `Promise.all` on N coins (the user had 13). CoinGecko's free `/coins/{id}/history` is the strictest rate-limited endpoint they expose (~10-30 req/min), and 13 simultaneous calls reliably trigger 429s. The error result was silently discarded by `if (r.ok && r.value !== null)`, leaving the user with a generic "unavailable" message and no way to know it was a rate limit.
- **Concurrency cap** in `computeWindowDelta`: historical prices now fetch in chunks of 3 (was: unlimited via `Promise.all`). Combined with the new retry path below, the typical wall time goes from ~1s (with most calls failing) to ~3-5s (with all calls succeeding) for cache-cold runs.
- **Retry-on-429 with backoff** in `PriceService.fetch`: when CoinGecko returns 429, the helper now retries up to 2 times with 2.5s sleeps between attempts (default; tunable via `PriceServiceOptions.rateLimitRetries` + `rateLimitBackoffMs`). Honors AbortSignal during backoff so cancelled tool calls don't hang. Other error kinds (auth, network, 5xx) bypass the retry — they won't fix themselves.
- **Better skip reason**: instead of the bare "historical price unavailable for 7d ago", the message now appends the cause:
  - `... (CoinGecko rate limit — try again in ~1 minute, or set COINGECKO_API_KEY env to get a free demo key)` for 429s
  - `... (no CoinGecko snapshot for this date — coin may be too new or was delisted)` for missing data
  - `... (<error_kind>)` for other failure modes
- **`SUPER` added to `COINGECKO_IDS`**: maps to `superfarm` (the dominant SUPER ticker — SuperVerse rebranded from SuperFarm but kept the CoinGecko id). User had this token in a wallet and it was outside the cached top-250.

### How to recover from rate-limiting (user-facing)

If you see `windowDelta` skips with `(CoinGecko rate limit ...)`:
1. Wait 1 minute and re-run the query (the rolling rate window clears).
2. Set `COINGECKO_API_KEY=<demo-key>` in your environment — free CoinGecko demo keys (https://www.coingecko.com/en/api/pricing) bump you from the public 5-15 req/sec global to 30 req/min on the demo tier with no historical-endpoint penalty.
3. Long-term: the cache TTL on historical entries is 7 days, so once a date succeeds it stays cached — repeated runs of `--timeframe=7d` won't re-hit the API.

### Tests

- 7 new tests: 4 for the retry-on-429 path (happy retry, exhausted budget, non-429 errors don't retry, abort short-circuits backoff), 1 for the SUPER static-map regression, 2 for the get_pnl skip-reason text + concurrency-cap (verifies max 3 in-flight historical calls when 6 coins need pricing).
- 314 tests pass (was 307). Existing 429 tests now use `rateLimitRetries: 0` to keep them sub-millisecond.

## v0.13.0 — 2026-05-03

**New connector: Binance.** Spot account holdings + optional Futures wallet/positions, read-only. HMAC-SHA256 signed REST API calls via Node's built-in `crypto` (no SDK dependency, ~390 lines of code). Mirrors Bybit's exchange-style credential pattern (apiKey + apiSecret) with one twist: a single Binance API key covers Spot/Margin/Futures, so we toggle Futures via an `includeFutures` flag rather than separate accountTypes.

### Added

- **`BinanceConnector`** (`src/connectors/binance.ts`):
  - `validateCredentials` — signed `GET /api/v3/account` (weight 20). Catches 401/403 → `auth_failed`, 429/418 → `rate_limited`, errors → `upstream_error`.
  - `fetchHoldings`:
    - **Spot**: `GET /api/v3/account?omitZeroBalances=true` → one Holding per non-zero balance (free + locked merged into `quantity`, both surfaced in `metadata`).
    - **Pricing**: one batch `GET /api/v3/ticker/24hr?type=MINI&symbols=[...]` for all non-stablecoin assets at once (weight 2 for ≤20 symbols, 40 for ≤100, fallback to all-symbols at 80 if user holds >100 distinct assets). Stablecoins (USDT/USDC/BUSD/FDUSD/TUSD/DAI/USDP/USDS) are priced at $1 without an API call. Missing tickers → `currentPrice: undefined` (honest unknown), not 0.
    - **Optional Futures** (when `creds.includeFutures === true`): signed `GET /fapi/v2/account` → emits separate `FUTURES_WALLET` Holdings per non-zero futures asset + `FUTURES_POSITION` Holdings per open position (with `side`, `entryPrice`, `markPrice`, `unrealizedPnl`, `leverage`, `marginType`, `liquidationPrice` in metadata). Soft-skip on auth_failed: spot data still returned, futures absence surfaces as a `__chainWarnings` message on the first holding.
  - `fetchTransactions` — returns `ok([])` for v0.13. Per-symbol `/api/v3/myTrades` calls cost weight 10 each and require iterating user's traded pairs; deferred to v0.14 with careful weight budgeting.
  - Default cache TTL: 120s (matches Bybit).
- **CLI setup**: `headless-tracker setup binance` — interactive prompts for API key/secret + futures opt-in. Same flow shape as the other exchanges.
- **MCP `setup_connector` tool**: extended discriminated union to accept `connector: "binance"` + `binance: { apiKey, apiSecret, includeFutures?, recvWindow? }`. Account identifier uses a 6-char fingerprint of the apiKey (`binance:key-AbCdEf`) so multiple Binance accounts per user can coexist.
- **Settings GUI** (Settings MCP App):
  - Add Account tab: new "Binance" button + form. API key / secret fields, `Include Futures` checkbox with hint about soft-skip behavior. Brief permission warning text (Reading only, no Trade/Withdraw).
  - Accounts tab: Binance accounts get a `binance` tag (Binance brand yellow `#f3ba2f`) and metadata summary (`key AbCdEf…, Spot only` or `Spot + Futures`).
  - Security disclosure: updated to mention all five connectors and Binance's "Enable Reading" requirement.
- **`refresh_data` + `list_accounts` tools**: Binance now an accepted value in the `connector` enum.
- **Test coverage**: 16 new tests.
  - `test/connectors/binance.test.ts`: identity, credential validation (5 cases including 401/429 mapping), happy path with batch ticker, honest-unknown for missing pairs, includeFutures + 401 soft-skip, includeFutures full path (3 holdings: SPOT + FUTURES_WALLET + FUTURES_POSITION), 429 propagates as rate_limited, empty account `ok([])`, fetchTransactions placeholder.
  - `test/mcp/tools/admin_tools.test.ts`: setup_connector binance happy path (verifies `apiSecret` NEVER ends up in account metadata, only the public fingerprint), `includeFutures=true` reflected in label.

### Changed

- `ConnectorId` type: now `"bybit" | "metamask" | "polymarket" | "solana" | "binance"`. Cache TTL table updated.
- `SERVER_VERSION` 0.12.0 → 0.13.0; `package.json` bump.
- `SERVER_INSTRUCTIONS` (system-prompt injection): mentions Binance in the connector list and the Settings routing hint.
- Settings security disclosure: "All four connectors" → "All five connectors" with Binance-specific permission note.

### Behavior caveats

- **Futures permission**: if you tick "Include Futures" but your API key lacks the futures permission, the connector soft-skips with a warning surfaced via `__chainWarnings` on the first holding. Spot data still works. To enable: edit the API key in Binance settings and add "Enable Futures".
- **Geographic restrictions**: Binance.com is unavailable in some jurisdictions (US users → binance.us, which has a different API at `api.binance.us`). v0.13 hard-codes `api.binance.com`; binance.us support is deferred. If the user is geo-blocked the connector returns `auth_failed` with a 451-ish error (Binance's WAF returns 451 / 403 with "Service unavailable from a restricted location").
- **Tx history empty**: `fetchTransactions` returns `ok([])`. PnL won't show realized gains for Binance until v0.14. Cost basis remains "honest unknown" (null) — the existing contract.
- **Balance scope**: only the **Spot** account (and optional Futures wallet/positions) is fetched. Earn / Trading Bots / Funding sub-wallets via `/sapi/v1/asset/wallet/balance` are deferred — those scattered balances aren't usually large enough to matter for portfolio tracking, and adding the call adds 30+ weight per fetch.

## v0.12.0 — 2026-05-03

**New connector: Solana wallets.** Read-only on-chain tracking for SOL + SPL tokens via the public Solana RPC + Jupiter Price API v2. No API key required, multi-wallet supported, optional premium RPC URL for power users. Mirrors the MetaMask credential pattern (multi-address per Account) so the Settings UI's Wallets tab now manages BOTH EVM and Solana accounts from one place.

### Added

- **`SolanaConnector`** (`src/connectors/solana.ts`) implementing the `Connector` interface:
  - `validateCredentials` — accepts a base58 address (or `addresses[]`), optional `rpcUrl`, optional `dustThresholdUsd` (default 0.5 USD). Reachability check via `getBalance` on the first address.
  - `fetchHoldings` — fans out per-address: parallel `getBalance` (SOL lamports → SOL) + `getTokenAccountsByOwner` (SPL token program v1 accounts). Aggregates non-zero mints, batch-fetches USD prices from Jupiter Price API v2 (one HTTP round-trip for all mints), emits one Holding per (mint × wallet). Honest-unknown rule: tokens with no Jupiter price get `currentPrice: undefined` and are dropped from the result if below the dust threshold AND not in the pinned `KNOWN_MINTS` list (USDC, USDT, mSOL, BONK, JUP, JTO, PYTH, RNDR, WIF, JLP, etc.).
  - `fetchTransactions` — returns `ok([])` for v0.12. Solana tx history requires `getSignaturesForAddress` + per-sig `getParsedTransaction`, which rate-limits the public RPC fast (~5 req/s sustained on mainnet-beta). Deferred to v0.13 with premium-RPC opt-in.
  - Default cache TTL: 60s (matches MetaMask).
- **CLI setup**: `headless-tracker setup solana` — interactive prompts for address, optional RPC URL, dust threshold. Same flow shape as the other connectors.
- **MCP `setup_connector` tool**: extended discriminated union to accept `connector: "solana"` + `solana: { address, rpcUrl?, dustThresholdUsd? }`. Validates against the connector's `validateCredentials` before persisting.
- **MCP `add_wallet_address` tool**: now supports BOTH MetaMask AND Solana accounts. Per-connector address validation (EVM hex 0x-prefix vs base58, 32-44 chars). Critical: Solana addresses are case-sensitive base58 — dedup compares as-is, no lowercase mangling. EVM dedup stays case-insensitive.
- **Settings GUI** (Settings MCP App):
  - Add Account tab: new "Solana wallet" button + form (address, optional RPC URL placeholder hinting at Helius/QuickNode, dust threshold).
  - Wallets tab: now lists MetaMask AND Solana accounts in one combined dropdown. Format hint below the address input updates dynamically based on the selected account's connector ("0x + 40 hex" vs "base58, 32-44 chars, case-sensitive").
  - Accounts tab: Solana accounts get a `solana` tag (Solana brand purple `#9945ff`) and metadata summary (`N addresses, public RPC` or `N addresses, premium RPC`).
  - Security disclosure: updated to mention all four connectors (Bybit / MetaMask / Polymarket / Solana) and notes that Solana addresses are public on-chain identifiers.
- **`refresh_data` + `list_accounts` tools**: Solana now an accepted value in the `connector` enum.
- **Test coverage**: 17 new tests.
  - `test/connectors/solana.test.ts`: validation (5 cases including bad-base58, missing creds, mocked RPC ok/error), fetchHoldings happy path (SOL + USDC with Jupiter prices), dust filter (unknown low-value dropped, known low-value kept), multi-wallet fan-out (verifies per-address `getBalance` calls), empty-wallet `ok([])`, fetchTransactions returns `ok([])` placeholder.
  - `test/mcp/tools/admin_tools.test.ts`: setup_connector solana happy path (verifies case-preserving accountId), add_wallet_address Solana append (preserves case), cross-format rejection (EVM address rejected on Solana account, base58 rejected on EVM account).

### Changed

- `ConnectorId` type: `"bybit" | "metamask" | "polymarket"` → `"bybit" | "metamask" | "polymarket" | "solana"`. All TS-exhaustive switches now require a Solana branch (caught one missing entry in `src/cache.ts` `DEFAULT_TTL_SEC`).
- `SERVER_VERSION` 0.11.1 → 0.12.0; `package.json` bump.
- `SERVER_INSTRUCTIONS` (system-prompt injection): mentions Solana wallets in the connector list and the Settings routing hint.
- `add_wallet_address` Zod schema relaxed from `regex(/^0x.../)` to `string().min(32)` because the address shape now depends on the parent account's connectorId. Format validation moved into the tool body where we have access to the account.

### Behavior caveats

- Public mainnet-beta RPC rate-limits aggressively (~100 req/10s). For users tracking 3+ Solana wallets, the Settings form prompts for an optional premium RPC URL (Helius / QuickNode / Triton). The connector will work without one, but `getTokenAccountsByOwner` calls can fail under load.
- Token-2022 program accounts are NOT yet enumerated (different program id). Holders of Token-2022 tokens (newer, less common) won't see them in v0.12. Deferred.
- Solana tx history is empty for v0.12 — PnL won't compute realized gains for Solana holdings until v0.13. Cost basis remains "honest unknown" (null), which is the existing contract for any holding without transaction history.

## v0.11.1 — 2026-05-03

User flagged: generic phrases like "open settings" / "open dashboard" could collide with other MCP servers (Vercel deploys / Sentry errors / Grafana metrics / browser settings / OS settings / etc.) when the user has multiple servers installed. Technical-namespace level there's no collision (Claude Desktop scopes tools as `headless-tracker:render_settings`), but the LLM picks tools by reading descriptions — that's where the practical risk lives. Hardened the descriptions + system prompt to keep Claude on rails.

### Changed

- **`render_dashboard` description**: now leads with "PORTFOLIO TRACKER dashboard" (not just "dashboard") and explicitly lists what it's NOT for: Vercel deploys, Sentry errors, Grafana metrics, GitHub activity, analytics events. Mirror change to `render_settings` ruling out app/browser/OS/website settings + a different MCP server's settings panel.
- **`list_accounts` description**: now anchors on "PORTFOLIO TRACKER accounts" and disambiguates from email accounts, social accounts, GitHub accounts, OS user accounts, etc.
- **`refresh_data` description**: same treatment — anchors on portfolio cache, rules out webpage/OAuth/browser cache refresh.
- **`SERVER_INSTRUCTIONS` (system prompt injection)** now leads with a DOMAIN ANCHOR section: "if the user's request is about anything OTHER than crypto/wallet/portfolio/exchange data, DO NOT call headless-tracker tools. When the user says generic things like 'open dashboard' or 'open settings' WITHOUT context implying portfolio, ask for clarification." This is the strongest disambiguation lever — gets injected into Claude's system prompt at session start.

### Why this approach (description + instructions, not tool rename)

1. Server-namespace already prevents literal collision (`headless-tracker:render_settings` vs `notion-mcp:render_settings`). The LLM-routing collision is the real problem.
2. LLM-routing is solved by domain-anchored descriptions + negative-space "NOT for X" hints + DOMAIN ANCHOR in system prompt instructions.
3. Tool renames (`render_dashboard` → `portfolio_dashboard`) would help slightly more but break compatibility for anyone who has the names pinned in custom skills/notes/commands. Cost > benefit at this stage.
4. If we ever observe a real collision in practice (Claude calls our tool when the user clearly meant a different server's), we'll rename — until then, descriptions stay the lever.

### Tests

- 274 tests pass unchanged. Description content changed but the existing assertions check for tool names, tab coverage, behavior contracts — those still hold. The dashboard / settings smoke tests assert `>200 chars` description length; new descriptions are longer.

### What this changes for the user

- "open dashboard" (no portfolio context) → Claude asks "the portfolio dashboard, or did you mean a different one?" instead of jumping straight to render_dashboard.
- "open settings" → same clarification reflex.
- "show my portfolio" / "open my portfolio dashboard" / "open headless-tracker settings" → unambiguous, calls the right tool immediately.

The verbose disclosure in tool descriptions costs ~200 extra tokens per session in the system-prompt-injected instructions. Cheap insurance.

## v0.11.0 — 2026-05-03

The big UX leap: **a full Settings MCP App** for setup + admin, completely replacing the need to drop into a terminal for connecting/managing accounts. User can ask "open settings" and get a live 4-tab UI panel inside Claude Desktop.

### Added

- **7 new MCP tools** behind the Settings UI (also callable directly by the LLM):
  - `list_accounts` — read-only listing of configured accounts. Strips credentials. Optional `connector` filter.
  - `setup_connector` — creates a new account by writing READ-ONLY credentials to the OS keychain. Mirror of the CLI setup flow. Validates against the upstream API before persisting. Discriminated union of `bybit | metamask | polymarket` credentials.
  - `add_wallet_address` — appends an address to an existing MetaMask account's `addresses[]` list. Auto-migrates legacy single-`address` form. Public on-chain identifier; no new secrets.
  - `remove_account` — deletes from AccountStore + keychain. One-way; Settings UI requires explicit confirm dialog before firing.
  - `add_custom_token` — wraps the existing `addCustomToken` from `src/tokens.ts`. Public on-chain data; no keychain.
  - `remove_custom_token` — wraps `removeCustomToken`.
  - `list_custom_tokens` — wraps `listCustomTokens`. Optional `account_id` filter.
- **Settings MCP App** (`render_settings` tool, linked to `ui://headless-tracker/settings`) with four tabs:
  - **Accounts**: read-only list with metadata summary (chains/addresses for MetaMask, account-type for Bybit, proxy short for Polymarket) + Remove button (browser `confirm()` dialog).
  - **Add Account**: connector selector → form per type. Bybit form has API key/secret/account-type. MetaMask form has address, Etherscan key, 6-checkbox chain picker (★ free / $ Pro tier marked), trackCommonTokens + hasEtherscanPro toggles. Polymarket form has just proxy wallet + size threshold. **Yellow-highlighted security disclosure banner** at the top of every form: credentials transit Claude Desktop process → keychain, all three connectors are read-only by design (worst-case leak = portfolio read, never fund movement), CLI path remains for zero-trust.
  - **Wallets**: select an existing MetaMask account from a dropdown, add a new address. Live table below shows tracked addresses per account.
  - **Custom Tokens**: list (with Remove button) + add form (account selector + chain dropdown + contract + symbol + decimals). Re-fetches on add/remove for live update.
- **Build script extension** (`scripts/build-mcp-apps.ts`) — now bundles BOTH `dashboard` and `settings` iframes via the same Bun.build pipeline. Output: `dist/mcp-apps/dashboard.html` (~403KB) + `dist/mcp-apps/settings.html` (~407KB). Both shipped with the package.
- **`SERVER_INSTRUCTIONS` updated** with routing hints for the new tools and a CREDENTIAL HANDLING section: "NEVER echo, log, paraphrase, or repeat any apiKey / apiSecret / etherscanApiKey value back to the user. After successful setup_connector, confirm only the account label and id."

### Changed

- `SERVER_VERSION` 0.10.5 → 0.11.0; `package.json` bump.
- `StubVault` in `test/helpers/stub-connector.ts` now properly implements `Vault` interface (async `set` returning `Promise<Result<void>>`). Existing tests unaffected; new tests can `await vault.set(...)`.
- README hoists a new "Settings panel (live UI for setup + admin)" section right after the Interactive dashboard section, with the explicit security trust-path explanation.

### Tests

- 16 new tests in `test/mcp/tools/admin_tools.test.ts`: `list_accounts` (empty / filtered / no-credential-leak), `setup_connector` Polymarket happy path + missing-creds + invalid-wallet, `add_wallet_address` (unknown account / non-metamask reject / append + legacy migration / duplicate detection), `remove_account` (unknown / store + vault delete), and the custom-token round-trip with non-metamask + invalid-chain rejection.
- 10 new tests in `test/mcp/apps/settings.test.ts`: tool name pinning, URI scheme, four-tab description coverage, behavior-contract assertion (description mentions transcripts + credentials), server-construction smoke, bundle existence + structure + size guard + security-disclosure copy assertion.
- E2E `tools/list` assertion expanded from 7 to 15 tools.
- One existing tool description (`remove_custom_token`) expanded to clear the >200-char descriptions threshold the E2E test enforces for LLM tool-selection accuracy.
- 248 → 274 tests, typecheck clean.

### Why we went with B (forms in iframe) instead of C (loopback localhost browser)

- All three connectors use READ-ONLY credentials by spec (Bybit Read+Trade-Read, no Withdraw; Etherscan rate-limit token for public data; Polymarket proxy wallet is already public). Worst-case leak is portfolio-read, never fund movement. Risk profile is much smaller than typical "API key" intuition implies.
- The host process (Claude Desktop) seeing the postMessage is a much narrower trust path than naive intuition — Claude the LLM doesn't get the payload as conversation context.
- Loopback localhost browser (~1-2 days extra eng) didn't justify the cost given the risk profile.
- CLI stays the zero-trust path for users who want it.

### What this changes for the user

Previously: setup required dropping into a terminal for each connector. Multi-wallet add required editing a vault entry directly.

Now: ask Claude "open settings", click through the form, done. Same writes to the same SQLite + keychain — accounts created via either path show up everywhere immediately.

## v0.10.5 — 2026-05-03

User-spotted bugs from a HUF dashboard screenshot:

1. **"Realized PnL (connector) -24620 Ft"** — wrong. The number was the USD amount with "Ft" suffix slapped on. `get_pnl` had no `currency` arg, so it always returned USD numbers regardless of the dashboard's currency state. Holdings were converting (via `get_holdings --currency=HUF`) but PnL fields weren't.
2. **"+52.09%" / "+12.25%" etc. on the Top Positions table** — the leading `+` is meaningless on allocation percentages (a position can't be a negative share of a portfolio). The sign was useful only for delta values (windowDelta change), but the same `fmtPct` helper drove both contexts.

### Added

- **`currency` arg to `get_pnl`** (`USD | EUR | GBP | HUF`, default `USD`). Mirrors the same pattern as `get_holdings`. When non-USD, every numeric field gets converted via live FX rates: `total.{currentValue, costBasis, unrealizedPnl, realizedPnl}`, `total.realizedFromHistory.knownRealized`, `total.windowDelta.{historicalValue, currentValueAtSnapshot, delta}` (deltaPercent stays untouched — it's a ratio), and per-account fields. Result type gains `currency` (echo) and optional `fx` block (`targetCurrency`, `source`, `rateUsdToTarget`, `fetchedAt`).
- **`fmtPctChange()` formatter** in `src/mcp/apps/dashboard/iframe.ts` — signed percent for delta values (windowDelta change). Renders `+5.20%` / `-3.10%`. The signed/unsigned split is now explicit at the formatter level.

### Changed

- **`fmtPct()` in iframe.ts**: dropped the leading `+` for non-negative values. Allocation percentages (Top Positions table, Risk dimensions) now render as `52.09%` / `12.25%`, not `+52.09%`. Audit of all 6 callsites: 5 are allocations (correct unsigned now), 1 is windowDelta change percent (switched to `fmtPctChange`).
- **Dashboard iframe `get_pnl` calls** now pass `currency` from the iframe's `currency` state. Both Portfolio tab (KPI: `Realized PnL (connector)`) and Weekly tab (windowDelta values) render in the user's chosen currency end-to-end.
- **Tool description** for `get_pnl` mentions the new `currency` arg with the routing hint that consistent currency state requires passing it explicitly.
- `SERVER_VERSION` 0.10.4 → 0.10.5; `package.json` bump.

### Tests

- 5 new tests in `test/mcp/tools/get_pnl.test.ts` for the currency path:
  1. `currency='USD'` (default) → no FX fetch, no `fx` meta, USD values unchanged.
  2. `currency='HUF'` converts ALL numeric fields (total + per-account) and populates `fx` meta with the right rate.
  3. `currency='EUR'` does the EUR-specific math correctly.
  4. `currency='HUF'` with `include_history=true` converts `realizedFromHistory.knownRealized` too.
  5. FX fallback path (both upstream APIs fail) still produces a result with `fx.source: "fallback"`.
- 243 → 248 tests, typecheck clean.

### What this changes for the user

- Dashboard in HUF: the `Realized PnL (connector)` KPI now shows the correctly-converted forint amount (e.g. -7.65M Ft instead of -24620 Ft).
- Top Positions table: clean percentages without the noisy `+` prefix.
- Weekly tab `% change`: still shows `+5.20%` / `-3.10%` style, since direction is meaningful there.

## v0.10.4 — 2026-05-03

User feedback: on the first turn of a session, Claude Desktop showed two warmup tool calls before the actual `get_holdings`. The first attempt failed with "tool has not been loaded yet — call tool_search first to discover parameters." Then a `tool_search` round-trip loaded the schemas, and only then could `get_holdings` succeed. This is Claude Desktop's lazy schema-loading on a server with many tools — a real protocol cost.

### Added

- **`SERVER_INSTRUCTIONS` field** populated on the `McpServer` constructor (`ServerOptions.instructions`). The MCP spec says the host MAY inject this string into the LLM system prompt — Claude Desktop and most modern hosts do. Now the model sees a routing summary on every session start without needing to call `tool_search` first.
- The instructions string (~1.6KB) covers:
  - Tool inventory mapped to user intent ("what do I own" → `get_holdings`, etc.) for all 7 tools.
  - Honesty rules: `realizedPnl: null` is unknown not zero, `windowDelta` is approximate, `skippedSymbols` should be surfaced, `failures[]` should be shown.
  - Fan-out hint: parallelize multi-tool questions in one round-trip (in-flight Promise dedup absorbs duplicate cache hits).
  - Currency support: storage is USD-equivalent, `currency=` arg switches display, `fx.source` warns on fallback.

### Changed

- `SERVER_VERSION` constant 0.10.3 → 0.10.4; `package.json` bump.

### Tests

- 2 new E2E assertions in `test/e2e/mcp-stdio.test.ts`:
  1. `initialize` advertises capabilities for tools, prompts, AND resources.
  2. `initialize` includes an `instructions` string of reasonable size (200-4000 chars), referencing every tool by name AND the honesty rules ("null", "windowDelta").
- The existing `initResult` was hoisted to module scope so multiple tests can assert on the same handshake response.
- 241 → 243 tests, typecheck clean.

### What this changes for the user

Per-session: in Claude Desktop, the first turn no longer wastes a "tool not loaded" round-trip + a `tool_search` discovery hop. The model already has enough routing context from the system-prompt-injected instructions to call the right tool directly. Claude on lazy-load hosts effectively gets a "cheat sheet" before the conversation starts.

### Forward note

If hosts evolve to support richer initialization metadata (e.g. tool-specific examples, or per-tool routing hints in `_meta`), we'd port relevant parts there too. For now `instructions` is the canonical channel.

## v0.10.3 — 2026-05-03

User feedback from the dashboard: a real Bybit portfolio (HYPE, JUP, ENA, DEEP, PUMP, SPEC, MON, VVV, ...) showed "5 priced, 8 skipped" on the Weekly tab — most holdings missing from the static `COINGECKO_IDS` map and `windowDelta` excluding them. The static map was capped at ~28 majors; everything else fell off a cliff.

### Added

- **8 ambiguity-resolved entries** to the static `COINGECKO_IDS` map: `JUP` → `jupiter-exchange-solana`, `HYPE` → `hyperliquid`, `ENA` → `ethena`, `DEEP` → `deep`, `PUMP` → `pump-fun`, `SPEC` → `spectral`, `MON` → `monad`, `VVV` → `venice-token`. Each verified against the CoinGecko search API to pin the correct id (e.g., `JUP` collides with a separate "Jupiter Project" coin at rank 4399, which we explicitly avoid).
- **Dynamic CoinGecko top-250 fallback** in `PriceService.resolveCoinId()`. When a symbol isn't in the static map, the service lazy-fetches `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1` once per 7 days and builds a symbol → id map. For symbol collisions in that list (the same ticker shared by multiple coins), the highest-cap one wins because the rows are pre-sorted by market_cap_desc and we use first-seen-wins.
- **Defensive non-array guard**: CoinGecko occasionally returns an object body with HTTP 200 on rate-limit instead of the documented array. The map loader now treats non-array as a clean miss instead of crashing.

### Changed

- **`get_pnl` window-delta resolution path** now calls `priceService.resolveCoinId()` (async, two-tier) instead of the sync-only `symbolToCoinGeckoId()`. Single dynamic markets fetch per `get_pnl` call covers all symbols in the loop.
- **Skipped-reason text** for unrecognized symbols changed from "no CoinGecko mapping (extend prices.ts COINGECKO_IDS to support)" to "not in CoinGecko top 250 — add to COINGECKO_IDS in src/prices.ts to track". Reflects that we've already tried both static AND dynamic before giving up; the user only needs to extend the static list for genuine long-tail micro-caps that fall outside the top 250.
- README status line bumped to v0.10.3 + 241 tests.
- `SERVER_VERSION` 0.10.2 → 0.10.3; package.json bump.

### Tests

- 8 new `PriceService.resolveCoinId` tests in `test/prices.test.ts`: static-only fast path (no fetch), dynamic miss + dynamic hit + cache reuse on second resolve, symbol collision (highest cap wins), miss falls through to null, fetch failure handled, non-array body handled defensively, static takes precedence over dynamic (pinned ambiguous symbol stays pinned even if /coins/markets returns a different id for it).
- 1 existing test updated for the new skipped-reason wording.
- `symbolToCoinGeckoId` now has an explicit "ambiguity-resolved symbols" assertion covering all 8 user-reported additions.
- 233 → 241 tests, typecheck clean.

### Forward note

If future user portfolios hit symbols outside the top 250 (genuine micro-caps), they show up in the Weekly tab's "skipped" disclosure with an actionable hint pointing at `src/prices.ts`. Adding a one-line entry there fixes the long tail without rebuilding anything else.

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
