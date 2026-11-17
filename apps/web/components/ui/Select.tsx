"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function Select({ label, className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-sm font-medium text-fg-muted">{label}</span> : null}
      <span className="relative block">
        <select className={cn("h-11 w-full appearance-none rounded-xl border border-border bg-surface px-3.5 pr-10 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/50", className)} {...props}>
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
      </span>
    </label>
  );
}
