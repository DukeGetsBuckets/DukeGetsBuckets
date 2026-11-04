import { it } from 'vitest';
import { OFFICIAL_TRACKS } from '../shared/track/officialTracks';
import { driveTrack } from './botHarness';

// Reference run: prints bot times at two aggression levels to calibrate medal thresholds.
it('bot reference times', async () => {
  for (const t of OFFICIAL_TRACKS) {
    const fast = await driveTrack(t, { aggression: 1.08 });
    const safe = await driveTrack(t, { aggression: 0.85 });
    console.log(`${t.id.padEnd(18)} fast=${(fast.timeMs / 1000).toFixed(1)}s(${fast.finished ? 'ok' : 'DNF'},r${fast.respawns}) safe=${(safe.timeMs / 1000).toFixed(1)}s(${safe.finished ? 'ok' : 'DNF'},r${safe.respawns}) author=${t.medals.author / 1000} gold=${t.medals.gold / 1000}`);
  }
}, 900000);
