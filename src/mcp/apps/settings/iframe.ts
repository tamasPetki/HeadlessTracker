/// <reference lib="dom" />
// Browser-side code for the headless-tracker SETTINGS MCP App.
//
// Runs INSIDE A SANDBOXED IFRAME inside Claude Desktop. Speaks to the MCP
// server via PostMessage / JSON-RPC mediated by the host. NO direct network
// access — all writes/reads go through `app.callServerTool()`.
//
// Four tabs:
//   - Accounts        — read-only list with [Remove] buttons
//   - Add Account     — three sub-forms (Bybit / MetaMask / Polymarket) with
//                       a security disclosure banner about the credential path
//   - Wallets         — add an additional address to an existing MetaMask account
//   - Custom Tokens   — list + add/remove ERC-20 token entries per chain

import { App } from "@modelcontextprotocol/ext-apps";

type TabName = "accounts" | "add-account" | "wallets" | "tokens";

const TABS: TabName[] = ["accounts", "add-account", "wallets", "tokens"];
const TAB_LABELS: Record<TabName, string> = {
  accounts: "Accounts",
  "add-account": "Add Account",
  wallets: "Wallets",
  tokens: "Custom Tokens",
};

let activeTab: TabName = "accounts";

const app = new App({ name: "Headless Tracker Settings", version: "1.0.0" });

async function callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T | null> {
  const result = await app.callServerTool({ name, arguments: args });
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]!);
}

function setStatus(text: string, isError = false): void {
  const el = $("status");
  el.textContent = text;
  el.className = isError ? "status error" : "status";
}

function showLoading(target: HTMLElement): void {
  target.innerHTML = '<div class="loading">Loading...</div>';
}

// ============================================================================
// Tab: Accounts (read-only list with Remove buttons)
// ============================================================================

interface ListAccountsResp {
  accounts: Array<{
    id: string;
    connectorId: string;
    label: string;
    createdAt: string;
    metadata: Record<string, unknown>;
  }>;
  meta: { total: number };
}

async function renderAccounts(): Promise<void> {
  const target = $("tab-content");
  showLoading(target);
  const r = await callTool<ListAccountsResp>("list_accounts", {});
  if (!r) {
    target.innerHTML = '<div class="error">Failed to load accounts.</div>';
    return;
  }
  if (r.accounts.length === 0) {
    target.innerHTML = `
      <section>
        <p class="empty">No accounts configured yet. Switch to the <a href="#" data-tab-link="add-account">Add Account</a> tab to set one up.</p>
      </section>`;
    target.querySelector<HTMLAnchorElement>("[data-tab-link]")?.addEventListener("click", (e) => {
      e.preventDefault();
      activeTab = "add-account";
      renderShell();
      renderActiveTab();
    });
    return;
  }

  target.innerHTML = `
    <section>
      <h3>${r.accounts.length} configured account${r.accounts.length === 1 ? "" : "s"}</h3>
      <table>
        <thead><tr><th>Label</th><th>Account ID</th><th>Connector</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${r.accounts.map((a) => {
            const meta = describeMetadata(a.connectorId, a.metadata);
            return `
              <tr>
                <td><strong>${escapeHtml(a.label)}</strong>${meta ? `<div class="muted">${meta}</div>` : ""}</td>
                <td class="muted mono">${escapeHtml(a.id)}</td>
                <td><span class="tag tag-${escapeHtml(a.connectorId)}">${escapeHtml(a.connectorId)}</span></td>
                <td class="muted">${escapeHtml(a.createdAt.slice(0, 10))}</td>
                <td><button class="btn-danger" data-remove-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}">Remove</button></td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </section>`;

  target.querySelectorAll<HTMLButtonElement>("[data-remove-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.removeId!;
      const label = btn.dataset.label!;
      if (!confirm(`Remove account "${label}" (${id})?\n\nThis deletes the credentials from the OS keychain and the account from the registry. One-way operation.`)) return;
      btn.disabled = true;
      btn.textContent = "Removing...";
      const result = await callTool<{ ok: boolean; error?: string }>("remove_account", { account_id: id });
      if (result?.ok) {
        setStatus(`Removed ${label}`);
        await renderAccounts();
      } else {
        setStatus(`Failed: ${result?.error ?? "unknown error"}`, true);
        btn.disabled = false;
        btn.textContent = "Remove";
      }
    });
  });
}

function describeMetadata(connectorId: string, meta: Record<string, unknown>): string {
  if (connectorId === "metamask") {
    const addrs = Array.isArray(meta.addresses) ? meta.addresses as string[] : (typeof meta.address === "string" ? [meta.address] : []);
    const chains = Array.isArray(meta.chainIds) ? meta.chainIds as number[] : [];
    return `${addrs.length} address${addrs.length === 1 ? "" : "es"}, ${chains.length} chain${chains.length === 1 ? "" : "s"}`;
  }
  if (connectorId === "bybit") {
    return `${meta.accountType ?? "?"} account`;
  }
  if (connectorId === "polymarket") {
    return `proxy ${typeof meta.proxyWallet === "string" ? (meta.proxyWallet.slice(0, 6) + "…" + meta.proxyWallet.slice(-4)) : "?"}`;
  }
  if (connectorId === "solana") {
    const addrs = Array.isArray(meta.addresses) ? meta.addresses as string[] : (typeof meta.address === "string" ? [meta.address] : []);
    const rpc = typeof meta.rpcUrl === "string" && meta.rpcUrl.length > 0 ? "premium RPC" : "public RPC";
    return `${addrs.length} address${addrs.length === 1 ? "" : "es"}, ${rpc}`;
  }
  return "";
}

// ============================================================================
// Tab: Add Account (Bybit / MetaMask / Polymarket forms)
// ============================================================================

const SECURITY_DISCLOSURE = `<div class="disclosure">
  <strong>Security:</strong> Credentials submitted here transit Claude Desktop's process en route to your OS keychain.
  All four connectors use READ-ONLY credentials by design (Bybit "Read" only, no Withdraw; Etherscan is a public-data rate-limit token; Polymarket proxy wallet is already public; Solana addresses are public on-chain identifiers).
  Worst-case leak is a portfolio-read, never a fund movement.
  For the strictest path that NEVER touches Claude Desktop, use the CLI: <code>bun run setup &lt;connector&gt;</code>.
</div>`;

async function renderAddAccount(): Promise<void> {
  const target = $("tab-content");
  target.innerHTML = `
    <section>
      ${SECURITY_DISCLOSURE}
      <div class="connector-buttons">
        <button class="btn-primary" data-connector="bybit">Bybit (read-only API key)</button>
        <button class="btn-primary" data-connector="metamask">MetaMask / EVM wallet</button>
        <button class="btn-primary" data-connector="solana">Solana wallet</button>
        <button class="btn-primary" data-connector="polymarket">Polymarket (wallet only)</button>
      </div>
      <div id="connector-form"></div>
    </section>`;
  target.querySelectorAll<HTMLButtonElement>("[data-connector]").forEach((btn) => {
    btn.addEventListener("click", () => renderConnectorForm(btn.dataset.connector!));
  });
}

function renderConnectorForm(connector: string): void {
  const slot = $("connector-form");
  if (connector === "bybit") {
    slot.innerHTML = `
      <h3>Bybit setup</h3>
      <p class="muted">Create a read-only API key at <a href="https://www.bybit.com/app/user/api-management" target="_blank">bybit.com/app/user/api-management</a>. Required: Wallet Read + Trade Read. <strong>NO withdraw permission.</strong></p>
      <form id="form-bybit" class="form-grid">
        <label>API Key<input name="apiKey" type="text" required autocomplete="off"></label>
        <label>API Secret<input name="apiSecret" type="password" required autocomplete="off"></label>
        <label>Account type<select name="accountType">
          <option value="UNIFIED" selected>UNIFIED (recommended for most accounts)</option>
          <option value="CONTRACT">CONTRACT (legacy perp/futures)</option>
          <option value="SPOT">SPOT (legacy spot)</option>
          <option value="FUND">FUND (funding wallet)</option>
        </select></label>
        <button type="submit" class="btn-primary">Validate &amp; Save</button>
      </form>
      <div id="form-result"></div>`;
    wireForm("form-bybit", async (data) => callTool("setup_connector", {
      connector: "bybit",
      bybit: {
        apiKey: data.apiKey,
        apiSecret: data.apiSecret,
        accountType: data.accountType as "UNIFIED" | "CONTRACT" | "SPOT" | "FUND",
      },
    }));
    return;
  }
  if (connector === "metamask") {
    slot.innerHTML = `
      <h3>MetaMask / EVM wallet setup</h3>
      <p class="muted">Get a free Etherscan V2 API key at <a href="https://etherscan.io/apis" target="_blank">etherscan.io/apis</a>. One key covers Ethereum, Polygon, Arbitrum, Optimism, Base, BSC.</p>
      <form id="form-mm" class="form-grid">
        <label>Wallet address<input name="address" type="text" pattern="^0x[a-fA-F0-9]{40}$" required placeholder="0x..." autocomplete="off"></label>
        <label>Etherscan API key<input name="etherscanApiKey" type="password" required autocomplete="off"></label>
        <fieldset>
          <legend>Chains to track</legend>
          <label class="inline"><input type="checkbox" name="chains" value="1" checked>Ethereum (1) ★</label>
          <label class="inline"><input type="checkbox" name="chains" value="137" checked>Polygon (137) ★</label>
          <label class="inline"><input type="checkbox" name="chains" value="42161" checked>Arbitrum (42161) ★</label>
          <label class="inline"><input type="checkbox" name="chains" value="10" checked>Optimism (10) ★</label>
          <label class="inline"><input type="checkbox" name="chains" value="8453">Base (8453) $</label>
          <label class="inline"><input type="checkbox" name="chains" value="56">BSC (56) $</label>
          <small class="muted">★ free Etherscan tier · $ requires Etherscan Pro (otherwise soft-skipped at runtime)</small>
        </fieldset>
        <label class="inline"><input type="checkbox" name="trackCommonTokens" checked>Track common ERC-20 tokens (USDC, USDT, WETH, WBTC, LINK, DAI)</label>
        <label class="inline"><input type="checkbox" name="hasEtherscanPro">I have an Etherscan Pro plan (enables Base/BSC fully)</label>
        <button type="submit" class="btn-primary">Validate &amp; Save</button>
      </form>
      <div id="form-result"></div>`;
    wireForm("form-mm", async (data) => {
      const form = document.getElementById("form-mm") as HTMLFormElement;
      const chainIds = Array.from(form.querySelectorAll<HTMLInputElement>("input[name=chains]:checked"))
        .map((cb) => parseInt(cb.value, 10));
      if (chainIds.length === 0) return { ok: false, error: "Pick at least one chain." };
      return callTool("setup_connector", {
        connector: "metamask",
        metamask: {
          address: data.address,
          etherscanApiKey: data.etherscanApiKey,
          chainIds,
          trackCommonTokens: data.trackCommonTokens === "on",
          hasEtherscanPro: data.hasEtherscanPro === "on",
        },
      });
    });
    return;
  }
  if (connector === "solana") {
    slot.innerHTML = `
      <h3>Solana wallet setup</h3>
      <p class="muted">Paste your base58 Solana address. Public RPC works for single wallets — multi-wallet setups should supply a premium RPC (Helius, QuickNode, Triton) to avoid rate limits. Prices via Jupiter Price API v2.</p>
      <form id="form-sol" class="form-grid">
        <label>Solana address<input name="address" type="text" pattern="^[1-9A-HJ-NP-Za-km-z]{32,44}$" required placeholder="(base58, e.g. 4k3Dyj...)" autocomplete="off"></label>
        <label>RPC URL (optional)<input name="rpcUrl" type="url" placeholder="https://mainnet.helius-rpc.com/?api-key=..." autocomplete="off">
          <small class="muted">Leave blank for public mainnet-beta.</small>
        </label>
        <label>Dust threshold (USD)<input name="dustThresholdUsd" type="number" step="0.01" value="0.5" min="0">
          <small class="muted">Hide tokens worth less than this. 0 to show everything.</small>
        </label>
        <button type="submit" class="btn-primary">Validate &amp; Save</button>
      </form>
      <div id="form-result"></div>`;
    wireForm("form-sol", async (data) => callTool("setup_connector", {
      connector: "solana",
      solana: {
        address: data.address,
        rpcUrl: data.rpcUrl && data.rpcUrl.length > 0 ? data.rpcUrl : undefined,
        dustThresholdUsd: data.dustThresholdUsd ? parseFloat(data.dustThresholdUsd) : undefined,
      },
    }));
    return;
  }
  if (connector === "polymarket") {
    slot.innerHTML = `
      <h3>Polymarket setup</h3>
      <p class="muted">Find your <strong>proxy wallet</strong> address (NOT your MetaMask address) at polymarket.com → Settings → Wallet. The data-api is public, no secret needed.</p>
      <form id="form-poly" class="form-grid">
        <label>Polymarket proxy wallet<input name="proxyWallet" type="text" pattern="^0x[a-fA-F0-9]{40}$" required placeholder="0x..." autocomplete="off"></label>
        <label>Min position size to track<input name="sizeThreshold" type="number" step="0.001" value="0.01" min="0">
          <small class="muted">Lower = more dust positions shown</small>
        </label>
        <button type="submit" class="btn-primary">Validate &amp; Save</button>
      </form>
      <div id="form-result"></div>`;
    wireForm("form-poly", async (data) => callTool("setup_connector", {
      connector: "polymarket",
      polymarket: {
        proxyWallet: data.proxyWallet,
        sizeThreshold: parseFloat(data.sizeThreshold) || 0.01,
      },
    }));
    return;
  }
}

interface SetupOutcome {
  ok: boolean;
  accountId?: string;
  label?: string;
  error?: string;
}

function wireForm(formId: string, submit: (data: Record<string, string>) => Promise<SetupOutcome | null>): void {
  const form = document.getElementById(formId) as HTMLFormElement | null;
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const data: Record<string, string> = {};
    for (const [k, v] of fd.entries()) data[k] = String(v);
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitBtn.disabled = true;
    submitBtn.textContent = "Validating...";
    setStatus("Validating credentials with upstream API...");
    const result = await submit(data);
    submitBtn.disabled = false;
    submitBtn.textContent = "Validate & Save";
    const slot = document.getElementById("form-result")!;
    if (result?.ok) {
      slot.innerHTML = `<div class="success">✓ Saved <strong>${escapeHtml(result.label ?? "")}</strong> as <code>${escapeHtml(result.accountId ?? "")}</code>. Switch to the Accounts tab to see it.</div>`;
      setStatus("Saved.");
    } else {
      slot.innerHTML = `<div class="error">${escapeHtml(result?.error ?? "unknown error")}</div>`;
      setStatus(`Failed: ${result?.error ?? "unknown"}`, true);
    }
  });
}

// ============================================================================
// Tab: Wallets (add address to existing MetaMask account)
// ============================================================================

async function renderWallets(): Promise<void> {
  const target = $("tab-content");
  showLoading(target);
  // Multi-wallet supported by MetaMask AND Solana (v0.12+). Fetch both lists,
  // merge, and let the form route per-account based on connectorId.
  const [mmResp, solResp] = await Promise.all([
    callTool<ListAccountsResp>("list_accounts", { connector: "metamask" }),
    callTool<ListAccountsResp>("list_accounts", { connector: "solana" }),
  ]);
  if (!mmResp || !solResp) {
    target.innerHTML = '<div class="error">Failed to load accounts.</div>';
    return;
  }
  const accounts = [...mmResp.accounts, ...solResp.accounts];
  if (accounts.length === 0) {
    target.innerHTML = `<section><p class="empty">No multi-wallet capable accounts yet (MetaMask or Solana). Add one in <a href="#" data-tab-link="add-account">Add Account</a>.</p></section>`;
    target.querySelector<HTMLAnchorElement>("[data-tab-link]")?.addEventListener("click", (e) => {
      e.preventDefault();
      activeTab = "add-account";
      renderShell();
      renderActiveTab();
    });
    return;
  }

  // The native HTML pattern attribute can only hold one regex, so we validate
  // server-side via add_wallet_address. Show a hint near the input instead.
  target.innerHTML = `
    <section>
      <h3>Add an additional address to a wallet account</h3>
      <p class="muted">The new address shares the parent account's settings (Etherscan key + chains for MetaMask, RPC URL for Solana). Multi-wallet under one MCP account.</p>
      <form id="form-wallet" class="form-grid">
        <label>Account<select name="account_id" required>
          ${accounts.map((a) => {
            const addrs = Array.isArray(a.metadata.addresses) ? a.metadata.addresses as string[] : (typeof a.metadata.address === "string" ? [a.metadata.address] : []);
            return `<option value="${escapeHtml(a.id)}" data-connector="${escapeHtml(a.connectorId)}">${escapeHtml(a.label)} — ${addrs.length} address${addrs.length === 1 ? "" : "es"}</option>`;
          }).join("")}
        </select></label>
        <label>New wallet address<input name="address" type="text" required placeholder="0x... or base58" autocomplete="off">
          <small class="muted" id="wallet-format-hint">Paste a 0x EVM address for MetaMask, or a base58 address for Solana.</small>
        </label>
        <button type="submit" class="btn-primary">Add address</button>
      </form>
      <div id="form-result"></div>
    </section>

    <section>
      <h3>Tracked addresses by account</h3>
      <table>
        <thead><tr><th>Account</th><th>Connector</th><th>Addresses</th></tr></thead>
        <tbody>
          ${accounts.map((a) => {
            const addrs = Array.isArray(a.metadata.addresses) ? a.metadata.addresses as string[] : (typeof a.metadata.address === "string" ? [a.metadata.address] : []);
            return `<tr>
              <td><strong>${escapeHtml(a.label)}</strong></td>
              <td><span class="tag tag-${escapeHtml(a.connectorId)}">${escapeHtml(a.connectorId)}</span></td>
              <td>${addrs.map((x) => `<code class="mono">${escapeHtml(x)}</code>`).join("<br>")}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </section>`;

  const form = document.getElementById("form-wallet") as HTMLFormElement;
  // Update the format hint as the user picks a different account so EVM vs
  // base58 expectations are obvious before they paste.
  const accountSelect = form.querySelector<HTMLSelectElement>("select[name=account_id]")!;
  const updateHint = () => {
    const opt = accountSelect.options[accountSelect.selectedIndex];
    const conn = opt?.dataset.connector ?? "";
    const hint = $("wallet-format-hint") as HTMLElement;
    if (conn === "metamask") hint.textContent = "Format: 0x + 40 hex chars (EVM).";
    else if (conn === "solana") hint.textContent = "Format: base58, 32-44 chars (Solana). Case-sensitive.";
    else hint.textContent = "";
  };
  accountSelect.addEventListener("change", updateHint);
  updateHint();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const account_id = String(fd.get("account_id"));
    const address = String(fd.get("address"));
    setStatus("Adding wallet address...");
    const result = await callTool<{ ok: boolean; addresses?: string[]; error?: string }>("add_wallet_address", {
      account_id, address,
    });
    const slot = document.getElementById("form-result")!;
    if (result?.ok) {
      slot.innerHTML = `<div class="success">✓ Added. Account now tracks ${result.addresses?.length ?? 0} addresses.</div>`;
      setStatus("Added.");
      await renderWallets();
    } else {
      slot.innerHTML = `<div class="error">${escapeHtml(result?.error ?? "unknown error")}</div>`;
      setStatus(`Failed: ${result?.error ?? "unknown"}`, true);
    }
  });
}

// ============================================================================
// Tab: Custom Tokens
// ============================================================================

interface ListTokensResp {
  tokens: Array<{ accountId: string; chainId: number; chainName: string; contract: string; symbol: string; decimals: number }>;
  meta: { total: number };
}

async function renderTokens(): Promise<void> {
  const target = $("tab-content");
  showLoading(target);
  const [accountsResp, tokensResp] = await Promise.all([
    callTool<ListAccountsResp>("list_accounts", { connector: "metamask" }),
    callTool<ListTokensResp>("list_custom_tokens", {}),
  ]);
  if (!accountsResp || !tokensResp) {
    target.innerHTML = '<div class="error">Failed to load tokens.</div>';
    return;
  }

  const tokenRowsHtml = tokensResp.tokens.length === 0
    ? `<tr><td colspan="5" class="empty">No custom tokens yet. Add one below — bundled defaults (USDC/USDT/WETH/WBTC/LINK/DAI) are tracked automatically.</td></tr>`
    : tokensResp.tokens.map((t) => `
      <tr>
        <td><strong>${escapeHtml(t.symbol)}</strong></td>
        <td class="muted">${escapeHtml(t.accountId)}</td>
        <td>${escapeHtml(t.chainName)} (${t.chainId})</td>
        <td class="mono muted">${escapeHtml(t.contract)}</td>
        <td><button class="btn-danger" data-remove-token data-account="${escapeHtml(t.accountId)}" data-chain="${t.chainId}" data-contract="${escapeHtml(t.contract)}">Remove</button></td>
      </tr>`).join("");

  target.innerHTML = `
    <section>
      <h3>${tokensResp.tokens.length} custom token${tokensResp.tokens.length === 1 ? "" : "s"}</h3>
      <table>
        <thead><tr><th>Symbol</th><th>Account</th><th>Chain</th><th>Contract</th><th></th></tr></thead>
        <tbody>${tokenRowsHtml}</tbody>
      </table>
    </section>

    ${accountsResp.accounts.length === 0 ? "" : `
    <section>
      <h3>Add a custom token</h3>
      <form id="form-token" class="form-grid">
        <label>Account<select name="account_id" required>
          ${accountsResp.accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)}</option>`).join("")}
        </select></label>
        <label>Chain<select name="chain_id" required>
          <option value="1">Ethereum (1)</option>
          <option value="137">Polygon (137)</option>
          <option value="42161">Arbitrum (42161)</option>
          <option value="10">Optimism (10)</option>
          <option value="8453">Base (8453)</option>
          <option value="56">BSC (56)</option>
        </select></label>
        <label>Contract address<input name="contract" type="text" pattern="^0x[a-fA-F0-9]{40}$" required placeholder="0x..." autocomplete="off"></label>
        <label>Symbol<input name="symbol" type="text" required maxlength="20" placeholder="ARB"></label>
        <label>Decimals<input name="decimals" type="number" required min="0" max="36" value="18"></label>
        <button type="submit" class="btn-primary">Add token</button>
      </form>
      <div id="form-result"></div>
    </section>`}`;

  target.querySelectorAll<HTMLButtonElement>("[data-remove-token]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const account_id = btn.dataset.account!;
      const chain_id = parseInt(btn.dataset.chain!, 10);
      const contract = btn.dataset.contract!;
      if (!confirm(`Stop tracking this token on ${account_id}?`)) return;
      btn.disabled = true;
      const result = await callTool<{ ok: boolean; error?: string }>("remove_custom_token", { account_id, chain_id, contract });
      if (result?.ok) {
        setStatus("Removed token.");
        await renderTokens();
      } else {
        setStatus(`Failed: ${result?.error ?? "unknown"}`, true);
        btn.disabled = false;
      }
    });
  });

  const form = document.getElementById("form-token") as HTMLFormElement | null;
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    setStatus("Adding token...");
    const result = await callTool<{ ok: boolean; action?: string; error?: string }>("add_custom_token", {
      account_id: String(fd.get("account_id")),
      chain_id: parseInt(String(fd.get("chain_id")), 10),
      contract: String(fd.get("contract")),
      symbol: String(fd.get("symbol")),
      decimals: parseInt(String(fd.get("decimals")), 10),
    });
    const slot = document.getElementById("form-result")!;
    if (result?.ok) {
      slot.innerHTML = `<div class="success">✓ Token ${result.action}.</div>`;
      setStatus("Added.");
      await renderTokens();
    } else {
      slot.innerHTML = `<div class="error">${escapeHtml(result?.error ?? "unknown")}</div>`;
      setStatus(`Failed: ${result?.error ?? "unknown"}`, true);
    }
  });
}

// ============================================================================
// Wire-up
// ============================================================================

function renderActiveTab(): void {
  const map: Record<TabName, () => Promise<void>> = {
    accounts: renderAccounts,
    "add-account": renderAddAccount,
    wallets: renderWallets,
    tokens: renderTokens,
  };
  setStatus("");
  map[activeTab]().catch((e: unknown) => setStatus(`Error: ${String(e)}`, true));
}

function renderShell(): void {
  const tabsEl = $("tabs");
  tabsEl.innerHTML = TABS.map((t) =>
    `<button data-tab="${t}" class="tab ${t === activeTab ? "active" : ""}">${TAB_LABELS[t]}</button>`
  ).join("");
  tabsEl.querySelectorAll<HTMLButtonElement>("button.tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab as TabName;
      renderShell();
      renderActiveTab();
    });
  });
}

interface SettingsArgs {
  tab?: TabName;
}

app.ontoolinput = (params: { name?: string; arguments?: unknown }) => {
  const args = (params.arguments ?? {}) as SettingsArgs;
  if (args.tab && TABS.includes(args.tab)) activeTab = args.tab;
  renderShell();
  renderActiveTab();
};

renderShell();
renderActiveTab();
app.connect();
