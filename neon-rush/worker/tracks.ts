// Community tracks: drafts, validated publishing, listing / search, likes and play counts.

import type { Env } from './index';
import type { CommunityTrack, CommunityTrackSummary, SaveTrackResponse, TracksListResponse, TracksSort } from '../shared/api';
import type { Placement, ThemeId } from '../shared/track/types';
import { PIECES } from '../shared/track/pieces';
import { cleanChat, containsProfanity } from '../shared/game/names';
import { all, one, run, batch, count, type TrackRow } from './db';
import { badRequest, notFound, asObject, int, str, uuid, randomCode } from './http';
import { requireAuth, optionalAuth } from './auth';
import { newAwards, unlock, commitAwards } from './progression';
import { decodeReplayBase64, validateRun } from './validate';
import { storeRun } from './records';
import { definitionFromRow, isThemeId, placementsOf, slimCompile, loadTrackRow } from './trackdefs';
import type { Ctx } from './api';

const MAX_PLACEMENTS = 400;
const NAME_MIN = 3, NAME_MAX = 32;
const DESCRIPTION_MAX = 300;
const SORTS: TracksSort[] = ['new', 'top', 'mine', 'played'];
const AUTHOR_RUN_RESPAWN_ALLOWANCE = 10;

/* ---------- validation ---------- */

function sanitizeTrackName(v: unknown): string {
  const s = (str(v, 80) ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < NAME_MIN || s.length > NAME_MAX) throw badRequest(`Track names are ${NAME_MIN}-${NAME_MAX} characters`, 'invalid_name');
  if (containsProfanity(s)) throw badRequest('Please choose a family friendly track name', 'invalid_name');
  return s;
}

function sanitizePlacements(v: unknown): Placement[] {
  if (!Array.isArray(v) || v.length === 0) throw badRequest('A track needs at least one piece', 'invalid_track');
  if (v.length > MAX_PLACEMENTS) throw badRequest(`Tracks have at most ${MAX_PLACEMENTS} pieces`, 'invalid_track');
  const out: Placement[] = [];
  for (const raw of v) {
    const p = asObject(raw);
    const type = typeof p.type === 'string' ? p.type : '';
    if (!PIECES[type]) throw badRequest(`Unknown track piece: ${type.slice(0, 32)}`, 'invalid_track');
    const nums = [p.x, p.y, p.z].map((n) => (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000 ? Math.round(n * 1000) / 1000 : NaN));
    if (nums.some((n) => Number.isNaN(n))) throw badRequest('Piece positions must be finite numbers', 'invalid_track');
    const rot = int(p.rot, 0, 3);
    if (rot === null) throw badRequest('Piece rotation must be 0-3', 'invalid_track');
    out.push({ type, x: nums[0], y: nums[1], z: nums[2], rot, ...(p.walls === true ? { walls: true } : {}) });
  }
  return out;
}

async function uniqueTrackCode(env: Env): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(6);
    if (!(await one(env.DB, 'SELECT 1 AS x FROM tracks WHERE code = ?', code))) return code;
  }
  throw new Error('Could not allocate a track code');
}

/* ---------- projections ---------- */

type TrackJoined = TrackRow & { author_name: string };
const TRACK_COLS = 't.*, a.name AS author_name';

function summary(row: TrackJoined, likedByMe: boolean): CommunityTrackSummary {
  return {
    id: row.id, code: row.code, name: row.name, theme: (isThemeId(row.theme) ? row.theme : 'neonCity') as ThemeId, authorId: row.author_id, authorName: row.author_name,
    pieces: row.pieces, lengthM: Math.round(row.length_m), likes: row.likes, plays: row.plays, published: !!row.published, authorTimeMs: row.author_time_ms ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, likedByMe,
  };
}

function full(row: TrackJoined, likedByMe: boolean, placements = placementsOf(row)): CommunityTrack {
  return { ...summary(row, likedByMe), placements, description: row.description ?? '' };
}

async function likedSet(env: Env, playerId: string | null, ids: string[]): Promise<Set<string>> {
  if (!playerId || !ids.length) return new Set();
  const rows = await all<{ track_id: string }>(
    env.DB, `SELECT track_id FROM track_likes WHERE player_id = ? AND track_id IN (${ids.map(() => '?').join(',')})`, playerId, ...ids,
  );
  return new Set(rows.map((r) => r.track_id));
}

async function loadJoined(env: Env, where: string, param: string): Promise<TrackJoined | null> {
  return one<TrackJoined>(env.DB, `SELECT ${TRACK_COLS} FROM tracks t JOIN players a ON a.id = t.author_id WHERE ${where}`, param);
}

async function respond(c: Ctx, row: TrackJoined | null): Promise<SaveTrackResponse> {
  const me = await optionalAuth(c.request, c.env);
  if (!row || (!row.published && row.author_id !== me?.id)) throw notFound('Track not found');
  const liked = await likedSet(c.env, me?.id ?? null, [row.id]);
  const placements = placementsOf(row);
  return { track: full(row, liked.has(row.id), placements), definition: definitionFromRow(row, row.author_name, placements) };
}

/* ---------- handlers ---------- */

export async function listTracks(c: Ctx): Promise<TracksListResponse> {
  const sortRaw = c.query('sort') ?? 'new';
  const sort = (SORTS as string[]).includes(sortRaw) ? (sortRaw as TracksSort) : 'new';
  const limit = int(c.query('limit'), 1, 50) ?? 20;
  const offset = int(c.query('offset'), 0, 100000) ?? 0;
  const me = sort === 'mine' ? await requireAuth(c.request, c.env) : await optionalAuth(c.request, c.env);
  const q = (str(c.query('q'), 40) ?? '').replace(/[%_\\]/g, (ch) => `\\${ch}`);

  const where: string[] = [];
  const params: unknown[] = [];
  if (sort === 'mine') { where.push('t.author_id = ?'); params.push(me!.id); } else where.push('t.published = 1');
  if (q) { where.push("t.name LIKE ? ESCAPE '\\'"); params.push(`%${q}%`); }
  const order = { new: 't.created_at DESC', top: 't.likes DESC, t.plays DESC, t.created_at DESC', played: 't.plays DESC, t.likes DESC, t.created_at DESC', mine: 't.updated_at DESC' }[sort];
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = await all<TrackJoined>(c.env.DB, `SELECT ${TRACK_COLS} FROM tracks t JOIN players a ON a.id = t.author_id ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = await count(c.env.DB, `SELECT COUNT(*) AS n FROM tracks t ${whereSql}`, ...params);
  const liked = await likedSet(c.env, me?.id ?? null, rows.map((r) => r.id));
  return { tracks: rows.map((r) => summary(r, liked.has(r.id))), total };
}

export async function getTrack(c: Ctx): Promise<SaveTrackResponse> {
  return respond(c, await loadJoined(c.env, 't.id = ?', c.params.id));
}

export async function getTrackByCode(c: Ctx): Promise<SaveTrackResponse> {
  return respond(c, await loadJoined(c.env, 't.code = ?', c.params.code.toUpperCase()));
}

export async function saveTrack(c: Ctx): Promise<SaveTrackResponse> {
  const p = await requireAuth(c.request, c.env);
  const b = asObject(await c.body());
  const id = str(b.id, 64);
  const name = sanitizeTrackName(b.name);
  const description = cleanChat(b.description ?? '', DESCRIPTION_MAX);
  if (!isThemeId(b.theme)) throw badRequest('Unknown theme', 'invalid_theme');
  const theme = b.theme;
  const placements = sanitizePlacements(b.placements);
  const publish = b.publish === true;

  const compiled = slimCompile(placements);
  if (compiled.issues.length) throw badRequest(compiled.issues.join(' '), 'invalid_track');
  if (compiled.gates.filter((g) => g.kind === 'start').length !== 1 || compiled.gates.filter((g) => g.kind === 'finish').length !== 1) {
    throw badRequest('A track needs exactly one start and one finish line', 'invalid_track');
  }

  const existing = id ? await loadTrackRow(c.env, id) : null;
  if (id && (!existing || existing.author_id !== p.id)) throw notFound('Track not found');

  // publishing requires the author's own completed run on exactly these pieces
  let authorRun: { timeMs: number; splits: number[]; bytes: Uint8Array } | null = null;
  if (publish) {
    if (!b.validation || typeof b.validation !== 'object') throw badRequest('Finish your track once before publishing it', 'validation_required');
    const v = asObject(b.validation);
    const timeMs = int(v.timeMs, 1, 1e9);
    const splits = Array.isArray(v.splits) ? v.splits.map((s) => (typeof s === 'number' && Number.isFinite(s) ? Math.round(s) : NaN)) : [];
    if (timeMs === null || typeof v.replay !== 'string') throw badRequest('Validation run is incomplete', 'validation_required');
    const decoded = decodeReplayBase64(v.replay);
    if ('error' in decoded) throw badRequest(`Validation run rejected: ${decoded.error}`, 'invalid_validation');
    const verdict = validateRun(compiled, decoded.replay, { timeMs, splits, respawns: AUTHOR_RUN_RESPAWN_ALLOWANCE, topSpeed: 0 });
    if (!verdict.ok) throw badRequest(`Validation run rejected: ${verdict.reason}`, 'invalid_validation');
    authorRun = { timeMs, splits, bytes: decoded.bytes };
  }

  const now = Date.now();
  const placementsJson = JSON.stringify(placements);
  let row: TrackRow;
  if (existing) {
    const layoutChanged = existing.placements !== placementsJson;
    row = {
      ...existing, name, description, theme, placements: placementsJson, pieces: placements.length, length_m: compiled.length,
      published: publish ? 1 : 0, author_time_ms: authorRun ? authorRun.timeMs : layoutChanged ? null : existing.author_time_ms, updated_at: now,
    };
    const statements = [
      c.env.DB.prepare('UPDATE tracks SET name = ?, description = ?, theme = ?, placements = ?, pieces = ?, length_m = ?, published = ?, author_time_ms = ?, updated_at = ? WHERE id = ?')
        .bind(row.name, row.description, row.theme, row.placements, row.pieces, row.length_m, row.published, row.author_time_ms, row.updated_at, row.id),
    ];
    if (layoutChanged) {
      // old times are meaningless on a changed layout
      statements.push(c.env.DB.prepare('DELETE FROM records WHERE track_id = ?').bind(row.id), c.env.DB.prepare('DELETE FROM runs WHERE track_id = ?').bind(row.id));
    }
    await batch(c.env.DB, statements);
  } else {
    row = {
      id: uuid(), code: await uniqueTrackCode(c.env), name, description, theme, author_id: p.id, placements: placementsJson, pieces: placements.length,
      length_m: compiled.length, likes: 0, plays: 0, published: publish ? 1 : 0, author_time_ms: authorRun?.timeMs ?? null, created_at: now, updated_at: now,
    };
    await run(
      c.env.DB,
      `INSERT INTO tracks (id, code, name, description, theme, author_id, placements, pieces, length_m, likes, plays, published, author_time_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      row.id, row.code, row.name, row.description, row.theme, row.author_id, row.placements, row.pieces, row.length_m, row.published, row.author_time_ms, row.created_at, row.updated_at,
    );
  }

  if (authorRun) {
    // the validation run becomes the author's record on the track (no XP for publishing your own track)
    await storeRun(c.env, p.id, row.id, { timeMs: authorRun.timeMs, splits: authorRun.splits, car: p.car, replayBytes: authorRun.bytes, respawns: 0, topSpeed: 0, mode: 'solo' }, now);
    if (!existing?.published) {
      const awards = newAwards();
      p.stats.tracksPublished++;
      unlock(p, awards, 'track_builder', now);
      await commitAwards(c.env, p, awards, now);
    }
  }

  const joined: TrackJoined = { ...row, author_name: p.name };
  const liked = await likedSet(c.env, p.id, [row.id]);
  return { track: full(joined, liked.has(row.id), placements), definition: definitionFromRow(row, p.name, placements) };
}

export async function deleteTrack(c: Ctx): Promise<{ ok: true }> {
  const p = await requireAuth(c.request, c.env);
  const row = await loadTrackRow(c.env, c.params.id);
  if (!row || row.author_id !== p.id) throw notFound('Track not found');
  await batch(c.env.DB, [
    c.env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM track_likes WHERE track_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM records WHERE track_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM runs WHERE track_id = ?').bind(row.id),
  ]);
  return { ok: true };
}

export async function likeTrack(c: Ctx): Promise<{ likes: number; likedByMe: boolean }> {
  const p = await requireAuth(c.request, c.env);
  const row = await loadTrackRow(c.env, c.params.id);
  if (!row || (!row.published && row.author_id !== p.id)) throw notFound('Track not found');
  const existing = await one(c.env.DB, 'SELECT 1 AS x FROM track_likes WHERE track_id = ? AND player_id = ?', row.id, p.id);
  if (existing) {
    await batch(c.env.DB, [
      c.env.DB.prepare('DELETE FROM track_likes WHERE track_id = ? AND player_id = ?').bind(row.id, p.id),
      c.env.DB.prepare('UPDATE tracks SET likes = MAX(0, likes - 1) WHERE id = ?').bind(row.id),
    ]);
  } else {
    await batch(c.env.DB, [
      c.env.DB.prepare('INSERT INTO track_likes (track_id, player_id, created_at) VALUES (?, ?, ?)').bind(row.id, p.id, Date.now()),
      c.env.DB.prepare('UPDATE tracks SET likes = likes + 1 WHERE id = ?').bind(row.id),
    ]);
  }
  const likes = await count(c.env.DB, 'SELECT likes AS n FROM tracks WHERE id = ?', row.id);
  return { likes, likedByMe: !existing };
}

export async function playTrack(c: Ctx): Promise<{ ok: true }> {
  const res = await run(c.env.DB, 'UPDATE tracks SET plays = plays + 1 WHERE id = ? AND published = 1', c.params.id);
  if (res.meta.changes === 0) throw notFound('Track not found');
  return { ok: true };
}
