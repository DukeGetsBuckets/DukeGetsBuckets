// Local (offline) persistence: personal bests and best-run replays per track.
import { encodeReplay, decodeReplay, bytesToBase64, base64ToBytes, type Replay } from '@shared/game/replay';

const BESTS_KEY = 'neonrush.bests.v1';
const REPLAY_PREFIX = 'neonrush.replay.';
const NAME_KEY = 'neonrush.name.v1';

export function loadBests(): Record<string, number> { try { return JSON.parse(localStorage.getItem(BESTS_KEY) || '{}'); } catch { return {}; } }
export function saveBests(b: Record<string, number>) { try { localStorage.setItem(BESTS_KEY, JSON.stringify(b)); } catch { /* quota */ } }

export function saveLocalReplay(trackId: string, replay: Replay) {
  try { localStorage.setItem(REPLAY_PREFIX + trackId, bytesToBase64(encodeReplay(replay))); } catch { /* quota exceeded: ignore */ }
}
export function loadLocalReplay(trackId: string): Replay | null {
  try { const b64 = localStorage.getItem(REPLAY_PREFIX + trackId); return b64 ? decodeReplay(base64ToBytes(b64)) : null; } catch { return null; }
}

export function loadLocalName(): string | null { try { return localStorage.getItem(NAME_KEY); } catch { return null; } }
export function saveLocalName(n: string) { try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } }

export function medalFor(timeMs: number, medals: { author: number; gold: number; silver: number; bronze: number }) {
  return timeMs <= medals.author ? 'author' : timeMs <= medals.gold ? 'gold' : timeMs <= medals.silver ? 'silver' : timeMs <= medals.bronze ? 'bronze' : null;
}
