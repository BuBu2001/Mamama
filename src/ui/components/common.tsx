import React, { useState } from 'react';

export function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span className="absolute z-50 bottom-full mb-1 left-1/2 -translate-x-1/2 w-64 bg-panel2 border border-line rounded-md p-2 text-xs text-slate-300 shadow-xl whitespace-normal">
          {text}
        </span>
      )}
    </span>
  );
}

export function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return <span className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${color}`}>{children}</span>;
}

export function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    LIVE: 'bg-emerald-500', MOCK: 'bg-sky-500', STALE: 'bg-amber-500', OFFLINE: 'bg-red-500',
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-bold tracking-wide">
      <span className={`w-2 h-2 rounded-full ${map[status] ?? 'bg-slate-500'} animate-pulse`} />
      {status}
    </span>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-panel border border-line rounded-xl p-4 max-w-lg w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-semibold text-slate-200">{title}</h3>
          <button className="btn text-xs" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="text-center text-slate-500 text-sm py-8">{text}</div>;
}

export function Disclaimer() {
  return (
    <div className="text-[11px] text-amber-500/80 border border-amber-700/30 bg-amber-900/10 rounded-md px-2 py-1">
      ⚠️ Учебная симуляция. Не финансовые рекомендации. Никаких реальных денег и ордеров.
    </div>
  );
}
