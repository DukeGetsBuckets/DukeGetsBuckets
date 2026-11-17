"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, label, hint, error, id, ...props }, ref) {
  const inputId = id ?? React.useId();
  return (
    <label className="block" htmlFor={inputId}>
      {label ? <span className="mb-1.5 block text-sm font-medium text-fg-muted">{label}</span> : null}
      <input
        ref={ref}
        id={inputId}
        className={cn(
          "h-12 w-full rounded-xl border bg-surface px-3.5 text-base text-fg outline-none transition placeholder:text-fg-faint focus:ring-2 focus:ring-accent/50",
          error ? "border-danger" : "border-border focus:border-accent",
          className,
        )}
        aria-invalid={Boolean(error)}
        {...props}
      />
      {error ? <span className="mt-1.5 block text-sm text-danger">{error}</span> : hint ? <span className="mt-1.5 block text-xs text-fg-faint">{hint}</span> : null}
    </label>
  );
});
