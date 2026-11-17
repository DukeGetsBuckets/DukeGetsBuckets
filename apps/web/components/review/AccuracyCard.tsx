import type { AnalysisSummary, Classification } from "@tempo/shared";
import { cn } from "@/lib/cn";

export const CLASS_META: Record<Classification, { label: string; color: string; glyph: string }> = {
  BRILLIANT: { label: "Brilliant", color: "#1baaa0", glyph: "!!" },
  GREAT: { label: "Great", color: "#5b8def", glyph: "!" },
  BEST: { label: "Best", color: "#81b64c", glyph: "★" },
  EXCELLENT: { label: "Excellent", color: "#96bc4b", glyph: "✓" },
  GOOD: { label: "Good", color: "#95b776", glyph: "✓" },
  BOOK: { label: "Book", color: "#a88865", glyph: "📖" },
  INACCURACY: { label: "Inaccuracy", color: "#f7c631", glyph: "?!" },
  MISTAKE: { label: "Mistake", color: "#ffa459", glyph: "?" },
  BLUNDER: { label: "Blunder", color: "#fa412d", glyph: "??" },
  FORCED: { label: "Forced", color: "#96af8b", glyph: "→" },
};

const ORDER: Classification[] = ["BRILLIANT", "GREAT", "BEST", "EXCELLENT", "GOOD", "BOOK", "INACCURACY", "MISTAKE", "BLUNDER", "FORCED"];

export function AccuracyCard({ summary, white, black }: { summary: AnalysisSummary; white: string; black: string }) {
  return (
    <div className="card p-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="text-center">
          <p className="truncate text-sm font-semibold">{white}</p>
          <p className="text-3xl font-bold tracking-tight">{summary.white.accuracy != null ? `${summary.white.accuracy.toFixed(1)}%` : "—"}</p>
          <p className="text-xs text-fg-faint">ACPL {summary.white.acpl ?? "—"} · best {summary.white.bestMovePct ?? "—"}%</p>
        </div>
        <div className="text-center text-xs uppercase tracking-wide text-fg-faint">Accuracy</div>
        <div className="text-center">
          <p className="truncate text-sm font-semibold">{black}</p>
          <p className="text-3xl font-bold tracking-tight">{summary.black.accuracy != null ? `${summary.black.accuracy.toFixed(1)}%` : "—"}</p>
          <p className="text-xs text-fg-faint">ACPL {summary.black.acpl ?? "—"} · best {summary.black.bestMovePct ?? "—"}%</p>
        </div>
      </div>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {ORDER.map((c) => {
            const w = summary.white.counts[c];
            const b = summary.black.counts[c];
            if (!w && !b) return null;
            const meta = CLASS_META[c];
            return (
              <tr key={c} className="border-t border-border/60">
                <td className="py-1 text-center font-semibold tabular-nums">{w}</td>
                <td className="py-1 text-center">
                  <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium")}>
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: meta.color }}>
                      {meta.glyph}
                    </span>
                    {meta.label}
                  </span>
                </td>
                <td className="py-1 text-center font-semibold tabular-nums">{b}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-fg-faint">
        Tempo accuracy: our own calibrated model from {summary.engine.name} evaluations at depth {summary.engine.depth} (win-chance based, not a replica of any other site's formula).
      </p>
    </div>
  );
}
