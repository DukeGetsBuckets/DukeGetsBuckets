import { Chess, type Color as ChessColor, type Square } from "chess.js";

export type Color = "w" | "b";
export type GameResult = "WHITE_WINS" | "BLACK_WINS" | "DRAW";
export type GameEndReason =
  | "CHECKMATE"
  | "RESIGNATION"
  | "TIMEOUT"
  | "TIMEOUT_VS_INSUFFICIENT_MATERIAL"
  | "STALEMATE"
  | "INSUFFICIENT_MATERIAL"
  | "THREEFOLD_REPETITION"
  | "FIVEFOLD_REPETITION"
  | "FIFTY_MOVE_RULE"
  | "SEVENTY_FIVE_MOVE_RULE"
  | "AGREEMENT"
  | "ABANDONED"
  | "ABORTED";

export interface Adjudication {
  over: boolean;
  result?: GameResult;
  reason?: GameEndReason;
  /** Draws the side to move may claim (not automatic). */
  claimable: GameEndReason[];
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Position key ignoring move counters (used for repetition and opening lookup). */
export function positionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/**
 * Count how many times the current position has occurred in the game (including now).
 * chess.js only exposes threefold; we replay history to support fivefold.
 */
export function repetitionCount(chess: Chess): number {
  const target = positionKey(chess.fen());
  const replay = new Chess(chess.getHeaders()["FEN"] ?? START_FEN);
  let count = positionKey(replay.fen()) === target ? 1 : 0;
  for (const move of chess.history({ verbose: true })) {
    replay.move(move.san);
    if (positionKey(replay.fen()) === target) count++;
  }
  return count;
}

export function halfmoveClock(chess: Chess): number {
  return Number(chess.fen().split(" ")[4] ?? 0);
}

/**
 * Determine whether the game is over according to standard rules.
 *
 * Automatic endings: checkmate, stalemate, insufficient material (dead position per chess.js),
 * fivefold repetition and the 75-move rule (FIDE 9.6).
 * Claimable draws: threefold repetition and the 50-move rule (FIDE 9.2 / 9.3) — the side to move may claim.
 */
export function adjudicate(chess: Chess): Adjudication {
  const claimable: GameEndReason[] = [];
  if (chess.isCheckmate()) {
    return { over: true, result: chess.turn() === "w" ? "BLACK_WINS" : "WHITE_WINS", reason: "CHECKMATE", claimable };
  }
  if (chess.isStalemate()) return { over: true, result: "DRAW", reason: "STALEMATE", claimable };
  if (chess.isInsufficientMaterial()) return { over: true, result: "DRAW", reason: "INSUFFICIENT_MATERIAL", claimable };
  const hm = halfmoveClock(chess);
  if (hm >= 150) return { over: true, result: "DRAW", reason: "SEVENTY_FIVE_MOVE_RULE", claimable };
  const reps = repetitionCount(chess);
  if (reps >= 5) return { over: true, result: "DRAW", reason: "FIVEFOLD_REPETITION", claimable };
  if (reps >= 3) claimable.push("THREEFOLD_REPETITION");
  if (hm >= 100) claimable.push("FIFTY_MOVE_RULE");
  return { over: false, claimable };
}

/**
 * Whether `color` has enough material to deliver checkmate by any sequence of legal moves.
 * Used for timeouts: a player who runs out of time loses only if the opponent could still mate;
 * otherwise the game is drawn (FIDE 6.9).
 *
 * Insufficient: lone king; king + single minor piece; king + bishops all on the same square colour.
 * Two knights (or more), any pawn, rook or queen count as sufficient because a mate is legally reachable.
 */
export function hasMatingMaterial(chess: Chess, color: Color): boolean {
  const board = chess.board();
  let knights = 0;
  const bishopSquareColors = new Set<number>();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r]?.[f];
      if (!piece || piece.color !== color) continue;
      switch (piece.type) {
        case "p":
        case "r":
        case "q":
          return true;
        case "n":
          knights++;
          break;
        case "b":
          bishopSquareColors.add((r + f) % 2);
          break;
        default:
          break;
      }
    }
  }
  if (knights >= 2) return true;
  if (knights === 1 && bishopSquareColors.size > 0) return true;
  if (knights === 1) return false;
  return bishopSquareColors.size >= 2;
}

/** Outcome when `flagged` runs out of time. */
export function timeoutOutcome(chess: Chess, flagged: Color): { result: GameResult; reason: GameEndReason } {
  const opponent: Color = flagged === "w" ? "b" : "w";
  if (!hasMatingMaterial(chess, opponent)) {
    return { result: "DRAW", reason: "TIMEOUT_VS_INSUFFICIENT_MATERIAL" };
  }
  return { result: flagged === "w" ? "BLACK_WINS" : "WHITE_WINS", reason: "TIMEOUT" };
}

export function toChessColor(c: "white" | "black"): ChessColor {
  return c === "white" ? "w" : "b";
}
export function fromChessColor(c: ChessColor): "white" | "black" {
  return c === "w" ? "white" : "black";
}

export interface UciParts {
  from: Square;
  to: Square;
  promotion?: "q" | "r" | "b" | "n";
}

export function parseUci(uci: string): UciParts | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (!m) return null;
  const parts: UciParts = { from: m[1] as Square, to: m[2] as Square };
  if (m[3]) parts.promotion = m[3] as UciParts["promotion"];
  return parts;
}

export function moveToUci(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

export interface AppliedMove {
  uci: string;
  san: string;
  fenBefore: string;
  fenAfter: string;
  capture: boolean;
  check: boolean;
  promotion: boolean;
  castle: boolean;
  enPassant: boolean;
}

/**
 * Try to apply a UCI move to the position. Returns null when illegal. Never throws.
 */
export function applyUci(chess: Chess, uci: string): AppliedMove | null {
  const parts = parseUci(uci);
  if (!parts) return null;
  const fenBefore = chess.fen();
  try {
    const move = chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
    return {
      uci: moveToUci(move),
      san: move.san,
      fenBefore,
      fenAfter: chess.fen(),
      capture: move.isCapture() || move.isEnPassant(),
      check: chess.inCheck(),
      promotion: move.isPromotion(),
      castle: move.isKingsideCastle() || move.isQueensideCastle(),
      enPassant: move.isEnPassant(),
    };
  } catch {
    return null;
  }
}

/** Legal UCI moves for the side to move (optionally from a given square). */
export function legalUciMoves(chess: Chess, from?: Square): string[] {
  const moves = from ? chess.moves({ square: from, verbose: true }) : chess.moves({ verbose: true });
  return moves.map(moveToUci);
}

/** Whether moving a piece from `from` to `to` would be a pawn promotion in this position. */
export function isPromotionMove(chess: Chess, from: Square, to: Square): boolean {
  const piece = chess.get(from);
  if (!piece || piece.type !== "p") return false;
  const rank = to[1];
  return (piece.color === "w" && rank === "8") || (piece.color === "b" && rank === "1");
}

/**
 * Convert UCI to SAN in the given position without mutating the position. Returns null if illegal.
 */
export function uciToSan(fen: string, uci: string): string | null {
  const c = new Chess(fen);
  const applied = applyUci(c, uci);
  return applied?.san ?? null;
}

export function sanToUci(fen: string, san: string): string | null {
  const c = new Chess(fen);
  try {
    const move = c.move(san);
    return moveToUci(move);
  } catch {
    return null;
  }
}

/** Replay a list of UCI moves from a FEN. Throws on the first illegal move. */
export function replayUci(moves: string[], fen: string = START_FEN): Chess {
  const chess = new Chess(fen);
  for (const uci of moves) {
    if (!applyUci(chess, uci)) throw new Error(`Illegal move ${uci} at ply ${chess.history().length}`);
  }
  return chess;
}

export function fensFromUci(moves: string[], fen: string = START_FEN): string[] {
  const chess = new Chess(fen);
  const fens = [chess.fen()];
  for (const uci of moves) {
    if (!applyUci(chess, uci)) throw new Error(`Illegal move ${uci}`);
    fens.push(chess.fen());
  }
  return fens;
}

export interface MaterialCount {
  p: number;
  n: number;
  b: number;
  r: number;
  q: number;
}

export const PIECE_VALUES: Record<keyof MaterialCount, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export function materialFor(chess: Chess, color: Color): MaterialCount {
  const count: MaterialCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.color === color && piece.type !== "k") count[piece.type]++;
    }
  }
  return count;
}

export function materialValue(m: MaterialCount): number {
  return m.p * PIECE_VALUES.p + m.n * PIECE_VALUES.n + m.b * PIECE_VALUES.b + m.r * PIECE_VALUES.r + m.q * PIECE_VALUES.q;
}

/** Pieces captured so far by each side, derived from the current position vs. the starting army. */
export function capturedPieces(chess: Chess): { byWhite: MaterialCount; byBlack: MaterialCount } {
  const start: MaterialCount = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const white = materialFor(chess, "w");
  const black = materialFor(chess, "b");
  const diff = (a: MaterialCount, b: MaterialCount): MaterialCount => ({
    p: Math.max(0, a.p - b.p),
    n: Math.max(0, a.n - b.n),
    b: Math.max(0, a.b - b.b),
    r: Math.max(0, a.r - b.r),
    q: Math.max(0, a.q - b.q),
  });
  return { byWhite: diff(start, black), byBlack: diff(start, white) };
}

export { Chess };
export type { Square };
