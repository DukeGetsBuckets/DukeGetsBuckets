"use client";

import * as React from "react";
import { squareToXY } from "./geometry";
import type { Arrow, CircleMark, Orientation, SquareBadge } from "./types";
import { FILES, RANKS } from "./types";

const BADGE_STYLE: Record<SquareBadge["kind"], { bg: string; glyph: string }> = {
  BRILLIANT: { bg: "#1baaa0", glyph: "!!" },
  GREAT: { bg: "#5b8def", glyph: "!" },
  BEST: { bg: "#81b64c", glyph: "★" },
  EXCELLENT: { bg: "#96bc4b", glyph: "✓" },
  GOOD: { bg: "#95b776", glyph: "✓" },
  BOOK: { bg: "#a88865", glyph: "📖" },
  INACCURACY: { bg: "#f7c631", glyph: "?!" },
  MISTAKE: { bg: "#ffa459", glyph: "?" },
  BLUNDER: { bg: "#fa412d", glyph: "??" },
  FORCED: { bg: "#96af8b", glyph: "→" },
};

export function BoardOverlay({
  orientation,
  arrows,
  circles,
  badges,
  showCoordinates,
  drawing,
}: {
  orientation: Orientation;
  arrows: Arrow[];
  circles: CircleMark[];
  badges: SquareBadge[];
  showCoordinates: boolean;
  drawing: { from: string; to: string; color: string } | null;
}) {
  const center = (sq: string) => {
    const { x, y } = squareToXY(sq as never, orientation);
    return { cx: x + 0.5, cy: y + 0.5 };
  };
  const renderArrow = (a: Arrow, key: string, dashed = false) => {
    const f = center(a.from);
    const t = center(a.to);
    const dx = t.cx - f.cx;
    const dy = t.cy - f.cy;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const head = 0.42;
    const width = a.kind === "auto" ? 0.14 : 0.17;
    const ux = dx / len;
    const uy = dy / len;
    // start slightly off the piece centre, stop before the head
    const sx = f.cx + ux * 0.32;
    const sy = f.cy + uy * 0.32;
    const ex = t.cx - ux * head;
    const ey = t.cy - uy * head;
    const px = -uy;
    const py = ux;
    const headW = 0.3;
    const tip = `${t.cx},${t.cy}`;
    const left = `${ex + px * headW},${ey + py * headW}`;
    const right = `${ex - px * headW},${ey - py * headW}`;
    return (
      <g key={key} opacity={a.kind === "auto" ? 0.75 : 0.85} style={{ pointerEvents: "none" }}>
        <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={a.color} strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? "0.2 0.12" : undefined} />
        <polygon points={`${tip} ${left} ${right}`} fill={a.color} />
      </g>
    );
  };

  return (
    <>
      <svg viewBox="0 0 8 8" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {circles.map((c) => {
          const { cx, cy } = center(c.square);
          return <circle key={`c-${c.square}`} cx={cx} cy={cy} r={0.42} fill="none" stroke={c.color} strokeWidth={0.09} opacity={0.9} />;
        })}
        {arrows.map((a, i) => renderArrow(a, `a-${i}-${a.from}${a.to}`))}
        {drawing && drawing.from !== drawing.to ? renderArrow({ from: drawing.from as never, to: drawing.to as never, color: drawing.color, kind: "user" }, "drawing", true) : null}
        {showCoordinates
          ? [...Array(8).keys()].map((i) => {
              const file = orientation === "white" ? FILES[i] : FILES[7 - i];
              const rank = orientation === "white" ? RANKS[7 - i] : RANKS[i];
              const light = (i + 7) % 2 === 0;
              return (
                <g key={`coord-${i}`} fontSize={0.26} fontFamily="var(--font-sans)" fontWeight={600}>
                  <text x={i + 0.9} y={7.9} textAnchor="end" fill={light ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.7)"}>
                    {file}
                  </text>
                  <text x={0.08} y={i + 0.32} fill={(i % 2 === 0) ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.7)"}>
                    {rank}
                  </text>
                </g>
              );
            })
          : null}
      </svg>
      {badges.map((b) => {
        const { x, y } = squareToXY(b.square, orientation);
        const s = BADGE_STYLE[b.kind];
        return (
          <span
            key={`b-${b.square}`}
            className="pointer-events-none absolute flex items-center justify-center rounded-full font-bold text-white shadow"
            style={{
              width: "4.2%",
              height: "4.2%",
              left: `${x * 12.5 + 9.2}%`,
              top: `${y * 12.5 - 0.9}%`,
              background: s.bg,
              fontSize: "min(2.2vw, 13px)",
              zIndex: 6,
            }}
            aria-label={b.kind.toLowerCase()}
          >
            {s.glyph}
          </span>
        );
      })}
    </>
  );
}
