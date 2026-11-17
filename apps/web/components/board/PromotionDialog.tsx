"use client";

import type { Square } from "chess.js";
import { squareToXY } from "./geometry";
import type { Orientation, PieceColor } from "./types";

export type PromotionPiece = "q" | "r" | "b" | "n";

export function PromotionDialog({
  to,
  color,
  orientation,
  pieceSet,
  onPick,
  onCancel,
}: {
  to: Square;
  color: PieceColor;
  orientation: Orientation;
  pieceSet: string;
  onPick: (p: PromotionPiece) => void;
  onCancel: () => void;
}) {
  const { x, y } = squareToXY(to, orientation);
  // Column of 4 large choices starting at the promotion square, growing toward the board centre.
  const downward = y === 0;
  const pieces: PromotionPiece[] = ["q", "n", "r", "b"];
  return (
    <div className="absolute inset-0 z-20 bg-black/45" onPointerDown={onCancel} role="dialog" aria-label="Choose promotion piece">
      <div
        className="absolute flex flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        style={{ left: `${x * 12.5}%`, top: downward ? `${y * 12.5}%` : `${(y - 3) * 12.5}%`, width: "12.5%", height: "50%", flexDirection: downward ? "column" : "column-reverse" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {pieces.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="flex-1 bg-white transition hover:bg-amber-100 active:bg-amber-200"
            style={{ backgroundImage: `url(/pieces/${pieceSet}/${color}${p.toUpperCase()}.svg)`, backgroundSize: "88%", backgroundRepeat: "no-repeat", backgroundPosition: "center" }}
            aria-label={{ q: "Queen", n: "Knight", r: "Rook", b: "Bishop" }[p]}
          />
        ))}
      </div>
    </div>
  );
}
