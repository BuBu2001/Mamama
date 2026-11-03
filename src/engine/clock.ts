// ============================================================
// Simulation clock: 1 real second at 1x = 60 sim ticks (tick =
// "one minute of market time" scaled). Speeds: 0/1/2/4/8/16.
// The loop calls advance(realDeltaMs) and consumes whole ticks.
// Deterministic: tick count is the only time source for the sim.
// ============================================================

export const TICK_MS_SIM = 1_000;          // each tick = 1 simulated second
export const BASE_TICKS_PER_REAL_SEC = 10; // at 1x => 10 ticks/s (engine tick budget 100ms)

export class SimClock {
  tick = 0;
  speed = 1;                 // 0 = pause
  private acc = 0;           // accumulated real ms

  /** Returns number of simulation ticks to run this frame. */
  advance(realDeltaMs: number): number {
    if (this.speed === 0) return 0;
    this.acc += realDeltaMs * this.speed;
    const perTick = 1000 / BASE_TICKS_PER_REAL_SEC;
    let n = Math.floor(this.acc / perTick);
    // hard cap to avoid spiral-of-death after tab sleep
    n = Math.min(n, 200);
    this.acc -= n * perTick;
    this.tick += n;
    return n;
  }

  simTimeMs(): number { return this.tick * TICK_MS_SIM; }

  setSpeed(s: number): void { this.speed = s; }

  dayOf(tick: number): number { return Math.floor((tick * TICK_MS_SIM) / 86_400_000); }

  formatSimTime(): string {
    const totalSec = Math.floor(this.simTimeMs() / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `День ${d + 1} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
