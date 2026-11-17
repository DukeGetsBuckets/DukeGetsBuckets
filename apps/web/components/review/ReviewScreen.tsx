"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Download, Loader2, RotateCcw, Sparkles, Undo2 } from "lucide-react";
import { Chess, type Square } from "chess.js";
import { applyUci } from "@tempo/chess-core";
import { TIME_CONTROLS, type GameAnalysisDTO, type MoveAnalysisDTO, type PlayerColor } from "@tempo/shared";
import { Chessboard } from "@/components/board/Chessboard";
import type { Annotations, Arrow, SquareBadge } from "@/components/board/types";
import { MoveList } from "@/components/game/MoveList";
import { useSettings } from "@/components/providers/SettingsProvider";
import { useSocket } from "@/components/providers/SocketProvider";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { AccuracyCard, CLASS_META } from "./AccuracyCard";
import { CoachingPanel } from "./CoachingPanel";
import { EvalBar, EvalGraph } from "./EvalGraph";

export interface ReviewGame {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  category: "BULLET" | "BLITZ" | "RAPID";
  rated: boolean;
  status: string;
  result: "WHITE_WINS" | "BLACK_WINS" | "DRAW" | null;
  endReason: string | null;
  initialFen: string;
  moves: { ply: number; uci: string; san: string; fenAfter: string }[];
  openingName: string | null;
  openingEco: string | null;
  startedAt: string;
}

export function ReviewScreen({ game, initialAnalysis, viewerId, canRequest }: { game: ReviewGame; initialAnalysis: GameAnalysisDTO | null; viewerId: string | null; canRequest: boolean }) {
  const { settings } = useSettings();
  const { socket } = useSocket();
  const { toast } = useToast();
  const router = useRouter();
  const [analysis, setAnalysis] = React.useState<GameAnalysisDTO | null>(initialAnalysis);
  const [requesting, setRequesting] = React.useState(false);
  const [viewPly, setViewPly] = React.useState(game.moves.length);
  const [flipped, setFlipped] = React.useState(false);
  const [variation, setVariation] = React.useState<{ fromPly: number; moves: { uci: string; san: string; fen: string }[] } | null>(null);
  const [annotations, setAnnotations] = React.useState<Annotations>({ arrows: [], circles: [] });
  const [tab, setTab] = React.useState<"moves" | "coach">("moves");
  const [coachColor, setCoachColor] = React.useState<PlayerColor>(viewerId === game.black.id ? "black" : "white");
  const [playing, setPlaying] = React.useState(false);
  const [showBest, setShowBest] = React.useState(true);

  const myColor: PlayerColor | null = viewerId === game.white.id ? "white" : viewerId === game.black.id ? "black" : null;
  const orientation: PlayerColor = flipped ? (myColor === "black" ? "white" : "black") : (myColor ?? "white");
  const status = analysis?.status ?? "NONE";
  const completed = status === "COMPLETED" && analysis?.summary;

  // Poll + socket progress while queued/processing.
  React.useEffect(() => {
    if (status !== "QUEUED" && status !== "PROCESSING") return;
    const refresh = async () => {
      const res = await fetch(`/api/review/${game.id}`, { cache: "no-store" });
      if (res.ok) setAnalysis(await res.json());
    };
    const t = setInterval(refresh, 2500);
    socket?.emit("analysis:subscribe", { gameId: game.id });
    const onProgress = (p: { gameId: string; status: string; progress: number }) => {
      if (p.gameId !== game.id) return;
      setAnalysis((a) => (a ? { ...a, status: p.status as GameAnalysisDTO["status"], progress: p.progress } : a));
      if (p.status === "COMPLETED" || p.status === "FAILED") void refresh();
    };
    socket?.on("analysis:progress", onProgress);
    return () => {
      clearInterval(t);
      socket?.off("analysis:progress", onProgress);
    };
  }, [status, game.id, socket]);

  const request = async () => {
    setRequesting(true);
    const res = await fetch(`/api/review/${game.id}`, { method: "POST" });
    setRequesting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast({ title: body.message ?? "Could not start review", tone: "danger" });
      return;
    }
    const r = await fetch(`/api/review/${game.id}`, { cache: "no-store" });
    if (r.ok) setAnalysis(await r.json());
  };

  // Position shown on the board
  const basePosition = React.useMemo(() => {
    const c = new Chess(game.initialFen);
    for (const m of game.moves.slice(0, viewPly)) applyUci(c, m.uci);
    return c;
  }, [game.initialFen, game.moves, viewPly]);
  const displayChess = React.useMemo(() => {
    if (!variation) return basePosition;
    const c = new Chess(variation.moves.at(-1)?.fen ?? basePosition.fen());
    return c;
  }, [variation, basePosition]);
  const fen = displayChess.fen();
  const dests = React.useMemo(() => {
    const map = new Map<Square, Square[]>();
    for (const m of displayChess.moves({ verbose: true })) {
      const list = map.get(m.from) ?? [];
      if (!list.includes(m.to)) list.push(m.to);
      map.set(m.from, list);
    }
    return map;
  }, [displayChess]);
  const checkSquare = React.useMemo(() => {
    if (!displayChess.inCheck()) return null;
    return displayChess.board().flat().find((p) => p && p.type === "k" && p.color === displayChess.turn())?.square ?? null;
  }, [displayChess]);

  const current: MoveAnalysisDTO | null = completed && viewPly > 0 && !variation ? (analysis!.moves.find((m) => m.ply === viewPly) ?? null) : null;
  const lastMove = variation ? variation.moves.at(-1) : viewPly > 0 ? game.moves[viewPly - 1] : null;
  const lastMoveSquares = lastMove ? { from: lastMove.uci.slice(0, 2) as Square, to: lastMove.uci.slice(2, 4) as Square } : null;

  const autoArrows: Arrow[] = [];
  if (completed && showBest && !variation) {
    const next = analysis!.moves.find((m) => m.ply === viewPly + 1);
    if (next?.bestUci && next.bestUci !== next.playedUci) autoArrows.push({ from: next.bestUci.slice(0, 2) as Square, to: next.bestUci.slice(2, 4) as Square, color: "rgba(129,182,76,0.95)", kind: "auto" });
    if (current?.bestUci && current.bestUci !== current.playedUci && ["INACCURACY", "MISTAKE", "BLUNDER"].includes(current.classification)) {
      // Show what should have been played from the previous position (arrow on the move list, not the board, to avoid confusion).
    }
  }
  const badges: SquareBadge[] = current && !variation ? [{ square: current.playedUci.slice(2, 4) as Square, kind: current.classification }] : [];
  const score = completed && !variation ? analysis!.summary!.evals[viewPly] ?? null : null;

  // Playback
  React.useEffect(() => {
    if (!playing) return;
    if (viewPly >= game.moves.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setViewPly((p) => Math.min(game.moves.length, p + 1)), 900);
    return () => clearTimeout(t);
  }, [playing, viewPly, game.moves.length]);

  // Keyboard navigation
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") {
        setVariation(null);
        setViewPly((p) => Math.max(0, p - 1));
      } else if (e.key === "ArrowRight") {
        setVariation(null);
        setViewPly((p) => Math.min(game.moves.length, p + 1));
      } else if (e.key === "f") setFlipped((f) => !f);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game.moves.length]);

  const select = (ply: number) => {
    setVariation(null);
    setViewPly(ply);
    setPlaying(false);
  };

  const onMove = (from: Square, to: Square, promotion?: "q" | "r" | "b" | "n") => {
    const uci = `${from}${to}${promotion ?? ""}`;
    const c = new Chess(fen);
    const applied = applyUci(c, uci);
    if (!applied) return;
    // Following the actual game move just steps forward.
    if (!variation && game.moves[viewPly]?.uci === uci) {
      setViewPly(viewPly + 1);
      return;
    }
    setVariation((v) => ({ fromPly: v?.fromPly ?? viewPly, moves: [...(v?.moves ?? []), { uci, san: applied.san, fen: applied.fenAfter }] }));
  };

  const copyFen = () => navigator.clipboard?.writeText(fen).then(() => toast({ title: "FEN copied", tone: "success" }));
  const moveBadgeColors: Record<number, string> = {};
  if (completed) for (const m of analysis!.moves) moveBadgeColors[m.ply] = CLASS_META[m.classification].color;
  const tc = TIME_CONTROLS[game.category];
  const resultText = game.result === "DRAW" ? "½–½" : game.result === "WHITE_WINS" ? "1–0" : game.result === "BLACK_WINS" ? "0–1" : "*";

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Board column */}
      <div className="flex w-full flex-col items-center gap-3 lg:w-auto lg:flex-1">
        <div className="flex w-full items-center justify-between text-sm">
          <div className="min-w-0">
            <p className="truncate font-semibold">
              <Link href={`/profile/${game.white.username}`} className="hover:underline">{game.white.username}</Link> vs <Link href={`/profile/${game.black.username}`} className="hover:underline">{game.black.username}</Link>{" "}
              <span className="text-fg-muted">{resultText}</span>
            </p>
            <p className="truncate text-xs text-fg-muted">
              {tc.name} {tc.label} · {game.rated ? "Rated" : "Casual"} · {game.openingName ?? "Unknown opening"} {game.openingEco ? `(${game.openingEco})` : ""} · {new Date(game.startedAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex w-full items-stretch gap-2 max-w-[min(100vw-1.5rem,calc(100dvh-14rem))]">
          {completed ? <EvalBar score={score} orientation={orientation} className="shrink-0" /> : null}
          <div className="min-w-0 flex-1">
            <Chessboard
              fen={fen}
              orientation={orientation}
              movable="both"
              dests={dests}
              onMove={onMove}
              lastMove={lastMoveSquares}
              checkSquare={checkSquare}
              annotations={annotations}
              onAnnotationsChange={setAnnotations}
              annotationColor={settings.arrowColor}
              autoArrows={autoArrows}
              badges={badges}
              theme={settings.boardTheme}
              pieceSet={settings.pieceSet}
              showCoordinates={settings.showCoordinates}
              showLegalMoves={settings.showLegalMoves}
              animationMs={settings.reducedMotion ? 0 : settings.animationMs}
              autoQueen={settings.autoQueen}
              defaultPromotion={settings.defaultPromotion}
            />
          </div>
        </div>
        {completed ? (
          <div className="w-full max-w-[min(100vw-1.5rem,calc(100dvh-14rem))]">
            <EvalGraph winChances={analysis!.summary!.winChances} evals={analysis!.summary!.evals} classifications={[null, ...analysis!.moves.map((m) => m.classification)]} viewPly={viewPly} onSelect={select} />
          </div>
        ) : null}
        <div className="flex w-full flex-wrap items-center justify-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setFlipped((f) => !f)}>
            <RotateCcw className="h-4 w-4" /> Flip
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setPlaying((p) => !p)} disabled={viewPly >= game.moves.length}>
            {playing ? "Pause" : "Play"}
          </Button>
          {variation ? (
            <Button size="sm" variant="secondary" onClick={() => setVariation(null)}>
              <Undo2 className="h-4 w-4" /> Back to game
            </Button>
          ) : null}
          {completed ? (
            <Button size="sm" variant={showBest ? "primary" : "secondary"} onClick={() => setShowBest((s) => !s)}>
              <Sparkles className="h-4 w-4" /> Best move
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={copyFen}>
            <Copy className="h-4 w-4" /> FEN
          </Button>
          <a href={`/api/games/${game.id}/pgn`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 text-sm font-medium hover:bg-surface-3">
            <Download className="h-4 w-4" /> PGN
          </a>
          {analysis && analysis.status === "COMPLETED" ? null : null}
        </div>
      </div>

      {/* Side column */}
      <aside className="flex w-full flex-col gap-3 lg:w-[24rem] lg:flex-none">
        {!completed ? (
          <div className="card p-4">
            {status === "NONE" || status === "FAILED" ? (
              <>
                <h2 className="font-semibold">Game Review</h2>
                <p className="mt-1 text-sm text-fg-muted">
                  {status === "FAILED" ? `The last attempt failed${analysis?.error ? `: ${analysis.error}` : ""}. You can retry.` : "Run a full Stockfish analysis: every move classified, accuracy scores, an evaluation graph and engine-grounded coaching."}
                </p>
                {canRequest ? (
                  <Button className="mt-3" fullWidth onClick={request} loading={requesting} disabled={game.status === "ACTIVE"}>
                    <Sparkles className="h-4 w-4" /> {status === "FAILED" ? "Retry review" : "Start Game Review"}
                  </Button>
                ) : (
                  <p className="mt-3 text-sm text-fg-muted">
                    <Link href="/login" className="text-accent hover:underline">Log in</Link> to request an analysis.
                  </p>
                )}
              </>
            ) : (
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-accent" />
                <div className="flex-1">
                  <p className="font-semibold">{status === "QUEUED" ? "Queued for analysis…" : `Analysing with ${analysis?.engine ?? "Stockfish"}…`}</p>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${analysis?.progress ?? 0}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-fg-faint">{analysis?.progress ?? 0}% · this usually takes under a minute</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <AccuracyCard summary={analysis!.summary!} white={game.white.username} black={game.black.username} />
        )}

        {current ? (
          <div className="card p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: CLASS_META[current.classification].color }}>
                {CLASS_META[current.classification].glyph}
              </span>
              <span className="font-semibold">
                {Math.ceil(current.ply / 2)}
                {current.color === "white" ? ". " : "... "}
                {current.playedSan}
              </span>
              <span className="text-fg-muted">{CLASS_META[current.classification].label}</span>
              {current.bestSan && current.bestSan !== current.playedSan ? <span className="ml-auto text-xs text-fg-muted">Best: {current.bestSan}</span> : null}
            </div>
            {current.explanation ? <p className="mt-2 text-fg-muted">{current.explanation}</p> : null}
            {current.pvSan.length ? <p className="mt-2 font-mono text-xs text-fg-faint">Engine line: {current.pvSan.join(" ")}</p> : null}
          </div>
        ) : null}

        <div className="card flex min-h-[18rem] flex-col overflow-hidden lg:h-[28rem]">
          {completed && analysis!.coaching ? (
            <div className="border-b border-border p-2">
              <Segmented size="sm" value={tab} onChange={setTab} options={[{ value: "moves", label: "Moves" }, { value: "coach", label: "Coach" }]} />
            </div>
          ) : null}
          {tab === "coach" && completed && analysis!.coaching ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div className="mb-3">
                <Segmented size="sm" value={coachColor} onChange={setCoachColor} options={[{ value: "white", label: game.white.username }, { value: "black", label: game.black.username }]} />
              </div>
              <CoachingPanel report={analysis!.coaching[coachColor]} onJump={select} />
            </div>
          ) : (
            <>
              {variation ? (
                <div className="border-b border-border px-3 py-2 text-xs text-fg-muted">
                  Variation from move {Math.ceil((variation.fromPly + 1) / 2)}: <span className="font-medium text-fg">{variation.moves.map((m) => m.san).join(" ")}</span>
                </div>
              ) : null}
              <MoveList moves={game.moves} viewPly={viewPly} onSelect={select} className="flex-1" badges={moveBadgeColors} />
            </>
          )}
        </div>
        {completed && myColor ? (
          <Link href="/improve/mistakes" className={cn("card flex items-center justify-between p-3 text-sm hover:border-accent/60")}>
            <span>
              <span className="block font-semibold">Practice your mistakes</span>
              <span className="block text-xs text-fg-muted">Positions from this game are saved to your training set.</span>
            </span>
            <span className="text-accent">→</span>
          </Link>
        ) : null}
        <button onClick={() => router.push("/history")} className="text-sm text-fg-muted hover:text-fg">
          ← Back to history
        </button>
      </aside>
    </div>
  );
}
