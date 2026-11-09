import { useEffect, useState } from "react";
import { serverNow } from "./api";

export function ago(ts: number, now = serverNow()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** Approximate time left: "21h", "43m", "<1m". */
export function left(expiresAt: number, now = serverNow()): string {
  const s = Math.max(0, Math.floor((expiresAt - now) / 1000));
  if (s < 60) return "<1m";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  // Round up so "posted 3h ago • disappears in 21h" adds up to 24.
  return h < 3 ? `${h}h ${m % 60}m` : `${Math.ceil(s / 3600)}h`;
}

export const joined = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "long", year: "numeric" });

/** Re-render every `ms` so relative times and countdowns stay fresh. */
export function useTick(ms = 30_000): number {
  const [t, setT] = useState(serverNow);
  useEffect(() => {
    const id = setInterval(() => setT(serverNow()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}
