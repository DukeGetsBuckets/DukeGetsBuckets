// Durable Object: a live multiplayer race room.
//
// Structure
//   RoomCore  - the room state machine. It has no Cloudflare dependencies: it is given a clock
//               (`now()`) and a message sink, so it is unit-testable in plain Node
//               (see tests/room.test.ts).
//   RaceRoom  - the Durable Object adapter: Hibernatable WebSockets, storage persistence
//               (keys `room` and `meta`) and alarms for timed transitions.
//
// Protocol: shared/net.ts.  Room codes come from the URL (`/ws/room/<CODE>`, routed with
// `idFromName(code)` in worker/index.ts); the DO reads the code on first use and persists it.
import { MAX_ROOM_PLAYERS } from '../shared/net';
import type { ClientMessage, NetCarState, RaceResultEntry, RoomPlayer, RoomState, ServerMessage } from '../shared/net';
import { sanitizeCarConfig, type CarConfig } from '../shared/game/carConfig';
import { cleanChat, sanitizeName, NAME_MAX } from '../shared/game/names';

/* ------------------------------------------------------------------------------------------ */
/* Tunables                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const COUNTDOWN_MS = 5_000;
export const RACE_TIME_LIMIT_MS = 10 * 60_000;
export const FINISH_GRACE_MS = 60_000;             // time the others get once the first player finishes
export const RESULTS_AUTO_RETURN_MS = 90_000;      // results -> lobby if nobody rematches
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;      // storage wiped if the room stays empty this long
export const DEFAULT_TRACK_ID = 'neon-sprint';     // first official track (shared/track/officialTracks.ts)
export const JOIN_REJECT_CLOSE_CODE = 4001;

const STATE_RATE_PER_SEC = 30;                     // per-connection cap on `state` messages
const CHAT_MIN_INTERVAL_MS = 700;
const POSITIONS_BROADCAST_MIN_INTERVAL_MS = 250;   // max 4 position-only `room` broadcasts per second
const FINISH_TOLERANCE_MS = 2_000;
const MAX_TRACK_ID_LEN = 64;
const MAX_PLAYER_ID_LEN = 64;

/* ------------------------------------------------------------------------------------------ */
/* Core state machine                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Timers that are not part of the public RoomState but must survive hibernation. */
export interface RoomMeta {
  resultsEndsAt: number | null;  // when the results screen auto-returns to the lobby
  emptySince: number | null;     // when the last player left (cleanup timer)
}

/** Where RoomCore delivers messages. Ids are per-connection session ids. */
export interface RoomSink {
  send(id: string, msg: ServerMessage): void;
  broadcast(ids: string[], msg: ServerMessage): void;
  close(id: string, code: number, reason: string): void;
  log?(level: 'info' | 'warn' | 'error', ...args: unknown[]): void;
}

export type ParsedClientMessage = { ok: true; msg: ClientMessage } | { ok: false; error: string };

const CLIENT_TYPES = new Set(['join', 'ready', 'selectTrack', 'start', 'state', 'checkpoint', 'finish', 'rematch', 'leave', 'ping', 'chat']);

/** Validates the shape of a decoded client message (field types only; semantics are checked by RoomCore). */
export function parseClientMessage(raw: unknown): ParsedClientMessage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Malformed message' };
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== 'string') return { ok: false, error: 'Malformed message: missing type' };
  if (!CLIENT_TYPES.has(m.type)) return { ok: false, error: `Unknown message type: ${m.type.slice(0, 32)}` };
  const bad = (what: string): ParsedClientMessage => ({ ok: false, error: `Malformed ${m.type} message: ${what}` });
  switch (m.type) {
    case 'join':
      return { ok: true, msg: { type: 'join', name: typeof m.name === 'string' ? m.name : '', car: m.car as CarConfig, playerId: typeof m.playerId === 'string' ? m.playerId : null, token: typeof m.token === 'string' ? m.token : null } };
    case 'ready':
      return { ok: true, msg: { type: 'ready', ready: !!m.ready } };
    case 'selectTrack':
      if (typeof m.trackId !== 'string') return bad('trackId must be a string');
      if (m.trackSource !== 'official' && m.trackSource !== 'community') return bad('trackSource must be official or community');
      return { ok: true, msg: { type: 'selectTrack', trackId: m.trackId, trackSource: m.trackSource } };
    case 'start': return { ok: true, msg: { type: 'start' } };
    case 'rematch': return { ok: true, msg: { type: 'rematch' } };
    case 'leave': return { ok: true, msg: { type: 'leave' } };
    case 'state':
      if (!m.state || typeof m.state !== 'object') return bad('state must be an object');
      return { ok: true, msg: { type: 'state', state: m.state as NetCarState } };
    case 'checkpoint':
      if (typeof m.index !== 'number') return bad('index must be a number');
      return { ok: true, msg: { type: 'checkpoint', index: m.index, timeMs: typeof m.timeMs === 'number' ? m.timeMs : 0 } };
    case 'finish':
      if (typeof m.timeMs !== 'number') return bad('timeMs must be a number');
      return { ok: true, msg: { type: 'finish', timeMs: m.timeMs } };
    case 'ping':
      return { ok: true, msg: { type: 'ping', t: typeof m.t === 'number' ? m.t : 0 } };
    case 'chat':
      if (typeof m.text !== 'string') return bad('text must be a string');
      return { ok: true, msg: { type: 'chat', text: m.text } };
    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Returns a clean copy of a client car state or null if it is unusable. `t` is left for the caller. */
export function sanitizeCarState(raw: unknown): NetCarState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const x = finiteNum(o.x), y = finiteNum(o.y), z = finiteNum(o.z);
  const qx = finiteNum(o.qx), qy = finiteNum(o.qy), qz = finiteNum(o.qz), qw = finiteNum(o.qw);
  if (x === null || y === null || z === null || qx === null || qy === null || qz === null || qw === null) return null;
  const s = finiteNum(o.s) ?? 0;
  const cp = finiteNum(o.cp) ?? 0;
  const p = finiteNum(o.p) ?? 0;
  return {
    t: 0, x, y, z, qx, qy, qz, qw,
    s,
    d: o.d ? 1 : 0,
    b: o.b ? 1 : 0,
    cp: Math.max(0, Math.floor(cp)),
    p: Math.min(1, Math.max(0, p)),
  };
}

/** Race ordering: finishers first (fastest first), then by checkpoint desc, then progress desc; ties keep join order. */
function compareRaceOrder(a: RoomPlayer, b: RoomPlayer): number {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished && b.finished) return (a.finishTimeMs ?? Infinity) - (b.finishTimeMs ?? Infinity);
  if (a.checkpoint !== b.checkpoint) return b.checkpoint - a.checkpoint;
  return b.progress - a.progress;
}

interface PlayerRuntime {
  car: NetCarState | null;   // latest relayed state (not persisted)
  tokens: number;            // state-message token bucket
  lastRefillAt: number;
  lastChatAt: number;
}

type JoinMessage = Extract<ClientMessage, { type: 'join' }>;
type SelectTrackMessage = Extract<ClientMessage, { type: 'selectTrack' }>;
type CheckpointMessage = Extract<ClientMessage, { type: 'checkpoint' }>;

export class RoomCore {
  readonly room: RoomState;
  readonly meta: RoomMeta;
  /** Set whenever the persisted state (room/meta) changed; the adapter clears it after saving. */
  dirty = false;

  private readonly runtime = new Map<string, PlayerRuntime>();
  private positionsDirty = false;
  private lastRoomBroadcastAt = -Infinity;

  constructor(
    room: RoomState,
    meta: RoomMeta | null | undefined,
    private readonly sink: RoomSink,
    private readonly now: () => number,
    private readonly rng: () => number = Math.random,
  ) {
    this.room = room;
    this.meta = meta ?? RoomCore.createMeta();
    if (this.room.players.length === 0 && this.meta.emptySince === null) this.meta.emptySince = this.now();
    for (const p of this.room.players) this.runtime.set(p.id, this.newRuntime());
  }

  static createRoom(code: string): RoomState {
    return {
      code, phase: 'lobby', trackId: DEFAULT_TRACK_ID, trackSource: 'official', players: [], hostId: '',
      countdownEndsAt: null, raceStartedAt: null, raceEndsAt: null, results: null, round: 1,
    };
  }

  static createMeta(): RoomMeta {
    return { resultsEndsAt: null, emptySince: null };
  }

  /* ---- queries ------------------------------------------------------------------------- */

  player(id: string): RoomPlayer | undefined {
    return this.room.players.find((p) => p.id === id);
  }

  /** Latest car state relayed for a player (transient). */
  carState(id: string): NetCarState | null {
    return this.runtime.get(id)?.car ?? null;
  }

  info(): { code: string; phase: RoomState['phase']; players: number; trackId: string } {
    return { code: this.room.code, phase: this.room.phase, players: this.room.players.length, trackId: this.room.trackId };
  }

  /** When the adapter should next call `onAlarm()`, or null if nothing is pending. */
  nextAlarmAt(): number | null {
    const r = this.room;
    if (r.players.length === 0) return (this.meta.emptySince ?? this.now()) + EMPTY_ROOM_TTL_MS;
    switch (r.phase) {
      case 'countdown': return r.countdownEndsAt;
      case 'racing': return r.raceEndsAt;
      case 'results': return this.meta.resultsEndsAt;
      default: return null;
    }
  }

  /* ---- entry points -------------------------------------------------------------------- */

  /** Handles one validated message from connection `id`. Never throws. */
  handle(id: string, msg: ClientMessage): void {
    try {
      this.dispatch(id, msg);
    } catch (err) {
      this.log('error', 'room handler failed', msg.type, err);
      this.error(id, 'Internal error');
    }
  }

  /** The connection went away (close or error). Safe to call for connections that never joined. */
  disconnect(id: string): void {
    try {
      this.removePlayer(id);
    } catch (err) {
      this.log('error', 'room disconnect failed', err);
    }
  }

  /** Runs every timed transition that is due. Returns 'destroy' when the room storage should be wiped. */
  onAlarm(): 'destroy' | null {
    try {
      for (let guard = 0; guard < 4; guard++) {
        const now = this.now();
        const r = this.room;
        if (r.players.length === 0) {
          return now >= (this.meta.emptySince ?? now) + EMPTY_ROOM_TTL_MS ? 'destroy' : null;
        }
        if (r.phase === 'countdown' && r.countdownEndsAt !== null && now >= r.countdownEndsAt) { this.beginRace(); continue; }
        if (r.phase === 'racing' && r.raceEndsAt !== null && now >= r.raceEndsAt) { this.endRace(); continue; }
        if (r.phase === 'results' && this.meta.resultsEndsAt !== null && now >= this.meta.resultsEndsAt) { this.returnToLobby(); continue; }
        break;
      }
    } catch (err) {
      this.log('error', 'room alarm failed', err);
    }
    return null;
  }

  /* ---- dispatch ------------------------------------------------------------------------ */

  private dispatch(id: string, msg: ClientMessage): void {
    const player = this.player(id);
    if (!player) {
      if (msg.type === 'join') this.join(id, msg);
      else if (msg.type === 'ping') this.sink.send(id, { type: 'pong', t: msg.t, serverTime: this.now() });
      else this.error(id, 'Send a join message first');
      return;
    }
    switch (msg.type) {
      case 'join': this.error(id, 'Already joined'); break;
      case 'ready': this.setReady(player, msg.ready); break;
      case 'selectTrack': this.selectTrack(player, msg); break;
      case 'start': this.requestStart(player); break;
      case 'state': this.onState(player, msg.state); break;
      case 'checkpoint': this.onCheckpoint(player, msg); break;
      case 'finish': this.onFinish(player, msg.timeMs); break;
      case 'rematch': this.onRematch(player); break;
      case 'leave': this.onLeave(player); break;
      case 'ping': this.sink.send(id, { type: 'pong', t: msg.t, serverTime: this.now() }); break;
      case 'chat': this.onChat(player, msg.text); break;
      default: this.error(id, `Unknown message type: ${String((msg as { type?: unknown }).type)}`);
    }
  }

  /* ---- lobby --------------------------------------------------------------------------- */

  private join(id: string, msg: JoinMessage): void {
    const r = this.room;
    if (r.phase === 'countdown' || r.phase === 'racing') { this.reject(id, 'Race in progress — wait for the lobby'); return; }
    if (r.players.length >= MAX_ROOM_PLAYERS) { this.reject(id, 'Room is full'); return; }
    const name = this.uniqueName(sanitizeName(msg.name) ?? this.fallbackName());
    const car = sanitizeCarConfig(msg.car);
    const playerId = typeof msg.playerId === 'string' && msg.playerId.length > 0 && msg.playerId.length <= MAX_PLAYER_ID_LEN ? msg.playerId : null;
    // Note: `token` is not verified here (the DO has no account access); playerId is informational.
    const isHost = r.players.length === 0;
    const player: RoomPlayer = {
      id, playerId, name, car, ready: false, isHost, finished: false, finishTimeMs: null,
      position: r.players.length + 1, progress: 0, checkpoint: 0, connected: true, wins: 0,
    };
    r.players.push(player);
    if (isHost) r.hostId = id;
    this.runtime.set(id, this.newRuntime());
    this.meta.emptySince = null;
    this.dirty = true;
    this.sink.send(id, { type: 'welcome', you: id, room: r, serverTime: this.now() });
    this.broadcastRoom();
  }

  private setReady(player: RoomPlayer, ready: boolean): void {
    if (this.room.phase !== 'lobby') { this.error(player.id, 'Not in the lobby'); return; }
    player.ready = !!ready;
    this.dirty = true;
    if (this.allReady()) this.beginCountdown();
    else this.broadcastRoom();
  }

  private selectTrack(player: RoomPlayer, msg: SelectTrackMessage): void {
    if (this.room.phase !== 'lobby') { this.error(player.id, 'Not in the lobby'); return; }
    if (!player.isHost) { this.error(player.id, 'Only the host can select the track'); return; }
    const trackId = msg.trackId.trim();
    if (!trackId || trackId.length > MAX_TRACK_ID_LEN) { this.error(player.id, 'Invalid track id'); return; }
    if (msg.trackSource !== 'official' && msg.trackSource !== 'community') { this.error(player.id, 'Invalid track source'); return; }
    this.room.trackId = trackId;
    this.room.trackSource = msg.trackSource;
    this.dirty = true;
    this.broadcastRoom();
  }

  private requestStart(player: RoomPlayer): void {
    if (this.room.phase !== 'lobby') { this.error(player.id, 'Not in the lobby'); return; }
    if (player.isHost || this.allReady()) this.beginCountdown();
    else this.error(player.id, 'Only the host can start the race');
  }

  private allReady(): boolean {
    const ps = this.room.players;
    return ps.length >= 2 && ps.every((p) => p.ready);
  }

  /* ---- race transitions ---------------------------------------------------------------- */

  private beginCountdown(): void {
    const r = this.room;
    const now = this.now();
    r.phase = 'countdown';
    r.countdownEndsAt = now + COUNTDOWN_MS;
    r.raceStartedAt = null;
    r.raceEndsAt = null;
    r.results = null;
    this.resetRaceFields();
    this.meta.resultsEndsAt = null;
    this.dirty = true;
    this.broadcastAll({ type: 'countdown', endsAt: r.countdownEndsAt, serverTime: now });
    this.broadcastRoom();
  }

  private beginRace(): void {
    const r = this.room;
    r.phase = 'racing';
    r.raceStartedAt = r.countdownEndsAt ?? this.now();
    r.raceEndsAt = r.raceStartedAt + RACE_TIME_LIMIT_MS;
    r.countdownEndsAt = null;
    this.dirty = true;
    this.broadcastAll({ type: 'raceStart', startedAt: r.raceStartedAt });
    this.broadcastRoom();
  }

  private endRace(): void {
    const r = this.room;
    const ranking = [...r.players].sort(compareRaceOrder);
    ranking.forEach((p, i) => { p.position = i + 1; });
    r.results = ranking.map<RaceResultEntry>((p, i) => ({
      id: p.id, name: p.name, carColor: p.car.paint,
      timeMs: p.finished ? p.finishTimeMs : null, position: i + 1, dnf: !p.finished,
    }));
    const winner = ranking[0];
    if (winner && winner.finished) winner.wins += 1;
    r.phase = 'results';
    this.meta.resultsEndsAt = this.now() + RESULTS_AUTO_RETURN_MS;
    this.dirty = true;
    this.broadcastAll({ type: 'results', results: r.results, room: r });
  }

  private returnToLobby(): void {
    const r = this.room;
    r.phase = 'lobby';
    r.round += 1;
    r.countdownEndsAt = null;
    r.raceStartedAt = null;
    r.raceEndsAt = null;
    r.results = null;
    for (const p of r.players) p.ready = false;
    this.resetRaceFields();
    this.meta.resultsEndsAt = null;
    this.dirty = true;
    this.broadcastRoom();
  }

  private resetRaceFields(): void {
    this.room.players.forEach((p, i) => {
      p.finished = false;
      p.finishTimeMs = null;
      p.position = i + 1;
      p.progress = 0;
      p.checkpoint = 0;
    });
    for (const rt of this.runtime.values()) rt.car = null;
    this.positionsDirty = false;
  }

  /* ---- racing -------------------------------------------------------------------------- */

  private onState(player: RoomPlayer, raw: NetCarState): void {
    const r = this.room;
    if (r.phase !== 'racing' && r.phase !== 'countdown') return;
    const rt = this.runtime.get(player.id);
    if (!rt) return;
    const now = this.now();
    // Token bucket: STATE_RATE_PER_SEC per second, burst up to one second's worth.
    rt.tokens = Math.min(STATE_RATE_PER_SEC, rt.tokens + ((now - rt.lastRefillAt) * STATE_RATE_PER_SEC) / 1000);
    rt.lastRefillAt = now;
    if (rt.tokens < 1) return;
    rt.tokens -= 1;

    const state = sanitizeCarState(raw);
    if (!state) return;
    state.t = now;
    rt.car = state;
    if (!player.finished) {
      player.progress = state.p;
      player.checkpoint = state.cp;
    }
    const others = r.players.filter((p) => p.id !== player.id).map((p) => p.id);
    if (others.length) this.sink.broadcast(others, { type: 'states', serverTime: now, states: [{ id: player.id, state }] });
    if (r.phase === 'racing') {
      if (this.recomputePositions()) this.positionsDirty = true;
      this.flushPositions(now);
    }
  }

  private onCheckpoint(player: RoomPlayer, msg: CheckpointMessage): void {
    if (this.room.phase !== 'racing') return;
    if (player.finished) return;
    if (!Number.isFinite(msg.index) || msg.index < 0 || msg.index > 10_000) return;
    // `index` is the 0-based checkpoint just passed, so the passed count is index + 1 (matches NetCarState.cp).
    player.checkpoint = Math.max(player.checkpoint, Math.floor(msg.index) + 1);
    this.dirty = true;
    if (this.recomputePositions()) this.positionsDirty = true;
    this.flushPositions(this.now());
  }

  private onFinish(player: RoomPlayer, timeMs: number): void {
    const r = this.room;
    if (r.phase !== 'racing') { this.error(player.id, 'Not racing'); return; }
    if (player.finished) return;
    const now = this.now();
    const elapsed = Math.max(1, now - (r.raceStartedAt ?? now));
    let t = Number(timeMs);
    if (!Number.isFinite(t) || t < 1000 || t > elapsed + FINISH_TOLERANCE_MS) t = elapsed;
    t = Math.round(t);
    player.finished = true;
    player.finishTimeMs = t;
    player.progress = 1;
    this.recomputePositions();
    const finishedCount = r.players.filter((p) => p.finished).length;
    if (finishedCount === 1) r.raceEndsAt = Math.min(r.raceEndsAt ?? Infinity, now + FINISH_GRACE_MS);
    this.dirty = true;
    this.broadcastAll({ type: 'playerFinished', id: player.id, timeMs: t, position: player.position });
    if (r.players.every((p) => p.finished)) this.endRace();
    else this.broadcastRoom();
  }

  /** Returns true if any player's position changed. */
  private recomputePositions(): boolean {
    const sorted = [...this.room.players].sort(compareRaceOrder);
    let changed = false;
    sorted.forEach((p, i) => {
      if (p.position !== i + 1) { p.position = i + 1; changed = true; }
    });
    return changed;
  }

  private flushPositions(now: number): void {
    if (this.positionsDirty && now - this.lastRoomBroadcastAt >= POSITIONS_BROADCAST_MIN_INTERVAL_MS) this.broadcastRoom();
  }

  /* ---- results / leaving / chat -------------------------------------------------------- */

  private onRematch(player: RoomPlayer): void {
    if (this.room.phase !== 'results') { this.error(player.id, 'No finished race to rematch'); return; }
    this.returnToLobby();
  }

  private onLeave(player: RoomPlayer): void {
    const id = player.id;
    this.removePlayer(id);
    this.sink.close(id, 1000, 'Left room');
  }

  private removePlayer(id: string): void {
    const r = this.room;
    const idx = r.players.findIndex((p) => p.id === id);
    this.runtime.delete(id);
    if (idx < 0) return;
    r.players.splice(idx, 1);
    this.dirty = true;
    const now = this.now();
    if (r.players.length === 0) {
      // Empty room: back to a fresh lobby (track/round/wins are moot) and start the cleanup timer.
      r.hostId = '';
      r.phase = 'lobby';
      r.countdownEndsAt = null;
      r.raceStartedAt = null;
      r.raceEndsAt = null;
      r.results = null;
      this.meta.resultsEndsAt = null;
      this.meta.emptySince = now;
      this.positionsDirty = false;
      return;
    }
    if (r.hostId === id) {
      r.hostId = r.players[0].id;
      for (const p of r.players) p.isHost = p.id === r.hostId;
    }
    this.broadcastAll({ type: 'playerLeft', id });
    if (r.phase === 'racing') {
      this.recomputePositions();
      if (r.players.every((p) => p.finished)) { this.endRace(); return; }
    } else if (r.phase === 'lobby' && this.allReady()) {
      this.beginCountdown();
      return;
    }
    this.broadcastRoom();
  }

  private onChat(player: RoomPlayer, text: string): void {
    const rt = this.runtime.get(player.id);
    if (!rt) return;
    const now = this.now();
    if (now - rt.lastChatAt < CHAT_MIN_INTERVAL_MS) return;
    const clean = cleanChat(text);
    if (!clean) return;
    rt.lastChatAt = now;
    this.broadcastAll({ type: 'chat', from: player.id, name: player.name, text: clean });
  }

  /* ---- helpers ------------------------------------------------------------------------- */

  private reject(id: string, message: string): void {
    this.error(id, message);
    this.sink.close(id, JOIN_REJECT_CLOSE_CODE, message);
  }

  private error(id: string, message: string): void {
    this.sink.send(id, { type: 'error', message });
  }

  private broadcastAll(msg: ServerMessage): void {
    const ids = this.room.players.map((p) => p.id);
    if (ids.length) this.sink.broadcast(ids, msg);
  }

  private broadcastRoom(): void {
    this.lastRoomBroadcastAt = this.now();
    this.positionsDirty = false;
    this.broadcastAll({ type: 'room', room: this.room });
  }

  private fallbackName(): string {
    return 'Racer' + String(Math.floor(this.rng() * 10_000)).padStart(4, '0');
  }

  /** Avoids two players sharing a display name (appends _2, _3, ... within the name length limit). */
  private uniqueName(name: string): string {
    const taken = new Set(this.room.players.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 100; n++) {
      const suffix = `_${n}`;
      const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  private newRuntime(): PlayerRuntime {
    return { car: null, tokens: STATE_RATE_PER_SEC, lastRefillAt: this.now(), lastChatAt: -Infinity };
  }

  private log(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
    this.sink.log?.(level, ...args);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Durable Object adapter                                                                      */
/* ------------------------------------------------------------------------------------------ */

interface SocketAttachment {
  id: string;      // session id (also the socket's tag)
  code: string;    // room code from the URL, so a cold start can rebuild the room
  joined: boolean;
}

const STORAGE_ROOM_KEY = 'room';
const STORAGE_META_KEY = 'meta';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export class RaceRoom implements DurableObject {
  private core: RoomCore | null = null;
  private loading: Promise<RoomCore> | null = null;
  /** The alarm time currently set in storage (undefined until loaded). */
  private alarmAt: number | null | undefined = undefined;

  constructor(private readonly state: DurableObjectState, private readonly env: unknown) {
    void this.env;
    try {
      // Lets clients keep connections alive with a raw "ping" frame without waking the object.
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    } catch (err) {
      console.warn('RaceRoom: setWebSocketAutoResponse failed', err);
    }
  }

  /* ---- HTTP entry ---------------------------------------------------------------------- */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = (url.pathname.split('/')[3] ?? '').toUpperCase();
    const core = await this.load(code);

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      if (request.method === 'GET' && url.searchParams.has('info')) return jsonResponse(core.info());
      return new Response('Expected websocket', { status: 426, headers: { 'Upgrade': 'websocket' } });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const id = crypto.randomUUID();
    this.state.acceptWebSocket(server, [id]);
    const attachment: SocketAttachment = { id, code: core.room.code, joined: false };
    server.serializeAttachment(attachment);
    await this.afterEvent(core);
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---- Hibernatable WebSocket handlers ------------------------------------------------- */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const att = this.attachment(ws);
      if (!att) { this.safeClose(ws, 4000, 'Unknown session'); return; }
      const core = await this.load(att.code);
      if (typeof message !== 'string') { this.sendRaw(ws, { type: 'error', message: 'Binary messages are not supported' }); return; }
      let decoded: unknown;
      try {
        decoded = JSON.parse(message);
      } catch {
        this.sendRaw(ws, { type: 'error', message: 'Malformed JSON' });
        return;
      }
      const parsed = parseClientMessage(decoded);
      if (!parsed.ok) { this.sendRaw(ws, { type: 'error', message: parsed.error }); return; }
      if (!att.joined && parsed.msg.type !== 'join' && parsed.msg.type !== 'ping') {
        this.sendRaw(ws, { type: 'error', message: 'Send a join message first' });
        return;
      }
      core.handle(att.id, parsed.msg);
      if (!att.joined && core.player(att.id)) {
        att.joined = true;
        ws.serializeAttachment(att);
      }
      await this.afterEvent(core);
    } catch (err) {
      console.error('RaceRoom.webSocketMessage failed', err);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    try {
      void wasClean;
      const att = this.attachment(ws);
      if (att) {
        const core = await this.load(att.code);
        core.disconnect(att.id);
        await this.afterEvent(core);
      }
      this.safeClose(ws, code, reason);
    } catch (err) {
      console.error('RaceRoom.webSocketClose failed', err);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    try {
      console.warn('RaceRoom websocket error', error);
      const att = this.attachment(ws);
      if (att) {
        const core = await this.load(att.code);
        core.disconnect(att.id);
        await this.afterEvent(core);
      }
      this.safeClose(ws, 1011, 'Socket error');
    } catch (err) {
      console.error('RaceRoom.webSocketError failed', err);
    }
  }

  async alarm(): Promise<void> {
    try {
      const core = await this.load();
      this.alarmAt = null; // the alarm that just fired is consumed
      const result = core.onAlarm();
      if (result === 'destroy') {
        await this.state.storage.deleteAlarm();
        await this.state.storage.deleteAll();
        this.core = null;
        this.alarmAt = null;
        return;
      }
      await this.afterEvent(core);
    } catch (err) {
      console.error('RaceRoom.alarm failed', err);
    }
  }

  /* ---- state loading / persistence ----------------------------------------------------- */

  private load(code?: string): Promise<RoomCore> {
    if (this.core) return Promise.resolve(this.core);
    if (!this.loading) {
      this.loading = (async () => {
        const storage = this.state.storage;
        const [stored, meta, alarm] = await Promise.all([
          storage.get<RoomState>(STORAGE_ROOM_KEY),
          storage.get<RoomMeta>(STORAGE_META_KEY),
          storage.getAlarm(),
        ]);
        this.alarmAt = alarm;
        const room = stored ?? RoomCore.createRoom(code || this.codeFromSockets() || 'ROOM');
        const core = new RoomCore(room, meta ?? null, this.sink, () => Date.now());
        this.core = core;
        return core;
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  /** After a cold start with no stored room, recover the code from an attached socket if any. */
  private codeFromSockets(): string | null {
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      if (att?.code) return att.code;
    }
    return null;
  }

  private async afterEvent(core: RoomCore): Promise<void> {
    if (core.dirty) {
      core.dirty = false;
      await this.state.storage.put({ [STORAGE_ROOM_KEY]: core.room, [STORAGE_META_KEY]: core.meta });
    }
    const want = core.nextAlarmAt();
    if (want !== this.alarmAt) {
      if (want === null) await this.state.storage.deleteAlarm();
      else await this.state.storage.setAlarm(want);
      this.alarmAt = want;
    }
  }

  /* ---- socket plumbing ----------------------------------------------------------------- */

  private readonly sink: RoomSink = {
    send: (id, msg) => {
      const text = JSON.stringify(msg);
      for (const ws of this.state.getWebSockets(id)) this.sendText(ws, text);
    },
    broadcast: (ids, msg) => {
      const text = JSON.stringify(msg);
      for (const id of ids) for (const ws of this.state.getWebSockets(id)) this.sendText(ws, text);
    },
    close: (id, code, reason) => {
      for (const ws of this.state.getWebSockets(id)) this.safeClose(ws, code, reason);
    },
    log: (level, ...args) => {
      if (level === 'error') console.error('RaceRoom', ...args);
      else if (level === 'warn') console.warn('RaceRoom', ...args);
      else console.log('RaceRoom', ...args);
    },
  };

  private attachment(ws: WebSocket): SocketAttachment | null {
    try {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      return att && typeof att.id === 'string' ? att : null;
    } catch {
      return null;
    }
  }

  private sendRaw(ws: WebSocket, msg: ServerMessage): void {
    this.sendText(ws, JSON.stringify(msg));
  }

  private sendText(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch (err) {
      console.warn('RaceRoom send failed', err);
    }
  }

  private safeClose(ws: WebSocket, code: number, reason: string): void {
    const valid = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    try {
      ws.close(valid, reason.slice(0, 120));
    } catch {
      /* already closed */
    }
  }
}
