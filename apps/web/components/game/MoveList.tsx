"use client";

import * as React from "react";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";
import type { MoveRecord } from "@tempo/shared";
import { cn } from "@/lib/cn";

export function MoveList({
  moves,
  viewPly,
  onSelect,
  className,
  compact,
  badges,
}: {
  moves: Pick<MoveRecord, "ply" | "san">[];
  /** Ply currently displayed (moves.length = live). */
  viewPly: number;
  onSelect: (ply: number) => void;
  className?: string;
  compact?: boolean;
  /** Optional per-ply classification colours (review). */
  badges?: Record<number, string>;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-ply="${viewPly}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [viewPly, moves.length]);

  const pairs: { n: number; white?: Pick<MoveRecord, "ply" | "san">; black?: Pick<MoveRecord, "ply" | "san"> }[] = [];
  for (const m of moves) {
    const n = Math.ceil(m.ply / 2);
    let pair = pairs[n - 1];
    if (!pair) {
      pair = { n };
      pairs[n - 1] = pair;
    }
    if (m.ply % 2 === 1) pair.white = m;
    else pair.black = m;
  }

  const Btn = ({ ply, san }: { ply: number; san: string }) => (
    <button
      data-ply={ply}
      onClick={() => onSelect(ply)}
      className={cn("rounded-md px-1.5 py-0.5 text-left font-medium tabular-nums transition", viewPly === ply ? "bg-accent text-accent-fg" : "hover:bg-surface-3")}
      style={badges?.[ply] ? { boxShadow: `inset 3px 0 0 ${badges[ply]}` } : undefined}
    >
      {san}
    </button>
  );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div ref={listRef} className={cn("min-h-0 flex-1 overflow-y-auto px-2 py-1 text-sm", compact ? "flex gap-1 overflow-x-auto no-scrollbar" : "")}>
        {pairs.length === 0 ? <p className="px-2 py-3 text-xs text-fg-faint">No moves yet.</p> : null}
        {compact
          ? pairs.map((p) => (
              <span key={p.n} className="flex shrink-0 items-center gap-1">
                <span className="text-fg-faint">{p.n}.</span>
                {p.white ? <Btn ply={p.white.ply} san={p.white.san} /> : null}
                {p.black ? <Btn ply={p.black.ply} san={p.black.san} /> : null}
              </span>
            ))
          : pairs.map((p) => (
              <div key={p.n} className="grid grid-cols-[2.5rem_1fr_1fr] items-center gap-1 py-0.5">
                <span className="text-xs text-fg-faint">{p.n}.</span>
                {p.white ? <Btn ply={p.white.ply} san={p.white.san} /> : <span />}
                {p.black ? <Btn ply={p.black.ply} san={p.black.san} /> : <span />}
              </div>
            ))}
      </div>
      <div className="flex items-center justify-between border-t border-border px-1 py-1">
        <NavBtn onClick={() => onSelect(0)} disabled={viewPly === 0} label="First move">
          <ChevronFirst className="h-5 w-5" />
        </NavBtn>
        <NavBtn onClick={() => onSelect(Math.max(0, viewPly - 1))} disabled={viewPly === 0} label="Previous move">
          <ChevronLeft className="h-5 w-5" />
        </NavBtn>
        <NavBtn onClick={() => onSelect(Math.min(moves.length, viewPly + 1))} disabled={viewPly >= moves.length} label="Next move">
          <ChevronRight className="h-5 w-5" />
        </NavBtn>
        <NavBtn onClick={() => onSelect(moves.length)} disabled={viewPly >= moves.length} label="Last move">
          <ChevronLast className="h-5 w-5" />
        </NavBtn>
      </div>
    </div>
  );
}

function NavBtn({ children, onClick, disabled, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} className="flex h-10 flex-1 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
      {children}
    </button>
  );
}
