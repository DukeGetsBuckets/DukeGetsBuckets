// Persists the outcome of a live multiplayer race for the calling player (XP / coins / stats).
// The client is trusted for the position, but values are clamped and calls are throttled.

import type { LiveRaceResultResponse } from '../shared/api';
import { liveXp, liveCoins } from '../shared/game/progression';
import { tooMany, asObject, int, str, throttle } from './http';
import { requireAuth } from './auth';
import { buildProfile } from './players';
import { newAwards, grant, unlock, commitAwards } from './progression';
import type { Ctx } from './api';

const MAX_PLAYERS = 8;
const MIN_INTERVAL_MS = 20_000;

export async function liveResult(c: Ctx): Promise<LiveRaceResultResponse> {
  const p = await requireAuth(c.request, c.env);
  const b = asObject(await c.body());
  const roomCode = (str(b.roomCode, 8) ?? '').toUpperCase();
  const trackId = str(b.trackId, 64) ?? '';
  const playerCount = int(b.playerCount, 1, MAX_PLAYERS) ?? 1;
  const position = Math.min(int(b.position, 1, MAX_PLAYERS) ?? 1, playerCount);
  const timeMs = typeof b.timeMs === 'number' && Number.isFinite(b.timeMs) && b.timeMs > 0 ? Math.round(b.timeMs) : null;
  if (!throttle('live', p.id, MIN_INTERVAL_MS)) throw tooMany('Live results can be reported once every 20 seconds', 'rate_limited');

  const now = Date.now();
  const awards = newAwards();
  grant(p, awards, liveXp(position), liveCoins(position));
  p.stats.races++;
  if (timeMs !== null) p.stats.finishes++;
  if (position === 1 && playerCount >= 2) {
    p.stats.wins++;
    unlock(p, awards, 'first_victory', now);
  }
  if (p.stats.races >= 100) unlock(p, awards, 'races_100', now);
  await commitAwards(c.env, p, awards, now);
  console.log(`[live] ${p.name} finished #${position}/${playerCount} on ${trackId} in room ${roomCode}`);
  return { xp: awards.xp, coins: awards.coins, achievements: awards.achievements, player: await buildProfile(c.env, p) };
}
