// Daily challenge: deterministic official track per UTC day, today's standings and
// lazily processed results for yesterday (winner achievement + result notifications).

import type { Env } from './index';
import type { DailyResponse, LeaderboardEntry } from '../shared/api';
import { dayKey, dayEndsAt, dailyTrackId } from '../shared/game/daily';
import { OFFICIAL_TRACKS, OFFICIAL_TRACK_MAP } from '../shared/track/officialTracks';
import { all, run } from './db';
import { optionalAuth } from './auth';
import { loadPlayer } from './players';
import { newAwards, unlock, commitAwards } from './progression';
import { notify, type NotificationInput } from './social';
import { queryLeaderboard } from './records';
import type { Ctx } from './api';

const OFFICIAL_IDS = OFFICIAL_TRACKS.map((t) => t.id);
const DAY_MS = 86_400_000;

export function todaysTrackId(now = Date.now()): string { return dailyTrackId(dayKey(now), OFFICIAL_IDS); }

/** Sends 'daily_result' notifications and awards the winner once per finished day. */
async function processFinishedDay(env: Env, key: string, trackId: string, now: number): Promise<void> {
  const standings = await all<{ player_id: string; time_ms: number }>(
    env.DB, 'SELECT player_id, MIN(time_ms) AS time_ms FROM runs WHERE track_id = ? AND day_key = ? GROUP BY player_id ORDER BY time_ms ASC LIMIT 500', trackId, key,
  );
  if (!standings.length) return;
  const name = OFFICIAL_TRACK_MAP[trackId]?.name ?? trackId;
  const notes: NotificationInput[] = standings.map((s, i) => ({
    playerId: s.player_id, kind: 'daily_result', trackId,
    text: i === 0 ? `You won the daily challenge on ${name} (${key})! 🏆` : `Daily challenge ${key}: you finished #${i + 1} of ${standings.length} on ${name}`,
  }));
  await notify(env, notes, now);
  const winner = await loadPlayer(env, standings[0].player_id);
  if (winner) {
    const awards = newAwards();
    winner.stats.dailyWins++;
    unlock(winner, awards, 'daily_winner', now);
    await commitAwards(env, winner, awards, now);
  }
}

async function yesterday(env: Env, now: number): Promise<DailyResponse['yesterday']> {
  const key = dayKey(now - DAY_MS);
  const trackId = dailyTrackId(key, OFFICIAL_IDS);
  const lb = await queryLeaderboard(env, { trackId, scope: 'daily', periodKey: key, limit: 1, offset: 0, me: null });
  const winner: LeaderboardEntry | null = lb.entries[0] ?? null;
  // First request after midnight claims the day; INSERT OR IGNORE makes this race-safe.
  const claimed = await run(env.DB, 'INSERT OR IGNORE INTO daily_results (day_key, track_id, winner_id, processed_at) VALUES (?, ?, ?, ?)', key, trackId, winner?.playerId ?? null, now);
  if (claimed.meta.changes > 0 && winner) await processFinishedDay(env, key, trackId, now);
  return { dayKey: key, trackId, winner };
}

export async function getDaily(c: Ctx): Promise<DailyResponse> {
  const me = await optionalAuth(c.request, c.env);
  const now = Date.now();
  const key = dayKey(now);
  const trackId = dailyTrackId(key, OFFICIAL_IDS);
  const [top, friends, y] = await Promise.all([
    queryLeaderboard(c.env, { trackId, scope: 'daily', periodKey: key, limit: 10, offset: 0, me }),
    me ? queryLeaderboard(c.env, { trackId, scope: 'daily', periodKey: key, limit: 10, offset: 0, me, filter: 'friends' }) : Promise.resolve(null),
    yesterday(c.env, now),
  ]);
  return {
    dayKey: key, trackId, endsAt: dayEndsAt(now), top: top.entries,
    me: top.me ? { rank: top.me.rank, timeMs: top.me.timeMs } : null,
    friends: friends?.entries ?? [], participants: top.total, yesterday: y,
  };
}
