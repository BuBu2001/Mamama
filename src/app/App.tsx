import { useEffect, useMemo, useState } from 'react';
import { useUiStore, type Screen } from '../store';
import { SimulationEngine, START_CASH_USD } from '../../engine/simulation-loop';
import { SYMBOLS, SYMBOL_MAP } from '../../config/symbols';
import { CandleChart } from '../../ui/charts/CandleChart';
import { OrderBook } from '../../ui/components/OrderBook';
import { Toasts } from '../../ui/components/Toasts';
import { Badge, Disclaimer, EmptyState, Modal, StatusDot, Tip } from '../../ui/components/common';
import { fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, pnlColor, tickToSimClock } from '../../lib/format';
import { GLOSSARY, TUTORIAL_STEPS, explanationForEvent } from '../../features/education/content';
import { saveToSlot, loadSlot, listSaves, deleteSlot, exportJson, importJson, type SaveRow } from '../../storage/db';
import { CompositeProvider } from '../../data/market-data-provider';
import { MockProvider } from '../../data/mock-provider';
import { createBinanceProvider } from '../../data/live-adapters';
import type { GameEvent } from '../../types/domain';

// ============================================================
// App shell + all MVP screens. Dark trading-terminal layout with
// an educational side panel ("Почему это произошло?").
// ============================================================

const SCREENS: { id: Screen; label: string; key: string }[] = [
  { id: 'dashboard', label: 'Дашборд', key: '1' },
  { id: 'market', label: 'Рынок', key: '2' },
  { id: 'trade', label: 'Торговля', key: '3' },
  { id: 'portfolio', label: 'Портфель', key: '4' },
  { id: 'orders', label: 'Ордера', key: '5' },
  { id: 'history', label: 'История', key: '6' },
  { id: 'news', label: 'Новости', key: '7' },
  { id: 'education', label: 'Обучение', key: '8' },
  { id: 'risk', label: 'Риск', key: '9' },
  { id: 'taxes', label: 'Налоги', key: '0' },
  { id: 'legal', label: 'Legal', key: 'l' },
  { id: 'bots', label: 'Боты', key: 'b' },
  { id: 'saves', label: 'Сейвы', key: 's' },
  { id: 'settings', label: 'Настройки', key: ',' },
];

export function App() {
  const { engine, snap, screen, symbol } = useUiStore();
  const setSnap = useUiStore((s) => s.setSnap);
  const setEngine = useUiStore((s) => s.setEngine);
  const pushToast = useUiStore((s) => s.pushToast);
  const setScreen = useUiStore((s) => s.setScreen);
  const setSymbol = useUiStore((s) => s.setSymbol);
  const [started, setStarted] = useState(false);
  const [seedInput, setSeedInput] = useState(() => Math.random().toString(36).slice(2, 10));
  const [difficulty, setDifficulty] = useState<'beginner' | 'normal' | 'hardcore'>('normal');
  const [livePref, setLivePref] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<GameEvent | null>(null);

  // ---- boot engine ----
  useEffect(() => {
    if (!started || engine) return;
    const eng = new SimulationEngine(seedInput, difficulty, { dataSourcePreference: livePref ? 'live' : 'mock' });
    setEngine(eng);
    // main loop: fixed 100ms budget; clock decides ticks per frame (speed x1..x16)
    let last = performance.now();
    const iv = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(now - last, 500);
      last = now;
      const n = eng.clock.advance(dt);
      for (let i = 0; i < n; i++) eng.tickOnce();
      setSnap(eng.snapshot());
    }, 100);
    // UI mirror at ~4Hz even when paused handled by interval above; snapshot every run is fine.
    // event bus -> toasts for important things
    const offs: (() => void)[] = [];
    offs.push(eng.bus.on('GAME_EVENT', ({ event }) => {
      if (['critical', 'error'].includes(event.severity)) pushToast(`${event.title}: ${event.message.slice(0, 120)}`, event.severity);
    }));
    // data provider wiring (live optional; mock always as fallback)
    const mock = new MockProvider(seedInput, SYMBOLS);
    const primary = livePref ? createBinanceProvider(SYMBOLS.map((s) => s.id)) : null;
    const composite = new CompositeProvider(primary, mock);
    composite.start();
    const provIv = setInterval(() => {
      const st = composite.status();
      eng.setDataSourceStatus(livePref ? st : 'MOCK');
      if (livePref && st === 'LIVE') {
        for (const q of composite.getQuotes()) eng.ingestLivePrice(q.symbol, q.price);
      }
    }, 2000);
    // autosave
    const autosaveIv = setInterval(async () => {
      try { await saveToSlot('autosave', eng.toSave()); } catch (e) { console.error(e); }
    }, eng.settings.autosaveSec * 1000);
    // keyboard shortcuts
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.key === ' ') { e.preventDefault(); eng.setSpeed(eng.clock.speed === 0 ? 1 : 0); }
      const sc = SCREENS.find((x) => x.key === e.key);
      if (sc) setScreen(sc.id);
      if (e.key === '+' || e.key === '=') { const speeds = [1, 2, 4, 8, 16]; eng.setSpeed(speeds[Math.min(speeds.indexOf(eng.clock.speed) + 1, 4)]); }
      if (e.key === '-') { const speeds = [1, 2, 4, 8, 16]; eng.setSpeed(speeds[Math.max(speeds.indexOf(eng.clock.speed) - 1, 0)]); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(iv); clearInterval(provIv); clearInterval(autosaveIv);
      window.removeEventListener('keydown', onKey);
      offs.forEach((f) => f()); composite.stop();
    };
  }, [started]);

  // ---- start screen ----
  if (!started || !engine || !snap) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="card max-w-md w-full space-y-4">
          <h1 className="text-2xl font-bold text-slate-100">CryptoSim <span className="text-accent">⚡</span></h1>
          <p className="text-sm text-slate-400">
            Обучающий симулятор криптобиржи: paper trading с $100 стартового капитала.
            Реальные названия активов, синтетические цены, честные издержки и последствия решений.
          </p>
          <Disclaimer />
          <div>
            <label className="label">Seed (детерминированность)</label>
            <div className="flex gap-2 mt-1">
              <input className="input" value={seedInput} onChange={(e) => setSeedInput(e.target.value)} />
              <button className="btn" onClick={() => setSeedInput(Math.random().toString(36).slice(2, 10))}>🎲</button>
            </div>
          </div>
          <div>
            <label className="label">Сложность</label>
            <div className="flex gap-2 mt-1">
              {(['beginner', 'normal', 'hardcore'] as const).map((d) => (
                <button key={d} className={`btn flex-1 ${difficulty === d ? 'btn-accent' : ''}`} onClick={() => setDifficulty(d)}>{d}</button>
              ))}
            </div>
            <p className="text-xs text-slate-500 mt-1">beginner: комиссии ×0.6, мягче события · hardcore: ×1.25 комиссии, больше новостей и манипуляций</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={livePref} onChange={(e) => setLivePref(e.target.checked)} />
            Пытаться использовать LIVE-котировки (Binance публичный API / dev-proxy). Без сети — автоматический fallback на MOCK.
          </label>
          <button className="btn btn-green w-full text-base py-2.5" onClick={() => setStarted(true)}>▶ Начать симуляцию</button>
          <LoadQuick onLoaded={() => setStarted(true)} />
        </div>
      </div>
    );
  }

  const pf = snap.portfolio;
  const speedBtns = [0, 1, 2, 4, 8, 16];

  return (
    <div className="h-full flex flex-col">
      {/* top bar */}
      <header className="flex items-center gap-3 px-3 py-2 bg-panel border-b border-line text-sm flex-wrap">
        <span className="font-bold text-slate-100">CryptoSim</span>
        <Tip text="Статус источника рыночных данных. LIVE — внешние котировки влияют на движок; MOCK — полностью синтетика; STALE/OFFLINE — данные устарели, игра не зависит от сети.">
          <StatusDot status={snap.dataSourceStatus} />
        </Tip>
        <Badge color="bg-indigo-900/50 text-indigo-300">{snap.regime.toUpperCase()}</Badge>
        <span className="text-slate-500 num">{snap.clockLabel}</span>
        <span className="text-slate-500">tick {snap.tick.toLocaleString()}</span>
        <div className="flex items-center gap-1 ml-2">
          {speedBtns.map((s) => (
            <button key={s} className={`btn !px-2 !py-0.5 text-xs ${snap.speed === s ? 'btn-accent' : ''}`}
              onClick={() => engine.setSpeed(s)} title={s === 0 ? 'Пауза (Space)' : `Скорость x${s}`}>
              {s === 0 ? '⏸' : `${s}x`}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-4 num">
          <Tip text="Equity = кэш + стоимость позиций + замороженные средства. Все изменения проходят через ledger с причиной.">
            <span className="text-slate-400">Equity <b className="text-slate-100">${fmtUsd(pf.equityUsd)}</b></span>
          </Tip>
          <span className={pnlColor(pf.totalPnlUsd)}>Всего {fmtSignedUsd(pf.totalPnlUsd)}$</span>
          <span className={pnlColor(pf.dayPnlUsd)}>День {fmtSignedUsd(pf.dayPnlUsd)}$</span>
          <span className="text-slate-400">Кэш ${fmtUsd(pf.cashUsd)}</span>
          {Number(snap.frozenCashUsd) > 0 && <Badge color="bg-red-900/60 text-red-300">FROZEN ${fmtUsd(snap.frozenCashUsd)}</Badge>}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* nav */}
        <nav className="w-40 shrink-0 bg-panel border-r border-line py-2 flex flex-col gap-0.5 overflow-y-auto">
          {SCREENS.map((sc) => (
            <button key={sc.id}
              className={`text-left px-3 py-1.5 text-sm hover:bg-panel2 ${screen === sc.id ? 'bg-panel2 text-accent border-r-2 border-accent' : 'text-slate-400'}`}
              onClick={() => setScreen(sc.id)}>
              {sc.label} <span className="text-[10px] text-slate-600 ml-1">{sc.key}</span>
            </button>
          ))}
          <div className="mt-auto px-3 py-2"><Disclaimer /></div>
        </nav>

        {/* main */}
        <main className="flex-1 overflow-y-auto p-3">
          {screen === 'dashboard' && <Dashboard />}
          {screen === 'market' && <Market />}
          {screen === 'trade' && <TradePanel />}
          {screen === 'portfolio' && <Portfolio />}
          {screen === 'orders' && <Orders />}
          {screen === 'history' && <History />}
          {screen === 'news' && <News />}
          {screen === 'education' && <Education />}
          {screen === 'risk' && <RiskPanel />}
          {screen === 'taxes' && <Taxes />}
          {screen === 'legal' && <Legal />}
          {screen === 'bots' && <Bots />}
          {screen === 'saves' && <Saves />}
          {screen === 'settings' && <Settings />}
        </main>

        {/* why panel */}
        <aside className="w-72 shrink-0 bg-panel border-l border-line p-3 overflow-y-auto hidden xl:block">
          <h3 className="text-sm font-semibold text-slate-300 mb-2">💡 Почему это произошло?</h3>
          <div className="space-y-2">
            {snap.events.slice(0, 12).map((ev) => (
              <button key={ev.id} onClick={() => setSelectedEvent(ev)}
                className={`w-full text-left rounded-md border p-2 text-xs hover:bg-panel2 ${
                  ev.severity === 'critical' ? 'border-red-800 bg-red-950/30' :
                  ev.severity === 'error' ? 'border-red-900' :
                  ev.severity === 'warn' ? 'border-amber-900' : 'border-line'
                }`}>
                <div className="font-medium text-slate-200">{ev.title}</div>
                <div className="text-slate-400 line-clamp-2">{ev.message}</div>
                <div className="text-slate-600 mt-1">{tickToSimClock(ev.tick)}</div>
              </button>
            ))}
            {snap.events.length === 0 && <EmptyState text="Событий пока нет" />}
          </div>
        </aside>
      </div>

      <Toasts />
      <Modal open={!!selectedEvent} onClose={() => setSelectedEvent(null)} title={selectedEvent?.title ?? ''}>
        {selectedEvent && <EventCard ev={selectedEvent} />}
      </Modal>
    </div>
  );
}

function EventCard({ ev }: { ev: GameEvent }) {
  const x = ev.explanation;
  return (
    <div className="text-sm space-y-2">
      <div className="text-slate-300">{ev.message}</div>
      {x ? (
        <div className="space-y-1.5">
          <p><b className="text-accent">Что:</b> {x.what}</p>
          <p><b className="text-accent">Почему:</b> {x.why}</p>
          <p><b className="text-accent">Факторы:</b> {x.factors.join(', ')}</p>
          <p><b className="text-accent">Стоимость:</b> ${x.costUsd}</p>
          <p><b className="text-accent">Риск:</b> {x.riskNote}</p>
          <p><b className="text-accent">Что можно иначе:</b> {x.alternative}</p>
          <div className="pt-1 border-t border-line">
            {x.terms.map((t) => <div key={t.term} className="text-xs text-slate-400"><b className="text-slate-300">{t.term}</b> — {t.definition}</div>)}
          </div>
        </div>
      ) : <p className="text-slate-500 text-xs">Карточка объяснения не приложена к этому событию (рутина).</p>}
    </div>
  );
}

function LoadQuick({ onLoaded }: { onLoaded: () => void }) {
  const setEngine = useUiStore((s) => s.setEngine);
  const setSnap = useUiStore((s) => s.setSnap);
  return (
    <button className="btn w-full" onClick={async () => {
      const st = await loadSlot('autosave');
      if (!st) return alert('Автосейв не найден');
      const eng = SimulationEngine.fromSave(st);
      setEngine(eng);
      setSnap(eng.snapshot());
      onLoaded();
    }}>▶ Продолжить автосейв</button>
  );
}

// ==================== SCREENS ====================

function Dashboard() {
  const { snap, engine } = useUiStore();
  const setScreen = useUiStore((s) => s.setScreen);
  const setSymbol = useUiStore((s) => s.setSymbol);
  if (!snap || !engine) return null;
  const movers = SYMBOLS.map((s) => {
    const prev = snap.prevPrices[s.id] ?? snap.prices[s.id];
    return { ...s, chg: ((snap.prices[s.id] / prev) - 1) * 100 };
  }).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 6);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div className="lg:col-span-2 space-y-3">
        <div className="card">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-semibold">BTC / USD</h2>
            <button className="btn text-xs" onClick={() => setScreen('trade')}>Торговать →</button>
          </div>
          <CandleChart candles={engine.candles('BTC')} height={300} />
        </div>
        <div className="card">
          <h2 className="font-semibold mb-2">Движущиеся активы</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {movers.map((m) => (
              <button key={m.id} className="rounded-md border border-line p-2 hover:bg-panel2 text-left" onClick={() => { setSymbol(m.id); setScreen('market'); }}>
                <div className="flex justify-between"><span style={{ color: m.color }} className="font-bold">{m.id}</span>
                  <span className={pnlColor(m.chg)}>{fmtPct(m.chg)}</span></div>
                <div className="num text-slate-300">${fmtPrice(snap.prices[m.id])}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <h2 className="font-semibold mb-1">Верх новостей</h2>
          {snap.news.slice(0, 3).map((n) => (
            <div key={n.id} className="text-sm py-1 border-b border-line last:border-0">
              <span className={n.sentiment >= 0 ? 'text-up' : 'text-down'}>{n.sentiment >= 0 ? '▲' : '▼'}</span> {n.headline}
              <span className="text-slate-600 text-xs ml-2">{tickToSimClock(n.tick)}</span>
            </div>
          ))}
          {snap.news.length === 0 && <EmptyState text="Новостей пока нет — рынок спит" />}
        </div>
      </div>
      <div className="space-y-3">
        <MiniStats />
        <div className="card">
          <h3 className="font-semibold mb-1 text-sm">Активные ордера</h3>
          {snap.orders.length === 0 ? <EmptyState text="Нет активных ордеров" /> :
            snap.orders.slice(0, 5).map((o) => (
              <div key={o.id} className="text-xs py-1 border-b border-line last:border-0 flex justify-between">
                <span className={o.side === 'BUY' ? 'text-up' : 'text-down'}>{o.side} {o.symbol}</span>
                <span className="text-slate-400">{o.type}{o.price ? ` @${o.price}` : ''} {fmtQty(o.qty)}</span>
              </div>
            ))}
        </div>
        <div className="card">
          <h3 className="font-semibold mb-1 text-sm">Последние сделки</h3>
          {snap.trades.length === 0 ? <EmptyState text="Ни одной сделки. Сделай первую в «Торговля»!" /> :
            snap.trades.slice(-5).reverse().map((t) => (
              <div key={t.id} className="text-xs py-1 border-b border-line last:border-0 flex justify-between">
                <span className={t.side === 'BUY' ? 'text-up' : 'text-down'}>{t.side} {fmtQty(t.qty)} {t.symbol}</span>
                <span className="num">@${fmtPrice(Number(t.price))} · комиссия ${Number(t.fee).toFixed(4)}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function MiniStats() {
  const { snap } = useUiStore();
  if (!snap) return null;
  const r = snap.risk;
  return (
    <div className="card grid grid-cols-2 gap-2 text-sm">
      <Stat label="Режим рынка" value={snap.regime} tip="Markov-цепь режимов движка меняет дрейф/волатильность." />
      <Stat label="KYC" value={`ур.${snap.kycLevel}`} tip="Уровни KYC влияют на лимиты и заморозки. Повышается в Legal/KYC." />
      <Stat label="Репутация" value={String(snap.reputation)} tip="Влияет на отношение ботов и регуляторов." />
      <Stat label="Regulator heat" value={`${snap.manipulationScore.toFixed(0)}/100`} tip="Растёт от подозрительных паттернов (wash/spoof/pump). >75 — расследование." />
      <Stat label="Max drawdown" value={`${r.maxDrawdownPct.toFixed(1)}%`} tip="Падение equity от исторического пика." />
      <Stat label="VaR 95%/день" value={`${r.varDailyPct.toFixed(1)}%`} tip="Упрощённый параметрический VaR портфеля." />
    </div>
  );
}

function Stat({ label, value, tip }: { label: string; value: string; tip: string }) {
  return (
    <Tip text={tip}>
      <div className="rounded border border-line p-2 w-full">
        <div className="label">{label}</div>
        <div className="font-semibold num">{value}</div>
      </div>
    </Tip>
  );
}

function Market() {
  const { snap, engine, symbol } = useUiStore();
  const setSymbol = useUiStore((s) => s.setSymbol);
  if (!snap || !engine) return null;
  const book = engine.orderBook(symbol);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
      <div className="lg:col-span-1 card !p-2 max-h-[70vh] overflow-y-auto">
        <table className="w-full text-sm">
          <tbody>
            {SYMBOLS.map((s) => {
              const prev = snap.prevPrices[s.id] ?? snap.prices[s.id];
              const chg = ((snap.prices[s.id] / prev) - 1) * 100;
              return (
                <tr key={s.id} className={`cursor-pointer hover:bg-panel2 ${symbol === s.id ? 'bg-panel2' : ''}`} onClick={() => setSymbol(s.id)}>
                  <td className="pl-2 py-1 font-bold" style={{ color: s.color }}>{s.id}</td>
                  <td className="num text-right">${fmtPrice(snap.prices[s.id])}</td>
                  <td className={`num text-right pr-2 ${pnlColor(chg)}`}>{fmtPct(chg)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="lg:col-span-2 space-y-3">
        <div className="card">
          <h2 className="font-semibold mb-1">{SYMBOL_MAP[symbol]?.name} ({symbol}/USD)</h2>
          <CandleChart candles={engine.candles(symbol)} height={340} />
        </div>
        <WhyNow symbol={symbol} />
      </div>
      <div className="card !p-0">
        <div className="p-2 border-b border-line font-semibold text-sm">Стакан {symbol}/USD</div>
        <OrderBook book={book} />
      </div>
    </div>
  );
}

/** Live attribution strip: why the price is moving right now. */
function WhyNow({ symbol }: { symbol: string }) {
  const { snap } = useUiStore();
  const [msg, setMsg] = useState('—');
  const engine = useUiStore((s) => s.engine);
  useEffect(() => {
    if (!engine) return;
    return engine.bus.on('PRICE_UPDATED', ({ symbol: sym, reason, price, prev }) => {
      if (sym !== symbol) return;
      const dir = price > prev ? '↑' : price < prev ? '↓' : '→';
      setMsg(`${dir} ${(price >= 1 ? price.toFixed(4) : price.toFixed(6))} — ${reason}`);
    });
  }, [engine, symbol]);
  return (
    <div className="card text-xs">
      <span className="label">Почему цена двигается сейчас ({symbol})</span>
      <div className="mt-1 text-slate-300">{msg}</div>
    </div>
  );
}

function TradePanel() {
  const { snap, engine, symbol } = useUiStore();
  const pushToast = useUiStore((s) => s.pushToast);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT'>('MARKET');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [trigger, setTrigger] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!snap || !engine) return null;
  const cfg = SYMBOL_MAP[symbol];
  const px = snap.prices[symbol];
  const pos = snap.positions.find((p) => p.symbol === symbol);
  const estNotional = Number(qty || 0) * px;
  const estFee = estNotional * (type === 'LIMIT' ? 0.0025 : 0.004);
  const estSlip = type === 'LIMIT' ? 0 : estNotional * 0.0007 * Math.sqrt(Math.max(estNotional / cfg.liquidityDepth, 0));

  const submit = () => {
    const res = engine.placeOrder({
      symbol, side, type, qty: qty || '0',
      price: type === 'LIMIT' ? (price || String(px)) : null,
      trigger: (type === 'STOP_LOSS' || type === 'TAKE_PROFIT') ? trigger : null,
      reason: side === 'BUY' ? 'Ручная покупка игроком' : 'Ручная продажа игроком',
    });
    if (res.ok) pushToast(`Ордер размещён (${res.orderId})`, 'info');
    else pushToast(`Отклонено: ${res.why}`, 'error');
    setConfirmOpen(false);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-w-4xl">
      <div className="card space-y-3">
        <div className="flex gap-2">
          <select className="input !w-auto" value={symbol} onChange={(e) => useUiStore.getState().setSymbol(e.target.value)}>
            {SYMBOLS.filter((s) => !s.isStable).map((s) => <option key={s.id} value={s.id}>{s.id}/USD</option>)}
          </select>
          <div className="flex gap-1">
            {(['BUY', 'SELL'] as const).map((sd) => (
              <button key={sd} className={`btn flex-1 ${side === sd ? (sd === 'BUY' ? 'btn-green' : 'btn-red') : ''}`} onClick={() => setSide(sd)}>{sd}</button>
            ))}
          </div>
        </div>
        <div className="flex gap-1">
          {(['MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT'] as const).map((tp) => (
            <Tip key={tp} text={tp === 'MARKET' ? 'Исполнение сразу по стакану: платишь taker-комиссию, спред и проскальзывание.'
              : tp === 'LIMIT' ? 'Ждёт свою цену в стакане. Maker-комиссия ниже, слиппеджа нет, но может не исполниться.'
              : tp === 'STOP_LOSS' ? 'Защита: при достижении цены срабатывания становится рыночным ордером. Ограничивает убыток.'
              : 'Фиксация прибыли: при достижении цели становится рыночным ордером.'}>
              <button className={`btn text-xs ${type === tp ? 'btn-accent' : ''}`} onClick={() => setType(tp)}>{tp.replace('_', '-')}</button>
            </Tip>
          ))}
        </div>
        <div>
          <label className="label">Количество {symbol} (min {cfg.minLot})</label>
          <input className="input" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0.0001" />
          <div className="flex gap-1 mt-1">
            {[25, 50, 75].map((pct) => (
              <button key={pct} className="btn text-xs" onClick={() => {
                if (side === 'BUY') setQty(((Number(snap.cashUsd) * pct / 100) / px).toFixed(6));
                else if (pos) setQty((Number(pos.qty) * pct / 100).toFixed(6));
              }}>{pct}% {side === 'BUY' ? 'кэша' : 'позиции'}</button>
            ))}
          </div>
        </div>
        {type === 'LIMIT' && (
          <div><label className="label">Цена limit USD</label><input className="input" type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={px.toFixed(2)} /></div>
        )}
        {(type === 'STOP_LOSS' || type === 'TAKE_PROFIT') && (
          <div><label className="label">Цена срабатывания USD</label><input className="input" type="number" step="any" value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder={px.toFixed(2)} /></div>
        )}
        <div className="text-xs text-slate-400 border-t border-line pt-2 space-y-0.5">
          <div>Mid: <b className="num">${fmtPrice(px)}</b> · Позиция: <b className="num">{pos ? fmtQty(pos.qty) : '0'}</b> {symbol}</div>
          <div>Оценка: notional ≈ ${fmtUsd(estNotional)} · комиссия ≈ ${fmtUsd(estFee)} · slippage ≈ ${fmtUsd(estSlip)}</div>
          <div className="text-amber-500/80">Market-ордера в тонком стакане платят спред+слиппедж. На малом капитале это решает всё.</div>
        </div>
        <button className={`btn w-full ${side === 'BUY' ? 'btn-green' : 'btn-red'}`} onClick={() => setConfirmOpen(true)}>
          {side === 'BUY' ? 'Купить' : 'Продать'} {symbol}
        </button>
      </div>
      <div className="space-y-3">
        <div className="card">
          <h3 className="font-semibold text-sm mb-1">Текущая позиция {symbol}</h3>
          {pos ? (
            <div className="text-sm space-y-1 num">
              <div>Объём: {fmtQty(pos.qty)} · Средняя цена: ${fmtPrice(Number(pos.avgCost))}</div>
              <div>Unrealized P&L: <span className={pnlColor((px - Number(pos.avgCost)))}>{fmtSignedUsd((px - Number(pos.avgCost)) * Number(pos.qty))}$</span></div>
              <div>Realized P&L: <span className={pnlColor(pos.realizedPnl)}>{fmtSignedUsd(pos.realizedPnl)}$</span></div>
              <div className="text-xs text-slate-500">Стоп-лосс выше средней для лонга; тейк-профит — тоже выше. Ставь保护 заранее.</div>
            </div>
          ) : <EmptyState text="Нет позиции" />}
        </div>
        <div className="card">
          <h3 className="font-semibold text-sm mb-1">Быстрые защиты</h3>
          <div className="flex gap-2">
            <button className="btn text-xs" disabled={!pos} onClick={() => {
              if (!pos) return;
              const trig = (Number(pos.avgCost) * 0.93).toFixed(2);
              const r = engine.placeOrder({ symbol, side: 'SELL', type: 'STOP_LOSS', qty: pos.qty, trigger: trig, reason: `Автоматический стоп-лосс -7% от средней $${pos.avgCost}` });
              pushToast(r.ok ? `Стоп-лосс выставлен @ $${trig}` : `Ошибка: ${r.why}`, r.ok ? 'info' : 'error');
            }}>Поставить SL -7%</button>
            <button className="btn text-xs" disabled={!pos} onClick={() => {
              if (!pos) return;
              const trig = (Number(pos.avgCost) * 1.15).toFixed(2);
              const r = engine.placeOrder({ symbol, side: 'SELL', type: 'TAKE_PROFIT', qty: pos.qty, trigger: trig, reason: `Автоматический тейк-профит +15% от средней $${pos.avgCost}` });
              pushToast(r.ok ? `Take-profit выставлен @ $${trig}` : `Ошибка: ${r.why}`, r.ok ? 'info' : 'error');
            }}>TP +15%</button>
          </div>
          <p className="text-xs text-slate-500 mt-2">Стоп защищает от каскадов: кит сливает в тонкий стакан → ликвидности нет → твой market-ордер исполняется далеко от входа.</p>
        </div>
      </div>
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Подтверждение risky action">
        <p className="text-sm mb-3">
          {side} {qty} {symbol} типом {type}. Ориентировочные издержки: комиссия ${fmtUsd(estFee)} + спред/слиппедж до ${fmtUsd(estSlip + estNotional * (snap.booksSpreadBps ?? 8) / 10000)}.
          Продолжить?
        </p>
        <div className="flex gap-2 justify-end"><button className="btn" onClick={() => setConfirmOpen(false)}>Отмена</button>
          <button className={`btn ${side === 'BUY' ? 'btn-green' : 'btn-red'}`} onClick={submit}>Подтвердить</button></div>
      </Modal>
    </div>
  );
}

function Portfolio() {
  const { snap, engine } = useUiStore();
  if (!snap || !engine) return null;
  const pf = snap.portfolio;
  return (
    <div className="max-w-4xl space-y-3">
      <div className="card grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div><div className="label">Кэш</div><div className="num font-bold">${fmtUsd(pf.cashUsd)}</div></div>
        <div><div className="label">Позиции</div><div className="num font-bold">${fmtUsd(pf.positionsValueUsd)}</div></div>
        <div><div className="label">Equity</div><div className="num font-bold">${fmtUsd(pf.equityUsd)}</div></div>
        <div><div className="label">P&L всего (от $100)</div><div className={`num font-bold ${pnlColor(pf.totalPnlUsd)}`}>{fmtSignedUsd(pf.totalPnlUsd)}$</div></div>
      </div>
      <div className="card overflow-x-auto">
        <h3 className="font-semibold text-sm mb-2">Позиции</h3>
        <table className="table w-full">
          <thead><tr><th>Актив</th><th>Объём</th><th>Средняя</th><th>Цена</th><th>Стоимость</th><th>Unrealized</th><th>Realized</th></tr></thead>
          <tbody>
            {snap.positions.map((p) => {
              const px = snap.prices[p.symbol];
              const upl = (px - Number(p.avgCost)) * Number(p.qty);
              return (
                <tr key={p.symbol} className="border-t border-line">
                  <td className="font-bold" style={{ color: SYMBOL_MAP[p.symbol]?.color }}>{p.symbol}</td>
                  <td>{fmtQty(p.qty)}</td><td>${fmtPrice(Number(p.avgCost))}</td><td>${fmtPrice(px)}</td>
                  <td>${fmtUsd(px * Number(p.qty))}</td>
                  <td className={pnlColor(upl)}>{fmtSignedUsd(upl)}$</td>
                  <td className={pnlColor(p.realizedPnl)}>{fmtSignedUsd(p.realizedPnl)}$</td>
                </tr>
              );
            })}
            {snap.positions.length === 0 && <tr><td colSpan={7}><EmptyState text="Позиций нет. Кэш ${0} — это тоже позиция: 100% cash".replace('${0}', '') /></td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3 className="font-semibold text-sm mb-2">Ledger (каждое движение денег имеет причину)</h3>
        <div className="max-h-72 overflow-y-auto">
          <table className="table w-full">
            <thead><tr><th>Tick</th><th>Тип</th><th>Счёт</th><th>Δ</th><th>Баланс после</th><th>Причина</th></tr></thead>
            <tbody>
              {[...engine.ledger.entries].reverse().slice(0, 60).map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td>{e.tick.toLocaleString()}</td><td>{e.type}</td><td>{e.account}</td>
                  <td className={pnlColor(e.amount)}>{fmtSignedUsd(e.amount)}</td>
                  <td>{fmtUsd(e.balanceAfter, 4)}</td>
                  <td className="text-slate-400 text-xs max-w-md whitespace-normal">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Orders() {
  const { snap, engine } = useUiStore();
  const pushToast = useUiStore((s) => s.pushToast);
  if (!snap || !engine) return null;
  return (
    <div className="max-w-4xl card overflow-x-auto">
      <h3 className="font-semibold text-sm mb-2">Активные ордера</h3>
      <table className="table w-full">
        <thead><tr><th>Создан</th><th>Пара</th><th>Сторона</th><th>Тип</th><th>Цена/Триггер</th><th>Объём</th><th>Исполнено</th><th>Статус</th><th>Причина</th><th /></tr></thead>
        <tbody>
          {snap.orders.map((o) => (
            <tr key={o.id} className="border-t border-line">
              <td>{tickToSimClock(o.createdAtTick)}</td><td className="font-bold">{o.symbol}</td>
              <td className={o.side === 'BUY' ? 'text-up' : 'text-down'}>{o.side}</td><td>{o.type}</td>
              <td>{o.price ?? o.triggerPrice ?? '—'}</td><td>{fmtQty(o.qty)}</td><td>{fmtQty(o.filledQty)}</td>
              <td><Badge color={o.status === 'FILLED' ? 'bg-emerald-900/60 text-emerald-300' : o.status === 'NEW' ? 'bg-slate-800 text-slate-300' : 'bg-amber-900/60 text-amber-300'}>{o.status}</Badge></td>
              <td className="text-xs text-slate-400 max-w-xs whitespace-normal">{o.reason}</td>
              <td><button className="btn text-xs !py-0.5" onClick={() => { engine.cancelOrder(o.id, 'Отменён игроком вручную'); pushToast('Ордер отменён'); }}>✕</button></td>
            </tr>
          ))}
          {snap.orders.length === 0 && <tr><td colSpan={10}><EmptyState text="Нет активных ордеров" /></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function History() {
  const { snap } = useUiStore();
  const [sortBy, setSortBy] = useState<'tick' | 'fee'>('tick');
  if (!snap) return null;
  const trades = [...snap.trades].reverse();
  if (sortBy === 'fee') trades.sort((a, b) => Number(b.fee) - Number(a.fee));
  const totalFees = snap.trades.reduce((s, t) => s + Number(t.fee), 0);
  const totalSlip = snap.trades.reduce((s, t) => s + Number(t.slippageCost), 0);
  return (
    <div className="max-w-5xl space-y-3">
      <div className="card text-sm flex gap-6">
        <span>Сделок: <b>{snap.trades.length}</b></span>
        <span>Комиссий уплачено: <b className="text-down">${fmtUsd(totalFees)}</b></span>
        <span>Проскальзывание: <b className="text-down">${fmtUsd(totalSlip)}</b></span>
        <Tip text="Суммарные friction costs. Если стратегия не генерирует edge больше этих издержек — она убыточна по определению.">
          <span className="text-accent underline dotted">Почему это важно?</span>
        </Tip>
      </div>
      <div className="card overflow-x-auto">
        <div className="flex gap-2 mb-2">
          <button className={`btn text-xs ${sortBy === 'tick' ? 'btn-accent' : ''}`} onClick={() => setSortBy('tick')}>По времени</button>
          <button className={`btn text-xs ${sortBy === 'fee' ? 'btn-accent' : ''}`} onClick={() => setSortBy('fee')}>По комиссии</button>
        </div>
        <table className="table w-full">
          <thead><tr><th>Tick</th><th>Пара</th><th>Сторона</th><th>Объём</th><th>Цена</th><th>Комиссия</th><th>Slip</th><th>Спред</th><th>Причина</th></tr></thead>
          <tbody>
            {trades.slice(0, 100).map((t) => (
              <tr key={t.id} className="border-t border-line">
                <td>{t.tick.toLocaleString()}</td><td className="font-bold">{t.symbol}</td>
                <td className={t.side === 'BUY' ? 'text-up' : 'text-down'}>{t.side}</td>
                <td>{fmtQty(t.qty)}</td><td>${fmtPrice(Number(t.price))}</td>
                <td>${Number(t.fee).toFixed(4)}</td><td>${Number(t.slippageCost).toFixed(4)}</td><td>${Number(t.spreadCost).toFixed(4)}</td>
                <td className="text-xs text-slate-400 max-w-sm whitespace-normal">{t.reason}</td>
              </tr>
            ))}
            {trades.length === 0 && <tr><td colSpan={9}><EmptyState text="Сделок ещё не было" /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function News() {
  const { snap } = useUiStore();
  if (!snap) return null;
  return (
    <div className="max-w-3xl space-y-2">
      {snap.news.map((n) => (
        <div key={n.id} className="card">
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>{n.source} · {tickToSimClock(n.tick)} · <span className={n.sentiment >= 0 ? 'text-up' : 'text-down'}>{n.kind}, sentiment {(n.sentiment * 100).toFixed(0)}</span></span>
            <span>{n.affectedSymbols.join(' ')}</span>
          </div>
          <h3 className="font-semibold text-slate-200">{n.headline}</h3>
          <p className="text-sm text-slate-400 mt-1">{n.body}</p>
          <p className="text-xs text-slate-600 mt-1">Заложенный импульс: {n.impactBps} bps → применяется как причина движения цен affected-активов.</p>
        </div>
      ))}
      {snap.news.length === 0 && <EmptyState text="Лента пуста. Подкрути скорость времени (кнопки сверху или +/-)" />}
    </div>
  );
}

function Education() {
  const [q, setQ] = useState('');
  const filtered = GLOSSARY.filter((g) => (g.term + g.def + g.tag).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="max-w-3xl space-y-3">
      <div className="card">
        <h3 className="font-semibold mb-2">Мини-туториал</h3>
        {TUTORIAL_STEPS.map((s) => (
          <details key={s.title} className="border-b border-line last:border-0 py-1">
            <summary className="cursor-pointer text-sm font-medium text-slate-300">{s.title}</summary>
            <p className="text-sm text-slate-400 pl-4 py-1">{s.body}</p>
          </details>
        ))}
      </div>
      <div className="card">
        <h3 className="font-semibold mb-2">Глоссарий</h3>
        <input className="input mb-2" placeholder="Поиск термина…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
          {filtered.map((g) => (
            <div key={g.term} className="text-sm">
              <span className="font-semibold text-slate-200">{g.term}</span>
              <Badge color="bg-slate-800 text-slate-400 ml-2">{g.tag}</Badge>
              <div className="text-slate-400">{g.def}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RiskPanel() {
  const { snap } = useUiStore();
  if (!snap) return null;
  const r = snap.risk;
  const rows = [
    ['Equity', `$${fmtUsd(r.equityUsd)}`, 'Капитал: кэш + позиции + замороженное'],
    ['Exposure', `$${fmtUsd(r.exposureUsd)}`, 'Доля капитала в рисковых активах'],
    ['Leverage (spot)', `${r.leverage.toFixed(2)}x`, 'Spot ≤ 1x. >1 бывает только с маржой/перпами'],
    ['Max Drawdown', `${r.maxDrawdownPct.toFixed(2)}%`, 'Падение от пика equity. Главный показатель риска стратегии'],
    ['VaR 95% (день)', `${r.varDailyPct.toFixed(2)}%`, 'Параметрическая оценка: худший обычный день ~ с вероятностью 5%'],
    ['Концентрация', `${r.concentrationTopPct.toFixed(1)}%`, 'Вес крупнейшей позиции. >40% — ставка, не диверсификация'],
  ];
  return (
    <div className="max-w-3xl space-y-3">
      <div className="card">
        <h3 className="font-semibold mb-2">Risk Panel</h3>
        <table className="table w-full">
          <tbody>
            {rows.map(([k, v, tip]) => (
              <tr key={k} className="border-t border-line">
                <td className="w-48"><Tip text={tip}><span className="underline dotted cursor-help">{k}</span></Tip></td>
                <td className="num font-semibold">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card text-sm text-slate-400">
        <b className="text-slate-200">Цены ликвидации:</b> в spot-режиме их нет — ты не можешь потерять больше стоимости позиции.
        Маржа/перпы (расширение NEXT PHASE) добавляют liquidation price = entry·(1 − margin/notional + mmr) для лонгов.
        Maintenance margin растёт с размером позиции, funding платится каждые 8 часов симуляции.
      </div>
    </div>
  );
}

function Taxes() {
  const { snap } = useUiStore();
  if (!snap) return null;
  const year = Math.floor((snap.tick ?? 0) / (86_400 * 365)) + 1;
  const totals = snap.taxes.reduce((acc, t) => acc + Number(t.gain), 0);
  return (
    <div className="max-w-4xl space-y-3">
      <div className="card text-sm">
        Налоговый ledger (образовательно, юрисдикция США). Налог <b>начисляется</b>, но не списывается — цель показать механику capital gains / wash sale.
        Итог реализованных gain/loss: <b className={pnlColor(totals)}>{fmtSignedUsd(totals)}$</b>. Текущий sim-year: {year}.
      </div>
      <div className="card overflow-x-auto">
        <table className="table w-full">
          <thead><tr><th>Tick</th><th>Актив</th><th>Категория</th><th>Выручка</th><th>Basis</th><th>Gain</th><th>Дней</th><th>Wash sale</th><th>Комментарий</th></tr></thead>
          <tbody>
            {[...snap.taxes].reverse().slice(0, 80).map((t) => (
              <tr key={t.id} className="border-t border-line">
                <td>{t.tick.toLocaleString()}</td><td>{t.symbol}</td><td>{t.category}</td>
                <td>${fmtUsd(t.proceeds)}</td><td>${fmtUsd(t.costBasis)}</td>
                <td className={pnlColor(t.gain)}>{fmtSignedUsd(t.gain)}$</td>
                <td>{t.holdingDays}</td>
                <td>{t.washSaleDisallowed ? <Badge color="bg-red-900/60 text-red-300">DISALLOWED</Badge> : '—'}</td>
                <td className="text-xs text-slate-400 max-w-xs whitespace-normal">{t.note}</td>
              </tr>
            ))}
            {snap.taxes.length === 0 && <tr><td colSpan={9}><EmptyState text="Нет налогооблагаемых событий — продажи ещё не были" /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Legal() {
  const { snap, engine } = useUiStore();
  const pushToast = useUiStore((s) => s.pushToast);
  if (!snap || !engine) return null;
  return (
    <div className="max-w-4xl space-y-3">
      <div className="card grid grid-cols-3 gap-3 text-sm">
        <div><div className="label">KYC уровень</div><div className="font-bold">{snap.kycLevel}/3</div>
          <div className="flex gap-1 mt-1">
            {[1, 2, 3].map((lv) => (
              <button key={lv} className="btn text-xs" disabled={lv <= snap.kycLevel}
                onClick={() => { engine.upgradeKyc(lv as 1 | 2 | 3); pushToast(`KYC повышен до ${lv}`); }}>KYC {lv}</button>
            ))}
          </div>
        </div>
        <div><div className="label">Reputation</div><div className={`font-bold ${pnlColor(snap.reputation)}`}>{snap.reputation}</div></div>
        <div><div className="label">Regulator heat</div>
          <div className="font-bold text-amber-400">{snap.manipulationScore.toFixed(0)}/100</div>
          <div className="h-1.5 bg-panel2 rounded mt-1"><div className="h-full bg-amber-500 rounded" style={{ width: `${snap.manipulationScore}%` }} /></div>
        </div>
      </div>
      <div className="card">
        <h3 className="font-semibold text-sm mb-2">Юридические дела</h3>
        {snap.legalCases.length === 0 ? <EmptyState text="Чисто. Heat растёт от wash trading / spoofing-паттернов — следи за ним." /> :
          snap.legalCases.map((c) => (
            <div key={c.id} className="border-t border-line py-2 text-sm">
              <div className="flex justify-between">
                <b>{c.kind}</b><Badge color={c.status === 'open' ? 'bg-amber-900/60 text-amber-300' : c.status === 'dismissed' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-red-900/60 text-red-300'}>{c.status}</Badge>
              </div>
              <div className="text-slate-400 text-xs">{c.description} (доказательства {c.evidenceScore}/100){c.penaltyUsd ? `, штраф $${fmtUsd(c.penaltyUsd)}` : ''}</div>
              {c.status === 'open' && (
                <div className="flex gap-2 mt-1">
                  <button className="btn text-xs" onClick={() => { engine.resolveLegalCase(c.id, rngDismiss() ? 'dismissed' : 'fined'); }}>Судиться</button>
                  <button className="btn text-xs" onClick={() => { engine.resolveLegalCase(c.id, 'fined'); pushToast('Штраф уплачен, репутация -20', 'warn'); }}>Признать и заплатить</button>
                </div>
              )}
            </div>
          ))}
      </div>
      <div className="card text-xs text-slate-400">
        Регуляторика (US): SEC — ценные бумаги, CFTC — деривативы, FinCEN — AML, IRS — налоги, OFAC — санкции.
        Биржа обязана делать SAR-отчёты и блокировать подозрительные операции. В игре это механики freeze/legal case.
      </div>
    </div>
  );
}

function rngDismiss(): boolean { return Math.random() < 0.35; } // court outcome chance (UI-side flavor; consequences still via engine)

function Bots() {
  const { snap } = useUiStore();
  if (!snap) return null;
  return (
    <div className="max-w-4xl card overflow-x-auto">
      <h3 className="font-semibold text-sm mb-2">NPC-агенты (правила + память, без LLM)</h3>
      <table className="table w-full">
        <thead><tr><th>Агент</th><th>Тип</th><th>FSM-состояние</th><th>Бюджет</th><th>Мнение об игроке</th><th>Последнее действие</th><th>Cooldown</th></tr></thead>
        <tbody>
          {snap.agents.map((a) => (
            <tr key={a.agentId} className="border-t border-line">
              <td className="text-xs">{a.agentId}</td><td>{a.kind}</td>
              <td><Badge color="bg-slate-800 text-slate-300">{a.state}</Badge></td>
              <td>${(a.budgetUsd / 1000).toFixed(0)}k</td>
              <td>{a.reputationOfPlayer}</td>
              <td className="text-xs text-slate-400 max-w-sm whitespace-normal">{a.lastAction}</td>
              <td>{a.cooldownTicks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Saves() {
  const { snap, engine } = useUiStore();
  const pushToast = useUiStore((s) => s.pushToast);
  const setEngine = useUiStore((s) => s.setEngine);
  const setSnap = useUiStore((s) => s.setSnap);
  const [rows, setRows] = useState<SaveRow[]>([]);
  const refresh = () => listSaves().then(setRows);
  useEffect(() => { refresh(); }, []);
  if (!engine) return null;
  return (
    <div className="max-w-3xl space-y-3">
      <div className="card flex gap-2 flex-wrap">
        <button className="btn btn-accent" onClick={async () => { await saveToSlot('manual-1', engine.toSave()); pushToast('Сейв сохранён (IndexedDB)'); refresh(); }}>💾 Сохранить вручную</button>
        <button className="btn" onClick={async () => {
          const blob = new Blob([exportJson(engine.toSave())], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = `cryptosim-seed-${engine.seed}.json`; a.click();
          pushToast('JSON экспортирован');
        }}>⬇ Экспорт JSON</button>
        <label className="btn cursor-pointer">⬆ Импорт JSON
          <input type="file" accept=".json" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const st = importJson(await f.text());
              const eng = SimulationEngine.fromSave(st);
              setEngine(eng); setSnap(eng.snapshot());
              pushToast('Сейв импортирован (на паузе)', 'info');
            } catch (err) { pushToast(`Импорт не удался: ${(err as Error).message}`, 'error'); }
          }} />
        </label>
      </div>
      <div className="card">
        <h3 className="font-semibold text-sm mb-2">Слоты IndexedDB</h3>
        <table className="table w-full">
          <thead><tr><th>Слот</th><th>Seed</th><th>Сложность</th><th>Equity</th><th>Tick</th><th>Обновлён</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td>{r.slotName}</td><td>{r.seed}</td><td>{r.difficulty}</td>
                <td>${fmtUsd(r.equityUsd)}</td><td>{r.tick.toLocaleString()}</td>
                <td className="text-xs">{new Date(r.updatedAt).toLocaleTimeString()}</td>
                <td className="space-x-1">
                  <button className="btn text-xs" onClick={async () => {
                    const st = await loadSlot(r.slotName);
                    if (st) { const eng = SimulationEngine.fromSave(st); setEngine(eng); setSnap(eng.snapshot()); pushToast('Загружено (пауза)'); }
                  }}>Load</button>
                  <button className="btn text-xs" onClick={async () => { await deleteSlot(r.slotName); refresh(); }}>Del</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7}><EmptyState text="Пусто. Автосейв появится через ~30 секунд игры" /></td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card text-xs text-slate-500">
        Seed + детерминированный RNG означают: тот же seed и те же действия игрока воспроизводят те же рыночные сценарии (для тестов и разборов).
      </div>
    </div>
  );
}

function Settings() {
  const { engine, snap } = useUiStore();
  const pushToast = useUiStore((s) => s.pushToast);
  if (!engine) return null;
  return (
    <div className="max-w-xl space-y-3">
      <div className="card space-y-2 text-sm">
        <h3 className="font-semibold">Источник данных</h3>
        <div className="flex gap-2">
          <button className={`btn ${snap?.dataSourceStatus === 'MOCK' ? 'btn-accent' : ''}`} onClick={() => { engine.setDataSourceStatus('MOCK'); engine.settings.dataSourcePreference = 'mock'; pushToast('Источник: MOCK (офлайн, детерминированный)'); }}>MOCK</button>
          <button className="btn" onClick={() => { engine.settings.dataSourcePreference = 'live'; pushToast('Перезапусти игру со включённой LIVE-галкой на старте (или обнови страницу). Прокси /api/binance доступен в dev.'); }}>LIVE (нужна сеть/прокси)</button>
        </div>
        <h3 className="font-semibold pt-2">Обучение</h3>
        <label className="flex gap-2"><input type="checkbox" checked={engine.settings.showEducationalCards} onChange={(e) => { engine.settings.showEducationalCards = e.target.checked; }} /> Показывать карточки-объяснения (правая панель)</label>
        <h3 className="font-semibold pt-2">Jurisdiction</h3>
        <div className="text-slate-400">США (US) — SEC/CFTC/FinCEN/IRS/OFAC механики включены. <span className="text-slate-600">Другие юрисдикции: NEXT PHASE.</span></h3>
        <h3 className="font-semibold pt-2">Расширенные модули</h3>
        <div className="text-slate-400 leading-6">
          <Badge color="bg-emerald-900/60 text-emerald-300">готово</Badge> spot · market/limit/SL/TP · стакан · maker/taker · spread · slippage · ledger · P&L · налоги · risk · новости · боты · save/load · экспорт<br />
          <Badge color="bg-amber-900/60 text-amber-300">STUB / NEXT PHASE</Badge> margin · perpetuals+funding+liquidation UI · options · futures · staking · lending · AMM/IL · farming · NFT · ICO · arbitrage UI · player bots · fund mgmt · employees · investors · partnerships
        </div>
        <p className="text-xs text-slate-500">Модули имеют единый интерфейс canOpen/canClose/calculateFee/calculatePnL/calculateRisk/applyEvent/getEducationalExplanation (см. src/features/tool.ts). Деривативная математика уже в engine/risk-engine.ts (liquidation prices, margin) и покрыта тестами.</p>
      </div>
    </div>
  );
}
