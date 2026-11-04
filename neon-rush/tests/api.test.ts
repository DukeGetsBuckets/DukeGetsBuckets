// End-to-end API test against a running dev server (vite + cloudflare plugin, local D1).
// Skips when the server is not reachable. Start it with: npx vite --port 5173 --host 127.0.0.1

import { describe, it, expect } from 'vitest';
import { compileTrack } from '../shared/track/compile';
import { chain } from '../shared/track/chain';
import { getOfficialTrack, OFFICIAL_TRACKS } from '../shared/track/officialTracks';
import type { Placement } from '../shared/track/types';
import { encodeReplay, bytesToBase64, REPLAY_HZ } from '../shared/game/replay';
import { quatLookUp, vadd, vscale, vdist, vlerp } from '../shared/math';
import type {
  AuthResponse, SubmitRecordResponse, LeaderboardResponse, FriendsResponse, SchoolResponse, DailyResponse, SaveTrackResponse,
  TracksListResponse, BuyResponse, NotificationsResponse, PbHistoryResponse, LiveRaceResultResponse, PlayerProfile,
} from '../shared/api';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:5173';

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok && (await r.json()).ok === true;
  } catch { return false; }
}
const up = await serverUp();

interface Res<T> { status: number; data: T }
async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, token?: string): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data: data as T };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

/** Builds a plausible replay by driving the centerline at constant speed, finishing in `timeMs`. */
function buildRun(pieces: Placement[], timeMs: number, opts: { teleports?: number } = {}) {
  const c = compileTrack({ pieces });
  if (c.issues.length) throw new Error(c.issues.join(', '));
  let startIdx = 0, best = Infinity;
  c.frames.forEach((f, i) => { const d = vdist(f.pos, c.start.pos); if (d < best) { best = d; startIdx = i; } });
  const startDist = c.frames[startIdx].dist;
  const finish = c.checkpoints[c.checkpoints.length - 1];
  const endDist = finish.dist + 2;
  const speed = (endDist - startDist) / (timeMs / 1000);
  const hz = REPLAY_HZ;
  const frameCount = Math.round((timeMs / 1000) * hz) + 1;
  const frames = new Float32Array(frameCount * 7);
  let fi = startIdx;
  for (let i = 0; i < frameCount; i++) {
    const d = Math.min(endDist, startDist + speed * (i / hz));
    while (fi < c.frames.length - 2 && c.frames[fi + 1].dist <= d) fi++;
    const f = c.frames[fi], g = c.frames[Math.min(fi + 1, c.frames.length - 1)];
    const span = g.dist - f.dist;
    const t = span > 1e-6 ? Math.max(0, Math.min(1, (d - f.dist) / span)) : 0;
    const pos = vadd(vlerp(f.pos, g.pos, t), vscale(f.up, 0.9));
    const q = quatLookUp(f.tangent, f.up);
    frames.set([pos.x, pos.y, pos.z, q.x, q.y, q.z, q.w], i * 7);
  }
  const splits = c.checkpoints.map((cp) => Math.max(1, Math.round(((cp.dist - startDist) / speed) * 1000)));
  splits[splits.length - 1] = timeMs;
  for (let k = 1; k <= (opts.teleports ?? 0); k++) {
    const i = Math.floor((frameCount * k) / ((opts.teleports ?? 0) + 1));
    frames[i * 7] += 400;
  }
  const bytes = encodeReplay({ version: 1, hz, timeMs, frameCount, frames, splits });
  return { replay: bytesToBase64(bytes), splits, timeMs, lengthM: c.length };
}

const TRACK = 'neon-sprint';
const officialPieces = getOfficialTrack(TRACK)!.pieces;
const medals = getOfficialTrack(TRACK)!.medals;
// run times derived from the medal table so retuned medals do not break the expectations
const tA = Math.round((medals.silver + medals.bronze) / 2);  // bronze
const tB = tA - 1000;                                        // bronze, 1 s faster than A
const tA2 = Math.round((medals.gold + medals.silver) / 2);   // silver
const car = { body: 'viper', paint: '#22d3ee', paint2: '#f472b6', finish: 'gloss', underglow: '#a855f7', tireColor: '#22d3ee', wheel: 'classic', trail: 'neon', decal: 'stripes', effect: 'none', number: 7 } as const;
const submitBody = (run: ReturnType<typeof buildRun>, extra: Record<string, unknown> = {}) => ({
  trackId: TRACK, timeMs: run.timeMs, splits: run.splits, replay: run.replay, car, respawns: 0, topSpeed: 60, mode: 'solo', ...extra,
});

if (!up) it.skip(`API server not reachable at ${BASE} — start the dev server to run these tests`, () => {});

describe.skipIf(!up)('NEON RUSH API', () => {
  const suffix = rand();
  let tokenA = '', tokenB = '', playerA: PlayerProfile, playerB: PlayerProfile;
  let guestId = '';

  it('health', async () => {
    const r = await call<{ ok: boolean }>('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const nf = await call('GET', '/nope');
    expect(nf.status).toBe(404);
  });

  it('guest auth creates a profile with a friend code', async () => {
    const r = await call<AuthResponse>('POST', '/auth/guest', { name: `Guest_${suffix}` });
    expect(r.status).toBe(200);
    expect(r.data.token).toHaveLength(64);
    expect(r.data.player.isGuest).toBe(true);
    expect(r.data.player.friendCode).toMatch(/^[A-Z0-9]{6}$/);
    tokenA = r.data.token;
    guestId = r.data.player.id;
    const bad = await call('POST', '/auth/guest', { name: 'x' });
    expect(bad.status).toBe(400);
    const me = await call<{ player: PlayerProfile }>('GET', '/me', undefined, tokenA);
    expect(me.data.player.id).toBe(guestId);
    const noAuth = await call('GET', '/me');
    expect(noAuth.status).toBe(401);
  });

  it('register upgrades the guest in place and login works', async () => {
    const name = `Acct_${suffix}`;
    const r = await call<AuthResponse>('POST', '/auth/register', { name, password: 'secret123', guestToken: tokenA });
    expect(r.status).toBe(200);
    expect(r.data.player.id).toBe(guestId);
    expect(r.data.player.isGuest).toBe(false);
    expect(r.data.player.name).toBe(name);
    tokenA = r.data.token;
    playerA = r.data.player;
    const dup = await call('POST', '/auth/register', { name: name.toUpperCase(), password: 'secret123' });
    expect(dup.status).toBe(409);
    const wrong = await call('POST', '/auth/login', { name, password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    const ok = await call<AuthResponse>('POST', '/auth/login', { name, password: 'secret123' });
    expect(ok.status).toBe(200);
    expect(ok.data.player.id).toBe(guestId);
  });

  it('accepts a valid record and rejects a teleporting replay', async () => {
    const run = buildRun(officialPieces, tA);
    const r = await call<SubmitRecordResponse>('POST', '/records', submitBody(run), tokenA);
    expect(r.status).toBe(200);
    expect(r.data.accepted, r.data.reason).toBe(true);
    expect(r.data.isPb).toBe(true);
    expect(r.data.prevPbMs).toBeNull();
    expect(r.data.medal).toBe('bronze');
    expect(r.data.rank).toBeGreaterThanOrEqual(1);
    // finish(50 + 25*difficulty) + pb + first bronze; the local DB persists, so a WR bonus may apply
    const wr = r.data.worldRecord ? 1 : 0;
    expect(r.data.xp).toBe(50 + 25 + 40 + 20 + wr * 300);
    expect(r.data.coins).toBe(20 + 10 + 15 + 25 + wr * 400);
    expect(r.data.achievements).toContain('first_finish');
    expect(r.data.player.stats.finishes).toBe(1);

    const tooSoon = await call('POST', '/records', submitBody(run), tokenA);
    expect(tooSoon.status).toBe(429);
    await sleep(2100);

    const cheat = buildRun(officialPieces, tA, { teleports: 6 });
    const bad = await call<SubmitRecordResponse>('POST', '/records', submitBody(cheat), tokenA);
    expect(bad.status).toBe(200);
    expect(bad.data.accepted).toBe(false);
    expect(bad.data.reason).toMatch(/teleport/i);

    const fast = buildRun(officialPieces, 3000);
    const tooFast = await call<SubmitRecordResponse>('POST', '/records', submitBody(fast), tokenA);
    expect(tooFast.data.accepted).toBe(false);
  });

  it('global leaderboard lists the record with my rank', async () => {
    const r = await call<LeaderboardResponse>('GET', `/leaderboard?track=${TRACK}&scope=global&limit=100`, undefined, tokenA);
    expect(r.status).toBe(200);
    const mine = r.data.entries.find((e) => e.playerId === guestId);
    expect(mine?.timeMs).toBe(tA);
    expect(mine?.hasReplay).toBe(true);
    expect(r.data.me?.rank).toBe(mine?.rank);
    const replay = await call<{ replay: string; timeMs: number }>('GET', `/replay/${mine!.recordId}`);
    expect(replay.status).toBe(200);
    expect(replay.data.timeMs).toBe(tA);
    expect(replay.data.replay.length).toBeGreaterThan(100);
  });

  it('friends: add by code, list, rivals beaten', async () => {
    const b = await call<AuthResponse>('POST', '/auth/guest', { name: `Buddy_${suffix}` });
    tokenB = b.data.token;
    playerB = b.data.player;
    const add = await call<{ friend: { id: string } }>('POST', '/friends', { code: playerA.friendCode.toLowerCase() }, tokenB);
    expect(add.status).toBe(200);
    expect(add.data.friend.id).toBe(guestId);
    const self = await call('POST', '/friends', { code: playerB.friendCode }, tokenB);
    expect(self.status).toBe(400);
    const list = await call<FriendsResponse>('GET', '/friends', undefined, tokenB);
    expect(list.data.friends.map((f) => f.id)).toContain(guestId);
    expect(list.data.friends[0].bests[TRACK]).toBe(tA);

    // B beats A's time -> A is a rival beaten (friendship counts in both directions)
    const run = buildRun(officialPieces, tB);
    const r = await call<SubmitRecordResponse>('POST', '/records', submitBody(run), tokenB);
    expect(r.data.accepted, r.data.reason).toBe(true);
    expect(r.data.rivalsBeaten.map((x) => x.playerId)).toContain(guestId);
    expect(r.data.rivalsBeaten[0].byMs).toBe(1000);
    const friendsLb = await call<LeaderboardResponse>('GET', `/leaderboard?track=${TRACK}&scope=friends`, undefined, tokenA);
    expect(friendsLb.data.entries.map((e) => e.playerId).sort()).toEqual([guestId, playerB.id].sort());
    expect(friendsLb.data.entries[0].playerId).toBe(playerB.id);
  });

  it('notifications arrive for beaten rivals and can be marked read', async () => {
    const n = await call<NotificationsResponse>('GET', '/notifications', undefined, tokenA);
    expect(n.status).toBe(200);
    expect(n.data.items.some((i) => i.kind === 'rival_beat_you' && i.fromPlayer?.id === playerB.id)).toBe(true);
    expect(n.data.unread).toBeGreaterThan(0);
    await call('POST', '/notifications/read', {}, tokenA);
    const after = await call<NotificationsResponse>('GET', '/notifications', undefined, tokenA);
    expect(after.data.unread).toBe(0);
    const ch = await call('POST', '/challenge', { friendId: guestId, trackId: TRACK }, tokenB);
    expect(ch.status).toBe(200);
  });

  it('schools: create, join by code, rankings', async () => {
    const created = await call<SchoolResponse>('POST', '/schools', { name: `Neon High ${suffix}` }, tokenA);
    expect(created.status).toBe(200);
    expect(created.data.school.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(created.data.school.memberCount).toBe(1);
    const joined = await call<SchoolResponse>('POST', '/schools/join', { code: created.data.school.code }, tokenB);
    expect(joined.status).toBe(200);
    expect(joined.data.school.memberCount).toBe(2);
    const mine = await call<SchoolResponse>('GET', '/schools/mine', undefined, tokenB);
    expect(mine.data.rankings).toHaveLength(2);
    expect(mine.data.rankings[0].rank).toBe(1);
    expect(mine.data.records.find((r) => r.trackId === TRACK)?.playerId).toBe(playerB.id);
    expect(mine.data.weekly.weekKey).toMatch(/^\d{4}-W\d{2}$/);
    const schoolLb = await call<LeaderboardResponse>('GET', `/leaderboard?track=${TRACK}&scope=school`, undefined, tokenA);
    expect(schoolLb.data.total).toBe(2);
    const prof = await call<{ player: PlayerProfile }>('GET', '/me', undefined, tokenB);
    expect(prof.data.player.achievements.some((a) => a.id === 'school_spirit')).toBe(true);
  });

  it('daily challenge', async () => {
    const r = await call<DailyResponse>('GET', '/daily', undefined, tokenA);
    expect(r.status).toBe(200);
    expect(r.data.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(OFFICIAL_TRACKS.map((t) => t.id)).toContain(r.data.trackId);
    expect(r.data.endsAt).toBeGreaterThan(Date.now());
    expect(r.data.yesterday?.dayKey).toBeDefined();
    const weekly = await call<LeaderboardResponse>('GET', `/leaderboard?track=${TRACK}&scope=weekly`, undefined, tokenA);
    expect(weekly.data.periodKey).toMatch(/^\d{4}-W\d{2}$/);
    expect(weekly.data.entries.some((e) => e.playerId === guestId)).toBe(true);
  });

  it('community tracks: draft, publish with validation, list, code, like, play', async () => {
    const pieces = chain({ x: 0, y: 0, z: 0, rot: 0 }, ['start', 'straight', 'curveR2', 'checkpoint', 'straight', 'finish', 'straight']);
    const draft = await call<SaveTrackResponse>('POST', '/tracks', { name: `My Track ${suffix}`, theme: 'cyberVoid', placements: pieces, publish: false }, tokenA);
    expect(draft.status).toBe(200);
    expect(draft.data.track.published).toBe(false);
    expect(draft.data.definition.official).toBe(false);
    expect(draft.data.definition.pieces).toHaveLength(pieces.length);

    const noVal = await call('POST', '/tracks', { id: draft.data.track.id, name: `My Track ${suffix}`, theme: 'cyberVoid', placements: pieces, publish: true }, tokenA);
    expect(noVal.status).toBe(400);
    const broken = await call('POST', '/tracks', { name: `Broken ${suffix}`, theme: 'cyberVoid', placements: pieces.filter((p) => p.type !== 'finish'), publish: false }, tokenA);
    expect(broken.status).toBe(400);

    const run = buildRun(pieces, 12000);
    const pub = await call<SaveTrackResponse>('POST', '/tracks', {
      id: draft.data.track.id, name: `My Track ${suffix}`, description: 'A quick loop', theme: 'cyberVoid', placements: pieces, publish: true,
      validation: { timeMs: run.timeMs, replay: run.replay, splits: run.splits },
    }, tokenA);
    expect(pub.status).toBe(200);
    expect(pub.data.track.published).toBe(true);
    expect(pub.data.track.authorTimeMs).toBe(12000);
    expect(pub.data.definition.medals).toEqual({ author: 12000, gold: 13200, silver: 15000, bronze: 18000 });

    const list = await call<TracksListResponse>('GET', `/tracks?sort=new&q=${encodeURIComponent(suffix)}`, undefined, tokenB);
    expect(list.data.tracks.map((t) => t.id)).toContain(draft.data.track.id);
    const byCode = await call<SaveTrackResponse>('GET', `/tracks/code/${pub.data.track.code.toLowerCase()}`, undefined, tokenB);
    expect(byCode.status).toBe(200);
    expect(byCode.data.track.placements).toHaveLength(pieces.length);
    const like = await call<{ likes: number; likedByMe: boolean }>('POST', `/tracks/${draft.data.track.id}/like`, {}, tokenB);
    expect(like.data).toEqual({ likes: 1, likedByMe: true });
    const unlike = await call<{ likes: number; likedByMe: boolean }>('POST', `/tracks/${draft.data.track.id}/like`, {}, tokenB);
    expect(unlike.data).toEqual({ likes: 0, likedByMe: false });
    const play = await call('POST', `/tracks/${draft.data.track.id}/play`, {}, tokenB);
    expect(play.status).toBe(200);
    const lb = await call<LeaderboardResponse>('GET', `/leaderboard?track=${draft.data.track.id}`);
    expect(lb.data.entries[0]?.playerId).toBe(guestId);
    const me = await call<{ player: PlayerProfile }>('GET', '/me', undefined, tokenA);
    expect(me.data.player.achievements.some((a) => a.id === 'track_builder')).toBe(true);
    expect(me.data.player.stats.tracksPublished).toBe(1);
  });

  it('pb history, bests and shop purchase', async () => {
    await sleep(2100);
    const run = buildRun(officialPieces, tA2);
    const r = await call<SubmitRecordResponse>('POST', '/records', submitBody(run), tokenA);
    expect(r.data.accepted, r.data.reason).toBe(true);
    expect(r.data.isPb).toBe(true);
    expect(r.data.prevPbMs).toBe(tA);
    expect(r.data.medal).toBe('silver');
    expect(r.data.xp).toBe(50 + 25 + 40 + 40 + 30 + (r.data.worldRecord ? 300 : 0)); // finish + pb + first silver + one rival beaten (+ WR)
    expect(r.data.rivalsBeaten.map((x) => x.playerId)).toContain(playerB.id);

    const hist = await call<PbHistoryResponse>('GET', `/records/history?track=${TRACK}`, undefined, tokenA);
    expect(hist.data.history.map((h) => h.timeMs)).toEqual([tA, tA2]);
    const bests = await call<{ bests: Record<string, number> }>('GET', '/records/bests', undefined, tokenA);
    expect(bests.data.bests[TRACK]).toBe(tA2);

    const coins = r.data.player.coins;
    expect(coins).toBeGreaterThanOrEqual(120);
    const buy = await call<BuyResponse>('POST', '/shop/buy', { itemId: 'finish_matte' }, tokenA);
    expect(buy.status).toBe(200);
    expect(buy.data.player.unlocked).toContain('finish_matte');
    expect(buy.data.player.coins).toBe(coins - 120);
    const again = await call('POST', '/shop/buy', { itemId: 'finish_matte' }, tokenA);
    expect(again.status).toBe(409);
    const locked = await call('POST', '/shop/buy', { itemId: 'trail_stars' }, tokenA);
    expect(locked.status).toBe(403);
    const unknown = await call('POST', '/shop/buy', { itemId: 'nope' }, tokenA);
    expect(unknown.status).toBe(400);

    const okCar = await call<{ player: PlayerProfile }>('PUT', '/me', { car: { ...car, finish: 'matte' } }, tokenA);
    expect(okCar.status).toBe(200);
    expect(okCar.data.player.car.finish).toBe('matte');
    const lockedCar = await call('PUT', '/me', { car: { ...car, trail: 'rainbow' } }, tokenA);
    expect(lockedCar.status).toBe(403);
  });

  it('live race results award xp and the first victory', async () => {
    const r = await call<LiveRaceResultResponse>('POST', '/live/result', { roomCode: 'ABCD', trackId: TRACK, position: 1, playerCount: 4, timeMs: 50000 }, tokenB);
    expect(r.status).toBe(200);
    expect(r.data.xp).toBe(100);
    expect(r.data.coins).toBe(80);
    expect(r.data.achievements).toContain('first_victory');
    expect(r.data.player.stats.wins).toBe(1);
    const throttled = await call('POST', '/live/result', { roomCode: 'ABCD', trackId: TRACK, position: 2, playerCount: 4, timeMs: 51000 }, tokenB);
    expect(throttled.status).toBe(429);
  });

  it('cleanup: remove friend and leave school', async () => {
    const rm = await call('DELETE', `/friends/${guestId}`, undefined, tokenB);
    expect(rm.status).toBe(200);
    const leave = await call('POST', '/schools/leave', {}, tokenB);
    expect(leave.status).toBe(200);
    const mine = await call<{ school: null }>('GET', '/schools/mine', undefined, tokenB);
    expect(mine.data.school).toBeNull();
  });
});
