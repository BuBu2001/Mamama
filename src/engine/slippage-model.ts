import type { SymbolConfig } from '../types/domain';

// ============================================================
// Slippage model — walks synthetic depth. Cost grows with the
// square root of (order notional / book depth), a common market
// microstructure approximation, plus linear impact for very
// large orders. Thin books (small liquidityDepth) => big slip.
// ============================================================

export interface SlippageResult {
  /** average execution price given mid & side */
  avgPrice: number;
  /** bps of slippage vs mid */
  slipBps: number;
}

/**
 * @param mid        current mid price
 * @param notionalUsd order size in USD
 * @param cfg        symbol config (depth per tick)
 * @param buy        direction (buys push up, sells push down)
 * @param thinFactor extra illiquidity multiplier (crisis/regime)
 */
export function estimateSlippage(
  mid: number,
  notionalUsd: number,
  cfg: SymbolConfig,
  buy: boolean,
  thinFactor = 1,
): SlippageResult {
  if (notionalUsd <= 0 || mid <= 0) return { avgPrice: mid, slipBps: 0 };
  const ratio = notionalUsd / (cfg.liquidityDepth * thinFactor);
  // sqrt impact ~ k*sqrt(ratio), k tuned so $9M order on BTC (~depth) slips ~70bps
  const slipFrac = Math.min(0.25, 0.07 * Math.sqrt(ratio) + 0.35 * ratio * ratio);
  const slipBps = slipFrac * 10_000;
  const avgPrice = buy ? mid * (1 + slipFrac) : mid * (1 - slipFrac);
  return { avgPrice, slipBps };
}

/** Spread model: wider in vol/crisis, tighter for deep majors. */
export function estimateSpreadBps(cfg: SymbolConfig, volMult: number): number {
  const base = cfg.isStable ? 1 : 4 + (2_000_000 / cfg.liquidityDepth);
  return base * volMult;
}
