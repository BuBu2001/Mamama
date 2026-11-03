import { useUiStore } from '../../app/store';

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  return (
    <div className="fixed bottom-4 right-4 z-[60] space-y-2 w-80">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`rounded-lg border p-3 text-sm shadow-xl cursor-pointer backdrop-blur ${
            t.severity === 'critical' || t.severity === 'error'
              ? 'bg-red-950/80 border-red-700 text-red-200'
              : t.severity === 'warn'
                ? 'bg-amber-950/80 border-amber-700 text-amber-200'
                : 'bg-panel border-line text-slate-200'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
