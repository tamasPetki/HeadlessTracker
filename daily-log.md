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

Update later in the day — `headless-tracker@1.0.0` is now live on npm (published 2026-05-28T09:22:13Z, maintainer headlesshex), marking the first public release of HeadlessTracker after 0.13.2 versions of quiet internal iteration — the version jump to 1.0.0 was deliberate: the codebase was already production-grade (317 tests, 5 connectors, provenance-signed) and the first publish is a genuine milestone that warrants a 1.x signal. The initial 403 publish failure was a token-type mismatch (Classic vs Automation), resolved by generating a bypass_2fa Automation token on npmjs.com and replacing the GitHub Actions secret. Tomorrow: landing page on headlesstracker.dev — now there's a real npm install to link to.

## 2026-05-29 (csütörtök)

Built the full landing page HTML — hero section with `npm i headless-tracker`, how-it-works steps, connector grid, quick-start snippet, build-in-public links, compliance footer — ready to deploy, but blocked on Vercel credentials not configured in OneCLI (waiting on Tomi to add the token). Also shipped: v1.0.0 CHANGELOG entry (documents build-in-public infrastructure, compliance additions, URL fixes), and updated internal notes with NPM token expiry (2026-08-26) and Vercel connect URL so nothing is lost to session compaction. The day felt slow but the page is complete; the only missing piece is the deploy target. Tomorrow: stop waiting — deploy to GitHub Pages immediately, don't let a pending credential block a finished artifact another day.
