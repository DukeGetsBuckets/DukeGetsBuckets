import type { Square } from "chess.js";
import { FILES, RANKS, type Orientation, type PieceColor, type PieceType } from "./types";

export function squareToFileRank(sq: Square): { file: number; rank: number } {
  return { file: sq.charCodeAt(0) - 97, rank: Number(sq[1]) - 1 };
}

export function fileRankToSquare(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file]}${RANKS[rank]}` as Square;
}

/** Board-relative column/row (0..7, top-left origin) for a square under the given orientation. */
export function squareToXY(sq: Square, orientation: Orientation): { x: number; y: number } {
  const { file, rank } = squareToFileRank(sq);
  return orientation === "white" ? { x: file, y: 7 - rank } : { x: 7 - file, y: rank };
}

export function xyToSquare(x: number, y: number, orientation: Orientation): Square | null {
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  return orientation === "white" ? fileRankToSquare(x, 7 - y) : fileRankToSquare(7 - x, y);
}

/** Square under a pointer position relative to the board's bounding box. */
export function pointToSquare(px: number, py: number, size: number, orientation: Orientation): Square | null {
  if (size <= 0) return null;
  const x = Math.floor((px / size) * 8);
  const y = Math.floor((py / size) * 8);
  return xyToSquare(x, y, orientation);
}

export interface ParsedPiece {
  color: PieceColor;
  type: PieceType;
  square: Square;
}

/** Parse the piece placement field of a FEN. */
export function parseFenPieces(fen: string): ParsedPiece[] {
  const placement = fen.split(" ")[0] ?? "";
  const out: ParsedPiece[] = [];
  let rank = 7;
  let file = 0;
  for (const ch of placement) {
    if (ch === "/") {
      rank--;
      file = 0;
      continue;
    }
    if (ch >= "1" && ch <= "8") {
      file += Number(ch);
      continue;
    }
    const color: PieceColor = ch === ch.toUpperCase() ? "w" : "b";
    const type = ch.toLowerCase() as PieceType;
    const sq = fileRankToSquare(file, rank);
    if (sq) out.push({ color, type, square: sq });
    file++;
  }
  return out;
}

export function sideToMove(fen: string): PieceColor {
  return (fen.split(" ")[1] ?? "w") === "b" ? "b" : "w";
}

export function isLightSquare(sq: Square): boolean {
  const { file, rank } = squareToFileRank(sq);
  return (file + rank) % 2 === 1;
}

/**
 * Destinations a piece could move to as a premove. The opponent has not moved yet, so legality is
 * unknowable: we allow every geometric move of the piece (sliding through pieces, since they may
 * move away), pawn pushes and diagonal captures, and castling squares for the king.
 */
export function premoveDests(fen: string, from: Square): Square[] {
  const pieces = parseFenPieces(fen);
  const piece = pieces.find((p) => p.square === from);
  if (!piece) return [];
  const { file, rank } = squareToFileRank(from);
  const out = new Set<Square>();
  const add = (f: number, r: number) => {
    const sq = fileRankToSquare(f, r);
    if (sq) out.add(sq);
  };
  const ray = (df: number, dr: number) => {
    let f = file + df;
    let r = rank + dr;
    while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
      add(f, r);
      f += df;
      r += dr;
    }
  };
  switch (piece.type) {
    case "p": {
      const dir = piece.color === "w" ? 1 : -1;
      const startRank = piece.color === "w" ? 1 : 6;
      add(file, rank + dir);
      if (rank === startRank) add(file, rank + 2 * dir);
      add(file - 1, rank + dir);
      add(file + 1, rank + dir);
      break;
    }
    case "n":
      for (const [df, dr] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) add(file + df!, rank + dr!);
      break;
    case "b":
      ray(1, 1);
      ray(1, -1);
      ray(-1, 1);
      ray(-1, -1);
      break;
    case "r":
      ray(1, 0);
      ray(-1, 0);
      ray(0, 1);
      ray(0, -1);
      break;
    case "q":
      ray(1, 1);
      ray(1, -1);
      ray(-1, 1);
      ray(-1, -1);
      ray(1, 0);
      ray(-1, 0);
      ray(0, 1);
      ray(0, -1);
      break;
    case "k": {
      for (const df of [-1, 0, 1]) for (const dr of [-1, 0, 1]) if (df || dr) add(file + df, rank + dr);
      const homeRank = piece.color === "w" ? 0 : 7;
      if (rank === homeRank && file === 4) {
        add(6, homeRank);
        add(2, homeRank);
      }
      break;
    }
  }
  out.delete(from);
  // Never target your own pieces.
  for (const p of pieces) if (p.color === piece.color) out.delete(p.square);
  return [...out];
}

/** Whether a from→to move for the piece on `from` is a pawn promotion. */
export function isPromotionGeometry(fen: string, from: Square, to: Square): boolean {
  const piece = parseFenPieces(fen).find((p) => p.square === from);
  if (!piece || piece.type !== "p") return false;
  return (piece.color === "w" && to[1] === "8") || (piece.color === "b" && to[1] === "1");
}

/** Material value used for sacrifice detection and captured-piece displays. */
export const PIECE_ORDER: PieceType[] = ["q", "r", "b", "n", "p"];
