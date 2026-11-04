import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_MS, EMPTY_ROOM_TTL_MS, FINISH_GRACE_MS, JOIN_REJECT_CLOSE_CODE, RACE_TIME_LIMIT_MS, RESULTS_AUTO_RETURN_MS,
  RoomCore, parseClientMessage, type RoomSink,
} from '../worker/room';
import { MAX_ROOM_PLAYERS } from '../shared/net';
import type { ClientMessage, NetCarState, ServerMessage } from '../shared/net';
import { DEFAULT_CAR } from '../shared/game/carConfig';

/* A fake clock + recording sink so the state machine can be driven without Cloudflare. */
function harness() {
  let t = 1_000_000;
  const sent: { id: string; msg: ServerMessage }[] = [];
  const closed: { id: string; code: number; reason: string }[] = [];
  const sink: RoomSink = {
    send: (id, msg) => sent.push({ id, msg: structuredClone(msg) }),
    broadcast: (ids, msg) => { const m = structuredClone(msg); for (const id of ids) sent.push({ id, msg: m }); },
    close: (id, code, reason) => closed.push({ id, code, reason }),
  };
  const core = new RoomCore(RoomCore.createRoom('TEST01'), null, sink, () => t, () => 0.1234);
  const advance = (ms: number) => { t += ms; };
  const msgs = (id: string, type?: ServerMessage['type']) => sent.filter((s) => s.id === id && (!type || s.msg.type === type)).map((s) => s.msg);
  const last = <T extends ServerMessage['type']>(id: string, type: T) => msgs(id, type).at(-1) as Extract<ServerMessage, { type: T }> | undefined;
  const clear = () => { sent.length = 0; closed.length = 0; };
  const join = (id: string, name = 'P_' + id) => core.handle(id, { type: 'join', name, car: DEFAULT_CAR, playerId: null, token: null });
  const send = (id: string, msg: ClientMessage) => core.handle(id, msg);
  return { core, sink, sent, closed, advance, msgs, last, clear, join, send, now: () => t };
}

function carState(p: number, cp: number): NetCarState {
  return { t: 0, x: p * 100, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, s: 20, d: 0, b: 0, cp, p };
}

/** Lobby -> countdown -> racing with the given players (host starts). */
function startRace(h: ReturnType<typeof harness>, ids: string[]) {
  for (const id of ids) h.join(id);
  h.send(ids[0], { type: 'start' });
  expect(h.core.room.phase).toBe('countdown');
  h.advance(COUNTDOWN_MS);
  expect(h.core.onAlarm()).toBeNull();
  expect(h.core.room.phase).toBe('racing');
  h.clear();
}

describe('RoomCore: joining and host assignment', () => {
  it('welcomes the first player as host and broadcasts the room', () => {
    const h = harness();
    h.join('a', 'Alice');
    const welcome = h.last('a', 'welcome');
    expect(welcome?.you).toBe('a');
    expect(welcome?.room.code).toBe('TEST01');
    expect(welcome?.room.hostId).toBe('a');
    expect(h.core.room.players[0]).toMatchObject({ id: 'a', name: 'Alice', isHost: true, ready: false, connected: true, position: 1 });
    expect(h.last('a', 'room')?.room.players).toHaveLength(1);
    expect(h.core.dirty).toBe(true);
    expect(h.core.nextAlarmAt()).toBeNull();
  });

  it('keeps join order, second player is not host, everyone gets the room update', () => {
    const h = harness();
    h.join('a', 'Alice');
    h.join('b', 'Bob');
    expect(h.core.room.players.map((p) => p.id)).toEqual(['a', 'b']);
    expect(h.core.room.players[1].isHost).toBe(false);
    expect(h.core.room.hostId).toBe('a');
    expect(h.msgs('a', 'room')).toHaveLength(2);
    expect(h.msgs('b', 'room')).toHaveLength(1);
  });

  it('falls back to Racer#### for invalid names, sanitizes cars, and de-duplicates names', () => {
    const h = harness();
    h.join('a', 'x');                 // too short
    expect(h.core.room.players[0].name).toBe('Racer1234');
    h.core.handle('b', { type: 'join', name: 'Bob', car: { body: 'nope', paint: 'red' } as never, playerId: 'acct-1', token: null });
    expect(h.core.room.players[1].car).toEqual(DEFAULT_CAR);
    expect(h.core.room.players[1].playerId).toBe('acct-1');
    h.join('c', 'bob');
    expect(h.core.room.players[2].name).toBe('bob_2');
  });

  it('rejects joins when full (error + close 4001)', () => {
    const h = harness();
    for (let i = 0; i < MAX_ROOM_PLAYERS; i++) h.join(`p${i}`, `Player${i}`);
    h.clear();
    h.join('late', 'Late');
    expect(h.core.room.players).toHaveLength(MAX_ROOM_PLAYERS);
    expect(h.last('late', 'error')?.message).toMatch(/full/i);
    expect(h.closed).toEqual([{ id: 'late', code: JOIN_REJECT_CLOSE_CODE, reason: expect.any(String) }]);
  });

  it('rejects joins during countdown and racing, allows them in results', () => {
    const h = harness();
    h.join('a');
    h.send('a', { type: 'start' });
    h.clear();
    h.join('b');
    expect(h.last('b', 'error')?.message).toBe('Race in progress — wait for the lobby');
    expect(h.closed[0]).toMatchObject({ id: 'b', code: JOIN_REJECT_CLOSE_CODE });
    h.advance(COUNTDOWN_MS);
    h.core.onAlarm();
    h.clear();
    h.join('c');
    expect(h.last('c', 'error')?.message).toMatch(/in progress/);
    h.send('a', { type: 'finish', timeMs: 5000 });
    expect(h.core.room.phase).toBe('results');
    h.join('d');
    expect(h.core.room.players.map((p) => p.id)).toEqual(['a', 'd']);
  });

  it('requires join before anything else, answers ping anyway', () => {
    const h = harness();
    h.send('x', { type: 'ready', ready: true });
    expect(h.last('x', 'error')?.message).toMatch(/join/i);
    h.send('x', { type: 'ping', t: 42 });
    expect(h.last('x', 'pong')).toMatchObject({ t: 42, serverTime: h.now() });
    h.join('x');
    h.join('x');
    expect(h.last('x', 'error')?.message).toBe('Already joined');
  });
});

describe('RoomCore: lobby, countdown and race start', () => {
  it('only the host selects the track; non-host start is refused', () => {
    const h = harness();
    h.join('a');
    h.join('b');
    h.send('b', { type: 'selectTrack', trackId: 'void-spiral', trackSource: 'official' });
    expect(h.last('b', 'error')?.message).toMatch(/host/);
    expect(h.core.room.trackId).toBe('neon-sprint');
    h.send('a', { type: 'selectTrack', trackId: 'abc123', trackSource: 'community' });
    expect(h.core.room).toMatchObject({ trackId: 'abc123', trackSource: 'community' });
    expect(h.last('b', 'room')?.room.trackId).toBe('abc123');
    h.send('b', { type: 'start' });
    expect(h.last('b', 'error')?.message).toMatch(/host/);
    expect(h.core.room.phase).toBe('lobby');
  });

  it('auto-starts the countdown when every player (>= 2) is ready', () => {
    const h = harness();
    h.join('a');
    h.send('a', { type: 'ready', ready: true });
    expect(h.core.room.phase).toBe('lobby'); // single ready player does not start
    h.join('b');
    h.send('b', { type: 'ready', ready: true });
    expect(h.core.room.phase).toBe('countdown');
    expect(h.core.room.countdownEndsAt).toBe(h.now() + COUNTDOWN_MS);
    const cd = h.last('b', 'countdown');
    expect(cd).toMatchObject({ endsAt: h.now() + COUNTDOWN_MS, serverTime: h.now() });
    expect(h.last('a', 'room')?.room.phase).toBe('countdown');
    expect(h.core.nextAlarmAt()).toBe(h.core.room.countdownEndsAt);
  });

  it('host start -> countdown -> racing at the countdown-end alarm', () => {
    const h = harness();
    h.join('a');
    h.join('b');
    h.send('a', { type: 'ready', ready: true });
    h.send('a', { type: 'start' });
    expect(h.core.room.phase).toBe('countdown');
    const endsAt = h.core.room.countdownEndsAt!;
    // Alarm before the deadline does nothing.
    h.advance(COUNTDOWN_MS - 1);
    expect(h.core.onAlarm()).toBeNull();
    expect(h.core.room.phase).toBe('countdown');
    h.advance(1);
    h.clear();
    expect(h.core.onAlarm()).toBeNull();
    expect(h.core.room.phase).toBe('racing');
    expect(h.core.room.raceStartedAt).toBe(endsAt);
    expect(h.core.room.raceEndsAt).toBe(endsAt + RACE_TIME_LIMIT_MS);
    expect(h.core.room.countdownEndsAt).toBeNull();
    expect(h.last('b', 'raceStart')?.startedAt).toBe(endsAt);
    expect(h.last('a', 'room')?.room.phase).toBe('racing');
    expect(h.core.nextAlarmAt()).toBe(endsAt + RACE_TIME_LIMIT_MS);
    // Lobby-only messages are refused while racing.
    h.send('a', { type: 'ready', ready: true });
    expect(h.last('a', 'error')?.message).toMatch(/lobby/i);
  });
});

describe('RoomCore: racing', () => {
  it('relays states to the other players with server time and tracks progress/positions', () => {
    const h = harness();
    startRace(h, ['a', 'b', 'c']);
    h.send('a', { type: 'state', state: carState(0.3, 1) });
    expect(h.msgs('a', 'states')).toHaveLength(0);
    const relayed = h.last('b', 'states');
    expect(relayed?.states).toEqual([{ id: 'a', state: { ...carState(0.3, 1), t: h.now() } }]);
    expect(h.last('c', 'states')?.states[0].id).toBe('a');
    expect(h.core.room.players[0]).toMatchObject({ progress: 0.3, checkpoint: 1, position: 1 });
    expect(h.core.carState('a')?.p).toBe(0.3);
    expect(h.core.carState('b')).toBeNull();
    // Position-change room broadcast was sent (a moved from 1->1? no: b and c shift) -> check ordering
    h.advance(300);
    h.send('b', { type: 'state', state: carState(0.1, 2) }); // higher checkpoint beats progress
    expect(h.core.room.players.map((p) => [p.id, p.position])).toEqual([['a', 2], ['b', 1], ['c', 3]]);
    expect(h.last('c', 'room')?.room.players.find((p) => p.id === 'b')?.position).toBe(1);
  });

  it('throttles position-only room broadcasts to one per 250 ms', () => {
    const h = harness();
    startRace(h, ['a', 'b']);
    h.send('b', { type: 'state', state: carState(0.5, 0) }); // b overtakes a, but raceStart just broadcast `room`
    expect(h.msgs('a', 'room')).toHaveLength(0);
    h.advance(300);
    h.send('b', { type: 'state', state: carState(0.55, 0) }); // pending position change flushes now
    expect(h.msgs('a', 'room')).toHaveLength(1);
    expect(h.last('a', 'room')?.room.players.map((p) => p.position)).toEqual([2, 1]);
    h.advance(100);
    h.send('a', { type: 'state', state: carState(0.9, 0) }); // a overtakes back; too soon to broadcast
    expect(h.msgs('a', 'room')).toHaveLength(1);
    h.advance(200);
    h.send('b', { type: 'state', state: carState(0.6, 0) }); // no change, but pending dirty flushes now
    expect(h.msgs('a', 'room')).toHaveLength(2);
    expect(h.last('a', 'room')?.room.players.map((p) => p.position)).toEqual([1, 2]);
  });

  it('rate-limits state messages to about 30 per second per connection', () => {
    const h = harness();
    startRace(h, ['a', 'b']);
    for (let i = 0; i < 60; i++) h.send('a', { type: 'state', state: carState(0.1, 0) });
    expect(h.msgs('b', 'states')).toHaveLength(30);
    h.advance(500);
    for (let i = 0; i < 60; i++) h.send('a', { type: 'state', state: carState(0.1, 0) });
    expect(h.msgs('b', 'states')).toHaveLength(45);
    // Invalid states are dropped silently.
    h.advance(1000);
    h.clear();
    h.send('a', { type: 'state', state: { x: NaN } as never });
    expect(h.sent).toHaveLength(0);
  });

  it('ignores states outside countdown/racing', () => {
    const h = harness();
    h.join('a');
    h.join('b');
    h.send('a', { type: 'state', state: carState(0.5, 0) });
    expect(h.msgs('b', 'states')).toHaveLength(0);
    expect(h.core.room.players[0].progress).toBe(0);
  });

  it('checkpoint messages raise the checkpoint count', () => {
    const h = harness();
    startRace(h, ['a', 'b']);
    h.send('b', { type: 'checkpoint', index: 2, timeMs: 1234 });
    expect(h.core.room.players[1].checkpoint).toBe(3);
    expect(h.core.room.players[1].position).toBe(1);
    h.send('b', { type: 'checkpoint', index: 0, timeMs: 1300 });
    expect(h.core.room.players[1].checkpoint).toBe(3);
  });

  it('validates finish times, orders finishers, shortens the race for the rest, then DNFs them', () => {
    const h = harness();
    startRace(h, ['a', 'b', 'c']);
    const startedAt = h.core.room.raceStartedAt!;
    h.advance(30_000);
    h.send('b', { type: 'finish', timeMs: 29_500 });
    expect(h.core.room.players[1]).toMatchObject({ finished: true, finishTimeMs: 29_500, position: 1, progress: 1 });
    expect(h.last('a', 'playerFinished')).toEqual({ type: 'playerFinished', id: 'b', timeMs: 29_500, position: 1 });
    expect(h.core.room.raceEndsAt).toBe(h.now() + FINISH_GRACE_MS);
    expect(h.core.nextAlarmAt()).toBe(h.now() + FINISH_GRACE_MS);
    expect(h.core.room.phase).toBe('racing');
    // Out-of-range claims fall back to the server-measured elapsed time.
    h.advance(1_000);
    h.send('a', { type: 'finish', timeMs: 500 });
    expect(h.core.room.players[0].finishTimeMs).toBe(h.now() - startedAt);
    expect(h.core.room.players[0].position).toBe(2);
    // Duplicate finish is ignored.
    h.send('a', { type: 'finish', timeMs: 2000 });
    expect(h.core.room.players[0].finishTimeMs).toBe(h.now() - startedAt);
    // The grace alarm must not fire early...
    h.advance(FINISH_GRACE_MS - 1_001);
    expect(h.core.onAlarm()).toBeNull();
    expect(h.core.room.phase).toBe('racing');
    // ...and ends the race once it is due; c is DNF.
    h.advance(1);
    h.clear();
    h.core.onAlarm();
    expect(h.core.room.phase).toBe('results');
    const results = h.last('c', 'results');
    expect(results?.results).toEqual([
      { id: 'b', name: 'P_b', carColor: DEFAULT_CAR.paint, timeMs: 29_500, position: 1, dnf: false },
      { id: 'a', name: 'P_a', carColor: DEFAULT_CAR.paint, timeMs: 31_000, position: 2, dnf: false },
      { id: 'c', name: 'P_c', carColor: DEFAULT_CAR.paint, timeMs: null, position: 3, dnf: true },
    ]);
    expect(results?.room.phase).toBe('results');
    expect(h.core.room.players.map((p) => p.wins)).toEqual([0, 1, 0]);
    expect(h.core.room.players.map((p) => p.position)).toEqual([2, 1, 3]);
    expect(h.core.nextAlarmAt()).toBe(h.now() + RESULTS_AUTO_RETURN_MS);
    // Lobby messages are refused and finish is refused on results.
    h.send('c', { type: 'finish', timeMs: 40_000 });
    expect(h.last('c', 'error')?.message).toBe('Not racing');
  });

  it('ends the race immediately when everyone has finished', () => {
    const h = harness();
    startRace(h, ['a', 'b']);
    h.advance(20_000);
    h.send('a', { type: 'finish', timeMs: 20_000 });
    expect(h.core.room.phase).toBe('racing');
    h.advance(1_000);
    h.send('b', { type: 'finish', timeMs: 19_000 });
    expect(h.core.room.phase).toBe('results');
    expect(h.core.room.results?.map((r) => r.id)).toEqual(['b', 'a']);
    expect(h.core.room.players[1].wins).toBe(1);
  });

  it('DNFs everyone at the 10 minute limit (no wins awarded)', () => {
    const h = harness();
    startRace(h, ['a', 'b']);
    h.advance(RACE_TIME_LIMIT_MS);
    h.core.onAlarm();
    expect(h.core.room.phase).toBe('results');
    expect(h.core.room.results?.every((r) => r.dnf && r.timeMs === null)).toBe(true);
    expect(h.core.room.players.every((p) => p.wins === 0)).toBe(true);
  });
});

describe('RoomCore: results, rematch and auto-return', () => {
  it('rematch from any player returns to the lobby with everyone un-ready and round++', () => {
    const h = harness();
    startRace(h, ['a', 'b']);
    h.advance(10_000);
    h.send('a', { type: 'finish', timeMs: 10_000 });
    h.send('b', { type: 'finish', timeMs: 10_500 });
    expect(h.core.room.phase).toBe('results');
    h.send('b', { type: 'rematch' });
    expect(h.core.room).toMatchObject({ phase: 'lobby', round: 2, results: null, trackId: 'neon-sprint', raceStartedAt: null, raceEndsAt: null });
    expect(h.core.room.players.every((p) => !p.ready && !p.finished && p.finishTimeMs === null && p.progress === 0 && p.checkpoint === 0)).toBe(true);
    expect(h.core.room.players[0].wins).toBe(1); // wins persist across rounds
    expect(h.last('a', 'room')?.room.round).toBe(2);
    expect(h.core.nextAlarmAt()).toBeNull();
    h.send('a', { type: 'rematch' });
    expect(h.last('a', 'error')?.message).toMatch(/rematch/);
  });

  it('auto-returns to the lobby after 90 s on results', () => {
    const h = harness();
    startRace(h, ['a', 'b']);
    h.advance(10_000);
    h.send('a', { type: 'finish', timeMs: 10_000 });
    h.send('b', { type: 'finish', timeMs: 10_500 });
    h.advance(RESULTS_AUTO_RETURN_MS);
    h.core.onAlarm();
    expect(h.core.room.phase).toBe('lobby');
    expect(h.core.room.round).toBe(2);
  });
});

describe('RoomCore: leaving, host promotion and cleanup', () => {
  it('leave removes the player, closes the socket, promotes the next host', () => {
    const h = harness();
    h.join('a');
    h.join('b');
    h.join('c');
    h.clear();
    h.send('a', { type: 'leave' });
    expect(h.core.room.players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(h.core.room.hostId).toBe('b');
    expect(h.core.room.players[0].isHost).toBe(true);
    expect(h.core.room.players[1].isHost).toBe(false);
    expect(h.last('b', 'playerLeft')?.id).toBe('a');
    expect(h.last('c', 'room')?.room.hostId).toBe('b');
    expect(h.closed).toEqual([{ id: 'a', code: 1000, reason: 'Left room' }]);
    expect(h.msgs('a')).toHaveLength(0);
  });

  it('disconnect of a non-finished racer counts as DNF and can end the race', () => {
    const h = harness();
    startRace(h, ['a', 'b', 'c']);
    h.advance(15_000);
    h.send('a', { type: 'finish', timeMs: 15_000 });
    h.core.disconnect('c');
    expect(h.core.room.phase).toBe('racing');
    expect(h.last('b', 'playerLeft')?.id).toBe('c');
    h.core.disconnect('b');
    expect(h.core.room.phase).toBe('results');
    expect(h.core.room.results).toEqual([
      { id: 'a', name: 'P_a', carColor: DEFAULT_CAR.paint, timeMs: 15_000, position: 1, dnf: false },
    ]);
    // Disconnect of an unknown session is a no-op.
    h.core.disconnect('zzz');
    expect(h.core.room.players).toHaveLength(1);
  });

  it('starts the countdown if the remaining players are all ready after a leave', () => {
    const h = harness();
    h.join('a');
    h.join('b');
    h.join('c');
    h.send('a', { type: 'ready', ready: true });
    h.send('b', { type: 'ready', ready: true });
    expect(h.core.room.phase).toBe('lobby');
    h.core.disconnect('c');
    expect(h.core.room.phase).toBe('countdown');
  });

  it('an empty room resets to lobby and is destroyed after 10 minutes unless someone joins', () => {
    const h = harness();
    startRace(h, ['a']);
    h.core.disconnect('a');
    expect(h.core.room.players).toHaveLength(0);
    expect(h.core.room).toMatchObject({ phase: 'lobby', hostId: '', raceStartedAt: null });
    expect(h.core.nextAlarmAt()).toBe(h.now() + EMPTY_ROOM_TTL_MS);
    h.advance(EMPTY_ROOM_TTL_MS - 1);
    expect(h.core.onAlarm()).toBeNull();
    h.join('b');
    expect(h.core.nextAlarmAt()).toBeNull();
    expect(h.core.room.hostId).toBe('b');
    h.core.disconnect('b');
    h.advance(EMPTY_ROOM_TTL_MS);
    expect(h.core.onAlarm()).toBe('destroy');
  });
});

describe('RoomCore: chat, ping and parsing', () => {
  it('chat is cleaned, rate limited and broadcast to everyone including the sender', () => {
    const h = harness();
    h.join('a', 'Alice');
    h.join('b');
    h.clear();
    h.send('a', { type: 'chat', text: '  hello shit world  ' });
    expect(h.last('a', 'chat')).toEqual({ type: 'chat', from: 'a', name: 'Alice', text: 'hello **** world' });
    expect(h.last('b', 'chat')?.text).toBe('hello **** world');
    h.send('a', { type: 'chat', text: 'too fast' });
    expect(h.msgs('b', 'chat')).toHaveLength(1);
    h.advance(700);
    h.send('a', { type: 'chat', text: '   ' });
    expect(h.msgs('b', 'chat')).toHaveLength(1);
    h.send('a', { type: 'chat', text: 'ok now' });
    expect(h.msgs('b', 'chat')).toHaveLength(2);
  });

  it('parseClientMessage rejects malformed and unknown messages', () => {
    expect(parseClientMessage(null)).toEqual({ ok: false, error: expect.stringMatching(/Malformed/) });
    expect(parseClientMessage({})).toEqual({ ok: false, error: expect.stringMatching(/type/) });
    expect(parseClientMessage({ type: 'nope' })).toEqual({ ok: false, error: 'Unknown message type: nope' });
    expect(parseClientMessage({ type: 'selectTrack', trackId: 'x', trackSource: 'bad' }).ok).toBe(false);
    expect(parseClientMessage({ type: 'finish' }).ok).toBe(false);
    expect(parseClientMessage({ type: 'finish', timeMs: 12 })).toEqual({ ok: true, msg: { type: 'finish', timeMs: 12 } });
    expect(parseClientMessage({ type: 'ping', t: 5 })).toEqual({ ok: true, msg: { type: 'ping', t: 5 } });
    expect(parseClientMessage({ type: 'join', name: 'A' })).toEqual({ ok: true, msg: { type: 'join', name: 'A', car: undefined, playerId: null, token: null } });
  });

  it('handle never throws on hostile input', () => {
    const h = harness();
    h.join('a');
    expect(() => h.core.handle('a', { type: 'state', state: null as never })).not.toThrow();
    expect(() => h.core.handle('a', { type: 'weird' } as never)).not.toThrow();
    expect(h.last('a', 'error')?.message).toMatch(/Unknown message type/);
  });
});
