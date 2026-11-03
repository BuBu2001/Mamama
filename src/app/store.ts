import { create } from 'zustand';
import type { EngineSnapshot, SimulationEngine } from '../engine/simulation-loop';

// ============================================================
// UI store (Zustand). Holds: engine ref, latest snapshot, active
// symbol/screen, toasts. The engine itself lives OUTSIDE React —
// this store only mirrors snapshots at ~4Hz for rendering, so the
// 10-tick/second sim loop never re-renders the tree per tick.
// ============================================================

export type Screen =
  | 'dashboard' | 'market' | 'trade' | 'portfolio' | 'orders' | 'history'
  | 'news' | 'education' | 'risk' | 'taxes' | 'legal' | 'bots' | 'settings' | 'saves';

export interface Toast { id: number; text: string; severity: 'info' | 'warn' | 'error' | 'critical'; }

interface UiState {
  engine: SimulationEngine | null;
  snap: EngineSnapshot | null;
  screen: Screen;
  symbol: string;
  toasts: Toast[];
  running: boolean;
  setEngine(e: SimulationEngine | null): void;
  setSnap(s: EngineSnapshot): void;
  setScreen(sc: Screen): void;
  setSymbol(sym: string): void;
  pushToast(text: string, severity?: Toast['severity']): void;
  dismissToast(id: number): void;
  setRunning(r: boolean): void;
}

let toastId = 0;

export const useUiStore = create<UiState>((set, get) => ({
  engine: null,
  snap: null,
  screen: 'dashboard',
  symbol: 'BTC',
  toasts: [],
  running: false,
  setEngine: (e) => set({ engine: e }),
  setSnap: (s) => set({ snap: s }),
  setScreen: (sc) => set({ screen: sc }),
  setSymbol: (sym) => set({ symbol: sym }),
  pushToast: (text, severity = 'info') => {
    const t = { id: ++toastId, text, severity };
    set({ toasts: [...get().toasts.slice(-4), t] });
    setTimeout(() => get().dismissToast(t.id), 6000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
  setRunning: (r) => set({ running: r }),
}));

/** Loop runner: setInterval(100ms) -> clock.advance -> engine.tickOnce N times. */
export function startMainLoop(engine: SimulationEngine, clock: SimClock): () => void {
  let last = performance.now();
  const iv = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(now - last, 500); // clamp tab-throttle gaps
    last = now;
    const n = clock.advance(dt);
    for (let i = 0; i < n; i++) engine.tickOnce();
  }, 100);
  return () => clearInterval(iv);
}
