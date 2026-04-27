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

## v0.8.0 — Done (Apr 2026)

5 capability commits + release-prep. 162 tests, typecheck clean. Capability scope set by /autoplan review (premise gate option B): promote distribution + CLI from Phase 2+ to v0.8. See the Decision Audit Trail below for every choice the review made.

- **CLI portfolio queries** (commit `607da9a`): `show holdings | pnl | transactions [--account-id=X] [--asset-class=Y] [--since=7d]`. Reuses the same orchestrator the MCP server uses; presentation layer is a text table. Unlocks the "mennyi a portfoliom?" 3-second answer without opening Claude Desktop.
- **Custom ERC-20 token list** (commit `057baf2`): `token add | list | remove`. Stored in `Account.metadata.customTokens`, NOT the keychain (tokens are public on-chain identifiers). Orchestrator merges them into connector credentials at fetch time.
- **FIFO cost basis tracker** (commit `c259a3a`): new `src/cost_basis.ts` module + `get_pnl --include-history`. Honest cost basis is the design point: tokens received via wallet transfer-in have no known price; lots get `costBasisKnown=false`; any SELL consuming them produces `realizedPnl: null` — NOT $0, NOT NaN. The /autoplan TC10 critical regression is pinned in tests.
- **Polymarket realized P&L from `/trades`** (commit `75d1126`): replaces the `cashPnl` mixed metric. Default mode → Polymarket realized = null with a note pointing to `include_history=true`. With history, FIFO over /trades gives the canonical number.
- **Multi-wallet per MetaMask account** (commit `def9e1d`): additive `addresses?: string[]` schema. Legacy single-`address` vaults auto-upgrade at runtime (1-element list). Connector fans out per-(address × chain). Setup CLI still single-wallet for back-compat.
- **Side fix:** `bun test --timeout 15000` → `--timeout=15000` in package.json. The space-form was silently ignored; E2E flakiness "fix" only properly activated with the `=` form.

## v0.8.x — Open (deferred from earlier rounds)

- **Pricing snapshot consistency** between `get_pnl` and `get_allocations`. Each tool computes value off whatever the connector returned at fetch time; within a single conversation the numbers can diverge if the cache TTL crosses between tool calls. Fix needs a request-scoped price snapshot (one read, both tools share). Refactor-shaped, not bug-shaped. Carried over from v0.7 burn-in.
- **Ship public** (the only v0.8 item not yet executed because it's a user-side action): GitHub repo public, NPM_TOKEN secret, `git tag v0.8.0`, awesome-MCP PR. Until this happens, the "open source as serendipity strategy" produces 0 signal.

## v1 — Stable release horizon

v1 is **user-feedback-driven**, not feature-driven. Promotion happens when round-2+ burn-in either confirms the items below are missed, or surfaces something else. Listed items below are candidates, not blockers.

- **Time-windowed P&L** (`24h` / `7d` / `30d` / `ytd`). Needs a price-history table seeded from connector snapshots over time. Promote if Tomi asks for it during burn-in 3+ times.
- **Automated tool-selection eval.** 10 natural-language prompts × expected tool, run as part of CI. Promote if a tool-mismatch causes a wrong-data-shown incident in round-2 burn-in.

## Success criteria

- **Primary (N=1):** Tomi uses the MCP (or CLI binary) 3+ times per week, 2 months after the v1 release, AND at least half of those uses query connector data the LLM couldn't answer alone (filtering out meta-questions like "what tools do you have"). Local-only usage log (timestamp + tool name + boolean used-connector-data, no payload). The data filter matters because raw "uses MCP" can be inflated by curiosity, but "answered a portfolio question I needed answered" is the real outcome.
- **Secondary (organic):** >10 GitHub stars + >3 external issues/PRs at 6 months — indicator only, not a goal.
- **Anti-success guard:** If Tomi himself stops using it 2 months in, **stop and reconsider** rather than spending another 6 months. Three legitimate readings: thesis wrong, integration not ergonomic, or AI-native habit not yet there.

## Out of scope (Phase 2+, community-driven only)

These are not blocked by v1; they unblock if there's external demand or a concrete personal need.

- HTTP wrapper for n8n / Zapier / custom scripts
- More connectors: Binance, Kraken, Coinbase, Schwab, eToro
- Cross-venue cost basis (CEX → wallet transfer matching) — taxonomy work, ~600 LOC
- Hosted MCP tier
- Tax export (CSV → TurboTax / NAV)

## How items get promoted

A backlog item moves up if **(a)** Tomi hits it during real Claude Desktop use, or **(b)** an external issue/PR shows the same gap. Pure speculation stays in Phase 2.

## Round 2 burn-in checklist (post v0.8.0 ship)

Before considering v0.8 closed, re-run these against Claude Desktop with the v0.8 build:

- [ ] `What's in my portfolio?` — verify warnings field surfaces any soft-skipped chains, multi-wallet metadata.address differentiates wallets if multi.
- [ ] `Show my recent transactions from the last 24h.` — verify `meta.accountsWithEmptyResults` distinguishes "0 trades" from silent fail (burn-in fix #2).
- [ ] `Show holdings filtered to my MetaMask wallet, only crypto.` — verify POL + native + ERC-20 + custom tokens all present (P2-POL regression).
- [ ] `How am I doing? Include history.` — verify `get_pnl` with `include_history=true` returns FIFO realized for Polymarket and surfaces `unknownSalesCount` for MetaMask deposits.
- [ ] CLI smoke: `bun run bin/headless-tracker.ts show holdings`, `... show pnl --include-history=true`, `... show transactions --since=7d`.
- [ ] Token CLI: `token add` a project token you actually hold, `show holdings`, verify it shows up.
- [ ] Tarball check: `npm pack --dry-run`, inspect file list — no `.env`, no `cache.db`, no secrets, no node_modules (FM-E1).
- [ ] First-time install on a clean macOS user account or Docker container — TTHW < 5 min target (DX scorecard goal).

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail (autoplan run 2026-04-27)

| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|----------------|-----------|-----------|
| 1 | CEO | Mode = SELECTIVE EXPANSION | Mechanical | autoplan default | Skill default for review of an existing-but-evolving plan |
| 2 | CEO | Promote CLI binary from Phase 2+ to v0.8 #2 | TASTE → user chose B | F1 + P1 completeness | HOUR 6 use case shows CLI is daily-use. User confirmed at premise gate. |
| 3 | CEO | Promote ship-public from v1 to v0.8 #1 | TASTE → user chose B | F4 + P6 bias toward action | "Open source as serendipity" produces 0 signal until repo public. Confirmed at premise gate. |
| 4 | CEO | Soften v1 ship gate (time-windowed PnL + tool-selection eval no longer blockers) | TASTE → user chose B | F2 | v1 should be user-feedback-driven, not feature-driven. Confirmed at premise gate. |
| 5 | CEO | Add cost-basis #4 caveat: "on-chain only, no cross-venue" | Mechanical | F3 + P1 (honesty in roadmap) | Cross-venue requires CEX↔wallet matching, ~600 LOC, taxonomy work. Stays Phase 2+. |
| 6 | CEO | Tighten success metric: must include used-connector-data filter | Mechanical | F5 + P1 | Raw "uses MCP" can be inflated by curiosity; the real outcome is portfolio questions answered. |
| 7 | CEO | Drop IBKR from "Out of scope" list (already dropped in design doc) | Mechanical | F7 + P4 DRY | Inconsistent stale entry. |
| 8 | Eng | Custom tokens stored in `Account.metadata.customTokens`, not Vault | Mechanical | DRY (Sec 2 finding) | Tokens are not secrets; AccountStore already has WAL retry. |
| 9 | Eng | Multi-wallet uses additive `addresses?: string[]` schema, not breaking change | Mechanical | P5 + back-compat | Existing accounts auto-upgrade via AccountStore migration on open. |
| 10 | Eng | Sequence v0.8 #6 (multi-wallet) LAST in the release | Mechanical | Section 1 coupling assessment | Highest blast radius; sequence late so #1-5 don't block on it. |
| 11 | Eng | Add 15 new tests (TC1-TC15), TC16 manual one-time | Mechanical | P1 completeness | Every new codepath gets a test; CLI gets integration coverage. |
| 12 | Eng | Orphan SELL → cost basis = null (not NaN) | Mechanical | FM-E4 | NaN propagates silently through sums; null forces explicit handling at consumer. |
| 13 | Eng | `npm publish --dry-run` is manual one-time, not CI | Mechanical | P3 pragmatic | CI integration brittle; one inspection per release tag is enough. |
| 14 | DX | Rename `list-accounts` → `accounts list` (consistency with `show <thing>` / `token <verb>`) | TASTE | Pass 2 nitpick | Surfaced at gate as low-priority. |
| 15 | DX | Add `CONTRIBUTING.md` with "Adding a connector" section in v0.8 | Mechanical | Pass 4 gap | Required for personas 3 (self-hosters extending). |
| 16 | DX | AccountStore auto-migrates `address` → `addresses` on open | Mechanical | Pass 5 gap, FM-E3 | User runs `npm install -g headless-tracker@0.8` and just works. |
| 17 | DX | README "magic moment" gif/screencast for v0.8 ship | Mechanical | Pass 7 + the design doc's "no 30s whoa demo" gap | CLI binary unlocks the cleanest demo. |
