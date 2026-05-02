/// <reference lib="dom" />
// Browser-side code for the headless-tracker dashboard MCP App.
//
// Runs INSIDE A SANDBOXED IFRAME inside Claude Desktop (or any other MCP-Apps-
// capable host). Speaks to the MCP server via PostMessage / JSON-RPC mediated
// by the host. NO direct network access — all data fetches go through
// `app.callServerTool({name: "get_holdings", ...})` etc.
//
// Bundle: `bun build` produces a single self-contained JS that the build
// script (scripts/build-mcp-apps.ts) inlines into shell.html, which becomes
// dist/mcp-apps/dashboard.html. The server reads that file at startup and
// serves it as the `ui://headless-tracker/dashboard` resource.
//
// This file imports from "@modelcontextprotocol/ext-apps" — that's a
// browser-safe dependency, the bundler pulls in the App class + its
// PostMessage transport.

import { App } from "@modelcontextprotocol/ext-apps";

type Currency = "USD" | "EUR" | "GBP" | "HUF";
type TabName = "portfolio" | "weekly" | "risk";

interface DashboardArgs {
  currency?: Currency;
  tab?: TabName;
}

const app = new App({ name: "Headless Tracker Dashboard", version: "1.0.0" });

// Mutable state. Defaults overridden by tool input on first ontoolinput.
let currency: Currency = "USD";
let activeTab: TabName = "portfolio";

const TABS: TabName[] = ["portfolio", "weekly", "risk"];
const TAB_LABELS: Record<TabName, string> = {
  portfolio: "Portfolio",
  weekly: "Weekly",
  risk: "Risk",
};
const CURRENCIES: Currency[] = ["USD", "EUR", "GBP", "HUF"];

// Tool result shape the existing tools return: text-encoded JSON in content[0].text.
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

function fmtMoney(n: number | null | undefined, ccy: Currency = currency): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (ccy === "HUF") {
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M Ft`;
    return `${sign}${abs.toFixed(0)} Ft`;
  }
  const symbol = ccy === "USD" ? "$" : ccy === "EUR" ? "€" : "£";
  if (abs >= 1000) return `${sign}${symbol}${abs.toFixed(0)}`;
  if (abs >= 1) return `${sign}${symbol}${abs.toFixed(2)}`;
  return `${sign}${symbol}${abs.toFixed(4)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]!);
}

// Tiny SVG horizontal bar chart. width=100% of parent, no deps, no Chart.js.
function barChart(rows: Array<{ label: string; value: number }>, ccy: Currency): string {
  if (rows.length === 0) return '<div class="empty">No data</div>';
  const max = Math.max(...rows.map((r) => r.value), 1);
  const barH = 24;
  const gap = 6;
  const labelW = 120;
  const valueW = 100;
  const chartW = 360;
  const totalW = labelW + chartW + valueW;
  const totalH = rows.length * (barH + gap);
  const bars = rows.map((r, i) => {
    const y = i * (barH + gap);
    const w = (r.value / max) * chartW;
    return `
      <text x="${labelW - 8}" y="${y + barH / 2 + 4}" text-anchor="end" class="bar-label">${escapeHtml(r.label)}</text>
      <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="3" class="bar"></rect>
      <text x="${labelW + chartW + 8}" y="${y + barH / 2 + 4}" class="bar-value">${escapeHtml(fmtMoney(r.value, ccy))}</text>
    `;
  }).join("");
  return `<svg viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg" class="bar-chart">${bars}</svg>`;
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
// Tab: Portfolio
// ============================================================================

interface HoldingsResult {
  holdings: Array<{
    accountId: string;
    symbol: string;
    assetClass: string;
    quantity: number;
    value?: number;
    currentPrice?: number;
    valueCurrency: string;
  }>;
  failures: Array<{ accountId: string; error: string }>;
  warnings: string[];
  meta: {
    accountsConfigured: number;
    accountsWithData: number;
    fx?: { source: string; rateUsdToTarget: number; targetCurrency: string };
  };
}
interface AllocationsResult {
  groupedBy: string;
  rows: Array<{ label: string; currentValue: number; percentOfTotal: number; holdingCount: number }>;
  meta: { totalCurrentValue: number; totalHoldings: number };
}
interface PnlResult {
  total: { currentValue: number; costBasis: number; unrealizedPnl: number; realizedPnl: number };
  byAccount: Array<{ accountId: string; currentValue: number; realizedPnl: number | null; notes: string[] }>;
}

async function renderPortfolio(): Promise<void> {
  const target = $("tab-content");
  showLoading(target);
  const [h, byClass, bySymbol, pnl] = await Promise.all([
    callTool<HoldingsResult>("get_holdings", { currency }),
    callTool<AllocationsResult>("get_allocations", { by: "asset_class" }),
    callTool<AllocationsResult>("get_allocations", { by: "symbol", top: 10 }),
    callTool<PnlResult>("get_pnl", {}),
  ]);

  if (!h) {
    target.innerHTML = '<div class="error">Failed to load holdings.</div>';
    return;
  }

  const total = h.holdings.reduce((s, hd) => s + (hd.value ?? 0), 0);
  const sorted = [...h.holdings].filter((hd) => hd.value !== undefined).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const fxLine = h.meta.fx
    ? `<span class="fx">FX: 1 USD = ${h.meta.fx.rateUsdToTarget.toFixed(4)} ${h.meta.fx.targetCurrency} (${h.meta.fx.source})</span>`
    : "";

  target.innerHTML = `
    <section>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Total value</div><div class="kpi-value">${fmtMoney(total)}</div></div>
        <div class="kpi"><div class="kpi-label">Positions</div><div class="kpi-value">${h.holdings.length}</div></div>
        <div class="kpi"><div class="kpi-label">Accounts</div><div class="kpi-value">${h.meta.accountsWithData} / ${h.meta.accountsConfigured}</div></div>
        <div class="kpi"><div class="kpi-label">Realized PnL (connector)</div><div class="kpi-value ${(pnl?.total.realizedPnl ?? 0) >= 0 ? "pos" : "neg"}">${fmtMoney(pnl?.total.realizedPnl ?? null)}</div></div>
      </div>
      ${fxLine ? `<div class="fx-line">${fxLine}</div>` : ""}
    </section>

    <section>
      <h3>Allocation by asset class</h3>
      ${barChart((byClass?.rows ?? []).map((r) => ({ label: r.label, value: r.currentValue })), currency)}
    </section>

    <section>
      <h3>Top positions by value</h3>
      <table>
        <thead><tr><th>Symbol</th><th>Account</th><th>Qty</th><th>Value</th><th>% of portfolio</th></tr></thead>
        <tbody>
          ${sorted.slice(0, 10).map((hd) => `
            <tr>
              <td><strong>${escapeHtml(hd.symbol)}</strong></td>
              <td class="muted">${escapeHtml(hd.accountId)}</td>
              <td class="num">${hd.quantity.toPrecision(6)}</td>
              <td class="num">${fmtMoney(hd.value)}</td>
              <td class="num">${total > 0 ? fmtPct((hd.value ?? 0) / total * 100) : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>

    ${bySymbol && bySymbol.rows.length > 0 ? `
    <section>
      <h3>Top 10 by symbol (across accounts)</h3>
      ${barChart(bySymbol.rows.slice(0, 10).map((r) => ({ label: r.label, value: r.currentValue })), currency)}
    </section>` : ""}

    ${h.warnings.length > 0 ? `
    <section class="warnings">
      <h3>Warnings</h3>
      <ul>${h.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
    </section>` : ""}

    ${h.failures.length > 0 ? `
    <section class="warnings">
      <h3>Failures</h3>
      <ul>${h.failures.map((f) => `<li><strong>${escapeHtml(f.accountId)}</strong>: ${escapeHtml(f.error)}</li>`).join("")}</ul>
    </section>` : ""}
  `;
}

// ============================================================================
// Tab: Weekly
// ============================================================================

interface PnlWithWindow extends PnlResult {
  total: PnlResult["total"] & {
    windowDelta: {
      timeframe: string;
      asOfDate: string;
      historicalValue: number;
      currentValueAtSnapshot: number;
      delta: number;
      deltaPercent: number;
      pricedSymbols: number;
      skippedSymbols: number;
      skippedReasons: string[];
    } | null;
  };
}
interface TransactionsResult {
  transactions: Array<{
    accountId: string;
    txId: string;
    type: string;
    symbol?: string;
    quantity?: number;
    price?: number;
    timestamp: number;
  }>;
  meta: { sinceResolved: string; sinceInputRaw: string; totalTransactions: number };
}

async function renderWeekly(): Promise<void> {
  const target = $("tab-content");
  showLoading(target);
  const [pnl, txns] = await Promise.all([
    callTool<PnlWithWindow>("get_pnl", { timeframe: "7d" }),
    callTool<TransactionsResult>("get_transactions", { since: "7d" }),
  ]);

  if (!pnl) {
    target.innerHTML = '<div class="error">Failed to load PnL.</div>';
    return;
  }

  const wd = pnl.total.windowDelta;
  const txnCount = txns?.transactions.length ?? 0;

  const skipBlock = (wd && wd.skippedSymbols > 0)
    ? `<details><summary>${wd.skippedSymbols} skipped symbol${wd.skippedSymbols === 1 ? "" : "s"}</summary>
        <ul>${wd.skippedReasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></details>`
    : "";

  target.innerHTML = `
    <section>
      <h3>7-day window delta</h3>
      <p class="caveat">"Current basket valued at 7-day-old prices vs now". Does NOT account for trades within the window.</p>
      ${wd ? `
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">7d ago</div><div class="kpi-value">${fmtMoney(wd.historicalValue)}</div><div class="kpi-meta">${escapeHtml(wd.asOfDate.slice(0, 10))}</div></div>
        <div class="kpi"><div class="kpi-label">Now</div><div class="kpi-value">${fmtMoney(wd.currentValueAtSnapshot)}</div></div>
        <div class="kpi"><div class="kpi-label">Delta</div><div class="kpi-value ${wd.delta >= 0 ? "pos" : "neg"}">${fmtMoney(wd.delta)}</div></div>
        <div class="kpi"><div class="kpi-label">% change</div><div class="kpi-value ${wd.deltaPercent >= 0 ? "pos" : "neg"}">${fmtPct(wd.deltaPercent)}</div></div>
      </div>
      <div class="meta-line">${wd.pricedSymbols} priced, ${wd.skippedSymbols} skipped</div>
      ${skipBlock}
      ` : `<div class="empty">No window delta — no priced holdings or all skipped.</div>`}
    </section>

    <section>
      <h3>Trades in the last 7 days (${txnCount})</h3>
      ${txnCount > 0 && txns ? `
      <table>
        <thead><tr><th>Date</th><th>Account</th><th>Type</th><th>Symbol</th><th>Qty</th><th>Price</th></tr></thead>
        <tbody>
          ${txns.transactions.slice(0, 50).map((t) => `
            <tr>
              <td class="muted">${new Date(t.timestamp).toISOString().slice(0, 16).replace("T", " ")}</td>
              <td class="muted">${escapeHtml(t.accountId)}</td>
              <td><span class="tag tag-${escapeHtml(t.type)}">${escapeHtml(t.type)}</span></td>
              <td>${escapeHtml(t.symbol ?? "—")}</td>
              <td class="num">${t.quantity?.toPrecision(6) ?? "—"}</td>
              <td class="num">${t.price !== undefined ? fmtMoney(t.price, "USD") : "—"}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      ${txnCount > 50 ? `<div class="meta-line">Showing first 50 of ${txnCount}</div>` : ""}
      ` : `<div class="empty">No trades in the last 7 days.</div>`}
    </section>
  `;
}

// ============================================================================
// Tab: Risk
// ============================================================================

async function renderRisk(): Promise<void> {
  const target = $("tab-content");
  showLoading(target);
  const [h, bySymbol, byClass, byConn] = await Promise.all([
    callTool<HoldingsResult>("get_holdings", {}),
    callTool<AllocationsResult>("get_allocations", { by: "symbol" }),
    callTool<AllocationsResult>("get_allocations", { by: "asset_class" }),
    callTool<AllocationsResult>("get_allocations", { by: "connector" }),
  ]);

  if (!h || !bySymbol || !byClass || !byConn) {
    target.innerHTML = '<div class="error">Failed to load risk data.</div>';
    return;
  }

  const total = bySymbol.meta.totalCurrentValue;

  // Risk dimensions, each scored PASS / WARN / ALERT.
  const topSymbol = bySymbol.rows[0];
  const symbolPct = topSymbol ? topSymbol.percentOfTotal : 0;
  const symbolStatus = symbolPct > 40 ? "ALERT" : symbolPct > 25 ? "WARN" : "PASS";

  const topConn = byConn.rows[0];
  const connPct = topConn ? topConn.percentOfTotal : 0;
  const connStatus = connPct > 70 ? "ALERT" : connPct > 50 ? "WARN" : "PASS";

  const stableSymbols = ["USDC", "USDT", "DAI", "BUSD"];
  const stableValue = bySymbol.rows.filter((r) => stableSymbols.includes(r.label)).reduce((s, r) => s + r.currentValue, 0);
  const stablePct = total > 0 ? (stableValue / total) * 100 : 0;
  const stableStatus = stablePct === 0 ? "ALERT" : stablePct < 5 ? "WARN" : "PASS";

  const predRow = byClass.rows.find((r) => r.label === "prediction");
  const predPct = predRow ? predRow.percentOfTotal : 0;
  const predStatus = predPct > 15 ? "WARN" : "PASS";

  const dims: Array<{ name: string; status: string; detail: string }> = [
    { name: "Single-position concentration", status: symbolStatus, detail: topSymbol ? `${topSymbol.label} = ${fmtPct(symbolPct)}` : "n/a" },
    { name: "Venue concentration", status: connStatus, detail: topConn ? `${topConn.label} = ${fmtPct(connPct)}` : "n/a" },
    { name: "Stablecoin reserve", status: stableStatus, detail: `${fmtMoney(stableValue)} = ${fmtPct(stablePct)}` },
    { name: "Prediction-market overweight", status: predStatus, detail: predRow ? fmtPct(predPct) : "0% (no Polymarket account)" },
  ];

  const alerts = dims.filter((d) => d.status === "ALERT");
  const summaryText = alerts.length === 0
    ? `No risk alerts. ${dims.filter((d) => d.status === "WARN").length} warnings to consider.`
    : `${alerts.length} alert${alerts.length === 1 ? "" : "s"}: ${alerts.map((a) => a.name).join(", ")}.`;

  target.innerHTML = `
    <section>
      <h3>Risk audit</h3>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Total value</div><div class="kpi-value">${fmtMoney(total)}</div></div>
        <div class="kpi"><div class="kpi-label">Positions</div><div class="kpi-value">${bySymbol.meta.totalHoldings}</div></div>
      </div>
      <p class="summary">${escapeHtml(summaryText)}</p>
    </section>

    <section>
      <table class="risk-table">
        <thead><tr><th>Risk</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>
          ${dims.map((d) => `
            <tr>
              <td>${escapeHtml(d.name)}</td>
              <td><span class="status-${d.status.toLowerCase()}">${d.status}</span></td>
              <td>${escapeHtml(d.detail)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </section>

    <section>
      <h3>By venue</h3>
      ${barChart(byConn.rows.map((r) => ({ label: r.label, value: r.currentValue })), "USD")}
    </section>
  `;
}

// ============================================================================
// Wire-up
// ============================================================================

function renderActiveTab(): void {
  const map: Record<TabName, () => Promise<void>> = {
    portfolio: renderPortfolio,
    weekly: renderWeekly,
    risk: renderRisk,
  };
  setStatus("Loading...");
  map[activeTab]().then(
    () => setStatus(`Updated ${new Date().toLocaleTimeString()}`),
    (e: unknown) => setStatus(`Error: ${String(e)}`, true)
  );
}

function renderShell(): void {
  // Tabs
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
  // Currency selector
  const ccyEl = $("currency-select") as HTMLSelectElement;
  ccyEl.innerHTML = CURRENCIES.map((c) => `<option value="${c}" ${c === currency ? "selected" : ""}>${c}</option>`).join("");
  ccyEl.onchange = () => {
    currency = ccyEl.value as Currency;
    renderActiveTab();
  };
  // Refresh button
  ($("refresh-btn") as HTMLButtonElement).onclick = async () => {
    try {
      await app.callServerTool({ name: "refresh_data", arguments: {} });
    } catch {
      // ignore
    }
    renderActiveTab();
  };
}

// Hook tool input BEFORE connect to apply user-supplied args (currency, tab).
app.ontoolinput = (params: { name?: string; arguments?: unknown }) => {
  const args = (params.arguments ?? {}) as DashboardArgs;
  if (args.currency && CURRENCIES.includes(args.currency)) currency = args.currency;
  if (args.tab && TABS.includes(args.tab)) activeTab = args.tab;
  renderShell();
  renderActiveTab();
};

renderShell();
app.connect();
