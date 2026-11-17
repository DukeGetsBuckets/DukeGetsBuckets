"use client";

import * as React from "react";
import { Chess, type Square } from "chess.js";
import { adjudicate, applyUci } from "@tempo/chess-core";
import type { ClockState, GameFinishedPayload, GameSnapshot, MoveAcceptedPayload, MoveRecord, PlayerColor } from "@tempo/shared";
import { emitWithAck, type AppSocket } from "@/lib/socket";
import { playSound, haptic } from "@/lib/sounds";

export interface ChatLine {
  id: string;
  userId: string;
  username: string;
  text: string;
  at: string;
  system?: boolean;
}

export interface LiveGameState {
  snapshot: GameSnapshot | null;
  fen: string;
  ply: number;
  moves: MoveRecord[];
  clock: ClockState & { receivedAt: number };
  status: GameSnapshot["status"];
  result: GameSnapshot["result"];
  endReason: GameSnapshot["endReason"];
  drawOfferBy: PlayerColor | null;
  rematch: GameSnapshot["rematch"];
  yourColor: PlayerColor | null;
  premove: { from: Square; to: Square; promotion?: "q" | "r" | "b" | "n" } | null;
  opponentConnected: boolean;
  claimableAt: number | null;
  finished: GameFinishedPayload | null;
  chat: ChatLine[];
  firstMoveDeadline: number | null;
  error: string | null;
  loading: boolean;
}

function uciToParts(uci: string) {
  return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: (uci[4] as "q" | "r" | "b" | "n" | undefined) ?? undefined };
}

export function useLiveGame(socket: AppSocket | null, connected: boolean, gameId: string, soundsEnabled: boolean) {
  const chessRef = React.useRef(new Chess());
  const optimistic = React.useRef<{ ply: number; uci: string; actionId: string } | null>(null);
  const [state, setState] = React.useState<LiveGameState>({
    snapshot: null,
    fen: chessRef.current.fen(),
    ply: 0,
    moves: [],
    clock: { whiteMs: 0, blackMs: 0, running: false, active: null, serverTime: Date.now(), receivedAt: Date.now() },
    status: "ACTIVE",
    result: null,
    endReason: null,
    drawOfferBy: null,
    rematch: { offeredBy: null, gameId: null },
    yourColor: null,
    premove: null,
    opponentConnected: true,
    claimableAt: null,
    finished: null,
    chat: [],
    firstMoveDeadline: null,
    error: null,
    loading: true,
  });

  const sound = React.useCallback(
    (name: Parameters<typeof playSound>[0]) => {
      if (soundsEnabled) playSound(name);
    },
    [soundsEnabled],
  );

  const applySnapshot = React.useCallback((s: GameSnapshot) => {
    const chess = new Chess(s.initialFen);
    for (const m of s.moves) applyUci(chess, m.uci);
    chessRef.current = chess;
    optimistic.current = null;
    setState((prev) => ({
      ...prev,
      snapshot: s,
      fen: chess.fen(),
      ply: s.ply,
      moves: s.moves,
      clock: { ...s.clock, receivedAt: Date.now() },
      status: s.status,
      result: s.result,
      endReason: s.endReason,
      drawOfferBy: s.drawOfferBy,
      rematch: s.rematch,
      yourColor: s.yourColor,
      premove: s.yourPremove ? uciToParts(s.yourPremove) : null,
      opponentConnected: s.opponentConnected ?? true,
      firstMoveDeadline: s.firstMoveDeadline,
      loading: false,
      error: null,
    }));
  }, []);

  const resync = React.useCallback(async () => {
    if (!socket) return;
    const r = await emitWithAck(socket, "game:join", { gameId });
    if (r.ok) applySnapshot(r.snapshot);
    else setState((prev) => ({ ...prev, loading: false, error: r.error.message }));
  }, [socket, gameId, applySnapshot]);

  // Join on connect / reconnect.
  React.useEffect(() => {
    if (!socket || !connected) return;
    void resync();
    const onReconnect = () => void resync();
    socket.on("connect", onReconnect);
    return () => {
      socket.off("connect", onReconnect);
      socket.emit("game:leave", { gameId });
    };
  }, [socket, connected, gameId, resync]);

  // Server events
  React.useEffect(() => {
    if (!socket) return;
    const onMove = (p: MoveAcceptedPayload) => {
      if (p.gameId !== gameId) return;
      const chess = chessRef.current;
      const currentPly = chess.history().length;
      const opt = optimistic.current;
      if (opt && p.ply === opt.ply && p.uci === opt.uci) {
        // Confirmation of our optimistic move.
        optimistic.current = null;
        setState((prev) => ({
          ...prev,
          clock: { ...p.clock, receivedAt: Date.now() },
          moves: prev.moves.map((m) => (m.ply === p.ply ? { ...m, whiteTimeMs: p.clock.whiteMs, blackTimeMs: p.clock.blackMs, spentMs: p.spentMs } : m)),
          firstMoveDeadline: null,
        }));
        return;
      }
      if (p.ply <= currentPly) return; // duplicate / already applied
      if (p.ply !== currentPly + 1) {
        void resync();
        return;
      }
      const applied = applyUci(chess, p.uci);
      if (!applied) {
        void resync();
        return;
      }
      if (p.check) sound("check");
      else if (applied.castle) sound("castle");
      else if (applied.promotion) sound("promote");
      else if (p.capture) sound("capture");
      else sound("move");
      setState((prev) => ({
        ...prev,
        fen: applied.fenAfter,
        ply: p.ply,
        moves: [...prev.moves, { ply: p.ply, uci: p.uci, san: p.san, fenAfter: applied.fenAfter, whiteTimeMs: p.clock.whiteMs, blackTimeMs: p.clock.blackMs, spentMs: p.spentMs }],
        clock: { ...p.clock, receivedAt: Date.now() },
        drawOfferBy: prev.drawOfferBy && prev.drawOfferBy !== p.by ? null : prev.drawOfferBy,
        premove: p.fromPremove && p.by === prev.yourColor ? null : prev.premove,
        firstMoveDeadline: null,
      }));
    };
    const onRejected = (p: { gameId: string; actionId: string; code: string; message: string; ply: number }) => {
      if (p.gameId !== gameId) return;
      const opt = optimistic.current;
      if (opt && opt.actionId === p.actionId) {
        optimistic.current = null;
        // Roll back the optimistic move.
        chessRef.current.undo();
        setState((prev) => ({ ...prev, fen: chessRef.current.fen(), ply: prev.ply - 1, moves: prev.moves.filter((m) => m.ply !== opt.ply), error: p.message }));
      }
      if (p.code === "STALE_SEQUENCE" || p.code === "GAME_NOT_ACTIVE") void resync();
    };
    const onClock = (p: { gameId: string; clock: ClockState }) => {
      if (p.gameId === gameId) setState((prev) => ({ ...prev, clock: { ...p.clock, receivedAt: Date.now() } }));
    };
    const onFinished = (p: GameFinishedPayload) => {
      if (p.gameId !== gameId) return;
      sound("end");
      haptic([20, 40, 20]);
      optimistic.current = null;
      setState((prev) => ({
        ...prev,
        status: p.status,
        result: p.result,
        endReason: p.reason,
        finished: p,
        clock: { ...p.clock, receivedAt: Date.now() },
        drawOfferBy: null,
        premove: null,
        snapshot: prev.snapshot
          ? {
              ...prev.snapshot,
              white: { ...prev.snapshot.white, ratingDelta: p.white.delta, ratingAfter: p.white.ratingAfter },
              black: { ...prev.snapshot.black, ratingDelta: p.black.delta, ratingAfter: p.black.ratingAfter },
            }
          : prev.snapshot,
      }));
    };
    const onDrawOffered = (p: { gameId: string; by: PlayerColor }) => {
      if (p.gameId !== gameId) return;
      sound("notify");
      setState((prev) => ({ ...prev, drawOfferBy: p.by }));
    };
    const onDrawDeclined = (p: { gameId: string }) => {
      if (p.gameId === gameId) setState((prev) => ({ ...prev, drawOfferBy: null, chat: [...prev.chat, sys("Draw offer declined")] }));
    };
    const onPremoveCleared = (p: { gameId: string }) => {
      if (p.gameId === gameId) setState((prev) => ({ ...prev, premove: null }));
    };
    const onRematchOffered = (p: { gameId: string; by: PlayerColor }) => {
      if (p.gameId === gameId) {
        sound("notify");
        setState((prev) => ({ ...prev, rematch: { ...prev.rematch, offeredBy: p.by } }));
      }
    };
    const onRematchDeclined = (p: { gameId: string }) => {
      if (p.gameId === gameId) setState((prev) => ({ ...prev, rematch: { offeredBy: null, gameId: null }, chat: [...prev.chat, sys("Rematch declined")] }));
    };
    const onChat = (p: { gameId: string; id: string; userId: string; username: string; text: string; at: string }) => {
      if (p.gameId === gameId) setState((prev) => ({ ...prev, chat: [...prev.chat, { id: p.id, userId: p.userId, username: p.username, text: p.text, at: p.at }].slice(-200) }));
    };
    const onPresence = (p: { gameId: string; userId: string; connected: boolean; claimableAt: number | null }) => {
      if (p.gameId !== gameId) return;
      setState((prev) => {
        const me = prev.yourColor ? prev.snapshot?.[prev.yourColor] : null;
        if (me && me.id === p.userId) return prev;
        return { ...prev, opponentConnected: p.connected, claimableAt: p.connected ? null : p.claimableAt };
      });
    };
    socket.on("game:move:accepted", onMove);
    socket.on("game:move:rejected", onRejected);
    socket.on("game:clock:sync", onClock);
    socket.on("game:finished", onFinished);
    socket.on("game:draw:offered", onDrawOffered);
    socket.on("game:draw:declined", onDrawDeclined);
    socket.on("game:premove:cleared", onPremoveCleared);
    socket.on("game:rematch:offered", onRematchOffered);
    socket.on("game:rematch:declined", onRematchDeclined);
    socket.on("game:chat:message", onChat);
    socket.on("game:presence", onPresence);
    return () => {
      socket.off("game:move:accepted", onMove);
      socket.off("game:move:rejected", onRejected);
      socket.off("game:clock:sync", onClock);
      socket.off("game:finished", onFinished);
      socket.off("game:draw:offered", onDrawOffered);
      socket.off("game:draw:declined", onDrawDeclined);
      socket.off("game:premove:cleared", onPremoveCleared);
      socket.off("game:rematch:offered", onRematchOffered);
      socket.off("game:rematch:declined", onRematchDeclined);
      socket.off("game:chat:message", onChat);
      socket.off("game:presence", onPresence);
    };
  }, [socket, gameId, resync, sound]);

  /** Submit a move optimistically; the server remains authoritative. */
  const makeMove = React.useCallback(
    (from: Square, to: Square, promotion?: "q" | "r" | "b" | "n") => {
      if (!socket || !state.yourColor || state.status !== "ACTIVE") return;
      const chess = chessRef.current;
      const uci = `${from}${to}${promotion ?? ""}`;
      const expectedPly = chess.history().length;
      const applied = applyUci(chess, uci);
      if (!applied) return;
      const actionId = crypto.randomUUID();
      optimistic.current = { ply: expectedPly + 1, uci, actionId };
      if (applied.check) sound("check");
      else if (applied.castle) sound("castle");
      else if (applied.promotion) sound("promote");
      else if (applied.capture) sound("capture");
      else sound("move");
      haptic(8);
      const now = Date.now();
      setState((prev) => {
        // Stop our clock locally right away so the display does not keep ticking before the ack.
        const elapsed = prev.clock.running && prev.clock.active === prev.yourColor ? now - prev.clock.receivedAt : 0;
        const whiteMs = prev.clock.active === "white" ? prev.clock.whiteMs - elapsed : prev.clock.whiteMs;
        const blackMs = prev.clock.active === "black" ? prev.clock.blackMs - elapsed : prev.clock.blackMs;
        const opponent = prev.yourColor === "white" ? "black" : "white";
        return {
          ...prev,
          fen: applied.fenAfter,
          ply: expectedPly + 1,
          moves: [...prev.moves, { ply: expectedPly + 1, uci, san: applied.san, fenAfter: applied.fenAfter, whiteTimeMs: Math.max(0, whiteMs), blackTimeMs: Math.max(0, blackMs), spentMs: elapsed }],
          clock: { ...prev.clock, whiteMs: Math.max(0, whiteMs), blackMs: Math.max(0, blackMs), active: prev.clock.running ? opponent : null, receivedAt: now },
          error: null,
        };
      });
      void emitWithAck(socket, "game:move:submit", { gameId, uci, expectedPly, actionId }).then((r) => {
        if (!r.ok && optimistic.current?.actionId === actionId) {
          optimistic.current = null;
          chessRef.current.undo();
          setState((prev) => ({ ...prev, fen: chessRef.current.fen(), ply: expectedPly, moves: prev.moves.filter((m) => m.ply !== expectedPly + 1), error: r.error.message }));
          if (r.error.code === "STALE_SEQUENCE" || r.error.code === "TIMEOUT") void resync();
        } else if (r.ok && !r.duplicate) {
          setState((prev) => ({ ...prev, clock: { ...r.clock, receivedAt: Date.now() } }));
        }
      });
    },
    [socket, gameId, state.yourColor, state.status, sound, resync],
  );

  const setPremove = React.useCallback(
    (pm: { from: Square; to: Square; promotion?: "q" | "r" | "b" | "n" } | null) => {
      if (!socket) return;
      setState((prev) => ({ ...prev, premove: pm }));
      if (pm) sound("premove");
      void emitWithAck(socket, "game:premove:set", { gameId, uci: pm ? `${pm.from}${pm.to}${pm.promotion ?? ""}` : null }).then((r) => {
        if (!r.ok) setState((prev) => ({ ...prev, premove: null }));
      });
    },
    [socket, gameId, sound],
  );

  const action = React.useCallback(
    async <E extends "game:resign" | "game:abort" | "game:draw:offer" | "game:claim:victory" | "game:rematch:request">(event: E) => {
      if (!socket) return { ok: false as const, error: { code: "OFFLINE", message: "Not connected" } };
      return emitWithAck(socket, event, { gameId });
    },
    [socket, gameId],
  );

  const respondDraw = React.useCallback((accept: boolean) => socket && emitWithAck(socket, "game:draw:respond", { gameId, accept }), [socket, gameId]);
  const claimDraw = React.useCallback((kind: "THREEFOLD_REPETITION" | "FIFTY_MOVE_RULE") => socket && emitWithAck(socket, "game:draw:claim", { gameId, kind }), [socket, gameId]);
  const respondRematch = React.useCallback((accept: boolean) => socket && emitWithAck(socket, "game:rematch:respond", { gameId, accept }), [socket, gameId]);
  const sendChat = React.useCallback((text: string) => socket && emitWithAck(socket, "game:chat:send", { gameId, text }), [socket, gameId]);
  const clearError = React.useCallback(() => setState((prev) => ({ ...prev, error: null })), []);

  const legal = React.useMemo(() => {
    const chess = chessRef.current;
    const dests = new Map<Square, Square[]>();
    if (chess.fen() !== state.fen) return { dests, check: null as Square | null, claimable: [] as string[] };
    for (const m of chess.moves({ verbose: true })) {
      const list = dests.get(m.from) ?? [];
      if (!list.includes(m.to)) list.push(m.to);
      dests.set(m.from, list);
    }
    let check: Square | null = null;
    if (chess.inCheck()) {
      const king = chess.board().flat().find((p) => p && p.type === "k" && p.color === chess.turn());
      check = king?.square ?? null;
    }
    const verdict = adjudicate(chess);
    return { dests, check, claimable: verdict.claimable };
  }, [state.fen]);

  return { state, makeMove, setPremove, action, respondDraw, claimDraw, respondRematch, sendChat, resync, clearError, legal, chess: chessRef };
}

function sys(text: string): ChatLine {
  return { id: Math.random().toString(36).slice(2), userId: "system", username: "", text, at: new Date().toISOString(), system: true };
}
