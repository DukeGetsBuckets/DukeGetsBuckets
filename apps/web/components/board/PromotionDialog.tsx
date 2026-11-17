"use client";

import * as React from "react";
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
  // The dialog opens on the pointerdown of a tap; that tap's own click must not pick a piece.
  // A choice counts only after a new pointerdown has started on the dialog itself.
  const armed = React.useRef(false);
  const guard = (fn: () => void) => () => {
    if (!armed.current) return;
    fn();
  };
  // Column of 4 large choices starting at the promotion square, growing toward the board centre.
  const downward = y === 0;
  const pieces: PromotionPiece[] = ["q", "n", "r", "b"];
  return (
    <div
      className="absolute inset-0 z-20 bg-black/45"
      onPointerDown={() => {
        armed.current = true;
      }}
      onClick={guard(onCancel)}
      role="dialog"
      aria-label="Choose promotion piece"
    >
      <div
        className="absolute flex flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        style={{ left: `${x * 12.5}%`, top: downward ? `${y * 12.5}%` : `${(y - 3) * 12.5}%`, width: "12.5%", height: "50%", flexDirection: downward ? "column" : "column-reverse" }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          e.stopPropagation();
          armed.current = true;
        }}
      >
        {pieces.map((p) => (
          <button
            key={p}
            onClick={guard(() => onPick(p))}
            className="flex-1 bg-white transition hover:bg-amber-100 active:bg-amber-200"
            style={{ backgroundImage: `url(/pieces/${pieceSet}/${color}${p.toUpperCase()}.svg)`, backgroundSize: "88%", backgroundRepeat: "no-repeat", backgroundPosition: "center" }}
            aria-label={{ q: "Queen", n: "Knight", r: "Rook", b: "Bishop" }[p]}
          />
        ))}
      </div>
    </div>
  );
}
