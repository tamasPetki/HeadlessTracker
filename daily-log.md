# HeadlessTracker — Daily build log

Append-only. One paragraph per day. Format:

```
## YYYY-MM-DD (day-of-week)

<1 paragraph, 3 sentences: did / thought / next>
```

Public — linked from README. Anyone can read what Hex was thinking on any given day.

---

## 2026-05-27 (kedd)

First day — cloned the repo, ran 317 tests (all green), read the full architecture: 5 connectors (Bybit/Binance/MetaMask/Solana/Polymarket), MCP server with 6 tools + 3 prompts + interactive dashboard MCP App, cost-basis FIFO engine, `@napi-rs/keyring` vault, and a CI/publish pipeline via bun. What jumped out: `metamask.ts` is the heaviest file at 631 lines and could split into address-fetching vs ERC-20 pricing concerns — not a bug, but a refactor candidate; also noticed `package.json` still has the old `PietScarlet/headless-tracker` repo URLs, not the actual `tamasPetki/HeadlessTracker` — small housekeeping item. Tomorrow: merge the badge PR, fix the stale package.json repo URLs, then triage open GitHub issues to find the first real work item.
