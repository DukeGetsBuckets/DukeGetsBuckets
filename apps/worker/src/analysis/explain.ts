import { Chess } from "chess.js";
import { applyUci, materialFor, materialValue, type Color } from "@tempo/chess-core";
import type { Classification, EngineScoreDTO } from "@tempo/shared";

export interface MoveFacts {
  ply: number;
  mover: Color;
  fenBefore: string;
  fenAfter: string;
  playedUci: string;
  playedSan: string;
  bestUci: string | null;
  bestSan: string | null;
  /** White-POV scores. */
  before: EngineScoreDTO;
  after: EngineScoreDTO;
  bestAfter: EngineScoreDTO;
  secondBestAfter: EngineScoreDTO | null;
  /** PV from the position before the move (starts with the best move). */
  bestPvSan: string[];
  /** PV from the position after the played move (starts with the opponent's best reply). */
  replyPvSan: string[];
  replyPvUci: string[];
  classification: Classification;
  winBefore: number;
  winAfter: number;
  winDrop: number;
  cpLoss: number;
  openingName: string | null;
  spentMs: number | undefined;
  initialTimeMs: number;
  remainingMsAfter: number | undefined;
  sacrificedMaterial: number;
}

export function pvToSan(fen: string, pv: string[], max = 8): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, max)) {
    const m = applyUci(c, uci);
    if (!m) break;
    out.push(m.san);
  }
  return out;
}

/** Material balance for `color` (own minus opponent, pawn units). */
function balance(chess: Chess, color: Color): number {
  const other: Color = color === "w" ? "b" : "w";
  return materialValue(materialFor(chess, color)) - materialValue(materialFor(chess, other));
}

/**
 * Material the mover gives up with this move that the engine's expected continuation does not win back
 * within four plies. Used for brilliancy detection; also reports whether the move simply hung material.
 */
export function materialOutcome(fenBefore: string, playedUci: string, replyPvUci: string[]): { sacrificed: number; minBalanceDelta: number } {
  const chess = new Chess(fenBefore);
  const mover = chess.turn();
  const start = balance(chess, mover);
  if (!applyUci(chess, playedUci)) return { sacrificed: 0, minBalanceDelta: 0 };
  let min = balance(chess, mover) - start;
  for (const uci of replyPvUci.slice(0, 4)) {
    if (!applyUci(chess, uci)) break;
    min = Math.min(min, balance(chess, mover) - start);
  }
  // Balance after the expected sequence settles (end of the 4 plies).
  const end = balance(chess, mover) - start;
  return { sacrificed: Math.max(0, -end), minBalanceDelta: min };
}

function isCheckSan(san: string | undefined): boolean {
  return Boolean(san && (san.includes("+") || san.includes("#")));
}
function isCaptureSan(san: string | undefined): boolean {
  return Boolean(san && san.includes("x"));
}

function pieceName(fen: string, square: string): string {
  const p = new Chess(fen).get(square as never);
  if (!p) return "piece";
  return { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" }[p.type];
}

function totalNonPawnMaterial(fen: string): number {
  const c = new Chess(fen);
  const w = materialFor(c, "w");
  const b = materialFor(c, "b");
  return (w.n + b.n + w.b + b.b) * 3 + (w.r + b.r) * 5 + (w.q + b.q) * 9;
}

function isDevelopingMove(fenBefore: string, uci: string, mover: Color): boolean {
  const c = new Chess(fenBefore);
  const from = uci.slice(0, 2);
  const piece = c.get(from as never);
  if (!piece) return false;
  const homeRank = mover === "w" ? "1" : "8";
  if ((piece.type === "n" || piece.type === "b") && from[1] === homeRank) return true;
  if (piece.type === "k" && Math.abs(from.charCodeAt(0) - uci.charCodeAt(2)) === 2) return true; // castling
  if (piece.type === "p" && (from[0] === "d" || from[0] === "e")) return true;
  return false;
}

export interface Explanation {
  text: string;
  theme: string | null;
}

/** Deterministic, engine-grounded explanation and training theme for a move. */
export function explainMove(f: MoveFacts): Explanation {
  const you = f.mover === "w" ? "White" : "Black";
  const opp = f.mover === "w" ? "Black" : "White";
  const reply = f.replyPvSan[0];
  const bestLine = f.bestPvSan.slice(0, 4).join(" ");
  const opponentMatesAfter = f.after.mate != null && f.after.mate !== 0 && (f.after.mate > 0) !== (f.mover === "w");
  const moverHadMate = f.before.mate != null && f.before.mate !== 0 && (f.before.mate > 0) === (f.mover === "w");
  const moverMatesAfter = f.after.mate != null && f.after.mate !== 0 && (f.after.mate > 0) === (f.mover === "w");
  const { minBalanceDelta } = materialOutcome(f.fenBefore, f.playedUci, f.replyPvUci);
  const bestMaterial = f.bestUci ? materialOutcome(f.fenBefore, f.bestUci, f.bestPvSanToUci ?? []) : null;
  const lowTime = f.remainingMsAfter != null && f.initialTimeMs > 0 && f.remainingMsAfter < f.initialTimeMs * 0.1;
  const endgame = totalNonPawnMaterial(f.fenBefore) <= 26 && f.ply > 30;

  switch (f.classification) {
    case "BOOK":
      return { text: f.openingName ? `${f.playedSan} is a known theory move in the ${f.openingName}.` : `${f.playedSan} follows established opening theory.`, theme: null };
    case "FORCED":
      return { text: `${f.playedSan} was the only legal move.`, theme: null };
    case "BRILLIANT":
      return {
        text: `A sound sacrifice: ${f.playedSan} gives up material, yet it is the engine's top choice and the only move that keeps ${you}'s advantage (${bestLine}).`,
        theme: null,
      };
    case "GREAT": {
      const alt = f.secondBestAfter ? ` Every alternative loses at least ${Math.round(f.winBefore - winFor(f.secondBestAfter, f.mover))}% of the winning chances.` : "";
      return { text: `${f.playedSan} was the critical move — the only way to maintain the position.${alt}`, theme: null };
    }
    case "BEST":
      if (moverMatesAfter && f.after.mate != null) return { text: `${f.playedSan} keeps the forced mate in ${Math.abs(f.after.mate)}.`, theme: null };
      return { text: `${f.playedSan} was the engine's top choice.`, theme: null };
    case "EXCELLENT":
      return { text: `${f.playedSan} is practically as good as the best move ${f.bestSan ?? ""}.`.trim(), theme: null };
    case "GOOD":
      return { text: `${f.playedSan} is a reasonable move, though ${f.bestSan ?? "the engine's line"} was slightly more precise.`, theme: null };
    default:
      break;
  }

  // INACCURACY / MISTAKE / BLUNDER — explain the concrete reason.
  const severity = f.classification === "BLUNDER" ? "This blunder" : f.classification === "MISTAKE" ? "This mistake" : "This inaccuracy";
  if (opponentMatesAfter && f.after.mate != null) {
    const line = f.replyPvSan.slice(0, 5).join(" ");
    return { text: `${f.playedSan} allows a forced mate in ${Math.abs(f.after.mate)}: ${line}. ${f.bestSan ? `${f.bestSan} was necessary.` : ""}`.trim(), theme: "allowed-mate" };
  }
  if (moverHadMate && !moverMatesAfter) {
    return { text: `${you} had a forced mate starting with ${f.bestSan ?? "the best move"} (${bestLine}), but ${f.playedSan} lets ${opp} escape.`, theme: "missed-mate" };
  }
  if (minBalanceDelta <= -2 && reply) {
    const target = f.replyPvUci[0] ? f.replyPvUci[0].slice(2, 4) : "";
    const piece = target ? pieceName(f.fenAfter, target) : "material";
    const which = isCaptureSan(reply) ? `${opp} simply plays ${reply}, winning the ${piece}` : `after ${f.replyPvSan.slice(0, 3).join(" ")} ${opp} wins material`;
    return { text: `${severity} leaves material hanging — ${which}. ${f.bestSan ? `Better was ${f.bestSan}.` : ""}`.trim(), theme: "hanging-piece" };
  }
  if (bestMaterial && bestMaterial.minBalanceDelta >= 2 && f.bestSan) {
    return { text: `${severity} misses a tactic: ${f.bestSan} wins material (${bestLine}).`, theme: "missed-tactic" };
  }
  if (f.winBefore >= 80 && f.winDrop >= 10) {
    return { text: `${you} was winning, but ${f.playedSan} gives much of it back; ${f.bestSan ?? "the engine's move"} keeps control (${bestLine}).`, theme: "converting-advantage" };
  }
  if (isCheckSan(reply) || f.replyPvSan.slice(0, 3).some(isCheckSan)) {
    return { text: `${severity} weakens ${you}'s king: ${opp} gets ${f.replyPvSan.slice(0, 3).join(" ")} with a strong attack. ${f.bestSan ? `${f.bestSan} was safer.` : ""}`.trim(), theme: "king-safety" };
  }
  if (f.ply <= 20 && f.bestUci && !isDevelopingMove(f.fenBefore, f.playedUci, f.mover) && isDevelopingMove(f.fenBefore, f.bestUci, f.mover)) {
    return { text: `In the opening, development matters most: ${f.bestSan} brings a piece into play, while ${f.playedSan} loses time.`, theme: "opening-development" };
  }
  if (lowTime) {
    return { text: `Played with little time left: ${f.playedSan} drops ${Math.round(f.winDrop)}% of the winning chances; ${f.bestSan ?? "the best move"} was stronger.`, theme: "time-trouble" };
  }
  if (endgame) {
    return { text: `Endgame precision: ${f.playedSan} lets the evaluation slip; ${f.bestSan ?? "the engine's move"} (${bestLine}) was the accurate continuation.`, theme: "endgame-technique" };
  }
  if (f.winBefore <= 35) {
    return { text: `Under pressure, ${f.playedSan} makes the defence harder; ${f.bestSan ?? "the engine's move"} held on better (${bestLine}).`, theme: "defence" };
  }
  if (reply && (isCaptureSan(reply) || isCheckSan(reply))) {
    return { text: `${severity} overlooks ${opp}'s reply ${reply}. ${f.bestSan ? `${f.bestSan} addresses the threat first.` : ""}`.trim(), theme: "threat-recognition" };
  }
  return { text: `${severity} costs about ${Math.round(f.winDrop)}% of the winning chances; the engine prefers ${f.bestSan ?? "another move"} (${bestLine}).`, theme: "piece-activity" };
}

function winFor(score: EngineScoreDTO, mover: Color): number {
  if (score.mate != null && score.mate !== 0) return (score.mate > 0) === (mover === "w") ? 100 : 0;
  const cp = score.cp ?? 0;
  const w = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-10000, Math.min(10000, cp)))) - 1);
  return mover === "w" ? w : 100 - w;
}

declare module "./explain" {
  interface MoveFacts {
    /** UCI form of bestPvSan (optional; used for material analysis of the best line). */
    bestPvSanToUci?: string[];
  }
}
