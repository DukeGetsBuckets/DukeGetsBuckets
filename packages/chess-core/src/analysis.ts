/**
 * Engine-derived metrics: win-chance mapping, per-move accuracy, game accuracy and move classification.
 *
 * These are Tempo's own, documented heuristics (see docs/ANALYSIS.md). They are inspired by publicly
 * described approaches (e.g. lichess' open-source accuracy model) and are NOT a replica of any
 * proprietary review algorithm.
 */

export interface EngineScore {
  /** Centipawns from White's point of view; null when a mate score applies. */
  cp: number | null;
  /** Signed plies-to-mate from White's point of view (positive = White mates). */
  mate: number | null;
}

export type Classification =
  | "BRILLIANT"
  | "GREAT"
  | "BEST"
  | "EXCELLENT"
  | "GOOD"
  | "BOOK"
  | "INACCURACY"
  | "MISTAKE"
  | "BLUNDER"
  | "FORCED";

/** Mate scores map to a large centipawn equivalent for monotonic comparisons. */
export const MATE_CP = 10_000;

export function scoreToCp(score: EngineScore): number {
  if (score.mate != null && score.mate !== 0) {
    // Nearer mates are better: mate in 1 → 9999, mate in 20 → 9980.
    const sign = score.mate > 0 ? 1 : -1;
    return sign * (MATE_CP - Math.min(Math.abs(score.mate), 999));
  }
  return score.cp ?? 0;
}

/**
 * Win probability (0–100) for White given a white-POV centipawn evaluation.
 * Logistic curve with k = 0.00368208 (fitted on large engine datasets, as used by lichess).
 */
export function winChanceFromCp(cp: number): number {
  const clamped = Math.max(-MATE_CP, Math.min(MATE_CP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

export function winChance(score: EngineScore): number {
  if (score.mate != null && score.mate !== 0) return score.mate > 0 ? 100 : 0;
  return winChanceFromCp(score.cp ?? 0);
}

/** Win chance from the perspective of `color`. */
export function winChanceFor(score: EngineScore, color: "w" | "b"): number {
  const w = winChance(score);
  return color === "w" ? w : 100 - w;
}

/**
 * Accuracy of a single move (0–100) from the drop in the mover's win chance.
 * accuracy = 103.1668 · e^(−0.04354·Δ) − 3.1669, clamped. Δ = winBefore − winAfter (mover POV).
 */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  const drop = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export interface ClassifyInput {
  /** Evaluation of the position before the move (white POV). */
  before: EngineScore;
  /** Evaluation of the position after the played move (white POV). */
  after: EngineScore;
  /** Evaluation after the engine's best move (white POV) — i.e. the best achievable. */
  bestAfter: EngineScore;
  /** Evaluation after the engine's second-best move, if known (white POV). */
  secondBestAfter?: EngineScore | null;
  mover: "w" | "b";
  playedIsBest: boolean;
  legalMoveCount: number;
  isBook: boolean;
  /** Material (pawn units) the mover gave up with this move that is not immediately recovered in the PV. */
  sacrificedMaterial: number;
}

export interface ClassifyOutput {
  classification: Classification;
  winBefore: number;
  winAfter: number;
  /** Win-chance lost by the mover (0 when the move improved the position per the engine). */
  winDrop: number;
  /** Centipawn loss relative to the best move (mover POV, ≥ 0). */
  cpLoss: number;
}

export const CLASSIFICATION_THRESHOLDS = {
  excellent: 2,
  good: 5,
  inaccuracy: 10,
  mistake: 20,
  /** Gap between best and second-best (mover win %) that makes a move "critical". */
  criticalGap: 10,
  /** Brilliancies require at least this much sacrificed material (pawn units). */
  brilliantMinSacrifice: 2,
  /** No brilliancies/greats when already overwhelmingly winning. */
  decidedWin: 92,
} as const;

/**
 * Classify a move using engine evaluations before/after and the alternatives.
 * Precedence: FORCED → BOOK → BRILLIANT → GREAT → BEST → EXCELLENT/GOOD/INACCURACY/MISTAKE/BLUNDER,
 * with special handling for missed and allowed forced mates.
 */
export function classifyMove(input: ClassifyInput): ClassifyOutput {
  const { mover } = input;
  const winBefore = winChanceFor(input.bestAfter, mover); // best achievable from the position
  const winAfter = winChanceFor(input.after, mover);
  const winDrop = Math.max(0, winBefore - winAfter);
  const bestCp = scoreToCp(input.bestAfter) * (mover === "w" ? 1 : -1);
  const playedCp = scoreToCp(input.after) * (mover === "w" ? 1 : -1);
  const cpLoss = Math.max(0, Math.min(2000, bestCp - playedCp));
  const base = { winBefore, winAfter, winDrop, cpLoss };

  if (input.legalMoveCount <= 1) return { classification: "FORCED", ...base };
  if (input.isBook) return { classification: "BOOK", ...base };

  const moverMateBefore = input.before.mate != null && input.before.mate !== 0 && (input.before.mate > 0) === (mover === "w");
  const opponentMateAfter = input.after.mate != null && input.after.mate !== 0 && (input.after.mate > 0) !== (mover === "w");
  const moverMateAfter = input.after.mate != null && input.after.mate !== 0 && (input.after.mate > 0) === (mover === "w");

  // Allowed a forced mate from a position that was not already lost: always a blunder.
  const wasLost = winChanceFor(input.before, mover) < 5;
  if (opponentMateAfter && !wasLost) return { classification: "BLUNDER", ...base };

  // Missed a forced mate: still winning, but never better than an inaccuracy.
  if (moverMateBefore && !moverMateAfter) {
    const classification: Classification = playedCp >= 300 ? "INACCURACY" : "MISTAKE";
    return { classification, ...base };
  }

  const secondWin = input.secondBestAfter ? winChanceFor(input.secondBestAfter, mover) : null;
  const criticalGap = secondWin != null ? winBefore - secondWin : 0;
  const nearBest = input.playedIsBest || winDrop <= 1;

  if (nearBest && winBefore < CLASSIFICATION_THRESHOLDS.decidedWin && winAfter >= 40) {
    const soundSacrifice = input.sacrificedMaterial >= CLASSIFICATION_THRESHOLDS.brilliantMinSacrifice;
    if (soundSacrifice && criticalGap >= CLASSIFICATION_THRESHOLDS.criticalGap) {
      return { classification: "BRILLIANT", ...base };
    }
    if (criticalGap >= CLASSIFICATION_THRESHOLDS.criticalGap && winBefore >= 15) {
      return { classification: "GREAT", ...base };
    }
  }

  if (input.playedIsBest || cpLoss === 0) return { classification: "BEST", ...base };
  if (winDrop <= CLASSIFICATION_THRESHOLDS.excellent) return { classification: "EXCELLENT", ...base };
  if (winDrop <= CLASSIFICATION_THRESHOLDS.good) return { classification: "GOOD", ...base };
  if (winDrop <= CLASSIFICATION_THRESHOLDS.inaccuracy) return { classification: "INACCURACY", ...base };
  if (winDrop <= CLASSIFICATION_THRESHOLDS.mistake) return { classification: "MISTAKE", ...base };
  return { classification: "BLUNDER", ...base };
}

export interface GameAccuracyInput {
  /** Win chances (white POV) for every position of the game: length = plies + 1. */
  winChances: number[];
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function harmonicMean(values: number[]): number {
  if (!values.length) return 0;
  const sum = values.reduce((a, b) => a + 1 / Math.max(b, 0.01), 0);
  return values.length / sum;
}

/**
 * Game accuracy per side (0–100). Each move's accuracy is weighted by the volatility of the
 * position (std-dev of win chances in a sliding window), so quiet "any move works" positions
 * weigh less than sharp ones. Final = mean of the volatility-weighted average and the harmonic mean.
 * Returns null for a side that made no moves.
 */
export function gameAccuracy(input: GameAccuracyInput): { white: number | null; black: number | null } {
  const wc = input.winChances;
  const plies = wc.length - 1;
  if (plies < 1) return { white: null, black: null };
  const windowSize = Math.max(2, Math.min(8, Math.ceil(plies / 10)));
  const weights: number[] = [];
  for (let i = 0; i < plies; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const window = wc.slice(start, Math.min(wc.length, start + windowSize + 1));
    weights.push(Math.max(0.5, Math.min(12, stdDev(window))));
  }
  const perSide = (color: "w" | "b"): number | null => {
    const accs: number[] = [];
    const ws: number[] = [];
    for (let i = 0; i < plies; i++) {
      const moverIsWhite = i % 2 === 0;
      if ((color === "w") !== moverIsWhite) continue;
      const before = moverIsWhite ? wc[i]! : 100 - wc[i]!;
      const after = moverIsWhite ? wc[i + 1]! : 100 - wc[i + 1]!;
      accs.push(moveAccuracy(before, after));
      ws.push(weights[i]!);
    }
    if (!accs.length) return null;
    const weighted = accs.reduce((a, acc, i) => a + acc * ws[i]!, 0) / ws.reduce((a, b) => a + b, 0);
    const harmonic = harmonicMean(accs);
    return Math.round(((weighted + harmonic) / 2) * 10) / 10;
  };
  return { white: perSide("w"), black: perSide("b") };
}

/** Average centipawn loss for a side, capping individual losses at 1000. */
export function averageCentipawnLoss(cpLosses: (number | null)[], color: "w" | "b"): number | null {
  const values: number[] = [];
  cpLosses.forEach((loss, i) => {
    const moverIsWhite = i % 2 === 0;
    if ((color === "w") !== moverIsWhite || loss == null) return;
    values.push(Math.min(1000, Math.max(0, loss)));
  });
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

export function formatEval(score: EngineScore): string {
  if (score.mate != null && score.mate !== 0) return `M${Math.abs(score.mate)}`;
  const pawns = (score.cp ?? 0) / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}
