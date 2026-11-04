// Friends, schools, notifications and challenges.

import type { Env } from './index';
import type {
  FriendsResponse, Notification, NotificationKind, NotificationsResponse, PlayerPublic, School, SchoolRankingEntry, SchoolRecord, SchoolResponse,
} from '../shared/api';
import { containsProfanity } from '../shared/game/names';
import { weekKey, weekEndsAt } from '../shared/game/daily';
import { OFFICIAL_TRACK_MAP } from '../shared/track/officialTracks';
import { formatTime } from '../shared/math';
import { medalFor, medalTier, levelForXp } from '../shared/game/progression';
import { DEFAULT_CAR, sanitizeCarConfig } from '../shared/game/carConfig';
import { all, one, run, batch, count, parseJson, isUniqueViolation, type SchoolRow, type NotificationRow } from './db';
import { badRequest, notFound, conflict, forbidden, asObject, randomCode, uuid, str } from './http';
import { PUBLIC_COLS, publicFromJoined, loadPublic, type Player } from './players';
import { newAwards, unlock, commitAwards } from './progression';
import { requireAuth } from './auth';
import { trackName } from './trackdefs';
import type { Ctx } from './api';

/* ---------- notifications ---------- */

export interface NotificationInput { playerId: string; kind: NotificationKind; text: string; trackId?: string | null; fromPlayerId?: string | null }

export function notificationStatement(env: Env, n: NotificationInput, now: number): D1PreparedStatement {
  return env.DB
    .prepare('INSERT INTO notifications (id, player_id, kind, text, track_id, from_player_id, created_at, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
    .bind(uuid(), n.playerId, n.kind, n.text.slice(0, 300), n.trackId ?? null, n.fromPlayerId ?? null, now);
}

export async function notify(env: Env, items: NotificationInput[], now = Date.now()): Promise<void> {
  if (!items.length) return;
  await batch(env.DB, items.map((n) => notificationStatement(env, n, now)));
}

export async function listNotifications(c: Ctx): Promise<NotificationsResponse> {
  const p = await requireAuth(c.request, c.env);
  const rows = await all<NotificationRow & Record<string, unknown>>(
    c.env.DB,
    `SELECT n.*, ${PUBLIC_COLS} FROM notifications n
     LEFT JOIN players p ON p.id = n.from_player_id LEFT JOIN schools s ON s.id = p.school_id
     WHERE n.player_id = ? ORDER BY n.created_at DESC LIMIT 50`,
    p.id,
  );
  const items: Notification[] = rows.map((r) => ({
    id: r.id, kind: r.kind as NotificationKind, text: r.text, trackId: r.track_id ?? null,
    fromPlayer: r.p_id ? publicFromJoined(r) : null, createdAt: r.created_at, read: !!r.is_read,
  }));
  const unread = await count(c.env.DB, 'SELECT COUNT(*) AS n FROM notifications WHERE player_id = ? AND is_read = 0', p.id);
  return { items, unread };
}

export async function markNotificationsRead(c: Ctx): Promise<{ ok: true }> {
  const p = await requireAuth(c.request, c.env);
  const body = asObject(await c.body());
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 100) : null;
  if (ids && ids.length) {
    await batch(c.env.DB, ids.map((id) => c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND player_id = ?').bind(id, p.id)));
  } else {
    await run(c.env.DB, 'UPDATE notifications SET is_read = 1 WHERE player_id = ? AND is_read = 0', p.id);
  }
  return { ok: true };
}

/* ---------- friends ---------- */

/** Ids of everyone connected to the player in either direction. */
export async function friendIdsUnion(env: Env, playerId: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    env.DB,
    'SELECT friend_id AS id FROM friends WHERE player_id = ? UNION SELECT player_id AS id FROM friends WHERE friend_id = ?',
    playerId, playerId,
  );
  return rows.map((r) => r.id);
}

export async function areConnected(env: Env, a: string, b: string): Promise<boolean> {
  const row = await one(env.DB, 'SELECT 1 AS x FROM friends WHERE (player_id = ? AND friend_id = ?) OR (player_id = ? AND friend_id = ?)', a, b, b, a);
  return !!row;
}

export async function listFriends(c: Ctx): Promise<FriendsResponse> {
  const p = await requireAuth(c.request, c.env);
  const rows = await all<Record<string, unknown> & { last_seen: number }>(
    c.env.DB,
    `SELECT ${PUBLIC_COLS}, p.last_seen FROM friends f JOIN players p ON p.id = f.friend_id LEFT JOIN schools s ON s.id = p.school_id
     WHERE f.player_id = ? ORDER BY f.created_at ASC LIMIT 200`,
    p.id,
  );
  const bests = new Map<string, Record<string, number>>();
  if (rows.length) {
    const recs = await all<{ player_id: string; track_id: string; time_ms: number }>(
      c.env.DB,
      'SELECT r.player_id, r.track_id, r.time_ms FROM records r JOIN friends f ON f.friend_id = r.player_id WHERE f.player_id = ?',
      p.id,
    );
    for (const r of recs) {
      let m = bests.get(r.player_id);
      if (!m) { m = {}; bests.set(r.player_id, m); }
      m[r.track_id] = r.time_ms;
    }
  }
  return {
    friends: rows.map((r) => ({ ...publicFromJoined(r), lastSeen: Number(r.last_seen) || 0, bests: bests.get(String(r.p_id)) ?? {} })),
  };
}

export async function addFriend(c: Ctx): Promise<{ friend: PlayerPublic }> {
  const p = await requireAuth(c.request, c.env);
  const body = asObject(await c.body());
  const code = (str(body.code, 12) ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4) throw badRequest('Enter a friend code', 'invalid_code');
  const target = await one<Record<string, unknown>>(
    c.env.DB, `SELECT ${PUBLIC_COLS} FROM players p LEFT JOIN schools s ON s.id = p.school_id WHERE p.friend_code = ?`, code,
  );
  if (!target) throw notFound('No player with that friend code', 'unknown_code');
  const friend = publicFromJoined(target);
  if (friend.id === p.id) throw badRequest('You cannot add yourself', 'self_friend');
  const now = Date.now();
  const res = await run(c.env.DB, 'INSERT OR IGNORE INTO friends (player_id, friend_id, created_at) VALUES (?, ?, ?)', p.id, friend.id, now);
  if (res.meta.changes > 0) {
    await notify(c.env, [{ playerId: friend.id, kind: 'friend_added', text: `${p.name} added you as a friend (code ${p.friendCode})`, fromPlayerId: p.id }], now);
    const n = await count(c.env.DB, 'SELECT COUNT(*) AS n FROM friends WHERE player_id = ?', p.id);
    const awards = newAwards();
    if (n >= 5 && unlock(p, awards, 'socialite', now)) await commitAwards(c.env, p, awards, now);
  }
  return { friend };
}

export async function removeFriend(c: Ctx): Promise<{ ok: true }> {
  const p = await requireAuth(c.request, c.env);
  await run(c.env.DB, 'DELETE FROM friends WHERE player_id = ? AND friend_id = ?', p.id, c.params.id);
  return { ok: true };
}

/* ---------- schools ---------- */

const SCHOOL_NAME_MIN = 3, SCHOOL_NAME_MAX = 40;

function sanitizeSchoolName(v: unknown): string {
  const s = (str(v, 80) ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < SCHOOL_NAME_MIN || s.length > SCHOOL_NAME_MAX) throw badRequest(`School names are ${SCHOOL_NAME_MIN}-${SCHOOL_NAME_MAX} characters`, 'invalid_name');
  if (containsProfanity(s)) throw badRequest('Please choose a family friendly school name', 'invalid_name');
  return s;
}

async function uniqueSchoolCode(env: Env): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(6);
    if (!(await one(env.DB, 'SELECT 1 AS x FROM schools WHERE code = ?', code))) return code;
  }
  throw new Error('Could not allocate a school code');
}

async function schoolModel(env: Env, row: SchoolRow): Promise<School> {
  const memberCount = await count(env.DB, 'SELECT COUNT(*) AS n FROM players WHERE school_id = ?', row.id);
  return { id: row.id, name: row.name, code: row.code, memberCount, createdAt: row.created_at };
}

interface MemberRow { id: string; name: string; car: string; xp: number; friend_code: string; is_guest: number }
interface MemberRecord { player_id: string; track_id: string; time_ms: number; achieved_at: number }

function rankMembers(members: MemberRow[], recs: MemberRecord[]): SchoolRankingEntry[] {
  const acc = new Map<string, { points: number; pbs: number; tracks: Set<string> }>();
  for (const r of recs) {
    const def = OFFICIAL_TRACK_MAP[r.track_id];
    if (!def) continue;
    let a = acc.get(r.player_id);
    if (!a) { a = { points: 0, pbs: 0, tracks: new Set() }; acc.set(r.player_id, a); }
    const tier = medalTier(medalFor(r.time_ms, def.medals));
    a.points += [0, 1, 2, 4, 6][tier] + 1; // medal points + 1 per track completed
    a.pbs++;
    a.tracks.add(r.track_id);
  }
  const entries = members.map((m) => {
    const a = acc.get(m.id);
    const car = sanitizeCarConfig(parseJson(m.car, DEFAULT_CAR));
    return { rank: 0, playerId: m.id, name: m.name, carColor: car.paint, level: levelForXp(m.xp), points: a?.points ?? 0, personalBests: a?.pbs ?? 0, tracksCompleted: a?.tracks.size ?? 0 };
  });
  entries.sort((x, y) => y.points - x.points || y.personalBests - x.personalBests || x.name.localeCompare(y.name));
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}

function bestPerTrack(members: Map<string, MemberRow>, recs: MemberRecord[]): SchoolRecord[] {
  const best = new Map<string, MemberRecord>();
  for (const r of recs) {
    if (!OFFICIAL_TRACK_MAP[r.track_id]) continue;
    const b = best.get(r.track_id);
    if (!b || r.time_ms < b.time_ms) best.set(r.track_id, r);
  }
  return [...best.values()].map((r) => ({
    trackId: r.track_id, trackName: OFFICIAL_TRACK_MAP[r.track_id].name, timeMs: r.time_ms, playerId: r.player_id,
    playerName: members.get(r.player_id)?.name ?? 'Unknown', achievedAt: r.achieved_at,
  })).sort((a, b) => a.trackName.localeCompare(b.trackName));
}

function rivalries(members: MemberRow[], recs: MemberRecord[], schoolName: string | null): SchoolResponse['rivalries'] {
  const byTrack = new Map<string, MemberRecord[]>();
  for (const r of recs) {
    if (!OFFICIAL_TRACK_MAP[r.track_id]) continue;
    let list = byTrack.get(r.track_id);
    if (!list) { list = []; byTrack.set(r.track_id, list); }
    list.push(r);
  }
  const pairs = new Map<string, { a: string; b: string; aWins: number; bWins: number }>();
  for (const list of byTrack.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [x, y] = list[i].player_id < list[j].player_id ? [list[i], list[j]] : [list[j], list[i]];
      const key = `${x.player_id}|${y.player_id}`;
      let pr = pairs.get(key);
      if (!pr) { pr = { a: x.player_id, b: y.player_id, aWins: 0, bWins: 0 }; pairs.set(key, pr); }
      if (x.time_ms < y.time_ms) pr.aWins++; else if (y.time_ms < x.time_ms) pr.bWins++;
    }
  }
  const byId = new Map(members.map((m) => [m.id, m]));
  const pub = (m: MemberRow): PlayerPublic => {
    const car = sanitizeCarConfig(parseJson(m.car, DEFAULT_CAR));
    return { id: m.id, name: m.name, carColor: car.paint, level: levelForXp(m.xp), schoolId: null, schoolName, friendCode: m.friend_code, isGuest: !!m.is_guest };
  };
  return [...pairs.values()]
    .filter((p) => p.aWins + p.bWins >= 2)
    .sort((p, q) => (q.aWins + q.bWins) - (p.aWins + p.bWins) || Math.min(q.aWins, q.bWins) - Math.min(p.aWins, p.bWins))
    .slice(0, 5)
    .flatMap((p) => {
      const a = byId.get(p.a), b = byId.get(p.b);
      return a && b ? [{ a: pub(a), b: pub(b), aWins: p.aWins, bWins: p.bWins }] : [];
    });
}

export async function schoolResponse(env: Env, row: SchoolRow): Promise<SchoolResponse> {
  const wk = weekKey();
  const [school, members, recs, weeklyRecs] = await Promise.all([
    schoolModel(env, row),
    all<MemberRow>(env.DB, 'SELECT id, name, car, xp, friend_code, is_guest FROM players WHERE school_id = ? ORDER BY xp DESC LIMIT 500', row.id),
    all<MemberRecord>(env.DB, 'SELECT r.player_id, r.track_id, r.time_ms, r.achieved_at FROM records r JOIN players p ON p.id = r.player_id WHERE p.school_id = ?', row.id),
    all<MemberRecord>(
      env.DB,
      `SELECT r.player_id, r.track_id, MIN(r.time_ms) AS time_ms, r.achieved_at FROM runs r JOIN players p ON p.id = r.player_id
       WHERE p.school_id = ? AND r.week_key = ? GROUP BY r.player_id, r.track_id`,
      row.id, wk,
    ),
  ]);
  const memberMap = new Map(members.map((m) => [m.id, m]));
  return {
    school,
    rankings: rankMembers(members, recs),
    weekly: { weekKey: wk, endsAt: weekEndsAt(), rankings: rankMembers(members, weeklyRecs).filter((e) => e.points > 0) },
    records: bestPerTrack(memberMap, recs),
    rivalries: rivalries(members, recs, row.name),
  };
}

async function joinSchool(env: Env, p: Player, row: SchoolRow): Promise<SchoolResponse> {
  const now = Date.now();
  p.schoolId = row.id;
  const awards = newAwards();
  unlock(p, awards, 'school_spirit', now);
  await commitAwards(env, p, awards, now);
  return schoolResponse(env, row);
}

export async function createSchool(c: Ctx): Promise<SchoolResponse> {
  const p = await requireAuth(c.request, c.env);
  const body = asObject(await c.body());
  const name = sanitizeSchoolName(body.name);
  if (p.schoolId) throw conflict('Leave your current school first', 'already_in_school');
  const row: SchoolRow = { id: uuid(), name, name_lower: name.toLowerCase(), code: await uniqueSchoolCode(c.env), created_by: p.id, created_at: Date.now() };
  try {
    await run(c.env.DB, 'INSERT INTO schools (id, name, name_lower, code, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', row.id, row.name, row.name_lower, row.code, row.created_by, row.created_at);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('A school with that name already exists — ask a classmate for its code', 'name_taken');
    throw err;
  }
  return joinSchool(c.env, p, row);
}

export async function joinSchoolByCode(c: Ctx): Promise<SchoolResponse> {
  const p = await requireAuth(c.request, c.env);
  const body = asObject(await c.body());
  const code = (str(body.code, 12) ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const row = code ? await one<SchoolRow>(c.env.DB, 'SELECT * FROM schools WHERE code = ?', code) : null;
  if (!row) throw notFound('No school with that code', 'unknown_code');
  if (p.schoolId && p.schoolId !== row.id) throw conflict('Leave your current school first', 'already_in_school');
  return joinSchool(c.env, p, row);
}

export async function leaveSchool(c: Ctx): Promise<{ ok: true }> {
  const p = await requireAuth(c.request, c.env);
  if (p.schoolId) await run(c.env.DB, 'UPDATE players SET school_id = NULL WHERE id = ?', p.id);
  return { ok: true };
}

export async function mySchool(c: Ctx): Promise<SchoolResponse | { school: null }> {
  const p = await requireAuth(c.request, c.env);
  const row = p.schoolId ? await one<SchoolRow>(c.env.DB, 'SELECT * FROM schools WHERE id = ?', p.schoolId) : null;
  if (!row) return { school: null };
  return schoolResponse(c.env, row);
}

/* ---------- challenges ---------- */

export async function challengeFriend(c: Ctx): Promise<{ ok: true }> {
  const p = await requireAuth(c.request, c.env);
  const body = asObject(await c.body());
  const friendId = str(body.friendId, 64), trackId = str(body.trackId, 64);
  if (!friendId || !trackId) throw badRequest('friendId and trackId are required');
  if (friendId === p.id) throw badRequest('You cannot challenge yourself');
  if (!(await areConnected(c.env, p.id, friendId))) throw forbidden('You can only challenge friends', 'not_friends');
  if (!(await loadPublic(c.env, friendId))) throw notFound('Player not found');
  const mine = await one<{ time_ms: number }>(c.env.DB, 'SELECT time_ms FROM records WHERE track_id = ? AND player_id = ?', trackId, p.id);
  if (!mine) throw badRequest('Set a time on this track before challenging friends', 'no_record');
  const name = await trackName(c.env, trackId);
  await notify(c.env, [{ playerId: friendId, kind: 'challenge', text: `${p.name} challenges you to beat ${formatTime(mine.time_ms)} on ${name}`, trackId, fromPlayerId: p.id }]);
  return { ok: true };
}
