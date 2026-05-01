// FIFO cost basis tracker tests. Critical regression flag from /autoplan
// review: TC10 (orphan SELL → null, never NaN) — easy to silently corrupt
// downstream sums if anything in this module emits NaN.

import { describe, expect, test } from "bun:test";
import {
  computeCostBasis,
  computeCostBasisAverage,
  computeCostBasisWithMethod,
} from "../src/cost_basis.ts";
import type { Transaction } from "../src/types.ts";

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    accountId: "test:account",
    txId: `tx-${Math.random().toString(36).slice(2, 8)}`,
    type: "buy",
    timestamp: 1000,
    ...overrides,
  };
}

describe("computeCostBasis — FIFO basics", () => {
  test("simple buy then sell → realized PnL math", () => {
    const result = computeCostBasis([
      tx({ type: "buy", symbol: "USDC", quantity: 100, price: 1.0, timestamp: 1000 }),
      tx({ type: "sell", symbol: "USDC", quantity: 50, price: 1.05, timestamp: 2000 }),
    ]);
    expect(result.realizedSales).toHaveLength(1);
    const sale = result.realizedSales[0]!;
    expect(sale.quantity).toBe(50);
    expect(sale.proceeds).toBe(52.5);          // 50 × 1.05
    expect(sale.costBasis).toBe(50);            // 50 × 1.0
    expect(sale.realizedPnl).toBeCloseTo(2.5, 6);
    expect(result.totals.realizedKnown).toBeCloseTo(2.5, 6);
    expect(result.totals.orphanCount).toBe(0);

    // Open lot remaining = 50 USDC at $1.0
    const usdcLots = result.openLots.get("USDC")!;
    expect(usdcLots).toHaveLength(1);
    expect(usdcLots[0]!.quantity).toBe(50);
  });

  test("multi-buy partial sell consumes oldest lot first", () => {
    // Two BUYs at different prices, then a SELL that crosses the boundary.
    const result = computeCostBasis([
      tx({ type: "buy", symbol: "ETH", quantity: 1, price: 1000, timestamp: 1000 }),
      tx({ type: "buy", symbol: "ETH", quantity: 1, price: 2000, timestamp: 2000 }),
      tx({ type: "sell", symbol: "ETH", quantity: 1.5, price: 3000, timestamp: 3000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.quantity).toBe(1.5);
    expect(sale.proceeds).toBeCloseTo(4500, 6);   // 1.5 × 3000
    // FIFO cost: 1.0 ETH @ 1000 + 0.5 ETH @ 2000 = 2000
    expect(sale.costBasis).toBeCloseTo(2000, 6);
    expect(sale.realizedPnl).toBeCloseTo(2500, 6);

    // Remaining lot: 0.5 ETH @ 2000
    const ethLots = result.openLots.get("ETH")!;
    expect(ethLots).toHaveLength(1);
    expect(ethLots[0]!.quantity).toBeCloseTo(0.5, 6);
    expect(ethLots[0]!.pricePerUnit).toBe(2000);
  });
});

describe("computeCostBasis — orphan SELL (TC10 critical regression)", () => {
  test("SELL with no prior BUY/DEPOSIT → realized PnL is null (NOT NaN, NOT 0)", () => {
    // The /autoplan eng review flagged this: NaN propagates silently through
    // sum reductions. null forces explicit handling at the consumer.
    const result = computeCostBasis([
      tx({ type: "sell", symbol: "FOO", quantity: 10, price: 5, timestamp: 1000 }),
    ]);
    expect(result.realizedSales).toHaveLength(1);
    const sale = result.realizedSales[0]!;
    expect(sale.quantity).toBe(0);                // no lots consumed
    expect(sale.realizedPnl).toBeNull();          // CRITICAL: not NaN
    expect(sale.costBasis).toBeNull();
    expect(Number.isNaN(sale.realizedPnl as unknown as number)).toBe(false);
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]!.reason).toContain("no prior");
    expect(result.totals.realizedKnown).toBe(0);
    expect(result.totals.realizedUnknownCount).toBe(1);
  });

  test("SELL partially exceeds lots → split: known portion realizes, orphan portion flagged", () => {
    const result = computeCostBasis([
      tx({ type: "buy", symbol: "USDC", quantity: 100, price: 1.0, timestamp: 1000 }),
      tx({ type: "sell", symbol: "USDC", quantity: 150, price: 1.10, timestamp: 2000 }),
    ]);
    expect(result.realizedSales).toHaveLength(1);
    const sale = result.realizedSales[0]!;
    expect(sale.quantity).toBe(100);              // fully consumed the lot
    expect(sale.proceeds).toBeCloseTo(110, 6);
    expect(sale.costBasis).toBeCloseTo(100, 6);
    expect(sale.realizedPnl).toBeCloseTo(10, 6);

    // Plus a 50-unit orphan for the unmatched portion.
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]!.quantity).toBe(50);
  });
});

describe("computeCostBasis — unknown cost basis (deposits / transfers)", () => {
  test("DEPOSIT lot → SELL produces null realized PnL", () => {
    // MetaMask use case: tokens received via on-chain transfer have no cost
    // basis. Selling them (e.g. via a DEX swap that the connector reports as
    // a SELL) must NOT fabricate a cost of 0 — that would inflate realized PnL.
    const result = computeCostBasis([
      tx({ type: "deposit", symbol: "FOO", quantity: 100, timestamp: 1000 }),
      tx({ type: "sell", symbol: "FOO", quantity: 50, price: 2.0, timestamp: 2000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.quantity).toBe(50);
    expect(sale.proceeds).toBe(100);              // 50 × 2.0
    expect(sale.costBasis).toBeNull();            // unknown propagates
    expect(sale.realizedPnl).toBeNull();
    expect(result.totals.realizedUnknownCount).toBe(1);
  });

  test("MIXED deposit + buy → partial SELL across both → unknown taints the sale", () => {
    // FIFO consumes deposit lot first (older), then buy lot. ANY unknown lot
    // in the consumption set taints the whole sale as unknown — that's the
    // honest answer; the user can't claim a clean realized PnL on a position
    // partly built from unpriced tokens.
    const result = computeCostBasis([
      tx({ type: "deposit", symbol: "FOO", quantity: 50, timestamp: 1000 }),
      tx({ type: "buy", symbol: "FOO", quantity: 50, price: 1.0, timestamp: 2000 }),
      tx({ type: "sell", symbol: "FOO", quantity: 75, price: 2.0, timestamp: 3000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.quantity).toBe(75);
    expect(sale.realizedPnl).toBeNull();          // tainted by deposit lot
    // The buy lot is partially consumed; 25 units remain.
    const fooLots = result.openLots.get("FOO")!;
    expect(fooLots).toHaveLength(1);
    expect(fooLots[0]!.quantity).toBeCloseTo(25, 6);
    expect(fooLots[0]!.costBasisKnown).toBe(true);
  });

  test("REWARD / INTEREST act like deposits (unknown cost basis)", () => {
    const result = computeCostBasis([
      tx({ type: "reward", symbol: "FOO", quantity: 10, timestamp: 1000 }),
      tx({ type: "interest", symbol: "FOO", quantity: 5, timestamp: 2000 }),
      tx({ type: "sell", symbol: "FOO", quantity: 12, price: 3.0, timestamp: 3000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.realizedPnl).toBeNull();
  });
});

describe("computeCostBasis — withdraw (TC11)", () => {
  test("WITHDRAW reduces lot quantity but does NOT realize a gain", () => {
    // User transfers USDC from MetaMask to another wallet they own. The
    // cost basis ledger should NOT count this as a sale.
    const result = computeCostBasis([
      tx({ type: "buy", symbol: "USDC", quantity: 100, price: 1.0, timestamp: 1000 }),
      tx({ type: "withdraw", symbol: "USDC", quantity: 30, timestamp: 2000 }),
    ]);
    expect(result.realizedSales).toHaveLength(0);  // no sale recorded
    expect(result.totals.realizedKnown).toBe(0);
    const usdcLots = result.openLots.get("USDC")!;
    expect(usdcLots).toHaveLength(1);
    expect(usdcLots[0]!.quantity).toBe(70);         // 100 - 30
  });

  test("WITHDRAW with no prior lots → orphan event, no realized side-effects", () => {
    const result = computeCostBasis([
      tx({ type: "withdraw", symbol: "FOO", quantity: 100, timestamp: 1000 }),
    ]);
    expect(result.realizedSales).toHaveLength(0);
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]!.reason).toContain("incomplete");
  });
});

describe("computeCostBasis — chronological ordering", () => {
  test("transactions are processed by timestamp, not input order", () => {
    // Important: callers may shovel transactions in any order. The FIFO
    // ledger correctness depends on chronological processing.
    const result = computeCostBasis([
      tx({ type: "sell", symbol: "X", quantity: 10, price: 5, timestamp: 3000 }),
      tx({ type: "buy", symbol: "X", quantity: 10, price: 1, timestamp: 1000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.realizedPnl).toBeCloseTo(40, 6);   // 10×5 - 10×1 = 40
  });

  test("zero-quantity tx is skipped (no NaN, no orphan)", () => {
    const result = computeCostBasis([
      tx({ type: "buy", symbol: "X", quantity: 0, price: 1, timestamp: 1000 }),
      tx({ type: "sell", symbol: "X", quantity: 0, price: 2, timestamp: 2000 }),
    ]);
    expect(result.realizedSales).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
    expect(result.openLots.size).toBe(0);
  });
});

// ===== Average Cost method (parallel to FIFO above) =====

describe("computeCostBasisAverage — basics", () => {
  test("two buys at different prices → averaged cost", () => {
    const result = computeCostBasisAverage([
      tx({ type: "buy", symbol: "ETH", quantity: 1, price: 1000, timestamp: 1000 }),
      tx({ type: "buy", symbol: "ETH", quantity: 1, price: 2000, timestamp: 2000 }),
      tx({ type: "sell", symbol: "ETH", quantity: 1, price: 3000, timestamp: 3000 }),
    ]);
    expect(result.realizedSales).toHaveLength(1);
    const sale = result.realizedSales[0]!;
    expect(sale.quantity).toBe(1);
    expect(sale.proceeds).toBe(3000);
    // avg cost = (1000 + 2000) / 2 = 1500
    expect(sale.costBasis).toBeCloseTo(1500, 6);
    expect(sale.realizedPnl).toBeCloseTo(1500, 6);
    // Open synthetic lot: 1 ETH at 1500 avg.
    const lots = result.openLots.get("ETH")!;
    expect(lots).toHaveLength(1);
    expect(lots[0]!.quantity).toBeCloseTo(1, 6);
    expect(lots[0]!.pricePerUnit).toBeCloseTo(1500, 6);
    expect(lots[0]!.costBasisKnown).toBe(true);
  });

  test("partial sell preserves average cost on remainder", () => {
    const result = computeCostBasisAverage([
      tx({ type: "buy", symbol: "X", quantity: 2, price: 100, timestamp: 1000 }),
      tx({ type: "buy", symbol: "X", quantity: 2, price: 200, timestamp: 2000 }),
      // avg = 150
      tx({ type: "sell", symbol: "X", quantity: 1, price: 250, timestamp: 3000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.costBasis).toBeCloseTo(150, 6);
    expect(sale.realizedPnl).toBeCloseTo(100, 6);
    // 3 units left, avg still 150.
    const lots = result.openLots.get("X")!;
    expect(lots[0]!.quantity).toBeCloseTo(3, 6);
    expect(lots[0]!.pricePerUnit).toBeCloseTo(150, 6);
  });

  test("withdraw reduces holdings without realizing PnL", () => {
    const result = computeCostBasisAverage([
      tx({ type: "buy", symbol: "X", quantity: 10, price: 5, timestamp: 1000 }),
      tx({ type: "withdraw", symbol: "X", quantity: 3, timestamp: 2000 }),
    ]);
    expect(result.realizedSales).toHaveLength(0);
    expect(result.totals.realizedKnown).toBe(0);
    const lots = result.openLots.get("X")!;
    expect(lots[0]!.quantity).toBeCloseTo(7, 6);
    expect(lots[0]!.pricePerUnit).toBe(5); // avg unchanged
  });
});

describe("computeCostBasisAverage — honest unknown handling", () => {
  test("sell from a deposit-only pool → realizedPnl is null (NOT 0, NOT NaN)", () => {
    // Bulltrapp would silently use $0 cost here and inflate gains. HT must NOT.
    const result = computeCostBasisAverage([
      tx({ type: "deposit", symbol: "USDC", quantity: 100, timestamp: 1000 }),
      tx({ type: "sell", symbol: "USDC", quantity: 50, price: 1.05, timestamp: 2000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.realizedPnl).toBeNull();
    expect(sale.costBasis).toBeNull();
    expect(Number.isNaN(sale.realizedPnl as unknown as number)).toBe(false);
    expect(result.totals.realizedUnknownCount).toBe(1);
  });

  test("mixed pool (priced buy + deposit) taints subsequent sells", () => {
    const result = computeCostBasisAverage([
      tx({ type: "buy", symbol: "X", quantity: 10, price: 5, timestamp: 1000 }),
      tx({ type: "deposit", symbol: "X", quantity: 10, timestamp: 1500 }),
      tx({ type: "sell", symbol: "X", quantity: 5, price: 10, timestamp: 2000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.realizedPnl).toBeNull();
    expect(result.totals.realizedKnown).toBe(0);
    expect(result.totals.realizedUnknownCount).toBe(1);
  });

  test("pool resets to clean after full exit", () => {
    // Deposit → fully sold (with null realized) → fresh buy → fresh sell, NOW priced.
    const result = computeCostBasisAverage([
      tx({ type: "deposit", symbol: "X", quantity: 10, timestamp: 1000 }),
      tx({ type: "sell", symbol: "X", quantity: 10, price: 5, timestamp: 2000 }),     // tainted
      tx({ type: "buy", symbol: "X", quantity: 5, price: 10, timestamp: 3000 }),
      tx({ type: "sell", symbol: "X", quantity: 5, price: 12, timestamp: 4000 }),     // clean
    ]);
    expect(result.realizedSales).toHaveLength(2);
    expect(result.realizedSales[0]!.realizedPnl).toBeNull();
    expect(result.realizedSales[1]!.realizedPnl).toBeCloseTo(10, 6); // 5 × (12 - 10)
    expect(result.totals.realizedKnown).toBeCloseTo(10, 6);
    expect(result.totals.realizedUnknownCount).toBe(1);
  });

  test("orphan sell (no prior pool) → realizedPnl null, sale.quantity = 0", () => {
    const result = computeCostBasisAverage([
      tx({ type: "sell", symbol: "FOO", quantity: 5, price: 100, timestamp: 1000 }),
    ]);
    const sale = result.realizedSales[0]!;
    expect(sale.quantity).toBe(0);
    expect(sale.realizedPnl).toBeNull();
    expect(sale.costBasis).toBeNull();
    expect(result.orphans).toHaveLength(1);
  });
});

describe("computeCostBasisWithMethod dispatcher", () => {
  test("method='fifo' routes to FIFO", () => {
    const txs = [
      tx({ type: "buy", symbol: "X", quantity: 1, price: 100, timestamp: 1000 }),
      tx({ type: "buy", symbol: "X", quantity: 1, price: 200, timestamp: 2000 }),
      tx({ type: "sell", symbol: "X", quantity: 1, price: 250, timestamp: 3000 }),
    ];
    const r = computeCostBasisWithMethod(txs, "fifo");
    // FIFO consumes oldest lot (cost=100), realized = 250 - 100 = 150.
    expect(r.realizedSales[0]!.realizedPnl).toBeCloseTo(150, 6);
  });

  test("method='average' routes to Average Cost", () => {
    const txs = [
      tx({ type: "buy", symbol: "X", quantity: 1, price: 100, timestamp: 1000 }),
      tx({ type: "buy", symbol: "X", quantity: 1, price: 200, timestamp: 2000 }),
      tx({ type: "sell", symbol: "X", quantity: 1, price: 250, timestamp: 3000 }),
    ];
    const r = computeCostBasisWithMethod(txs, "average");
    // Average cost = 150, realized = 250 - 150 = 100.
    expect(r.realizedSales[0]!.realizedPnl).toBeCloseTo(100, 6);
  });
});
