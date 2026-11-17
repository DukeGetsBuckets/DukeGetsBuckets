import type { PlayerColor } from "./types";

export type Classification = "BRILLIANT" | "GREAT" | "BEST" | "EXCELLENT" | "GOOD" | "BOOK" | "INACCURACY" | "MISTAKE" | "BLUNDER" | "FORCED";
export type AnalysisStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface EngineScoreDTO {
  cp: number | null;
  mate: number | null;
}

export interface MoveAnalysisDTO {
  ply: number;
  color: PlayerColor;
  fenBefore: string;
  playedUci: string;
  playedSan: string;
  bestUci: string | null;
  bestSan: string | null;
  /** White-POV evaluation of the position before the move. */
  evalBefore: EngineScoreDTO;
  /** White-POV evaluation of the position after the move. */
  evalAfter: EngineScoreDTO;
  /** Principal variation (UCI) from the position before the move. */
  pv: string[];
  pvSan: string[];
  /** Alternative engine lines from the position before the move. */
  altLines: { uci: string; san: string; score: EngineScoreDTO; pv: string[] }[];
  cpLoss: number | null;
  winChanceBefore: number;
  winChanceAfter: number;
  classification: Classification;
  explanation: string | null;
  isBook: boolean;
  depth: number | null;
  /** Clock time spent on the move (ms), when available. */
  spentMs?: number;
}

export interface ClassificationCounts {
  BRILLIANT: number;
  GREAT: number;
  BEST: number;
  EXCELLENT: number;
  GOOD: number;
  BOOK: number;
  INACCURACY: number;
  MISTAKE: number;
  BLUNDER: number;
  FORCED: number;
}

export interface SideSummary {
  accuracy: number | null;
  acpl: number | null;
  counts: ClassificationCounts;
  bestMovePct: number | null;
  moves: number;
}

export interface AnalysisSummary {
  white: SideSummary;
  black: SideSummary;
  /** Ply with the largest swing in winning chances. */
  turningPoint: { ply: number; san: string; color: PlayerColor; swing: number } | null;
  opening: { eco: string | null; name: string | null; lastBookPly: number } | null;
  /** White-POV win chance after each position, index 0 = starting position. */
  winChances: number[];
  /** White-POV evaluations per position (index 0 = start). */
  evals: EngineScoreDTO[];
  engine: { name: string; version: string | null; depth: number; multipv: number };
  durationMs: number;
}

export interface CoachingMistake {
  ply: number;
  san: string;
  color: PlayerColor;
  classification: Classification;
  bestSan: string | null;
  winDrop: number;
  theme: string;
  explanation: string;
}

export interface CoachingReport {
  /** Which side the report is written for. */
  color: PlayerColor;
  didWell: string[];
  biggestMistakes: CoachingMistake[];
  practice: string[];
  turningPoint: { ply: number; san: string; text: string } | null;
  openingInsight: string;
  lesson: string;
  themes: { theme: string; count: number }[];
  source: "deterministic" | "ai";
}

export interface GameAnalysisDTO {
  gameId: string;
  status: AnalysisStatus;
  progress: number;
  error: string | null;
  engine: string;
  engineVersion: string | null;
  config: { depth: number; multipv: number; movetimeMs: number };
  whiteAccuracy: number | null;
  blackAccuracy: number | null;
  whiteAcpl: number | null;
  blackAcpl: number | null;
  summary: AnalysisSummary | null;
  coaching: { white: CoachingReport; black: CoachingReport } | null;
  moves: MoveAnalysisDTO[];
  createdAt: string;
  completedAt: string | null;
}

export interface TrainingPositionDTO {
  id: string;
  gameId: string;
  ply: number;
  fen: string;
  sideToMove: PlayerColor;
  playedUci: string;
  playedSan: string;
  bestUci: string;
  bestSan: string;
  acceptableMoves: { uci: string; san: string; score: EngineScoreDTO }[];
  cpLoss: number;
  classification: Classification;
  theme: string | null;
  explanation: string | null;
  status: "NEW" | "SOLVED" | "FAILED" | "REVIEW" | "SKIPPED";
  attempts: number;
  hintsUsed: number;
  solvedAt: string | null;
  createdAt: string;
  opponent: string;
  /** White-POV eval before the move, for context. */
  evalBefore: EngineScoreDTO;
}

/** BullMQ job payloads shared by the web app (producer) and the worker (consumer). */
export type AnalysisJobData =
  | { type: "game"; gameId: string; requestedById: string | null }
  | { type: "position"; fen: string; depth: number; multipv: number };

export const ANALYSIS_QUEUE = "analysis";
export const POSITION_QUEUE = "position";

export const THEME_LABELS: Record<string, string> = {
  "hanging-piece": "Hanging pieces",
  "missed-tactic": "Missed tactics",
  "king-safety": "King safety",
  "allowed-mate": "Allowing mate",
  "missed-mate": "Missed mates",
  "opening-development": "Opening development",
  "endgame-technique": "Endgame technique",
  "piece-activity": "Piece activity",
  "pawn-structure": "Pawn structure",
  "time-trouble": "Time management",
  "converting-advantage": "Converting winning positions",
  "defence": "Defensive accuracy",
  "material": "Material management",
  "center-control": "Center control",
  "threat-recognition": "Recognising threats",
};
