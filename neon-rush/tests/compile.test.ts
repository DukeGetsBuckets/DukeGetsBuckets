import { describe, it, expect } from 'vitest';
import { compileTrack } from '../shared/track/compile';
import { chain } from '../shared/track/chain';
import { PIECE_LIST } from '../shared/track/pieces';
import { vdist, vlen } from '../shared/math';

describe('track compiler', () => {
  it('compiles every piece type without NaNs and with continuous frames', () => {
    for (const def of PIECE_LIST) {
      const pieces = chain({ x: 0, y: 0, z: 0, rot: 0 }, def.category === 'gate' ? ['straight', def.id, 'straight'] : ['start', def.id, 'finish']);
      if (def.category === 'gate') { const t0 = compileTrack({ pieces }); expect(t0.frames.length).toBeGreaterThan(3); continue; }
      const t = compileTrack({ pieces });
      expect(t.issues, def.id).toEqual([]);
      for (const f of t.frames) {
        expect(Number.isFinite(f.pos.x + f.pos.y + f.pos.z), def.id).toBe(true);
        expect(Math.abs(vlen(f.up) - 1), def.id).toBeLessThan(1e-3);
        expect(Math.abs(vlen(f.tangent) - 1), def.id).toBeLessThan(1e-3);
      }
      // consecutive frames should be close (no jumps), except gap pieces which have no geometry
      for (let i = 1; i < t.frames.length; i++) {
        const d = vdist(t.frames[i].pos, t.frames[i - 1].pos);
        expect(d, `${def.id} frame ${i}`).toBeLessThan(def.gap ? 60 : 8);
      }
      const surf = t.surfaces.road;
      expect(surf.positions.length % 3).toBe(0);
      for (let i = 0; i < surf.positions.length; i++) expect(Number.isFinite(surf.positions[i])).toBe(true);
    }
  });

  it('chains exits so the next piece starts where the previous ends (within 1mm)', () => {
    for (const def of PIECE_LIST) {
      const pieces = chain({ x: 10, y: 5, z: -20, rot: 1 }, ['straight', def.id, 'straight']);
      const t = compileTrack({ pieces });
      const pf = t.pieceFrames;
      const endOfPiece = t.frames[pf[1].end].pos;
      const startOfNext = t.frames[pf[2].start].pos;
      expect(vdist(endOfPiece, startOfNext), def.id).toBeLessThan(0.01);
    }
  });

  it('orders checkpoints and puts the finish last', () => {
    const pieces = chain({ x: 0, y: 0, z: 0, rot: 0 }, ['start', 'straight', 'checkpoint', 'curveL2', 'checkpoint', 'finish']);
    const t = compileTrack({ pieces });
    expect(t.checkpoints.length).toBe(3);
    expect(t.checkpoints[0].index).toBe(0);
    expect(t.checkpoints[2].kind).toBe('finish');
    expect(t.length).toBeGreaterThan(100);
  });
});
