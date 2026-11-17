import type { Square } from "chess.js";

export type Orientation = "white" | "black";
export type PieceColor = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export interface BoardPiece {
  /** Stable identity across renders so moves animate instead of remounting. */
  id: string;
  color: PieceColor;
  type: PieceType;
  square: Square;
  /** Set when captured: the piece fades out at its last square. */
  captured?: boolean;
}

export interface Arrow {
  from: Square;
  to: Square;
  color: string;
  /** Visual role; "auto" arrows come from the engine, "user" from annotations, "premove" from pending premoves. */
  kind?: "user" | "auto" | "premove";
}

export interface CircleMark {
  square: Square;
  color: string;
}

export interface Annotations {
  arrows: Arrow[];
  circles: CircleMark[];
}

export interface SquareBadge {
  square: Square;
  kind: "BRILLIANT" | "GREAT" | "BEST" | "EXCELLENT" | "GOOD" | "BOOK" | "INACCURACY" | "MISTAKE" | "BLUNDER" | "FORCED";
}

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
