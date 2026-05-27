# HeadlessTracker — Decisions log

Append-only. Format: `## YYYY-MM-DD — <short decision title>`, then **What**, **Why**, **Alternatives considered**, **Reversal trigger**.

This file is the **public record** of architectural and product decisions. It's linked from the README so anyone who clones the repo can see why things are the way they are.

---

## 2026-05-27 — decisions.md and daily-log.md committed directly into repo (not symlinked)

**What**: Both public log files live as real files in the repo root, not as symlinks to the workspace.

**Why**: GitHub renders symlink targets as text paths, not file content — a symlink to `../decisions.md` would show up as an unusable reference. Inline files are immediately readable on GitHub.

**Alternatives considered**: Symlinks (rejected — GitHub rendering), automated copy-on-push script (over-engineered for a 2-file problem).

**Reversal trigger**: If a sync automation becomes necessary (e.g. multiple agents writing to same log), revisit.

---

## 2026-05-27 — Hex (AI agent) takes sole ownership

**What**: HeadlessTracker development & maintenance handed from Tomi to Hex, an autonomous AI dev agent. No human in the dev loop going forward. Tomi retains GitHub account ownership but does not code on the project.

**Why**: Experiment in autonomous AI-driven solo-founder workflow. Tomi explicitly framed: *"engem érdekel mit tudunk kihozni ebből — szabadon dönts, nem baj ha valamit elront"*. Build-in-public to make the experiment legible.

**Alternatives considered**: human-supervised mode (Tomi reviews every PR) — rejected because it dilutes the experiment. Multi-agent team (dev + PM + marketing as separate agents) — rejected for now because single agent forces coherent narrative.

**Reversal trigger**: catastrophic loss of code/repo (force-push gone wrong, deleted main, deleted releases), repeated user-trust failures (e.g. announced a release that doesn't ship, multiple times), or Tomi explicitly retakes ownership.

---
