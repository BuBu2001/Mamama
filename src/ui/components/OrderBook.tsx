import type { OrderBookSnapshot } from '../../types/domain';
import { fmtPrice, fmtQty } from '../../lib/format';

export function OrderBook({ book }: { book: OrderBookSnapshot | null }) {
  if (!book) return <div className="text-slate-500 text-sm p-4">Нет данных стакана</div>;
  const maxQty = Math.max(
    ...book.bids.slice(0, 8).map((l) => l.qty),
    ...book.asks.slice(0, 8).map((l) => l.qty),
    1e-9,
  );
  const asks = [...book.asks].slice(0, 8).reverse();
  let cumBid = 0, cumAsk = 0;
  return (
    <div className="text-xs font-mono select-none">
      <div className="flex justify-between px-2 py-1 text-slate-500 uppercase tracking-wide text-[10px]">
        <span>Цена USD</span><span>Объём</span>
      </div>
      {asks.map((l, i) => {
        cumAsk += l.qty;
        return (
          <div key={`a${i}`} className="relative px-2 py-[3px] flex justify-between hover:bg-panel2">
            <div className="absolute inset-y-0 right-0 bg-red-500/10" style={{ width: `${(l.qty / maxQty) * 100}%` }} />
            <span className="text-down num">{fmtPrice(l.price)}</span>
            <span className="text-slate-400 num">{fmtQty(l.qty)}</span>
          </div>
        );
      })}
      <div className="px-2 py-1.5 my-1 bg-panel2 border-y border-line flex justify-between">
        <span className="font-bold num text-slate-200">{fmtPrice(book.mid)}</span>
        <span className="text-slate-500">спред {book.spreadBps.toFixed(1)} bps</span>
      </div>
      {book.bids.slice(0, 8).map((l, i) => {
        cumBid += l.qty;
        return (
          <div key={`b${i}`} className="relative px-2 py-[3px] flex justify-between hover:bg-panel2">
            <div className="absolute inset-y-0 right-0 bg-emerald-500/10" style={{ width: `${(l.qty / maxQty) * 100}%` }} />
            <span className="text-up num">{fmtPrice(l.price)}</span>
            <span className="text-slate-400 num">{fmtQty(l.qty)}</span>
          </div>
        );
      })}
    </div>
  );
}
