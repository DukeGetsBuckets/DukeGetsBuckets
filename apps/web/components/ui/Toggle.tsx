"use client";

import { cn } from "@/lib/cn";

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-center justify-between gap-4 py-3", disabled && "opacity-50")}>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description ? <span className="block text-xs text-fg-muted">{description}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative h-7 w-12 shrink-0 rounded-full border transition", checked ? "border-accent bg-accent" : "border-border-strong bg-surface-3")}
      >
        <span className={cn("absolute top-0.5 h-5.5 w-5.5 rounded-full bg-white shadow transition-transform", checked ? "left-[calc(100%-1.5rem)]" : "left-0.5")} style={{ height: 22, width: 22 }} />
      </button>
    </label>
  );
}
