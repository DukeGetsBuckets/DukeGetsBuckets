"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  dismissible?: boolean;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissible]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-3 backdrop-blur-[2px] sm:items-center" onClick={dismissible ? onClose : undefined} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        className={cn("card animate-fade-in w-full max-w-md bg-bg-elevated p-5 shadow-card sm:p-6", className)}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || dismissible) && (
          <div className="mb-4 flex items-start justify-between gap-4">
            {title ? <h2 className="text-lg font-semibold tracking-tight">{title}</h2> : <span />}
            {dismissible ? (
              <button onClick={onClose} className="-mr-1 -mt-1 rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            ) : null}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
