import type { AssetId } from '../types/domain';
import { RestPollProvider, type MarketDataProvider } from './market-data-provider';

// ============================================================
// Live adapters. In the browser, direct calls may be blocked by
// CORS; vite dev proxy maps /api/binance -> api.binance.com.
// Production MVP must not depend on these — CompositeProvider
// falls back to MockProvider automatically.
// ============================================================

const BINANCE_PAIR: Record<AssetId, string> = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', ADA: 'ADAUSDT',
  DOGE: 'DOGEUSDT', LINK: 'LINKUSDT', POL: 'PONUSDT', AVAX: 'AVAXUSDT', DOT: 'DOTUSDT',
  LTC: 'LTCUSDT', BCH: 'BCHUSDT', TRX: 'TRXUSDT', USDT: 'USDCUSDTPairSkip', USDC: 'USDCUSDT',
};

export function createBinanceProvider(symbols: AssetId[]): MarketDataProvider {
  return new RestPollProvider(
    {
      name: 'binance',
      urlFor: () => {
        // single-ticker loop is heavy; use bookTicker multi-symbol endpoint
        const list = symbols.filter((s) => BINANCE_PAIR[s] && !BINANCE_PAIR[s].includes('Skip'));
        const arr = JSON.stringify(list.map((s) => BINANCE_PAIR[s]));
        const base = import.meta.env.DEV ? '/api/binance' : 'https://api.binance.com';
        return `${base}/api/v3/ticker/bookTicker?symbols=${encodeURIComponent(arr)}`;
      },
      parse: (json) => {
        const out: Record<string, number> = {};
        if (!Array.isArray(json)) return out;
        const rev: Record<string, AssetId> = {};
        for (const [k, v] of Object.entries(BINANCE_PAIR)) rev[v] = k;
        for (const row of json as { symbol: string; bidPrice: string; askPrice: string }[]) {
          const sym = rev[row.symbol];
          if (!sym) continue;
          const mid = (Number(row.bidPrice) + Number(row.askPrice)) / 2;
          if (mid > 0) out[sym] = mid;
        }
        return out;
      },
      pollMs: 2500,
    },
    Object.keys(BINANCE_PAIR).filter((s) => symbols.includes(s as AssetId)),
  );
}

/** Coinbase & Kraken adapters: STUB / NEXT PHASE (same RestPollProvider pattern). */
export function createCoinbaseProvider(_symbols: AssetId[]): MarketDataProvider | null {
  return null; // STUB — fallback chain will use mock
}
export function createKrakenProvider(_symbols: AssetId[]): MarketDataProvider | null {
  return null; // STUB — fallback chain will use mock
}
