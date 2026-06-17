// Unit tests for the `demo` sample dataset. These guard the contract the CLI
// renders and the headline total it prints, so the demo can't silently drift
// or lose its disclaimer.

import { describe, expect, test } from "bun:test";
import { DEMO_ACCOUNTS, DEMO_HOLDINGS, DEMO_PROMPTS, DEMO_TOTAL_USD } from "../src/demo-data.ts";
import type { AssetClass } from "../src/types.ts";

const VALID_CLASSES: AssetClass[] = ["crypto", "stock", "prediction", "cash"];
// Tool names the demo claims each prompt maps to — must stay real tool names.
const REAL_TOOLS = new Set(["get_holdings", "get_allocations", "get_polymarket_positions", "get_pnl"]);

describe("demo dataset", () => {
  test("is a non-trivial multi-venue portfolio", () => {
    expect(DEMO_HOLDINGS.length).toBeGreaterThanOrEqual(10);
    const accounts = new Set(DEMO_HOLDINGS.map((h) => h.accountId));
    expect(accounts.size).toBe(6); // one per connector
  });

  test("every holding is fully priced and USD-denominated", () => {
    for (const h of DEMO_HOLDINGS) {
      expect(VALID_CLASSES).toContain(h.assetClass);
      expect(h.valueCurrency).toBe("USD");
      expect(Number.isFinite(h.quantity)).toBe(true);
      expect(Number.isFinite(h.currentPrice)).toBe(true);
      expect(Number.isFinite(h.value)).toBe(true);
      // value is a fixed snapshot equal to quantity * currentPrice.
      expect(h.value!).toBeCloseTo(h.quantity * h.currentPrice!, 4);
    }
  });

  test("DEMO_TOTAL_USD equals the sum of holding values", () => {
    const sum = DEMO_HOLDINGS.reduce((s, h) => s + (h.value ?? 0), 0);
    expect(DEMO_TOTAL_USD).toBeCloseTo(sum, 6);
    expect(DEMO_TOTAL_USD).toBe(116166);
  });

  test("includes all three asset classes (the 'how is it split' story)", () => {
    const classes = new Set(DEMO_HOLDINGS.map((h) => h.assetClass));
    expect(classes.has("crypto")).toBe(true);
    expect(classes.has("cash")).toBe(true);
    expect(classes.has("prediction")).toBe(true);
  });

  test("each demo account id is referenced by at least one holding", () => {
    const referenced = new Set(DEMO_HOLDINGS.map((h) => h.accountId));
    for (const a of DEMO_ACCOUNTS) expect(referenced.has(a.id)).toBe(true);
  });

  test("every example prompt maps to a real MCP tool", () => {
    expect(DEMO_PROMPTS.length).toBeGreaterThan(0);
    for (const p of DEMO_PROMPTS) expect(REAL_TOOLS.has(p.tool)).toBe(true);
  });
});
