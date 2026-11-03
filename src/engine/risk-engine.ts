import Decimal from 'decimal.js';
import type { Order, Position } from '../types/domain';
import { D } from '../lib/decimal-utils';

// ============================================================
// Risk engine (MVP scope): portfolio valuation, drawdown,
// simplified parametric VaR, exposure/concentration, and the
// margin/liquidation math used by futures/margin modules.
// Spot positions have no liquidation price => null.
// ============================================================

export interface MarginParams {
  leverage: number;         // e.g. 5x
  maintenanceMarginRate: number; // e.g. 0.005 for low tiers
}

/** Liquidation price for an isolated long perp position. */
export function liquidationPriceLong(entryPx: Decimal, qty: Decimal, marginUsd: Decimal, mmr: number): Decimal | null {
  const notional = entryPx.mul(qty);
  if (notional.lte(0)) return null;
  // liq when unrealized loss eats margin minus maintenance: P_liq = entry * (1 - m/notional + mmr)
  const liq = entryPx.mul(D(1).minus(marginUsd.div(notional)).plus(mmr));
  return liq.gt(0) ? liq : null;
}

export function liquidationPriceShort(entryPx: Decimal, qty: Decimal, marginUsd: Decimal, mmr: number): Decimal | null {
  const notional = entryPx.mul(qty);
  if (notional.lte(0)) return null;
  const liq = entryPx.mul(D(1).plus(marginUsd.div(notional)).minus(mmr));
  return liq.gt(0) ? liq : null;
}

export function initialMarginRequired(notionalUsd: Decimal, leverage: number): Decimal {
  return notionalUsd.div(leverage);
}

export function maintenanceMarginPctFor(notionalUsd: Decimal): number {
  // tiered: bigger positions need more maintenance margin ratio
  const n = notionalUsd.toNumber();
  if (n < 10_000) return 0.005;
  if (n < 100_000) return 0.01;
  if (n < 1_000_000) return 0.02;
  return 0.05;
}

/** Simplified parametric daily VaR at 95% (z=1.645) from weighted asset vols. */
export function simpleVar95(weights: { symbol: string; weight: number; volDaily: number }[], corrAvg = 0.7): number {
  if (weights.length === 0) return 0;
  let varSum = 0;
  for (const w of weights) {
    varSum += w.weight * 1.645 * w.volDaily;
  }
  // naive diversification haircut toward average correlation
  return Math.min(1, varSum * corrAvg + varSum * (1 - corrAvg) / Math.max(1, weights.length));
}

export function maxDrawdownPct(equitySeries: number[]): number {
  let peak = -Infinity, mdd = 0;
  for (const e of equitySeries) {
    if (e > peak) peak = e;
    if (peak > 0) mdd = Math.max(mdd, (peak - e) / peak);
  }
  return mdd * 100;
}

export function sharpeApprox(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : (mean / sd) * Math.sqrt(365); // annualize-ish
}

/** Realized P&L for closing (part of) a spot long position. Fee handled by caller. */
export function realizedPnlOnSell(pos: Position, qty: Decimal, sellNotionalNetOfFee: Decimal): Decimal {
  const cost = D(pos.avgCost).mul(qty);
  return sellNotionalNetOfFee.minus(cost);
}

/** Unrealized P&L of a spot long at current mid. */
export function unrealizedPnl(pos: Position, mid: number): Decimal {
  return D(mid).minus(D(pos.avgCost)).mul(D(pos.qty));
}

/** Does the player actually hold enough base asset to sell? */
export function canSell(pos: Position | undefined, order: Order): boolean {
  if (!pos) return false;
  return D(pos.qty).gte(D(order.qty).minus(D(order.filledQty)));
}
