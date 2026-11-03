import type { SymbolConfig } from '../types/domain';

// ============================================================
// Liquidity model — regime-dependent book thinness and how much
// price impact a given notional causes. liquidityShock < 1 means
// books are thin (crisis) which amplifies both slippage and the
// price pressure from order flow.
// ============================================================

export function liquidityShockFor(regime: string, cfg: SymbolConfig): number {
  const byRegime: Record<string, number> = {
    bull: 1.2, chop: 1.0, bear: 0.75, manipulation: 0.85, crisis: 0.35,
  };
  const base = byRegime[regime] ?? 1;
  // small-cap assets have stickier-thin books in stress
  const capFactor = Math.min(1.5, cfg.liquidityDepth / 2_000_000);
  return Math.max(0.2, base * (regime === 'crisis' ? Math.min(1, 0.5 + capFactor * 0.4) : 1));
}

/** Maximum fillable qty at/through a level before price moves a full tick. */
export function levelCapacityUsd(cfg: SymbolConfig): number {
  return cfg.liquidityDepth * 0.08;
}
