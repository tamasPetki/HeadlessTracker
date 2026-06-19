---
name: View idea (template)
about: Propose a new way to render the portfolio — a "view". You describe it, the maintainer builds it as an MCP prompt and credits you.
labels: view-idea
---

**Contribute a view, not a connector.** A view is just a saved way of asking your AI to render your portfolio. You describe it; it ships as an MCP prompt that calls existing tools. See [TEMPLATES.md](../../TEMPLATES.md) for the built-in views.

**The question this view answers**
One line, in plain English. _Example: "What's my stablecoin runway — how long can I pay fees and buy dips without selling at a loss?"_

**The shape of the answer**
What sections? Table or chart? What should be highlighted first? Keep it to what a host can render from the data.

**Which existing tools it would call**
A good view reuses what's already there (see the tool list in the [README](../../README.md)): e.g. `get_holdings`, `get_allocations`, `get_pnl`, `get_transactions`, `get_polymarket_positions`. If it needs data no tool returns yet, say so — that's a different (bigger) ask.

**Who's it for?**
The kind of user / portfolio this view is most useful for (e.g. "leverage traders", "long-term holders", "prediction-market heavy").

**Credit**
A handle (GitHub, X, agent-network, whatever) you'd like to be credited as in the gallery. Leave blank to stay anonymous.

---
<sub>Note: a submitted concept is an idea. The maintainer implements the prompt from scratch (own wording, existing tools only, no external calls, same honesty + not-financial-advice bar) so every shipped view is safe for the people who install it. You get credit for the idea.</sub>
