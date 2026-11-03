import { useEffect, useRef } from 'react';
import { createChart, ColorType, CrosshairMode, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Candle } from '../../types/domain';

// ============================================================
// Candlestick chart wrapper around lightweight-charts (TV OSS).
// Updates in place (no full redraw) => cheap at high speed.
// ============================================================

interface Props {
  candles: Candle[];
  height?: number;
}

export function CandleChart({ candles, height = 320 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: '#12161f' }, textColor: '#8b98ab' },
      grid: { vertLines: { color: '#1a202c' }, horzLines: { color: '#1a202c' } },
      rightPriceScale: { borderColor: '#232a38' },
      timeScale: { borderColor: '#232a38', timeVisible: true, secondsVisible: true },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
      height,
    });
    const s = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    });
    const v = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
    v.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartRef.current = chart;
    seriesRef.current = s;
    volRef.current = v;
    return () => { chart.remove(); chartRef.current = null; };
  }, [height]);

  useEffect(() => {
    if (!seriesRef.current || !volRef.current) return;
    const data = candles.map((c) => ({ time: c.t as unknown as never, open: c.o, high: c.h, low: c.l, close: c.c }));
    const vols = candles.map((c) => ({ time: c.t as unknown as never, value: c.v, color: c.c >= c.o ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)' }));
    try {
      seriesRef.current.setData(data as never);
      volRef.current.setData(vols as never);
      chartRef.current?.timeScale().fitContent();
    } catch { /* ignore transient malformed-time errors */ }
  }, [candles]);

  return <div ref={ref} className="w-full" style={{ height }} />;
}
