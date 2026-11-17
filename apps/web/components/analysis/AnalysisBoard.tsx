"use client";

import * as React from "react";
import { Chess, type Square } from "chess.js";
import { Copy, RotateCcw, Sparkles, Undo2, Upload } from "lucide-react";
import { START_FEN, applyUci, identifyOpening, parsePgn, uciToSan } from "@tempo/chess-core";
import type { EngineScoreDTO } from "@tempo/shared";
import { Chessboard } from "@/components/board/Chessboard";
import type { Annotations, Arrow } from "@/components/board/types";
import { MoveList } from "@/components/game/MoveList";
import { useSettings } from "@/components/providers/SettingsProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { EvalBar } from "@/components/review/EvalGraph";

interface EngineLine {
  uci: string;
  score: EngineScoreDTO;
  pv: string[];
}

export function AnalysisBoard({ authenticated, initialFen }: { authenticated: boolean; initialFen: string | null }) {
  const { settings } = useSettings();
  const { toast } = useToast();
  const [startFen, setStartFen] = React.useState<string>(() => {
    if (initialFen) {
      try {
        new Chess(initialFen);
        return initialFen;
      } catch {
        /* ignore */
      }
    }
    return START_FEN;
  });
  const [moves, setMoves] = React.useState<{ ply: number; uci: string; san: string; fen: string }[]>([]);
  const [viewPly, setViewPly] = React.useState(0);
  const [flipped, setFlipped] = React.useState(false);
  const [annotations, setAnnotations] = React.useState<Annotations>({ arrows: [], circles: [] });
  const [engineOn, setEngineOn] = React.useState(false);
  const [lines, setLines] = React.useState<EngineLine[] | null>(null);
  const [depth, setDepth] = React.useState<number | null>(null);
  const [engineBusy, setEngineBusy] = React.useState(false);
  const [engineError, setEngineError] = React.useState<string | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [pgnText, setPgnText] = React.useState("");
  const [fenInput, setFenInput] = React.useState("");

  const chess = React.useMemo(() => {
    const c = new Chess(startFen);
    for (const m of moves.slice(0, viewPly)) applyUci(c, m.uci);
    return c;
  }, [startFen, moves, viewPly]);
  const fen = chess.fen();
  const dests = React.useMemo(() => {
    const map = new Map<Square, Square[]>();
    for (const m of chess.moves({ verbose: true })) {
      const l = map.get(m.from) ?? [];
      if (!l.includes(m.to)) l.push(m.to);
      map.set(m.from, l);
    }
    return map;
  }, [chess]);
  const checkSquare = chess.inCheck() ? (chess.board().flat().find((p) => p && p.type === "k" && p.color === chess.turn())?.square ?? null) : null;
  const opening = React.useMemo(() => (startFen === START_FEN ? identifyOpening(moves.slice(0, viewPly).map((m) => m.uci)) : null), [startFen, moves, viewPly]);
  const last = viewPly > 0 ? moves[viewPly - 1] : null;

  // Engine evaluation of the current position (debounced, server-side Stockfish).
  React.useEffect(() => {
    if (!engineOn || !authenticated) return;
    let cancelled = false;
    setEngineBusy(true);
    setEngineError(null);
    const t = setTimeout(async () => {
      const res = await fetch("/api/analysis/position", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fen, depth: 14, multipv: 3 }) });
      if (cancelled) return;
      setEngineBusy(false);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setEngineError(body.message ?? "Engine unavailable");
        setLines(null);
        return;
      }
      const data = (await res.json()) as { lines: EngineLine[]; depth: number };
      setLines(data.lines);
      setDepth(data.depth);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [engineOn, fen, authenticated]);

  const onMove = (from: Square, to: Square, promotion?: "q" | "r" | "b" | "n") => {
    const uci = `${from}${to}${promotion ?? ""}`;
    const c = new Chess(fen);
    const applied = applyUci(c, uci);
    if (!applied) return;
    const kept = moves.slice(0, viewPly);
    setMoves([...kept, { ply: kept.length + 1, uci, san: applied.san, fen: applied.fenAfter }]);
    setViewPly(kept.length + 1);
  };

  const importPgn = () => {
    try {
      const parsed = parsePgn(pgnText);
      setStartFen(parsed.initialFen);
      setAnnotations({ arrows: [], circles: [] });
      setMoves(parsed.ucis.map((uci, i) => ({ ply: i + 1, uci, san: parsed.sans[i]!, fen: parsed.fens[i + 1]! })));
      setViewPly(parsed.ucis.length);
      setImportOpen(false);
      toast({ title: `Imported ${parsed.ucis.length} moves`, tone: "success" });
    } catch (err) {
      toast({ title: "Could not parse PGN", description: err instanceof Error ? err.message : undefined, tone: "danger" });
    }
  };
  const loadFen = () => {
    try {
      new Chess(fenInput.trim());
      setStartFen(fenInput.trim());
      setAnnotations({ arrows: [], circles: [] });
      setMoves([]);
      setViewPly(0);
      setImportOpen(false);
    } catch {
      toast({ title: "Invalid FEN", tone: "danger" });
    }
  };
  const reset = () => {
    setStartFen(START_FEN);
    setAnnotations({ arrows: [], circles: [] });
    setMoves([]);
    setViewPly(0);
    setLines(null);
  };

  const best = lines?.[0];
  const autoArrows: Arrow[] = engineOn && best?.uci ? [{ from: best.uci.slice(0, 2) as Square, to: best.uci.slice(2, 4) as Square, color: "rgba(129,182,76,0.95)", kind: "auto" }] : [];
  const orientation = flipped ? "black" : "white";
  const fmt = (s: EngineScoreDTO) => (s.mate != null && s.mate !== 0 ? `M${Math.abs(s.mate)}` : `${(s.cp ?? 0) > 0 ? "+" : ""}${((s.cp ?? 0) / 100).toFixed(2)}`);
  const lineSan = (l: EngineLine) => {
    const c = new Chess(fen);
    const out: string[] = [];
    for (const u of l.pv.slice(0, 6)) {
      const san = uciToSan(c.fen(), u);
      if (!san) break;
      out.push(san);
      c.move(san);
    }
    return out.join(" ");
  };

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex w-full items-stretch gap-2 max-w-[min(100vw-1.5rem,calc(100dvh-12rem))] lg:flex-1">
        {engineOn ? <EvalBar score={best?.score ?? null} orientation={orientation} className="shrink-0" /> : null}
        <div className="min-w-0 flex-1">
          <Chessboard
            fen={fen}
            orientation={orientation}
            movable="both"
            dests={dests}
            onMove={onMove}
            lastMove={last ? { from: last.uci.slice(0, 2) as Square, to: last.uci.slice(2, 4) as Square } : null}
            checkSquare={checkSquare}
            annotations={annotations}
            onAnnotationsChange={setAnnotations}
            annotationColor={settings.arrowColor}
            autoArrows={autoArrows}
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
      <aside className="flex w-full flex-col gap-3 lg:w-[22rem]">
        <div className="card p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{opening ? `${opening.opening.name} (${opening.opening.eco})` : "Analysis board"}</span>
            <Button size="sm" variant={engineOn ? "primary" : "secondary"} onClick={() => setEngineOn((v) => !v)} disabled={!authenticated} title={authenticated ? "Toggle Stockfish" : "Log in to use the engine"}>
              <Sparkles className="h-4 w-4" /> Engine
            </Button>
          </div>
          {engineOn ? (
            <div className="mt-2 space-y-1 text-xs">
              {engineError ? <p className="text-danger">{engineError}</p> : null}
              {engineBusy && !lines ? <p className="text-fg-muted">Thinking…</p> : null}
              {lines?.map((l, i) => (
                <p key={i} className="font-mono">
                  <span className="mr-2 inline-block w-12 font-semibold">{fmt(l.score)}</span>
                  {lineSan(l)}
                </p>
              ))}
              {lines ? <p className="text-fg-faint">Stockfish depth {depth}{engineBusy ? " · updating…" : ""}</p> : null}
            </div>
          ) : !authenticated ? (
            <p className="mt-2 text-xs text-fg-muted">Log in to turn on the engine.</p>
          ) : null}
        </div>
        <div className="card flex h-[20rem] flex-col overflow-hidden">
          <MoveList moves={moves} viewPly={viewPly} onSelect={setViewPly} className="flex-1" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" variant="secondary" onClick={() => setFlipped((f) => !f)}>
            <RotateCcw className="h-4 w-4" /> Flip
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" /> Import
          </Button>
          <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(fen).then(() => toast({ title: "FEN copied", tone: "success" }))}>
            <Copy className="h-4 w-4" /> Copy FEN
          </Button>
          <Button size="sm" variant="secondary" onClick={reset}>
            <Undo2 className="h-4 w-4" /> Reset
          </Button>
        </div>
        <p className="break-all font-mono text-[11px] text-fg-faint">{fen}</p>
      </aside>
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import a game or position">
        <div className="space-y-3">
          <textarea value={pgnText} onChange={(e) => setPgnText(e.target.value)} rows={6} placeholder="Paste PGN here" className="w-full rounded-xl border border-border bg-surface p-3 font-mono text-xs outline-none focus:border-accent" />
          <Button fullWidth onClick={importPgn} disabled={!pgnText.trim()}>
            Import PGN
          </Button>
          <div className="flex gap-2">
            <input value={fenInput} onChange={(e) => setFenInput(e.target.value)} placeholder="Or paste a FEN" className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 font-mono text-xs outline-none focus:border-accent" />
            <Button variant="secondary" onClick={loadFen} disabled={!fenInput.trim()}>
              Load FEN
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
