# headless-tracker

> MCP server for portfolio tracking across crypto exchanges, on-chain wallets, and prediction markets. Query your portfolio from any MCP-compatible AI host (Claude Desktop, Claude Code, Cursor, ChatGPT).

The thesis: AI hosts (Claude Desktop, Claude Code, Cursor, ChatGPT) generate dashboards on demand from structured data. Building yet another tracker UI is wasted work in 2026. Build the data layer; let the AI host be the renderer.

**Status:** v0.7.1-burn-in. 3 connectors (Bybit, MetaMask multi-chain, Polymarket), 6 MCP tools, 110-test suite. Working end-to-end with Claude Desktop.

## What it does

Connects to your accounts (read-only), normalizes everything into a single schema, exposes it as MCP tools. Then you ask Claude (or any MCP host):

- "What do I own?"
- "How is my portfolio split between crypto and prediction markets?"
- "Show my Polymarket positions grouped by event."
- "Refresh Bybit and tell me my BTC P&L."

The AI host generates the chart, the table, the breakdown. You don't build a UI.

## Quick start

### 1. Install

```bash
git clone https://github.com/PietScarlet/headless-tracker.git
cd headless-tracker
bun install
```

Requires [Bun 1.3+](https://bun.sh).

### 2. Configure your accounts (interactive)

Run setup for each integration you want. Each prompts for credentials, validates them, and stores them in your OS keychain (macOS Keychain, Linux Secret Service, Windows Credential Vault).

```bash
bun run bin/headless-tracker.ts setup bybit
bun run bin/headless-tracker.ts setup metamask
bun run bin/headless-tracker.ts setup polymarket
```

Verify what's configured:
```bash
bun run bin/headless-tracker.ts list-accounts
```

### 3. Wire up Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "headless-tracker": {
      "command": "/path/to/bun",
      "args": ["run", "/absolute/path/to/headless-tracker/bin/headless-tracker.ts"]
    }
  }
}
```

Replace `/path/to/bun` with the output of `which bun` and the project path with your clone location.

Restart Claude Desktop (Cmd+Q, then reopen — the in-app "new conversation" doesn't reload config).

### 4. Try it

Open a new conversation in Claude Desktop:

> What's in my portfolio?

> How is my portfolio split between crypto and prediction markets?

> Show my Polymarket positions sorted by current value.

If Claude doesn't see the tools, check `~/Library/Logs/Claude/mcp-server-headless-tracker.log`.

## Supported integrations

| Connector | Auth | Status | Notes |
|-----------|------|--------|-------|
| Bybit V5 | API key + secret | ✓ Full | UNIFIED / SPOT / CONTRACT / FUND accounts. Read-only key. |
| MetaMask / EVM wallets | Etherscan V2 API key | ✓ Full | Single key covers Ethereum, Polygon, BSC, Base, Arbitrum, Optimism. Native + bundled common ERC-20 tokens (USDC, USDT, WETH, WBTC, LINK, DAI) for balances; native + ERC-20 transfers for transactions. Custom token lists planned for v0.8. BSC/Base require Etherscan Pro on the free tier (auto-skipped with a warning otherwise). |
| Polymarket | Proxy wallet address (no API key) | ✓ Full | Uses public data-api. Positions + BUY/SELL trade history (up to ~1000 most recent) via `/trades?user=PROXY`. |

To add a new connector, implement `Connector` from `src/connectors/types.ts` and add it to `CONNECTOR_FACTORIES` in `src/mcp/orchestrator.ts`. ~150 lines of code per connector based on the existing three.

## MCP tools exposed

| Tool | Purpose | Common prompts |
|------|---------|----------------|
| `get_holdings` | Current holdings across all accounts | "what do I own", "show my portfolio", "current positions" |
| `get_pnl` | Aggregate profit/loss summary | "how am I doing", "what's my P&L", "am I up or down" |
| `get_polymarket_positions` | Polymarket-specialized, event-grouped | "show my Polymarket bets", "election bets" |
| `get_transactions` | Transaction history with `since` filter | "show my recent trades", "transactions this week" |
| `get_allocations` | Group-by breakdown (asset class / connector / chain / symbol) | "how is my portfolio split", "biggest positions" |
| `refresh_data` | Force cache invalidation | "refresh", "get the latest", "fetch now" |

Each tool accepts an optional `account_id` filter (e.g. `metamask:0xabc...`, `bybit:UNIFIED`). Without a filter, tools query everything.

## Why local-first

- **API keys never leave your machine.** Stored in your OS keychain via [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node).
- **Cache is local SQLite** (`bun:sqlite`). No server, no SaaS, no telemetry, no analytics pings.
- **Read-only by design.** No transaction signing. Nothing this tool can do can lose your money.
- **Per-connector cache TTL** (crypto wallets 60s, exchanges 120s, Polymarket 30s) keeps things fast without hammering upstream APIs.

## Architecture

```
              ┌────────────────────────────┐
              │     headless-tracker       │
              │       (Bun process)        │
              │  ────────────────────────  │
              │  src/connectors/           │
              │    bybit.ts                │
              │    metamask.ts             │
              │    polymarket.ts           │
              │  src/types.ts (schema)     │
              │  src/cache.ts (bun:sqlite) │
              │  src/vault.ts (keyring)    │
              │  src/accounts.ts (registry)│
              │  src/mcp/orchestrator.ts   │  ← parallel fan-out + in-flight Promise dedup
              │  src/mcp/server.ts         │  ← McpServer + 6 tools
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

```bash
bun install
bun test                              # 99 tests, ~1.5s
bun run typecheck                     # bun --bun tsc --noEmit
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
Yes — any MCP-compatible host works (Claude Code, Cursor, Codex, ZED, ChatGPT once their MCP support stabilizes). Wire it the same way; just change which client config file you edit.

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
