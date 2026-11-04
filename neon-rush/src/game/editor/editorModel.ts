// Pure Track Builder logic (no three.js / DOM): edit operations on a placement list,
// build-cursor movement, undo/redo history, validation, templates and draft helpers.
// Shared by the editor UI (src/ui/TrackBuilder.tsx) and unit tests.

import { CELL, HEIGHT_STEP, PIECES, getPiece } from '@shared/track/pieces';
import { advanceCursor, chain, endCursor, type ChainItem, type Cursor } from '@shared/track/chain';
import { compileTrack } from '@shared/track/compile';
import { hashString } from '@shared/math';
import type { CompiledTrack, Placement, ThemeId, TrackDefinition } from '@shared/track/types';

export type { Cursor };

export const MAX_PIECES = 400;
export const MAX_HISTORY = 100;
export const MAX_NAME = 32;
export const Y_STEP = HEIGHT_STEP; // 8 m
export const THEME_IDS: ThemeId[] = ['neonCity', 'skyIslands', 'sunsetCanyon', 'cyberVoid', 'tropicalRush', 'crystalMountains'];

/* ------------------------------------------------------------------ */
/* Editor snapshot                                                     */
/* ------------------------------------------------------------------ */

/**
 * One undoable editor state. `cursor === null` means the build cursor follows the end of
 * the chain (the exit of the last piece); an explicit cursor is a "free placement" cursor.
 */
export interface EditorSnapshot {
  placements: Placement[];
  cursor: Cursor | null;
}

export const normRot = (r: number) => ((Math.round(r) % 4) + 4) % 4;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function defaultPlacements(): Placement[] {
  return chain({ x: 0, y: 0, z: 0, rot: 0 }, ['start', 'straight']);
}

export function emptySnapshot(): EditorSnapshot {
  return { placements: defaultPlacements(), cursor: null };
}

/** Where the next appended piece goes. */
export function cursorOf(s: EditorSnapshot): Cursor {
  return s.cursor ?? endCursor(s.placements);
}

export function placementCursor(p: Placement): Cursor {
  return { x: p.x, y: p.y, z: p.z, rot: normRot(p.rot) };
}

export function sameCursor(a: Cursor, b: Cursor): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.01 && normRot(a.rot) === normRot(b.rot);
}

/** True if `b` starts exactly at `a`'s exit (chain-connected). */
export function isConnected(a: Placement, b: Placement): boolean {
  if (!PIECES[a.type]) return false;
  return sameCursor(advanceCursor(placementCursor(a), a.type), placementCursor(b));
}

/** Whether the walls toggle changes anything for this piece type. */
export function supportsWalls(type: string): boolean {
  const def = PIECES[type];
  if (!def || def.gap) return false;
  return def.profile(true).length !== def.profile(false).length;
}

function place(type: string, c: Cursor, walls?: boolean): Placement {
  return { type, x: round3(c.x), y: round3(c.y), z: round3(c.z), rot: normRot(c.rot), ...(walls ? { walls: true } : {}) };
}

/**
 * Re-chain the run of pieces starting at `from` that were connected to each other (and to
 * the piece before `from` in the original list) so they continue from `start`.
 * `oldList` is the list before the edit, `oldPrevIndex` the index (in oldList) of the piece
 * that `from`'s first piece was connected to (or -1 to only follow internal connections).
 */
function reflowTail(newList: Placement[], from: number, start: Cursor, oldList: Placement[], oldFrom: number, oldPrev: Placement | null): Placement[] {
  const out = newList.slice();
  if (from >= out.length) return out;
  // only reflow when the first tail piece was attached to its predecessor before the edit
  if (!oldPrev || !isConnected(oldPrev, oldList[oldFrom])) return out;
  let cur = start;
  for (let i = from, j = oldFrom; i < out.length; i++, j++) {
    if (j > oldFrom && !isConnected(oldList[j - 1], oldList[j])) break;
    out[i] = place(out[i].type, cur, out[i].walls);
    if (!PIECES[out[i].type]) break;
    cur = advanceCursor(cur, out[i].type);
  }
  return out;
}

export function appendPiece(s: EditorSnapshot, type: string, walls?: boolean): EditorSnapshot {
  getPiece(type);
  if (s.placements.length >= MAX_PIECES) return s;
  const c = cursorOf(s);
  return { placements: [...s.placements, place(type, c, walls)], cursor: null };
}

/** Insert a new piece right after `index` and pull the connected pieces that followed along. */
export function insertAfter(s: EditorSnapshot, index: number, type: string): EditorSnapshot {
  getPiece(type);
  if (index < 0 || index >= s.placements.length) return appendPiece(s, type);
  if (s.placements.length >= MAX_PIECES) return s;
  const prev = s.placements[index];
  const at = advanceCursor(placementCursor(prev), prev.type);
  const piece = place(type, at);
  const list = [...s.placements.slice(0, index + 1), piece, ...s.placements.slice(index + 1)];
  const placements = reflowTail(list, index + 2, advanceCursor(at, type), s.placements, index + 1, prev);
  return { placements, cursor: s.cursor };
}

/** Delete a piece. Connected pieces after it slide back to close the hole. */
export function deletePiece(s: EditorSnapshot, index: number): EditorSnapshot {
  const list = s.placements;
  if (index < 0 || index >= list.length) return s;
  const removed = list[index];
  if (index === list.length - 1) {
    // last piece: cursor moves back to where the removed piece started
    const prev = list[index - 1];
    const connected = prev ? isConnected(prev, removed) : sameCursor(placementCursor(removed), { x: 0, y: 0, z: 0, rot: 0 });
    return { placements: list.slice(0, -1), cursor: connected ? null : placementCursor(removed) };
  }
  const next = [...list.slice(0, index), ...list.slice(index + 1)];
  const placements = reflowTail(next, index, placementCursor(removed), list, index + 1, removed);
  return { placements, cursor: s.cursor };
}

/** Swap a piece's type in place; connected following pieces are re-chained from its new exit. */
export function replacePiece(s: EditorSnapshot, index: number, type: string): EditorSnapshot {
  getPiece(type);
  const list = s.placements;
  if (index < 0 || index >= list.length) return s;
  const old = list[index];
  const keepWalls = old.walls && supportsWalls(type);
  const piece = place(type, placementCursor(old), keepWalls);
  const next = list.slice();
  next[index] = piece;
  const placements = reflowTail(next, index + 1, advanceCursor(placementCursor(piece), type), list, index + 1, old);
  return { placements, cursor: s.cursor };
}

export function toggleWalls(s: EditorSnapshot, index: number): EditorSnapshot {
  const p = s.placements[index];
  if (!p || !supportsWalls(p.type)) return s;
  const next = s.placements.slice();
  const { walls, ...rest } = p;
  next[index] = walls ? rest : { ...rest, walls: true };
  return { placements: next, cursor: s.cursor };
}

/* ---- build cursor ---- */

export function setCursor(s: EditorSnapshot, c: Cursor): EditorSnapshot {
  const snapped: Cursor = {
    x: Math.round(c.x / CELL) * CELL,
    y: Math.round(c.y / Y_STEP) * Y_STEP,
    z: Math.round(c.z / CELL) * CELL,
    rot: normRot(c.rot),
  };
  return { placements: s.placements, cursor: snapped };
}

/** Move the cursor by whole grid cells (world axes). Switches to free placement. */
export function moveCursor(s: EditorSnapshot, dxCells: number, dzCells: number): EditorSnapshot {
  const c = cursorOf(s);
  return { placements: s.placements, cursor: { x: round3(c.x + dxCells * CELL), y: c.y, z: round3(c.z + dzCells * CELL), rot: c.rot } };
}

export function raiseCursor(s: EditorSnapshot, steps: number): EditorSnapshot {
  const c = cursorOf(s);
  const y = Math.max(-25 * Y_STEP, Math.min(40 * Y_STEP, c.y + steps * Y_STEP));
  return { placements: s.placements, cursor: { ...c, y: round3(y) } };
}

/** +1 turns the heading left (from +Z toward +X), -1 turns right. */
export function rotateCursor(s: EditorSnapshot, quarterTurns: number): EditorSnapshot {
  const c = cursorOf(s);
  return { placements: s.placements, cursor: { ...c, rot: normRot(c.rot + quarterTurns) } };
}

export function snapCursorToEnd(s: EditorSnapshot): EditorSnapshot {
  return { placements: s.placements, cursor: null };
}

/** Heading of a quarter-turn rotation as a unit grid step. */
export function headingOf(rot: number): { dx: number; dz: number } {
  switch (normRot(rot)) {
    case 0: return { dx: 0, dz: 1 };
    case 1: return { dx: 1, dz: 0 };
    case 2: return { dx: 0, dz: -1 };
    default: return { dx: -1, dz: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export interface History {
  past: EditorSnapshot[];
  present: EditorSnapshot;
  future: EditorSnapshot[];
}

export function createHistory(present: EditorSnapshot): History {
  return { past: [], present, future: [] };
}

/** Record a new state (no-op if unchanged). Keeps at most MAX_HISTORY undo steps. */
export function pushHistory(h: History, next: EditorSnapshot): History {
  if (next === h.present) return h;
  const past = [...h.past, h.present];
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  return { past, present: next, future: [] };
}

/** Replace the present state without creating an undo step (e.g. cursor moves). */
export function replacePresent(h: History, next: EditorSnapshot): History {
  return next === h.present ? h : { ...h, present: next };
}

export function undo(h: History): History {
  if (!h.past.length) return h;
  const prev = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (!h.future.length) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest };
}

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type IssueLevel = 'error' | 'warning' | 'info';
export interface EditorIssue { level: IssueLevel; message: string; pieces?: number[] }
export interface ValidationResult {
  valid: boolean;
  issues: EditorIssue[];
  /** piece indices involved in warnings/errors (for highlighting) */
  flagged: number[];
  errors: number;
  warnings: number;
}

const JUMP_PIECES = new Set(['kicker', 'kickerBig', 'hill']);

/** Pairs of pieces whose roads cross / overlap (non-adjacent frames too close together). */
export function findOverlaps(compiled: CompiledTrack, maxPairs = 6): [number, number][] {
  const f = compiled.frames;
  const H = 12, V = 6, ALONG = 40;
  const grid = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.floor(x / H)},${Math.floor(z / H)}`;
  const pairs = new Map<string, [number, number]>();
  for (let i = 0; i < f.length; i += 2) {
    const p = f[i].pos;
    const cx = Math.floor(p.x / H), cz = Math.floor(p.z / H);
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const bucket = grid.get(`${cx + ox},${cz + oz}`);
      if (!bucket) continue;
      for (const j of bucket) {
        const q = f[j].pos;
        const dx = p.x - q.x, dz = p.z - q.z;
        if (dx * dx + dz * dz >= H * H) continue;
        if (Math.abs(p.y - q.y) >= V) continue;
        if (Math.abs(f[i].dist - f[j].dist) <= ALONG) continue;
        const a = Math.min(f[i].pieceIndex, f[j].pieceIndex), b = Math.max(f[i].pieceIndex, f[j].pieceIndex);
        if (a === b) continue;
        const k = `${a}:${b}`;
        if (!pairs.has(k)) {
          pairs.set(k, [a, b]);
          if (pairs.size >= maxPairs) return [...pairs.values()];
        }
      }
    }
    const k = key(p.x, p.z);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  }
  return [...pairs.values()];
}

export function pieceName(type: string): string {
  return PIECES[type]?.name ?? type;
}

export function validateTrack(placements: Placement[], compiled: CompiledTrack = compileTrack({ pieces: placements })): ValidationResult {
  const issues: EditorIssue[] = [];
  for (const msg of compiled.issues) issues.push({ level: 'error', message: msg });

  const starts = placements.map((p, i) => (p.type === 'start' ? i : -1)).filter((i) => i >= 0);
  const finishes = placements.map((p, i) => (p.type === 'finish' ? i : -1)).filter((i) => i >= 0);
  const tag = (needle: string, pieces: number[]) => { const it = issues.find((x) => x.message.includes(needle)); if (it) it.pieces = pieces; };
  if (starts.length > 1) tag('more than one start', starts);
  if (finishes.length > 1) tag('more than one finish', finishes);
  if (starts.length === 1 && starts[0] !== 0) {
    issues.push({ level: 'warning', message: `The Start Line should be the first piece (it is #${starts[0] + 1}). Pieces before it are skipped.`, pieces: [starts[0]] });
  }
  if (starts.length === 1 && finishes.length === 1 && finishes[0] < starts[0]) {
    const existing = issues.find((x) => x.message.startsWith('Finish must'));
    if (existing) existing.pieces = [starts[0], finishes[0]];
    else issues.push({ level: 'error', message: 'Finish must come after the start.', pieces: [starts[0], finishes[0]] });
  }

  // connection checks
  for (let i = 1; i < placements.length; i++) {
    const a = placements[i - 1], b = placements[i];
    if (!PIECES[a.type] || !PIECES[b.type]) continue;
    if (isConnected(a, b)) continue;
    const jumpy = JUMP_PIECES.has(a.type) || PIECES[a.type].gap;
    issues.push({
      level: jumpy ? 'info' : 'warning',
      message: jumpy
        ? `#${i + 1} ${pieceName(b.type)} is a separate landing spot after the jump.`
        : `#${i + 1} ${pieceName(b.type)} is not connected to #${i} — cars will have to jump or fall to reach it.`,
      pieces: [i - 1, i],
    });
  }

  for (const [a, b] of findOverlaps(compiled)) {
    issues.push({ level: 'warning', message: `#${a + 1} ${pieceName(placements[a]?.type ?? '?')} and #${b + 1} ${pieceName(placements[b]?.type ?? '?')} overlap or cross too closely.`, pieces: [a, b] });
  }

  const startGate = compiled.gates.find((g) => g.kind === 'start');
  const finishGate = compiled.gates.find((g) => g.kind === 'finish');
  if (startGate && finishGate && finishGate.dist > startGate.dist) {
    if (finishGate.dist - startGate.dist < 150) issues.push({ level: 'info', message: 'This track is very short. Add more pieces between start and finish!' });
    if (!compiled.gates.some((g) => g.kind === 'checkpoint') && finishGate.dist - startGate.dist > 500) {
      issues.push({ level: 'info', message: 'Tip: add Checkpoints so racers respawn closer when they crash.' });
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  const errors = issues.filter((x) => x.level === 'error').length;
  const warnings = issues.filter((x) => x.level === 'warning').length;
  const flagged = [...new Set(issues.filter((x) => x.level !== 'info').flatMap((x) => x.pieces ?? []))];
  return { valid: errors === 0, issues, flagged, errors, warnings };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export interface TrackTemplate { id: string; name: string; description: string; theme: ThemeId; items: ChainItem[] }

export const TEMPLATES: TrackTemplate[] = [
  {
    id: 'oval', name: 'Simple Oval', theme: 'neonCity',
    description: 'Two straights and two U-turns that almost close the loop.',
    items: ['start', 'straight', 'straight2', 'curveR2', 'curveR2', 'checkpoint', 'boost', 'straight2', 'finish', 'curveR2', 'curveR2'],
  },
  {
    id: 'jumps', name: 'Jump Practice', theme: 'skyIslands',
    description: 'Two ramps over open gaps with wide landing zones.',
    items: ['start', 'straight', 'boost', 'straight', 'kicker', 'gapDrop1', 'landing', 'straight', 'checkpoint', 'curveL2', 'straight', 'boost',
      'kicker', 'gapDrop2', 'landing', 'straight2', 'finish', 'straight'],
  },
  {
    id: 'stunts', name: 'Loop & Corkscrew', theme: 'cyberVoid',
    description: 'Boost into a full loop, then barrel-roll through a corkscrew.',
    items: ['start', 'boost', 'straight', 'loopL', 'straight2', 'checkpoint', 'curveR2', 'straight2', 'corkscrewL', 'boost', 'straight', 'checkpoint',
      'straight', 'finish', 'straight'],
  },
];

export function templatePlacements(t: TrackTemplate): Placement[] {
  return chain({ x: 0, y: 0, z: 0, rot: 0 }, t.items);
}

/* ------------------------------------------------------------------ */
/* Drafts                                                              */
/* ------------------------------------------------------------------ */

export interface DraftData { id?: string; code?: string; name: string; theme: ThemeId; placements: Placement[]; description?: string }

export const DRAFT_STORAGE_KEY = 'neonrush.builder.draft';

export function definitionFromDraft(d: DraftData): TrackDefinition {
  const name = (d.name || '').trim().slice(0, MAX_NAME) || 'My Track';
  return {
    id: `draft-${d.id ?? 'local'}`,
    name,
    theme: THEME_IDS.includes(d.theme) ? d.theme : 'neonCity',
    difficulty: 2,
    description: d.description ?? '',
    author: 'You',
    pieces: d.placements.map((p) => ({ ...p })),
    medals: { author: 60000, gold: 70000, silver: 80000, bronze: 100000 },
    seed: hashString(name),
  };
}

const finite = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Defensive parse of a draft from storage / props. Returns null if unusable. */
export function sanitizeDraft(raw: unknown): DraftData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const placements: Placement[] = [];
  if (Array.isArray(r.placements)) {
    for (const p of r.placements.slice(0, MAX_PIECES)) {
      if (!p || typeof p !== 'object') continue;
      const q = p as Record<string, unknown>;
      if (typeof q.type !== 'string' || !PIECES[q.type]) continue;
      placements.push({ type: q.type, x: finite(q.x), y: finite(q.y), z: finite(q.z), rot: normRot(finite(q.rot)), ...(q.walls ? { walls: true } : {}) });
    }
  }
  return {
    ...(typeof r.id === 'string' ? { id: r.id } : {}),
    ...(typeof r.code === 'string' ? { code: r.code } : {}),
    name: typeof r.name === 'string' ? r.name.slice(0, MAX_NAME) : 'My Track',
    theme: THEME_IDS.includes(r.theme as ThemeId) ? (r.theme as ThemeId) : 'neonCity',
    placements,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
  };
}
