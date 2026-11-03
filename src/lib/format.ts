// Formatting helpers shared by UI. All money arrives as decimal strings.

export function fmtUsd(s: string | number | null | undefined, dp = 2): string {
  if (s === null || s === undefined) return '—';
  const n = typeof s === 'number' ? s : Number(s);
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtSignedUsd(s: string | number, dp = 2): string {
  const n = typeof s === 'number' ? s : Number(s);
  const sign = n > 0 ? '+' : '';
  return `${sign}${fmtUsd(n, dp)}`;
}

export function fmtPrice(p: number): string {
  if (!isFinite(p)) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  return p.toFixed(6).replace(/0+$/, '');
}

export function fmtQty(q: string | number): string {
  const n = typeof q === 'number' ? q : Number(q);
  if (!isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4).replace(/0+$/, '');
  return n.toPrecision(5);
}

export function fmtPct(v: number, dp = 2): string {
  return `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(dp)}%`;
}

export function pnlColor(v: number | string): string {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n > 0) return 'text-up';
  if (n < 0) return 'text-down';
  return 'text-slate-400';
}

export function tickToSimClock(tick: number): string {
  const sec = Math.floor(tick);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `Д${d + 1} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
