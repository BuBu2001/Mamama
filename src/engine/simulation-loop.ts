import Decimal from 'decimal.js';
import type {
  AgentMemorySummary, Difficulty, GameEvent, LegalCase, MarketRegime, NewsItem,
  Order, OrderBookSnapshot, PortfolioSnapshot, Position, RiskSnapshot, SaveStateV1,
  SymbolConfig, TaxRecord, Trade, RuntimeSettings, ExplanationCard,
} from '../types/domain';
import { SYMBOLS, SYMBOL_MAP } from '../config/symbols';
import { D, qUsd, rawStr } from '../lib/decimal-utils';
import { Ledger } from './ledger';
import { EventBus, makeGameEvent } from './event-bus';
import { SimClock } from './clock';
import { makeRng, rngChance, uid, Rng } from './rng';
import { PriceState, newPriceState, priceRng, stepPrice } from './price-model';
import { OrderBookEngine } from './order-book';
import { liquidityShockFor } from './liquidity-model';
import { matchOrder, matchMakerFill, triggerTouched, MatchContext } from './matching-engine';
import { feeScheduleFor } from './fee-model';
import { NewsEngine, nextRegime } from './market-engine';
import { onSellFill, TaxContext } from './tax-engine';
import { simpleVar95, maxDrawdownPct } from './risk-engine';
import { AgentHub } from '../agents/agent-hub';

// ============================================================
// SimulationEngine — orchestrates everything. Pure TS, no React.
// UI talks to it via: commands (placeOrder/cancel...) in,
// EventBus + snapshot getters out. All money through Ledger.
// ============================================================

export const START_CASH_USD = '100';
export const DAY_TICKS = 86_400;         // sim seconds per day (clock tick = 1 sim sec)
const TICK_DT_DAYS = 1 / DAY_TICKS;      // each engine tick advances this much market time
const CANDLE_SECONDS = 300;              // 5-minute candles in sim time

export interface EngineSnapshot {
  tick: number;
  clockLabel: string;
  regime: MarketRegime;
  prices: Record<string, number>;
  prevPrices: Record<string, number>;
  cashUsd: string;
  frozenCashUsd: string;
  portfolio: PortfolioSnapshot;
  risk: RiskSnapshot;
  orders: Order[];
  positions: Position[];
  trades: Trade[];
  events: GameEvent[];
  news: NewsItem[];
  taxes: TaxRecord[];
  legalCases: LegalCase[];
  agents: AgentMemorySummary[];
  dataSourceStatus: string;
  speed: number;
  kycLevel: number;
  reputation: number;
  manipulationScore: number;
  volume30dUsd: number;
}

export class SimulationEngine {
  readonly bus = new EventBus();
  readonly clock = new SimClock();
  readonly ledger = new Ledger();
  readonly book: OrderBookEngine;
  readonly newsEngine: NewsEngine;
  readonly agents: AgentHub;

  seed: string;
  difficulty: Difficulty;
  settings: RuntimeSettings;

  regime: MarketRegime = 'chop';
  private regimeRng: Rng;
  private priceStates = new Map<string, PriceState>();
  private prevPrices: Record<string, number> = {};
  prices: Record<string, number> = {};
  candleBuckets: Record<string, { t: number; o: number; h: number; l: number; c: number; v: number }[]> = {};
  books: Record<string, OrderBookSnapshot> = {};

  orders: Order[] = [];
  trades: Trade[] = [];
  positions = new Map<string, Position>();
  events: GameEvent[] = [];
  news: NewsItem[] = [];
  taxes: TaxRecord[] = [];
  legalCases: LegalCase[] = [];
  recentBuys: { symbol: string; tick: number }[] = [];

  frozenCashUsd = D(0);
  reputation = 0;            // -100..100
  manipulationScore = 0;     // 0..100
  kycLevel: 0 | 1 | 2 | 3 = 0;
  volume30dUsd = 0;
  private btcReturn = 0;
  private flowImbalancePerSymbol: Record<string, number> = {};
  private pendingNewsImpulse: Record<string, number> = {};
  private dayStartEquity = D(START_CASH_USD);
  private peakEquity = D(START_CASH_USD);
  private equitySeries: number[] = [100];
  private portfolioHistory: PortfolioSnapshot[] = [];
  private lastDay = 0;
  private hackCooldownTicks = 0;
  private insuranceFundUsd = D(50_000); // simplified protocol insurance fund
  dataSourceStatus: 'LIVE' | 'MOCK' | 'STALE' | 'OFFLINE' = 'MOCK';

  constructor(seed: string, difficulty: Difficulty = 'normal', settings?: Partial<RuntimeSettings>) {
    this.seed = seed;
    this.difficulty = difficulty;
    this.settings = {
      dataSourcePreference: 'mock',
      autosaveSec: 30,
      showEducationalCards: true,
      jurisdiction: 'US',
      soundEnabled: false,
      ...settings,
    };
    this.regimeRng = makeRng(seed, 'regime');
    this.book = new OrderBookEngine(seed);
    this.newsEngine = new NewsEngine(seed);
    this.agents = new AgentHub(seed, difficulty, {
      getPrices: () => this.prices,
      getBooks: () => this.books,
      applyFlow: (sym, imbalance) => { this.flowImbalancePerSymbol[sym] = clampAbs((this.flowImbalancePerSymbol[sym] ?? 0) * 0.7 + imbalance * 0.3, 1); },
      emitEvent: (type, sev, title, msg, expl, data) => this.pushEvent(type, sev, title, msg, expl, data),
      getManipulationScore: () => this.manipulationScore,
      addManipulation: (delta) => { this.manipulationScore = clamp(this.manipulationScore + delta, 0, 100); },
      getReputation: () => this.reputation,
      addReputation: (delta) => this.addReputation(delta),
      freezePlayerCash: (amountUsd, reason) => this.freezeCash(amountUsd, reason),
      openLegalCase: (kind, desc, evidence) => this.openLegalCase(kind, desc, evidence),
      getLedgerBalance: () => this.ledger.getBalance('cash'),
      getPositionsValue: () => this.positionsValue(),
      insuranceFundDeposit: (amt) => { this.insuranceFundUsd = this.insuranceFundUsd.plus(amt); },
    });
    for (const cfg of SYMBOLS) {
      const st = newPriceState(cfg);
      this.priceStates.set(cfg.id, st);
      this.prices[cfg.id] = st.price;
      this.prevPrices[cfg.id] = st.price;
      this.candleBuckets[cfg.id] = [];
    }
    this.ledger.setBalance('cash', D(START_CASH_USD));
    this.pushEvent('SIM_INIT', 'info', 'Симуляция запущена',
      `Стартовый капитал $100. Сид ${seed}. Это учебная песочница: никаких реальных денег и ордеров.`,
      undefined, { seed, difficulty });
  }

  // ---------------- main tick ----------------

  /** Advance exactly one simulation tick. Called N times by the loop. */
  tickOnce(): void {
    const tick = this.clock.tick;

    // 1) regime switch (slow)
    if (tick % 600 === 0 && tick > 0) {
      const prev = this.regime;
      this.regime = nextRegime(this.regime, this.regimeRng);
      if (this.regime !== prev) {
        this.pushEvent('GAME_EVENT', 'info', `Смена режима рынка: ${this.regime}`,
          `Режим «${prev}» → «${this.regime}». Меняются дрейф, волатильность и вероятность прыжков цен.`,
          explainRegime(prev, this.regime));
      }
    }

    // 2) news
    const diffMult = this.difficulty === 'hardcore' ? 1.6 : this.difficulty === 'beginner' ? 0.7 : 1;
    const item = this.newsEngine.maybePublish(tick, this.regime, diffMult);
    if (item) this.publishNews(item);

    // 3) agents act (bots with memory)
    this.agents.step(tick, this.regime);

    // 4) random global hack attempts against the simulated exchange
    this.hackCooldownTicks = Math.max(0, this.hackCooldownTicks - 1);
    if (this.hackCooldownTicks === 0 && rngChance(makeRng(this.seed, `hack:${Math.floor(tick / 3600)}`), 0.000004)) {
      this.rollHackEvent(tick);
    }

    // 5) price steps for all symbols
    let btcRet = 0;
    const volMult = this.regime === 'crisis' ? 2.4 : this.regime === 'bear' || this.regime === 'manipulation' ? 1.5 : this.regime === 'bull' ? 1.1 : 1;
    for (const cfg of SYMBOLS) {
      const st = this.priceStates.get(cfg.id)!;
      const prng = priceRng(this.seed, cfg.id);
      const shock = liquidityShockFor(this.regime, cfg);
      const res = stepPrice(st, prng, {
        cfg, dtDays: TICK_DT_DAYS, regime: this.regime,
        btcReturn: cfg.id === 'BTC' ? 0 : this.btcReturn,
        flowImbalance: this.flowImbalancePerSymbol[cfg.id] ?? 0,
        newsImpulseBps: this.pendingNewsImpulse[cfg.id] ?? 0,
        liquidityShock: shock,
      });
      this.pendingNewsImpulse[cfg.id] = 0;
      const prev = st.price;
      st.price = res.newPrice;
      this.prevPrices[cfg.id] = prev;
      this.prices[cfg.id] = res.newPrice;
      if (cfg.id === 'BTC') btcRet = res.ret;

      // depeg detection for stablecoins
      if (cfg.isStable && Math.abs(res.newPrice - 1) > 0.02) {
        this.pushEvent('DEPEG', 'critical', `${cfg.id} вышел из привязки`,
          `${cfg.id} торгуется по $${res.newPrice.toFixed(4)} вместо $1.00. Причина: ${res.causes.join('; ')}.`,
          explainDepeg(cfg.id, res.newPrice));
      }

      this.updateCandles(cfg.id, res.newPrice, tick);
      this.bus.emit('PRICE_UPDATED', { symbol: cfg.id, price: res.newPrice, prev, reason: res.causes.join('; ') });
    }
    this.btcReturn = btcRet;

    // 6) order books
    for (const cfg of SYMBOLS) {
      this.books[cfg.id] = this.book.snapshot(cfg, this.prices[cfg.id], tick, volMult, this.flowImbalancePerSymbol[cfg.id] ?? 0);
    }

    // 7) order processing: triggers -> resting limit maker fills -> aggressive matching
    this.processOrders(tick);

    // 8) accounting rollups
    this.updateVolumeRollup(tick);
    this.checkNewDay(tick);
    if (tick % 300 === 0) this.recordPortfolioHistory(tick);
    this.agents.maybeOpenInvestigation(tick, () => this.playerWashTradeSuspect());

    // 9) bankruptcy notice (sandbox: no hard game over)
    const snap = this.portfolioSnapshot(tick);
    if (snap.equityUsd !== '0.00' && D(snap.equityUsd).lte(D('0.5'))) {
      if (!this.events.some((e) => e.type === 'GAME_EVENT' && e.title === 'Банкротство')) {
        this.pushEvent('GAME_EVENT', 'critical', 'Банкротство',
          'Капитал практически обнулён. Игра продолжается как песочница: можно перезапустить сейв с новым сидом.',
          explainBankruptcy());
      }
    }

    this.bus.emit('SIMULATION_TICK', { tick });
  }

  // ---------------- orders ----------------

  placeOrder(input: {
    symbol: string; side: 'BUY' | 'SELL'; type: Order['type'];
    qty: string; price?: string | null; trigger?: string | null;
    tif?: 'GTC' | 'IOC'; reason: string;
  }): { ok: boolean; orderId?: string; why?: string } {
    const cfg = SYMBOL_MAP[input.symbol];
    if (!cfg) return { ok: false, why: 'Неизвестный символ' };
    if (this.frozenCashUsd.gt(0) && this.ledger.getBalance('cash').lte(0)) {
      return { ok: false, why: 'Средства заморожены AML-контролем — торговля ограничена.' };
    }
    const qty = D(input.qty);
    if (qty.lt(cfg.minLot)) return { ok: false, why: `Минимальный лот: ${cfg.minLot} ${cfg.id}` };

    const order: Order = {
      id: uid('ord'),
      createdAtTick: this.clock.tick,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      price: input.price ?? null,
      qty: rawStr(qty),
      filledQty: '0.00000000',
      status: 'NEW',
      timeInForce: input.tif ?? 'GTC',
      triggerPrice: input.trigger ?? null,
      reason: input.reason,
    };

    if (input.type === 'LIMIT' && !input.price) return { ok: false, why: 'Limit-ордер требует цену' };
    if ((input.type === 'STOP_LOSS' || input.type === 'TAKE_PROFIT') && !input.trigger) {
      return { ok: false, why: `${input.type} требует цену срабатывания` };
    }
    if (input.side === 'SELL') {
      const pos = this.positions.get(input.symbol);
      if (!pos || D(pos.qty).lt(qty)) return { ok: false, why: `Недостаточно ${input.symbol} для продажи (есть ${pos ? pos.qty : '0'})` };
    }

    this.orders.push(order);
    this.bus.emit('ORDER_CREATED', { orderId: order.id });
    this.pushEvent('ORDER_CREATED', 'info', `Ордер создан: ${input.side} ${input.symbol}`,
      `${input.type} ${qty.toFixed(6)} ${input.symbol}${input.price ? ` @ $${input.price}` : ''}. Причина: ${input.reason}`);

    // Immediate handling for MARKET (and IOC LIMIT crossing)
    if (input.type === 'MARKET' || (input.type === 'LIMIT' && input.tif === 'IOC')) {
      this.tryExecuteAggressive(order, 'немедленное исполнение агрессивного ордера');
      const remaining = D(order.qty).minus(order.filledQty);
      if (remaining.gt(0) && order.timeInForce === 'IOC') {
        this.cancelOrder(order.id, 'IOC: остаток отменён автоматически');
      }
    } else if (input.type === 'LIMIT') {
      // crossable immediately? try maker-style instant fill against book
      this.tryExecuteResting(order);
    }
    return { ok: true, orderId: order.id };
  }

  cancelOrder(orderId: string, reason: string): boolean {
    const o = this.orders.find((x) => x.id === orderId);
    if (!o || o.status === 'FILLED' || o.status === 'CANCELLED') return false;
    o.status = 'CANCELLED';
    this.bus.emit('ORDER_CANCELLED', { orderId });
    this.pushEvent('ORDER_CANCELLED', 'info', 'Ордер отменён', `${reason}`);
    return true;
  }

  private processOrders(tick: number): void {
    for (const o of this.orders) {
      if (o.status === 'FILLED' || o.status === 'CANCELLED' || o.status === 'REJECTED') continue;
      if (o.type === 'STOP_LOSS' || o.type === 'TAKE_PROFIT') {
        if (triggerTouched(o, this.prices[o.symbol])) {
          o.status = 'TRIGGERED';
          this.pushEvent('GAME_EVENT', 'warn', `Сработал ${o.type} ${o.symbol}`,
            `Цена ${this.prices[o.symbol].toFixed(4)} коснулась триггера ${o.triggerPrice}. Ордер исполняется как рыночный.`);
          this.tryExecuteAggressive(o, `${o.type} превращается в рыночный после срабатывания`);
          const rem = D(o.qty).minus(o.filledQty);
          if (rem.lte(0)) o.status = 'FILLED';
        }
        continue;
      }
      if (o.type === 'LIMIT') this.tryExecuteResting(o);
    }
    // GC finished/cancelled occasionally
    if (tick % 3600 === 0) {
      this.orders = this.orders.filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' || o.status === 'TRIGGERED');
    }
  }

  private tryExecuteResting(o: Order): void {
    const ctx = this.matchCtx(o.symbol, `Limit-ордер игрока исполнен как maker (цена ${o.price})`);
    const res = matchMakerFill(o, ctx);
    if (res && res.trades.length > 0) this.applyFill(o, res, ctx.tick);
  }

  private tryExecuteAggressive(o: Order, reason: string): void {
    const ctx = this.matchCtx(o.symbol, reason);
    const res = matchOrder(o, ctx);
    if (res.trades.length > 0) {
      this.applyFill(o, res, ctx.tick);
    } else {
      this.pushEvent('ORDER_REJECTED', 'error', 'Ордер не исполнен',
        `Нет доступной ликвидности для ${o.side} ${o.symbol}. Попробуй меньший объём или limit.`,
        undefined, { orderId: o.id });
      this.bus.emit('ORDER_REJECTED', { orderId: o.id, why: 'no liquidity' });
    }
  }

  private matchCtx(symbol: string, reason: string): MatchContext {
    const cfg = SYMBOL_MAP[symbol];
    const book = this.books[symbol] ?? this.book.snapshot(cfg, this.prices[symbol], this.clock.tick, 1, 0);
    return {
      tick: this.clock.tick,
      mid: this.prices[symbol],
      bids: book.bids,
      asks: book.asks,
      cfg,
      sched: feeScheduleFor(this.volume30dUsd, this.difficulty),
      liquidityShock: liquidityShockFor(this.regime, cfg),
      reason,
    };
  }

  /** Apply a fill result to balances (via Ledger), positions, P&L, taxes. */
  private applyFill(o: Order, res: ReturnType<typeof matchOrder>, tick: number): void {
    const cfg = SYMBOL_MAP[o.symbol];
    let positionOpened = false;
    for (const tr of res.trades) {
      tr.eventId = uid('evt');
      const px = D(tr.price), qty = D(tr.qty), fee = D(tr.fee);
      const notional = px.mul(qty);
      if (o.side === 'BUY') {
        // cash out: notional + fee ; asset in: qty
        this.ledger.applyDelta({ type: 'TRADE_BUY', account: 'cash', amount: qUsd(notional.plus(fee).neg()), reason: `Покупка ${tr.qty} ${cfg.id} по $${px.toFixed(4)} + комиссия $${fee.toFixed(4)}. ${tr.reason}`, tick, tradeId: tr.id, orderId: o.id });
        this.ledger.applyDelta({ type: 'TRADE_BUY', account: `asset:${cfg.id}`, amount: qUsd(qty), reason: `Зачислено ${tr.qty} ${cfg.id}`, tick, tradeId: tr.id });
        const pos = this.getOrCreatePosition(cfg.id, tick);
        const oldQty = D(pos.qty);
        const newQty = oldQty.plus(qty);
        pos.avgCost = rawStr(oldQty.eq(0) ? px.plus(fee.div(qty)) : qUsd(D(pos.avgCost).mul(oldQty).plus(notional.plus(fee)).div(newQty)));
        pos.qty = rawStr(qUsd(newQty));
        if (oldQty.eq(0)) positionOpened = true;
        this.recentBuys.push({ symbol: cfg.id, tick });
        this.volume30dUsd += notional.toNumber();
      } else {
        this.ledger.applyDelta({ type: 'TRADE_SELL', account: `asset:${cfg.id}`, amount: qUsd(qty.neg()), reason: `Продано ${tr.qty} ${cfg.id}`, tick, tradeId: tr.id, orderId: o.id });
        this.ledger.applyDelta({ type: 'TRADE_SELL', account: 'cash', amount: qUsd(notional.minus(fee)), reason: `Выручка $${notional.toFixed(4)} минус комиссия $${fee.toFixed(4)} за продажу ${tr.qty} ${cfg.id}. ${tr.reason}`, tick, tradeId: tr.id });
        const pos = this.positions.get(cfg.id);
        if (pos) {
          const realized = qUsd(px.minus(D(pos.avgCost)).mul(qty).minus(fee));
          pos.realizedPnl = rawStr(D(pos.realizedPnl).plus(realized));
          pos.qty = rawStr(D(pos.qty).minus(qty));
          // tax record (educational accrual only)
          const tctx: TaxContext = { tick, dayTicks: DAY_TICKS, recentBuys: this.recentBuys };
          const { record, estimatedTax } = onSellFill(tr, D(pos.avgCost), tctx, pos.openedTick);
          this.taxes.push(record);
          if (estimatedTax.gt(0)) {
            this.pushEvent('TAX_ACCRUED', 'warn', `Налог начислен (образовательно): ~$${estimatedTax.toFixed(2)}`,
              `Закрыта прибыльная часть позиции ${cfg.id}: прирост ${record.gain} USD, категория ${record.category}. Налог НЕ списывается — это учебный ledger. ${record.note}`,
              explainTax(record, estimatedTax), { recordId: record.id });
            this.bus.emit('TAX_ACCRUED', { recordId: record.id });
          }
          this.volume30dUsd += notional.toNumber();
          if (D(pos.qty).lte(D('0.00000001'))) {
            this.positions.delete(cfg.id);
            this.pushEvent('POSITION_CLOSED', 'info', `Позиция ${cfg.id} закрыта`,
              `Средняя цена $${pos.avgCost}, реализованный P&L $${pos.realizedPnl}.`);
            this.bus.emit('POSITION_CLOSED', { symbol: cfg.id });
          }
        }
      }
      this.trades.push(tr);
      if (this.trades.length > 2000) this.trades.splice(0, 500);
      this.bus.emit('ORDER_FILLED', { tradeId: tr.id, orderId: o.id });
      this.pushEvent('ORDER_FILLED', 'info', `Исполнение: ${tr.side} ${tr.qty} ${tr.symbol} @ $${px.toFixed(4)}`,
        `Комиссия $${tr.fee}, проскальзывание $${tr.slippageCost}, стоимость спреда $${tr.spreadCost}. Причина: ${tr.reason}`,
        explainFill(tr, cfg));
    }
    o.filledQty = rawStr(D(o.filledQty).plus(res.filledQty));
    o.status = res.status;
    if (o.status === 'FILLED') this.bus.emit('ORDER_CANCELLED', { orderId: o.id }); // remove from active lists too
    if (positionOpened) this.bus.emit('POSITION_OPENED', { symbol: o.symbol });
  }

  private getOrCreatePosition(symbol: string, tick: number): Position {
    let p = this.positions.get(symbol);
    if (!p) {
      p = { symbol, qty: '0.00000000', avgCost: '0.00000000', realizedPnl: '0.00000000', openedTick: tick };
      this.positions.set(symbol, p);
    }
    return p;
  }

  // ---------------- events / subsystems ----------------

  publishNews(item: NewsItem): void {
    this.news.unshift(item);
    if (this.news.length > 200) this.news.pop();
    for (const sym of item.affectedSymbols) {
      this.pendingNewsImpulse[sym] = (this.pendingNewsImpulse[sym] ?? 0) + item.impactBps;
    }
    this.bus.emit('NEWS_PUBLISHED', { newsId: item.id });
    this.pushEvent('NEWS_PUBLISHED', 'info', `Новости: ${item.headline}`,
      `${item.body} Затронуты: ${item.affectedSymbols.join(', ')}. Ожидаемый импульс: ${item.impactBps} bps.`);
    // journalists amplify sentiment -> retail bots FOMO/FUD handled inside AgentHub
    this.agents.onNews(item);
  }

  private rollHackEvent(tick: number): void {
    this.hackCooldownTicks = 3600;
    const success = rngChance(makeRng(this.seed, `hackroll:${tick}`), 0.25);
    if (success) {
      const loss = qUsd(Decimal.min(this.ledger.getBalance('cash').mul(0.05), D(50)));
      if (loss.gt(0)) {
        this.ledger.applyDelta({ type: 'HACK_LOSS', account: 'cash', amount: loss.neg(), reason: 'Утечка через фишинговую сессию игрока (симуляционное событие безопасности)', tick });
        this.insuranceFundUsd = this.insuranceFundUsd.plus(loss.mul(0.5));
        this.pushEvent('HACK_ATTEMPT', 'critical', 'Хак инцидент: украдено ~$' + loss.toFixed(2),
          'Биржевой хак затронул счёт. Урок: 2FA, белые списки адресов, лимиты вывода. Частично покрыто insurance fund.',
          explainHack(loss), { success });
      }
    } else {
      this.pushEvent('HACK_ATTEMPT', 'warn', 'Хак-атака отражена', 'Security-скоринг площадки погасил атаку. Вероятность успеха зависит от security score протоколов.', undefined, { success: false });
    }
    this.bus.emit('HACK_ATTEMPT', { success });
  }

  freezeCash(amountUsd: Decimal, reason: string): void {
    const amt = qUsd(Decimal.min(amountUsd, this.ledger.getBalance('cash')));
    if (amt.lte(0)) return;
    this.ledger.applyDelta({ type: 'FREEZE', account: 'cash', amount: amt.neg(), reason: `AML-скоринг превысил порог: ${reason}`, tick: this.clock.tick, legalImpact: 'freeze' });
    this.frozenCashUsd = this.frozenCashUsd.plus(amt);
    this.bus.emit('ACCOUNT_FROZEN', { amountUsd: rawStr(amt) });
    this.pushEvent('ACCOUNT_FROZEN', 'critical', `Заморожено $${amt.toFixed(2)}`,
      `Вывод и часть операций заблокированы: ${reason}. Разморозка возможна после KYC-апгрейда и охлаждения расследования.`,
      explainFreeze(reason));
  }

  unfreezeCash(reason: string): void {
    if (this.frozenCashUsd.lte(0)) return;
    const amt = this.frozenCashUsd;
    this.frozenCashUsd = D(0);
    this.ledger.applyDelta({ type: 'UNFREEZE', account: 'cash', amount: amt, reason: `Расследование завершено: ${reason}`, tick: this.clock.tick });
    this.pushEvent('GAME_EVENT', 'info', `Разморожено $${amt.toFixed(2)}`, reason);
  }

  openLegalCase(kind: LegalCase['kind'], description: string, evidence: number): void {
    if (this.legalCases.some((c) => c.kind === kind && c.status === 'open')) return;
    const c: LegalCase = { id: uid('case'), openedTick: this.clock.tick, kind, status: 'open', description, evidenceScore: evidence };
    this.legalCases.push(c);
    this.bus.emit('REGULATORY_ALERT', { caseId: c.id });
    this.pushEvent('REGULATORY_ALERT', 'critical', `Юридическое дело: ${kind}`,
      `${description} Уровень доказательств: ${evidence}/100. Возможные последствия: штраф, конфискация, бан, «тюрьма» (game-over-like состояние без жёсткого game over).`,
      explainLegalCase(kind));
  }

  resolveLegalCase(caseId: string, outcome: 'fined' | 'dismissed' | 'banned'): void {
    const c = this.legalCases.find((x) => x.id === caseId);
    if (!c || c.status !== 'open') return;
    if (outcome === 'fined') {
      const fine = qUsd(Decimal.min(this.ledger.getBalance('cash').mul(0.3).plus(this.positionsValue().mul(0.1)), D(1000)));
      if (fine.gt(0)) this.ledger.applyDelta({ type: 'PENALTY', account: 'cash', amount: fine.neg(), reason: `Штраф регулятора по делу ${c.kind}`, tick: this.clock.tick, legalImpact: 'fine' });
      c.status = 'fined'; c.penaltyUsd = rawStr(fine);
      this.addReputation(-20);
    } else if (outcome === 'dismissed') {
      c.status = 'dismissed';
      this.manipulationScore = clamp(this.manipulationScore - 30, 0, 100);
    } else {
      c.status = 'banned';
      this.addReputation(-50);
      this.pushEvent('GAME_EVENT', 'critical', 'Аккаунт забанен биржей/регулятором',
        'Доступ к площадкам потерян. Песочница позволяет начать новый сейв — это и есть урок про последствия.');
    }
  }

  addReputation(delta: number): void {
    const before = this.reputation;
    this.reputation = clamp(this.reputation + delta, -100, 100);
    if (before !== this.reputation) {
      this.bus.emit('REPUTATION_CHANGED', { delta: this.reputation - before, total: this.reputation });
      this.pushEvent('REPUTATION_CHANGED', 'info', `Репутация: ${this.reputation}`, `Изменение ${delta > 0 ? '+' : ''}${delta}. Влияет на спреды, лимиты и реакцию ботов.`);
    }
  }

  upgradeKyc(level: 1 | 2 | 3): void {
    if (level <= this.kycLevel) return;
    this.kycLevel = level;
    this.pushEvent('GAME_EVENT', 'info', `KYC уровень ${level}`,
      level === 1 ? 'Email+телефон: базовые лимиты.' : level === 2 ? 'Документ + селфи: повышенные лимиты, ниже AML-фрикции.' : 'Расширенный: институциональные лимиты, разблокировка разморозки.');
    if (level >= 2) this.unfreezeCash('KYC-верификация повышена, риск снижен');
  }

  playerWashTradeSuspect(): boolean {
    // heuristic used by regulator agent: many same-size round-trips recently
    const t = this.trades.slice(-40);
    let pairs = 0;
    for (let i = 1; i < t.length; i++) {
      const a = t[i - 1], b = t[i];
      if (a.symbol === b.symbol && a.side !== b.side && Math.abs(Number(a.qty) - Number(b.qty)) < 1e-6 && b.tick - a.tick < 60) pairs++;
    }
    return pairs >= 3;
  }

  // ---------------- snapshots ----------------

  positionsValue(): Decimal {
    let v = D(0);
    for (const p of this.positions.values()) v = v.plus(D(p.qty).mul(this.prices[p.symbol] ?? 0));
    return qUsd(v);
  }

  portfolioSnapshot(tick: number): PortfolioSnapshot {
    const cash = this.ledger.getBalance('cash');
    const pv = this.positionsValue();
    const equity = qUsd(cash.plus(pv).plus(this.frozenCashUsd));
    const dayPnl = qUsd(equity.minus(this.dayStartEquity));
    const totalPnl = qUsd(equity.minus(D(START_CASH_USD)));
    if (equity.gt(this.peakEquity)) this.peakEquity = equity;
    return {
      tick,
      cashUsd: rawStr(cash),
      positionsValueUsd: rawStr(pv),
      equityUsd: rawStr(equity),
      dayPnlUsd: rawStr(dayPnl),
      totalPnlUsd: rawStr(totalPnl),
      peakEquityUsd: rawStr(this.peakEquity),
    };
  }

  riskSnapshot(tick: number): RiskSnapshot {
    const pf = this.portfolioSnapshot(tick);
    const exposure = this.positionsValue();
    const equity = D(pf.equityUsd);
    const weights = [...this.positions.values()].map((p) => ({
      symbol: p.symbol,
      weight: equity.gt(0) ? D(p.qty).mul(this.prices[p.symbol]).div(equity).toNumber() : 0,
      volDaily: this.priceStates.get(p.symbol)?.vol ?? 0.03,
    }));
    const topConc = weights.reduce((m, w) => Math.max(m, w.weight), 0) * 100;
    return {
      tick,
      equityUsd: pf.equityUsd,
      cashUsd: pf.cashUsd,
      exposureUsd: rawStr(exposure),
      leverage: equity.gt(0) ? exposure.div(equity).toNumber() : 0,
      maxDrawdownPct: maxDrawdownPct(this.equitySeries),
      varDailyPct: simpleVar95(weights) * 100,
      concentrationTopPct: topConc,
      liquidationPrices: [...this.positions.values()].map((p) => ({ symbol: p.symbol, price: null })),
    };
  }

  snapshot(): EngineSnapshot {
    const tick = this.clock.tick;
    this.equitySeries.push(Number(this.portfolioSnapshot(tick).equityUsd));
    if (this.equitySeries.length > 2000) this.equitySeries.splice(0, 1000);
    return {
      tick,
      clockLabel: this.clock.formatSimTime(),
      regime: this.regime,
      prices: { ...this.prices },
      prevPrices: { ...this.prevPrices },
      cashUsd: this.ledger.getBalance('cash').toFixed(8),
      frozenCashUsd: rawStr(this.frozenCashUsd),
      portfolio: this.portfolioSnapshot(tick),
      risk: this.riskSnapshot(tick),
      orders: this.orders.filter((o) => ['NEW', 'PARTIALLY_FILLED', 'TRIGGERED'].includes(o.status)),
      positions: [...this.positions.values()],
      trades: this.trades.slice(-300),
      events: this.events.slice(-200),
      news: this.news.slice(0, 50),
      taxes: this.taxes.slice(-200),
      legalCases: [...this.legalCases],
      agents: this.agents.summaries(),
      dataSourceStatus: this.dataSourceStatus,
      speed: this.clock.speed,
      kycLevel: this.kycLevel,
      reputation: this.reputation,
      manipulationScore: this.manipulationScore,
      volume30dUsd: this.volume30dUsd,
    };
  }

  candles(symbol: string) {
    return (this.candleBuckets[symbol] ?? []).slice(-240);
  }

  orderBook(symbol: string): OrderBookSnapshot | null {
    return this.books[symbol] ?? null;
  }

  private updateCandles(symbol: string, price: number, tick: number) {
    const bucket = Math.floor(tick / CANDLE_SECONDS) * CANDLE_SECONDS;
    const arr = this.candleBuckets[symbol];
    const last = arr[arr.length - 1];
    if (!last || last.t !== bucket) {
      arr.push({ t: bucket, o: price, h: price, l: price, c: price, v: 0 });
      if (arr.length > 400) arr.shift();
    } else {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
      last.v += 0.01; // synthetic baseline volume; real volume added on fills below
    }
  }

  private updateVolumeRollup(tick: number): void {
    // decay 30-day rolling volume slowly so fee tiers can move
    if (tick % 3600 === 0) this.volume30dUsd *= 0.995;
    // add actual traded volume from recent fills into candles
    for (const tr of this.trades.slice(-5)) {
      const arr = this.candleBuckets[tr.symbol];
      const last = arr?.[arr.length - 1];
      if (last) last.v += Number(tr.qty);
    }
  }

  private checkNewDay(tick: number): void {
    const day = Math.floor(tick / DAY_TICKS);
    if (day > this.lastDay) {
      this.lastDay = day;
      this.dayStartEquity = D(this.portfolioSnapshot(tick).equityUsd);
      // daily regulatory decay
      this.manipulationScore = clamp(this.manipulationScore - 2, 0, 100);
      this.agents.dailyStep(tick);
    }
  }

  private recordPortfolioHistory(tick: number): void {
    this.portfolioHistory.push(this.portfolioSnapshot(tick));
    if (this.portfolioHistory.length > 1000) this.portfolioHistory.shift();
  }

  private pushEvent(
    type: GameEvent['type'], severity: GameEvent['severity'],
    title: string, message: string,
    explanation?: ExplanationCard, data?: Record<string, unknown>,
  ): void {
    const ev = makeGameEvent(this.clock.tick, type, severity, title, message, data, explanation);
    this.events.unshift(ev);
    if (this.events.length > 800) this.events.pop();
    this.bus.emit('GAME_EVENT', { event: ev });
  }

  setSpeed(s: number): void { this.clock.setSpeed(s); this.bus.emit('SPEED_CHANGED', { speed: s }); }

  setDataSourceStatus(st: SimulationEngine['dataSourceStatus']): void {
    if (st !== this.dataSourceStatus) {
      this.dataSourceStatus = st;
      this.bus.emit('DATA_SOURCE_CHANGED', { status: st });
      this.pushEvent('DATA_SOURCE_CHANGED', 'info', `Источник данных: ${st}`,
        st === 'LIVE' ? 'Получаем публичные котировки через API/прокси. Цены всё равно симулируются движком поверх внешнего сигнала.'
          : st === 'MOCK' ? 'Работаем на детерминированном mock-провайдере. Игра полностью офлайн.'
            : st === 'STALE' ? 'Данные устарели — переключаемся на mock, но показываем предупреждение.'
              : 'Сеть недоступна — полный офлайн на mock-данных.');
    }
  }

  /** Feed an external live price into the model (overrides drift partially). */
  ingestLivePrice(symbol: string, price: number): void {
    const st = this.priceStates.get(symbol);
    if (!st || !isFinite(price) || price <= 0) return;
    // blend: pull synthetic price toward live anchor gently (causal attribution)
    const blended = st.price * 0.97 + price * 0.03;
    st.price = blended;
  }

  // ---------------- persistence ----------------

  toSave(): SaveStateV1 {
    return {
      version: 1,
      seed: this.seed,
      difficulty: this.difficulty,
      tick: this.clock.tick,
      simTimeMs: this.clock.simTimeMs(),
      speed: this.clock.speed,
      cashUsd: rawStr(this.ledger.getBalance('cash')),
      frozenCashUsd: rawStr(this.frozenCashUsd),
      positions: [...this.positions.values()],
      orders: this.orders,
      trades: this.trades.slice(-1000),
      ledger: this.ledger.entries.slice(-2000),
      events: this.events.slice(-300),
      news: this.news.slice(-100),
      taxes: this.taxes.slice(-500),
      legalCases: this.legalCases,
      prices: { ...this.prices },
      regime: this.regime,
      reputation: this.reputation,
      manipulationScore: this.manipulationScore,
      kycLevel: this.kycLevel,
      agents: this.agents.summaries(),
      candles: Object.fromEntries(SYMBOLS.map((s) => [s.id, this.candles(s.id)])),
      portfolioHistory: this.portfolioHistory.slice(-500),
      dayStartEquityUsd: rawStr(this.dayStartEquity),
      peakEquityUsd: rawStr(this.peakEquity),
      settings: this.settings,
    };
  }

  static fromSave(save: SaveStateV1): SimulationEngine {
    const eng = new SimulationEngine(save.seed, save.difficulty, save.settings);
    eng.clock.tick = save.tick;
    eng.clock.setSpeed(0); // load paused; user resumes
    eng.regime = save.regime;
    eng.reputation = save.reputation;
    eng.manipulationScore = save.manipulationScore;
    eng.kycLevel = save.kycLevel;
    eng.frozenCashUsd = D(save.frozenCashUsd);
    eng.dayStartEquity = D(save.dayStartEquityUsd);
    eng.peakEquity = D(save.peakEquityUsd);
    eng.orders = save.orders;
    eng.trades = save.trades;
    eng.taxes = save.taxes;
    eng.news = save.news;
    eng.legalCases = save.legalCases;
    eng.events = save.events;
    eng.positions = new Map(save.positions.map((p) => [p.symbol, p]));
    for (const [sym, px] of Object.entries(save.prices)) {
      const st = eng.priceStates.get(sym);
      if (st) { st.price = px; eng.prices[sym] = px; eng.prevPrices[sym] = px; }
      if (save.candles[sym]) eng.candleBuckets[sym] = save.candles[sym];
    }
    eng.ledger.loadBalances({ cash: save.cashUsd, ...Object.fromEntries(save.positions.map((p) => [`asset:${p.symbol}`, p.qty])) });
    eng.ledger.loadEntries(save.ledger);
    eng.agents.loadSummaries(save.agents);
    eng.portfolioHistory = save.portfolioHistory;
    eng.pushEvent('GAME_EVENT', 'info', 'Сейв загружен', `tick=${save.tick}, капитал=${save.cashUsd} USD. Симуляция на паузе.`);
    return eng;
  }
}

// ---- helpers & educational cards ----

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }
function clampAbs(v: number, hi: number): number { return clamp(v, -hi, hi); }

function explainRegime(from: MarketRegime, to: MarketRegime): ExplanationCard {
  return {
    what: `Режим рынка сменился: ${from} → ${to}.`,
    why: 'Markov-цепь переключения режимов движка: у каждого режима свои дрейф, волатильность и частота скачков.',
    factors: ['режим рынка', 'дрейф', 'стохастическая волатильность', 'вероятность jumps'],
    costUsd: '0',
    riskNote: 'В кризисе стаканы тонкие: обычные объёмы дают большое проскальзывание.',
    alternative: 'Снизь размер позиций и кредитное плечо при переходе в crisis/bear.',
    terms: [
      { term: 'Regime switching', definition: 'Модель, где рынок находится в дискретных состояниях (бычий/медвежий/кризис) с вероятностями перехода.' },
      { term: 'Волатильность', definition: 'Мера разброса доходностей; здесь σ в годовых/дневных процентах.' },
    ],
  };
}

function explainDepeg(sym: string, px: number): ExplanationCard {
  return {
    what: `${sym} торгуется по ${px.toFixed(4)} USD вместо ожидаемых 1.00.`,
    why: 'Доверие к резервам эмитента подорвано новостями/оттоками; маркет-мейкеры убирают котировки.',
    factors: ['резервы эмитента', 'паника держателей', 'ликвидность стейблкоина'],
    costUsd: '0',
    riskNote: 'Стейблкоин ≠ безрисковый актив. Depeg может быть глубоким и долгим.',
    alternative: 'Держи кэш в нескольких стейблах или в USD-балансе биржи.',
    terms: [{ term: 'Depeg', definition: 'Потеря привязки стейблкоина к 1:1 с базовой валютой.' }],
  };
}

function explainTax(rec: TaxRecord, est: Decimal): ExplanationCard {
  return {
    what: `Начислен налог ~$${est.toFixed(2)} (учебно) с реализации ${rec.symbol}.`,
    why: `Продажа — налогооблагаемое событие. Прирост ${rec.gain} USD, удержание ${rec.holdingDays} дней => ${rec.category}.`,
    factors: ['short-term vs long-term', 'wash sale', 'cost basis', 'комиссии уменьшают выручку'],
    costUsd: rawStr(est),
    riskNote: 'Это образовательный ledger, не налоговая консультация. Реальные правила IRS сложнее.',
    alternative: 'Loss harvesting: зафиксировать убытки дляOffset прибыли (осторожно с wash sale).',
    terms: [
      { term: 'Capital gains', definition: 'Прибыль от продажи актива, облагается налогом.' },
      { term: 'Wash sale', definition: 'Запрет учитывать убыток при покупке того же актива в течение 30 дней (упрощённо).' },
    ],
  };
}

function explainFill(tr: Trade, cfg: SymbolConfig): ExplanationCard | undefined {
  if (Number(tr.slippageCost) < 0.01 && Number(tr.fee) < 0.01) return undefined;
  return {
    what: `Сделка ${tr.side} ${tr.qty} ${tr.symbol}: комиссия $${tr.fee}, slippage $${tr.slippageCost}, спред $${tr.spreadCost}.`,
    why: `Агрессивный ордер выбивал стакан по уровням; impact ≈ sqrt(size/depth) для ${cfg.name}.`,
    factors: ['maker/taker fee', 'spread', 'глубина стакана', 'размер ордера'],
    costUsd: rawStr(D(tr.fee).plus(tr.slippageCost)),
    riskNote: 'Крупные рыночные ордера в тонкий стакан теряют много на исполнении.',
    alternative: 'Используй limit-ордера (maker fee ниже, нет проскальзывания выше цены).',
    terms: [
      { term: 'Slippage', definition: 'Разница между ожидаемой (mid) и фактической ценой исполнения.' },
      { term: 'Spread', definition: 'Разница лучшей bid и ask; её платит тот, кто пересекает стакан.' },
    ],
  };
}

function explainHack(loss: Decimal): ExplanationCard {
  return {
    what: `Инцидент безопасности: потеряно ~$${loss.toFixed(2)}.`,
    why: 'Хакер-агент атакует площадку с вероятностью, обратной security score; часть компенсации — insurance fund.',
    factors: ['security score', 'insurance fund', 'hygiene игрока (2FA, лимиты)'],
    costUsd: rawStr(loss),
    riskNote: 'Кастодиальный риск — реальный класс риска криптобирж (FTX, Mt.Gox).',
    alternative: 'Держи долгосрочно вне биржи (в игре: «холодное хранение» модуля кошелька).',
    terms: [{ term: 'Insurance fund', definition: 'Пулу средств для покрытия дефолтов/ликвидаций.' }],
  };
}

function explainFreeze(reason: string): ExplanationCard {
  return {
    what: 'Часть средств заморожена комплаенсом.',
    why: `AML-скоринг: ${reason}. FinCEN-подобные требования обязывают биржу приостанавливать подозрительные операции.`,
    factors: ['частые крупные конвертации', 'round-trip паттерны', 'низкий KYC'],
    costUsd: '0',
    riskNote: 'Заморозка ограничивает ликвидность именно тогда, когда она нужна.',
    alternative: 'Пройди KYC-2+, снизь подозрительную активность, подай апелляцию в разделе Legal.',
    terms: [
      { term: 'AML', definition: 'Anti-Money Laundering — контроль отмывания денег.' },
      { term: 'KYC', definition: 'Know Your Customer — верификация личности.' },
    ],
  };
}

function explainLegalCase(kind: LegalCase['kind']): ExplanationCard {
  const map: Record<string, string> = {
    MARKET_MANIPULATION: 'SEC/CFTC считают паттерны торгов похожими на pump & dump / spoofing.',
    WASH_TRADE_DETECTED: 'Искусственный объём через самоделки обнаружен surveillance-системой.',
    INSIDER_TRADING: 'Торги по утечке от инсайдера — классическое нарушение Rule 10b-5 (упрощённо).',
    AML_INVESTIGATION: 'Подозрительные потоки средств попали в SAR-отчёт.',
    SANCTIONS_VIOLATION: 'Контрагент из санкционного списка OFAC (симуляционно).',
    TAX_EVASION: 'Расхождения налогового ledger и заявленного дохода.',
    UNLICENSED_OFFERING: 'Запуск токена мог быть незарегистрированной эмиссией (Howey-тест упрощённо).',
  };
  return {
    what: `Открыто дело: ${kind}.`,
    why: map[kind] ?? 'Регулятор-агент инициировал проверку по накопленному manipulation score.',
    factors: ['манипулятивный скоринг', 'паттерны сделок', 'pубличность/PR', 'уровень KYC'],
    costUsd: '0',
    riskNote: 'Штрафы могут достигать 3x прибыли от манипуляции; возможен бан аккаунта.',
    alternative: 'Легальные стратегии: маркет-мейкинг с честными квотами, арбитраж, холд.',
    terms: [
      { term: 'SEC', definition: 'Комиссия по ценным бумагам США.' },
      { term: 'CFTC', definition: 'Комиссия по фьючерсам и опционам США.' },
    ],
  };
}

function explainBankruptcy(): ExplanationCard {
  return {
    what: 'Капитал почти обнулён.',
    why: 'Комисции + спред + слиппедж + неблагоприятные движения съели edge. Без преимущества ожидаемая доходность активных стратегий отрицательна.',
    factors: ['издержки оборота', 'отсутствие edge', 'чрезмерный размер ставок'],
    costUsd: '0',
    riskNote: 'Это главный урок симулятора: высокая активность ≠ высокая прибыль.',
    alternative: 'Меньше трейдов, лимитные ордера, стоп-лоссы, диверсификация, либо долгий холд индексной корзины.',
    terms: [{ term: 'Edge', definition: 'Статистическое преимущество стратегии до издержек.' }],
  };
}
