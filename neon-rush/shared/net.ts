// WebSocket protocol for live multiplayer rooms (RaceRoom Durable Object).
import type { CarConfig } from './game/carConfig';

export const NET_TICK_HZ = 20;          // client state send rate
export const MAX_ROOM_PLAYERS = 8;

export type RoomPhase = 'lobby' | 'countdown' | 'racing' | 'results';

export interface RoomPlayer {
  id: string;             // session id within the room
  playerId: string | null; // account id if authenticated
  name: string;
  car: CarConfig;
  ready: boolean;
  isHost: boolean;
  finished: boolean;
  finishTimeMs: number | null;
  position: number;       // live race position (1-based)
  progress: number;       // 0..1 track progress
  checkpoint: number;
  connected: boolean;
  wins: number;           // wins in this room
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  trackId: string;        // official id or community id
  trackSource: 'official' | 'community';
  players: RoomPlayer[];
  hostId: string;
  countdownEndsAt: number | null;  // server time ms
  raceStartedAt: number | null;    // server time ms
  raceEndsAt: number | null;       // server time ms (time limit after first finisher)
  results: RaceResultEntry[] | null;
  round: number;
}

export interface RaceResultEntry { id: string; name: string; carColor: string; timeMs: number | null; position: number; dnf: boolean }

export interface NetCarState {
  t: number;      // server time ms (client stamps with its estimate; server overrides)
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  s: number;      // speed m/s
  d: 0 | 1;       // drifting
  b: 0 | 1;       // boosting
  cp: number;     // checkpoints passed
  p: number;      // progress 0..1
}

/* client -> server */
export type ClientMessage =
  | { type: 'join'; name: string; car: CarConfig; playerId: string | null; token: string | null }
  | { type: 'ready'; ready: boolean }
  | { type: 'selectTrack'; trackId: string; trackSource: 'official' | 'community' }
  | { type: 'start' }                    // host force-start (or vote when all ready)
  | { type: 'state'; state: NetCarState }
  | { type: 'checkpoint'; index: number; timeMs: number }
  | { type: 'finish'; timeMs: number }
  | { type: 'rematch' }
  | { type: 'leave' }
  | { type: 'ping'; t: number }
  | { type: 'chat'; text: string };

/* server -> client */
export type ServerMessage =
  | { type: 'welcome'; you: string; room: RoomState; serverTime: number }
  | { type: 'room'; room: RoomState }
  | { type: 'countdown'; endsAt: number; serverTime: number }
  | { type: 'raceStart'; startedAt: number }
  | { type: 'states'; serverTime: number; states: { id: string; state: NetCarState }[] }
  | { type: 'playerFinished'; id: string; timeMs: number; position: number }
  | { type: 'results'; results: RaceResultEntry[]; room: RoomState }
  | { type: 'playerLeft'; id: string }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'chat'; from: string; name: string; text: string }
  | { type: 'error'; message: string };

export function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 6; i++) s += alphabet[arr[i] % alphabet.length];
  return s;
}
