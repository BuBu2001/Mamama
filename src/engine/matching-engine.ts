import Decimal from 'decimal.js';
import type { Order, Side, SymbolConfig, Trade } from '../types/domain';
import { D, qUsd, rawStr } from '../lib/decimal-utils';
import { estimateSlippage } from './slippage-model';
import { calcFee, FeeSchedule } from './fee-model';
import { uid } from './rng';

// ============================================================
// Matching engine for the player's orders against the synthetic
// book. Simplified price-time priority: MARKET orders walk the
// book levels (partial fills); LIMIT orders fill only when the
// book crosses their price; STOP_LOSS / TAKE_PROFIT become
// market orders once the trigger is touched.
//
// The engine is pure: it returns trades + resulting order state
// and never touches balances directly (the Ledger does that).
// ============================================================

export interface BookSideLevel { price: number; qty: number; }

export interface MatchContext {
  tick: number;
  mid: number;
  bids: BookSideLevel[]; // sorted desc by price
  asks: BookSideLevel[]; // sorted asc by price
  cfg: SymbolConfig;
  sched: FeeSchedule;
  liquidityShock: number;
  reason: string;
}

export interface MatchResult {
  trades: Trade[];
  filledQty: Decimal;      // additional filled this call
  remaining: Decimal;
  status: Order['status'];
  rejectedWhy?: string;
  totalFee: Decimal;
  totalSlipCost: Decimal;
  totalSpreadCost: Decimal;
  avgPrice: Decimal | null;
}

/** Is a resting limit order currently crossable? */
export function limitCrossable(order: Order, mid: number, bids: BookSideLevel[], asks: BookSideLevel[]): boolean {
  const p = Number(order.price);
  if (order.side === 'BUY') return bids.length > 0 && bids[0].price >= p;
  return asks.length > 0 && asks[0].price <= p;
}

/** Trigger check for stop/take-profit on last price. */
export function triggerTouched(order: Order, lastPrice: number): boolean {
  if (!order.triggerPrice) return false;
  const t = Number(order.triggerPrice);
  if (order.type === 'STOP_LOSS') return order.side === 'SELL' ? lastPrice <= t : lastPrice >= t;
  if (order.type === 'TAKE_PROFIT') return order.side === 'SELL' ? lastPrice >= t : lastPrice <= t;
  return false;
}

/**
 * Execute an aggressive (market-like) order by walking book levels.
 * Partial fills are supported; IOC leaves remainder cancelled (caller decides).
 */
export function matchOrder(order: Order, ctx: MatchContext): MatchResult {
  const cfg = ctx.cfg;
  let need = D(order.qty).minus(D(order.filledQty));
  const traded: Trade[] = [];
  let feeTotal = D(0), slipTotal = D(0), spreadTotal = D(0);
  let costNotional = D(0);

  const levels: BookSideLevel[] =
    order.side === 'BUY' ? [...ctx.asks] : [...ctx.bids];

  // Limit orders: cap participation at own price
  if (order.type === 'LIMIT' && order.price != null) {
    const p = Number(order.price);
    const filtered = order.side === 'BUY'
      ? levels.filter((l) => l.price <= p)
      : levels.filter((l) => l.price >= p);
    levels.length = 0;
    levels.push(...filtered);
  }

  // Estimate slippage vs mid for whole residual size (sqrt-impact model),
  // then distribute fills across levels with level prices as bounds.
  const midAtDecision = ctx.mid;
  const notionalEst = need.mul(midAtDecision);
  const slip = estimateSlippage(midAtDecision, notionalEst.toNumber(), cfg, order.side === 'BUY', Math.max(0.25, ctx.liquidityShock));

  let consumedNotional = D(0);
  for (const lvl of levels) {
    if (need.lte(0)) break;
    const avail = D(lvl.qty);
    if (avail.lte(0)) continue;
    const take = Decimal.min(need, avail);
    // Execution price blends level price with impact estimate so bigger
    // sweeps pay worse average — matches the sqrt model at aggregate.
    let execPx = D(lvl.price);
    const fracDone = Decimal.div(consumedNotional, Decimal.max(notionalEst, D(0.01)));
    const impactAdj = D(slip.avgPrice).minus(midAtDecision).mul(fracDone);
    execPx = execPx.plus(impactAdj);
    if (order.side === 'BUY') execPx = Decimal.max(execPx, D(lvl.price));
    else execPx = Decimal.min(execPx, D(lvl.price));

    const px = qUsd(execPx);
    const qty = qUsd(take);
    const fee = qUsd(calcFee(px, qty, false, ctx.sched)); // aggressive => taker
    const slipCost = qUsd(px.minus(midAtDecision).abs().mul(qty));
    const spreadCost = qUsd(
      (order.side === 'BUY'
        ? px.minus(midAtDecision)
        : D(midAtDecision).minus(px)).mul(qty).div(2),
    );

    traded.push({
      id: uid('trd'),
      tick: ctx.tick,
      orderId: order.id,
      symbol: cfg.id,
      side: order.side,
      price: rawStr(px),
      qty: rawStr(qty),
      fee: rawStr(fee),
      feeAsset: 'USD',
      makerRebate: false,
      slippageCost: rawStr(slipCost),
      spreadCost: rawStr(Decimal.max(spreadCost, D(0))),
      reason: ctx.reason,
      eventId: '',
    });

    feeTotal = feeTotal.plus(fee);
    slipTotal = slipTotal.plus(Decimal.max(slipCost, D(0)));
    spreadTotal = spreadTotal.plus(Decimal.max(spreadCost, D(0)));
    costNotional = costNotional.plus(px.mul(qty));
    consumedNotional = consumedNotional.plus(qty.mul(midAtDecision));
    need = need.minus(qty);
  }

  const totalFilled = D(order.qty).minus(need);
  const status: Order['status'] = need.lte(0) ? 'FILLED' : totalFilled.gt(0) ? 'PARTIALLY_FILLED' : 'NEW';
  const avgPrice = totalFilled.gt(0) ? qUsd(costNotional.div(totalFilled)) : null;

  return {
    trades: traded,
    filledQty: totalFilled.minus(order.filledQty),
    remaining: need,
    status,
    totalFee: feeTotal,
    totalSlipCost: slipTotal,
    totalSpreadCost: spreadTotal,
    avgPrice,
  };
}

/** Passive fill for a resting LIMIT order (maker side). */
export function matchMakerFill(order: Order, ctx: MatchContext): MatchResult | null {
  if (order.type !== 'LIMIT' || order.price == null) return null;
  const p = D(order.price);
  const need = D(order.qty).minus(D(order.filledQty));
  if (need.lte(0)) return null;

  // Fill only when book crosses; assume full-touch at own price up to level qty
  const levels = order.side === 'BUY' ? ctx.bids : ctx.asks;
  const best = levels[0];
  if (!best) return null;
  const crossed = order.side === 'BUY' ? best.price >= Number(p) : best.price <= Number(p);
  if (!crossed) return null;

  const avail = D(best.qty);
  const take = Decimal.min(need, avail);
  const fee = qUsd(calcFee(p, take, true, ctx.sched)); // maker fee (lower)
  const trade: Trade = {
    id: uid('trd'),
    tick: ctx.tick,
    orderId: order.id,
    symbol: ctx.cfg.id,
    side: order.side,
    price: rawStr(p),
    qty: rawStr(qUsd(take)),
    fee: rawStr(fee),
    feeAsset: 'USD',
    makerRebate: true,
    slippageCost: rawStr(D(0)),
    spreadCost: rawStr(D(0)),
    reason: ctx.reason,
    eventId: '',
  };
  const newFilled = D(order.filledQty).plus(take);
  return {
    trades: [trade],
    filledQty: take,
    remaining: D(order.qty).minus(newFilled),
    status: newFilled.gte(order.qty) ? 'FILLED' : 'PARTIALLY_FILLED',
    totalFee: fee,
    totalSlipCost: D(0),
    totalSpreadCost: D(0),
    avgPrice: p,
  };
}

export function sideLabel(side: Side): string { return side === 'BUY' ? 'покупка' : 'продажа'; }
