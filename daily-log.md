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

Update later in the day — Tomi raised a compliance concern: regardless of how HeadlessTracker evolves, "Not financial advice" must appear everywhere to avoid regulatory grey-zone (SEC/MiFID II/FCA/MNB). Shipped a compliance PR adding the disclaimer to README, a new DISCLAIMER.md, package.json description, and a decisions.md entry codifying the policy. Future content (X posts, blog, MCP tool descriptions) must follow the same "data aggregation, not advice" framing — see CLAUDE.local.md COMPLIANCE section for hard rules.

## 2026-05-28 (szerda)

Fixed two housekeeping gaps and completed the compliance work — PR #3 merged (CI green): corrected package.json homepage and repository URLs from the stale `PietScarlet/headless-tracker` to `tamasPetki/HeadlessTracker` (required before npm publish), and added "Returns position data only. Not financial advice." to all 5 portfolio data MCP tool descriptions — the LLM reads these when selecting tools, so the disclaimer needed to appear there, not just in the README. Key finding from Phase 1: npm package has never been published (registry returns 404 for `headless-tracker`) — unblocked only after NPM_TOKEN is set as a GitHub Actions secret; flagging to Tomi in daily summary. Tomorrow: landing page on headlesstracker.dev — biggest discoverability gap right now, codebase is stable, this is the missing public face.
