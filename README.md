# headless-tracker

[![npm version](https://img.shields.io/npm/v/headless-tracker.svg)](https://www.npmjs.com/package/headless-tracker)

> 🤖 **This project is being developed and maintained autonomously by [Hex](https://x.com/krip_tom), an AI dev agent. Decisions log: [decisions.md](decisions.md) · Daily build log: [daily-log.md](daily-log.md) · Solo team. No human in the dev loop.**

> ⚠️ **Not financial advice.** HeadlessTracker is a portfolio data aggregation tool. For informational purposes only. See [DISCLAIMER.md](DISCLAIMER.md) for full text.

> MCP server for portfolio tracking across crypto exchanges, on-chain wallets, and prediction markets. Query your portfolio from any MCP-compatible AI host (Claude Desktop, Claude Code, Cursor, ChatGPT).

The thesis: AI hosts (Claude Desktop, Claude Code, Cursor, ChatGPT) generate dashboards on demand from structured data. Building yet another tracker UI is wasted work in 2026. Build the data layer; let the AI host be the renderer.

**Status:** Production-ready, live on npm (version badge above). 5 connectors (Bybit, Binance Spot+Futures, MetaMask multi-chain + multi-wallet, Polymarket, Solana multi-wallet), 15 MCP tools (6 data + 7 account/token management + 2 MCP App panels), 3 MCP prompts (`portfolio-dashboard`, `weekly-review`, `risk-check`), interactive 3-tab dashboard MCP App with donut + bar charts (Portfolio / Weekly / Risk + currency switcher + refresh), live Settings MCP App for setup/admin, CLI portfolio queries (`show holdings/pnl/transactions`), custom ERC-20 token lists, FIFO + Average Cost on transaction history, multi-currency display (USD/EUR/GBP/HUF), CoinGecko + Jupiter Price spot + historical price service, time-windowed PnL (`--timeframe=24h|7d|30d|ytd`), 323-test suite. Runs under plain Node (`npx headless-tracker`) or Bun. Working end-to-end with Claude Desktop. See [ROADMAP.md](./ROADMAP.md) for what's done, what's next, and what's intentionally out of scope.

## What it does

Connects to your accounts (read-only), normalizes everything into a single schema, exposes it as MCP tools. Then you ask Claude (or any MCP host):

- "What do I own?"
- "How is my portfolio split between crypto and prediction markets?"
- "Show my Polymarket positions grouped by event."
- "Refresh Bybit and tell me my BTC P&L."

The AI host generates the chart, the table, the breakdown. You don't build a UI.

## Interactive dashboard (live UI panel)

For hosts that support [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) — Claude Desktop, ChatGPT, Goose, VS Code — say:

> Show my dashboard

The host renders a sandboxed iframe in the chat panel with three live tabs:

- **Portfolio** — total value KPIs, top positions table, allocation-by-symbol donut (top 7 + "Other" tail), warnings + failures
- **Weekly** — 7-day window delta KPIs, recent trades table, skipped-symbols disclosure (with reasons)
- **Risk** — concentration audit (single-position, venue, stablecoin reserve, prediction-market overweight) scored PASS / WARN / ALERT, by-venue donut

Plus a currency switcher (USD / EUR / GBP / HUF) and a refresh button. The iframe makes its own follow-up tool calls as the user clicks tabs — no extra prompting needed once it's open. Optional args:

> Open the dashboard in HUF, weekly tab

Implementation: `src/mcp/apps/dashboard/` (browser-side TS bundled into a single `dist/mcp-apps/dashboard.html` via `bun run build:apps`, ships with the package). The bundled artifact ships inside the npm package so users running `npx headless-tracker` don't need a build step.

If your host doesn't render MCP Apps yet, the `render_dashboard` tool still returns a textual confirmation. Use the [prompt cookbook](#prompt-cookbook) below as a fallback — same workflows, same data, just no live UI panel.

## Settings panel (live UI for setup + admin)

For setup that doesn't drop you into a terminal, ask:

> Open settings

The Settings MCP App opens with four tabs:

- **Accounts** — list of configured accounts with a Remove button (one-way confirm dialog; deletes from both the OS keychain and the registry).
- **Add Account** — forms for Bybit / Binance / MetaMask / Solana / Polymarket. Each form validates against the upstream API before persisting credentials. Explicit security disclosure at the top: credentials submitted via the form transit Claude Desktop's process en route to the keychain. **All five connectors use READ-ONLY credentials by design** (Bybit "Read" only, no Withdraw; Binance "Enable Reading" only, no Trade or Withdraw; Etherscan is a public-data rate-limit token; Polymarket proxy wallet is already public; Solana addresses are public on-chain identifiers). Worst-case leak = portfolio-read, never fund movement. For zero-trust, the CLI flow (`bun run setup <connector>`) stays available.
- **Wallets** — add an additional wallet address to an existing MetaMask OR Solana account (multi-wallet under one MCP account, sharing the same Etherscan key/chain selection or RPC URL).
- **Custom Tokens** — list / add / remove ERC-20 tokens per chain. Token data is public on-chain; no keychain involvement.

Either path (CLI or Settings UI) writes to the same `~/.headless-tracker/cache.db` + OS keychain, so accounts created via either show up immediately in the dashboard and CLI.

## Quick start

### 1. Install

No clone, no build step, no Bun required. The package runs under plain Node (≥ 22.5) or Bun. Install it globally:

```bash
npm install -g headless-tracker
```

Or run any command without installing by prefixing `npx`, e.g. `npx headless-tracker setup solana`. (Building from source for development uses Bun — see [Development](#development).)

### 2. Configure your accounts (interactive)

Run setup for each integration you want. Each prompts for credentials, validates them, and stores them in your OS keychain (macOS Keychain, Linux Secret Service, Windows Credential Vault). On a headless box with no keychain, see [Headless / no OS keychain](#headless--no-os-keychain-docker-wsl-servers-ci) below.

```bash
headless-tracker setup bybit
headless-tracker setup binance
headless-tracker setup metamask
headless-tracker setup solana
headless-tracker setup polymarket
```

Verify what's configured:
```bash
headless-tracker list-accounts
```

#### Headless / no OS keychain (Docker, WSL, servers, CI)

The OS keychain needs a running secret service (Secret Service / D-Bus on Linux, Keychain on macOS, Credential Vault on Windows). Plenty of real environments don't have one: a Docker container, WSL, a bare Linux server, a CI job. There, the keychain write fails.

In that case `setup` does **not** abort. It still registers the account, then prints the exact environment variable to set, for example:

```
⚠  OS keychain unavailable, so credentials were NOT stored (...). The account is
   registered. ... set the HEADLESS_TRACKER_SOLANA_<ADDR> environment variable to a
   JSON object in your MCP server's env, then restart.
```

Set that variable to the connector's credential JSON in your MCP server's `env` block (or your shell), then restart. The env var always takes precedence over the keychain, so this also works as an explicit override. Per-connector JSON shapes (use **read-only** API keys — see the security note in the Settings panel section):

| Connector | Env var (printed by `setup`) | JSON value |
|-----------|------------------------------|------------|
| Bybit | `HEADLESS_TRACKER_BYBIT_<ACCOUNTTYPE>` | `{"apiKey":"...","apiSecret":"...","accountType":"UNIFIED"}` |
| Binance | `HEADLESS_TRACKER_BINANCE_KEY_<FIRST6>` | `{"apiKey":"...","apiSecret":"...","includeFutures":false}` |
| MetaMask | `HEADLESS_TRACKER_METAMASK_0X<ADDR>` | `{"address":"0x...","etherscanApiKey":"...","chainIds":[1],"trackCommonTokens":true,"hasEtherscanPro":false}` |
| Solana | `HEADLESS_TRACKER_SOLANA_<ADDR>` | `{"address":"<base58>"}` (optional `"rpcUrl"`, `"dustThresholdUsd"`) |
| Polymarket | `HEADLESS_TRACKER_POLYMARKET_0X<ADDR>` | `{"proxyWallet":"0x...","sizeThreshold":0.01}` |

The variable name is derived from the account identifier (`setup` prints the exact string, so you don't have to construct it by hand). Example for a Claude Desktop / MCP config `env` block:

```json
"env": {
  "HEADLESS_TRACKER_SOLANA_<ADDR>": "{\"address\":\"<base58 address>\"}"
}
```

### 3. Wire up Claude Desktop

Edit your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "headless-tracker": {
      "command": "npx",
      "args": ["-y", "headless-tracker"]
    }
  }
}
```

That's the whole config: no absolute paths, no clone location, no Bun. `npx -y headless-tracker` with no subcommand starts the MCP server over stdio (npx caches after the first run). If you installed globally with `npm i -g headless-tracker`, you can use `"command": "headless-tracker"` with no `args` instead.

Restart Claude Desktop (Cmd+Q, then reopen — the in-app "new conversation" doesn't reload config).

### 4. Try it

Open a new conversation in Claude Desktop:

> What's in my portfolio?

> How is my portfolio split between crypto and prediction markets?

> Show my Polymarket positions sorted by current value.

If Claude doesn't see the tools, check `~/Library/Logs/Claude/mcp-server-headless-tracker.log`.

### 5. Use the interactive dashboard (MCP App)

Once setup works, ask:

> Show my dashboard

The live UI panel pops up in the chat. See the [Interactive dashboard](#interactive-dashboard-live-ui-panel) section above for what's in each tab and how to pass args.

### 6. Use the preset prompts (one-click dashboards)

The MCP server ships three prompt templates. They show up in Claude Desktop's prompt picker (the `/` or attachment menu, depending on version) and in Claude Code as slash commands. Each one steers Claude through a specific multi-tool workflow:

| Prompt | What it does |
|--------|--------------|
| `portfolio-dashboard` | Calls `get_holdings` + `get_allocations` + `get_pnl` + `get_polymarket_positions` in parallel and renders a complete multi-section dashboard (HTML artifact when supported). |
| `weekly-review` | 7-day window delta + biggest movers + recent trades + one observation. Approximation caveat surfaced honestly (current basket at historical prices, NOT trades within the window). |
| `risk-check` | Concentration / venue / stablecoin reserve / prediction-market overweight / chain concentration. Each dimension scored PASS / WARN / ALERT with the actual percentages. |

You can also paste any of these prompts directly — they're plain text. See the cookbook below.

## Prompt cookbook

Copy-paste these into any MCP-aware client. Each one expects the headless-tracker MCP server to be configured. None of them require new code on the server side.

**Quick "where do I stand"**
> Build me a complete portfolio dashboard. Call get_holdings, get_allocations (by asset_class and by symbol), get_pnl, and get_polymarket_positions in parallel and synthesize a single dashboard artifact. Show top 10 positions, asset-class breakdown, total PnL. Be honest about NULL fields — don't fabricate.

**Quick "how was this week"**
> Give me a 7-day review. Call get_pnl with timeframe=7d, get_holdings, and get_transactions with since=7d. Surface windowDelta with the approximation caveat ("current basket at historical prices, not trades within the window"), list the trades by exchange, and end with one short observation about what drove the change.

**Quick "should I be worried"**
> Risk check my portfolio. Call get_holdings and get_allocations (by symbol, by asset_class, by connector). Score each: single-position concentration (ALERT > 40%), venue concentration (ALERT > 70%), stablecoin reserve (WARN < 5%, ALERT = 0%), prediction-market overweight (WARN > 15%). Output as a markdown table.

**Tax season**
> I need to do my taxes. Call get_transactions for the past year (since=365d). Then call get_pnl with include_history=true and method=fifo. Group realized PnL by symbol and by month. Flag any sales with unknown cost basis (deposits / transfers without price) — those are honest gaps I'll have to research separately.

**HUF view (or EUR / GBP)**
> Show my portfolio in Hungarian forint. Call get_holdings with currency=HUF. Sort by value descending. Sum the total in HUF and tell me whether the FX source was the live API or the static fallback.

**Polymarket bet review**
> Walk me through my Polymarket positions. Call get_polymarket_positions with group_by_event=true. Then call get_pnl with include_history=true to get realized PnL via FIFO over /trades. For each event, show: title, my outcome holdings, current value, realized PnL so far, and end date. Flag any redeemable positions I should claim.

## Quick portfolio queries from the CLI (no Claude required)

For the 3-second "what's in my portfolio?" question without opening Claude Desktop:

```bash
headless-tracker show holdings
headless-tracker show pnl
headless-tracker show transactions --since=7d
```

Each prints a text table. Filters work: `show holdings --account-id=bybit:UNIFIED`, `show holdings --asset-class=crypto`, `show transactions --since=24h --account-id=metamask:0xabc`.

### Multi-currency display

`show holdings` defaults to USD. Pass `--currency=` for live FX-converted values:

```bash
headless-tracker show holdings --currency=HUF
headless-tracker show holdings --currency=EUR
```

FX rates come from a free public API (`exchangerate-api.com`) with `frankfurter.dev` as fallback, plus a static fallback if both fail (which surfaces as a warning so you know the displayed numbers may be a few percent stale). Supported: `USD`, `EUR`, `GBP`, `HUF`.

### Cost basis methods (FIFO vs Average)

For honest realized P&L based on your transaction history (not connector metadata which can mix realized + unrealized for prediction markets):

```bash
headless-tracker show pnl --include-history=true
headless-tracker show pnl --include-history=true --method=average
```

`--method=fifo` (default): consumes the oldest lot first per sell.
`--method=average`: pools all priced acquisitions; sells out at the running weighted average.

Both methods preserve the "honest unknown" rule: tokens received via wallet transfer-in (no price) produce `realizedPnl: null` for any sell drawing from them — NOT a fabricated number. The realized PnL counts only sales whose every consumed lot had a known cost basis.

### Time-windowed PnL

```bash
headless-tracker show pnl --timeframe=7d
headless-tracker show pnl --timeframe=24h
headless-tracker show pnl --timeframe=ytd
```

Values your **current basket** at historical CoinGecko prices and reports the delta vs. now. **Approximation:** it does NOT account for trades within the window — it answers "if I held this exact basket N days ago, how much have I gained?" Polymarket positions and crypto without a CoinGecko mapping are skipped (counted in `skippedSymbols`). CoinGecko free-tier historical is daily granularity, so `--timeframe=24h` is "yesterday's close vs now".

## Custom ERC-20 tokens

The bundled MetaMask token list covers `USDC, USDT, WETH, WBTC, LINK, DAI`. To track project-specific tokens:

```bash
headless-tracker token add metamask:0xabc 1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 USDC 6
headless-tracker token list
headless-tracker token remove metamask:0xabc 1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```

Custom tokens are stored per-account in the SQLite account store (NOT the keychain — they're public on-chain identifiers, not secrets).

## Supported integrations

| Connector | Auth | Status | Notes |
|-----------|------|--------|-------|
| Bybit V5 | API key + secret | ✓ Full | UNIFIED / SPOT / CONTRACT / FUND accounts. Read-only key. |
| Binance | API key + secret | ✓ Holdings | Spot account (`/api/v3/account`) + optional Futures wallet/positions (`/fapi/v2/account`). Read-only key ("Enable Reading" only). Stablecoins priced at $1; non-stable assets priced via batch `/api/v3/ticker/24hr?type=MINI`. Open futures positions surface as separate Holdings with side/leverage/PnL/liquidation in metadata. Tx history is `ok([])` for v0.13 — deferred. binance.com only (binance.us deferred). |
| MetaMask / EVM wallets | Etherscan V2 API key | ✓ Full | Single key covers Ethereum, Polygon, BSC, Base, Arbitrum, Optimism. Native + bundled common ERC-20 tokens (USDC, USDT, WETH, WBTC, LINK, DAI) for balances; native + ERC-20 transfers for transactions. Custom token lists via `headless-tracker token add ...`. Multi-wallet per account (one Etherscan key, multiple addresses). BSC/Base require Etherscan Pro on the free tier (auto-skipped with a warning otherwise). |
| Polymarket | Proxy wallet address (no API key) | ✓ Full | Uses public data-api. Positions + BUY/SELL trade history (up to ~1000 most recent) via `/trades?user=PROXY`. |
| Solana wallets | Base58 address (no API key) | ✓ Holdings | Public Solana RPC + Jupiter Price API v2. Native SOL + SPL tokens (Token program v1; Token-2022 deferred). Multi-wallet per account, optional premium RPC URL (Helius/QuickNode/Triton) for users tracking 3+ wallets. Pinned metadata for major mints (USDC/USDT/mSOL/JUP/JTO/PYTH/BONK/RNDR/WIF/JLP). Tx history is `ok([])` for v0.12 — coming in v0.14 with premium-RPC opt-in. |

To add a new connector, implement `Connector` from `src/connectors/types.ts` and add it to `CONNECTOR_FACTORIES` in `src/mcp/orchestrator.ts`. ~150-400 lines of code per connector based on the existing five (depends on whether the upstream API is REST/SDK/RPC and how rich the response shape is).

## MCP tools exposed

| Tool | Purpose | Common prompts |
|------|---------|----------------|
| `get_holdings` | Current holdings across all accounts | "what do I own", "show my portfolio", "current positions" |
| `get_pnl` | Aggregate profit/loss summary | "how am I doing", "what's my P&L", "am I up or down" |
| `get_polymarket_positions` | Polymarket-specialized, event-grouped | "show my Polymarket bets", "election bets" |
| `get_transactions` | Transaction history with `since` filter | "show my recent trades", "transactions this week" |
| `get_allocations` | Group-by breakdown (asset class / connector / chain / symbol) | "how is my portfolio split", "biggest positions" |
| `refresh_data` | Force cache invalidation | "refresh", "get the latest", "fetch now" |

The data tools accept an optional `account_id` filter (e.g. `metamask:0xabc...`, `bybit:UNIFIED`). Without a filter, they query everything.

Account and setup management (all credential writes are read-only API keys stored in the OS keychain):

| Tool | Purpose |
|------|---------|
| `setup_connector` | Configure a connector by writing read-only credentials to the OS keychain |
| `list_accounts` | List configured accounts without exposing credentials |
| `add_wallet_address` | Add another wallet address to an existing MetaMask or Solana account |
| `remove_account` | Delete an account and its credentials from the keychain |
| `add_custom_token` | Track a project-specific ERC-20 token on a MetaMask account |
| `remove_custom_token` | Stop tracking a custom ERC-20 token (public on-chain data, no keychain) |
| `list_custom_tokens` | List the custom ERC-20 tokens tracked per MetaMask account |

MCP App panels (interactive UI rendered in the chat):

| Tool | Purpose |
|------|---------|
| `render_dashboard` | Interactive dashboard panel: holdings, P&L, allocations, prediction markets |
| `render_settings` | Settings panel: a GUI alternative to the CLI setup flow |

## Why local-first

- **API keys never leave your machine.** Stored in your OS keychain via [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node).
- **Cache is local SQLite** (the runtime's built-in driver: `node:sqlite` under Node, `bun:sqlite` under Bun). No server, no SaaS, no telemetry, no analytics pings.
- **Read-only by design.** No transaction signing. Nothing this tool can do can lose your money.
- **Per-connector cache TTL** (crypto wallets 60s, exchanges 120s, Polymarket 30s) keeps things fast without hammering upstream APIs.

## Architecture

```
              ┌────────────────────────────┐
              │     headless-tracker       │
              │      (Node or Bun)         │
              │  ────────────────────────  │
              │  src/connectors/           │
              │    bybit.ts                │
              │    metamask.ts             │
              │    polymarket.ts           │
              │  src/types.ts (schema)     │
              │  src/cache.ts (SQLite)     │
              │  src/vault.ts (keyring)    │
              │  src/accounts.ts (registry)│
              │  src/mcp/orchestrator.ts   │  ← parallel fan-out + in-flight Promise dedup
              │  src/mcp/server.ts         │  ← McpServer + 15 tools
              │       ▲                    │
              │       │ stdio MCP          │
              └───────┼────────────────────┘
                      │
       ┌──────────────┼──────────────┐
       │              │              │
┌──────▼──────┐ ┌─────▼─────┐ ┌──────▼──────┐
│Claude Desktop│ │Claude Code│ │ Cursor/Codex│
│  ChatGPT     │ │           │ │  ZED, etc.  │
└──────────────┘ └───────────┘ └─────────────┘
```

## Sample prompts and responses

The point of headless-tracker is that you don't write SQL or learn a CLI — you ask Claude. Some example sessions:

**"What do I own?"**
> Claude calls `get_holdings({})` and returns a formatted breakdown: "You currently hold 0.5 BTC (~$30,000), 2 ETH (~$5,000) on Bybit, plus 1 ETH on your MetaMask wallet, and one Polymarket position on the 2024 election worth $60. Total portfolio value: ~$35,060."

**"Show my Polymarket bets grouped by event."**
> Claude calls `get_polymarket_positions({ group_by_event: true })` and renders an event-grouped table with title, your Yes/No outcome holdings, total event value, and combined cash P&L per event.

**"How am I split between crypto and prediction markets?"**
> Claude calls `get_allocations({ by: "asset_class" })` and returns a percentage breakdown: "97.5% crypto ($35,000), 2.5% prediction ($1,000)."

**"Refresh my data and show the latest holdings."**
> Claude calls `refresh_data({})` then `get_holdings({})` — the cache is invalidated, fresh data is fetched from all upstream APIs in parallel, and Claude renders the new state.

**"Give me a complete portfolio dashboard."**
> Claude calls multiple tools in parallel (`get_holdings`, `get_allocations`, `get_pnl`, `get_polymarket_positions`) and synthesizes a multi-section dashboard. The orchestrator's in-flight Promise dedup ensures each connector is hit at most once even when fan-out is wide.

## Development

Building from source uses [Bun 1.3+](https://bun.sh). End users don't need this — see [Quick start](#quick-start).

```bash
git clone https://github.com/tamasPetki/HeadlessTracker.git
cd headless-tracker
bun install
bun test                              # 323 tests, ~5s
bun run typecheck                     # bun --bun tsc --noEmit
bun run build:apps                    # bundle the dashboard MCP App into dist/mcp-apps/
bun run build                         # build the Node-runnable dist/ (what npm ships)
bun run start                         # start MCP server on stdio (debug only)
bun run setup bybit                   # interactive credential setup
```

To add a connector, follow the existing pattern in `src/connectors/`. The `Connector` interface enforces uniform `Result<T>` error handling across all integrations — there is no exception-throwing path for expected failures (auth, rate limit, network).

## FAQ

**Will my API keys be sent anywhere?**
No. They're stored in your OS keychain and only sent to the upstream API they're for (Bybit's API for Bybit keys, Etherscan's API for Etherscan keys). The MCP server runs entirely on your machine.

**Polymarket has my positions but Claude can't see them.**
Make sure you used your **Polymarket proxy wallet address**, not your MetaMask address. Find it in the Polymarket UI under Settings → Wallet. Re-run `setup polymarket` if you used the wrong one.

**Bybit returns auth_failed.**
Verify the API key has Wallet Read + Trade Read permissions (NO Withdraw needed). If you set an IP whitelist on the key, make sure your machine's current public IP is on it.

**Etherscan returns rate_limited.**
The free tier is 5 calls/sec, 100k/day. Each MetaMask refresh costs (1 + N tokens) calls per chain. If you have 4 chains × 7 common tokens, that's 32 calls per refresh. Spread your refresh requests; the cache TTL (60s for MetaMask) is there for a reason.

**Can I use this without Claude Desktop?**
Yes — any MCP-compatible host works (Claude Code, Cursor, Codex, ZED, ChatGPT once their MCP support stabilizes). Wire it the same way; just change which client config file you edit. There's also a CLI (`headless-tracker show holdings/pnl/transactions`) for terminal queries that don't need an AI host at all.

**Realized P&L looks wrong.**
For Polymarket, default `get_pnl` returns `realizedPnl: null` because the connector's `cashPnl` field mixes realized + unrealized. Pass `include_history=true` (or `--include-history=true` from the CLI) to get the honest number computed from FIFO over your `/trades` history. For MetaMask, on-chain transfer-in tokens have no known cost basis — `include_history=true` reports them as `unknownSalesCount` instead of fabricating $0.

**Can one MetaMask account track multiple wallets?**
Yes. v0.8 added `addresses[]` to MetaMask credentials. The setup CLI still asks for one wallet (back-compat), but the connector accepts a list. Edit the vault entry directly to add more addresses to the same account, sharing the same Etherscan key + chain selection. A `wallet add` CLI command is on the v0.9 list if there's demand.

**Does this support [my favorite exchange / chain / market]?**
Not yet. Open an issue or PR. The Connector interface is open for extension and the existing 3 connectors are reference implementations totaling ~600 lines.

**What about transaction history for Polymarket?**
Supported as of v0.7.1: `get_transactions` returns BUY/SELL trades from the public data-api `/trades?user=PROXY` endpoint, up to ~1000 most recent. The data-api ignores time-bound query params, so the `since` filter is enforced client-side; pagination terminates early once a page falls before the cutoff.

**Why no UI?**
Claude Desktop, ChatGPT, and Cursor all generate richer dashboards on demand than I'd ship in v1. Building a UI duplicates work the AI host already does better. If you want a hosted web UI, see [bulltrapp.com](https://bulltrapp.com).

## Related

[bulltrapp.com](https://bulltrapp.com) — a hosted web portfolio tracker by the same maintainer. Same problem space, different surface. Use either or both.

## License

MIT
