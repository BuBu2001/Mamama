import type { SymbolConfig } from '../types/domain';

// Real crypto assets used as *simulation entities only* — no real trading.
// Prices are synthetic (seeded) and NOT market prices.
export const SYMBOLS: SymbolConfig[] = [
  { id: 'BTC',  name: 'Bitcoin',        startPrice: 68000,  baseVol: 0.028, driftBpsPerDay: 8,   liquidityDepth: 9_000_000, tickSize: 1,    minLot: 0.0001, correlationToBtc: 1.0,  color: '#f7931a' },
  { id: 'ETH',  name: 'Ethereum',       startPrice: 3500,   baseVol: 0.033, driftBpsPerDay: 6,   liquidityDepth: 5_000_000, tickSize: 0.1,  minLot: 0.001,  correlationToBtc: 0.85, color: '#627eea' },
  { id: 'SOL',  name: 'Solana',         startPrice: 160,    baseVol: 0.048, driftBpsPerDay: 5,   liquidityDepth: 1_800_000, tickSize: 0.01, minLot: 0.01,   correlationToBtc: 0.78, color: '#14f195' },
  { id: 'XRP',  name: 'XRP',            startPrice: 0.52,   baseVol: 0.040, driftBpsPerDay: 1,   liquidityDepth: 1_500_000, tickSize: 0.0001, minLot: 1, correlationToBtc: 0.65, color: '#23292f' },
  { id: 'ADA',  name: 'Cardano',        startPrice: 0.45,   baseVol: 0.045, driftBpsPerDay: 0,   liquidityDepth: 900_000,   tickSize: 0.0001, minLot: 1, correlationToBtc: 0.7,  color: '#0033ad' },
  { id: 'DOGE', name: 'Dogecoin',       startPrice: 0.14,   baseVol: 0.065, driftBpsPerDay: -2,  liquidityDepth: 700_000,   tickSize: 0.0001, minLot: 1, correlationToBtc: 0.55, color: '#c2a633' },
  { id: 'LINK', name: 'Chainlink',      startPrice: 15,     baseVol: 0.042, driftBpsPerDay: 3,   liquidityDepth: 600_000,   tickSize: 0.01,  minLot: 0.1,   correlationToBtc: 0.72, color: '#2a5ada' },
  { id: 'POL',  name: 'Polygon',        startPrice: 0.6,    baseVol: 0.05,  driftBpsPerDay: -1,  liquidityDepth: 500_000,   tickSize: 0.0001,minLot: 1,  correlationToBtc: 0.68, color: '#8247e5' },
  { id: 'AVAX', name: 'Avalanche',      startPrice: 32,     baseVol: 0.05,  driftBpsPerDay: 2,   liquidityDepth: 550_000,   tickSize: 0.01,  minLot: 0.01,  correlationToBtc: 0.74, color: '#e84142' },
  { id: 'DOT',  name: 'Polkadot',       startPrice: 6.5,    baseVol: 0.047, driftBpsPerDay: -1,  liquidityDepth: 400_000,   tickSize: 0.001, minLot: 0.1,   correlationToBtc: 0.7,  color: '#e6007a' },
  { id: 'LTC',  name: 'Litecoin',       startPrice: 82,     baseVol: 0.035, driftBpsPerDay: 1,   liquidityDepth: 450_000,   tickSize: 0.01,  minLot: 0.01,  correlationToBtc: 0.6,  color: '#a6a9aa' },
  { id: 'BCH',  name: 'Bitcoin Cash',   startPrice: 400,    baseVol: 0.04,  driftBpsPerDay: -1,  liquidityDepth: 350_000,   tickSize: 0.01,  minLot: 0.001, correlationToBtc: 0.58, color: '#8dc351' },
  { id: 'TRX',  name: 'TRON',           startPrice: 0.12,   baseVol: 0.038, driftBpsPerDay: 2,   liquidityDepth: 600_000,   tickSize: 0.0001,minLot: 1,  correlationToBtc: 0.4,  color: '#ef0027' },
  { id: 'USDT', name: 'Tether USDT',    startPrice: 1.0,    baseVol: 0.0012,driftBpsPerDay: 0,   liquidityDepth: 20_000_000,tickSize: 0.0001,minLot: 1,  correlationToBtc: 0.0, isStable: true, color: '#26a17b' },
  { id: 'USDC', name: 'Circle USDC',    startPrice: 1.0,    baseVol: 0.001, driftBpsPerDay: 0,   liquidityDepth: 15_000_000,tickSize: 0.0001,minLot: 1,  correlationToBtc: 0.0, isStable: true, color: '#2775ca' },
];

export const SYMBOL_MAP: Record<string, SymbolConfig> = Object.fromEntries(
  SYMBOLS.map((s) => [s.id, s]),
);

export const TRADEABLE_SYMBOLS = SYMBOLS.filter((s) => !s.isStable).map((s) => s.id);
