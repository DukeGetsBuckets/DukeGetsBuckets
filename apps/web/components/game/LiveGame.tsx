"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Eraser, Flag, Handshake, MessageSquare, PenLine, RotateCcw, Settings2, Volume2, VolumeX, WifiOff } from "lucide-react";
import type { Square } from "chess.js";
import { Chess } from "chess.js";
import { applyUci } from "@tempo/chess-core";
import { TIME_CONTROLS, type PlayerColor } from "@tempo/shared";
import { Chessboard } from "@/components/board/Chessboard";
import type { Annotations } from "@/components/board/types";
import { useSettings } from "@/components/providers/SettingsProvider";
import { useSocket } from "@/components/providers/SocketProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { configureSounds, unlockAudio } from "@/lib/sounds";
import { ChatPanel } from "./ChatPanel";
import { GameOverModal } from "./GameOverModal";
import { MoveList } from "./MoveList";
import { PlayerPanel } from "./PlayerPanel";
import { useLiveGame } from "./useLiveGame";

export function LiveGame({ gameId, meId }: { gameId: string; meId: string | null }) {
  const { socket, connected } = useSocket();
  const { settings, update } = useSettings();
  const { toast } = useToast();
  const { state, makeMove, setPremove, action, respondDraw, claimDraw, respondRematch, sendChat, clearError, legal, chess } = useLiveGame(socket, connected, gameId, settings.soundEnabled);
  const [flipped, setFlipped] = React.useState(false);
  const [viewPly, setViewPly] = React.useState<number | null>(null); // null = live
  const [annotations, setAnnotations] = React.useState<Annotations>({ arrows: [], circles: [] });
  const [annotationMode, setAnnotationMode] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [confirmResign, setConfirmResign] = React.useState(false);
  const [gameOverOpen, setGameOverOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [touch, setTouch] = React.useState(false);

  React.useEffect(() => {
    configureSounds({ enabled: settings.soundEnabled, volume: settings.soundVolume });
  }, [settings.soundEnabled, settings.soundVolume]);
  React.useEffect(() => {
    setTouch(window.matchMedia("(pointer: coarse)").matches);
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);
  React.useEffect(() => {
    if (state.finished) setGameOverOpen(true);
  }, [state.finished]);
  React.useEffect(() => {
    if (state.error) {
      toast({ title: state.error, tone: "danger", durationMs: 2500 });
      clearError();
    }
  }, [state.error, toast, clearError]);
  // Clear live annotations when a new move arrives (they are temporary by design).
  React.useEffect(() => {
    setAnnotations({ arrows: [], circles: [] });
  }, [state.ply]);

  const snap = state.snapshot;
  const yourColor = state.yourColor;
  const orientation: PlayerColor = (yourColor ?? "white") === "white" ? (flipped ? "black" : "white") : flipped ? "white" : "black";
  const isLive = viewPly == null || viewPly >= state.moves.length;
  const displayFen = React.useMemo(() => {
    if (isLive || !snap) return state.fen;
    const c = new Chess(snap.initialFen);
    for (const m of state.moves.slice(0, viewPly!)) applyUci(c, m.uci);
    return c.fen();
  }, [isLive, snap, state.fen, state.moves, viewPly]);
  const displayMoves = isLive ? state.moves : state.moves.slice(0, viewPly!);
  const lastMove = displayMoves.at(-1);
  const lastMoveSquares = lastMove ? { from: lastMove.uci.slice(0, 2) as Square, to: lastMove.uci.slice(2, 4) as Square } : null;
  const active = state.status === "ACTIVE";
  const myTurn = active && yourColor && state.fen.split(" ")[1] === (yourColor === "white" ? "w" : "b");
  const pieceColor = yourColor === "white" ? "w" : "b";
  const soundsOn = settings.soundEnabled;

  const top = snap ? (orientation === "white" ? snap.black : snap.white) : null;
  const bottom = snap ? (orientation === "white" ? snap.white : snap.black) : null;
  const topColor: PlayerColor = orientation === "white" ? "black" : "white";
  const bottomColor: PlayerColor = orientation;

  const run = async (label: string, fn: () => Promise<unknown> | unknown) => {
    setBusy(label);
    try {
      const r = (await fn()) as { ok: boolean; error?: { message: string } } | null | undefined;
      if (r && !r.ok && r.error) toast({ title: r.error.message, tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const canAbort = active && state.ply < 2 && yourColor;
  const canClaimVictory = active && yourColor && !state.opponentConnected && state.claimableAt != null && Date.now() >= state.claimableAt;
  const firstMoveCountdown = useCountdown(active && state.firstMoveDeadline ? state.firstMoveDeadline : null);
  const tc = snap ? TIME_CONTROLS[snap.category] : null;

  if (state.loading && !snap) {
    return (
      <div className="flex h-[70dvh] items-center justify-center text-fg-muted">{state.error ? state.error : connected ? "Loading game…" : "Connecting…"}</div>
    );
  }
  if (!snap || !top || !bottom) return <div className="p-8 text-center text-danger">{state.error ?? "Game not found"}</div>;

  const controls = (
    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-4">
      {active && yourColor ? (
        <>
          {state.drawOfferBy && state.drawOfferBy !== yourColor ? (
            <>
              <Button variant="success" size="sm" className="col-span-2" onClick={() => run("draw", () => respondDraw(true))} loading={busy === "draw"}>
                <Handshake className="h-4 w-4" /> Accept draw
              </Button>
              <Button variant="secondary" size="sm" className="col-span-2" onClick={() => run("draw", () => respondDraw(false))}>
                Decline
              </Button>
            </>
          ) : (
            <>
              <IconBtn label={state.drawOfferBy === yourColor ? "Draw offered" : "Offer draw"} disabled={state.drawOfferBy === yourColor} onClick={() => run("draw", () => action("game:draw:offer"))}>
                <Handshake className="h-5 w-5" />
              </IconBtn>
              <IconBtn
                label={canAbort ? "Abort" : "Resign"}
                danger
                onClick={() => {
                  if (canAbort) return void run("abort", () => action("game:abort"));
                  if (settings.confirmResign) setConfirmResign(true);
                  else void run("resign", () => action("game:resign"));
                }}
              >
                <Flag className="h-5 w-5" />
              </IconBtn>
            </>
          )}
        </>
      ) : null}
      <IconBtn label="Flip board" onClick={() => setFlipped((f) => !f)}>
        <RotateCcw className="h-5 w-5" />
      </IconBtn>
      <IconBtn label={soundsOn ? "Mute" : "Unmute"} onClick={() => update({ soundEnabled: !soundsOn })}>
        {soundsOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
      </IconBtn>
      {touch ? (
        <IconBtn label={annotationMode ? "Exit drawing" : "Draw arrows"} active={annotationMode} onClick={() => setAnnotationMode((m) => !m)}>
          <PenLine className="h-5 w-5" />
        </IconBtn>
      ) : null}
      {annotations.arrows.length || annotations.circles.length ? (
        <IconBtn label="Clear drawings" onClick={() => setAnnotations({ arrows: [], circles: [] })}>
          <Eraser className="h-5 w-5" />
        </IconBtn>
      ) : null}
      <IconBtn label="Chat" active={chatOpen} onClick={() => setChatOpen((c) => !c)}>
        <MessageSquare className="h-5 w-5" />
      </IconBtn>
      <Link href="/settings" className="flex h-11 flex-col items-center justify-center rounded-xl text-fg-muted hover:bg-surface-2" aria-label="Settings">
        <Settings2 className="h-5 w-5" />
      </Link>
    </div>
  );

  const statusLine = (() => {
    if (!active) return state.finished || state.result ? "Game over" : state.status === "ABORTED" ? "Aborted" : "Game over";
    if (state.drawOfferBy === yourColor) return "Draw offered — waiting for opponent";
    if (!state.opponentConnected) return canClaimVictory ? "Opponent left — you may claim the win" : "Opponent disconnected…";
    if (firstMoveCountdown != null) return myTurn ? `Make your first move (${firstMoveCountdown}s)` : `Waiting for opponent's first move (${firstMoveCountdown}s)`;
    if (legal.check) return myTurn ? "You are in check" : "Check";
    return myTurn ? "Your move" : yourColor ? "Opponent's move" : `${state.fen.split(" ")[1] === "w" ? "White" : "Black"} to move`;
  })();

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col lg:h-dvh lg:flex-row lg:items-stretch lg:gap-4 lg:p-4">
      {/* Board column */}
      <div className="flex flex-1 flex-col items-center justify-center px-2 pt-2 lg:px-0 lg:pt-0">
        <div className="w-full lg:hidden">
          <PlayerPanel player={top} color={topColor} clock={state.clock} chess={chess.current} pieceSet={settings.pieceSet} isYou={top.id === meId} connected={top.id === meId ? connected : state.opponentConnected} soundsEnabled={soundsOn} showRating={settings.showOpponentRating || top.id === meId} finished={!active} compact />
        </div>
        <div className="w-full max-w-[min(100vw-1rem,calc(100dvh-15rem))] lg:max-w-[min(100vw-26rem,calc(100dvh-2rem))]">
          <Chessboard
            fen={displayFen}
            orientation={orientation}
            movable={isLive && active && yourColor ? pieceColor : null}
            dests={isLive ? legal.dests : new Map()}
            onMove={(from, to, promotion) => {
              if (!isLive) return;
              makeMove(from, to, promotion);
            }}
            lastMove={lastMoveSquares}
            checkSquare={isLive ? legal.check : null}
            premovable={isLive && active && yourColor && settings.premovesEnabled && !myTurn ? pieceColor : null}
            premove={isLive ? state.premove : null}
            onPremove={(pm) => setPremove(pm ? { from: pm.from, to: pm.to, promotion: pm.promotion ?? settings.defaultPromotion } : null)}
            annotations={annotations}
            onAnnotationsChange={setAnnotations}
            annotationMode={annotationMode}
            annotationColor={settings.arrowColor}
            theme={settings.boardTheme}
            pieceSet={settings.pieceSet}
            showCoordinates={settings.showCoordinates}
            showLegalMoves={settings.showLegalMoves}
            showLastMove={settings.showLastMove}
            animationMs={settings.reducedMotion ? 0 : settings.animationMs}
            autoQueen={settings.autoQueen}
            defaultPromotion={settings.defaultPromotion}
            className="mx-auto"
          />
        </div>
        <div className="w-full lg:hidden">
          <PlayerPanel player={bottom} color={bottomColor} clock={state.clock} chess={chess.current} pieceSet={settings.pieceSet} isYou={bottom.id === meId} connected={bottom.id === meId ? connected : state.opponentConnected} soundsEnabled={soundsOn} showRating={settings.showOpponentRating || bottom.id === meId} finished={!active} compact />
        </div>
      </div>

      {/* Side panel */}
      <aside className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2 pb-2 lg:w-[22rem] lg:flex-none lg:px-0 lg:pb-0">
        <div className="hidden items-center justify-between lg:flex">
          <Link href="/" className="flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" /> Home
          </Link>
          <span className="text-xs text-fg-faint">
            {tc?.name} {tc?.label} · {snap.rated ? "Rated" : "Casual"}
          </span>
        </div>
        <div className="hidden lg:block">
          <PlayerPanel player={top} color={topColor} clock={state.clock} chess={chess.current} pieceSet={settings.pieceSet} isYou={top.id === meId} connected={top.id === meId ? connected : state.opponentConnected} soundsEnabled={soundsOn} showRating={settings.showOpponentRating || top.id === meId} finished={!active} />
        </div>
        <div className={cn("card flex items-center justify-between gap-2 px-3 py-2 text-sm", !connected && "border-danger/50")}>
          <span className="truncate font-medium">{connected ? statusLine : "Reconnecting…"}</span>
          {!connected ? <WifiOff className="h-4 w-4 text-danger" /> : null}
          {!isLive ? (
            <button onClick={() => setViewPly(null)} className="shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-accent-fg">
              Back to live
            </button>
          ) : null}
        </div>
        {legal.claimable.length && active && yourColor && isLive ? (
          <div className="flex gap-2">
            {legal.claimable.map((k) => (
              <Button key={k} size="sm" variant="secondary" fullWidth onClick={() => run("claim", () => claimDraw(k as "THREEFOLD_REPETITION" | "FIFTY_MOVE_RULE"))}>
                Claim draw ({k === "THREEFOLD_REPETITION" ? "repetition" : "50 moves"})
              </Button>
            ))}
          </div>
        ) : null}
        {canClaimVictory ? (
          <Button size="sm" variant="success" fullWidth onClick={() => run("claim", () => action("game:claim:victory"))}>
            Claim victory
          </Button>
        ) : null}
        <div className="card flex min-h-[3rem] flex-1 flex-col overflow-hidden lg:min-h-0">
          {chatOpen ? (
            <ChatPanel lines={state.chat} onSend={(t) => void sendChat(t)} disabled={!yourColor || !settings.chatEnabled} meId={meId} className="flex-1" />
          ) : (
            <MoveList moves={state.moves} viewPly={isLive ? state.moves.length : viewPly!} onSelect={(p) => setViewPly(p >= state.moves.length ? null : p)} className="flex-1" compact={!isLandscape()} />
          )}
        </div>
        <div className="hidden lg:block">
          <PlayerPanel player={bottom} color={bottomColor} clock={state.clock} chess={chess.current} pieceSet={settings.pieceSet} isYou={bottom.id === meId} connected={bottom.id === meId ? connected : state.opponentConnected} soundsEnabled={soundsOn} showRating={settings.showOpponentRating || bottom.id === meId} finished={!active} />
        </div>
        {controls}
        {!active && state.result !== undefined ? (
          <Button variant="secondary" size="sm" onClick={() => setGameOverOpen(true)}>
            Show result
          </Button>
        ) : null}
      </aside>

      <Modal open={confirmResign} onClose={() => setConfirmResign(false)} title="Resign this game?">
        <p className="text-sm text-fg-muted">Your opponent will be awarded the win.</p>
        <div className="mt-4 flex gap-2">
          <Button variant="danger" fullWidth onClick={() => { setConfirmResign(false); void run("resign", () => action("game:resign")); }}>
            Resign
          </Button>
          <Button variant="secondary" fullWidth onClick={() => setConfirmResign(false)}>
            Keep playing
          </Button>
        </div>
      </Modal>

      <GameOverModal
        open={gameOverOpen && !active}
        onClose={() => setGameOverOpen(false)}
        gameId={gameId}
        result={state.result}
        reason={state.endReason}
        yourColor={yourColor}
        category={snap.category}
        rated={snap.rated}
        ratingBefore={yourColor ? snap[yourColor].rating : null}
        ratingAfter={yourColor ? snap[yourColor].ratingAfter ?? null : null}
        rematch={state.rematch}
        onRematch={() => run("rematch", () => action("game:rematch:request"))}
        onRespondRematch={(accept) => run("rematch", () => respondRematch(accept))}
        rematchBusy={busy === "rematch"}
      />
    </div>
  );
}

function IconBtn({ children, label, onClick, disabled, danger, active }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl text-fg-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-40",
        danger && "hover:text-danger",
        active && "bg-accent-soft text-accent",
      )}
    >
      {children}
      <span className="text-[10px] leading-none">{label.length > 12 ? label.split(" ")[0] : label}</span>
    </button>
  );
}

function useCountdown(deadline: number | null): number | null {
  const [left, setLeft] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!deadline) {
      setLeft(null);
      return;
    }
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [deadline]);
  return left;
}

function isLandscape(): boolean {
  if (typeof window === "undefined") return true;
  return window.innerWidth >= 1024;
}
