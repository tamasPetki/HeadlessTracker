<!-- /autoplan restore point: /Users/kriptom/.gstack/projects/HeadlessTracker/main-autoplan-restore-20260426-214656.md -->
# Roadmap

> Where headless-tracker is, where it's going, and what's intentionally out of scope.
> The full design doc lives at `~/.gstack/projects/HeadlessTracker/kriptom-no-branch-design-20260426-171054.md`.

## v0.7.x — Done (Apr 2026)

The original 14-day plan plus the first burn-in round.

- **Connectors:** Bybit V5 (UNIFIED/SPOT/CONTRACT/FUND), MetaMask multi-chain via Etherscan V2 (Ethereum, Polygon, BSC, Base, Arbitrum, Optimism), Polymarket via public data-api.
- **MCP tools (6):** `get_holdings`, `get_pnl`, `get_polymarket_positions`, `get_transactions`, `get_allocations`, `refresh_data`.
- **Storage:** `bun:sqlite` cache with WAL + busy_timeout retry; per-connector TTL (60s/120s/30s); in-flight Promise dedup against cache stampede.
- **Vault:** `@napi-rs/keyring` with `.env` fallback.
- **Tests:** 110 tests (unit + integration + E2E via `Bun.spawn`), `tsc --noEmit` clean.
- **Burn-in fix #1:** `freeTier` flag on chains — BSC/Base soft-skipped on free Etherscan keys with surfaced warnings (`hasEtherscanPro: true` opts in).
- **Burn-in fix #2:** `meta.scope` + per-account empty/error counts so the LLM can distinguish "0 results" from silent failure.
- **Coverage caveats closed:** MetaMask ERC-20 transfers (`tokentx`) and Polymarket BUY/SELL trades (`/trades?user=PROXY`) — both flipped from "Day 8-10 polish" to shipped.

## v0.7.x — Open (deferred from burn-in round 1)

- **Pricing snapshot consistency** between `get_pnl` and `get_allocations`. Currently each tool computes value off whatever the connector returned at fetch time, so within a single conversation the numbers can diverge if the cache TTL crosses between tool calls. Fix needs a request-scoped price snapshot (one read, both tools share). Refactor-shaped, not bug-shaped.

## v0.8 — Next priorities

User-facing capability additions, ordered by likely value to Tomi:

1. **Custom ERC-20 token list per chain.** Currently the bundled list is `USDC, USDT, WETH, WBTC, LINK, DAI` (chain-dependent). Add `headless-tracker token add <chain> <contract> <symbol> <decimals>` so the user can track project tokens. Source: `src/connectors/metamask.ts:11-15` "V0.2 scope".
2. **MetaMask cost-basis from transaction history.** `get_pnl.ts` notes today: "MetaMask connector does not yet track cost basis (V0 limitation)." With ERC-20 transfers now in scope, FIFO cost basis becomes feasible per token per chain. Unlocks honest unrealized P&L for on-chain holdings.
3. **Polymarket realized P&L from `/trades`.** The trade history we now collect lets us compute true realized P&L (sum of SELL price × size minus BUY cost) instead of falling back to the connector's own `cashPnl` field. Removes the "cashPnl combines realized + unrealized" caveat in `get_pnl`.
4. **Multiple wallets per MetaMask account.** Currently one address per Account row. Lift to a list once a real "I have a hot wallet and a cold wallet" use case shows up.

## v1 — Stable release horizon

- **Time-windowed P&L** (`24h` / `7d` / `30d` / `ytd`). Needs a price-history table seeded from connector snapshots over time. Until then, `get_pnl`'s `timeframe` argument stays informational and the description tells the LLM to be honest about the gap.
- **Automated tool-selection eval.** 10 natural-language prompts × expected tool, run as part of CI. Currently the verbose tool descriptions are believed-good from manual burn-in only (eng review F9, partially deferred from v0.7).
- **Ship checklist:** GitHub repo public, NPM_TOKEN secret, `git tag v1.0.0` (+ awesome-MCP PR submission).

## Success criteria

- **Primary (N=1):** Tomi uses the MCP from Claude Desktop 3+ times per week, 2 months after the v1 release. Local-only usage log (timestamp + tool name, no payload).
- **Secondary (organic):** >10 GitHub stars + >3 external issues/PRs at 6 months — indicator only, not a goal.
- **Anti-success guard:** If Tomi himself stops using it 2 months in, **stop and reconsider** rather than spending another 6 months. Three legitimate readings: thesis wrong, integration not ergonomic, or AI-native habit not yet there.

## Out of scope (Phase 2+, community-driven only)

These are not blocked by v1; they unblock if there's external demand or a concrete personal need.

- CLI binary (`headless-tracker show btc --since=30d`)
- HTTP wrapper for n8n / Zapier / custom scripts
- More connectors: Binance, Kraken, Coinbase, Schwab, eToro, IBKR
- Hosted MCP tier
- Tax export (CSV → TurboTax / NAV)

## How items get promoted

A v0.8 item moves up if **(a)** Tomi hits it during real Claude Desktop use, or **(b)** an external issue/PR shows the same gap. Pure speculation stays in Phase 2.
