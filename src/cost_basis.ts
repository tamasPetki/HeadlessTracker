// Generic FIFO cost basis tracker over a Transaction[] stream.
//
// Used by:
//   - v0.8 #4: MetaMask on-chain history → unrealized PnL for tokens born
//     on-chain (LP rewards, swaps, native airdrops). Most ERC-20 transfers
//     have NO price information — those become "unknown cost basis" lots,
//     and any SELL consuming them produces a null realized PnL (not zero,
//     not NaN — explicit unknown).
//   - v0.8 #5: Polymarket realized PnL from /trades. Trades have prices,
//     so cost basis is fully known; the orphan-SELL path is unused.
//
// Key correctness invariants (regression-tested in test/cost_basis.test.ts):
//   1. SELL before any BUY → orphan, realized PnL = null, NEVER NaN.
//   2. Partial SELL of a multi-lot position consumes oldest lot first.
//   3. Lot with costBasisKnown=false (e.g. MetaMask deposit) propagates
//      "unknown" through any SELL that consumes it, even partially.
//   4. WITHDRAW (transfer-out to another wallet you own) reduces lot
//      quantity but does NOT realize a gain.
//
// Cross-venue cost basis (CEX-bought tokens transferred to a MetaMask wallet)
// is explicitly out of scope — the deposit/withdraw events on the two sides
// can't be matched without venue-aware heuristics. Phase 2+ work.

import type { Transaction } from "./types.ts";

export interface Lot {
  symbol: string;
  quantity: number;             // remaining (after partial consumption)
  pricePerUnit: number;         // 0 if costBasisKnown=false
  costBasisKnown: boolean;      // true if this lot came from a priced BUY/TRADE
  acquiredAt: number;           // epoch ms (FIFO ordering key)
  sourceTxId: string;
}

export interface RealizedSale {
  symbol: string;
  quantity: number;
  proceeds: number;             // sale price × quantity
  costBasis: number | null;     // null if any consumed lot lacked a known cost
  realizedPnl: number | null;   // null when costBasis is null
  timestamp: number;
  sourceTxId: string;
}

export interface OrphanEvent {
  symbol: string;
  quantity: number;
  reason: string;               // human-readable, surfaced to the user
  timestamp: number;
  sourceTxId: string;
}

export interface CostBasisResult {
  openLots: Map<string, Lot[]>;            // keyed by symbol; lots in FIFO order (oldest first)
  realizedSales: RealizedSale[];
  orphans: OrphanEvent[];
  totals: {
    realizedKnown: number;                  // sum of realized PnL where cost basis was known
    realizedUnknownCount: number;           // sales that produced null realized
    orphanCount: number;
  };
}

// Process transactions in chronological order. The caller can pre-filter
// by accountId or symbol if scoping is needed; this function makes no
// per-account assumptions — it computes one global FIFO ledger.
export function computeCostBasis(transactions: Transaction[]): CostBasisResult {
  const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  const lots = new Map<string, Lot[]>();
  const realizedSales: RealizedSale[] = [];
  const orphans: OrphanEvent[] = [];
  let realizedKnown = 0;
  let realizedUnknownCount = 0;

  for (const tx of sorted) {
    const symbol = tx.symbol;
    if (!symbol) continue;
    const qty = tx.quantity;
    if (qty === undefined || qty <= 0) continue;

    switch (tx.type) {
      case "buy":
      case "trade": {
        // Acquisition with a known price — high-confidence lot.
        if (tx.price === undefined || !Number.isFinite(tx.price) || tx.price < 0) {
          // Price-missing buy: treat as unknown cost rather than fabricating one.
          addLot(lots, {
            symbol, quantity: qty, pricePerUnit: 0,
            costBasisKnown: false, acquiredAt: tx.timestamp, sourceTxId: tx.txId,
          });
        } else {
          addLot(lots, {
            symbol, quantity: qty, pricePerUnit: tx.price,
            costBasisKnown: true, acquiredAt: tx.timestamp, sourceTxId: tx.txId,
          });
        }
        break;
      }
      case "deposit":
      case "transfer":
      case "reward":
      case "interest": {
        // Acquisition with unknown cost basis. Includes:
        //   - on-chain ERC-20 transfer in (sender wallet unknown)
        //   - airdrop / staking reward / interest accrual
        //   - CEX deposit (came from another venue, cost not propagated)
        // Lots get costBasisKnown=false; any SELL consuming them propagates "unknown".
        addLot(lots, {
          symbol, quantity: qty, pricePerUnit: 0,
          costBasisKnown: false, acquiredAt: tx.timestamp, sourceTxId: tx.txId,
        });
        break;
      }
      case "sell": {
        // Disposal at a known price — realize gain (or unknown if any consumed
        // lot lacked a cost). Price MUST be present for a sell; if not, treat
        // as orphan (unusual, but defensive).
        if (tx.price === undefined || !Number.isFinite(tx.price) || tx.price < 0) {
          orphans.push({
            symbol, quantity: qty,
            reason: "sell event missing price",
            timestamp: tx.timestamp, sourceTxId: tx.txId,
          });
          break;
        }
        const sale = consumeLots(lots, symbol, qty, tx.price, tx.timestamp, tx.txId);
        realizedSales.push(sale);
        if (sale.realizedPnl !== null) {
          realizedKnown += sale.realizedPnl;
        } else {
          realizedUnknownCount++;
        }
        // If we couldn't satisfy the full quantity (orphan portion), we add an orphan.
        if (sale.quantity < qty) {
          orphans.push({
            symbol, quantity: qty - sale.quantity,
            reason: "sell exceeds known lot history (no prior BUY/DEPOSIT)",
            timestamp: tx.timestamp, sourceTxId: tx.txId,
          });
        }
        break;
      }
      case "withdraw": {
        // Outbound transfer to another wallet you own. Reduces lot quantity
        // (FIFO) but does NOT realize a gain. If we have no lots, treat as
        // an orphan informational event so the user knows their tx history
        // is incomplete.
        const consumed = consumeLotsForWithdraw(lots, symbol, qty);
        if (consumed < qty) {
          orphans.push({
            symbol, quantity: qty - consumed,
            reason: "withdraw exceeds known lot history (incomplete tx history)",
            timestamp: tx.timestamp, sourceTxId: tx.txId,
          });
        }
        break;
      }
      case "fee":
      case "resolve":
        // Fees and prediction-market resolutions don't move the cost basis ledger
        // for V0. (Resolutions could in theory zero-out a position, but the
        // Polymarket connector emits BUY/SELL trades for that path.)
        break;
    }
  }

  return {
    openLots: lots,
    realizedSales,
    orphans,
    totals: {
      realizedKnown,
      realizedUnknownCount,
      orphanCount: orphans.length,
    },
  };
}

function addLot(lots: Map<string, Lot[]>, lot: Lot): void {
  const list = lots.get(lot.symbol) ?? [];
  list.push(lot);
  lots.set(lot.symbol, list);
}

// FIFO consumption for a SELL. Returns a RealizedSale whose `costBasis` /
// `realizedPnl` are null if any consumed lot lacked a known cost basis.
function consumeLots(
  lots: Map<string, Lot[]>,
  symbol: string,
  desiredQty: number,
  salePrice: number,
  timestamp: number,
  sourceTxId: string
): RealizedSale {
  const list = lots.get(symbol) ?? [];
  let remaining = desiredQty;
  let costBasis = 0;
  let anyUnknown = false;
  let consumedQty = 0;

  while (remaining > 0 && list.length > 0) {
    const lot = list[0]!;
    const take = Math.min(lot.quantity, remaining);
    if (!lot.costBasisKnown) anyUnknown = true;
    costBasis += take * lot.pricePerUnit;       // 0 contribution when unknown, but we tag anyUnknown above
    lot.quantity -= take;
    remaining -= take;
    consumedQty += take;
    if (lot.quantity <= 1e-12) {
      list.shift();                              // lot fully consumed
    }
  }

  if (list.length === 0) lots.delete(symbol);
  else lots.set(symbol, list);

  const proceeds = salePrice * consumedQty;
  // Edge: zero-consumed sale (pure orphan) — null is honest. Treating it as
  // costBasis=0 / realizedPnl=0 would lie about a position we never had.
  const finalCost = consumedQty === 0 || anyUnknown ? null : costBasis;
  const realizedPnl = finalCost === null ? null : proceeds - finalCost;
  return { symbol, quantity: consumedQty, proceeds, costBasis: finalCost, realizedPnl, timestamp, sourceTxId };
}

// FIFO consumption for a WITHDRAW. Same lot reduction logic but no realized PnL.
// Returns the actual quantity consumed (may be less than requested if history
// is incomplete).
function consumeLotsForWithdraw(lots: Map<string, Lot[]>, symbol: string, desiredQty: number): number {
  const list = lots.get(symbol) ?? [];
  let remaining = desiredQty;
  let consumed = 0;

  while (remaining > 0 && list.length > 0) {
    const lot = list[0]!;
    const take = Math.min(lot.quantity, remaining);
    lot.quantity -= take;
    remaining -= take;
    consumed += take;
    if (lot.quantity <= 1e-12) {
      list.shift();
    }
  }

  if (list.length === 0) lots.delete(symbol);
  else lots.set(symbol, list);
  return consumed;
}
