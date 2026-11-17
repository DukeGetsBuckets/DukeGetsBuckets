import type { PlayerColor } from "./types";

export function otherColor(c: PlayerColor): PlayerColor {
  return c === "white" ? "black" : "white";
}

export function formatClock(ms: number, opts: { showTenths?: boolean } = {}): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const showTenths = opts.showTenths ?? clamped < 10_000;
  if (showTenths && minutes === 0) {
    const tenths = Math.floor((clamped % 1000) / 100);
    return `${seconds}.${tenths}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Compare two user ids to produce a stable undirected pair ordering. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function normalizeUsername(u: string): string {
  return u.trim().toLowerCase();
}

export function resultForColor(result: "WHITE_WINS" | "BLACK_WINS" | "DRAW" | null, color: PlayerColor): "win" | "loss" | "draw" | null {
  if (!result) return null;
  if (result === "DRAW") return "draw";
  const whiteWon = result === "WHITE_WINS";
  return (color === "white") === whiteWon ? "win" : "loss";
}
