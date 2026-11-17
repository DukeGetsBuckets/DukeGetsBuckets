"use client";

import * as React from "react";
import Link from "next/link";
import { Chess, type Square } from "chess.js";
import { CheckCircle2, Lightbulb, RotateCcw, SkipForward, XCircle } from "lucide-react";
import type { TrainingPositionDTO } from "@tempo/shared";
import { THEME_LABELS } from "@tempo/shared";
import { Chessboard } from "@/components/board/Chessboard";
import type { Arrow } from "@/components/board/types";
import { useSettings } from "@/components/providers/SettingsProvider";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { CLASS_META } from "@/components/review/AccuracyCard";
import { cn } from "@/lib/cn";

type Feedback = { kind: "correct" | "wrong" | "revealed"; text: string; attemptsLeft?: number };

export function PracticeScreen({ initial }: { initial: TrainingPositionDTO[] }) {
  const { settings } = useSettings();
  const [positions, setPositions] = React.useState(initial);
  const [filter, setFilter] = React.useState<"pending" | "solved" | "all">("pending");
  const [index, setIndex] = React.useState(0);
  const [feedback, setFeedback] = React.useState<Feedback | null>(null);
  const [hintSquare, setHintSquare] = React.useState<Square | null>(null);
  const [shownUci, setShownUci] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const list = positions.filter((p) => (filter === "pending" ? p.status === "NEW" || p.status === "FAILED" || p.status === "REVIEW" : filter === "solved" ? p.status === "SOLVED" : true));
  const current = list[Math.min(index, Math.max(0, list.length - 1))] ?? null;

  React.useEffect(() => {
    setFeedback(null);
    setHintSquare(null);
    setShownUci(null);
  }, [current?.id]);

  const chess = React.useMemo(() => (current ? new Chess(current.fen) : null), [current]);
  const dests = React.useMemo(() => {
    const map = new Map<Square, Square[]>();
    if (!chess) return map;
    for (const m of chess.moves({ verbose: true })) {
      const l = map.get(m.from) ?? [];
      if (!l.includes(m.to)) l.push(m.to);
      map.set(m.from, l);
    }
    return map;
  }, [chess]);
  const displayFen = React.useMemo(() => {
    if (!current || !shownUci) return current?.fen ?? "8/8/8/8/8/8/8/8 w - - 0 1";
    const c = new Chess(current.fen);
    c.move({ from: shownUci.slice(0, 2), to: shownUci.slice(2, 4), promotion: shownUci[4] as "q" | undefined });
    return c.fen();
  }, [current, shownUci]);

  const post = async (body: Record<string, unknown>) => {
    if (!current) return null;
    setBusy(true);
    const res = await fetch(`/api/training/${current.id}/attempt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    return res.ok ? res.json() : null;
  };
  const update = (patch: Partial<TrainingPositionDTO>) => setPositions((list) => list.map((p) => (p.id === current?.id ? { ...p, ...patch } : p)));

  const onMove = async (from: Square, to: Square, promotion?: "q" | "r" | "b" | "n") => {
    if (!current || feedback?.kind === "correct" || feedback?.kind === "revealed") return;
    const uci = `${from}${to}${promotion ?? ""}`;
    const r = (await post({ action: "attempt", uci })) as { correct: boolean; isBest: boolean; playedSan: string; bestSan: string; attemptsLeft: number; explanation: string | null } | null;
    if (!r) return;
    if (r.correct) {
      setShownUci(uci);
      setFeedback({ kind: "correct", text: r.isBest ? `${r.playedSan} — exactly what the engine recommends. ${current.explanation ?? ""}` : r.explanation ?? "Correct!" });
      update({ status: "SOLVED", attempts: current.attempts + 1, solvedAt: new Date().toISOString() });
    } else {
      setFeedback({ kind: "wrong", text: r.attemptsLeft > 0 ? `${r.playedSan} isn't it. ${r.attemptsLeft} attempt${r.attemptsLeft === 1 ? "" : "s"} left.` : `${r.playedSan} isn't it. The best move was ${r.bestSan}.`, attemptsLeft: r.attemptsLeft });
      update({ attempts: current.attempts + 1, status: r.attemptsLeft === 0 ? "FAILED" : current.status });
      if (r.attemptsLeft === 0) setShownUci(current.bestUci);
    }
  };
  const hint = async () => {
    const r = (await post({ action: "hint" })) as { square: string } | null;
    if (r) {
      setHintSquare(r.square as Square);
      update({ hintsUsed: (current?.hintsUsed ?? 0) + 1 });
    }
  };
  const reveal = async () => {
    const r = (await post({ action: "reveal" })) as { solution: { uci: string; san: string }; explanation: string | null } | null;
    if (r && current) {
      setShownUci(r.solution.uci);
      setFeedback({ kind: "revealed", text: `The best move was ${r.solution.san}. ${r.explanation ?? ""}` });
      update({ status: current.status === "SOLVED" ? "SOLVED" : "FAILED", attempts: current.attempts + 1 });
    }
  };
  const next = () => setIndex((i) => (list.length ? (i + 1) % list.length : 0));
  const retry = async () => {
    if (!current) return;
    await post({ action: "reset" });
    update({ status: "REVIEW" });
    setFeedback(null);
    setShownUci(null);
  };

  const solved = positions.filter((p) => p.status === "SOLVED").length;
  const arrows: Arrow[] = shownUci ? [{ from: shownUci.slice(0, 2) as Square, to: shownUci.slice(2, 4) as Square, color: feedback?.kind === "correct" ? "rgba(63,207,127,0.9)" : "rgba(91,155,255,0.9)", kind: "auto" }] : [];

  if (!positions.length) {
    return (
      <div className="card p-8 text-center text-fg-muted">
        No training positions yet. Run <Link href="/history" className="text-accent hover:underline">Game Review</Link> on your games — every mistake with a clear best move becomes an exercise here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="w-full max-w-[min(100vw-1.5rem,calc(100dvh-14rem))] lg:flex-1">
        {current ? (
          <Chessboard
            fen={displayFen}
            orientation={current.sideToMove}
            movable={feedback?.kind === "correct" || feedback?.kind === "revealed" || shownUci ? null : current.sideToMove === "white" ? "w" : "b"}
            dests={dests}
            onMove={(f, t, p) => void onMove(f, t, p)}
            annotations={{ arrows: [], circles: hintSquare ? [{ square: hintSquare, color: "#f59e0b" }] : [] }}
            autoArrows={arrows}
            theme={settings.boardTheme}
            pieceSet={settings.pieceSet}
            showCoordinates={settings.showCoordinates}
            showLegalMoves={settings.showLegalMoves}
            animationMs={settings.reducedMotion ? 0 : settings.animationMs}
            autoQueen={settings.autoQueen}
          />
        ) : null}
      </div>
      <aside className="flex w-full flex-col gap-3 lg:w-[22rem]">
        <div className="flex items-center justify-between">
          <Segmented size="sm" value={filter} onChange={(v) => { setFilter(v); setIndex(0); }} options={[{ value: "pending", label: `To do (${positions.filter((p) => p.status !== "SOLVED" && p.status !== "SKIPPED").length})` }, { value: "solved", label: `Solved (${solved})` }, { value: "all", label: "All" }]} />
        </div>
        {current ? (
          <>
            <div className="card p-4 text-sm">
              <p className="text-xs uppercase tracking-wide text-fg-faint">
                Position {Math.min(index + 1, list.length)} of {list.length} · vs {current.opponent}
              </p>
              <p className="mt-1 text-lg font-semibold">{current.sideToMove === "white" ? "White" : "Black"} to move — find a better move than {current.playedSan}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-fg-muted">
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-white" style={{ background: CLASS_META[current.classification].color }}>
                  {CLASS_META[current.classification].label} in the game
                </span>
                {current.theme ? <span className="text-xs">{THEME_LABELS[current.theme] ?? current.theme}</span> : null}
                <Link href={`/review/${current.gameId}`} className="text-xs text-accent hover:underline">
                  Open game
                </Link>
              </p>
              {feedback ? (
                <p className={cn("mt-3 flex items-start gap-2 rounded-xl px-3 py-2", feedback.kind === "wrong" ? "bg-danger-soft text-danger" : "bg-success-soft text-success")}>
                  {feedback.kind === "wrong" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span className="text-fg">{feedback.text}</span>
                </p>
              ) : (
                <p className="mt-3 text-fg-muted">You have up to 3 attempts. Hints and the solution are available at any time.</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={hint} disabled={busy || Boolean(shownUci)}>
                <Lightbulb className="h-4 w-4" /> Hint
              </Button>
              <Button variant="secondary" onClick={reveal} disabled={busy || Boolean(shownUci)}>
                Show solution
              </Button>
              {current.status === "SOLVED" || current.status === "FAILED" ? (
                <Button variant="outline" onClick={retry} disabled={busy}>
                  <RotateCcw className="h-4 w-4" /> Try again later
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void post({ action: "skip" }).then(() => { update({ status: "SKIPPED" }); next(); })} disabled={busy}>
                  <SkipForward className="h-4 w-4" /> Skip
                </Button>
              )}
              <Button onClick={next} disabled={list.length < 2}>
                Next position
              </Button>
            </div>
          </>
        ) : (
          <div className="card p-6 text-center text-sm text-fg-muted">{filter === "pending" ? "All caught up — nothing pending." : "Nothing here yet."}</div>
        )}
        <div className="card p-3 text-xs text-fg-muted">
          Progress: {solved} of {positions.length} positions solved. Positions you fail stay in your queue to revisit.
        </div>
      </aside>
    </div>
  );
}
