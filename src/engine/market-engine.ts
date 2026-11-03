import type { NewsItem, MarketRegime } from '../types/domain';
import { makeRng, rngChance, rngPick, rngUniform, Rng } from './rng';
import { uid } from './rng';

// ============================================================
// News / regime engine. News items are CAUSES: each carries the
// affected symbols and an impact in bps that the market engine
// applies as an impulse. Regime switching is a Markov chain with
// difficulty-dependent transition probabilities.
// ============================================================

interface NewsTemplate {
  kind: NewsItem['kind'];
  headline: string;
  body: string;
  sentiment: number;      // -1..1
  impactBps: number;      // magnitude applied to affected symbols (sign = sentiment)
  targets: 'ALL' | 'BTC' | 'ETH' | 'ALTS' | 'STABLES' | 'ONE';
}

const TEMPLATES: NewsTemplate[] = [
  { kind: 'macro', headline: 'ФРС сохранила ставку без изменений', body: 'Рынок воспринял решение как нейтрально-позитивный для рисковых активов.', sentiment: 0.4, impactBps: 60, targets: 'ALL' },
  { kind: 'macro', headline: 'Инфляция выше ожиданий', body: 'Данные CPI превзошли консенсус; ожидания более жёсткой политики давят на рисковые активы.', sentiment: -0.5, impactBps: 90, targets: 'ALL' },
  { kind: 'macro', headline: 'ETF на биткоин привлек рекордный приток', body: 'Оптимизм вокруг спотовых ETF поддерживает спрос на BTC и рынок в целом.', sentiment: 0.7, impactBps: 140, targets: 'BTC' },
  { kind: 'regulatory', headline: 'SEC ужесточает требования к биржам', body: 'Регулятор требует лицензирования и разделения клиентских средств. Негатив для сентимента.', sentiment: -0.4, impactBps: 70, targets: 'ALL' },
  { kind: 'regulatory', headline: 'Clearsong-подобный закон принят', body: 'Ясные правила хранения улучшают доступ институционалов — мягкий позитив.', sentiment: 0.3, impactBps: 45, targets: 'ALL' },
  { kind: 'asset', headline: 'Крупное обновление сети Ethereum успешно', body: 'Апгрейд прошёл без сбоев; комиссии снижаются.', sentiment: 0.5, impactBps: 110, targets: 'ETH' },
  { kind: 'hack', headline: 'Взлом DeFi-протокола: украдено $200M', body: 'Эксплойт переписов повторного входа. Отток из альткоинов, рост премии за риск.', sentiment: -0.8, impactBps: 160, targets: 'ALTS' },
  { kind: 'exchange', headline: 'Биржа приостановила вывод средств', body: 'Проблемы ликвидности у централизованной площадки пугают рынок.', sentiment: -0.9, impactBps: 220, targets: 'ALL' },
  { kind: 'manipulation', headline: 'Анонимный «кит» накачал мемкоин', body: 'Подозрительный объём и pump & dump схема. Регуляторы наблюдают.', sentiment: 0.15, impactBps: 120, targets: 'ONE' },
  { kind: 'asset', headline: 'Halving близко: майнеры сокращают продажи', body: 'Снижение эмиссии исторически поддерживает BTC.', sentiment: 0.35, impactBps: 55, targets: 'BTC' },
  { kind: 'hack', headline: 'Stablecoin потерял привязку на час', body: 'USDT кратко торговался ниже паритета из-за массового выкупа маркет-мейкерами.', sentiment: -0.6, impactBps: 40, targets: 'STABLES' },
  { kind: 'macro', headline: 'Сильный доллар давит на крипторынок', body: 'Укрепление DXY снижает аппетит к риску.', sentiment: -0.35, impactBps: 65, targets: 'ALL' },
];

export class NewsEngine {
  private rng: Rng;
  constructor(seed: string) { this.rng = makeRng(seed, 'news'); }

  /** Probability of a news item per sim-minute, regime-aware. */
  maybePublish(tick: number, regime: MarketRegime, difficultyMult: number): NewsItem | null {
    const pPerTick = 0.00004 * difficultyMult * (regime === 'crisis' ? 3 : regime === 'bull' ? 1.3 : 1);
    if (!rngChance(this.rng, pPerTick)) return null;
    const t = rngPick(this.rng, TEMPLATES);
    const symbols = resolveTargets(t.targets, this.rng);
    const jitter = rngUniform(this.rng, 0.7, 1.3);
    return {
      id: uid('news'),
      tick,
      headline: t.headline,
      body: t.body,
      source: rngPick(this.rng, ['CoinDesk', 'The Block', 'Bloomberg Crypto', 'Reuters', 'CryptoTwitter']),
      sentiment: clamp(t.sentiment * jitter, -1, 1),
      affectedSymbols: symbols,
      impactBps: Math.round(t.impactBps * jitter * Math.sign(t.sentiment || 1)),
      kind: t.kind,
    };
  }

  /** Deterministic fast-forward helper for tests/replay. */
  force(tick: number, idx: number, symbols: string[]): NewsItem {
    const t = TEMPLATES[idx % TEMPLATES.length];
    return {
      id: uid('news'), tick, headline: t.headline, body: t.body, source: 'TestFeed',
      sentiment: t.sentiment, affectedSymbols: symbols,
      impactBps: Math.round(t.impactBps * Math.sign(t.sentiment || 1)), kind: t.kind,
    };
  }
}

function resolveTargets(kind: NewsTemplate['targets'], rng: Rng): string[] {
  switch (kind) {
    case 'ALL': return ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'LINK', 'AVAX'];
    case 'BTC': return ['BTC'];
    case 'ETH': return ['ETH'];
    case 'ALTS': return ['SOL', 'ADA', 'DOGE', 'LINK', 'AVAX', 'DOT', 'POL'];
    case 'STABLES': return ['USDT', 'USDC'];
    case 'ONE': return [rngPick(rng, ['DOGE', 'SOL', 'ADA', 'POL'])];
  }
}

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)); }

// ---- Regime Markov chain ----

const TRANSITIONS: Record<MarketRegime, [MarketRegime, number][]> = {
  bull:         [['bull', 0.985], ['chop', 0.01], ['bear', 0.004], ['crisis', 0.001]],
  bear:         [['bear', 0.98], ['chop', 0.012], ['bull', 0.005], ['crisis', 0.003]],
  chop:         [['chop', 0.97], ['bull', 0.015], ['bear', 0.012], ['manipulation', 0.003]],
  crisis:       [['crisis', 0.9], ['bear', 0.06], ['chop', 0.03], ['bull', 0.01]],
  manipulation: [['manipulation', 0.93], ['chop', 0.04], ['bear', 0.02], ['crisis', 0.01]],
};

export function nextRegime(cur: MarketRegime, rng: Rng): MarketRegime {
  const r = rng();
  let acc = 0;
  for (const [state, p] of TRANSITIONS[cur]) {
    acc += p;
    if (r <= acc) return state;
  }
  return cur;
}

export const REGIME_LABEL_RU: Record<MarketRegime, string> = {
  bull: 'Бычий рынок', bear: 'Медвежий рынок', chop: 'Флэт', crisis: 'Кризис', manipulation: 'Манипуляции',
};
