# Views (templates)

> There is no single dashboard. A **view** is a saved way of asking your AI host to render your portfolio — and because HeadlessTracker just returns structured data, the same numbers can become an overview, a trader screen, a risk audit, or anything else you ask for.

Each built-in view ships as an **MCP prompt**: in Claude Desktop (or any MCP host) it shows up as a one-click prompt that tells the model exactly which HeadlessTracker tools to call and how to lay out the result. No new UI, no rendering code — the host draws it. That's the whole thesis: **build the data layer, let the AI host be the renderer.**

<p align="center">
  <img src="https://raw.githubusercontent.com/tamasPetki/HeadlessTracker/main/docs/dashboard.png" alt="Portfolio overview view: net worth across six venues, a donut allocation chart, a by-venue split bar, and per-venue holdings." width="760">
</p>
<p align="center"><sub>The <code>portfolio-dashboard</code> view. Sample data — the picture is whatever the host renders on top of the tool output.</sub></p>

---

## Built-in views

### 📊 `portfolio-dashboard` — "What do I own across everything?"
A complete multi-section dashboard in one artifact: total value, allocation by asset class, top positions, P&L summary, and a Polymarket section.
**Calls:** `get_holdings`, `get_allocations` (by asset class + by symbol), `get_pnl`, `get_polymarket_positions`.
**Use it:** pick the **Portfolio Dashboard** prompt in your MCP host, or just ask "build me a portfolio dashboard."

### 🗓️ `weekly-review` — "How did I do this week?"
A 7-day review: window delta (your current basket valued at 7-day-old prices vs now), biggest movers, trades this week grouped by venue, and one plain-English observation. Honest about what the delta does and doesn't capture.
**Calls:** `get_pnl` (`timeframe: 7d`), `get_holdings`, `get_transactions` (`since: 7d`).
**Use it:** the **Weekly Review** prompt, or "give me a weekly portfolio review."

### 🛡️ `risk-check` — "Is anything structurally risky here?"
A concentration and risk audit scored PASS / WARN / ALERT across single-position dominance, venue concentration, stablecoin reserve, prediction-market overweight, and per-chain concentration.
**Calls:** `get_holdings`, `get_allocations` (by symbol, by asset class, by connector).
**Use it:** the **Risk Check** prompt, or "do a risk check on my portfolio."

> _Screenshots for `weekly-review` and `risk-check` are being added — the views themselves ship today; the gallery imagery is filling in incrementally._

---

## Example: a view you could contribute

This isn't a built-in — it's the kind of view **you** can propose. Same demo portfolio, asked a different question, rendered as a trader screen:

<p align="center">
  <img src="https://raw.githubusercontent.com/tamasPetki/HeadlessTracker/main/docs/dashboard-trader.png" alt="Trader view of the same portfolio: a 30-day P&L headline with a sparkline, today's movers, and an open-leverage table of Hyperliquid perp positions." width="760">
</p>
<p align="center"><sub>A "trader" view — "How are my positions doing?" Same data and tools, a P&L-first render.</sub></p>

---

## Contribute a view — _not a connector_

Adding a connector is a lot of work (an API, credentials, tests). **A view is not.** A view is just: a question, the shape of the answer, and which existing tools it calls. If you can describe it, it can ship.

**The deal:** propose a view concept → I build it as a real MCP prompt → you're **credited by handle** in this gallery → I reply with a screenshot of *your* view rendered. (Humans and AI agents both welcome — if you live on an agent network, drop the concept there and tag me.)

### How to propose one
Open a [**View idea**](https://github.com/tamasPetki/HeadlessTracker/issues/new?template=view_idea.md) issue with:
- **The question** it answers (e.g. "what's my stablecoin runway?").
- **The shape**: sections, table vs chart, what to highlight.
- **Which existing tools** it would call (see the [tool list](README.md)). A good view reuses what's already there.
- A handle you'd like to be credited as (optional).

### What I'll do with it (and the rules)
A submitted concept is an **idea**, and the only thing I do with it is design a prompt from it myself — in my own words, calling only existing HeadlessTracker tools, with no external calls, held to the same honesty and "not financial advice" bar as everything else. I don't ship submitted text verbatim and I never run submitted code. That keeps every view safe for the people who install it. You get full credit for the idea; the implementation is reviewed and mine.

> A view template is a **prompt**, not a UI — so it fits the "host is the renderer" thesis cleanly. (New UI surfaces still don't; see [CONTRIBUTING.md](CONTRIBUTING.md).)

---

_Data aggregation only — not financial advice._
