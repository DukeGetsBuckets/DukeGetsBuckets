/**
 * Parsing for the subset of UCI output the in-browser engine produces. Pure functions, no DOM.
 */

/** Engine score from the side to move's point of view (the way UCI reports it). */
export interface UciScore {
  cp: number | null;
  mate: number | null;
}

export interface InfoLine {
  depth: number;
  seldepth: number | null;
  multipv: number;
  score: UciScore;
  /** Fail-high/fail-low lines carry a bound; their score is not exact. */
  bound: "lower" | "upper" | null;
  nodes: number | null;
  nps: number | null;
  timeMs: number | null;
  pv: string[];
}

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Parses an `info … score … pv …` line. Returns null for lines without a score and principal
 * variation (`info string`, `currmove` progress, `hashfull`-only lines and so on).
 */
export function parseInfoLine(line: string): InfoLine | null {
  if (!line.startsWith("info ")) return null;
  const t = line.trim().split(/\s+/);
  let depth: number | null = null;
  let seldepth: number | null = null;
  let multipv = 1;
  let cp: number | null = null;
  let mate: number | null = null;
  let bound: InfoLine["bound"] = null;
  let nodes: number | null = null;
  let nps: number | null = null;
  let timeMs: number | null = null;
  let pv: string[] = [];
  for (let i = 1; i < t.length; i++) {
    const key = t[i];
    switch (key) {
      case "string":
        return null;
      case "depth":
        depth = Number(t[++i]);
        break;
      case "seldepth":
        seldepth = Number(t[++i]);
        break;
      case "multipv":
        multipv = Number(t[++i]);
        break;
      case "score": {
        const kind = t[++i];
        const value = Number(t[++i]);
        if (kind === "cp") cp = value;
        else if (kind === "mate") mate = value;
        if (t[i + 1] === "lowerbound" || t[i + 1] === "upperbound") bound = t[++i] === "lowerbound" ? "lower" : "upper";
        break;
      }
      case "nodes":
        nodes = Number(t[++i]);
        break;
      case "nps":
        nps = Number(t[++i]);
        break;
      case "time":
        timeMs = Number(t[++i]);
        break;
      case "pv":
        pv = t.slice(i + 1).filter((m) => UCI_MOVE.test(m));
        i = t.length;
        break;
      default:
        break;
    }
  }
  if (depth == null || !Number.isFinite(depth) || (cp == null && mate == null) || pv.length === 0) return null;
  return { depth, seldepth, multipv: Number.isFinite(multipv) && multipv > 0 ? multipv : 1, score: { cp, mate }, bound, nodes, nps, timeMs, pv };
}

/** Parses `bestmove e2e4 [ponder e7e5]`. `bestmove (none)` (no legal moves) gives `best: null`. */
export function parseBestMove(line: string): { best: string | null; ponder: string | null } | null {
  if (!line.startsWith("bestmove")) return null;
  const t = line.trim().split(/\s+/);
  const best = t[1] && UCI_MOVE.test(t[1]) ? t[1] : null;
  const ponderIdx = t.indexOf("ponder");
  const ponder = ponderIdx > 0 && t[ponderIdx + 1] && UCI_MOVE.test(t[ponderIdx + 1]!) ? t[ponderIdx + 1]! : null;
  return { best, ponder };
}

/** Reads the `UCI_Elo` spin range from an `option name UCI_Elo type spin default … min … max …` line. */
export function parseEloOption(line: string): { min: number; max: number } | null {
  const m = /^option name UCI_Elo type spin default -?\d+ min (\d+) max (\d+)/.exec(line.trim());
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

/** Converts a side-to-move score into White's point of view. */
export function toWhitePov(score: UciScore, sideToMove: "w" | "b"): UciScore {
  if (sideToMove === "w") return { cp: score.cp, mate: score.mate };
  return { cp: score.cp == null ? null : -score.cp, mate: score.mate == null ? null : -score.mate };
}
