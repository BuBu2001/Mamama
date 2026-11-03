import type { SymbolConfig, MarketRegime } from '../types/domain';
import { makeRng, rngNormal, Rng } from './rng';

// ============================================================
// Price model: causal GBM-like process with
//   - base drift (per-symbol + regime modifier)
//   - stochastic volatility (OU-ish vol-of-vol)
//   - jumps (Poisson; size drawn per event)
//   - news impact (explicit impulses applied by market engine)
//   - order-flow imbalance pressure
//   - BTC correlation transmission
// Every tick's move is attributed to a named cause list so the
// UI can answer "why did the price move?".
// ============================================================

export interface PriceState {
  price: number;
  vol: number;        // current instantaneous daily vol multiplier
  volTarget: number;
}

export interface StepInput {
  cfg: SymbolConfig;
  dtDays: number;              // fraction of day for this tick
  regime: MarketRegime;
  btcReturn: number;           // last period BTC log-return (for correlation)
  flowImbalance: number;       // -1..1 net bot order flow
  newsImpulseBps: number;      // direct impulse this tick
  liquidityShock: number;      // <1 = thin books amplify moves
}

export interface StepResult {
  newPrice: number;
  ret: number;                 // simple return
  causes: string[];            // human-readable attribution
}

const REGIME_DRIFT_BPS: Record<MarketRegime, number> = {
  bull: 25, bear: -30, chop: 0, crisis: -60, manipulation: 10,
};
const REGIME_VOL_MULT: Record<MarketRegime, number> = {
  bull: 1.1, bear: 1.4, chop: 0.8, crisis: 2.6, manipulation: 1.6,
};
const JUMP_PROB_PER_DAY: Record<MarketRegime, number> = {
  bull: 0.9, bear: 1.2, chop: 0.5, crisis: 3.5, manipulation: 1.5,
};

export function stepPrice(
  state: PriceState,
  rng: Rng,
  input: StepInput,
): StepResult {
  const { cfg, dtDays, regime } = input;
  const causes: string[] = [];

  // --- stochastic volatility mean reversion ---
  const volTarget = cfg.baseVol * REGIME_VOL_MULT[regime];
  const kappa = 0.05; // reversion speed per day-fraction scaled below
  state.vol += (volTarget - state.vol) * Math.min(1, kappa * dtDays * 10);
  state.vol *= Math.exp(rngNormal(rng) * 0.02 * Math.sqrt(dtDays * 50)); // vol-of-vol noise
  state.vol = clamp(state.vol, cfg.baseVol * 0.3, cfg.baseVol * 6);

  let mu = (cfg.driftBpsPerDay + REGIME_DRIFT_BPS[regime]) / 10_000;
  if (Math.abs(mu) > 1e-9) causes.push(`дрейф режима «${regime}» + базовый дрейф актива (${(mu * 1e4).toFixed(0)} bps/день)`);

  let sigma = state.vol;
  const diffusion = rngNormal(rng) * sigma * Math.sqrt(dtDays);
  if (diffusion !== 0) causes.push(`случайная волатильность σ=${(sigma * 100).toFixed(1)}%/день`);

  // --- correlated BTC spillover ---
  const corr = cfg.correlationToBtc;
  const spill = corr * input.btcReturn * 0.6;
  if (Math.abs(spill) > 1e-7 && !cfg.isStable) causes.push(`корреляция с BTC (ρ=${corr.toFixed(2)})`);

  // --- order flow pressure ---
  const flowPressure = input.flowImbalance * 0.0006 * (1 / Math.max(0.2, input.liquidityShock));
  if (Math.abs(flowPressure) > 1e-7) causes.push(`перекос потока заявок ботов (${input.flowImbalance >= 0 ? 'покупки' : 'продажи'})`);

  // --- news impulse ---
  const news = input.newsImpulseBps / 10_000;
  if (Math.abs(news) > 1e-9) causes.push(`новость (+${input.newsImpulseBps.toFixed(0)} bps)`);

  // --- jumps ---
  let jump = 0;
  const pJump = JUMP_PROB_PER_DAY[regime] * dtDays;
  if (rng() < pJump) {
    const sign = rng() < 0.5 ? -1 : 1;
    jump = sign * (0.004 + Math.abs(rngNormal(rng)) * sigma * 1.5);
    causes.push(`ценовой скачок (jump ${sign > 0 ? '↑' : '↓'} ${(jump * 100).toFixed(2)}%)`);
  }

  // --- stablecoin depeg anchor pull ---
  if (cfg.isStable) {
    const pegPull = (1.0 - state.price) * 0.02;
    if (Math.abs(pegPull) > 1e-9) causes.push('возврат к привязке $1');
    jump += pegPull;
  }

  const logRet = (mu - 0.5 * sigma * sigma) * dtDays + diffusion + spill + flowPressure + news + jump;
  const newPrice = Math.max(cfg.tickSize * 0.5, state.price * Math.exp(logRet));
  const ret = newPrice / state.price - 1;

  if (causes.length === 0) causes.push('минимальное движение без внешних драйверов');
  return { newPrice, ret, causes };
}

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

export function newPriceState(cfg: SymbolConfig): PriceState {
  return { price: cfg.startPrice, vol: cfg.baseVol, volTarget: cfg.baseVol };
}

export function priceRng(seed: string, symbol: string): Rng {
  return makeRng(seed, `price:${symbol}`);
}
