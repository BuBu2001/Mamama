import type { AssetId, SymbolConfig } from '../types/domain';
import type { MarketDataProvider, TickQuote } from './market-data-provider';
import { makeRng, rngNormal, Rng } from '../engine/rng';

// ============================================================
// MockProvider — fully offline, deterministic-ish synthetic tick
// feed anchored at configured start prices. Used as the fallback
// for every live adapter and as the default in offline mode.
// (The authoritative sim prices come from SimulationEngine; this
// provider exists so UI/loops can consume a uniform interface.)
// ============================================================

export class MockProvider implements MarketDataProvider {
  name = 'mock';
  private states: { sym: AssetId; px: number; rng: Rng; vol: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private quotes: Map<AssetId, TickQuote> = new Map();

  constructor(seed: string, cfgs: SymbolConfig[]) {
    for (const c of cfgs) {
      this.states.push({ sym: c.id, px: c.startPrice, vol: c.baseVol / Math.sqrt(86_400), rng: makeRng(seed, `mock:${c.id}`) });
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const s of this.states) {
        s.px *= Math.exp(rngNormal(s.rng) * s.vol);
        this.quotes.set(s.sym, { symbol: s.sym, price: s.px, ts: now });
      }
    }, 250);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  getQuotes(): TickQuote[] { return [...this.quotes.values()]; }
  status() { return 'MOCK' as const; }
}
