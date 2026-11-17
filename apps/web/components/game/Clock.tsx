"use client";

import * as React from "react";
import { formatClock, type ClockState } from "@tempo/shared";
import { cn } from "@/lib/cn";
import { playSound } from "@/lib/sounds";

/** Smoothly interpolates the authoritative clock between server syncs. */
export function useClockDisplay(clock: ClockState & { receivedAt: number }, color: "white" | "black", enabled = true): number {
  const base = color === "white" ? clock.whiteMs : clock.blackMs;
  const active = clock.running && clock.active === color;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active || !enabled) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      // ~10 fps normally, every frame under 10 seconds for tenths.
      const remaining = base - (Date.now() - clock.receivedAt);
      const interval = remaining < 10_000 ? 50 : 100;
      if (t - last >= interval) {
        last = t;
        setNow(Date.now());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, enabled, base, clock.receivedAt]);
  if (!active) return Math.max(0, base);
  return Math.max(0, base - (now - clock.receivedAt));
}

export function Clock({ clock, color, soundsEnabled, compact }: { clock: ClockState & { receivedAt: number }; color: "white" | "black"; soundsEnabled: boolean; compact?: boolean }) {
  const ms = useClockDisplay(clock, color);
  const active = clock.running && clock.active === color;
  const low = ms < 20_000 && clock.running;
  const warned = React.useRef(false);
  React.useEffect(() => {
    if (active && ms < 10_000 && ms > 0 && !warned.current) {
      warned.current = true;
      if (soundsEnabled) playSound("lowTime");
    }
    if (ms > 10_000) warned.current = false;
  }, [ms, active, soundsEnabled]);
  return (
    <div
      className={cn(
        "clock-digits rounded-xl border px-3 text-right font-semibold tabular-nums transition-colors",
        compact ? "min-w-[5.25rem] py-1.5 text-2xl" : "min-w-[6rem] py-2 text-3xl",
        active ? "border-accent bg-accent text-accent-fg shadow-[0_0_0_3px_var(--accent-soft)]" : "border-border bg-surface-2 text-fg-muted",
        low && active && "animate-pulse border-danger bg-danger text-white",
      )}
      aria-label={`${color} clock`}
      aria-live={active ? "off" : undefined}
    >
      {formatClock(ms)}
    </div>
  );
}
