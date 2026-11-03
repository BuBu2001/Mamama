import type { SymbolConfig } from '../types/domain';
import Decimal from 'decimal.js';
import { D } from '../lib/decimal-utils';

// ============================================================
// Fee model — maker/taker tiers by volume notional, VIP-like
// ladder. Fees are quoted-denominated (USD). Beginner mode gets
// a discount (educational ramp-up); hardcore pays full + surcharge.
// ============================================================

export interface FeeSchedule {
  makerBps: number;
  takerBps: number;
}

const TIERS: { minNotional: number; makerBps: number; takerBps: number }[] = [
  { minNotional: 0,          makerBps: 25, takerBps: 40 },   // base: 0.25% / 0.40%
  { minNotional: 10_000,     makerBps: 20, takerBps: 35 },
  { minNotional: 100_000,    makerBps: 15, takerBps: 30 },
  { minNotional: 1_000_000,  makerBps: 10, takerBps: 25 },
  { minNotional: 10_000_000, makerBps: 5,  takerBps: 20 },
];

export function feeScheduleFor(volumeUsd: number, difficulty: 'beginner' | 'normal' | 'hardcore'): FeeSchedule {
  let t = TIERS[0];
  for (const tier of TIERS) if (volumeUsd >= tier.minNotional) t = tier;
  const mult = difficulty === 'beginner' ? 0.6 : difficulty === 'hardcore' ? 1.25 : 1.0;
  return { makerBps: t.makerBps * mult, takerBps: t.takerBps * mult };
}

/** Compute USD fee for a fill. LIMIT resting fills => maker; MARKET & liquidity-taking => taker. */
export function calcFee(price: Decimal, qty: Decimal, isMaker: boolean, sched: FeeSchedule): Decimal {
  const bps = isMaker ? sched.makerBps : sched.takerBps;
  return price.mul(qty).mul(new Decimal(bps).div(10_000));
}

export const WITHDRAWAL_FEE_USD = 5;        // simulated
export const STAKING_APY = 0.035;           // educational nominal
export const LEND_APY = 0.02;
