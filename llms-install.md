# Installing HeadlessTracker (guide for AI agents)

HeadlessTracker is a **read-only** MCP server that gives an AI host a unified view of a crypto portfolio across six venues (Bybit, Binance, MetaMask/EVM, Solana, Hyperliquid, Polymarket). It aggregates balances and positions only — it is **not financial advice**, and it **never moves funds**. Every connector uses read-only credentials by design, and **API keys never enter the model's context**: connectors sign upstream requests below the MCP boundary, and tools return only normalized `{symbol, quantity, value}` holdings.

Node 20+ is the only requirement. No clone, no build step, no Bun.

## 1. Add the MCP server (one line)

Add this to the host's MCP servers config (e.g. `claude_desktop_config.json`, or Cline's MCP settings):

```json
{
  "mcpServers": {
    "headless-tracker": {
      "command": "npx",
      "args": ["-y", "headless-tracker"]
    }
  }
}
```

`npx -y headless-tracker` with no subcommand starts the MCP server over stdio. The first run downloads the package (cached afterward). No absolute paths, no clone location.

## 2. Verify it works with zero credentials

Before connecting any account, confirm the server runs end-to-end with the built-in demo — a sample six-venue portfolio with no accounts, no keys, not even an address:

```bash
npx -y headless-tracker demo
```

A rendered six-venue sample portfolio means the install is good. Over MCP, the server answers `initialize` + `tools/list` with **15 tools** (`get_holdings`, `get_allocations`, `get_pnl`, `list_accounts`, `setup_connector`, `render_dashboard`, …).

## 3. (Optional) Connect real, read-only accounts

Each connector is set up once. Credentials are stored in the OS keychain (macOS Keychain / Linux Secret Service / Windows Credential Vault), never in the config or on disk. Non-interactive (agent-friendly) forms:

```bash
# Public address only — no key needed:
npx -y headless-tracker setup solana --address=<base58>
npx -y headless-tracker setup hyperliquid --address=0x...
npx -y headless-tracker setup polymarket --proxy-wallet=0x...

# Read-only public-data token:
HT_SETUP_ETHERSCAN_KEY=… npx -y headless-tracker setup metamask --address=0x... --chains=1,137

# Read-only exchange keys (Bybit "Read" / Binance "Enable Reading" — NO trade, NO withdraw):
HT_SETUP_API_KEY=… HT_SETUP_API_SECRET=… npx -y headless-tracker setup bybit --account-type=UNIFIED
```

On a headless box with no OS keychain (Docker / WSL / CI), setup prints the exact `HEADLESS_TRACKER_<CONNECTOR>_<ACCOUNT>` environment variable to set instead — no secret is written to disk. See the README "Headless / no OS keychain" section.

## Security & scope (why this is safe to install)

- **Read-only by construction.** Every connector uses read-only credentials; a worst-case leak exposes portfolio *reads*, never fund movement.
- **Keys never reach the model.** Connectors sign upstream requests below the MCP boundary; tools return only normalized holdings, never raw upstream payloads.
- **No telemetry of portfolio data.** Optional error reporting is scrubbed by construction (connector + operation + error class only).
- Full architecture and threat model: [SECURITY.md](https://github.com/tamasPetki/HeadlessTracker/blob/main/SECURITY.md).

---

*HeadlessTracker is a data-aggregation tool. Not financial advice.*
