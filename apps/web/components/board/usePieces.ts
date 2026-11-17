"use client";

import * as React from "react";
import type { Square } from "chess.js";
import { parseFenPieces } from "./geometry";
import type { BoardPiece } from "./types";

let nextId = 1;

/**
 * Derives an animatable piece list from successive FENs. Pieces keep their ids when they move so
 * CSS transforms animate them; captured pieces linger briefly with `captured: true` then disappear.
 */
export function usePieces(fen: string, animationMs: number): BoardPiece[] {
  const [pieces, setPieces] = React.useState<BoardPiece[]>(() => parseFenPieces(fen).map((p) => ({ ...p, id: `p${nextId++}` })));
  const lastFen = React.useRef(fen);
  const cleanupTimer = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    if (fen === lastFen.current) return;
    lastFen.current = fen;
    const next = parseFenPieces(fen);
    setPieces((prev) => {
      const live = prev.filter((p) => !p.captured);
      const bySquare = new Map<Square, BoardPiece>(live.map((p) => [p.square, p]));
      const result: BoardPiece[] = [];
      const unmatchedNew: typeof next = [];
      const usedIds = new Set<string>();

      // 1) Pieces that stayed in place.
      for (const n of next) {
        const existing = bySquare.get(n.square);
        if (existing && existing.color === n.color && existing.type === n.type) {
          result.push(existing);
          usedIds.add(existing.id);
        } else {
          unmatchedNew.push(n);
        }
      }
      // 2) Pieces that moved: match by color+type among vanished ones (closest first).
      const vanished = live.filter((p) => !usedIds.has(p.id));
      for (const n of unmatchedNew) {
        let best: BoardPiece | null = null;
        let bestDist = Infinity;
        for (const v of vanished) {
          if (usedIds.has(v.id) || v.color !== n.color || v.type !== n.type) continue;
          const d = Math.abs(v.square.charCodeAt(0) - n.square.charCodeAt(0)) + Math.abs(Number(v.square[1]) - Number(n.square[1]));
          if (d < bestDist) {
            best = v;
            bestDist = d;
          }
        }
        if (best) {
          usedIds.add(best.id);
          result.push({ ...best, square: n.square });
        } else {
          // Promotion or a brand-new piece: try to reuse a vanished pawn of the same colour for continuity.
          const pawn = n.type !== "p" ? vanished.find((v) => !usedIds.has(v.id) && v.color === n.color && v.type === "p") : undefined;
          if (pawn) {
            usedIds.add(pawn.id);
            result.push({ ...pawn, square: n.square, type: n.type });
          } else {
            result.push({ ...n, id: `p${nextId++}` });
          }
        }
      }
      // 3) Anything left vanished was captured.
      const captured = vanished.filter((v) => !usedIds.has(v.id)).map((v) => ({ ...v, captured: true }));
      if (captured.length && animationMs > 0) {
        if (cleanupTimer.current) clearTimeout(cleanupTimer.current);
        cleanupTimer.current = setTimeout(() => setPieces((cur) => cur.filter((p) => !p.captured)), animationMs);
        return [...result, ...captured];
      }
      return result;
    });
  }, [fen, animationMs]);

  React.useEffect(() => () => {
    if (cleanupTimer.current) clearTimeout(cleanupTimer.current);
  }, []);

  return pieces;
}
