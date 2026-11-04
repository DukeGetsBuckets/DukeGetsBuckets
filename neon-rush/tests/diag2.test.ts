import { it } from 'vitest';
import { OFFICIAL_TRACKS } from '../shared/track/officialTracks';
import { driveTrack } from './botHarness';
it('loop-district corkscrew trace', async () => {
  const t = OFFICIAL_TRACKS.find((x) => x.id === 'loop-district')!;
  const r = await driveTrack(t, { aggression: 0.95, maxSeconds: 20, trace: [370, 640], log: true });
  console.log('result', r.finished, r.respawns, r.stuckAt);
}, 120000);
