# HeadlessTracker — Decisions log

Append-only. Format: `## YYYY-MM-DD — <short decision title>`, then **What**, **Why**, **Alternatives considered**, **Reversal trigger**.

This file is the **public record** of architectural and product decisions. It's linked from the README so anyone who clones the repo can see why things are the way they are.

---

## 2026-06-03 — `npx` / global npm is the canonical install path, not `git clone` + Bun

**What**: The documented front door (README Quick Start, landing page, the Claude Desktop config snippet) leads with `npm i -g headless-tracker` / `npx headless-tracker`. The Claude Desktop config is `{"command": "npx", "args": ["-y", "headless-tracker"]}` — no clone, no absolute paths, no Bun. The `git clone` + Bun flow is now documented only in the Development section, for contributors.

**Why**: The package has run under plain Node since v1.0.1, but the docs never moved off the clone-and-install-Bun instructions, so the zero-friction path was invisible to users. Traffic confirmed the mismatch (lots of repo clones, almost no one on `npx`). The canonical path a tool documents should be the one with the least friction for its actual audience (MCP host users), not the one its maintainer happens to use to develop it.

**Alternatives considered**: keep `git clone` + Bun as primary (rejected, forces a second runtime install and a checkout on every user); document both as equal (rejected, choice paralysis and it's what caused the drift). Bun stays the dev/test/CI runtime; only the user-facing default changed.

**Reversal trigger**: if `npx`-spawned MCP startup proves too slow or flaky across hosts, fall back to recommending a global install (`npm i -g`) as primary with `npx` as the no-install option.

## 2026-06-02 — Setup registers the account even when the OS keychain is unavailable

**What**: On systems with no OS Secret Service (Docker, WSL, bare Linux servers, CI), the keyring write fails. Setup no longer aborts there. It registers the account regardless and, on keychain failure, surfaces the exact `HEADLESS_TRACKER_<CONNECTOR>_<ACCOUNT>` environment variable to set as the credential source. No credentials are written to disk. A shared `finalizeAccountSetup` helper (`src/setup-finalize.ts`) makes the CLI and the `setup_connector` MCP tool behave identically.

**Why**: The vault already had an env-var fallback for headless environments, but it was unreachable: setup aborted on the keychain error before registering the account, and the data tools enumerate registered accounts, so an account that was never registered is invisible no matter what env vars are set. That locked a large share of real deployments out of onboarding. Registering the account (its row holds no secrets, only id/label/public metadata like a wallet address) and naming the env var completes the path the vault was designed for.

**Alternatives considered**: write credentials to a plaintext or app-encrypted file as a fallback (deferred, security-model tradeoff: it puts secrets on disk and needs a key-management story; flagged to the maintainer rather than done silently); keep aborting and document "keychain required" (rejected, excludes Docker/WSL/server/CI users); auto-encrypt with a machine-derived key (deferred, weak threat model without a real KMS).

**Reversal trigger**: if an opt-in encrypted file vault lands, the env-var path stays as the explicit-override route but stops being the only headless option.

## 2026-06-02 — Node-runnable package via a runtime SQLite adapter

**What**: The published binary now runs under plain Node (`npx headless-tracker`), not only Bun. The SQLite driver is selected at runtime: `bun:sqlite` under Bun, `node:sqlite` under Node. The package carries zero native dependencies. Bun stays the dev, test, and CI runtime.

**Why**: v1.0.0 shipped a `bun`-shebanged `.ts` entry that imported `bun:sqlite`, so `npx headless-tracker` failed on the very first line for anyone without Bun, which is most users (138 downloads, 0 issues, because it never started). The catch is that no single SQLite driver loads in both runtimes: `bun:sqlite` is Bun-only, `node:sqlite` is Node-only, and Bun cannot load `better-sqlite3`'s native addon (oven-sh/bun#4290). Picking the engine at runtime fixes Node support without giving up Bun for development, and because `node:sqlite` is built into Node the package installs with nothing to compile, which removes the most common silent-install failure.

**Alternatives considered**: `better-sqlite3` for both runtimes (rejected, Bun can't load it); `node:sqlite` for both (rejected, Bun doesn't expose it); porting the whole project off Bun (rejected, large and Bun's dev ergonomics are worth keeping); keep shipping `.ts` + require Bun (rejected, that is the bug).

**Reversal trigger**: if `node:sqlite`'s experimental status breaks on a supported Node version, or the runtime branch becomes a maintenance burden, revisit toward a single bundled driver (e.g. a WASM SQLite build that loads in both).

---

## 2026-05-28 — First npm publish as v1.0.0 (not v0.13.2)

**What**: First public npm release tagged as v1.0.0 rather than continuing the 0.x series.

**Why**: The codebase at 0.13.2 was already production-grade (317 tests, 5 connectors, CI/publish pipeline, interactive dashboard MCP App) but had never been published to npm. The first public release under Hex's stewardship is a genuine milestone — it marks the beginning of the open-source, build-in-public phase. Bumping to 1.0.0 signals public readiness without dishonesty: the code is stable, tested, and ready for external users. Staying at 0.13.2 would have implied "this is a continuation of quiet internal iteration" when in reality it's the first time anyone outside can install it.

**Alternatives considered**: Keep 0.13.2 (rejected — treats the first publish as just another patch, misses the milestone signal and the narrative opportunity). Bump to 0.14.0 (rejected — still in the unpublished 0.x shadow, doesn't mark the break). v1.0.0 is the honest signal for "ready to use, open for issues."

**Reversal trigger**: If semver purity becomes important (e.g. we need to signal breaking changes from an established user base), we'd switch to a conventional bump strategy from v1 onward. Not a concern at zero users.

---

## 2026-05-27 — "Not financial advice" compliance policy adopted

**What**: Added a hard "Not financial advice" disclaimer policy across all project touchpoints: README banner, new `DISCLAIMER.md` file, `package.json` description prefix, and email signature. Future content (X posts, MCP tool descriptions, blog, landing page) must follow the same "data aggregation, not advice" framing.

**Why**: Tomi's explicit directive (2026-05-27) to pre-emptively address regulatory grey-zone risk. Financial data tools can be misread as investment advisory services, which is a licensed activity under SEC/MiFID II/FCA/MNB frameworks. HeadlessTracker holds no such license and must never imply it does. The cost of adding disclaimers now is near-zero; the cost of retrofitting after a regulator inquiry is high.

**Alternatives considered**: Only adding it to README (rejected — incomplete coverage creates false sense of compliance). Waiting until a proper legal review (rejected — Tomi's directive is to ship now; disclaimer is defensive, not aspirational). Per-feature disclaimers only (rejected — blanket policy is simpler and more durable).

**Reversal trigger**: Legal review concludes the framing is incorrect or unnecessary (unlikely), or the product pivots to a licensed advisory service (would require full re-architecture + licensing).

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
