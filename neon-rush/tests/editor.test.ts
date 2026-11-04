import { describe, it, expect } from 'vitest';
import {
  type EditorSnapshot, MAX_HISTORY, MAX_PIECES, TEMPLATES, Y_STEP,
  appendPiece, insertAfter, deletePiece, replacePiece, toggleWalls, moveCursor, raiseCursor, rotateCursor, setCursor,
  snapCursorToEnd, cursorOf, isConnected, supportsWalls, defaultPlacements, emptySnapshot, templatePlacements,
  validateTrack, findOverlaps, createHistory, pushHistory, replacePresent, undo, redo, canUndo, canRedo,
  definitionFromDraft, sanitizeDraft, headingOf,
} from '../src/game/editor/editorModel';
import { chain, endCursor } from '../shared/track/chain';
import { compileTrack } from '../shared/track/compile';
import { CELL, PIECE_LIST } from '../shared/track/pieces';
import { hashString } from '../shared/math';
import type { Placement } from '../shared/track/types';
import { driveTrack } from './botHarness';

const O = { x: 0, y: 0, z: 0, rot: 0 };
const snapOf = (items: Parameters<typeof chain>[1]): EditorSnapshot => ({ placements: chain(O, items), cursor: null });
const build = (s: EditorSnapshot, types: string[]) => types.reduce((acc, t) => appendPiece(acc, t), s);
const allConnected = (p: Placement[]) => p.every((x, i) => i === 0 || isConnected(p[i - 1], x));

describe('editor model: editing', () => {
  it('starts with a start line and a straight at the origin', () => {
    const s = emptySnapshot();
    expect(s.placements.map((p) => p.type)).toEqual(['start', 'straight']);
    expect(s.placements[0]).toMatchObject(O);
    expect(cursorOf(s)).toEqual({ x: 0, y: 0, z: 2 * CELL, rot: 0 });
  });

  it('appending chains pieces exactly like chain()', () => {
    const types = ['curveL2', 'slopeUp1', 'hairpinR', 'kicker', 'gapDrop1', 'landing', 'finish'];
    const s = build(emptySnapshot(), types);
    expect(s.placements).toEqual(chain(O, ['start', 'straight', ...types]));
    expect(s.cursor).toBeNull();
    expect(allConnected(s.placements)).toBe(true);
  });

  it('refuses unknown pieces and stops at the piece limit', () => {
    expect(() => appendPiece(emptySnapshot(), 'nope')).toThrow();
    let s: EditorSnapshot = { placements: [], cursor: null };
    for (let i = 0; i < MAX_PIECES + 5; i++) s = appendPiece(s, 'straight');
    expect(s.placements.length).toBe(MAX_PIECES);
  });

  it('deleting the last piece moves the cursor back', () => {
    const s = snapOf(['start', 'straight', 'curveR2']);
    const d = deletePiece(s, 2);
    expect(d.placements.length).toBe(2);
    expect(d.cursor).toBeNull();
    expect(cursorOf(d)).toEqual({ x: 0, y: 0, z: 2 * CELL, rot: 0 });
    // a free-placed (disconnected) last piece: cursor goes to where it was
    const free = appendPiece(moveCursor(s, 3, 1), 'straight');
    const d2 = deletePiece(free, 3);
    const e = endCursor(s.placements);
    expect(d2.cursor).toEqual({ x: e.x + 3 * CELL, y: 0, z: e.z + CELL, rot: e.rot });
  });

  it('deleting a middle piece slides the connected tail back', () => {
    const s = snapOf(['start', 'straight', 'curveL2', 'straight', 'finish']);
    const d = deletePiece(s, 2);
    expect(d.placements.map((p) => p.type)).toEqual(['start', 'straight', 'straight', 'finish']);
    expect(d.placements).toEqual(chain(O, ['start', 'straight', 'straight', 'finish']));
  });

  it('only reflows the connected run after the edited piece', () => {
    // start, straight, kicker | (free) landing, finish
    let s = snapOf(['start', 'straight', 'kicker']);
    s = appendPiece(raiseCursor(moveCursor(s, 0, 2), -1), 'landing');
    s = appendPiece(s, 'finish');
    const landing = s.placements[3];
    const d = deletePiece(s, 1);
    expect(d.placements[1]).toMatchObject({ type: 'kicker', z: CELL }); // slid back
    expect(d.placements[2]).toEqual(landing);                          // separate segment untouched
  });

  it('replacing a piece re-chains the following connected pieces and keeps walls when possible', () => {
    let s = snapOf(['start', { type: 'straight', walls: true }, 'straight', 'finish']);
    s = replacePiece(s, 1, 'curveR2');
    expect(s.placements[1]).toMatchObject({ type: 'curveR2', walls: true });
    expect(s.placements).toEqual(chain(O, ['start', { type: 'curveR2', walls: true }, 'straight', 'finish']));
    const g = replacePiece(s, 1, 'gap1');
    expect(g.placements[1].walls).toBeUndefined();
    expect(allConnected(g.placements)).toBe(true);
  });

  it('inserting after a piece pushes the rest of the chain along', () => {
    const s = snapOf(['start', 'straight', 'finish']);
    const ins = insertAfter(s, 1, 'checkpoint');
    expect(ins.placements.map((p) => p.type)).toEqual(['start', 'straight', 'checkpoint', 'finish']);
    expect(ins.placements).toEqual(chain(O, ['start', 'straight', 'checkpoint', 'finish']));
  });

  it('toggles walls only on pieces that have them', () => {
    const s = snapOf(['start', 'straight', 'gap1', 'tunnel']);
    const w = toggleWalls(s, 1);
    expect(w.placements[1].walls).toBe(true);
    expect(toggleWalls(w, 1).placements[1].walls).toBeUndefined();
    expect(toggleWalls(s, 2)).toBe(s); // gap: no geometry
    expect(supportsWalls('tunnel')).toBe(false);
    expect(supportsWalls('straight')).toBe(true);
    expect(supportsWalls('wallrideL')).toBe(true);
  });
});

describe('editor model: build cursor', () => {
  it('moves, rotates and raises in grid steps (free placement)', () => {
    const s = snapOf(['start', 'straight']);
    const m = moveCursor(s, 2, -1);
    expect(m.cursor).toEqual({ x: 2 * CELL, y: 0, z: CELL, rot: 0 });
    expect(raiseCursor(m, 2).cursor!.y).toBe(2 * Y_STEP);
    expect(rotateCursor(m, 1).cursor!.rot).toBe(1);
    expect(rotateCursor(m, -1).cursor!.rot).toBe(3);
    expect(rotateCursor(rotateCursor(m, 3), 2).cursor!.rot).toBe(1);
    expect(headingOf(1)).toEqual({ dx: 1, dz: 0 });
    expect(setCursor(s, { x: 30, y: 13, z: -40, rot: 6 }).cursor).toEqual({ x: CELL, y: 16, z: -48, rot: 2 });
  });

  it('appends at the free cursor, then follows the end again', () => {
    const s = rotateCursor(moveCursor(snapOf(['start', 'straight']), 3, 0), 1);
    const a = appendPiece(s, 'straight');
    expect(a.placements[2]).toEqual({ type: 'straight', x: 3 * CELL, y: 0, z: 2 * CELL, rot: 1 });
    expect(a.cursor).toBeNull();
    expect(cursorOf(a)).toEqual({ x: 4 * CELL, y: 0, z: 2 * CELL, rot: 1 });
    expect(snapCursorToEnd(s).cursor).toBeNull();
  });
});

describe('editor model: history', () => {
  it('undo / redo walk the stack and new edits clear redo', () => {
    let h = createHistory(emptySnapshot());
    expect(canUndo(h)).toBe(false);
    h = pushHistory(h, appendPiece(h.present, 'curveL2'));
    h = pushHistory(h, appendPiece(h.present, 'finish'));
    expect(h.present.placements.length).toBe(4);
    h = undo(h);
    expect(h.present.placements.length).toBe(3);
    expect(canRedo(h)).toBe(true);
    h = undo(undo(undo(h))); // extra undos are no-ops
    expect(h.present.placements.length).toBe(2);
    h = redo(h);
    expect(h.present.placements.length).toBe(3);
    h = pushHistory(h, appendPiece(h.present, 'straight'));
    expect(canRedo(h)).toBe(false);
    expect(redo(h)).toBe(h);
  });

  it('cursor moves do not create undo steps; history is capped', () => {
    let h = createHistory(emptySnapshot());
    h = replacePresent(h, moveCursor(h.present, 1, 0));
    expect(canUndo(h)).toBe(false);
    for (let i = 0; i < MAX_HISTORY + 30; i++) h = pushHistory(h, appendPiece(h.present, 'straight'));
    expect(h.past.length).toBe(MAX_HISTORY);
    expect(pushHistory(h, h.present)).toBe(h);
  });
});

describe('editor model: validation', () => {
  it('flags a missing finish / start', () => {
    const v = validateTrack(defaultPlacements());
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.level === 'error' && /finish/i.test(i.message))).toBe(true);
    const v2 = validateTrack(chain(O, ['straight', 'finish']));
    expect(v2.issues.some((i) => /no start/i.test(i.message))).toBe(true);
  });

  it('accepts a simple valid track', () => {
    const v = validateTrack(chain(O, ['start', 'straight2', 'curveL3', 'straight2', 'checkpoint', 'curveR3', 'straight2', 'finish', 'straight']));
    expect(v.valid).toBe(true);
    expect(v.errors).toBe(0);
    expect(v.warnings).toBe(0);
  });

  it('errors on duplicate gates and finish before start; warns when start is not first', () => {
    const dup = validateTrack(chain(O, ['start', 'straight', 'start', 'finish', 'finish']));
    expect(dup.valid).toBe(false);
    expect(dup.issues.find((i) => /more than one start/.test(i.message))?.pieces).toEqual([0, 2]);
    const rev = validateTrack(chain(O, ['finish', 'straight', 'start', 'straight']));
    expect(rev.valid).toBe(false);
    expect(rev.issues.some((i) => /Finish must come after/.test(i.message))).toBe(true);
    const late = validateTrack(chain(O, ['straight', 'start', 'straight2', 'straight2', 'finish']));
    expect(late.valid).toBe(true);
    expect(late.issues.some((i) => i.level === 'warning' && /first piece/.test(i.message))).toBe(true);
  });

  it('warns about overlapping / crossing pieces', () => {
    // a tight square loop that drives back over the start
    const p = chain(O, ['start', 'straight', 'curveL1', 'straight', 'curveL1', 'straight', 'curveL1', 'straight', 'curveL1', 'straight', 'straight', 'finish']);
    expect(findOverlaps(compileTrack({ pieces: p })).length).toBeGreaterThan(0);
    const v = validateTrack(p);
    expect(v.issues.some((i) => i.level === 'warning' && /overlap/.test(i.message))).toBe(true);
    expect(v.flagged.length).toBeGreaterThan(0);
  });

  it('warns about disconnected pieces (info after a jump ramp)', () => {
    let s = snapOf(['start', 'straight']);
    s = appendPiece(moveCursor(s, 2, 0), 'straight');
    s = appendPiece(s, 'finish');
    expect(validateTrack(s.placements).issues.some((i) => i.level === 'warning' && /not connected/.test(i.message))).toBe(true);
    let j = snapOf(['start', 'straight', 'kicker']);
    j = appendPiece(raiseCursor(moveCursor(j, 0, 2), -1), 'landing');
    j = appendPiece(j, 'finish');
    const vj = validateTrack(j.placements);
    expect(vj.valid).toBe(true);
    expect(vj.issues.find((i) => /landing spot/.test(i.message))?.level).toBe('info');
  });

  it('errors above the piece limit', () => {
    const p = chain(O, ['start', ...Array.from({ length: MAX_PIECES }, () => 'straight'), 'finish']);
    const v = validateTrack(p);
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => /too many pieces/.test(i.message))).toBe(true);
  });
});

describe('editor templates', () => {
  it('every template compiles with zero issues and passes the editor checks', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(3);
    for (const t of TEMPLATES) {
      const p = templatePlacements(t);
      expect(compileTrack({ pieces: p }).issues, t.id).toEqual([]);
      const v = validateTrack(p);
      expect(v.valid, t.id).toBe(true);
      expect(v.issues.filter((i) => i.level !== 'info'), t.id).toEqual([]);
    }
  });

  it('the oval ends close to (but not on top of) the start', () => {
    const p = templatePlacements(TEMPLATES.find((t) => t.id === 'oval')!);
    const end = endCursor(p);
    expect(Math.hypot(end.x, end.z)).toBeLessThanOrEqual(CELL);
    expect(end.rot).toBe(0);
  });

  for (const t of TEMPLATES) {
    it(`bot can drive the "${t.name}" template to the finish`, async () => {
      const def = definitionFromDraft({ name: t.name, theme: t.theme, placements: templatePlacements(t) });
      const r = await driveTrack(def, { aggression: 0.95 });
      expect(r.finished, `stuck at ${JSON.stringify(r.stuckAt)}`).toBe(true);
    }, 120000);
  }
});

describe('drafts', () => {
  it('builds a track definition from a draft', () => {
    const d = { id: 'x1', name: 'My Cool Track', theme: 'cyberVoid' as const, placements: defaultPlacements() };
    const def = definitionFromDraft(d);
    expect(def).toMatchObject({ id: 'draft-x1', name: 'My Cool Track', theme: 'cyberVoid', difficulty: 2, author: 'You', seed: hashString('My Cool Track') });
    expect(def.medals).toEqual({ author: 60000, gold: 70000, silver: 80000, bronze: 100000 });
    expect(def.pieces).toEqual(d.placements);
    expect(def.pieces).not.toBe(d.placements);
    expect(definitionFromDraft({ ...d, id: undefined }).id).toBe('draft-local');
  });

  it('sanitizes stored drafts', () => {
    expect(sanitizeDraft(null)).toBeNull();
    const s = sanitizeDraft({ name: 'x'.repeat(50), theme: 'bogus', placements: [{ type: 'straight', x: 1, y: 'a', z: 2, rot: 5 }, { type: 'warp', x: 0, y: 0, z: 0, rot: 0 }, null] });
    expect(s!.name.length).toBe(32);
    expect(s!.theme).toBe('neonCity');
    expect(s!.placements).toEqual([{ type: 'straight', x: 1, y: 0, z: 2, rot: 1 }]);
  });

  it('every palette piece can be appended', () => {
    let s = emptySnapshot();
    for (const p of PIECE_LIST) s = appendPiece(s, p.id);
    expect(s.placements.length).toBe(PIECE_LIST.length + 2);
    expect(compileTrack({ pieces: s.placements }).frames.length).toBeGreaterThan(0);
  });
});
