// Player model: parsed row, public/profile projections and persistence.

import type { Env } from './index';
import type { AchievementState, PlayerProfile, PlayerPublic, PlayerStats } from '../shared/api';
import { DEFAULT_CAR, sanitizeCarConfig, type CarConfig } from '../shared/game/carConfig';
import { levelForXp } from '../shared/game/progression';
import { all, one, run, parseJson, type PlayerRow } from './db';
import { uuid, randomCode } from './http';

export interface Player {
  id: string;
  name: string;
  isGuest: boolean;
  passwordHash: string | null;
  friendCode: string;
  schoolId: string | null;
  xp: number;
  coins: number;
  car: CarConfig;
  stats: PlayerStats;
  unlocked: string[];
  achievements: AchievementState[];
  createdAt: number;
  lastSeen: number;
}

export const DEFAULT_STATS: PlayerStats = {
  races: 0, finishes: 0, wins: 0, personalBests: 0, tracksCompleted: 0, goldMedals: 0, authorMedals: 0,
  worldRecords: 0, friendsBeaten: 0, dailyWins: 0, tracksPublished: 0,
};

export function fromRow(row: PlayerRow): Player {
  const unlocked = parseJson<unknown>(row.unlocked, []);
  const achievements = parseJson<unknown>(row.achievements, []);
  return {
    id: row.id,
    name: row.name,
    isGuest: !!row.is_guest,
    passwordHash: row.password_hash ?? null,
    friendCode: row.friend_code,
    schoolId: row.school_id ?? null,
    xp: Number(row.xp) || 0,
    coins: Number(row.coins) || 0,
    car: sanitizeCarConfig(parseJson(row.car, DEFAULT_CAR)),
    stats: { ...DEFAULT_STATS, ...parseJson<Partial<PlayerStats>>(row.stats, {}) },
    unlocked: Array.isArray(unlocked) ? unlocked.filter((x): x is string => typeof x === 'string') : [],
    achievements: Array.isArray(achievements)
      ? achievements.filter((a): a is AchievementState => !!a && typeof (a as AchievementState).id === 'string')
      : [],
    createdAt: Number(row.created_at) || 0,
    lastSeen: Number(row.last_seen) || 0,
  };
}

export function toPublic(p: Player, schoolName: string | null): PlayerPublic {
  return {
    id: p.id, name: p.name, carColor: p.car.paint, level: levelForXp(p.xp), schoolId: p.schoolId, schoolName,
    friendCode: p.friendCode, isGuest: p.isGuest,
  };
}

/** Column list for queries that join `players p LEFT JOIN schools s` and need a PlayerPublic. */
export const PUBLIC_COLS =
  'p.id AS p_id, p.name AS p_name, p.car AS p_car, p.xp AS p_xp, p.school_id AS p_school_id, s.name AS p_school_name, p.friend_code AS p_friend_code, p.is_guest AS p_is_guest';

export function publicFromJoined(r: Record<string, unknown>): PlayerPublic {
  const car = sanitizeCarConfig(parseJson(r.p_car, DEFAULT_CAR));
  return {
    id: String(r.p_id), name: String(r.p_name), carColor: car.paint, level: levelForXp(Number(r.p_xp) || 0),
    schoolId: (r.p_school_id as string | null) ?? null, schoolName: (r.p_school_name as string | null) ?? null,
    friendCode: String(r.p_friend_code ?? ''), isGuest: !!r.p_is_guest,
  };
}

export async function loadPlayer(env: Env, id: string): Promise<Player | null> {
  const row = await one<PlayerRow>(env.DB, 'SELECT * FROM players WHERE id = ?', id);
  return row ? fromRow(row) : null;
}

export async function loadPublic(env: Env, id: string): Promise<PlayerPublic | null> {
  const row = await one<Record<string, unknown>>(env.DB, `SELECT ${PUBLIC_COLS} FROM players p LEFT JOIN schools s ON s.id = p.school_id WHERE p.id = ?`, id);
  return row ? publicFromJoined(row) : null;
}

export async function uniqueFriendCode(env: Env): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(6);
    const hit = await one(env.DB, 'SELECT 1 AS x FROM players WHERE friend_code = ?', code);
    if (!hit) return code;
  }
  throw new Error('Could not allocate a friend code');
}

export async function insertPlayer(env: Env, init: { name: string; isGuest: boolean; passwordHash?: string | null; car?: CarConfig }): Promise<Player> {
  const now = Date.now();
  const p: Player = {
    id: uuid(), name: init.name, isGuest: init.isGuest, passwordHash: init.passwordHash ?? null,
    friendCode: await uniqueFriendCode(env), schoolId: null, xp: 0, coins: 0, car: init.car ?? { ...DEFAULT_CAR },
    stats: { ...DEFAULT_STATS }, unlocked: [], achievements: [], createdAt: now, lastSeen: now,
  };
  await run(
    env.DB,
    `INSERT INTO players (id, name, name_lower, is_guest, password_hash, friend_code, school_id, xp, coins, car, stats, unlocked, achievements, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, '[]', '[]', ?, ?)`,
    p.id, p.name, p.name.toLowerCase(), p.isGuest ? 1 : 0, p.passwordHash, p.friendCode, JSON.stringify(p.car), JSON.stringify(p.stats), now, now,
  );
  return p;
}

/** Persists every mutable column of a player. */
export async function savePlayer(env: Env, p: Player): Promise<void> {
  await run(
    env.DB,
    `UPDATE players SET name = ?, name_lower = ?, is_guest = ?, password_hash = ?, school_id = ?, xp = ?, coins = ?, car = ?, stats = ?, unlocked = ?, achievements = ?, last_seen = ?
     WHERE id = ?`,
    p.name, p.name.toLowerCase(), p.isGuest ? 1 : 0, p.passwordHash, p.schoolId, Math.round(p.xp), Math.round(p.coins), JSON.stringify(p.car),
    JSON.stringify(p.stats), JSON.stringify(p.unlocked), JSON.stringify(p.achievements), p.lastSeen, p.id,
  );
}

export async function schoolNameOf(env: Env, schoolId: string | null): Promise<string | null> {
  if (!schoolId) return null;
  const row = await one<{ name: string }>(env.DB, 'SELECT name FROM schools WHERE id = ?', schoolId);
  return row?.name ?? null;
}

/** Players I follow (one-way), as PlayerPublic. */
export async function listFollowed(env: Env, playerId: string, limit = 200): Promise<PlayerPublic[]> {
  const rows = await all<Record<string, unknown>>(
    env.DB,
    `SELECT ${PUBLIC_COLS} FROM friends f JOIN players p ON p.id = f.friend_id LEFT JOIN schools s ON s.id = p.school_id
     WHERE f.player_id = ? ORDER BY f.created_at ASC LIMIT ?`,
    playerId, limit,
  );
  return rows.map(publicFromJoined);
}

export async function buildProfile(env: Env, p: Player): Promise<PlayerProfile> {
  const [schoolName, friends, unreadRow] = await Promise.all([
    schoolNameOf(env, p.schoolId),
    listFollowed(env, p.id),
    one<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM notifications WHERE player_id = ? AND is_read = 0', p.id),
  ]);
  return {
    ...toPublic(p, schoolName),
    xp: p.xp, coins: p.coins, createdAt: p.createdAt, stats: p.stats, unlocked: p.unlocked, achievements: p.achievements,
    car: p.car, friends, unreadNotifications: Number(unreadRow?.n ?? 0),
  };
}

export function hasAchievement(p: Player, id: string): boolean {
  return p.achievements.some((a) => a.id === id);
}
