// Drives a live multiplayer race end to end: room lifecycle, track loading, synchronized
// countdown, 20 Hz state sync, remote cars, finishes and results.
import { LiveClient } from './net/liveClient';
import { generateRoomCode, NET_TICK_HZ, type RoomState, type RaceResultEntry } from '@shared/net';
import type { CarConfig } from '@shared/game/carConfig';
import { OFFICIAL_TRACK_MAP } from '@shared/track/officialTracks';
import type { TrackDefinition } from '@shared/track/types';
import { useStore } from './store';
import { tryGame } from './gameRef';
import { formatTime } from '@shared/math';
import { getAudio } from '@game/audio/audio';

export type LivePhase = 'idle' | 'connecting' | 'lobby' | 'countdown' | 'racing' | 'results';

export interface LiveState {
  phase: LivePhase;
  room: RoomState | null;
  results: RaceResultEntry[] | null;
  error: string | null;
  you: string | null;
  code: string;
  myFinish: number | null;
  loadingTrack: boolean;
}

type Listener = (s: LiveState) => void;

export class LiveSession {
  client = new LiveClient();
  state: LiveState = { phase: 'idle', room: null, results: null, error: null, you: null, code: '', myFinish: null, loadingTrack: false };
  private listeners: Listener[] = [];
  private tick: number | null = null;
  private loadedTrackId: string | null = null;
  private remoteIds = new Set<string>();
  private unsub: (() => void)[] = [];
  resolveTrack: (id: string, source: 'official' | 'community') => Promise<TrackDefinition | null> = async (id) => OFFICIAL_TRACK_MAP[id] ?? null;
  onRaceFinished: ((position: number, playerCount: number, timeMs: number | null) => void) | null = null;

  subscribe(l: Listener) { this.listeners.push(l); return () => { this.listeners = this.listeners.filter((x) => x !== l); }; }
  private set(patch: Partial<LiveState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(this.state); }

  async create(join: { name: string; car: CarConfig; playerId: string | null; token: string | null }) {
    return this.join(generateRoomCode(), join);
  }

  async join(code: string, join: { name: string; car: CarConfig; playerId: string | null; token: string | null }) {
    this.set({ phase: 'connecting', error: null, code: code.toUpperCase(), results: null, myFinish: null });
    this.wire();
    try {
      const room = await this.client.connect(code, join);
      this.set({ phase: room.phase === 'lobby' ? 'lobby' : 'lobby', room, you: this.client.you, code: room.code });
      getAudio().playSfx('lobbyJoin');
      void this.ensureTrack(room);
    } catch (e) {
      this.set({ phase: 'idle', error: (e as Error).message });
      this.unwire();
      throw e;
    }
  }

  leave() {
    this.stopTick();
    this.client.disconnect();
    this.unwire();
    const g = tryGame();
    g?.clearRemoteCars();
    this.remoteIds.clear();
    this.set({ phase: 'idle', room: null, results: null, you: null, myFinish: null });
  }

  private wire() {
    this.unwire();
    const c = this.client;
    this.unsub.push(c.on('room', (room) => this.onRoom(room)));
    this.unsub.push(c.on('countdown', (endsAt) => this.onCountdown(endsAt)));
    this.unsub.push(c.on('raceStart', () => { const g = tryGame(); if (g && g.race && g.race.state === 'countdown') { g.race.countdownSteps = Math.min(g.race.countdownSteps, 12); } }));
    this.unsub.push(c.on('states', (states) => {
      const g = tryGame(); if (!g) return;
      g.clockOffsetMs = Date.now() + c.offsetMs - performance.now();
      for (const s of states) { if (s.id === c.you) continue; if (!this.remoteIds.has(s.id)) this.addRemote(s.id); g.updateRemoteCar(s.id, { t: s.state.t, x: s.state.x, y: s.state.y, z: s.state.z, qx: s.state.qx, qy: s.state.qy, qz: s.state.qz, qw: s.state.qw, speed: s.state.s }); }
    }));
    this.unsub.push(c.on('playerFinished', (id, timeMs, position) => {
      const p = this.state.room?.players.find((x) => x.id === id);
      if (id !== c.you) useStore.getState().pushBanner({ text: `${p?.name ?? 'Racer'} finished ${ordinal(position)}`, sub: formatTime(timeMs), kind: 'info' });
    }));
    this.unsub.push(c.on('results', (results, room) => {
      this.stopTick();
      const g = tryGame();
      g?.endRace();
      const mine = results.find((r) => r.id === c.you);
      if (mine && mine.position === 1 && !mine.dnf) getAudio().playSfx('raceWin');
      this.set({ phase: 'results', results, room });
      if (mine) this.onRaceFinished?.(mine.position, results.length, mine.timeMs);
    }));
    this.unsub.push(c.on('playerLeft', (id) => { tryGame()?.removeRemoteCar(id); this.remoteIds.delete(id); }));
    this.unsub.push(c.on('error', (m) => { this.set({ error: m }); useStore.getState().pushBanner({ text: m, kind: 'warn' }); }));
    this.unsub.push(c.on('close', (reason) => { this.stopTick(); tryGame()?.clearRemoteCars(); this.remoteIds.clear(); this.set({ phase: 'idle', room: null, error: reason || 'Disconnected from room' }); }));
  }
  private unwire() { for (const u of this.unsub) u(); this.unsub = []; }

  private addRemote(id: string) {
    const g = tryGame(); const room = this.state.room;
    if (!g || !room) return;
    const p = room.players.find((x) => x.id === id);
    if (!p || p.id === this.client.you) return;
    g.addRemoteCar(p.id, p.car, p.name);
    this.remoteIds.add(id);
  }

  private async ensureTrack(room: RoomState) {
    const g = tryGame(); if (!g) return;
    if (this.loadedTrackId === room.trackId && g.trackDef?.id === room.trackId) return;
    this.set({ loadingTrack: true });
    const def = await this.resolveTrack(room.trackId, room.trackSource);
    if (def && g.trackDef?.id !== def.id) { await g.loadTrack(def); useStore.getState().setTrack(def); }
    if (def) this.loadedTrackId = def.id;
    this.set({ loadingTrack: false });
  }

  private onRoom(room: RoomState) {
    const prev = this.state.room;
    const wasResults = this.state.phase === 'results';
    this.set({ room, you: this.client.you, code: room.code });
    if (!prev || prev.trackId !== room.trackId) void this.ensureTrack(room);
    if (room.phase === 'lobby' && (wasResults || this.state.phase === 'connecting' || this.state.phase === 'racing' || this.state.phase === 'countdown')) {
      this.stopTick();
      const g = tryGame();
      g?.clearRemoteCars(); this.remoteIds.clear();
      g?.setSceneMode('menu');
      this.set({ phase: 'lobby', results: null, myFinish: null });
    }
    // sync remote car roster
    const g = tryGame();
    if (g && (room.phase === 'countdown' || room.phase === 'racing')) {
      for (const p of room.players) if (p.id !== this.client.you && p.connected && !this.remoteIds.has(p.id)) this.addRemote(p.id);
      for (const id of Array.from(this.remoteIds)) if (!room.players.some((p) => p.id === id && p.connected)) { g.removeRemoteCar(id); this.remoteIds.delete(id); }
    }
  }

  private async onCountdown(endsAt: number) {
    const g = tryGame(); const room = this.state.room;
    if (!g || !room) return;
    this.set({ phase: 'countdown', results: null, myFinish: null });
    await this.ensureTrack(room);
    const store = useStore.getState();
    g.raceMode = 'live';
    g.setCameraMode(store.settings.cameraMode);
    g.setGhost(null);
    g.setReferenceSplits(null);
    g.callbacks = {
      onCountdown: (n) => store.setCountdown(n, true),
      onStart: () => { store.setCountdown(0, true); setTimeout(() => store.setCountdown(0, false), 700); this.set({ phase: 'racing' }); this.startTick(); },
      onCheckpoint: (i, t, diff) => { this.client.checkpoint(i, t); store.pushBanner({ text: `Checkpoint ${i + 1}`, sub: diff != null ? formatTime(diff, true) : undefined, kind: 'checkpoint' }); },
      onFinish: (timeMs) => { this.client.finish(timeMs); this.set({ myFinish: timeMs }); store.pushBanner({ text: 'FINISHED!', sub: formatTime(timeMs), kind: 'pb' }); },
      onPause: () => { const p = !useStore.getState().paused; store.setPaused(p); /* live races never pause the sim */ g.input.enabled = !p; },
      onRestart: () => {},
    };
    for (const p of room.players) if (p.id !== this.client.you && p.connected && !this.remoteIds.has(p.id)) this.addRemote(p.id);
    const secs = Math.max(0.5, (endsAt - this.client.serverNow) / 1000);
    store.setResult(null); store.setPaused(false); g.setPaused(false);
    store.setScreen('race');
    g.startRace(secs);
  }

  private startTick() {
    this.stopTick();
    this.tick = window.setInterval(() => {
      const g = tryGame(); if (!g || !this.client.connected) return;
      const s = g.getNetState();
      this.client.sendState({ t: this.client.serverNow, x: s.x, y: s.y, z: s.z, qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw, s: s.speed, d: g.hud.drifting ? 1 : 0, b: g.hud.boost > 0 ? 1 : 0, cp: g.hud.checkpoint, p: g.hud.progress });
    }, 1000 / NET_TICK_HZ);
  }
  private stopTick() { if (this.tick != null) { clearInterval(this.tick); this.tick = null; } }
}

function ordinal(n: number) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

export const liveSession = new LiveSession();
