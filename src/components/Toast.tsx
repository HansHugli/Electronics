import { useState, useCallback, useRef, useEffect } from 'react';

export type ToastKind = 'info' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

/**
 * Small notices in the corner. Info notices fade after a few seconds; errors
 * stay until closed so they can be read and copied.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
  }, []);

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setToasts((prev) => {
      // Don't stack the same message twice.
      const rest = prev.filter((t) => !(t.message === message && t.kind === kind));
      return [...rest.slice(-3), { id, kind, message }];
    });
    if (kind === 'info') {
      timers.current.set(id, setTimeout(() => dismiss(id), 3500));
    }
    return id;
  }, [dismiss]);

  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
  }, []);

  return { toasts, show, dismiss };
}

export default function ToastList({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-list" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
          <span className="toast-message">{t.message}</span>
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
