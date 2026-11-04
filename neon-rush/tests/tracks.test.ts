import { describe, it, expect } from 'vitest';
import { OFFICIAL_TRACKS } from '../shared/track/officialTracks';
import { compileTrack } from '../shared/track/compile';
import { driveTrack } from './botHarness';

describe('official tracks', () => {
  it('compile without issues and do not self-intersect', () => {
    for (const t of OFFICIAL_TRACKS) {
      const c = compileTrack(t);
      expect(c.issues, t.id).toEqual([]);
      // crude overlap check: non-adjacent frames closer than 14 m horizontally with < 7 m height gap
      const f = c.frames;
      const bad: string[] = [];
      for (let i = 0; i < f.length; i += 2) for (let j = i + 30; j < f.length; j += 2) {
        const dx = f[i].pos.x - f[j].pos.x, dz = f[i].pos.z - f[j].pos.z, dy = Math.abs(f[i].pos.y - f[j].pos.y);
        if (dx * dx + dz * dz < 14 * 14 && dy < 7 && Math.abs(f[i].dist - f[j].dist) > 40) { bad.push(`${i}/${j} d=${f[i].dist.toFixed(0)}/${f[j].dist.toFixed(0)}`); if (bad.length > 3) break; }
      }
      expect(bad, `${t.id} overlaps`).toEqual([]);
    }
  });

  for (const t of OFFICIAL_TRACKS) {
    it(`bot can complete ${t.name}`, async () => {
      const r = await driveTrack(t, { aggression: 0.95, log: true });
      console.log(`${t.id}: finished=${r.finished} time=${(r.timeMs / 1000).toFixed(2)}s respawns=${r.respawns} maxSpeed=${(r.maxSpeed * 3.6).toFixed(0)}km/h cps=${r.checkpoints}`);
      expect(r.finished, `${t.id} not completed; stuck at ${JSON.stringify(r.stuckAt)}`).toBe(true);
    }, 300000);
  }
});
