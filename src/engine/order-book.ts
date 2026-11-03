import type { BookLevel, OrderBookSnapshot, SymbolConfig } from '../types/domain';
import { makeRng, Rng } from './rng';
import { estimateSpreadBps } from './slippage-model';

// ============================================================
// Synthetic order book. It is generated around the current mid
// each tick with deterministic noise, shaped by regime volatility
// and bot flow imbalance. Not a real exchange book.
// ============================================================

const LEVELS = 12;

export class OrderBookEngine {
  private rngs = new Map<string, Rng>();

  constructor(private seed: string) {}

  private rng(symbol: string): Rng {
    let r = this.rngs.get(symbol);
    if (!r) { r = makeRng(this.seed, `book:${symbol}`); this.rngs.set(symbol, r); }
    return r;
  }

  snapshot(cfg: SymbolConfig, mid: number, tick: number, volMult: number, flowImbalance: number): OrderBookSnapshot {
    const rng = this.rng(cfg.id);
    const spreadBps = estimateSpreadBps(cfg, volMult);
    const halfSpread = (mid * spreadBps) / 20_000;
    const bestBid = Math.max(cfg.tickSize, mid - halfSpread);
    const bestAsk = mid + halfSpread;

    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];
    // depth per level decays; flow imbalance thins one side
    for (let i = 0; i < LEVELS; i++) {
      const bp = roundTick(bestBid - i * cfg.tickSize * (1 + i * 0.35), cfg);
      const ap = roundTick(bestAsk + i * cfg.tickSize * (1 + i * 0.35), cfg);
      const baseQty = (cfg.liquidityDepth / cfg.tickSize / mid) * (0.6 + rng() * 0.8) / (i + 1.4);
      const bidQty = Math.max(0, baseQty * (1 - clamp(flowImbalance, -0.8, 0.8)));
      const askQty = Math.max(0, baseQty * (1 + clamp(flowImbalance, -0.8, 0.8)));
      if (bp > 0) bids.push({ price: bp, qty: roundQty(bidQty, cfg) });
      asks.push({ price: ap, qty: roundQty(askQty, cfg) });
    }
    return {
      symbol: cfg.id,
      tick,
      bids,
      asks,
      lastPrice: mid,
      mid,
      spreadBps,
    };
  }

  reset(seed: string): void {
    this.seed = seed;
    this.rngs.clear();
  }
}

export function roundTick(p: number, cfg: SymbolConfig): number {
  const n = Math.round(p / cfg.tickSize) * cfg.tickSize;
  return parseFloat(n.toPrecision(12));
}

function roundQty(q: number, cfg: SymbolConfig): number {
  const n = Math.max(cfg.minLot, Math.round(q / cfg.minLot) * cfg.minLot);
  return parseFloat(n.toPrecision(10));
}

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }
