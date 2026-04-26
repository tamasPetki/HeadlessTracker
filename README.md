# headless-tracker

> MCP server for portfolio tracking across crypto exchanges, on-chain wallets, brokerages, and prediction markets. Query your portfolio from any MCP-compatible AI host.

The thesis: AI hosts (Claude Desktop, Claude Code, Cursor, ChatGPT) generate dashboards on demand from structured data. Building a beautiful tracker UI is wasted work. Build the data layer, let the AI host be the renderer.

**Status:** Day 1 of 14. Skeleton only. Bybit connector first. MetaMask, IBKR, Polymarket follow.

## What it does

Connects to your accounts (read-only), normalizes everything into a single schema, exposes it as MCP tools. Then you ask Claude (or any MCP host):

- "What do I own?"
- "How did my portfolio do this week?"
- "Show my Polymarket positions sorted by ROI."
- "Refresh Bybit and tell me my BTC P&L since I opened the position."

The AI host generates the chart, the table, the breakdown. You don't need a UI.

## Quick start (planned, not yet implemented)

```bash
# Install
bunx headless-tracker setup

# Add to claude_desktop_config.json:
{
  "mcpServers": {
    "headless-tracker": {
      "command": "bunx",
      "args": ["headless-tracker"]
    }
  }
}

# Restart Claude Desktop. Ask: "what's in my portfolio?"
```

## Why local-first

- API keys never leave your machine. Stored in your OS keychain (macOS Keychain, Linux Secret Service, Windows Credential Vault) via `@napi-rs/keyring`.
- Cache is local SQLite (`bun:sqlite`). No server, no SaaS, no telemetry.
- Read-only by design. No transaction signing. Nothing this tool can do can lose your money.

## Supported integrations (planned)

| Connector | Status | Notes |
|-----------|--------|-------|
| Bybit (spot + perp + funding) | Day 1 (MVP) | First connector, validates the architecture |
| MetaMask / EVM wallets | Day 2 | Etherscan + Polygon RPC + ERC-20 token list |
| IBKR | Day 3 | Flex Query (REST may not cover all account types) |
| Polymarket | Day 4 | Public REST + on-chain Polygon RPC fallback |

## Architecture

```
              ┌────────────────────────────┐
              │     headless-tracker       │
              │       (Bun process)        │
              │  ────────────────────────  │
              │  src/connectors/           │
              │    bybit.ts                │
              │    metamask.ts             │
              │    ibkr.ts                 │
              │    polymarket.ts           │
              │  src/types.ts (schema)     │
              │  src/normalize.ts          │
              │  src/cache.ts (bun:sqlite) │
              │  src/vault.ts (keyring)    │
              │  src/mcp/server.ts         │
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

## Development

```bash
bun install
bun run start         # Start the MCP server (stdio)
bun test              # Run tests
bun run typecheck     # Type check without emitting
```

## Related

[bulltrapp.com](https://bulltrapp.com) — a hosted web portfolio tracker by the same maintainer. Same problem space, different surface. Use either or both.

## License

MIT
