# Contributing to headless-tracker

Thanks for your interest. This project follows a simple principle: **build the data layer, let the AI host be the renderer**. Contributions that add connectors, improve data quality, or fix bugs fit naturally. New UI surfaces don't — the MCP host handles rendering.

## Quick orientation

| Directory | What's there |
|-----------|-------------|
| `src/connectors/` | One file per exchange / wallet / market. Each implements `fetchHoldings`, `fetchPnl`, `fetchTransactions`. |
| `src/mcp/` | MCP server, tools, prompts, and MCP Apps (dashboard, settings). |
| `src/cost_basis.ts` | FIFO cost basis engine. |
| `src/orchestrator.ts` | Aggregates across connectors, applies pricing, produces the unified schema. |
| `test/` | 317 tests. Bun test runner, `--timeout=15000`. |
| `ROADMAP.md` | What's done, what's next, what's intentionally out of scope. Read before opening a feature request. |

## Setup

Requires [Bun 1.3+](https://bun.sh).

```bash
git clone https://github.com/tamasPetki/HeadlessTracker.git
cd HeadlessTracker
bun install
```

Run tests:

```bash
bun test
```

Type-check:

```bash
bun --bun tsc --noEmit
```

Build MCP Apps (dashboard + settings UI):

```bash
bun run build:apps
```

## Adding a connector

1. Create `src/connectors/<name>.ts`. Implement the `Connector` interface: `fetchHoldings`, `fetchPnl`, `fetchTransactions`. Return `null` for operations the exchange doesn't support — don't throw.
2. Add credentials schema to `src/vault.ts`.
3. Wire `setup <name>` into `bin/headless-tracker.ts`.
4. Add a Settings UI form in `src/mcp/apps/settings/`.
5. Add tests under `test/connectors/<name>.test.ts`. Aim for schema validation + at least one happy-path integration test.
6. Update `ROADMAP.md` — add the connector to the Done section with a one-line note.

**Read-only credentials only.** Every connector must request the minimum scope the exchange allows (e.g. Bybit "Read", Binance "Enable Reading"). Withdraw / trade permissions are never needed and must not be requested.

## Submitting a PR

- Keep PRs focused: one connector, one bug, one feature.
- Run `bun test && bun --bun tsc --noEmit` before pushing. CI runs the same check.
- If you're adding a connector: mention in the PR description which exchange, what credentials are needed, and whether you've tested against a live account.
- `CHANGELOG.md`: add a line under an `## Unreleased` section at the top if one exists, or the maintainer will add it on merge.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). The most useful bug reports include:
- What connector (Bybit, Binance, MetaMask, Solana, Polymarket)
- The exact error message or unexpected output
- Whether the issue is data-wrong or crash/exception

Don't include API keys or wallet addresses in issues.

## Requesting features

Check `ROADMAP.md` first — if it's listed as "out of scope", open a discussion rather than an issue so we can understand the use case before committing to it.

## License

MIT. By contributing you agree your changes are released under the same license.
