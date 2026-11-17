"use client";

import * as React from "react";
import type { Classification, EngineScoreDTO } from "@tempo/shared";
import { cn } from "@/lib/cn";

const BAD: Partial<Record<Classification, string>> = { BLUNDER: "#fa412d", MISTAKE: "#ffa459", INACCURACY: "#f7c631", BRILLIANT: "#1baaa0", GREAT: "#5b8def" };

/** Interactive evaluation graph: x = ply, y = white win chance (0–100). Clicking jumps to a position. */
export function EvalGraph({
  winChances,
  evals,
  classifications,
  viewPly,
  onSelect,
  className,
}: {
  winChances: number[];
  evals: EngineScoreDTO[];
  /** Classification of the move that led to position i (index = ply). */
  classifications: (Classification | null)[];
  viewPly: number;
  onSelect: (ply: number) => void;
  className?: string;
}) {
  const W = 600;
  const H = 120;
  const n = winChances.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (w: number) => H - (w / 100) * H;
  const path = winChances.map((w, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(w).toFixed(1)}`).join(" ");
  const area = `${path} L${W},${H} L0,${H} Z`;
  const ref = React.useRef<SVGSVGElement>(null);
  const [hover, setHover] = React.useState<number | null>(null);

  const plyFromEvent = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return null;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(n - 1, Math.round((px / W) * (n - 1))));
  };

  const fmt = (s: EngineScoreDTO | undefined) => {
    if (!s) return "";
    if (s.mate != null && s.mate !== 0) return `M${Math.abs(s.mate)}`;
    return `${(s.cp ?? 0) > 0 ? "+" : ""}${((s.cp ?? 0) / 100).toFixed(2)}`;
  };
  const shown = hover ?? viewPly;

  return (
    <div className={cn("relative", className)}>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-28 w-full cursor-crosshair touch-none rounded-lg border border-border bg-surface-2"
        onPointerMove={(e) => setHover(plyFromEvent(e))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          const p = plyFromEvent(e);
          if (p != null) onSelect(p);
        }}
        role="img"
        aria-label="Evaluation graph"
      >
        <rect x={0} y={0} width={W} height={H} fill="#2b2b2b" />
        <path d={area} fill="#f3f3f3" />
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="rgba(240,165,58,0.6)" strokeWidth={1} strokeDasharray="4 4" />
        <path d={path} fill="none" stroke="#f0a53a" strokeWidth={1.5} />
        {classifications.map((c, i) =>
          c && BAD[c] ? <circle key={i} cx={x(i)} cy={y(winChances[i] ?? 50)} r={3.5} fill={BAD[c]} stroke="#fff" strokeWidth={1} /> : null,
        )}
        <line x1={x(shown)} x2={x(shown)} y1={0} y2={H} stroke="rgba(91,155,255,0.9)" strokeWidth={1.5} />
      </svg>
      <div className="pointer-events-none absolute left-2 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">
        {shown === 0 ? "Start" : `Move ${Math.ceil(shown / 2)}${shown % 2 === 1 ? "." : "..."}`} · {fmt(evals[shown])}
      </div>
    </div>
  );
}

export function EvalBar({ score, orientation, className }: { score: EngineScoreDTO | null; orientation: "white" | "black"; className?: string }) {
  let whitePct = 50;
  let label = "0.0";
  if (score) {
    if (score.mate != null && score.mate !== 0) {
      whitePct = score.mate > 0 ? 100 : 0;
      label = `M${Math.abs(score.mate)}`;
    } else {
      const cp = score.cp ?? 0;
      whitePct = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-10000, Math.min(10000, cp)))) - 1);
      label = `${Math.abs(cp / 100).toFixed(1)}`;
    }
  }
  const whiteOnBottom = orientation === "white";
  return (
    <div className={cn("relative w-4 overflow-hidden rounded-md bg-[#2b2b2b]", className)} title={label} aria-label={`Evaluation ${label}`}>
      <div className="absolute inset-x-0 bg-[#f3f3f3] transition-[height] duration-300" style={{ height: `${whitePct}%`, [whiteOnBottom ? "bottom" : "top"]: 0 }} />
      <span className={cn("absolute inset-x-0 text-center text-[9px] font-bold", whitePct >= 50 ? (whiteOnBottom ? "bottom-0.5 text-black" : "top-0.5 text-black") : whiteOnBottom ? "top-0.5 text-white" : "bottom-0.5 text-white")}>{label}</span>
    </div>
  );
}
