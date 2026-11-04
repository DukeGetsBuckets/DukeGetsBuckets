// Record submission (validation → runs/records → awards → notifications), leaderboards, replays, history.

import type { Env } from './index';
import type { LeaderboardEntry, LeaderboardResponse, LeaderboardScope, PbHistoryResponse, ReplayResponse, SubmitRecordResponse } from '../shared/api';
import { sanitizeCarConfig, type CarConfig } from '../shared/game/carConfig';
import { bytesToBase64 } from '../shared/game/replay';
import { dayKey, weekKey } from '../shared/game/daily';
import { OFFICIAL_TRACKS } from '../shared/track/officialTracks';
import { formatTime } from '../shared/math';
import {
  COMMUNITY_DIFFICULTY, XP_REWARDS, COIN_REWARDS, MEDAL_ORDER, finishXp, finishCoins, medalFor, medalTier, type Medal,
} from '../shared/game/progression';
import { all, one, count, parseJson, blobToBytes, type RecordRow, type RunRow } from './db';
import { badRequest, notFound, unauthorized, tooMany, asObject, int, str, uuid, bytesToArrayBuffer } from './http';
import { PUBLIC_COLS, publicFromJoined, buildProfile, type Player } from './players';
import { requireAuth, optionalAuth } from './auth';
import { loadTrack, type LoadedTrack } from './trackdefs';
import { decodeReplayBase64, validateRun } from './validate';
import { newAwards, grant, unlock, levelUp, commitAwards, type Awards } from './progression';
import { notify, friendIdsUnion, type NotificationInput } from './social';
import type { Ctx } from './api';

const MODES = ['solo', 'daily', 'live', 'ghost'] as const;
type Mode = (typeof MODES)[number];
const SUBMIT_MIN_INTERVAL_MS = 2000;
const OFFICIAL_IDS = OFFICIAL_TRACKS.map((t) => t.id);

/* ---------- storing runs / records ---------- */

export interface StoredRun { runId: string; isPb: boolean; prevPbMs: number | null }

/** Inserts a run row and upserts the player's record when it is a PB. Shared with track publishing. */
export async function storeRun(
  env: Env, playerId: string, trackId: string, input: { timeMs: number; splits: number[]; car: CarConfig; replayBytes: Uint8Array; respawns: number; topSpeed: number; mode: Mode },
  now = Date.now(),
): Promise<StoredRun> {
  const prev = await one<{ id: string; time_ms: number }>(env.DB, 'SELECT id, time_ms FROM records WHERE track_id = ? AND player_id = ?', trackId, playerId);
  const runId = uuid();
  const isPb = !prev || input.timeMs < prev.time_ms;
  const statements = [
    env.DB.prepare('INSERT INTO runs (id, track_id, player_id, time_ms, achieved_at, day_key, week_key, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(runId, trackId, playerId, input.timeMs, now, dayKey(now), weekKey(now), input.mode),
  ];
  if (isPb) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO records (id, track_id, player_id, time_ms, splits, car, replay, respawns, top_speed, mode, achieved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (track_id, player_id) DO UPDATE SET id = excluded.id, time_ms = excluded.time_ms, splits = excluded.splits, car = excluded.car,
           replay = excluded.replay, respawns = excluded.respawns, top_speed = excluded.top_speed, mode = excluded.mode, achieved_at = excluded.achieved_at`,
      ).bind(runId, trackId, playerId, input.timeMs, JSON.stringify(input.splits), JSON.stringify(input.car), bytesToArrayBuffer(input.replayBytes), input.respawns, input.topSpeed, input.mode, now),
    );
  }
  await env.DB.batch(statements);
  return { runId, isPb, prevPbMs: prev?.time_ms ?? null };
}

function rankOf(env: Env, trackId: string, timeMs: number): Promise<number> {
  return count(env.DB, 'SELECT COUNT(*) AS n FROM records WHERE track_id = ? AND time_ms < ?', trackId, timeMs).then((n) => n + 1);
}

/* ---------- POST /api/records ---------- */

interface SubmitInput { trackId: string; timeMs: number; splits: number[]; replay: string; car: CarConfig; respawns: number; topSpeed: number; mode: Mode }

function parseSubmit(raw: unknown): SubmitInput {
  const b = asObject(raw);
  const trackId = str(b.trackId, 64);
  const timeMs = int(b.timeMs, 1, 1e9);
  if (!trackId) throw badRequest('trackId is required');
  if (timeMs === null) throw badRequest('timeMs is required');
  const splits = Array.isArray(b.splits) ? b.splits.slice(0, 64).map((s) => (typeof s === 'number' && Number.isFinite(s) ? Math.round(s) : NaN)) : [];
  if (typeof b.replay !== 'string') throw badRequest('replay is required');
  const mode = (MODES as readonly string[]).includes(b.mode as string) ? (b.mode as Mode) : 'solo';
  return {
    trackId, timeMs, splits, replay: b.replay, car: sanitizeCarConfig(b.car),
    respawns: int(b.respawns, 0, 1000) ?? 0,
    topSpeed: typeof b.topSpeed === 'number' && Number.isFinite(b.topSpeed) ? b.topSpeed : 0,
    mode,
  };
}

interface RecordAwardContext {
  p: Player; track: LoadedTrack; input: SubmitInput; stored: StoredRun; now: number;
  rank: number | null; worldRecord: boolean; medal: Medal | null; rivalsBeaten: { playerId: string; name: string; byMs: number }[];
  firstDailyRun: boolean; firstOnTrack: boolean;
}

/** Applies XP/coins/stats/achievements for an accepted run. */
async function applyRecordAwards(env: Env, ctx: RecordAwardContext, awards: Awards): Promise<void> {
  const { p, track, input, stored, now, medal, rivalsBeaten } = ctx;
  const difficulty = track.official ? track.def.difficulty : COMMUNITY_DIFFICULTY;
  const s = p.stats;

  grant(p, awards, finishXp(difficulty), finishCoins(difficulty));
  s.races++;
  s.finishes++;
  if (ctx.firstOnTrack) s.tracksCompleted++;
  if (ctx.firstDailyRun) grant(p, awards, XP_REWARDS.dailyParticipation, 0);

  if (stored.isPb) {
    s.personalBests++;
    grant(p, awards, XP_REWARDS.personalBest, COIN_REWARDS.personalBest);
    const prevTier = medalTier(stored.prevPbMs === null ? null : medalFor(stored.prevPbMs, track.def.medals));
    const newTier = medalTier(medal);
    for (let t = prevTier + 1; t <= newTier; t++) {
      const m = MEDAL_ORDER[t - 1];
      grant(p, awards, XP_REWARDS.medal[m], COIN_REWARDS.medal[m]);
    }
    if (newTier >= 3 && prevTier < 3) s.goldMedals++;
    if (newTier >= 4 && prevTier < 4) s.authorMedals++;
    if (ctx.worldRecord) {
      s.worldRecords++;
      grant(p, awards, XP_REWARDS.worldRecord, COIN_REWARDS.worldRecord);
      unlock(p, awards, 'world_record', now);
    }
    if (rivalsBeaten.length) {
      s.friendsBeaten += rivalsBeaten.length;
      grant(p, awards, XP_REWARDS.rivalBeaten * rivalsBeaten.length, 0);
      if (rivalsBeaten.some((r) => r.byMs <= 500)) unlock(p, awards, 'comeback', now);
    }
  }

  unlock(p, awards, 'first_finish', now);
  if (input.topSpeed >= 83) unlock(p, awards, 'speed_demon', now);
  if (input.respawns === 0 && medalTier(medal) >= 3) unlock(p, awards, 'perfect_run', now);
  if (medal === 'author') unlock(p, awards, 'author_medal', now);
  if (s.races >= 100) unlock(p, awards, 'races_100', now);
  if (s.friendsBeaten >= 10) unlock(p, awards, 'friends_beaten_10', now);

  if (track.official && stored.isPb) {
    const mine = await all<{ track_id: string; time_ms: number }>(env.DB, 'SELECT track_id, time_ms FROM records WHERE player_id = ?', p.id);
    const byTrack = new Map(mine.map((r) => [r.track_id, r.time_ms]));
    if (OFFICIAL_TRACKS.every((t) => byTrack.has(t.id))) unlock(p, awards, 'all_tracks', now);
    if (OFFICIAL_TRACKS.every((t) => (byTrack.get(t.id) ?? Infinity) <= t.medals.gold)) unlock(p, awards, 'all_gold', now);
  }
}

export async function submitRecord(c: Ctx): Promise<SubmitRecordResponse> {
  const p = await requireAuth(c.request, c.env);
  const input = parseSubmit(await c.body());
  const now = Date.now();

  const last = await one<{ t: number }>(c.env.DB, 'SELECT MAX(achieved_at) AS t FROM runs WHERE player_id = ?', p.id);
  if (last?.t && now - last.t < SUBMIT_MIN_INTERVAL_MS) throw tooMany('Slow down — one submission every 2 seconds', 'too_fast');

  const track = await loadTrack(c.env, input.trackId, p.id);
  if (!track) throw notFound('Unknown track', 'unknown_track');

  const rejected = async (reason: string): Promise<SubmitRecordResponse> => ({
    accepted: false, reason, isPb: false, prevPbMs: null, rank: null, worldRecord: false, medal: null, xp: 0, coins: 0, levelUp: null,
    achievements: [], rivalsBeaten: [], player: await buildProfile(c.env, p),
  });

  const decoded = decodeReplayBase64(input.replay);
  if ('error' in decoded) return rejected(decoded.error);
  const verdict = validateRun(track.compiled, decoded.replay, input);
  if (!verdict.ok) return rejected(verdict.reason);

  // state before the write (for WR / rank-change detection)
  const [prevTop, firstDaily, friendIds] = await Promise.all([
    one<{ player_id: string; time_ms: number }>(c.env.DB, 'SELECT player_id, time_ms FROM records WHERE track_id = ? ORDER BY time_ms ASC LIMIT 1', input.trackId),
    input.mode === 'daily' ? count(c.env.DB, "SELECT COUNT(*) AS n FROM runs WHERE player_id = ? AND day_key = ? AND mode = 'daily'", p.id, dayKey(now)) : Promise.resolve(1),
    friendIdsUnion(c.env, p.id),
  ]);

  const stored = await storeRun(c.env, p.id, input.trackId, { ...input, replayBytes: decoded.bytes }, now);
  const prevRank = stored.prevPbMs === null ? null : await rankOf(c.env, input.trackId, stored.prevPbMs);
  const rank = stored.isPb ? await rankOf(c.env, input.trackId, input.timeMs) : prevRank;
  const worldRecord = stored.isPb && (!prevTop || input.timeMs < prevTop.time_ms);
  const medal = medalFor(input.timeMs, track.def.medals);

  // friends whose records I just overtook (I was slower before, faster now)
  let rivalsBeaten: SubmitRecordResponse['rivalsBeaten'] = [];
  if (stored.isPb && friendIds.length) {
    const rows = await all<{ player_id: string; name: string; time_ms: number }>(
      c.env.DB,
      `SELECT r.player_id, p.name, r.time_ms FROM records r JOIN players p ON p.id = r.player_id
       WHERE r.track_id = ? AND r.player_id != ? AND r.time_ms > ? AND r.time_ms < ?
         AND (r.player_id IN (SELECT friend_id FROM friends WHERE player_id = ?) OR r.player_id IN (SELECT player_id FROM friends WHERE friend_id = ?))
       ORDER BY r.time_ms ASC LIMIT 50`,
      input.trackId, p.id, input.timeMs, stored.prevPbMs ?? Number.MAX_SAFE_INTEGER, p.id, p.id,
    );
    rivalsBeaten = rows.map((r) => ({ playerId: r.player_id, name: r.name, byMs: r.time_ms - input.timeMs }));
  }

  const xpBefore = p.xp;
  const awards = newAwards();
  await applyRecordAwards(c.env, {
    p, track, input, stored, now, rank, worldRecord, medal, rivalsBeaten, firstDailyRun: input.mode === 'daily' && firstDaily === 0, firstOnTrack: stored.prevPbMs === null,
  }, awards);
  await commitAwards(c.env, p, awards, now);

  // notifications
  const notes: NotificationInput[] = [];
  const tName = track.def.name;
  for (const r of rivalsBeaten) {
    notes.push({ playerId: r.playerId, kind: 'rival_beat_you', text: `${p.name} beat your time on ${tName} by ${formatTime(r.byMs)}`, trackId: input.trackId, fromPlayerId: p.id });
    notes.push({ playerId: p.id, kind: 'you_beat_rival', text: `You beat ${r.name} on ${tName} by ${formatTime(r.byMs)}`, trackId: input.trackId, fromPlayerId: r.playerId });
  }
  if (stored.isPb && rank !== null && rank <= 10 && (prevRank === null || prevRank > 10)) {
    notes.push({ playerId: p.id, kind: 'rank_change', text: `You entered the global top 10 on ${tName} (#${rank})`, trackId: input.trackId });
  }
  if (stored.isPb && p.schoolId) {
    const schoolBest = await one<{ player_id: string; time_ms: number }>(
      c.env.DB,
      'SELECT r.player_id, r.time_ms FROM records r JOIN players x ON x.id = r.player_id WHERE r.track_id = ? AND x.school_id = ? AND r.player_id != ? ORDER BY r.time_ms ASC LIMIT 1',
      input.trackId, p.schoolId, p.id,
    );
    if (schoolBest && input.timeMs < schoolBest.time_ms && (stored.prevPbMs === null || stored.prevPbMs > schoolBest.time_ms)) {
      notes.push({ playerId: schoolBest.player_id, kind: 'school_record', text: `${p.name} took the school record on ${tName} (${formatTime(input.timeMs)})`, trackId: input.trackId, fromPlayerId: p.id });
    }
  }
  await notify(c.env, notes, now);

  return {
    accepted: true, recordId: stored.runId, isPb: stored.isPb, prevPbMs: stored.prevPbMs, rank, worldRecord, medal,
    xp: awards.xp, coins: awards.coins, levelUp: levelUp(xpBefore, p.xp), achievements: awards.achievements, rivalsBeaten,
    player: await buildProfile(c.env, p),
  };
}

/* ---------- leaderboards ---------- */

export interface LeaderboardQuery {
  trackId: string;
  scope: LeaderboardScope;
  limit: number;
  offset: number;
  me: Player | null;
  /** extra player filter; defaults from scope (school/friends) */
  filter?: 'none' | 'school' | 'friends';
  periodKey?: string;
}

interface Source { base: string; baseParams: unknown[]; join: string; joinParams: unknown[]; hasReplay: string; recordId: string }

function source(q: LeaderboardQuery, periodKey: string | undefined): Source {
  if (q.scope === 'daily' || q.scope === 'weekly') {
    const col = q.scope === 'daily' ? 'day_key' : 'week_key';
    return {
      base: `(SELECT id, player_id, MIN(time_ms) AS time_ms, achieved_at FROM runs WHERE track_id = ? AND ${col} = ? GROUP BY player_id) r`,
      baseParams: [q.trackId, periodKey],
      join: 'LEFT JOIN records x ON x.player_id = r.player_id AND x.track_id = ? AND x.time_ms = r.time_ms',
      joinParams: [q.trackId],
      hasReplay: '(x.id IS NOT NULL)', recordId: 'COALESCE(x.id, r.id)',
    };
  }
  return { base: '(SELECT id, player_id, time_ms, achieved_at, replay IS NOT NULL AS has_replay FROM records WHERE track_id = ?) r', baseParams: [q.trackId], join: '', joinParams: [], hasReplay: 'r.has_replay', recordId: 'r.id' };
}

function filterSql(q: LeaderboardQuery): { where: string[]; params: unknown[] } | null {
  const filter = q.filter ?? (q.scope === 'school' ? 'school' : q.scope === 'friends' ? 'friends' : 'none');
  if (filter === 'school') {
    if (!q.me?.schoolId) return null;
    return { where: ['p.school_id = ?'], params: [q.me.schoolId] };
  }
  if (filter === 'friends') {
    if (!q.me) return null;
    return {
      where: ['(r.player_id = ? OR r.player_id IN (SELECT friend_id FROM friends WHERE player_id = ?) OR r.player_id IN (SELECT player_id FROM friends WHERE friend_id = ?))'],
      params: [q.me.id, q.me.id, q.me.id],
    };
  }
  return { where: [], params: [] };
}

export async function queryLeaderboard(env: Env, q: LeaderboardQuery): Promise<LeaderboardResponse> {
  const periodKey = q.scope === 'daily' ? q.periodKey ?? dayKey() : q.scope === 'weekly' ? q.periodKey ?? weekKey() : undefined;
  const empty: LeaderboardResponse = { trackId: q.trackId, scope: q.scope, entries: [], me: null, total: 0, ...(periodKey ? { periodKey } : {}) };
  const f = filterSql(q);
  if (!f) return empty;
  const src = source(q, periodKey);
  const where = f.where.length ? `WHERE ${f.where.join(' AND ')}` : '';
  const fromJoin = `FROM ${src.base} JOIN players p ON p.id = r.player_id LEFT JOIN schools s ON s.id = p.school_id ${src.join}`;

  const rows = await all<Record<string, unknown> & { time_ms: number; achieved_at: number }>(
    env.DB,
    `SELECT ${src.recordId} AS record_id, r.time_ms, r.achieved_at, ${src.hasReplay} AS has_replay, ${PUBLIC_COLS} ${fromJoin} ${where}
     ORDER BY r.time_ms ASC, r.achieved_at ASC LIMIT ? OFFSET ?`,
    ...src.baseParams, ...src.joinParams, ...f.params, q.limit, q.offset,
  );
  const total = await count(env.DB, `SELECT COUNT(*) AS n ${fromJoin} ${where}`, ...src.baseParams, ...src.joinParams, ...f.params);

  const entries: LeaderboardEntry[] = rows.map((r, i) => {
    const pub = publicFromJoined(r);
    return {
      rank: q.offset + i + 1, recordId: String(r.record_id), playerId: pub.id, name: pub.name, carColor: pub.carColor, timeMs: Number(r.time_ms),
      achievedAt: Number(r.achieved_at), hasReplay: !!r.has_replay, schoolName: pub.schoolName, level: pub.level,
    };
  });

  let me: LeaderboardResponse['me'] = null;
  if (q.me) {
    const mine = await one<{ time_ms: number; record_id: string }>(
      env.DB,
      `SELECT r.time_ms, ${src.recordId} AS record_id ${fromJoin} ${where ? `${where} AND` : 'WHERE'} r.player_id = ?`,
      ...src.baseParams, ...src.joinParams, ...f.params, q.me.id,
    );
    if (mine) {
      const ahead = await count(env.DB, `SELECT COUNT(*) AS n ${fromJoin} ${where ? `${where} AND` : 'WHERE'} r.time_ms < ?`, ...src.baseParams, ...src.joinParams, ...f.params, mine.time_ms);
      me = { rank: ahead + 1, timeMs: Number(mine.time_ms), recordId: String(mine.record_id) };
    }
  }
  return { ...empty, entries, me, total };
}

const SCOPES: LeaderboardScope[] = ['global', 'school', 'friends', 'daily', 'weekly'];

export async function getLeaderboard(c: Ctx): Promise<LeaderboardResponse> {
  const trackId = str(c.query('track'), 64);
  if (!trackId) throw badRequest('track is required');
  const scopeRaw = c.query('scope') ?? 'global';
  const scope = (SCOPES as string[]).includes(scopeRaw) ? (scopeRaw as LeaderboardScope) : 'global';
  const me = await optionalAuth(c.request, c.env);
  if ((scope === 'school' || scope === 'friends') && !me) throw unauthorized('Sign in to see this leaderboard');
  return queryLeaderboard(c.env, {
    trackId, scope, me, limit: int(c.query('limit'), 1, 100) ?? 20, offset: int(c.query('offset'), 0, 100000) ?? 0,
  });
}

/* ---------- GET /api/replay/:recordId ---------- */

export async function getReplay(c: Ctx): Promise<ReplayResponse> {
  const row = await one<RecordRow & Record<string, unknown>>(
    c.env.DB,
    `SELECT r.*, ${PUBLIC_COLS} FROM records r JOIN players p ON p.id = r.player_id LEFT JOIN schools s ON s.id = p.school_id WHERE r.id = ?`,
    c.params.recordId,
  );
  const bytes = row ? blobToBytes(row.replay) : null;
  if (!row || !bytes) throw notFound('Replay not found');
  return {
    recordId: row.id, trackId: row.track_id, timeMs: row.time_ms, replay: bytesToBase64(bytes), player: publicFromJoined(row),
    car: sanitizeCarConfig(parseJson(row.car, {})), achievedAt: row.achieved_at,
  };
}

/* ---------- GET /api/records/history?track= ---------- */

export async function getHistory(c: Ctx): Promise<PbHistoryResponse> {
  const p = await requireAuth(c.request, c.env);
  const trackId = str(c.query('track'), 64);
  if (!trackId) throw badRequest('track is required');
  const runs = await all<RunRow>(c.env.DB, 'SELECT id, time_ms, achieved_at FROM runs WHERE player_id = ? AND track_id = ? ORDER BY achieved_at ASC LIMIT 2000', p.id, trackId);
  const history: PbHistoryResponse['history'] = [];
  let best = Infinity;
  for (const r of runs) {
    if (r.time_ms < best) { best = r.time_ms; history.push({ timeMs: r.time_ms, achievedAt: r.achieved_at, recordId: r.id }); }
  }
  return { trackId, history };
}

/* ---------- GET /api/records/bests ---------- */

export async function getBests(c: Ctx): Promise<{ bests: Record<string, number> }> {
  const p = await requireAuth(c.request, c.env);
  const rows = await all<{ track_id: string; time_ms: number }>(c.env.DB, 'SELECT track_id, time_ms FROM records WHERE player_id = ?', p.id);
  const bests: Record<string, number> = {};
  for (const r of rows) bests[r.track_id] = r.time_ms;
  return { bests };
}
