import type { AgentMemorySummary, Difficulty, LegalCase, MarketRegime, NewsItem } from '../types/domain';
import { makeRng, rngChance, rngPick, Rng } from '../engine/rng';
import Decimal from 'decimal.js';

// ============================================================
// AgentHub — rule-based bots with memory (NO LLM). Each agent:
//   FSM state + own RNG stream + memory of prices/actions/player.
// Agents influence the market through "flow imbalance" and events;
// they never touch the player's ledger directly.
// ============================================================

export interface AgentContext {
  getPrices(): Record<string, number>;
  getBooks(): Record<string, unknown>;
  applyFlow(symbol: string, imbalance: number): void;
  emitEvent(type: string, sev: 'info' | 'warn' | 'error' | 'critical', title: string, msg: string, expl?: unknown, data?: Record<string, unknown>): void;
  getManipulationScore(): number;
  addManipulation(delta: number): void;
  getReputation(): number;
  addReputation(delta: number): void;
  freezePlayerCash(amountUsd: Decimal, reason: string): void;
  openLegalCase(kind: LegalCase['kind'], desc: string, evidence: number): void;
  getLedgerBalance(): Decimal;
  getPositionsValue(): Decimal;
  insuranceFundDeposit(amt: Decimal): void;
}

interface BaseAgent {
  id: string;
  kind: AgentMemorySummary['kind'];
  state: string;
  budgetUsd: number;
  playerRep: number;         // agent's opinion of the player
  lastAction: string;
  cooldownTicks: number;
  memory: number[];          // rolling price history of focus symbol
  focusSymbol: string;
  rng: Rng;
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void;
}

const FOCUS = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'LINK', 'AVAX'];

class RetailBot implements BaseAgent {
  kind = 'retail' as const; state = 'neutral'; playerRep = 0; lastAction = '—'; cooldownTicks = 0;
  memory: number[] = []; momentum = 0;
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `retail:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    const px = ctx.getPrices()[this.focusSymbol] ?? 0;
    this.memory.push(px); if (this.memory.length > 120) this.memory.shift();
    if (this.cooldownTicks > 0) { this.cooldownTicks--; return; }
    // FOMO/FUD: momentum chasing amplified in bull/crisis
    if (this.memory.length > 30) {
      const past = this.memory[this.memory.length - 30];
      const mom = (px - past) / past;
      this.momentum = mom;
      const crowd = Math.tanh(mom * 40) * (regime === 'bull' ? 1.2 : regime === 'crisis' ? 1.5 : 0.8);
      if (Math.abs(crowd) > 0.15) {
        ctx.applyFlow(this.focusSymbol, crowd * 0.35);
        this.state = crowd > 0 ? 'FOMO_buying' : 'FUD_selling';
        this.lastAction = `${crowd > 0 ? 'Массовая скупка' : 'Массовая распродажа'} ${this.focusSymbol} (${(mom * 100).toFixed(1)}% за 30 тиков)`;
        ctx.emitEvent('BOT_ACTION', 'info', 'Retail-боты: стадное поведение', `${this.lastAction}. Причина: импульс цены → FOMO/FUD.`);
        this.cooldownTicks = 120;
      } else this.state = 'neutral';
    }
  }
}

class WhaleBot implements BaseAgent {
  kind = 'whale' as const; state = 'accumulating'; playerRep = 0; lastAction = 'наблюдает'; cooldownTicks = 0;
  memory: number[] = []; positionQty = 0;
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `whale:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    const px = ctx.getPrices()[this.focusSymbol] ?? 0;
    this.memory.push(px); if (this.memory.length > 240) this.memory.shift();
    if (this.cooldownTicks > 0) { this.cooldownTicks--; return; }
    // Accumulate on dips, dump after pumps (mean reversion with size)
    if (this.memory.length >= 120) {
      const avg = this.memory.reduce((a, b) => a + b, 0) / this.memory.length;
      const dev = (px - avg) / avg;
      if (dev < -0.03 && rngChance(this.rng, 0.4)) {
        const notional = this.budgetUsd * 0.25;
        ctx.applyFlow(this.focusSymbol, 0.7);
        this.positionQty += notional / px; this.budgetUsd -= notional;
        this.state = 'buying_dip'; this.lastAction = `Кит купил ~$${notional.toFixed(0)} ${this.focusSymbol} на просадке ${(dev * 100).toFixed(1)}%`;
        ctx.emitEvent('BOT_ACTION', 'warn', 'Действие кита', `${this.lastAction}. Large bid flow толкает цену вверх.`);
        this.cooldownTicks = 600;
      } else if (dev > 0.05 && this.positionQty > 0 && rngChance(this.rng, 0.35)) {
        const sellNotional = Math.min(this.positionQty * px, this.budgetUsd + this.positionQty * px);
        ctx.applyFlow(this.focusSymbol, -0.9);
        this.positionQty *= 0.6; this.budgetUsd += sellNotional * 0.6;
        this.state = 'dumping'; this.lastAction = `Кит продал ~$${sellNotional.toFixed(0)} в тонкий стакан`;
        ctx.emitEvent('BOT_ACTION', 'error', 'Действие кита', `${this.lastAction}. Проскальзывание и цепочка ликвидаций возможны.`);
        this.cooldownTicks = 900;
      }
    }
  }
}

class MarketMakerBot implements BaseAgent {
  kind = 'market_maker' as const; state = 'quoting'; playerRep = 0; lastAction = 'котирует обе стороны'; cooldownTicks = 0;
  memory: number[] = [];
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `mm:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    // MM tightens spread in calm, pulls quotes in volatility spikes
    const px = ctx.getPrices()[this.focusSymbol] ?? 0;
    this.memory.push(px); if (this.memory.length > 60) this.memory.shift();
    if (this.memory.length > 20) {
      const rets = this.memory.slice(1).map((p, i) => Math.abs(Math.log(p / this.memory[i])));
      const rv = rets.reduce((a, b) => a + b, 0) / rets.length;
      if (rv > 0.004) {
        this.state = 'widening_pull';
        this.lastAction = `MM расширил спред и снял часть котировок (realized vol ${(rv * 1e4).toFixed(0)} bps/тик)`;
      } else {
        this.state = 'quoting';
        this.lastAction = 'Сужает спред, собирает maker-комиссии';
      }
    }
  }
}

class HackerBot implements BaseAgent {
  kind = 'hacker' as const; state = 'scanning'; playerRep = 0; lastAction = 'ищет уязвимости'; cooldownTicks = 0;
  memory: number[] = [];
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `hacker:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    if (this.cooldownTicks > 0) { this.cooldownTicks--; return; }
    // Attack probability inversely tied to simulated security score (regime proxy)
    const security = regime === 'crisis' ? 0.35 : 0.75;
    if (rngChance(this.rng, 0.00002 * (1 - security))) {
      const target = rngPick(this.rng, ['DeFi-пул', 'мост', 'NFT-контракт']);
      this.state = 'exploiting';
      this.lastAction = `Эксплойт ${target}: $${(rngPick(this.rng, [5, 20, 120]) * 1e6).toLocaleString()}`;
      ctx.emitEvent('HACK_ATTEMPT', 'critical', 'Хак протокола (событие рынка)',
        `${this.lastAction}. Цена актива падает через news-импульс; риск смарт-контрактов — реальный класс риска DeFi.`);
      ctx.addReputation(-2);
      this.cooldownTicks = 3600;
    }
  }
}

class RegulatorAgent implements BaseAgent {
  kind = 'regulator' as const; state = 'watching'; playerRep = 0; lastAction = 'мониторинг surveillance'; cooldownTicks = 0;
  memory: number[] = []; heat = 0;
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `reg:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    const manip = ctx.getManipulationScore();
    this.heat = manip;
    this.state = manip > 60 ? 'investigating' : 'watching';
    if (manip > 75 && tick % 600 === 0 && this.cooldownTicks === 0) {
      ctx.openLegalCase('MARKET_MANIPULATION',
        'Surveillance-система биржи обнаружила паттерны pump&dump/spoofing в сделках игрока.', Math.round(manip));
      this.lastAction = 'Открыто расследование по манипулированию';
      this.cooldownTicks = 7200;
    }
    if (this.cooldownTicks > 0) this.cooldownTicks--;
  }
}

class JournalistAgent implements BaseAgent {
  kind = 'journalist' as const; state = 'idle'; playerRep = 0; lastAction = 'пишет заметки'; cooldownTicks = 0;
  memory: number[] = [];
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `journo:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    if (this.cooldownTicks > 0) { this.cooldownTicks--; return; }
    const px = ctx.getPrices()[this.focusSymbol] ?? 0;
    this.memory.push(px); if (this.memory.length > 60) this.memory.shift();
    if (this.memory.length > 30) {
      const chg = (px - this.memory[0]) / this.memory[0];
      if (Math.abs(chg) > 0.04 && rngChance(this.rng, 0.02)) {
        const tone = chg > 0 ? 'рали' : 'распродажа';
        ctx.emitEvent('NEWS_PUBLISHED', 'info', `Журналист: «${this.focusSymbol}: ${tone}»`,
          `Публикация усиливает sentiment (${(chg * 100).toFixed(1)}%). Медиа — часть причинно-следственной модели.`);
        this.lastAction = `Статья про ${this.focusSymbol}`;
        this.cooldownTicks = 900;
      }
    }
  }
}

class InsiderAgent implements BaseAgent {
  kind = 'insider' as const; state = 'silent'; playerRep = 0; lastAction = 'нет утечек'; cooldownTicks = 0;
  memory: number[] = [];
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `insider:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    if (this.cooldownTicks > 0) { this.cooldownTicks--; return; }
    if (rngChance(this.rng, 0.00003)) {
      this.state = 'leaked';
      this.lastAction = `Утечка: инсайдерский сигнал по ${this.focusSymbol}`;
      ctx.emitEvent('GAME_EVENT', 'warn', 'Инсайдерская утечка (симуляция)',
        `${this.lastAction}. Игрокам доступна «наводка», но торги по ней повышают legal risk и manipulation score. Реальный insider trading преследуется SEC.`);
      this.cooldownTicks = 7200;
    }
  }
}

class ArbBot implements BaseAgent {
  kind = 'arb' as const; state = 'monitoring'; playerRep = 0; lastAction = 'ищет расхождения'; cooldownTicks = 0;
  memory: number[] = [];
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `arb:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    // Arbitrage dampens flow-induced dislocations: counteracts extreme imbalance slowly
    if (this.cooldownTicks > 0) { this.cooldownTicks--; return; }
    const px = ctx.getPrices()[this.focusSymbol] ?? 0;
    this.memory.push(px); if (this.memory.length > 90) this.memory.shift();
    if (this.memory.length >= 90) {
      const avg = this.memory.reduce((a, b) => a + b, 0) / this.memory.length;
      const dev = (px - avg) / avg;
      if (Math.abs(dev) > 0.02) {
        ctx.applyFlow(this.focusSymbol, -Math.sign(dev) * 0.25);
        this.state = 'arbing';
        this.lastAction = `Арбитраж против отклонения ${(dev * 100).toFixed(1)}% (задержка+комиссии съедают часть edge)`;
        this.cooldownTicks = 300;
      } else this.state = 'monitoring';
    }
  }
}

class LiqHunterBot implements BaseAgent {
  kind = 'liq_hunter' as const; state = 'stalking'; playerRep = 0; lastAction = 'ищет кластеры ликвидаций'; cooldownTicks = 0;
  memory: number[] = [];
  constructor(public id: string, public focusSymbol: string, seed: string, public budgetUsd: number) { this.rng = makeRng(seed, `liq:${id}`); }
  step(tick: number, regime: MarketRegime, ctx: AgentContext): void {
    if (this.cooldownTicks > 0) { this.cooldownTicks--; return; }
    if ((regime === 'crisis' || regime === 'bear') && rngChance(this.rng, 0.0002)) {
      this.state = 'pushing';
      this.lastAction = `Толкнул цену к кластеру ликвидаций ${this.focusSymbol}`;
      ctx.applyFlow(this.focusSymbol, rngChance(this.rng, 0.5) ? -0.6 : 0.6);
      ctx.emitEvent('BOT_ACTION', 'warn', 'Liquidation hunting',
        `${this.lastAction}. Каскады ликвидаций усиливают движение — так работают маржин-колла на деривативных площадках.`);
      this.cooldownTicks = 1800;
    }
  }
}

export class AgentHub {
  private agents: BaseAgent[] = [];
  private difficultyMult: number;

  constructor(private seed: string, difficulty: Difficulty, private ctx: AgentContext) {
    this.difficultyMult = difficulty === 'hardcore' ? 1.5 : difficulty === 'beginner' ? 0.6 : 1;
    let n = 0;
    for (const sym of FOCUS) {
      this.agents.push(new RetailBot(`retail_${sym}_${n++}`, sym, seed, 50_000));
      this.agents.push(new RetailBot(`retail2_${sym}_${n++}`, sym, seed, 30_000));
      this.agents.push(new WhaleBot(`whale_${sym}`, sym, seed, 5_000_000));
      this.agents.push(new MarketMakerBot(`mm_${sym}`, sym, seed, 2_000_000));
      this.agents.push(new ArbBot(`arb_${sym}`, sym, seed, 500_000));
      this.agents.push(new LiqHunterBot(`liq_${sym}`, sym, seed, 1_000_000));
    }
    this.agents.push(new HackerBot('hacker_global', 'ETH', seed, 0));
    this.agents.push(new RegulatorAgent('regulator', 'BTC', seed, 0));
    this.agents.push(new JournalistAgent('journalist', 'BTC', seed, 0));
    this.agents.push(new InsiderAgent('insider', 'SOL', seed, 0));
  }

  step(tick: number, regime: MarketRegime): void {
    // Not every agent acts every tick — stagger by id hash for performance
    for (const a of this.agents) {
      if ((tick + hashStr(a.id)) % 3 !== 0) continue;
      try { a.step(tick, regime, this.ctx); } catch (e) { console.error('[agent]', a.id, e); }
    }
  }

  onNews(item: NewsItem): void {
    // journalists & retail react: amplify sentiment into flow
    const mult = item.sentiment * 0.4 * this.difficultyMult;
    for (const sym of item.affectedSymbols.slice(0, 4)) this.ctx.applyFlow(sym, mult);
  }

  dailyStep(tick: number): void {
    // regulator cools down investigations without new evidence
    if (this.ctx.getManipulationScore() > 0) this.ctx.addManipulation(-1);
  }

  maybeOpenInvestigation(tick: number, washSuspect: () => boolean): void {
    if (washSuspect() && tick % 120 === 0) {
      this.ctx.addManipulation(8);
      this.ctx.emitEvent('WASH_TRADE_DETECTED', 'error', 'Обнаружен подозрительный wash trading',
        'Round-trip сделки одного объёма подряд — классический паттерн накрутки объёма. Surveillance добавил +8 к heat.');
      if (this.ctx.getManipulationScore() > 55) {
        this.ctx.freezePlayerCash(this.ctx.getLedgerBalance().mul(0.2), 'Паттерны самоделок/накрутки объёма');
      }
    }
  }

  summaries(): AgentMemorySummary[] {
    return this.agents.map((a) => ({
      agentId: a.id, kind: a.kind, state: a.state, budgetUsd: a.budgetUsd,
      reputationOfPlayer: a.playerRep, lastAction: a.lastAction, cooldownTicks: a.cooldownTicks,
    }));
  }

  loadSummaries(list: AgentMemorySummary[]): void {
    for (const s of list) {
      const a = this.agents.find((x) => x.id === s.agentId);
      if (a) { a.state = s.state; a.lastAction = s.lastAction; a.cooldownTicks = s.cooldownTicks; a.playerRep = s.reputationOfPlayer; }
    }
  }

  /** Player attempted a shady scheme (pump&dump/wash/etc.) — consequences engine. */
  reportPlayerScheme(kind: 'PUMP_DUMP' | 'WASH' | 'SPOOF' | 'INSIDER'): void {
    const add = kind === 'PUMP_DUMP' ? 15 : kind === 'WASH' ? 12 : kind === 'SPOOF' ? 10 : 20;
    this.ctx.addManipulation(add * this.difficultyMult);
    this.ctx.addReputation(-add / 2);
    this.ctx.emitEvent('MANIPULATION_DETECTED', 'warn', `Последствия схемы: ${kind}`,
      `Манипулятивный скоринг +${add}. Регулятор видит паттерн; при heat>75 открывается дело, при большем уровне — штрафы/заморозки. Схемы даны как игровой урок, не инструкция.`);
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
