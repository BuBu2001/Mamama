import type { AssetId, DataSourceStatus } from '../types/domain';

// ============================================================
// MarketDataProvider abstraction.
// MockProvider: deterministic synthetic (default, offline-safe).
// Live adapters: fetch-based with retry/backoff/rate-limit and a
// StaleDetector; on any failure the CompositeProvider falls back
// to mock and status degrades LIVE -> STALE -> OFFLINE.
// ============================================================

export interface TickQuote {
  symbol: AssetId;
  price: number;
  ts: number; // wall-clock ms of data freshness
}

export interface MarketDataProvider {
  name: string;
  start(): void;
  stop(): void;
  /** latest known quotes (empty if none yet) */
  getQuotes(): TickQuote[];
  status(): DataSourceStatus;
}

class RateLimiter {
  private last = 0;
  constructor(private minIntervalMs: number) {}
  allow(): boolean {
    const now = Date.now();
    if (now - this.last < this.minIntervalMs) return false;
    this.last = now;
    return true;
  }
}

async function fetchWithRetry(url: string, attempts = 3, baseDelayMs = 500): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i)); // exponential backoff
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

/** Normalized error message for UI display. */
export function normalizeError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return 'Таймаут запроса к API котировок';
  if (e instanceof TypeError) return 'Сеть/CORS недоступен — работаем на mock-данных';
  if (e instanceof Error) return e.message;
  return 'Неизвестная ошибка источника данных';
}

// ---- REST polling provider usable for Binance-style public APIs ----

export interface RestPollConfig {
  name: string;
  urlFor: (symbols: AssetId[]) => string;
  parse: (json: unknown) => Record<string, number>; // symbol -> price
  pollMs?: number;
}

export class RestPollProvider implements MarketDataProvider {
  private quotes: Map<AssetId, TickQuote> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private limiter = new RateLimiter(900);
  private _status: DataSourceStatus = 'OFFLINE';
  private failStreak = 0;

  constructor(private cfg: RestPollConfig, private symbols: AssetId[]) {}

  start(): void {
    this._status = 'STALE';
    const poll = () => {
      if (!this.limiter.allow()) return;
      this.fetchOnce().catch(() => { /* status handled inside */ });
    };
    poll();
    this.timer = setInterval(poll, this.cfg.pollMs ?? 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._status = 'OFFLINE';
  }

  private async fetchOnce(): Promise<void> {
    try {
      const res = await fetchWithRetry(this.cfg.urlFor(this.symbols));
      const json = await res.json();
      const map = this.cfg.parse(json);
      const now = Date.now();
      let got = 0;
      for (const [sym, px] of Object.entries(map)) {
        if (typeof px === 'number' && px > 0) {
          this.quotes.set(sym, { symbol: sym, price: px, ts: now });
          got++;
        }
      }
      if (got > 0) { this.failStreak = 0; this._status = 'LIVE'; }
      else this.degrade();
    } catch {
      this.degrade();
    }
  }

  private degrade(): void {
    this.failStreak++;
    this._status = this.failStreak >= 4 ? 'OFFLINE' : 'STALE';
  }

  getQuotes(): TickQuote[] { return [...this.quotes.values()]; }
  status(): DataSourceStatus { return this._status; }
}

// ---- Stale detector wrapper ----

export class StaleDetector {
  private lastSeen = Date.now();
  constructor(public maxAgeMs = 15_000) {}
  beat(): void { this.lastSeen = Date.now(); }
  isStale(): boolean { return Date.now() - this.lastSeen > this.maxAgeMs; }
}

// ---- Composite with fallback chain ----

export class CompositeProvider implements MarketDataProvider {
  name = 'composite';
  private stale = new StaleDetector();
  constructor(private primary: MarketDataProvider | null, private fallback: MarketDataProvider) {}
  start(): void {
    this.fallback.start();
    if (this.primary) this.primary.start();
    this.stale.beat();
  }
  stop(): void { this.primary?.stop(); this.fallback.stop(); }
  getQuotes(): TickQuote[] {
    const p = this.primary?.getQuotes() ?? [];
    if (p.length > 0 && !this.stale.isStale()) { this.stale.beat(); return p; }
    return this.fallback.getQuotes();
  }
  status(): DataSourceStatus {
    if (!this.primary) return this.fallback.status();
    const s = this.primary.status();
    if (s === 'LIVE' && !this.stale.isStale()) return 'LIVE';
    if (s === 'STALE' || this.stale.isStale()) return 'STALE';
    if (s === 'OFFLINE') return 'OFFLINE';
    return 'MOCK';
  }
}
