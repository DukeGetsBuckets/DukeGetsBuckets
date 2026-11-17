import type { ClockState, PlayerColor } from "@tempo/shared";

export interface RawClock {
  whiteMs: number;
  blackMs: number;
  running: boolean;
  /** Epoch ms when the active side's clock last (re)started. */
  lastClockAt: number | null;
}

/** Remaining time for each side at `now`, charging elapsed time to the active side only. */
export function computeClock(raw: RawClock, sideToMove: PlayerColor, now: number): ClockState {
  let { whiteMs, blackMs } = raw;
  if (raw.running && raw.lastClockAt != null) {
    const elapsed = Math.max(0, now - raw.lastClockAt);
    if (sideToMove === "white") whiteMs -= elapsed;
    else blackMs -= elapsed;
  }
  return {
    whiteMs: Math.max(0, Math.round(whiteMs)),
    blackMs: Math.max(0, Math.round(blackMs)),
    running: raw.running,
    active: raw.running ? sideToMove : null,
    serverTime: now,
  };
}

/** Milliseconds until the active side flags (Infinity when the clock is stopped). */
export function msUntilFlag(raw: RawClock, sideToMove: PlayerColor, now: number): number {
  if (!raw.running || raw.lastClockAt == null) return Infinity;
  const remaining = sideToMove === "white" ? raw.whiteMs : raw.blackMs;
  return remaining - (now - raw.lastClockAt);
}
