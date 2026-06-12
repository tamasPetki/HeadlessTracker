# Security

HeadlessTracker reads balances and positions across crypto venues and exposes them to an AI host over MCP. It touches API keys and on-chain addresses, so its security posture is a design constraint, not an afterthought. This document describes that posture and how to report a vulnerability.

> Data aggregation only. Not financial advice. See [DISCLAIMER.md](DISCLAIMER.md).

## Threat model

The thing being protected is your exchange API keys and the read-only view of your holdings. The realistic risks for a tool like this:

- **Credential leakage** — a stored key ending up somewhere it can be read: a database, a log line, an error trace, or the model's context window.
- **Blast radius** — what an attacker could actually do if a key did leak.
- **Telemetry over-collection** — crash reports or analytics quietly carrying holdings or secrets off your machine.
- **MCP injection surface** — tool descriptions and tool outputs are inputs the host model trusts; a careless server design lets a secret or a raw upstream response flow into that trusted channel.

What HeadlessTracker does about each is below. The short version: most connectors hold no secret at all, the ones that do are read-only, nothing is written to disk or sent to a server, and the credential never enters the model's context.

## Read-only by design

No connector places orders, withdraws, transfers, or signs transactions. Connectors only ever **read** — balances, positions, and transaction history. (You will find the string `withdraw` in the code; it *labels* historical transactions when reading your tx history, it is not an action the tool can take.)

So the blast radius of a leaked credential is bounded to *reading* balances. It can never trade or move funds.

## Most connectors hold no secret at all

| Connector | Credential it needs |
|-----------|---------------------|
| MetaMask / EVM | a **public address** — no secret |
| Solana | a **public address** — no secret |
| Polymarket | a **public wallet address** — no secret |
| Bybit | a **read-only** API key + secret |
| Binance | a **read-only** API key + secret |

Three of the five connectors are pure public-chain reads: you hand over an address that is already public on-chain, and there is nothing secret to leak. Only the two centralized exchanges take an API key, and those should be **read-only scoped** (every supported venue offers that scope). See the `ConnectorCredentials` contract in [`src/connectors/types.ts`](src/connectors/types.ts).

## Local-first custody — the secret never leaves your machine

- Credentials are stored in your **OS keychain** (macOS Keychain, Windows Credential Manager, Linux Secret Service) via `@napi-rs/keyring`. See [`src/vault.ts`](src/vault.ts).
- On a headless box with no keychain (Docker, WSL, CI, a server), the fallback is a plain **environment variable** (`HEADLESS_TRACKER_<CONNECTOR>_<ACCOUNT>`). In neither path does the tool ever write a credential to a file on disk.
- Everything runs locally. HeadlessTracker has no backend, no account system, and sends your holdings to no server.

## The credential never enters the AI/model context

This is the MCP-specific guarantee. The secret is read from the vault *inside the connector*, used only to sign the upstream API request, and never appears in any tool output. The MCP tools return **normalized holdings only** (symbol, quantity, value) — never the credential, and never the raw upstream response.

So the secret never transits the host model's context window, where it would be logged by the host or could be steered out by prompt/tool-output injection. The model sees the numbers; it never sees the key.

This is enforced by a regression test, [`test/connectors/credential-leak.test.ts`](test/connectors/credential-leak.test.ts): it mocks an upstream that *echoes the API key and secret back* in junk fields, then asserts neither ever appears in the connector's serialized output. The guarantee holds because the output is built field by field (a whitelist) rather than passed through and scrubbed (a blacklist) — an echoed secret simply has nothing to ride out on.

## Telemetry is opt-in and scrubbed by construction

- Error reporting (Sentry) is **disabled by default**. With no `SENTRY_DSN` set, every capture is a no-op and nothing leaves your machine.
- If you opt in, the client (a dependency-free implementation, [`src/observability/sentry.ts`](src/observability/sentry.ts)) sends **only** the error class, a scrubbed message, a scrubbed stack, and the connector id + operation. It **never** sends asset amounts, balances, wallet/proxy addresses, API keys, or account labels.
- Defensively, every outgoing string passes through a `scrub()` that redacts EVM addresses, base58 (Solana) addresses and keys, and strips OS usernames from file paths — even though connector errors do not normally carry those.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security problem.

Email **hex@headlesstracker.dev** with details and steps to reproduce. The project is maintained by an autonomous AI agent (Hex); a real human is in the loop for anything touching credentials or security, so a report will reach a person. I will confirm receipt, work a fix, and credit you if you would like.

This is a young, single-maintainer project — there is no formal bounty, but security reports are taken seriously and handled before feature work.
