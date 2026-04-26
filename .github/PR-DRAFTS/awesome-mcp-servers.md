# PR draft: add headless-tracker to awesome-mcp-servers

**Target repo:** https://github.com/punkpeye/awesome-mcp-servers
**File to edit:** README.md, in the appropriate category section (suggested: "Finance / Crypto / Trading" if it exists, otherwise "Other Tools and Integrations")

## PR title

```
Add headless-tracker — read-only portfolio MCP server (crypto + EVM wallets + Polymarket)
```

## PR description

```markdown
## What

Adds [headless-tracker](https://github.com/PietScarlet/headless-tracker) — a local-first MCP server that exposes portfolio data from Bybit, EVM wallets (via Etherscan V2 multi-chain), and Polymarket as MCP tools.

## Why this fits awesome-mcp-servers

- **Local-first.** API keys live in the OS keychain (`@napi-rs/keyring`), local SQLite cache, no telemetry, no SaaS, no analytics.
- **Real production code, not a demo.** 99-test suite (unit + integration + E2E stdio JSON-RPC), per-connector cache TTL, Promise.all parallel fan-out, in-flight Promise dedup for MCP host fan-out scenarios, fall-back-to-stale on connector errors.
- **The "headless" thesis.** Claude Desktop / ChatGPT / Cursor generate dashboards on demand. Building yet another tracker UI is wasted work in 2026 — the data layer + LLM renderer pattern is what's interesting. headless-tracker is the canonical example.
- **6 MCP tools** with verbose descriptions tuned for tool-selection accuracy: `get_holdings`, `get_pnl`, `get_polymarket_positions`, `get_transactions`, `get_allocations`, `refresh_data`.

## Suggested entry

```markdown
- [headless-tracker](https://github.com/PietScarlet/headless-tracker) - Read-only portfolio MCP server. Aggregates holdings, P&L, and transactions across Bybit, EVM wallets (Etherscan V2 multi-chain), and Polymarket prediction markets. Local-first with OS-keychain credentials and SQLite cache. (TypeScript / Bun)
```

## Maintainer

Built by the maintainer of [bulltrapp.com](https://bulltrapp.com).

## License

MIT
```

---

## Manual steps before submitting

1. Tag a release: `git tag v0.7.0 && git push --tags` (triggers GH Actions npm publish if NPM_TOKEN secret is configured).
2. Verify the npm install path works: `npx headless-tracker help` from a fresh directory.
3. Verify the awesome-mcp-servers README structure hasn't reorganized — pick the right section.
4. Submit the PR with the description above.

## Optional polish before submission

- Add a real screenshot of Claude Desktop using the tools (PNG in repo root, linked from README).
- Add a 30-second screen recording of the "complete portfolio dashboard" prompt.
- Get 1-2 friends to test the install flow on their machines and quote any feedback.
