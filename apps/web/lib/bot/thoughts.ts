/**
 * Turns raw engine output into the bot's "thought process": candidate moves, the ideas behind a move,
 * how the position stands in plain English, and a verdict on the player's last move.
 *
 * Everything here is deterministic and derived from the board plus Stockfish's numbers; nothing is
 * invented. Pure functions (no DOM), so they are unit tested in apps/web/test/bot-thoughts.test.ts.
 */
import { Chess, type Square } from "chess.js";
import { CLASSIFICATION_THRESHOLDS, applyUci, scoreToCp, winChanceFor, type Color } from "@tempo/chess-core";
import type { EngineScoreDTO } from "@tempo/shared";
import { toWhitePov, type UciScore } from "../engine/uci";

export const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" } as const;
type PieceType = keyof typeof PIECE_NAMES;
const VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

export type Verdict = "BEST" | "EXCELLENT" | "GOOD" | "INACCURACY" | "MISTAKE" | "BLUNDER";

/** White-POV evaluation formatted the conventional way: +0.35, −1.20, M3, −M2. */
export function formatEvalWhite(s: EngineScoreDTO | null): string {
  if (!s) return "…";
  if (s.mate != null && s.mate !== 0) return `${s.mate > 0 ? "" : "−"}M${Math.abs(s.mate)}`;
  const p = (s.cp ?? 0) / 100;
  if (Math.abs(p) < 0.005) return "0.00";
  return `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}`;
}

/** SAN moves of a principal variation (stops at the first illegal move). */
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

/** A PV as numbered text, e.g. "12…Nf6 13.Nc3 d5". */
export function pvToText(fen: string, pv: string[], max = 6): string {
  const sans = pvToSan(fen, pv, max);
  const parts = fen.split(" ");
  let turn = parts[1] === "b" ? "b" : "w";
  let num = Number(parts[5]) || 1;
  const out: string[] = [];
  sans.forEach((san, i) => {
    if (turn === "w") out.push(`${num}.${san}`);
    else out.push(i === 0 ? `${num}…${san}` : san);
    if (turn === "b") num += 1;
    turn = turn === "w" ? "b" : "w";
  });
  return out.join(" ");
}

/** Move label with number, e.g. "12.Nf3" or "12…Nf6". */
export function moveLabel(fenBefore: string, san: string): string {
  const parts = fenBefore.split(" ");
  const num = Number(parts[5]) || 1;
  return parts[1] === "b" ? `${num}…${san}` : `${num}.${san}`;
}

function joinNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The concrete, checkable ideas behind a move: captures, checks, threats and forks created by the
 * moved piece, rescuing a piece that was under attack, castling, development and central pawns.
 */
export function moveIdeas(fenBefore: string, uci: string): string[] {
  const before = new Chess(fenBefore);
  const mover = before.turn() as Color;
  const opp: Color = mover === "w" ? "b" : "w";
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const piece = before.get(from);
  if (!piece) return [];
  const captured = before.get(to);
  const after = new Chess(fenBefore);
  const applied = applyUci(after, uci);
  if (!applied) return [];
  const ideas: string[] = [];
  const pieceName = PIECE_NAMES[piece.type as PieceType];
  const fullmove = Number(fenBefore.split(" ")[5]) || 1;

  if (after.isCheckmate()) return ["Checkmate."];

  if (applied.castle) ideas.push("Castles: the king gets to safety and the rooks connect.");
  if (applied.enPassant) ideas.push("Captures a pawn en passant.");
  else if (captured) {
    const recapturable = after.isAttacked(to, opp);
    const gain = VALUES[captured.type as PieceType] - (recapturable ? VALUES[piece.type as PieceType] : 0);
    if (!recapturable) ideas.push(`Wins the ${PIECE_NAMES[captured.type as PieceType]} on ${to} for free.`);
    else if (gain > 0) ideas.push(`Takes the ${PIECE_NAMES[captured.type as PieceType]} on ${to} with the ${pieceName}, coming out ahead even after a recapture.`);
    else ideas.push(`Captures the ${PIECE_NAMES[captured.type as PieceType]} on ${to}.`);
  }
  if (applied.promotion) ideas.push(`Promotes the pawn to a ${PIECE_NAMES[(uci[4] ?? "q") as PieceType]}.`);

  // Threats made by the moved piece from its new square.
  const movedType = (applied.promotion ? (uci[4] ?? "q") : piece.type) as PieceType;
  const targets: string[] = [];
  for (const row of after.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== opp || sq.type === "k") continue;
      const attackers = after.attackers(sq.square, mover);
      if (!attackers.includes(to)) continue;
      const defended = after.isAttacked(sq.square, opp);
      if (!defended || VALUES[sq.type as PieceType] > VALUES[movedType]) {
        targets.push(`${defended ? "" : "undefended "}${PIECE_NAMES[sq.type as PieceType]} on ${sq.square}`);
      }
    }
  }
  if (applied.check && targets.length > 0) ideas.push(`Check, and at the same time attacks the ${joinNames(targets)}: a fork.`);
  else if (applied.check) ideas.push("Gives check, forcing a reply.");
  else if (targets.length >= 2) ideas.push(`Forks the ${joinNames(targets)}.`);
  else if (targets.length === 1) ideas.push(`Attacks the ${targets[0]}.`);

  // Was the moved piece in danger before the move?
  if (!captured && piece.type !== "k") {
    const attackers = before.attackers(from, opp);
    if (attackers.length > 0) {
      const defended = before.isAttacked(from, mover);
      const cheaper = attackers.some((sq) => {
        const p = before.get(sq);
        return p ? VALUES[p.type as PieceType] < VALUES[piece.type as PieceType] : false;
      });
      if (!defended || cheaper) ideas.push(`Moves the ${pieceName} out of danger (it was attacked on ${from}).`);
    }
  }

  // Opening principles.
  if (fullmove <= 12 && !applied.castle) {
    const homeRank = mover === "w" ? "1" : "8";
    if ((piece.type === "n" || piece.type === "b") && from[1] === homeRank) ideas.push(`Develops the ${pieceName} toward the center.`);
    if (piece.type === "p" && ["c4", "d4", "e4", "f4", "c5", "d5", "e5", "f5"].includes(to)) ideas.push("Claims space in the center with a pawn.");
    if (piece.type === "q" && fullmove <= 6 && !captured) ideas.push("Brings the queen out early, which can make it a target.");
  }

  if (ideas.length === 0) {
    if (piece.type === "p") ideas.push(`A quiet pawn move (${to}) that improves the structure.`);
    else if (piece.type === "k") ideas.push("Repositions the king.");
    else ideas.push(`Improves the ${pieceName} by putting it on a better square (${to}).`);
  }
  return ideas;
}

/** How the position stands for `perspective`, in plain English, from a White-POV score. */
export function describeStanding(scoreWhite: EngineScoreDTO, perspective: Color, subject: "you" | "I" = "you"): { tone: "ahead" | "behind" | "equal"; text: string } {
  const S = subject === "you" ? "You" : "I";
  const are = subject === "you" ? "You're" : "I'm";
  if (scoreWhite.mate != null && scoreWhite.mate !== 0) {
    const n = Math.abs(scoreWhite.mate);
    const forPerspective = (scoreWhite.mate > 0) === (perspective === "w");
    return forPerspective
      ? { tone: "ahead", text: `${S} can force checkmate in ${n}.` }
      : { tone: "behind", text: `${are} getting checkmated: mate in ${n} is coming.` };
  }
  const pawns = ((scoreWhite.cp ?? 0) / 100) * (perspective === "w" ? 1 : -1);
  const a = Math.abs(pawns);
  const amount = a >= 1.5 ? `about ${Math.round(a)} pawns` : a >= 0.95 ? "about a pawn" : `about ${a.toFixed(1)} of a pawn`;
  if (a < 0.3) return { tone: "equal", text: "The position is about equal." };
  if (pawns > 0) {
    if (a < 1) return { tone: "ahead", text: `${are} slightly better (${amount}).` };
    if (a < 3) return { tone: "ahead", text: `${are} ahead by ${amount}.` };
    if (a < 6) return { tone: "ahead", text: `${are} clearly winning (${amount} up).` };
    return { tone: "ahead", text: `${are} completely winning.` };
  }
  if (a < 1) return { tone: "behind", text: `${are} slightly worse (${amount}).` };
  if (a < 3) return { tone: "behind", text: `${are} behind by ${amount}.` };
  if (a < 6) return { tone: "behind", text: `${are} clearly losing (${amount} down).` };
  return { tone: "behind", text: `${are} completely lost.` };
}

/**
 * Grades a move from the mover's loss of winning chances, on the same scale as Tempo's game review
 * (docs/ANALYSIS.md): `bestWhite` is the evaluation with best play, `afterWhite` after the move played.
 */
export function judgeMove(bestWhite: EngineScoreDTO, afterWhite: EngineScoreDTO, mover: Color, playedIsBest: boolean): { verdict: Verdict; winDrop: number } {
  const winBefore = winChanceFor(bestWhite, mover);
  const winAfter = winChanceFor(afterWhite, mover);
  const winDrop = Math.max(0, winBefore - winAfter);
  const opponentMates = afterWhite.mate != null && afterWhite.mate !== 0 && (afterWhite.mate > 0) !== (mover === "w");
  if (opponentMates && winBefore >= 5) return { verdict: "BLUNDER", winDrop };
  const cpLoss = (scoreToCp(bestWhite) - scoreToCp(afterWhite)) * (mover === "w" ? 1 : -1);
  if (playedIsBest || cpLoss <= 0) return { verdict: "BEST", winDrop };
  if (winDrop <= CLASSIFICATION_THRESHOLDS.excellent) return { verdict: "EXCELLENT", winDrop };
  if (winDrop <= CLASSIFICATION_THRESHOLDS.good) return { verdict: "GOOD", winDrop };
  if (winDrop <= CLASSIFICATION_THRESHOLDS.inaccuracy) return { verdict: "INACCURACY", winDrop };
  if (winDrop <= CLASSIFICATION_THRESHOLDS.mistake) return { verdict: "MISTAKE", winDrop };
  return { verdict: "BLUNDER", winDrop };
}

export interface Reaction {
  playedSan: string;
  playedLabel: string;
  expectedSan: string | null;
  verdict: Verdict;
  evalBefore: EngineScoreDTO;
  evalAfter: EngineScoreDTO;
  text: string;
}

/** The bot's reaction to the player's move, given its own evaluations before and after it. */
export function reactToMove(input: {
  fenBefore: string;
  playedUci: string;
  expectedUci: string | null;
  bestWhite: EngineScoreDTO;
  afterWhite: EngineScoreDTO;
  /** The bot's reply, used to name what the mistake allows. */
  replyUci: string | null;
}): Reaction | null {
  const c = new Chess(input.fenBefore);
  const mover = c.turn() as Color;
  const played = applyUci(c, input.playedUci);
  if (!played) return null;
  const expectedSan = input.expectedUci ? (pvToSan(input.fenBefore, [input.expectedUci], 1)[0] ?? null) : null;
  const playedIsBest = input.expectedUci != null && input.expectedUci === input.playedUci;
  const { verdict } = judgeMove(input.bestWhite, input.afterWhite, mover, playedIsBest);
  const playedLabel = moveLabel(input.fenBefore, played.san);

  let text: string;
  if (playedIsBest) text = `${played.san} is exactly the move I expected. Well played.`;
  else {
    const expect = expectedSan ? `I was expecting ${expectedSan}. ` : "";
    const judgement: Record<Verdict, string> = {
      BEST: `${played.san} is just as good.`,
      EXCELLENT: `${played.san} is practically as good.`,
      GOOD: `${played.san} is reasonable, just slightly less precise.`,
      INACCURACY: `${played.san} is an inaccuracy: it gives me a bit more room.`,
      MISTAKE: `${played.san} is a mistake: it hands me a real advantage.`,
      BLUNDER: `${played.san} is a blunder.`,
    };
    text = `${expect}${judgement[verdict]}`;
    if ((verdict === "MISTAKE" || verdict === "BLUNDER") && input.replyUci) {
      const afterFen = played.fenAfter;
      const replySan = pvToSan(afterFen, [input.replyUci], 1)[0];
      const after = new Chess(afterFen);
      const target = after.get(input.replyUci.slice(2, 4) as Square);
      if (replySan) text += target ? ` I can take the ${PIECE_NAMES[target.type as PieceType]} with ${replySan}.` : ` I answer with ${replySan}.`;
    }
  }
  return { playedSan: played.san, playedLabel, expectedSan, verdict, evalBefore: input.bestWhite, evalAfter: input.afterWhite, text };
}

export interface Candidate {
  uci: string;
  san: string;
  evalWhite: EngineScoreDTO;
  line: string;
  chosen: boolean;
}

export interface BotThought {
  id: string;
  ply: number;
  label: string;
  uci: string;
  san: string;
  candidates: Candidate[];
  /** 1 = the engine's top choice; null when the move was outside the lines shown. */
  chosenRank: number | null;
  ideas: string[];
  note: string | null;
  plan: string | null;
  evalWhite: EngineScoreDTO | null;
  standing: string | null;
  depth: number;
  nodes: number;
  elapsedMs: number;
  reaction: Reaction | null;
}

export interface RawLine {
  uci: string;
  pv: string[];
  /** Side-to-move POV. */
  score: UciScore;
}

/** Builds the thought card for the move the bot chose from its search output. */
export function buildBotThought(input: {
  id: string;
  ply: number;
  fenBefore: string;
  chosenUci: string;
  lines: RawLine[];
  depth: number;
  nodes: number;
  elapsedMs: number;
  elo: number;
  reaction: Reaction | null;
}): BotThought | null {
  const c = new Chess(input.fenBefore);
  const bot = c.turn() as Color;
  const san = pvToSan(input.fenBefore, [input.chosenUci], 1)[0];
  if (!san) return null;
  const candidates: Candidate[] = input.lines.map((l) => ({
    uci: l.uci,
    san: pvToSan(input.fenBefore, [l.uci], 1)[0] ?? l.uci,
    evalWhite: toWhitePov(l.score, bot),
    line: pvToText(input.fenBefore, l.pv, 6),
    chosen: l.uci === input.chosenUci,
  }));
  const idx = candidates.findIndex((x) => x.chosen);
  const chosenRank = idx >= 0 ? idx + 1 : null;
  const chosenLine = idx >= 0 ? input.lines[idx]! : null;
  const evalWhite = chosenLine ? toWhitePov(chosenLine.score, bot) : null;
  const top = candidates[0];

  let note: string | null = null;
  if (chosenRank === 1 && candidates.length >= 2) {
    const gap = (scoreToCp(candidates[0]!.evalWhite) - scoreToCp(candidates[1]!.evalWhite)) * (bot === "w" ? 1 : -1);
    if (gap >= 150) note = `This was the only good move: everything else was at least ${Math.round(gap / 100)} pawn${gap >= 250 ? "s" : ""} worse.`;
  } else if (chosenRank != null && chosenRank > 1 && top) {
    note = `Playing at about ${input.elo}, I went with ${san} instead of my top choice ${top.san} (${formatEvalWhite(top.evalWhite)}).`;
  } else if (chosenRank == null && top) {
    note = `Playing at about ${input.elo}, I chose ${san}, a move outside my top lines (best was ${top.san}).`;
  }

  const plan = chosenLine && chosenLine.pv.length > 1 ? pvToText(input.fenBefore, chosenLine.pv, 6) : null;
  return {
    id: input.id,
    ply: input.ply,
    label: moveLabel(input.fenBefore, san),
    uci: input.chosenUci,
    san,
    candidates,
    chosenRank,
    ideas: moveIdeas(input.fenBefore, input.chosenUci),
    note,
    plan,
    evalWhite,
    standing: evalWhite ? describeStanding(evalWhite, bot, "I").text : null,
    depth: input.depth,
    nodes: input.nodes,
    elapsedMs: input.elapsedMs,
    reaction: input.reaction,
  };
}
