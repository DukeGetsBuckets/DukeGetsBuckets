"use client";

import * as React from "react";
import type { Square } from "chess.js";
import { cn } from "@/lib/cn";
import { BOARD_THEMES, type BoardThemeId, type PieceSetId } from "@/lib/settings";
import { BoardOverlay } from "./BoardOverlay";
import { isPromotionGeometry, parseFenPieces, pointToSquare, premoveDests, sideToMove, squareToXY } from "./geometry";
import { PromotionDialog, type PromotionPiece } from "./PromotionDialog";
import type { Annotations, Arrow, Orientation, PieceColor, SquareBadge } from "./types";
import { usePieces } from "./usePieces";

export interface ChessboardProps {
  fen: string;
  orientation: Orientation;
  /** Which colour(s) the user may move right now (null = none). */
  movable: PieceColor | "both" | null;
  /** Legal destinations for the side to move, from the authoritative chess logic. */
  dests: Map<Square, Square[]>;
  onMove: (from: Square, to: Square, promotion?: PromotionPiece) => void;
  lastMove?: { from: Square; to: Square } | null;
  checkSquare?: Square | null;
  /** Colour that may queue a premove while waiting for the opponent. */
  premovable?: PieceColor | null;
  premove?: { from: Square; to: Square } | null;
  onPremove?: (pm: { from: Square; to: Square; promotion?: PromotionPiece } | null) => void;
  annotations?: Annotations;
  onAnnotationsChange?: (a: Annotations) => void;
  /** Touch devices: when true, primary-pointer drags draw arrows instead of moving pieces. */
  annotationMode?: boolean;
  annotationColor?: string;
  autoArrows?: Arrow[];
  badges?: SquareBadge[];
  theme: BoardThemeId;
  pieceSet: PieceSetId;
  showCoordinates?: boolean;
  showLegalMoves?: boolean;
  showLastMove?: boolean;
  animationMs?: number;
  autoQueen?: boolean;
  defaultPromotion?: PromotionPiece;
  viewOnly?: boolean;
  className?: string;
  onSelect?: (square: Square | null) => void;
}

interface DragState {
  from: Square;
  pointerId: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  isPremove: boolean;
}

const DRAG_THRESHOLD = 5;

export function Chessboard(props: ChessboardProps) {
  const {
    fen,
    orientation,
    movable,
    dests,
    onMove,
    lastMove,
    checkSquare,
    premovable = null,
    premove = null,
    onPremove,
    annotations,
    onAnnotationsChange,
    annotationMode = false,
    annotationColor = "#f59e0b",
    autoArrows = [],
    badges = [],
    theme,
    pieceSet,
    showCoordinates = true,
    showLegalMoves = true,
    showLastMove = true,
    animationMs = 180,
    autoQueen = false,
    defaultPromotion = "q",
    viewOnly = false,
    className,
    onSelect,
  } = props;

  const rootRef = React.useRef<HTMLDivElement>(null);
  const pieces = usePieces(fen, animationMs);
  const [selected, setSelected] = React.useState<Square | null>(null);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [drawing, setDrawing] = React.useState<{ from: Square; to: Square; pointerId: number } | null>(null);
  const [promotion, setPromotion] = React.useState<{ from: Square; to: Square; color: PieceColor; isPremove: boolean } | null>(null);
  const [size, setSize] = React.useState(0);
  const turn = sideToMove(fen);
  const colors = BOARD_THEMES[theme];

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize(entry?.contentRect.width ?? 0));
    ro.observe(el);
    setSize(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Clear selection when the position changes under us.
  React.useEffect(() => {
    setSelected(null);
    setPromotion(null);
  }, [fen]);

  React.useEffect(() => {
    onSelect?.(selected);
  }, [selected, onSelect]);

  const pieceAt = React.useCallback((sq: Square) => parseFenPieces(fen).find((p) => p.square === sq) ?? null, [fen]);

  const canMoveColor = (color: PieceColor) => !viewOnly && (movable === "both" || movable === color) && color === turn;
  const canPremoveColor = (color: PieceColor) => !viewOnly && premovable === color && color !== turn;

  const destsFor = React.useCallback(
    (sq: Square): { squares: Square[]; isPremove: boolean } => {
      const piece = pieceAt(sq);
      if (!piece) return { squares: [], isPremove: false };
      if (canMoveColor(piece.color)) return { squares: dests.get(sq) ?? [], isPremove: false };
      if (canPremoveColor(piece.color)) return { squares: premoveDests(fen, sq), isPremove: true };
      return { squares: [], isPremove: false };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pieceAt, dests, fen, movable, premovable, turn, viewOnly],
  );

  const commitMove = React.useCallback(
    (from: Square, to: Square, isPremove: boolean) => {
      const piece = pieceAt(from);
      if (!piece) return;
      if (isPromotionGeometry(fen, from, to)) {
        if (isPremove) {
          onPremove?.({ from, to, promotion: defaultPromotion });
        } else if (autoQueen) {
          onMove(from, to, defaultPromotion);
        } else {
          setPromotion({ from, to, color: piece.color, isPremove });
          return;
        }
      } else if (isPremove) {
        onPremove?.({ from, to });
      } else {
        onMove(from, to);
      }
      setSelected(null);
    },
    [fen, pieceAt, onMove, onPremove, autoQueen, defaultPromotion],
  );

  const squareFromEvent = (e: React.PointerEvent): Square | null => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return pointToSquare(e.clientX - rect.left, e.clientY - rect.top, rect.width, orientation);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (promotion) return;
    const sq = squareFromEvent(e);
    if (!sq) return;
    const isAnnotation = e.button === 2 || (annotationMode && e.button === 0);
    if (isAnnotation) {
      if (!onAnnotationsChange) return;
      e.preventDefault();
      rootRef.current?.setPointerCapture(e.pointerId);
      setDrawing({ from: sq, to: sq, pointerId: e.pointerId });
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();

    // Second tap: move to a highlighted destination.
    if (selected && selected !== sq) {
      const { squares, isPremove } = destsFor(selected);
      if (squares.includes(sq)) {
        commitMove(selected, sq, isPremove);
        return;
      }
    }
    // Tapping anywhere while a premove is pending cancels it.
    if (premove && onPremove) onPremove(null);

    const piece = pieceAt(sq);
    if (piece && (canMoveColor(piece.color) || canPremoveColor(piece.color))) {
      const rect = rootRef.current!.getBoundingClientRect();
      rootRef.current?.setPointerCapture(e.pointerId);
      setSelected(sq);
      setDrag({ from: sq, pointerId: e.pointerId, x: e.clientX - rect.left, y: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, moved: false, isPremove: canPremoveColor(piece.color) });
    } else {
      setSelected(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drawing && drawing.pointerId === e.pointerId) {
      const sq = squareFromEvent(e);
      if (sq && sq !== drawing.to) setDrawing({ ...drawing, to: sq });
      return;
    }
    if (drag && drag.pointerId === e.pointerId) {
      const rect = rootRef.current!.getBoundingClientRect();
      const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD;
      setDrag({ ...drag, x: e.clientX - rect.left, y: e.clientY - rect.top, moved });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drawing && drawing.pointerId === e.pointerId) {
      const current = annotations ?? { arrows: [], circles: [] };
      if (drawing.from === drawing.to) {
        const exists = current.circles.some((c) => c.square === drawing.from);
        onAnnotationsChange?.({
          ...current,
          circles: exists ? current.circles.filter((c) => c.square !== drawing.from) : [...current.circles, { square: drawing.from, color: annotationColor }],
        });
      } else {
        const exists = current.arrows.some((a) => a.from === drawing.from && a.to === drawing.to);
        onAnnotationsChange?.({
          ...current,
          arrows: exists ? current.arrows.filter((a) => !(a.from === drawing.from && a.to === drawing.to)) : [...current.arrows, { from: drawing.from, to: drawing.to, color: annotationColor, kind: "user" }],
        });
      }
      setDrawing(null);
      return;
    }
    if (drag && drag.pointerId === e.pointerId) {
      const target = squareFromEvent(e);
      if (drag.moved && target && target !== drag.from) {
        const { squares, isPremove } = destsFor(drag.from);
        if (squares.includes(target)) commitMove(drag.from, target, isPremove);
        else setSelected(null);
      }
      // A tap (no movement) keeps the piece selected for tap-to-move.
      setDrag(null);
    }
  };

  const onPointerCancel = () => {
    setDrag(null);
    setDrawing(null);
  };

  // Highlight sets
  const selectedDests = selected ? destsFor(selected) : null;
  const legalSet = new Set(showLegalMoves && selectedDests ? selectedDests.squares : []);
  const occupied = new Set(pieces.filter((p) => !p.captured).map((p) => p.square));
  const arrows: Arrow[] = [...autoArrows, ...(annotations?.arrows ?? [])];
  if (premove) arrows.push({ from: premove.from, to: premove.to, color: "rgba(56,189,248,0.9)", kind: "premove" });

  const squareStyle = (sq: Square): React.CSSProperties => {
    const { x, y } = squareToXY(sq, orientation);
    return { left: `${x * 12.5}%`, top: `${y * 12.5}%` };
  };

  return (
    <div
      ref={rootRef}
      className={cn("touch-none-select relative aspect-square w-full overflow-hidden rounded-md shadow-card", className)}
      style={{ background: colors.dark, cursor: drag?.moved ? "grabbing" : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      role="application"
      aria-label="Chess board"
    >
      {/* Squares */}
      <div className="absolute inset-0 grid grid-cols-8 grid-rows-8">
        {[...Array(64).keys()].map((i) => {
          const x = i % 8;
          const y = Math.floor(i / 8);
          const light = (x + y) % 2 === 0;
          return <div key={i} style={{ background: light ? colors.light : colors.dark }} />;
        })}
      </div>

      {/* Highlights */}
      {showLastMove && lastMove
        ? [lastMove.from, lastMove.to].map((sq) => <div key={`lm-${sq}`} className="absolute h-[12.5%] w-[12.5%]" style={{ ...squareStyle(sq), background: colors.highlight }} />)
        : null}
      {premove
        ? [premove.from, premove.to].map((sq) => <div key={`pm-${sq}`} className="absolute h-[12.5%] w-[12.5%]" style={{ ...squareStyle(sq), background: "rgba(56,189,248,0.45)" }} />)
        : null}
      {selected ? <div className="absolute h-[12.5%] w-[12.5%]" style={{ ...squareStyle(selected), background: "rgba(20, 85, 30, 0.45)" }} /> : null}
      {checkSquare ? (
        <div
          className="absolute h-[12.5%] w-[12.5%]"
          style={{ ...squareStyle(checkSquare), background: `radial-gradient(ellipse at center, ${colors.check} 0%, ${colors.check} 25%, rgba(239,68,68,0.35) 60%, transparent 90%)` }}
        />
      ) : null}
      {[...legalSet].map((sq) => (
        <div key={`d-${sq}`} className="pointer-events-none absolute flex h-[12.5%] w-[12.5%] items-center justify-center" style={squareStyle(sq)}>
          {occupied.has(sq) ? (
            <div className="h-full w-full rounded-full" style={{ border: "min(0.9vw, 7px) solid rgba(20,20,20,0.3)", boxSizing: "border-box" }} />
          ) : (
            <div className="h-[30%] w-[30%] rounded-full" style={{ background: "rgba(20,20,20,0.3)" }} />
          )}
        </div>
      ))}

      {/* Pieces */}
      {pieces.map((p) => {
        const { x, y } = squareToXY(p.square, orientation);
        const isDragging = drag?.moved && drag.from === p.square && !p.captured;
        const style: React.CSSProperties = {
          backgroundImage: `url(/pieces/${pieceSet}/${p.color}${p.type.toUpperCase()}.svg)`,
          transition: isDragging ? "none" : `transform ${animationMs}ms cubic-bezier(.2,.8,.2,1), opacity ${animationMs}ms`,
          opacity: p.captured ? 0 : 1,
          zIndex: isDragging ? 10 : p.captured ? 1 : 2,
          willChange: "transform",
        };
        if (isDragging && drag && size > 0) {
          const sq = size / 8;
          style.transform = `translate(${drag.x - sq / 2}px, ${drag.y - sq / 2}px) scale(1.12)`;
        } else {
          style.transform = `translate(${x * 100}%, ${y * 100}%)`;
        }
        return <div key={p.id} className="piece absolute left-0 top-0 h-[12.5%] w-[12.5%] bg-contain bg-center bg-no-repeat" style={style} />;
      })}

      <BoardOverlay
        orientation={orientation}
        arrows={arrows}
        circles={annotations?.circles ?? []}
        badges={badges}
        showCoordinates={showCoordinates}
        drawing={drawing ? { from: drawing.from, to: drawing.to, color: annotationColor } : null}
      />

      {promotion ? (
        <PromotionDialog
          to={promotion.to}
          color={promotion.color}
          orientation={orientation}
          pieceSet={pieceSet}
          onPick={(piece) => {
            const { from, to, isPremove } = promotion;
            setPromotion(null);
            setSelected(null);
            if (isPremove) onPremove?.({ from, to, promotion: piece });
            else onMove(from, to, piece);
          }}
          onCancel={() => {
            setPromotion(null);
            setSelected(null);
          }}
        />
      ) : null}
    </div>
  );
}
