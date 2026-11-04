// WebSocket client for live multiplayer rooms (talks to the RaceRoom Durable Object).
import type { ClientMessage, ServerMessage, RoomState, NetCarState, RaceResultEntry } from '@shared/net';
import type { CarConfig } from '@shared/game/carConfig';

type Handlers = {
  room: (room: RoomState) => void;
  countdown: (endsAt: number) => void;
  raceStart: (startedAt: number) => void;
  states: (states: { id: string; state: NetCarState }[]) => void;
  playerFinished: (id: string, timeMs: number, position: number) => void;
  results: (results: RaceResultEntry[], room: RoomState) => void;
  playerLeft: (id: string) => void;
  chat: (from: string, name: string, text: string) => void;
  error: (message: string) => void;
  close: (reason: string) => void;
};

export class LiveClient {
  private ws: WebSocket | null = null;
  private handlers: Record<string, ((...args: never[]) => void)[]> = {};
  room: RoomState | null = null;
  you: string | null = null;
  code = '';
  /** serverTime - Date.now() */
  offsetMs = 0;
  rttMs = 0;
  private pingTimer: number | null = null;
  private closedByUser = false;

  on<K extends keyof Handlers>(ev: K, fn: Handlers[K]) {
    const list = (this.handlers[ev] ??= []);
    list.push(fn as (...args: never[]) => void);
    return () => { this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== (fn as unknown)); };
  }
  private emit<K extends keyof Handlers>(ev: K, ...args: Parameters<Handlers[K]>) {
    for (const fn of this.handlers[ev] ?? []) (fn as unknown as (...a: unknown[]) => void)(...args);
  }

  get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  get serverNow() { return Date.now() + this.offsetMs; }
  get me() { return this.room?.players.find((p) => p.id === this.you) ?? null; }
  get isHost() { return !!this.room && this.room.hostId === this.you; }

  static async roomInfo(code: string): Promise<{ code: string; phase: string; players: number; trackId: string } | null> {
    try {
      const r = await fetch(`/ws/room/${encodeURIComponent(code)}?info=1`);
      if (!r.ok) return null;
      return (await r.json()) as { code: string; phase: string; players: number; trackId: string };
    } catch { return null; }
  }

  connect(code: string, join: { name: string; car: CarConfig; playerId: string | null; token: string | null }): Promise<RoomState> {
    this.disconnect();
    this.closedByUser = false;
    this.code = code.toUpperCase();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/room/${this.code}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      this.ws = ws;
      const timeout = window.setTimeout(() => { if (!settled) { settled = true; reject(new Error('Connection timed out')); ws.close(); } }, 12000);
      ws.onopen = () => { this.send({ type: 'join', name: join.name, car: join.car, playerId: join.playerId, token: join.token }); };
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try { msg = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
        this.handle(msg);
        if (msg.type === 'welcome' && !settled) { settled = true; clearTimeout(timeout); resolve(msg.room); this.startPing(); }
        if (msg.type === 'error' && !settled) { settled = true; clearTimeout(timeout); reject(new Error(msg.message)); }
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('Could not connect to the room')); } };
      ws.onclose = (ev) => {
        this.stopPing();
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(ev.reason || 'Connection closed')); }
        if (!this.closedByUser) this.emit('close', ev.reason || 'Disconnected');
        this.ws = null;
      };
    });
  }

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case 'welcome': this.you = msg.you; this.room = msg.room; this.offsetMs = msg.serverTime - Date.now(); this.emit('room', msg.room); break;
      case 'room': this.room = msg.room; this.emit('room', msg.room); break;
      case 'countdown': this.offsetMs = msg.serverTime - Date.now() + this.rttMs / 2; this.emit('countdown', msg.endsAt); break;
      case 'raceStart': this.emit('raceStart', msg.startedAt); break;
      case 'states': this.emit('states', msg.states); break;
      case 'playerFinished': this.emit('playerFinished', msg.id, msg.timeMs, msg.position); break;
      case 'results': this.room = msg.room; this.emit('results', msg.results, msg.room); break;
      case 'playerLeft': this.emit('playerLeft', msg.id); break;
      case 'pong': { const now = Date.now(); this.rttMs = now - msg.t; this.offsetMs = msg.serverTime - (msg.t + this.rttMs / 2); break; }
      case 'chat': this.emit('chat', msg.from, msg.name, msg.text); break;
      case 'error': this.emit('error', msg.message); break;
    }
  }

  private startPing() {
    this.stopPing();
    const ping = () => this.send({ type: 'ping', t: Date.now() });
    ping();
    this.pingTimer = window.setInterval(ping, 2500);
  }
  private stopPing() { if (this.pingTimer != null) { clearInterval(this.pingTimer); this.pingTimer = null; } }

  send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  setReady(ready: boolean) { this.send({ type: 'ready', ready }); }
  selectTrack(trackId: string, trackSource: 'official' | 'community') { this.send({ type: 'selectTrack', trackId, trackSource }); }
  start() { this.send({ type: 'start' }); }
  sendState(state: NetCarState) { this.send({ type: 'state', state }); }
  checkpoint(index: number, timeMs: number) { this.send({ type: 'checkpoint', index, timeMs }); }
  finish(timeMs: number) { this.send({ type: 'finish', timeMs }); }
  rematch() { this.send({ type: 'rematch' }); }
  chat(text: string) { this.send({ type: 'chat', text }); }

  disconnect() {
    this.closedByUser = true;
    this.stopPing();
    if (this.ws) { try { this.send({ type: 'leave' }); this.ws.close(1000, 'leave'); } catch { /* ignore */ } }
    this.ws = null;
    this.room = null;
    this.you = null;
  }
}
