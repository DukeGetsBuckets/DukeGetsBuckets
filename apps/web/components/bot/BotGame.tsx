"use client";

import * as React from "react";
import Link from "next/link";
import { Chess, type Square } from "chess.js";
import { Bot, Brain, Flag, Lightbulb, Loader2, Plus, RotateCcw, Swords, Undo2 } from "lucide-react";
import { adjudicate, applyUci, type Adjudication, type AppliedMove } from "@tempo/chess-core";
import type { EngineScoreDTO } from "@tempo/shared";
import { Chessboard } from "@/components/board/Chessboard";
import type { Arrow } from "@/components/board/types";
import { MoveList } from "@/components/game/MoveList";
import { useSettings } from "@/components/providers/SettingsProvider";
import { EvalBar } from "@/components/review/EvalGraph";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { buildBotThought, describeStanding, formatEvalWhite, pvToSan, pvToText, reactToMove, type BotThought, type Verdict } from "@/lib/bot/thoughts";
import { cn } from "@/lib/cn";
import { StockfishEngine, type SearchSnapshot } from "@/lib/engine/StockfishEngine";
import { toWhitePov } from "@/lib/engine/uci";
import { haptic, playSound } from "@/lib/sounds";

const STORAGE_KEY = "tempo.botGame.v1";
/** How long the bot thinks per move. */
const BOT_MOVETIME_MS = 1500;
/** Full-strength look at the player's position (eval bar, hint, and judging the player's move). */
const ANALYSIS_MOVETIME_MS = 1200;
const STRENGTHS = [1400, 1700, 2000, 2300, 2600] as const;
const DEFAULT_ELO = 2000;

type Side = "w" | "b";
interface GameSetup {
  humanColor: Side;
  elo: number;
}
interface Saved {
  v: 1;
  setup: GameSetup;
  ucis: string[];
  thoughts: BotThought[];
  resigned: boolean;
}
interface Analysis {
  fen: string;
  bestUci: string;
  evalWhite: EngineScoreDTO;
  depth: number;
}
interface LiveThinking extends SearchSnapshot {
  fen: string;
}
interface Outcome {
  title: string;
  detail: string;
  tone: "win" | "loss" | "draw";
}

const DRAW_REASONS: Record<string, string> = {
  STALEMATE: "Stalemate: the side to move has no legal moves but is not in check.",
  INSUFFICIENT_MATERIAL: "Neither side has enough material left to checkmate.",
  SEVENTY_FIVE_MOVE_RULE: "75 moves without a capture or pawn move.",
  FIVEFOLD_REPETITION: "The same position appeared five times.",
  THREEFOLD_REPETITION: "The same position appeared three times.",
  FIFTY_MOVE_RULE: "50 moves without a capture or pawn move.",
};

const VERDICT_STYLE: Record<Verdict, { label: string; className: string }> = {
  BEST: { label: "Best", className: "bg-success-soft text-success" },
  EXCELLENT: { label: "Excellent", className: "bg-success-soft text-success" },
  GOOD: { label: "Good", className: "bg-surface-3 text-fg" },
  INACCURACY: { label: "Inaccuracy", className: "bg-info-soft text-info" },
  MISTAKE: { label: "Mistake", className: "bg-danger-soft text-danger" },
  BLUNDER: { label: "Blunder", className: "bg-danger text-white" },
};

const ARROW_TOP = "rgba(129,182,76,0.92)";
const ARROW_ALT = ["rgba(96,165,250,0.72)", "rgba(96,165,250,0.5)", "rgba(96,165,250,0.35)"];
const ARROW_HINT = "rgba(245,158,11,0.92)";

function outcomeOf(adj: Adjudication, resigned: boolean, humanColor: Side): Outcome | null {
  if (resigned) return { title: "You resigned", detail: "The bot takes this one. Start a new game or review its thoughts below.", tone: "loss" };
  if (adj.over) {
    if (adj.result === "DRAW") return { title: "Draw", detail: DRAW_REASONS[adj.reason ?? ""] ?? "The game is drawn.", tone: "draw" };
    const humanWon = (adj.result === "WHITE_WINS") === (humanColor === "w");
    return humanWon ? { title: "Checkmate: you win!", detail: "You beat the bot.", tone: "win" } : { title: "Checkmate: the bot wins", detail: "Take back a few moves to find where it went wrong.", tone: "loss" };
  }
  // Bot games end automatically on a claimable draw.
  if (adj.claimable.length > 0) return { title: "Draw", detail: DRAW_REASONS[adj.claimable[0]!] ?? "The game is drawn.", tone: "draw" };
  return null;
}

function soundFor(m: AppliedMove, enabled: boolean) {
  if (!enabled) return;
  playSound(m.check ? "check" : m.promotion ? "promote" : m.castle ? "castle" : m.capture ? "capture" : "move");
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function arrowFor(uci: string, color: string): Arrow {
  return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, color, kind: "auto" };
}

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    if (saved?.v !== 1 || !saved.setup || !Array.isArray(saved.ucis)) return null;
    const c = new Chess();
    for (const u of saved.ucis) if (!applyUci(c, u)) return null;
    return { ...saved, thoughts: Array.isArray(saved.thoughts) ? saved.thoughts : [] };
  } catch {
    return null;
  }
}

export function BotGame({ activeGameId }: { activeGameId: string | null }) {
  const { settings } = useSettings();
  const engineRef = React.useRef<StockfishEngine | null>(null);
  const analysisRef = React.useRef<Analysis | null>(null);

  const [setup, setSetup] = React.useState<GameSetup | null>(null);
  const [colorChoice, setColorChoice] = React.useState<Side | "random">("w");
  const [eloChoice, setEloChoice] = React.useState<number>(DEFAULT_ELO);
  const [ucis, setUcis] = React.useState<string[]>([]);
  const [thoughts, setThoughts] = React.useState<BotThought[]>([]);
  const [resigned, setResigned] = React.useState(false);
  const [viewPly, setViewPly] = React.useState(0);
  const [flipped, setFlipped] = React.useState(false);
  const [engineState, setEngineState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [engineError, setEngineError] = React.useState<string | null>(null);
  const [live, setLive] = React.useState<LiveThinking | null>(null);
  const [analysis, setAnalysis] = React.useState<Analysis | null>(null);
  const [evalWhite, setEvalWhite] = React.useState<EngineScoreDTO | null>(null);
  const [hintOn, setHintOn] = React.useState(false);
  const [showArrows, setShowArrows] = React.useState(true);
  const [restored, setRestored] = React.useState(false);
  const [retryToken, setRetryToken] = React.useState(0);

  // Derived game state.
  const game = React.useMemo(() => {
    const chess = new Chess();
    const fens = [chess.fen()];
    const moves: { ply: number; uci: string; san: string; fen: string }[] = [];
    for (const uci of ucis) {
      const m = applyUci(chess, uci);
      if (!m) break;
      fens.push(m.fenAfter);
      moves.push({ ply: moves.length + 1, uci: m.uci, san: m.san, fen: m.fenAfter });
    }
    return { chess, fens, moves, adj: adjudicate(chess) };
  }, [ucis]);
  const liveFen = game.fens[game.fens.length - 1]!;
  const turn = game.chess.turn() as Side;
  const humanColor: Side = setup?.humanColor ?? "w";
  const botColor: Side = humanColor === "w" ? "b" : "w";
  const outcome = setup ? outcomeOf(game.adj, resigned, humanColor) : null;
  const over = outcome != null;
  const atLive = viewPly >= game.moves.length;
  const humanToMove = Boolean(setup) && !over && turn === humanColor;
  const botToMove = Boolean(setup) && !over && turn === botColor;

  // Restore an unfinished game (iPad Safari reloads background tabs).
  React.useEffect(() => {
    const saved = loadSaved();
    if (saved) {
      setSetup(saved.setup);
      setColorChoice(saved.setup.humanColor);
      setEloChoice(saved.setup.elo);
      setUcis(saved.ucis);
      setThoughts(saved.thoughts);
      setResigned(Boolean(saved.resigned));
      setViewPly(saved.ucis.length);
      const lastEval = [...saved.thoughts].reverse().find((t) => t.evalWhite)?.evalWhite ?? null;
      setEvalWhite(lastEval);
    }
    setRestored(true);
  }, []);

  React.useEffect(() => {
    if (!restored) return;
    try {
      if (setup) localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, setup, ucis, thoughts, resigned } satisfies Saved));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable (private mode): the game simply is not resumable */
    }
  }, [restored, setup, ucis, thoughts, resigned]);

  React.useEffect(
    () => () => {
      engineRef.current?.terminate();
      engineRef.current = null;
    },
    [],
  );

  const getEngine = React.useCallback(async (): Promise<StockfishEngine> => {
    if (!engineRef.current) engineRef.current = new StockfishEngine();
    const engine = engineRef.current;
    setEngineState((s) => (s === "ready" ? s : "loading"));
    try {
      await engine.ready();
      setEngineState("ready");
      setEngineError(null);
      return engine;
    } catch (err) {
      engineRef.current?.terminate();
      engineRef.current = null;
      setEngineState("error");
      setEngineError(err instanceof Error ? err.message : "The engine could not start.");
      throw err;
    }
  }, []);

  // Drive the engine: the bot searches on its turn; on the player's turn a full-strength search feeds
  // the eval bar, the hint, and the bot's verdict on the player's move.
  React.useEffect(() => {
    if (!setup || over || activeGameId) return;
    const ac = new AbortController();
    const fen = liveFen;
    const plies = ucis.length;
    const { humanColor: human, elo } = setup;
    const bot: Side = human === "w" ? "b" : "w";
    const sideToMove = turn;
    const fenBeforeLast = plies > 0 ? game.fens[plies - 1]! : null;
    const lastUci = plies > 0 ? ucis[plies - 1]! : null;
    void (async () => {
      let engine: StockfishEngine;
      try {
        engine = await getEngine();
      } catch {
        return;
      }
      if (ac.signal.aborted) return;
      if (sideToMove === bot) {
        setLive({ fen, depth: 0, nodes: 0, nps: 0, lines: [] });
        const res = await engine.search({ fen, movetimeMs: BOT_MOVETIME_MS, multipv: 4, elo, signal: ac.signal, onUpdate: (s) => !ac.signal.aborted && setLive({ fen, ...s }) });
        if (res.aborted || ac.signal.aborted || !res.bestmove) return;
        const top = res.lines[0];
        const prior = analysisRef.current;
        const reaction =
          fenBeforeLast && lastUci && top && prior && prior.fen === fenBeforeLast
            ? reactToMove({ fenBefore: fenBeforeLast, playedUci: lastUci, expectedUci: prior.bestUci, bestWhite: prior.evalWhite, afterWhite: toWhitePov(top.score, bot), replyUci: res.bestmove })
            : null;
        const thought = buildBotThought({ id: `${plies}-${Date.now()}`, ply: plies + 1, fenBefore: fen, chosenUci: res.bestmove, lines: res.lines, depth: res.depth, nodes: res.nodes, elapsedMs: res.elapsedMs, elo, reaction });
        const applied = applyUci(new Chess(fen), res.bestmove);
        if (!applied) return;
        if (thought) setThoughts((t) => [...t.filter((x) => x.ply < thought.ply), thought]);
        if (thought?.evalWhite) setEvalWhite(thought.evalWhite);
        else if (top) setEvalWhite(toWhitePov(top.score, bot));
        setUcis((prev) => (prev.length === plies ? [...prev, applied.uci] : prev));
        setViewPly(plies + 1);
        soundFor(applied, settings.soundEnabled);
      } else {
        setLive(null);
        await engine.search({
          fen,
          movetimeMs: ANALYSIS_MOVETIME_MS,
          multipv: 1,
          elo: null,
          signal: ac.signal,
          onUpdate: (s) => {
            const best = s.lines[0];
            if (!best || s.depth < 6 || ac.signal.aborted) return;
            const a: Analysis = { fen, bestUci: best.uci, evalWhite: toWhitePov(best.score, human), depth: s.depth };
            analysisRef.current = a;
            setAnalysis(a);
            setEvalWhite(a.evalWhite);
          },
        });
      }
    })();
    return () => ac.abort();
    // Keyed on the move list: everything else the effect reads is derived from it or stable.
  }, [setup, ucis, over, activeGameId, retryToken]);

  const start = async () => {
    const human: Side = colorChoice === "random" ? (Math.random() < 0.5 ? "w" : "b") : colorChoice;
    analysisRef.current = null;
    setAnalysis(null);
    setLive(null);
    setEvalWhite(null);
    setHintOn(false);
    setUcis([]);
    setThoughts([]);
    setResigned(false);
    setViewPly(0);
    setFlipped(false);
    setSetup({ humanColor: human, elo: eloChoice });
    if (settings.soundEnabled) playSound("start");
    try {
      const engine = await getEngine();
      await engine.newGame();
    } catch {
      /* shown via engineState */
    }
  };

  const newGame = () => {
    setSetup(null);
    setUcis([]);
    setThoughts([]);
    setResigned(false);
    setLive(null);
    setAnalysis(null);
    analysisRef.current = null;
    setEvalWhite(null);
    setHintOn(false);
    setViewPly(0);
  };

  const onMove = (from: Square, to: Square, promotion?: "q" | "r" | "b" | "n") => {
    if (!humanToMove || !atLive) return;
    const applied = applyUci(new Chess(liveFen), `${from}${to}${promotion ?? ""}`);
    if (!applied) return;
    setHintOn(false);
    soundFor(applied, settings.soundEnabled);
    haptic(8);
    setUcis([...ucis, applied.uci]);
    setViewPly(ucis.length + 1);
  };

  /** Undo back to the position before the player's last move. */
  const takeBackTarget = (() => {
    if (!setup || resigned) return null;
    for (let k = ucis.length - 1; k >= 0; k--) {
      if ((game.fens[k]!.split(" ")[1] as Side) === setup.humanColor) return k;
    }
    return null;
  })();
  const takeBack = () => {
    if (takeBackTarget == null) return;
    const k = takeBackTarget;
    analysisRef.current = null;
    setAnalysis(null);
    setLive(null);
    setHintOn(false);
    setUcis(ucis.slice(0, k));
    setThoughts((t) => t.filter((x) => x.ply <= k));
    setViewPly(k);
    const lastEval = [...thoughts].reverse().find((t) => t.ply <= k && t.evalWhite)?.evalWhite ?? null;
    setEvalWhite(lastEval);
  };

  // ---- render ----

  if (activeGameId) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <Swords className="mx-auto h-8 w-8 text-accent" />
        <h1 className="mt-3 text-xl font-semibold">You have a live game in progress</h1>
        <p className="mt-1 text-sm text-fg-muted">The bot and its engine are unavailable until that game is finished.</p>
        <Link href={`/game/${activeGameId}`} className="mt-5 inline-flex h-12 items-center rounded-xl bg-accent px-5 font-medium text-accent-fg">
          Return to game
        </Link>
      </div>
    );
  }

  if (!restored) return null;

  if (!setup) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div className="card p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-accent-fg">
              <Bot className="h-6 w-6" />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Play the bot</h1>
              <p className="text-sm text-fg-muted">A Stockfish bot that thinks out loud.</p>
            </div>
          </div>
          <p className="mt-4 text-sm text-fg-muted">
            While it thinks you see the moves it is weighing, how it scores each one and the line it expects. After every move it explains what the move does and what it
            thought of yours. Games are unrated and the engine runs on this device.
          </p>
          <div className="mt-5 space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">Play as</p>
              <Segmented
                value={colorChoice}
                onChange={(v) => setColorChoice(v)}
                options={[
                  { value: "w", label: "White" },
                  { value: "random", label: "Random" },
                  { value: "b", label: "Black" },
                ]}
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Bot strength (Elo)</p>
              <Segmented value={String(eloChoice)} onChange={(v) => setEloChoice(Number(v))} options={STRENGTHS.map((e) => ({ value: String(e), label: String(e) }))} />
              <p className="mt-2 text-xs text-fg-faint">Uses Stockfish&apos;s built-in strength limiter, calibrated against engine rating lists, so treat it as approximate.</p>
            </div>
          </div>
          <Button className="mt-6" size="lg" fullWidth onClick={() => void start()}>
            <Bot className="h-5 w-5" /> Start game
          </Button>
        </div>
      </div>
    );
  }

  const orientation = (flipped ? (humanColor === "w" ? "black" : "white") : humanColor === "w" ? "white" : "black") as "white" | "black";
  const shownFen = game.fens[Math.min(viewPly, game.fens.length - 1)]!;
  const shownChess = new Chess(shownFen);
  const dests = new Map<Square, Square[]>();
  if (humanToMove && atLive) {
    for (const m of shownChess.moves({ verbose: true })) {
      const l = dests.get(m.from) ?? [];
      if (!l.includes(m.to)) l.push(m.to);
      dests.set(m.from, l);
    }
  }
  const checkSquare = shownChess.inCheck() ? (shownChess.board().flat().find((p) => p && p.type === "k" && p.color === shownChess.turn())?.square ?? null) : null;
  const lastMove = viewPly > 0 ? game.moves[viewPly - 1] : null;

  const liveLines = live && live.fen === liveFen ? live.lines : [];
  const arrows: Arrow[] = [];
  if (atLive && showArrows && botToMove) liveLines.slice(0, 4).forEach((l, i) => arrows.push(arrowFor(l.uci, i === 0 ? ARROW_TOP : ARROW_ALT[i - 1]!)));
  const hint = hintOn && humanToMove && analysis && analysis.fen === liveFen ? analysis : null;
  if (atLive && hint) arrows.push(arrowFor(hint.bestUci, ARROW_HINT));

  const standing = evalWhite ? describeStanding(evalWhite, humanColor, "you") : null;
  const status = engineState === "loading" ? "Loading the engine (about 1.8 MB, first time only)…" : over ? outcome!.title : botToMove ? "The bot is thinking…" : "Your move";
  const newestFirst = [...thoughts].reverse();

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="w-full lg:flex-1">
        <div className="mb-2 flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 font-semibold">
            <Bot className="h-4 w-4 text-accent" /> Tempo Bot · {setup.elo}
          </span>
          <span data-testid="bot-status" className={cn("flex items-center gap-1.5 text-fg-muted", botToMove && "text-accent")}>
            {botToMove || engineState === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {status}
          </span>
        </div>
        <div className="flex w-full items-stretch gap-2 max-w-[min(100vw-1.5rem,calc(100dvh-27rem))] lg:max-w-[min(100vw-1.5rem,calc(100dvh-11rem))]">
          <EvalBar score={evalWhite} orientation={orientation} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <Chessboard
              fen={shownFen}
              orientation={orientation}
              movable={humanToMove && atLive ? humanColor : null}
              dests={dests}
              onMove={onMove}
              lastMove={lastMove ? { from: lastMove.uci.slice(0, 2) as Square, to: lastMove.uci.slice(2, 4) as Square } : null}
              checkSquare={checkSquare}
              autoArrows={arrows}
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
        <div className="mt-2 flex items-center justify-between gap-2 text-sm">
          <span className="font-semibold">You ({humanColor === "w" ? "White" : "Black"})</span>
          <span data-testid="bot-eval" className={cn("text-right", standing?.tone === "ahead" ? "text-success" : standing?.tone === "behind" ? "text-danger" : "text-fg-muted")}>
            {standing ? `${standing.text} (${formatEvalWhite(evalWhite)})` : "Evaluating…"}
          </span>
        </div>
      </div>

      <aside className="flex w-full flex-col gap-3 lg:w-[25rem]">
        {engineState === "error" ? (
          <div className="card border-danger/40 p-4 text-sm">
            <p className="font-semibold text-danger">The engine could not start</p>
            <p className="mt-1 text-fg-muted">{engineError}</p>
            <Button className="mt-3" size="sm" variant="secondary" onClick={() => setRetryToken((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : null}

        {over ? (
          <div data-testid="bot-outcome" className={cn("card p-4", outcome!.tone === "win" ? "border-success/50" : outcome!.tone === "loss" ? "border-danger/40" : "")}>
            <p className="text-lg font-semibold">{outcome!.title}</p>
            <p className="mt-1 text-sm text-fg-muted">{outcome!.detail}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={newGame}>
                <Plus className="h-4 w-4" /> New game
              </Button>
              {takeBackTarget != null ? (
                <Button size="sm" variant="secondary" onClick={takeBack}>
                  <Undo2 className="h-4 w-4" /> Take back
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="card p-4" data-testid="bot-thinking">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Brain className="h-4 w-4 text-accent" /> {botToMove ? "What the bot is considering" : "Bot's thinking"}
            </span>
            <button onClick={() => setShowArrows((v) => !v)} className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-2" aria-pressed={showArrows}>
              Arrows {showArrows ? "on" : "off"}
            </button>
          </div>
          {botToMove ? (
            <div className="mt-2 space-y-1.5">
              {liveLines.length === 0 ? <p className="text-sm text-fg-muted">Looking at the position…</p> : null}
              {liveLines.map((l, i) => (
                <div key={l.multipv} className="flex items-baseline gap-2 text-sm">
                  <span className="h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-full" style={{ background: i === 0 ? ARROW_TOP : ARROW_ALT[i - 1] }} />
                  <span className="w-12 shrink-0 font-semibold">{pvToSan(liveFen, [l.uci], 1)[0] ?? l.uci}</span>
                  <span className="w-14 shrink-0 font-mono text-xs">{formatEvalWhite(toWhitePov(l.score, botColor))}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-fg-muted">{pvToText(liveFen, l.pv, 6)}</span>
                </div>
              ))}
              {live && live.depth > 0 ? (
                <p className="pt-1 text-xs text-fg-faint">
                  Depth {live.depth} · {fmtCount(live.nps)} positions/sec · {fmtCount(live.nodes)} positions looked at
                </p>
              ) : null}
            </div>
          ) : (
            <div className="mt-2 space-y-2 text-sm">
              {newestFirst[0] ? (
                <p className="text-fg-muted">
                  After <span className="font-semibold text-fg">{newestFirst[0].label}</span> the bot thinks: &ldquo;{newestFirst[0].standing ?? "Let's see."}&rdquo; Its full reasoning is in the log
                  below.
                </p>
              ) : (
                <p className="text-fg-muted">The bot&apos;s reasoning appears here as soon as it moves.</p>
              )}
              {humanToMove ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant={hintOn ? "primary" : "secondary"} onClick={() => setHintOn((v) => !v)} data-testid="bot-hint">
                    <Lightbulb className="h-4 w-4" /> {hintOn ? "Hide hint" : "What would the engine play?"}
                  </Button>
                  {hint ? (
                    <span className="text-xs text-fg-muted">
                      <span data-testid="bot-hint-move" className="font-semibold text-fg">{pvToSan(liveFen, [hint.bestUci], 1)[0]}</span> ({formatEvalWhite(hint.evalWhite)}, depth {hint.depth})
                    </span>
                  ) : hintOn ? (
                    <span className="text-xs text-fg-muted">Thinking…</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="card flex max-h-[28rem] flex-col overflow-hidden">
          <div className="border-b border-border px-4 py-2.5 text-sm font-semibold">Thought log</div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
            {newestFirst.length === 0 ? <p className="text-sm text-fg-muted">Each bot move adds an entry: its candidates, why it chose the move, the line it expects, and its view of your previous move.</p> : null}
            {newestFirst.map((t) => (
              <ThoughtCard key={t.id} t={t} />
            ))}
          </div>
        </div>

        <div className="card flex h-[12rem] flex-col overflow-hidden">
          <MoveList moves={game.moves} viewPly={Math.min(viewPly, game.moves.length)} onSelect={setViewPly} className="flex-1" />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Button size="sm" variant="secondary" onClick={takeBack} disabled={takeBackTarget == null}>
            <Undo2 className="h-4 w-4" /> Take back
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setFlipped((f) => !f)}>
            <RotateCcw className="h-4 w-4" /> Flip
          </Button>
          {over ? (
            <Button size="sm" variant="secondary" onClick={newGame}>
              <Plus className="h-4 w-4" /> New game
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setResigned(true)}>
              <Flag className="h-4 w-4" /> Resign
            </Button>
          )}
        </div>
      </aside>
    </div>
  );
}

function ThoughtCard({ t }: { t: BotThought }) {
  return (
    <article data-testid="bot-thought" className="rounded-xl border border-border bg-surface p-3 text-sm">
      {t.reaction ? (
        <div className="mb-2 rounded-lg bg-surface-2 p-2">
          <div className="flex items-center gap-2">
            <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", VERDICT_STYLE[t.reaction.verdict].className)}>{VERDICT_STYLE[t.reaction.verdict].label}</span>
            <span className="text-xs text-fg-muted">
              Your {t.reaction.playedLabel} · {formatEvalWhite(t.reaction.evalBefore)} → {formatEvalWhite(t.reaction.evalAfter)}
            </span>
          </div>
          <p className="mt-1">{t.reaction.text}</p>
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">
          <Bot className="mr-1 inline h-3.5 w-3.5 text-accent" />
          {t.label}
        </span>
        <span className="font-mono text-xs text-fg-muted">
          {t.evalWhite ? `${formatEvalWhite(t.evalWhite)} · ` : ""}depth {t.depth} · {(t.elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
        {t.ideas.map((idea, i) => (
          <li key={i}>{idea}</li>
        ))}
      </ul>
      {t.candidates.length > 0 ? (
        <p className="mt-2 text-xs text-fg-muted">
          <span className="font-medium text-fg">Considered: </span>
          {t.candidates.map((c, i) => (
            <span key={c.uci}>
              {i > 0 ? " · " : ""}
              <span className={c.chosen ? "font-semibold text-fg" : undefined}>
                {c.san} {formatEvalWhite(c.evalWhite)}
                {c.chosen ? " ✓" : ""}
              </span>
            </span>
          ))}
        </p>
      ) : null}
      {t.note ? <p className="mt-1.5 text-xs italic text-fg-muted">{t.note}</p> : null}
      {t.plan ? (
        <p className="mt-1.5 text-xs">
          <span className="font-medium">Expected line: </span>
          <span className="font-mono text-fg-muted">{t.plan}</span>
        </p>
      ) : null}
      {t.standing ? <p className="mt-1.5 text-xs text-fg-muted">{t.standing}</p> : null}
    </article>
  );
}
