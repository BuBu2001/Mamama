import Decimal from 'decimal.js';
import type { TaxRecord, Trade, Position } from '../types/domain';
import { D, rawStr } from '../lib/decimal-utils';
import { uid } from './rng';

// ============================================================
// Tax engine — EDUCATIONAL simplification of US rules (IRS-style):
//   * every crypto sale/disposal is a taxable event
//   * holding <= 365 sim-days => short-term (taxed as income,
//     we use a flat educational rate), else long-term (lower rate)
//   * wash-sale rule (simplified): repurchase of same asset within
//     30 sim-days disallows the loss (it rolls into basis later)
//   * staking/lending rewards => ordinary income at receipt
// Taxes are ACCRUED to a ledger but never auto-paid — annual
// report shows what "would be owed". This is not tax advice.
// ============================================================

export const ST_RATE = 0.24;   // simplified short-term marginal rate
export const LT_RATE = 0.15;   // simplified long-term capital gains rate
export const SIM_DAY_TICKS = 86_400; // 100ms tick * ... scaled by clock elsewhere; day length injected

export interface TaxContext {
  tick: number;
  dayTicks: number;      // ticks per sim-day
  recentBuys: { symbol: string; tick: number }[]; // for wash-sale detection
}

/** Create a tax record for a completed SELL fill with known avg cost basis. */
export function onSellFill(
  trade: Trade,
  avgCost: Decimal,
  ctx: TaxContext,
  openedTick: number,
): { record: TaxRecord; estimatedTax: Decimal } {
  const qty = D(trade.qty);
  const proceeds = D(trade.price).mul(qty).minus(D(trade.fee));
  const basis = avgCost.mul(qty);
  const gain = proceeds.minus(basis);
  const holdingDays = Math.max(0, Math.floor((ctx.tick - openedTick) / ctx.dayTicks));
  const shortTerm = holdingDays <= 365;

  const washSale = gain.lt(0) && ctx.recentBuys.some(
    (b) => b.symbol === trade.symbol && ctx.tick - b.tick <= 30 * ctx.dayTicks,
  );

  const category = gain.gte(0)
    ? (shortTerm ? 'SHORT_TERM_GAIN' : 'LONG_TERM_GAIN')
    : (shortTerm ? 'SHORT_TERM_LOSS' : 'LONG_TERM_LOSS');

  const rate = shortTerm ? ST_RATE : LT_RATE;
  const tax = gain.gt(0) ? gain.mul(rate) : D(0);

  const record: TaxRecord = {
    id: uid('tax'),
    tick: ctx.tick,
    taxYear: Math.floor(ctx.tick / (ctx.dayTicks * 365)) + 1,
    category,
    proceeds: rawStr(proceeds),
    costBasis: rawStr(basis),
    gain: rawStr(gain),
    holdingDays,
    sourceTradeId: trade.id,
    symbol: trade.symbol,
    washSaleDisallowed: washSale,
    note: washSale
      ? 'Убыток заблокирован правилом wash sale (упрощённо): покупка того же актива в течение 30 дней.'
      : shortTerm
        ? 'Краткосрочное удержание (< 365 дней) — ставка как для обычного дохода.'
        : 'Долгосрочное удержание — пониженная ставка.',
  };
  return { record, estimatedTax: tax };
}

/** Ordinary income accrual (staking reward etc.). */
export function onIncome(amountUsd: Decimal, source: string, ctx: TaxContext): TaxRecord {
  return {
    id: uid('tax'),
    tick: ctx.tick,
    taxYear: Math.floor(ctx.tick / (ctx.dayTicks * 365)) + 1,
    category: 'ORDINARY_INCOME',
    proceeds: rawStr(amountUsd),
    costBasis: rawStr(D(0)),
    gain: rawStr(amountUsd),
    holdingDays: 0,
    sourceTradeId: '',
    symbol: '',
    note: `Доход от ${source} облагается как обычный доход в момент получения (образовательно).`,
  };
}

export interface AnnualReport {
  taxYear: number;
  shortTermGains: Decimal;
  longTermGains: Decimal;
  shortTermLosses: Decimal; // positive number
  longTermLosses: Decimal;
  ordinaryIncome: Decimal;
  estimatedTax: Decimal;
  netGain: Decimal;
}

/** Aggregate records into a mock annual report (netting per US ordering, simplified). */
export function buildAnnualReport(records: TaxRecord[], year: number): AnnualReport {
  let stg = D(0), ltg = D(0), stl = D(0), ltl = D(0), ord = D(0);
  for (const r of records) {
    if (r.taxYear !== year) continue;
    const g = D(r.gain);
    switch (r.category) {
      case 'SHORT_TERM_GAIN': stg = stg.plus(g); break;
      case 'LONG_TERM_GAIN': ltg = ltg.plus(g); break;
      case 'SHORT_TERM_LOSS': stl = stl.plus(g.abs()); break;
      case 'LONG_TERM_LOSS': ltl = ltl.plus(g.abs()); break;
      case 'ORDINARY_INCOME': case 'STAKING_INCOME': ord = ord.plus(g); break;
      default: break;
    }
  }
  // simplified netting: losses offset gains ST first
  let stNet = stg.minus(stl);
  let ltNet = ltg.minus(ltl);
  if (stNet.lt(0)) { const carry = stNet.abs().min(ltNet.gt(0) ? ltNet : D(0)); ltNet = ltNet.minus(carry); stNet = stNet.plus(carry); }
  if (ltNet.lt(0)) { const carry = ltNet.abs().min(stNet.gt(0) ? stNet : D(0)); stNet = stNet.minus(carry); ltNet = ltNet.plus(carry); }
  const threeK = D(3000);
  const excessLoss = stNet.lt(0) ? Decimal.min(stNet.abs(), threeK) : D(0);
  const tax = (stNet.gt(0) ? stNet.mul(ST_RATE) : D(0))
    .plus(ltNet.gt(0) ? ltNet.mul(LT_RATE) : D(0))
    .plus(ord.mul(ST_RATE))
    .minus(excessLoss.mul(ST_RATE)); // $3k deduction analog
  return {
    taxYear: year,
    shortTermGains: stg, longTermGains: ltg,
    shortTermLosses: stl, longTermLosses: ltl,
    ordinaryIncome: ord,
    estimatedTax: Decimal.max(tax, D(0)),
    netGain: stNet.plus(ltNet).plus(ord).minus(excessLoss),
  };
}
