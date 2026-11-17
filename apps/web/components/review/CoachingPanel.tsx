"use client";

import type { CoachingReport } from "@tempo/shared";
import { THEME_LABELS } from "@tempo/shared";
import { CLASS_META } from "./AccuracyCard";

export function CoachingPanel({ report, onJump }: { report: CoachingReport; onJump: (ply: number) => void }) {
  return (
    <div className="space-y-4 text-sm">
      <Section title="What you did well">
        <ul className="list-disc space-y-1 pl-5">
          {report.didWell.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </Section>
      <Section title="Biggest mistakes">
        {report.biggestMistakes.length ? (
          <ul className="space-y-2">
            {report.biggestMistakes.map((m) => (
              <li key={m.ply}>
                <button onClick={() => onJump(m.ply)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: CLASS_META[m.classification].color }}>
                    {CLASS_META[m.classification].glyph}
                  </span>
                  <span>
                    <span className="font-semibold">
                      {Math.ceil(m.ply / 2)}
                      {m.color === "white" ? ". " : "... "}
                      {m.san}
                    </span>
                    <span className="text-fg-muted"> (−{m.winDrop}% · {THEME_LABELS[m.theme] ?? m.theme})</span>
                    <span className="block text-fg-muted">{m.explanation}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-fg-muted">No significant mistakes — nicely played.</p>
        )}
      </Section>
      <Section title="What to practice">
        <ul className="list-disc space-y-1 pl-5">
          {report.practice.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </Section>
      {report.turningPoint ? (
        <Section title="Key turning point">
          <button onClick={() => onJump(report.turningPoint!.ply)} className="text-left hover:underline">
            {report.turningPoint.text}
          </button>
        </Section>
      ) : null}
      <Section title="Opening insight">
        <p>{report.openingInsight}</p>
      </Section>
      <Section title="One lesson to remember">
        <p className="rounded-xl bg-accent-soft px-3 py-2 font-medium">{report.lesson}</p>
      </Section>
      <p className="text-[11px] text-fg-faint">{report.source === "ai" ? "Explanations written by an AI coach from verified engine data." : "Explanations generated deterministically from Stockfish analysis."}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-faint">{title}</h3>
      {children}
    </section>
  );
}
