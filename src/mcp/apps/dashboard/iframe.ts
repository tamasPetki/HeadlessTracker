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

// Color palette for pie/donut slices. Picked to be readable in both light
// and dark themes; cycles if more slices than colors.
const SLICE_COLORS = [
  "#2f81f7", // blue
  "#3fb950", // green
  "#d29922", // amber
  "#bc8cff", // purple
  "#f85149", // red
  "#1f6feb", // dark blue
  "#56d4dd", // teal
  "#ff7b72", // coral
];

// SVG donut chart. Renders slices + a side legend. For breakdowns where
// percentages of a whole are the natural framing (asset class, venue mix).
// Returns a flex row with chart on the left, legend on the right.
function pieChart(rows: Array<{ label: string; value: number }>, ccy: Currency): string {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (total <= 0) return '<div class="empty">No data</div>';
  // Sort descending so the biggest slice starts at 12 o'clock and reads
  // clockwise — matches user expectation for "biggest first" charts.
  const sorted = [...rows].sort((a, b) => b.value - a.value);

  const cx = 110;
  const cy = 110;
  const r = 90;
  const inner = 55;
  let angle = -Math.PI / 2; // Start at top

  const sliceSvg: string[] = [];
  const legendItems: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]!;
    const pct = row.value / total;
    const sweep = pct * 2 * Math.PI;
    const color = SLICE_COLORS[i % SLICE_COLORS.length]!;

    if (sorted.length === 1) {
      // Edge case: a single 100% slice — full ring, not a degenerate path.
      sliceSvg.push(
        `<circle cx="${cx}" cy="${cy}" r="${(r + inner) / 2}" fill="none" stroke="${color}" stroke-width="${r - inner}"/>`
      );
    } else {
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + sweep);
      const y2 = cy + r * Math.sin(angle + sweep);
      const x3 = cx + inner * Math.cos(angle + sweep);
      const y3 = cy + inner * Math.sin(angle + sweep);
      const x4 = cx + inner * Math.cos(angle);
      const y4 = cy + inner * Math.sin(angle);
      const large = sweep > Math.PI ? 1 : 0;
      const d =
        `M ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
        `A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} ` +
        `L ${x3.toFixed(2)} ${y3.toFixed(2)} ` +
        `A ${inner} ${inner} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
      sliceSvg.push(`<path d="${d}" fill="${color}"></path>`);
    }
    angle += sweep;

    legendItems.push(`
      <div class="legend-item">
        <span class="legend-swatch" style="background:${color}"></span>
        <span class="legend-label">${escapeHtml(row.label)}</span>
        <span class="legend-value">${escapeHtml(fmtMoney(row.value, ccy))}</span>
        <span class="legend-pct">${(pct * 100).toFixed(1)}%</span>
      </div>
    `);
  }

  return `
    <div class="pie-row">
      <svg viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg" class="pie-chart">
        ${sliceSvg.join("")}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="pie-total-label">Total</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="pie-total-value">${escapeHtml(fmtMoney(total, ccy))}</text>
      </svg>
      <div class="legend">${legendItems.join("")}</div>
    </div>
  `;
}

// Take the top N rows by value and roll up the rest into a single "Other"
// slice. Avoids the 30-slice-confetti problem on portfolios with a long tail
// of dust positions, while preserving the total. If there are <= n rows OR
// the tail sum is zero, returns the input unchanged.
function bucketTopN(rows: Array<{ label: string; value: number }>, n: number): Array<{ label: string; value: number }> {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  if (sorted.length <= n) return sorted;
  const top = sorted.slice(0, n);
  const tail = sorted.slice(n);
  const tailSum = tail.reduce((s, r) => s + r.value, 0);
  if (tailSum <= 0) return top;
  return [...top, { label: `Other (${tail.length})`, value: tailSum }];
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
  const [h, bySymbol, pnl] = await Promise.all([
    callTool<HoldingsResult>("get_holdings", { currency }),
    // Pull more than we'll display so we can compute the "Other" tail bucket.
    callTool<AllocationsResult>("get_allocations", { by: "symbol" }),
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
      <h3>Allocation by symbol</h3>
      ${pieChart(bucketTopN(bySymbol.rows.map((r) => ({ label: r.label, value: r.currentValue })), 7), currency)}
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
      ${pieChart(byConn.rows.map((r) => ({ label: r.label, value: r.currentValue })), "USD")}
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
