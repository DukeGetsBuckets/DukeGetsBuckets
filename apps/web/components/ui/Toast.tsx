"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface ToastAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
}
export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone?: "neutral" | "success" | "danger" | "accent";
  actions?: ToastAction[];
  durationMs?: number;
}

interface ToastContextValue {
  toast: (t: Omit<ToastItem, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const timers = React.useRef(new Map<string, NodeJS.Timeout>());

  const dismiss = React.useCallback((id: string) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const toast = React.useCallback(
    (t: Omit<ToastItem, "id"> & { id?: string }) => {
      const id = t.id ?? Math.random().toString(36).slice(2);
      setItems((list) => [...list.filter((x) => x.id !== id), { ...t, id }].slice(-4));
      const duration = t.durationMs ?? (t.actions?.length ? 15000 : 4500);
      if (duration > 0) {
        const existing = timers.current.get(id);
        if (existing) clearTimeout(existing);
        timers.current.set(id, setTimeout(() => dismiss(id), duration));
      }
      return id;
    },
    [dismiss],
  );

  const value = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3 sm:items-end sm:px-4" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "card pointer-events-auto animate-fade-in w-full max-w-sm bg-bg-elevated p-4 shadow-card",
              t.tone === "success" && "border-success/40",
              t.tone === "danger" && "border-danger/40",
              t.tone === "accent" && "border-accent/50",
            )}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{t.title}</p>
                {t.description ? <p className="mt-0.5 text-sm text-fg-muted">{t.description}</p> : null}
                {t.actions?.length ? (
                  <div className="mt-3 flex gap-2">
                    {t.actions.map((a) => (
                      <button
                        key={a.label}
                        onClick={() => {
                          a.onClick();
                          dismiss(t.id);
                        }}
                        className={cn(
                          "h-9 rounded-lg px-3 text-sm font-medium",
                          a.variant === "secondary" ? "bg-surface-2 text-fg hover:bg-surface-3" : "bg-accent text-accent-fg hover:bg-accent-strong",
                        )}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button onClick={() => dismiss(t.id)} className="-mr-1 -mt-1 rounded-md p-1 text-fg-muted hover:bg-surface-2" aria-label="Dismiss">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
