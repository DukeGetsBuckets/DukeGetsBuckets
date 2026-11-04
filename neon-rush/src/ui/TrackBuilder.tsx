// NEON RUSH Track Builder: a cursor-chain level editor. Pieces are appended at the glowing
// build arrow (the end of the track by default), so tracks stay connected. A free cursor mode
// lets builders start new segments (e.g. a landing after a jump). Works with touch only
// (iPad) as well as mouse + keyboard.

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Placement, ThemeId, TrackDefinition } from '@shared/track/types';
import { PIECE_LIST, PIECES, BUILDER_CATEGORIES, type PieceCategory, type PieceDef } from '@shared/track/pieces';
import { advanceCursor, type Cursor } from '@shared/track/chain';
import { compileTrack } from '@shared/track/compile';
import { THEMES } from '@game/track/themes';
import { EditorScene } from '@game/editor/EditorScene';
import {
  type EditorSnapshot, type History, type EditorIssue,
  MAX_PIECES, MAX_NAME, THEME_IDS, TEMPLATES, DRAFT_STORAGE_KEY,
  appendPiece, insertAfter, deletePiece, replacePiece, toggleWalls, moveCursor, raiseCursor, rotateCursor, setCursor,
  snapCursorToEnd, cursorOf, placementCursor, supportsWalls, defaultPlacements, templatePlacements, validateTrack,
  createHistory, pushHistory, replacePresent, undo as undoH, redo as redoH, canUndo, canRedo,
  definitionFromDraft, sanitizeDraft,
} from '@game/editor/editorModel';
import { tryGame } from '@app/gameRef';

export interface BuilderDraft { id?: string; code?: string; name: string; theme: ThemeId; placements: Placement[]; description?: string }

export function draftToDefinition(d: BuilderDraft): TrackDefinition {
  return definitionFromDraft(d);
}

export interface TrackBuilderProps {
  initial: BuilderDraft | null;
  onExit: () => void;
  onTestDrive: (def: TrackDefinition, draft: BuilderDraft) => void;
  onSave: (draft: BuilderDraft, publish: boolean) => Promise<{ ok: boolean; message: string; code?: string; id?: string }>;
  status?: string | null;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const CAT_COLORS: Record<PieceCategory, string> = {
  road: '#22d3ee', turn: '#a855f7', elevation: '#a3e635', stunt: '#fb923c', tunnel: '#38bdf8', gate: '#facc15', gap: '#ec4899',
};

function pieceColor(def: PieceDef): string {
  if (def.id === 'start') return '#a3e635';
  if (def.id === 'finish') return '#f472b6';
  if (def.id === 'checkpoint') return '#22d3ee';
  if (def.id === 'boost') return '#facc15';
  return CAT_COLORS[def.category];
}

const iconCache = new Map<string, string>();
/** Small top-down centerline icon (plus a side view for pieces that change height). */
function pieceIcon(def: PieceDef): string {
  const hit = iconCache.get(def.id);
  if (hit) return hit;
  if (typeof document === 'undefined') return '';
  const W = 96, H = 72, dpr = 2;
  const c = document.createElement('canvas');
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.scale(dpr, dpr);
  const N = 48;
  const pts = Array.from({ length: N + 1 }, (_, i) => def.curve(i / N).pos);
  const ys = pts.map((p) => p.y);
  const yRange = Math.max(...ys) - Math.min(...ys);
  const hasSide = yRange > 0.8;
  const half = (def.halfWidth ?? 7) * (def.gap ? 0.4 : 1);
  // top-down: forward (+z) is up on the icon, left (+x) is left
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x - half); maxX = Math.max(maxX, p.x + half); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  minZ -= 3; maxZ += 3;
  const areaW = hasSide ? W * 0.62 : W - 10, areaH = H - 12;
  const s = Math.min(areaW / (maxX - minX), areaH / (maxZ - minZ));
  const cx = (hasSide ? 6 + areaW / 2 : W / 2), cy = H / 2;
  const midX = (minX + maxX) / 2, midZ = (minZ + maxZ) / 2;
  const tx = (x: number) => cx - (x - midX) * s;
  const ty = (z: number) => cy - (z - midZ) * s;
  const color = pieceColor(def);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(tx(p.x), ty(p.z)) : ctx.moveTo(tx(p.x), ty(p.z)))); };
  if (def.gap) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color; ctx.lineWidth = 3; path(); ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = Math.max(8, half * 2 * s + 3); path(); ctx.stroke();
    ctx.strokeStyle = '#1b1738'; ctx.lineWidth = Math.max(6, half * 2 * s); path(); ctx.stroke();
    ctx.shadowColor = color; ctx.shadowBlur = 6;
    ctx.strokeStyle = color; ctx.lineWidth = 2.2; path(); ctx.stroke();
    ctx.shadowBlur = 0;
  }
  // exit arrowhead
  const a = pts[N - 2], b = pts[N];
  const ang = Math.atan2(ty(b.z) - ty(a.z), tx(b.x) - tx(a.x));
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(tx(b.x) + Math.cos(ang) * 5, ty(b.z) + Math.sin(ang) * 5);
  ctx.lineTo(tx(b.x) + Math.cos(ang + 2.4) * 5, ty(b.z) + Math.sin(ang + 2.4) * 5);
  ctx.lineTo(tx(b.x) + Math.cos(ang - 2.4) * 5, ty(b.z) + Math.sin(ang - 2.4) * 5);
  ctx.fill();
  // gate markers
  for (const g of def.gates ?? []) {
    const p = def.curve(g.t).pos;
    ctx.strokeStyle = g.kind === 'start' ? '#a3e635' : g.kind === 'finish' ? '#ffffff' : '#22d3ee';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(tx(p.x - half - 2), ty(p.z)); ctx.lineTo(tx(p.x + half + 2), ty(p.z)); ctx.stroke();
  }
  if (def.boost) {
    ctx.fillStyle = '#facc15';
    for (const t of [0.35, 0.55, 0.75]) {
      const p = def.curve(t).pos;
      ctx.beginPath(); ctx.moveTo(tx(p.x), ty(p.z) - 4); ctx.lineTo(tx(p.x) - 5, ty(p.z) + 2); ctx.lineTo(tx(p.x) + 5, ty(p.z) + 2); ctx.fill();
    }
  }
  // side view (distance along vs height)
  if (hasSide) {
    const sx0 = W * 0.7, sw = W * 0.27, sy0 = 8, sh = H - 16;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(sx0 - 2, sy0 - 2, sw + 4, sh + 4);
    const zs = pts.map((p) => p.z);
    const minS = Math.min(...zs), maxS = Math.max(...zs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = Math.max(maxS - minS, maxY - minY, 1);
    const ss = Math.min(sw / span, sh / span);
    const ox = sx0 + (sw - (maxS - minS) * ss) / 2, oy = sy0 + sh - (sh - (maxY - minY) * ss) / 2;
    ctx.strokeStyle = def.gap ? color : '#ffffff'; ctx.lineWidth = 2;
    if (def.gap) ctx.setLineDash([3, 3]);
    ctx.beginPath();
    pts.forEach((p, i) => { const X = ox + (p.z - minS) * ss, Y = oy - (p.y - minY) * ss; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const url = c.toDataURL();
  iconCache.set(def.id, url);
  return url;
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

type Icon = 'up' | 'down' | 'left' | 'right' | 'rotL' | 'rotR' | 'raise' | 'lower' | 'undo' | 'redo' | 'trash' | 'focus' | 'frame' | 'swap' | 'plus'
  | 'close' | 'play' | 'save' | 'upload' | 'back' | 'walls' | 'grid' | 'check' | 'warn' | 'info' | 'zoomIn' | 'zoomOut' | 'move' | 'end' | 'copy' | 'prev' | 'next' | 'erase';
const ICONS: Record<Icon, string> = {
  up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M5 12l7 7 7-7', left: 'M19 12H5M12 5l-7 7 7 7', right: 'M5 12h14M12 5l7 7-7 7',
  rotL: 'M4 12a8 8 0 1 0 2.6-5.9M4 3.5V9h5.5', rotR: 'M20 12a8 8 0 1 1-2.6-5.9M20 3.5V9h-5.5',
  raise: 'M12 20V9M7 13l5-5 5 5M5 4h14', lower: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11', redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  focus: 'M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M12 2v4M12 18v4M2 12h4M18 12h4', frame: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  swap: 'M4 8h14l-4-4M20 16H6l4 4', plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M18 6L6 18', play: 'M7 4.5v15l12.5-7.5z',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6', upload: 'M12 16V4M7 9l5-5 5 5M4 20h16', back: 'M15 18l-6-6 6-6',
  walls: 'M4 20V7M20 20V7M4 13h16M8 20v-4M16 20v-4', grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  check: 'M5 12.5l4.5 4.5L19 7', warn: 'M12 4l9 16H3zM12 10v4.5M12 17.5v.5', info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v6M12 7.5v.5',
  zoomIn: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M20 20l-4.8-4.8M10.5 7.5v6M7.5 10.5h6', zoomOut: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M20 20l-4.8-4.8M7.5 10.5h6',
  move: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3', end: 'M5 12h11M12 7l5 5-5 5M20 5v14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1', prev: 'M15 6l-6 6 6 6', next: 'M9 6l6 6-6 6', erase: 'M20 6H9l-6 6 6 6h11zM13 10l4 4M17 10l-4 4',
};
function Ico({ name, size = 20, className = '' }: { name: Icon; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

function IconBtn({ icon, label, onClick, disabled, active, className = '', size = 48, children, title, tone }: {
  icon?: Icon; label?: string; onClick?: () => void; disabled?: boolean; active?: boolean; className?: string; size?: number; children?: React.ReactNode; title?: string; tone?: 'danger' | 'accent';
}) {
  return (
    <button type="button" title={title ?? label} aria-label={title ?? label} disabled={disabled} onClick={onClick}
      className={`tb-btn ${active ? 'tb-active' : ''} ${tone === 'danger' ? 'tb-danger' : tone === 'accent' ? 'tb-accent' : ''} ${className}`}
      style={{ minWidth: size, height: size }}>
      {icon && <Ico name={icon} size={size >= 48 ? 22 : 18} />}
      {label && <span className="tb-btn-label">{label}</span>}
      {children}
    </button>
  );
}

const CSS = `
.tb-root { font-family: var(--font-body); }
.tb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.14); background: linear-gradient(135deg, rgba(56,189,248,0.14), rgba(168,85,247,0.14));
  color: #fff; font-family: var(--font-display); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; font-size: 12px;
  transition: transform 100ms ease, box-shadow 140ms ease, border-color 140ms ease, background 140ms ease; cursor: pointer; touch-action: manipulation; white-space: nowrap; }
.tb-btn:hover:not(:disabled) { border-color: rgba(56,189,248,0.7); box-shadow: 0 0 20px -4px rgba(56,189,248,0.8); }
.tb-btn:active:not(:disabled) { transform: scale(0.95); }
.tb-btn:disabled { color: rgba(255,255,255,0.28); background: rgba(255,255,255,0.03); border-color: rgba(255,255,255,0.07); cursor: default; box-shadow: none; }
.tb-btn.tb-accent:disabled { color: rgba(7,6,26,0.75); background: linear-gradient(135deg, rgba(34,211,238,0.35), rgba(168,85,247,0.35) 60%, rgba(236,72,153,0.35)); }
.tb-btn.tb-active { background: linear-gradient(135deg, rgba(34,211,238,0.55), rgba(168,85,247,0.5)); border-color: #22d3ee; box-shadow: 0 0 18px -4px #22d3ee; }
.tb-btn.tb-danger { background: linear-gradient(135deg, rgba(236,72,153,0.28), rgba(251,146,60,0.24)); }
.tb-btn.tb-danger:hover:not(:disabled) { border-color: #fb7185; box-shadow: 0 0 20px -4px #fb7185; }
.tb-btn.tb-accent { background: linear-gradient(135deg, #22d3ee, #a855f7 60%, #ec4899); color: #07061a; border-color: transparent; }
.tb-btn.tb-accent:hover:not(:disabled) { box-shadow: 0 0 26px -2px rgba(236,72,153,0.8); }
.tb-tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 4px 5px; border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(10,8,34,0.72); color: #e2e8f0; cursor: pointer; touch-action: manipulation;
  transition: transform 100ms ease, border-color 140ms ease, box-shadow 140ms ease, background 140ms ease; }
.tb-tile:hover { border-color: var(--c); box-shadow: 0 0 18px -6px var(--c); background: rgba(24,18,64,0.85); }
.tb-tile:active { transform: scale(0.94); }
.tb-tile img { width: 84px; height: 63px; pointer-events: none; }
.tb-tile .tb-name { font-size: 12px; font-weight: 700; line-height: 1.1; text-align: center; letter-spacing: 0.02em; }
.tb-tile .tb-key { position: absolute; top: 4px; left: 6px; font-size: 10px; font-weight: 700; color: rgba(255,255,255,0.35); font-family: var(--font-display); }
.tb-tab { padding: 6px 10px; border-radius: 999px; font-family: var(--font-display); font-weight: 700; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  border: 1px solid rgba(255,255,255,0.12); color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.03); white-space: nowrap; cursor: pointer; min-height: 36px; touch-action: manipulation; }
.tb-tab.on { color: #07061a; background: var(--c); border-color: var(--c); box-shadow: 0 0 16px -4px var(--c); }
.tb-scroll { scrollbar-width: thin; scrollbar-color: rgba(168,85,247,0.6) transparent; touch-action: pan-x pan-y; }
.tb-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.tb-scroll::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.6); border-radius: 3px; }
.tb-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(255,255,255,0.5); }
.tb-select option { background: #0d0b2b; color: #fff; }
.tb-issue { display: flex; gap: 8px; align-items: flex-start; text-align: left; width: 100%; padding: 6px 8px; border-radius: 10px; font-size: 13px; line-height: 1.25; font-weight: 600; }
.tb-issue:hover { background: rgba(255,255,255,0.06); }
.tb-badge { display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; height: 40px; border-radius: 999px; font-family: var(--font-display); font-weight: 900; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer; white-space: nowrap; }
`;

type PaletteMode = 'append' | 'replace' | 'insert';
type Action =
  | { type: 'edit'; fn: (s: EditorSnapshot) => EditorSnapshot }
  | { type: 'cursor'; fn: (s: EditorSnapshot) => EditorSnapshot }
  | { type: 'undo' } | { type: 'redo' };

function historyReducer(h: History, a: Action): History {
  switch (a.type) {
    case 'edit': return pushHistory(h, a.fn(h.present));
    case 'cursor': return replacePresent(h, a.fn(h.present));
    case 'undo': return undoH(h);
    case 'redo': return redoH(h);
  }
}

function loadStoredDraft(): BuilderDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    return raw ? sanitizeDraft(JSON.parse(raw)) : null;
  } catch { return null; }
}

function initialDraft(initial: BuilderDraft | null): BuilderDraft {
  const d = (initial ? sanitizeDraft(initial) : null) ?? loadStoredDraft() ?? { name: 'My Track', theme: 'neonCity' as ThemeId, placements: [] };
  return { ...d, placements: d.placements.length ? d.placements : defaultPlacements() };
}

const HEADING_NAMES = ['north', 'east', 'south', 'west'];

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export function TrackBuilder(props: TrackBuilderProps) {
  const { onExit, onTestDrive, onSave, status } = props;
  const [init] = useState(() => initialDraft(props.initial));
  const [meta, setMeta] = useState(() => ({ id: init.id, code: init.code, name: init.name, theme: init.theme, description: init.description }));
  const [hist, dispatch] = useReducer(historyReducer, init.placements, (p) => createHistory({ placements: p, cursor: null }));
  const snap = hist.present;
  const placements = snap.placements;
  const cursor = cursorOf(snap);
  const freeMode = snap.cursor !== null;

  const [selected, setSelected] = useState<number | null>(null);
  const [hoverPiece, setHoverPiece] = useState<number | null>(null);
  const [hoverType, setHoverType] = useState<string | null>(null);
  const [category, setCategory] = useState<PieceCategory>('road');
  const [mode, setMode] = useState<PaletteMode>('append');
  const [busy, setBusy] = useState<null | 'save' | 'publish'>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showIssues, setShowIssues] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sceneReady, setSceneReady] = useState(false);
  const [view, setView] = useState(() => ({ w: typeof window !== 'undefined' ? window.innerWidth : 1280, h: typeof window !== 'undefined' ? window.innerHeight : 800 }));
  const viewRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<EditorScene | null>(null);
  const framedRef = useRef(false);
  const frameNextRef = useRef(false);
  const followRef = useRef(false); // pan the camera to keep the build arrow visible after the next cursor change
  const topRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const wide = view.w >= 1000 && view.h >= 600;
  const compact = view.w < 700;
  const labels = view.w >= 1100;   // text labels on secondary top-bar buttons

  const compiled = useMemo(() => compileTrack({ pieces: placements }), [placements]);
  const validation = useMemo(() => validateTrack(placements, compiled), [placements, compiled]);
  const draft: BuilderDraft = useMemo(() => ({
    ...(meta.id ? { id: meta.id } : {}), ...(meta.code ? { code: meta.code } : {}),
    name: meta.name, theme: meta.theme, placements, ...(meta.description ? { description: meta.description } : {}),
  }), [meta, placements]);

  // keep selection in range
  useEffect(() => {
    if (selected !== null && selected >= placements.length) setSelected(placements.length ? placements.length - 1 : null);
  }, [placements, selected]);
  useEffect(() => { if (selected === null && mode !== 'append') setMode('append'); }, [selected, mode]);

  // persist the draft
  useEffect(() => {
    try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft)); } catch { /* storage unavailable */ }
  }, [draft]);

  useEffect(() => {
    const on = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  /* ---------- 3D scene lifecycle ---------- */

  const tapRef = useRef<(piece: number | null, ground: { x: number; z: number } | null) => void>(() => {});
  useEffect(() => {
    let scene: EditorScene | null = null;
    let timer = 0;
    let cancelled = false;
    const tryInit = () => {
      if (cancelled) return;
      const game = tryGame();
      const el = viewRef.current;
      if (!game || !el) { timer = window.setTimeout(tryInit, 150); return; }
      scene = new EditorScene(game, el);
      scene.events = { onTap: (p, g) => tapRef.current(p, g), onHover: (p) => setHoverPiece(p) };
      scene.attach();
      sceneRef.current = scene;
      setSceneReady(true);
    };
    tryInit();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      scene?.dispose();
      sceneRef.current = null;
      setSceneReady(false);
    };
  }, []);

  // tell the 3D view which screen areas are covered by panels so it centers the track in the rest
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const W = window.innerWidth, H = window.innerHeight;
    const r = (el: HTMLElement | null) => el?.getBoundingClientRect();
    const top = r(topRef.current), left = r(leftRef.current), right = r(rightRef.current), bottom = r(bottomRef.current);
    s.setInsets({
      top: top ? top.bottom : 0,
      left: left ? left.right : 0,
      right: right && right.width > 60 ? W - right.left : 0,
      bottom: bottom ? H - bottom.top : 40,
    });
  });

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.setTrack(placements, compiled, meta.theme);
    if (!framedRef.current) {
      framedRef.current = true;
      if (!s.restoredCamera) s.frameAll(true, true);
    } else if (frameNextRef.current) {
      frameNextRef.current = false;
      s.frameAll(false, true);
    }
  }, [sceneReady, placements, compiled, meta.theme]);

  useEffect(() => { sceneRef.current?.setSelection(selected, hoverPiece, validation.flagged); }, [sceneReady, selected, hoverPiece, validation.flagged, compiled]);
  useEffect(() => {
    sceneRef.current?.setCursor(cursor);
    if (followRef.current) { followRef.current = false; sceneRef.current?.keepInView(cursor); }
  }, [sceneReady, cursor.x, cursor.y, cursor.z, cursor.rot]); // eslint-disable-line react-hooks/exhaustive-deps

  const ghostAt: Cursor | null = useMemo(() => {
    if (mode === 'append') return cursor;
    if (selected === null || !placements[selected]) return null;
    const p = placements[selected];
    return mode === 'replace' ? placementCursor(p) : advanceCursor(placementCursor(p), p.type);
  }, [mode, selected, placements, cursor]);
  useEffect(() => { sceneRef.current?.setGhost(hoverType, hoverType ? ghostAt : null); }, [sceneReady, hoverType, ghostAt, compiled]);

  /* ---------- actions ---------- */

  const say = useCallback((text: string, ok = true) => setToast({ text, ok }), []);

  const addPiece = useCallback((type: string) => {
    if (mode === 'replace' && selected !== null) {
      dispatch({ type: 'edit', fn: (s) => replacePiece(s, selected, type) });
      setMode('append');
      return;
    }
    if (placements.length >= MAX_PIECES) { say(`Maximum of ${MAX_PIECES} pieces reached.`, false); return; }
    if (mode === 'insert' && selected !== null) {
      dispatch({ type: 'edit', fn: (s) => insertAfter(s, selected, type) });
      setSelected(selected + 1);
      return;
    }
    followRef.current = true;
    dispatch({ type: 'edit', fn: (s) => appendPiece(s, type) });
  }, [mode, selected, placements.length, say]);

  const removeSelected = useCallback(() => {
    if (selected === null) return;
    dispatch({ type: 'edit', fn: (s) => deletePiece(s, selected) });
    const remaining = placements.length - 1;
    setSelected(remaining <= 0 ? null : Math.min(selected, remaining - 1));
  }, [selected, placements.length]);

  const removeLast = useCallback(() => {
    if (!placements.length) return;
    dispatch({ type: 'edit', fn: (s) => deletePiece(s, s.placements.length - 1) });
    setSelected(null);
  }, [placements.length]);

  const doUndo = useCallback(() => dispatch({ type: 'undo' }), []);
  const doRedo = useCallback(() => dispatch({ type: 'redo' }), []);

  const nudge = useCallback((dir: 'up' | 'down' | 'left' | 'right') => {
    const axes = sceneRef.current?.screenAxes() ?? { forward: { dx: 0, dz: 1 }, right: { dx: -1, dz: 0 } };
    const v = dir === 'up' ? axes.forward : dir === 'down' ? { dx: -axes.forward.dx, dz: -axes.forward.dz }
      : dir === 'right' ? axes.right : { dx: -axes.right.dx, dz: -axes.right.dz };
    followRef.current = true;
    dispatch({ type: 'cursor', fn: (s) => moveCursor(s, v.dx, v.dz) });
  }, []);
  const rotate = useCallback((q: number) => dispatch({ type: 'cursor', fn: (s) => rotateCursor(s, q) }), []);
  const raise = useCallback((n: number) => { followRef.current = true; dispatch({ type: 'cursor', fn: (s) => raiseCursor(s, n) }); }, []);
  const toggleFree = useCallback(() => dispatch({ type: 'cursor', fn: (s) => (s.cursor ? snapCursorToEnd(s) : setCursor(s, cursorOf(s))) }), []);
  const snapEnd = useCallback(() => { followRef.current = true; dispatch({ type: 'cursor', fn: snapCursorToEnd }); }, []);

  const select = useCallback((i: number | null, focus = false) => {
    setSelected(i);
    if (i !== null && focus) sceneRef.current?.focusPiece(i);
  }, []);
  const stepSelection = useCallback((d: number) => {
    if (!placements.length) return;
    const next = selected === null ? (d > 0 ? 0 : placements.length - 1) : (selected + d + placements.length) % placements.length;
    select(next, true);
  }, [selected, placements.length, select]);

  const doToggleWalls = useCallback(() => {
    if (selected === null) return;
    dispatch({ type: 'edit', fn: (s) => toggleWalls(s, selected) });
  }, [selected]);

  const loadTemplate = useCallback((id: string) => {
    setShowTemplates(false);
    setSelected(null); setMode('append');
    if (id === 'blank') {
      dispatch({ type: 'edit', fn: () => ({ placements: defaultPlacements(), cursor: null }) });
      say('Fresh start! Use Undo to get your old track back.');
    } else {
      const t = TEMPLATES.find((x) => x.id === id);
      if (!t) return;
      dispatch({ type: 'edit', fn: () => ({ placements: templatePlacements(t), cursor: null }) });
      setMeta((m) => ({ ...m, theme: t.theme, name: m.name === 'My Track' || !m.name.trim() || TEMPLATES.some((x) => x.name === m.name) ? t.name : m.name }));
      say(`Loaded “${t.name}”. Use Undo to go back.`);
    }
    frameNextRef.current = true;
  }, [say]);

  const clearAll = useCallback(() => {
    setConfirmClear(false);
    setSelected(null); setMode('append');
    dispatch({ type: 'edit', fn: () => ({ placements: [], cursor: null }) });
    setCategory('gate');
    say('Track cleared. Add a Start Line first!');
  }, [say]);

  const testDrive = useCallback(() => {
    if (!validation.valid) { setShowIssues(true); setPanelOpen(true); say('Fix the problems first!', false); return; }
    onTestDrive(draftToDefinition(draft), draft);
  }, [validation.valid, draft, onTestDrive, say]);

  const save = useCallback(async (publish: boolean) => {
    if (busy) return;
    setBusy(publish ? 'publish' : 'save');
    try {
      const r = await onSave(draft, publish);
      if (r.ok && (r.code || r.id)) setMeta((m) => ({ ...m, code: r.code ?? m.code, id: r.id ?? m.id }));
      say(r.message || (r.ok ? 'Saved!' : 'Could not save.'), r.ok);
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not save.', false);
    } finally {
      setBusy(null);
    }
  }, [busy, draft, onSave, say]);

  const copyCode = useCallback(() => {
    if (!meta.code) return;
    try { void navigator.clipboard?.writeText(meta.code).then(() => say('Share code copied!')).catch(() => say(`Share code: ${meta.code}`)); }
    catch { say(`Share code: ${meta.code}`); }
  }, [meta.code, say]);

  const onIssueClick = useCallback((it: EditorIssue) => {
    const p = it.pieces?.[0];
    if (p !== undefined) select(p, true);
  }, [select]);

  // tap in the 3D view
  tapRef.current = (piece, ground) => {
    if (piece !== null) { setSelected((s) => (s === piece ? null : piece)); return; }
    if (selected !== null) { setSelected(null); return; }
    if (freeMode && ground) dispatch({ type: 'cursor', fn: (s) => setCursor(s, { x: ground.x, y: cursorOf(s).y, z: ground.z, rot: cursorOf(s).rot }) });
  };

  const categoryPieces = useMemo(() => PIECE_LIST.filter((p) => p.category === category), [category]);

  /* ---------- keyboard ---------- */

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const lower = k.toLowerCase();
    let handled = true;
    if (ctrl && lower === 'z' && !e.shiftKey) doUndo();
    else if (ctrl && (lower === 'y' || (lower === 'z' && e.shiftKey))) doRedo();
    else if (ctrl) handled = false;
    else if (confirmClear) { if (k === 'Escape') setConfirmClear(false); else handled = false; }
    else if (lower === 'q') rotate(1);
    else if (lower === 'e') rotate(-1);
    else if (k === 'ArrowUp' || lower === 'w') nudge('up');
    else if (k === 'ArrowDown' || lower === 's') nudge('down');
    else if (k === 'ArrowLeft' || lower === 'a') nudge('left');
    else if (k === 'ArrowRight' || lower === 'd') nudge('right');
    else if (lower === 'r') raise(1);
    else if (lower === 'f') raise(-1);
    else if (k === 'Delete' || k === 'Backspace') { if (selected !== null) removeSelected(); else removeLast(); }
    else if (k === 'Escape') { if (showTemplates) setShowTemplates(false); else if (mode !== 'append') setMode('append'); else setSelected(null); }
    else if (k === '[' || k === ',') stepSelection(-1);
    else if (k === ']' || k === '.') stepSelection(1);
    else if (lower === 't') doToggleWalls();
    else if (lower === 'c') sceneRef.current?.focusCursor();
    else if (lower === 'v') sceneRef.current?.frameAll(false, true);
    else if (lower === 'g') toggleFree();
    else if (k === 'Enter' && e.shiftKey) testDrive();
    else if (/^[1-9]$/.test(k)) { const p = categoryPieces[Number(k) - 1]; if (p) addPiece(p.id); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  /* ---------- render ---------- */

  const sel = selected !== null ? placements[selected] : undefined;
  const selDef = sel ? PIECES[sel.type] : undefined;
  const themeObj = THEMES[meta.theme];
  const hint = !placements.length ? 'Start with a Start Line from the Gates tab — it appears at the glowing arrow.'
    : mode === 'replace' && selected !== null ? `Pick a piece to replace #${selected + 1}.`
    : mode === 'insert' && selected !== null ? `Pick pieces to insert after #${selected + 1}. They push the rest of the track along.`
    : freeMode ? 'Free cursor: tap the grid or use the arrows to move the glowing arrow. New pieces appear there.'
    : 'Click a piece to add it at the glowing arrow · drag to orbit · pinch or scroll to zoom · tap the track to select.';

  const palette = (
    <div className={`panel rounded-2xl pointer-events-auto flex flex-col ${wide ? 'h-full p-3' : 'p-2'}`} style={{ minHeight: 0 }}>
      <div className={`flex gap-1.5 tb-scroll ${wide ? 'flex-wrap mb-2' : 'overflow-x-auto pb-1.5 mb-1'}`}>
        {BUILDER_CATEGORIES.map((c) => (
          <button key={c.id} type="button" className={`tb-tab ${category === c.id ? 'on' : ''}`} style={{ ['--c' as string]: CAT_COLORS[c.id] } as React.CSSProperties}
            onClick={() => setCategory(c.id)}>{c.label}</button>
        ))}
      </div>
      {mode !== 'append' && selected !== null && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-xl text-sm font-bold" style={{ background: 'rgba(250,204,21,0.12)', border: '1px solid rgba(250,204,21,0.45)', color: '#fde68a' }}>
          <Ico name={mode === 'replace' ? 'swap' : 'plus'} size={16} />
          <span className="flex-1">{mode === 'replace' ? `Replacing #${selected + 1}` : `Inserting after #${selected + 1}`}</span>
          <IconBtn icon="close" size={34} title="Cancel" onClick={() => setMode('append')} />
        </div>
      )}
      <div className={`tb-scroll ${wide ? 'grid grid-cols-2 gap-2 overflow-y-auto pr-1' : 'flex gap-2 overflow-x-auto pb-1'}`} style={{ minHeight: 0 }}>
        {categoryPieces.map((p, i) => (
          <button key={p.id} type="button" className="tb-tile shrink-0" style={{ ['--c' as string]: pieceColor(p), width: wide ? undefined : 104 } as React.CSSProperties}
            title={p.name} data-piece={p.id}
            onClick={() => addPiece(p.id)}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHoverType(p.id); }}
            onPointerLeave={() => setHoverType((t) => (t === p.id ? null : t))}>
            {i < 9 && <span className="tb-key">{i + 1}</span>}
            <img src={pieceIcon(p)} alt="" draggable={false} />
            <span className="tb-name">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const issueColor = (l: EditorIssue['level']) => (l === 'error' ? '#fb7185' : l === 'warning' ? '#fbbf24' : '#67e8f9');

  const sidePanel = (
    <div className="flex flex-col gap-2 pointer-events-auto tb-scroll overflow-y-auto" style={{ maxHeight: '100%' }}>
      {/* selected piece */}
      {sel && selDef && selected !== null && (
        <div className="panel rounded-2xl p-3 anim-fade-in">
          <div className="flex items-center gap-2 mb-2">
            <span className="tb-label">Selected</span>
            <span className="ml-auto text-xs font-bold text-white/50">#{selected + 1} of {placements.length}</span>
            <IconBtn icon="close" size={34} title="Deselect (Esc)" onClick={() => setSelected(null)} />
          </div>
          <div className="flex items-center gap-2 mb-2">
            <img src={pieceIcon(selDef)} alt="" className="rounded-lg" style={{ width: 64, height: 48, background: 'rgba(0,0,0,0.3)' }} />
            <div className="min-w-0">
              <div className="font-display font-bold text-sm truncate" style={{ color: pieceColor(selDef) }}>{selDef.name}</div>
              <div className="text-xs text-white/50 font-semibold">height {sel.y} m{sel.walls ? ' · walls' : ''}</div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            <IconBtn icon="prev" title="Previous piece ( [ )" onClick={() => stepSelection(-1)} />
            <IconBtn icon="next" title="Next piece ( ] )" onClick={() => stepSelection(1)} />
            <IconBtn icon="walls" title="Toggle walls (T)" active={!!sel.walls} disabled={!supportsWalls(sel.type)} onClick={doToggleWalls} />
            <IconBtn icon="trash" title="Delete (Del)" tone="danger" onClick={removeSelected} />
          </div>
          <div className="grid grid-cols-2 gap-1.5 mt-1.5">
            <IconBtn icon="swap" label="Replace" active={mode === 'replace'} onClick={() => setMode(mode === 'replace' ? 'append' : 'replace')} />
            <IconBtn icon="plus" label="Insert" active={mode === 'insert'} onClick={() => setMode(mode === 'insert' ? 'append' : 'insert')} />
          </div>
        </div>
      )}

      {/* build cursor */}
      <div className="panel rounded-2xl p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="tb-label">Build arrow</span>
          <span className="ml-auto text-xs font-bold" style={{ color: '#a3e635' }}>{cursor.y >= 0 ? '+' : ''}{cursor.y} m · {HEADING_NAMES[cursor.rot]}</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <IconBtn icon="rotL" title="Turn arrow left (Q)" onClick={() => rotate(1)} />
          <IconBtn icon="up" title="Move forward (W / ↑)" onClick={() => nudge('up')} />
          <IconBtn icon="rotR" title="Turn arrow right (E)" onClick={() => rotate(-1)} />
          <IconBtn icon="left" title="Move left (A / ←)" onClick={() => nudge('left')} />
          <IconBtn icon="focus" title="Focus camera on arrow (C)" onClick={() => sceneRef.current?.focusCursor()} />
          <IconBtn icon="right" title="Move right (D / →)" onClick={() => nudge('right')} />
          <IconBtn icon="lower" title="Lower (F)" onClick={() => raise(-1)} />
          <IconBtn icon="down" title="Move back (S / ↓)" onClick={() => nudge('down')} />
          <IconBtn icon="raise" title="Raise (R)" onClick={() => raise(1)} />
        </div>
        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
          <IconBtn icon="move" label={freeMode ? 'Free: on' : 'Free: off'} active={freeMode} title="Free cursor (G): tap the grid to move the arrow" onClick={toggleFree} />
          <IconBtn icon="end" label="To end" disabled={!freeMode} title="Snap the arrow back to the end of the track" onClick={snapEnd} />
        </div>
        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
          <IconBtn icon="erase" label="Last" title="Remove the last piece (Backspace)" disabled={!placements.length} onClick={removeLast} />
          <IconBtn icon="frame" label="View all" title="Show the whole track (V)" onClick={() => sceneRef.current?.frameAll(false, true)} />
        </div>
      </div>

      {/* validation */}
      <div className="panel rounded-2xl p-3">
        <button type="button" className="flex items-center gap-2 w-full" onClick={() => setShowIssues((v) => !v)}>
          <span className="tb-label">Track check</span>
          <span className="ml-auto text-xs font-bold" style={{ color: validation.valid ? '#a3e635' : '#fb7185' }}>
            {validation.valid ? (validation.warnings ? `Valid · ${validation.warnings} warning${validation.warnings > 1 ? 's' : ''}` : 'All good!') : `${validation.errors} problem${validation.errors > 1 ? 's' : ''}`}
          </span>
          <Ico name={showIssues ? 'down' : 'right'} size={14} />
        </button>
        {showIssues && (
          <div className="mt-2 flex flex-col gap-0.5">
            {validation.issues.length === 0 && (
              <div className="tb-issue" style={{ color: '#a3e635' }}><Ico name="check" size={16} /> <span>Ready to test drive! Your track has a start and a finish.</span></div>
            )}
            {validation.issues.slice(0, 8).map((it, i) => (
              <button type="button" key={i} className="tb-issue" style={{ color: issueColor(it.level) }} onClick={() => onIssueClick(it)}>
                <span className="shrink-0 mt-0.5"><Ico name={it.level === 'error' ? 'close' : it.level === 'warning' ? 'warn' : 'info'} size={15} /></span>
                <span>{it.message}</span>
              </button>
            ))}
            {validation.issues.length > 8 && <div className="text-xs text-white/40 px-2">+{validation.issues.length - 8} more</div>}
            <div className="text-[11px] text-white/35 px-2 mt-1 font-semibold">{placements.length} / {MAX_PIECES} pieces · {(compiled.length / 1000).toFixed(2)} km</div>
          </div>
        )}
      </div>
    </div>
  );

  const badge = (
    <button type="button" className="tb-badge pointer-events-auto" onClick={() => { setPanelOpen(true); setShowIssues(true); }}
      style={validation.valid
        ? { color: '#a3e635', background: 'rgba(163,230,53,0.12)', border: '1px solid rgba(163,230,53,0.55)', boxShadow: '0 0 16px -6px #a3e635' }
        : { color: '#fb7185', background: 'rgba(251,113,133,0.12)', border: '1px solid rgba(251,113,133,0.55)' }}>
      <Ico name={validation.valid ? 'check' : 'warn'} size={16} />
      {validation.valid ? 'Valid' : `${validation.errors} issue${validation.errors > 1 ? 's' : ''}`}
    </button>
  );

  const sidebarW = view.w < 900 ? 228 : 264;

  return (
    <div className="tb-root fixed inset-0 z-20 select-none" style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)', paddingLeft: 'var(--safe-left)', paddingRight: 'var(--safe-right)' }}>
      <style>{CSS}</style>
      {/* 3D interaction surface */}
      <div ref={viewRef} className="absolute inset-0" style={{ touchAction: 'none', cursor: hoverPiece !== null ? 'pointer' : 'grab' }} data-testid="builder-viewport" />

      <div className="absolute inset-0 flex flex-col pointer-events-none p-2 md:p-3 gap-2" style={{ paddingTop: 'calc(var(--safe-top) + 8px)', paddingBottom: 'calc(var(--safe-bottom) + 8px)' }}>
        {/* top bar */}
        <div ref={topRef} className="panel relative z-30 rounded-2xl px-2 py-2 flex flex-wrap items-center gap-2 pointer-events-auto anim-fade-in">
          <IconBtn icon="back" title="Exit builder" onClick={onExit} />
          {view.w >= (meta.code ? 1400 : 1240) && <div className="font-display font-black tracking-widest text-sm gradient-text px-1">BUILDER</div>}
          <input className="input rounded-xl px-3 font-display text-sm" style={{ height: 44, width: compact ? 150 : 190 }} value={meta.name} maxLength={MAX_NAME}
            placeholder="Track name" aria-label="Track name"
            onChange={(e) => { const name = e.target.value.slice(0, MAX_NAME); setMeta((m) => ({ ...m, name })); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }} />
          <div className="flex items-center gap-1.5 rounded-xl pl-2" style={{ background: 'rgba(7,6,26,0.6)', border: '1px solid rgba(168,85,247,0.4)', height: 44 }}>
            <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: themeObj.accent, boxShadow: `0 0 10px ${themeObj.accent}` }} />
            <select className="tb-select bg-transparent text-white font-bold text-sm outline-none pr-2 h-full" aria-label="Theme" value={meta.theme}
              onChange={(e) => { const theme = e.target.value as ThemeId; setMeta((m) => ({ ...m, theme })); (e.target as HTMLSelectElement).blur(); }}>
              {THEME_IDS.map((id) => <option key={id} value={id}>{THEMES[id].name}</option>)}
            </select>
          </div>
          <div className="relative">
            <IconBtn icon="grid" label={view.w >= 1340 ? 'Templates' : undefined} title="Starter templates" active={showTemplates} onClick={() => setShowTemplates((v) => !v)} />
            {showTemplates && (
              <div className="panel absolute left-0 top-full mt-2 rounded-2xl p-2 w-72 z-30 anim-fade-up flex flex-col gap-1">
                {[{ id: 'blank', name: 'Blank track', description: 'Just a start line and one straight.', theme: meta.theme }, ...TEMPLATES].map((t) => (
                  <button key={t.id} type="button" className="tb-issue" style={{ color: '#fff' }} onClick={() => loadTemplate(t.id)} data-template={t.id}>
                    <span className="w-3 h-3 rounded-full mt-1 shrink-0" style={{ background: THEMES[t.theme].accent }} />
                    <span><span className="font-display text-sm">{t.name}</span><br /><span className="text-xs text-white/55">{t.description}</span></span>
                  </button>
                ))}
                <div className="h-px bg-white/10 my-1" />
                <button type="button" className="tb-issue" style={{ color: '#fb7185' }} onClick={() => { setShowTemplates(false); setConfirmClear(true); }}>
                  <Ico name="trash" size={16} /> <span>Clear everything…</span>
                </button>
              </div>
            )}
          </div>
          <IconBtn icon="undo" title="Undo (Ctrl+Z)" disabled={!canUndo(hist)} onClick={doUndo} />
          <IconBtn icon="redo" title="Redo (Ctrl+Y)" disabled={!canRedo(hist)} onClick={doRedo} />
          <div className="flex-1" />
          {badge}
          {meta.code && (
            <button type="button" className="tb-badge" onClick={copyCode} title="Copy share code"
              style={{ color: '#67e8f9', background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.45)' }}>
              <Ico name="copy" size={15} /> {meta.code}
            </button>
          )}
          <IconBtn icon="play" label={compact ? 'Test' : 'Test drive'} tone="accent" disabled={!validation.valid} onClick={testDrive} title="Test drive (Shift+Enter)" />
          <IconBtn icon="save" label={!labels ? undefined : busy === 'save' ? 'Saving…' : 'Save'} disabled={!!busy} onClick={() => void save(false)} title="Save draft" />
          <IconBtn icon="upload" label={!labels ? undefined : busy === 'publish' ? 'Publishing…' : 'Publish'} disabled={!!busy || !validation.valid} onClick={() => void save(true)} title="Publish to the community" />
        </div>

        {/* middle row */}
        <div className="flex-1 flex gap-2 min-h-0">
          {wide && <div ref={leftRef} className="shrink-0 anim-slide-left" style={{ width: 228, minHeight: 0 }}>{palette}</div>}
          <div className="flex-1 min-w-0 flex flex-col justify-end items-center pointer-events-none">
            {(status || toast) && (
              <div className="flex flex-col items-center gap-1.5 mb-2">
                {status && <div className="panel rounded-full px-4 py-2 text-sm font-bold text-white/90">{status}</div>}
                {toast && (
                  <div key={toast.text} className="rounded-full px-4 py-2 text-sm font-bold anim-pop" style={{ background: toast.ok ? 'rgba(20,83,45,0.85)' : 'rgba(127,29,29,0.85)', border: `1px solid ${toast.ok ? '#4ade80' : '#fb7185'}`, color: '#fff' }}>
                    {toast.text}
                  </div>
                )}
              </div>
            )}
            <div className="rounded-full px-4 py-1.5 text-xs md:text-sm font-semibold text-white/80 text-center max-w-full" style={{ background: 'rgba(7,6,26,0.6)', border: '1px solid rgba(255,255,255,0.08)' }} data-testid="builder-hint">
              {hint}
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end min-h-0" style={{ width: panelOpen ? sidebarW : 'auto' }}>
            <div className="pointer-events-auto mb-1.5 flex gap-1.5">
              <IconBtn icon="zoomIn" size={40} title="Zoom in" onClick={() => sceneRef.current?.zoom(0.75)} />
              <IconBtn icon="zoomOut" size={40} title="Zoom out" onClick={() => sceneRef.current?.zoom(1.33)} />
              <IconBtn icon={panelOpen ? 'next' : 'prev'} size={40} title={panelOpen ? 'Hide panel' : 'Show panel'} onClick={() => setPanelOpen((v) => !v)} />
            </div>
            {panelOpen && <div ref={rightRef} className="w-full min-h-0 flex-1 anim-slide-right">{sidePanel}</div>}
          </div>
        </div>

        {/* bottom palette on narrow screens */}
        {!wide && <div ref={bottomRef} className="shrink-0 anim-fade-up">{palette}</div>}
      </div>

      {confirmClear && (
        <div className="absolute inset-0 flex items-center justify-center z-40 anim-fade-in" style={{ background: 'rgba(4,3,16,0.6)' }} onClick={() => setConfirmClear(false)}>
          <div className="panel rounded-2xl p-5 w-[min(92vw,360px)] anim-pop" onClick={(e) => e.stopPropagation()}>
            <div className="font-display font-black text-lg gradient-text mb-2">Clear the whole track?</div>
            <p className="text-sm text-white/70 font-semibold mb-4">All {placements.length} pieces will be removed. You can still use Undo afterwards.</p>
            <div className="flex gap-2 justify-end">
              <IconBtn label="Cancel" onClick={() => setConfirmClear(false)} />
              <IconBtn icon="trash" label="Clear" tone="danger" onClick={clearAll} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

