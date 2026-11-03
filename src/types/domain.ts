// ============================================================
// Domain types for CryptoSim (educational paper-trading sim).
// Money-critical values are serialized as decimal STRINGS and
// operated on via decimal.js inside the engine. We keep the
// wire/storage format plain-JSON-friendly (no Decimal instances).
// ============================================================

export type AssetId = string; // e.g. 'BTC', 'ETH', 'USDT'
export type QuoteId = 'USD';

export type DataSourceStatus = 'LIVE' | 'MOCK' | 'STALE' | 'OFFLINE';

export type Difficulty = 'beginner' | 'normal' | 'hardcore';

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT';
export type Side = 'BUY' | 'SELL';
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'TRIGGERED' | 'REJECTED';
export type TimeInForce = 'GTC' | 'IOC';

export type FeeTier = 'maker' | 'taker';

export interface SymbolConfig {
  id: AssetId;            // base asset, e.g. BTC
  name: string;           // human name
  startPrice: number;     // USD, initial synthetic price
  baseVol: number;        // daily volatility sigma (fraction)
  driftBpsPerDay: number; // baseline drift in bps/day
  liquidityDepth: number; // USD notional per 1 tick of depth (thin => slippage)
  tickSize: number;       // price tick in USD
  minLot: number;         // minimum order qty in base units
  correlationToBtc: number; // -1..1
  isStable?: boolean;
  color: string;
}

export interface Order {
  id: string;
  createdAtTick: number;
  symbol: AssetId;
  side: Side;
  type: OrderType;
  price: string | null;    // decimal string; null for MARKET
  qty: string;             // decimal string in base units
  filledQty: string;       // decimal string
  status: OrderStatus;
  timeInForce: TimeInForce;
  triggerPrice: string | null; // for SL/TP
  reason: string;              // why this order exists (education / audit)
  note?: string;
}

export interface Trade {
  id: string;
  tick: number;
  orderId: string;
  symbol: AssetId;
  side: Side;
  price: string;      // execution price incl. slippage
  qty: string;
  fee: string;        // quote-denominated fee
  feeAsset: QuoteId;
  makerRebate: boolean;
  slippageCost: string;   // quote cost vs mid at decision
  spreadCost: string;     // quote cost vs mid due to spread
  reason: string;
  eventId: string;
}

export interface Position {
  symbol: AssetId;
  qty: string;                // signed not needed for spot (long-only MVP); kept decimal str
  avgCost: string;            // decimal string USD
  realizedPnl: string;        // lifetime realized pnl (after fees)
  openedTick: number;
}

export type LedgerType =
  | 'DEPOSIT' | 'TRADE_BUY' | 'TRADE_SELL' | 'FEE' | 'SLIPPAGE' | 'SPREAD'
  | 'FUNDING' | 'TAX' | 'PENALTY' | 'SEIZURE' | 'FREEZE' | 'UNFREEZE'
  | 'STAKING_REWARD' | 'LENDER_INTEREST' | 'LIQUIDATION' | 'ADJUSTMENT'
  | 'HACK_LOSS' | 'AIRDROP' | 'WASH';

export interface LedgerEntry {
  id: string;
  tick: number;
  tsReal: number;             // wall-clock ms when recorded (for display)
  type: LedgerType;
  account: 'cash' | `asset:${AssetId}`;
  amount: string;             // signed decimal string
  balanceBefore: string;
  balanceAfter: string;
  reason: string;             // REQUIRED: every movement has a cause
  eventId?: string;
  orderId?: string;
  tradeId?: string;
  taxCategory?: TaxCategory;
  riskImpact?: string;
  legalImpact?: string;
  reputationImpact?: number;
}

export type TaxCategory =
  | 'SHORT_TERM_GAIN' | 'LONG_TERM_GAIN' | 'SHORT_TERM_LOSS' | 'LONG_TERM_LOSS'
  | 'ORDINARY_INCOME' | 'STAKING_INCOME' | 'NFT_GAIN' | 'NONE';

export interface TaxRecord {
  id: string;
  tick: number;
  taxYear: number;
  category: TaxCategory;
  proceeds: string;
  costBasis: string;
  gain: string;         // signed
  holdingDays: number;
  sourceTradeId: string;
  symbol: AssetId;
  washSaleDisallowed?: boolean;
  note: string;
}

export type EventType =
  | 'SIM_INIT' | 'TICK' | 'PRICE_UPDATED' | 'ORDER_CREATED' | 'ORDER_FILLED'
  | 'ORDER_CANCELLED' | 'ORDER_REJECTED' | 'POSITION_OPENED' | 'POSITION_CLOSED'
  | 'LIQUIDATION_TRIGGERED' | 'FEE_CHARGED' | 'TAX_ACCRUED' | 'NEWS_PUBLISHED'
  | 'REGULATORY_ALERT' | 'HACK_ATTEMPT' | 'ACCOUNT_FROZEN' | 'REPUTATION_CHANGED'
  | 'BOT_ACTION' | 'SAVE_COMPLETED' | 'DATA_SOURCE_CHANGED' | 'SPEED_CHANGED'
  | 'GAME_EVENT' | 'MANIPULATION_DETECTED' | 'WASH_TRADE_DETECTED' | 'DEPEG'
  | 'RUG_PULL' | 'INSURANCE_PAYOUT';

export interface GameEvent {
  id: string;
  tick: number;
  tsReal: number;
  type: EventType;
  severity: 'info' | 'warn' | 'error' | 'critical';
  title: string;
  message: string;
  /** Educational card payload */
  explanation?: ExplanationCard;
  data?: Record<string, unknown>;
}

export interface ExplanationCard {
  what: string;
  why: string;
  factors: string[];
  costUsd: string;          // decimal string, may be '0'
  riskNote: string;
  alternative: string;
  terms: { term: string; definition: string }[];
}

export interface NewsItem {
  id: string;
  tick: number;
  headline: string;
  body: string;
  source: string;
  sentiment: number;        // -1..1
  affectedSymbols: AssetId[];
  impactBps: number;        // expected immediate impact on affected symbols
  kind: 'macro' | 'asset' | 'regulatory' | 'hack' | 'manipulation' | 'exchange';
}

export type MarketRegime = 'bull' | 'bear' | 'chop' | 'crisis' | 'manipulation';

export interface Candle {
  t: number;                // sim tick of candle open
  o: number; h: number; l: number; c: number;
  v: number;                // base-unit volume
}

export interface BookLevel {
  price: number;
  qty: number;
}

export interface OrderBookSnapshot {
  symbol: AssetId;
  tick: number;
  bids: BookLevel[];
  asks: BookLevel[];
  lastPrice: number;
  mid: number;
  spreadBps: number;
}

export interface AgentMemorySummary {
  agentId: string;
  kind: 'retail' | 'whale' | 'market_maker' | 'hacker' | 'regulator'
      | 'journalist' | 'insider' | 'arb' | 'liq_hunter';
  state: string;                 // FSM state name
  budgetUsd: number;
  reputationOfPlayer: number;    // -100..100
  lastAction: string;
  cooldownTicks: number;
}

export interface LegalCase {
  id: string;
  openedTick: number;
  kind: 'AML_INVESTIGATION' | 'MARKET_MANIPULATION' | 'INSIDER_TRADING'
      | 'SANCTIONS_VIOLATION' | 'TAX_EVASION' | 'UNLICENSED_OFFERING';
  status: 'open' | 'fined' | 'dismissed' | 'frozen' | 'banned';
  description: string;
  penaltyUsd?: string;
  evidenceScore: number; // 0..100
}

export interface RiskSnapshot {
  tick: number;
  equityUsd: string;
  cashUsd: string;
  exposureUsd: string;
  leverage: number;
  maxDrawdownPct: number;
  varDailyPct: number;      // simplified parametric VaR (95%)
  concentrationTopPct: number;
  liquidationPrices: { symbol: AssetId; price: string | null }[];
}

export interface PortfolioSnapshot {
  tick: number;
  cashUsd: string;
  positionsValueUsd: string;
  equityUsd: string;
  dayPnlUsd: string;
  totalPnlUsd: string;
  peakEquityUsd: string;
}

// ---- Save file ----

export interface SaveStateV1 {
  version: 1;
  seed: string;
  difficulty: Difficulty;
  tick: number;
  simTimeMs: number;
  speed: number;                  // 0 (pause),1,2,4,8,16
  cashUsd: string;
  frozenCashUsd: string;
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  ledger: LedgerEntry[];
  events: GameEvent[];
  news: NewsItem[];
  taxes: TaxRecord[];
  legalCases: LegalCase[];
  prices: Record<AssetId, number>;
  regime: MarketRegime;
  reputation: number;             // -100..100
  manipulationScore: number;      // 0..100 regulator heat
  kycLevel: 0 | 1 | 2 | 3;
  agents: AgentMemorySummary[];
  candles: Record<AssetId, Candle[]>;
  portfolioHistory: PortfolioSnapshot[];
  dayStartEquityUsd: string;
  peakEquityUsd: string;
  settings: RuntimeSettings;
}

export interface RuntimeSettings {
  dataSourcePreference: 'mock' | 'live';
  autosaveSec: number;
  showEducationalCards: boolean;
  jurisdiction: 'US';
  soundEnabled: boolean;
}
