// Server-side plausibility validation of a submitted run against the compiled track.

import { decodeReplay, base64ToBytes, type Replay } from '../shared/game/replay';
import { vdist } from '../shared/math';
import type { SlimCompiled } from './trackdefs';

export const MAX_REPLAY_BYTES = 600 * 1024;
export const MAX_RUN_MS = 30 * 60 * 1000;
export const MAX_SPEED = 100;            // m/s, hard cap on any reported top speed
export const MIN_AVG_SPEED = 95;         // m/s, used for the "impossibly fast" check
export const TELEPORT_SPEED = 110;       // m/s

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface RunInput {
  timeMs: number;
  splits: number[];
  respawns: number;
  topSpeed: number;
}

const fail = (reason: string): ValidationResult => ({ ok: false, reason });

/** Decodes a base64 replay with a size cap. Returns a reason string on failure. */
export function decodeReplayBase64(b64: string): { replay: Replay; bytes: Uint8Array } | { error: string } {
  if (typeof b64 !== 'string' || b64.length === 0) return { error: 'Missing replay' };
  if (b64.length > Math.ceil(MAX_REPLAY_BYTES / 3) * 4 + 8) return { error: 'Replay too large' };
  let bytes: Uint8Array;
  try { bytes = base64ToBytes(b64); } catch { return { error: 'Replay is not valid base64' }; }
  if (bytes.length > MAX_REPLAY_BYTES) return { error: 'Replay too large' };
  if (bytes.length < 20) return { error: 'Replay too short' };
  try {
    const replay = decodeReplay(bytes);
    const expectedBytes = 20 + replay.splits.length * 4 + replay.frameCount * 20;
    if (expectedBytes !== bytes.length) return { error: 'Replay length mismatch' };
    return { replay, bytes };
  } catch (e) {
    return { error: `Replay decode failed: ${(e as Error).message}` };
  }
}

export function validateRun(compiled: SlimCompiled, replay: Replay, input: RunInput): ValidationResult {
  const { timeMs, splits, respawns, topSpeed } = input;
  if (!Number.isFinite(timeMs) || timeMs <= 0) return fail('Invalid time');
  if (timeMs > MAX_RUN_MS) return fail('Run longer than 30 minutes');
  const minMs = (compiled.length / MIN_AVG_SPEED) * 1000 * 0.8;
  if (timeMs < minMs) return fail('Time is impossibly fast for this track');
  if (!Number.isFinite(topSpeed) || topSpeed < 0 || topSpeed > MAX_SPEED) return fail('Implausible top speed');

  // splits: strictly increasing, last one equals the finish time
  if (!Array.isArray(splits) || splits.length === 0) return fail('Missing splits');
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    if (!Number.isFinite(s) || s < 0) return fail('Invalid split');
    if (i > 0 && s <= splits[i - 1]) return fail('Splits are not increasing');
  }
  if (Math.abs(splits[splits.length - 1] - timeMs) > 2) return fail('Final split does not match the finish time');

  // replay header
  const hz = replay.hz;
  if (!Number.isFinite(hz) || hz < 10 || hz > 120) return fail('Unsupported replay sample rate');
  const n = replay.frameCount;
  if (n < 2 || replay.frames.length < n * 7) return fail('Replay has too few frames');
  const expectedFrames = (timeMs / 1000) * hz;
  if (Math.abs(n - expectedFrames) > expectedFrames * 0.15 + 3) return fail('Replay length does not match the finish time');

  const fr = replay.frames;
  const posAt = (i: number) => ({ x: fr[i * 7], y: fr[i * 7 + 1], z: fr[i * 7 + 2] });
  for (let i = 0; i < n * 7; i++) if (!Number.isFinite(fr[i])) return fail('Replay contains invalid values');

  // start / finish proximity
  if (vdist(posAt(0), compiled.start.pos) > 12) return fail('Replay does not start at the start line');
  const finish = compiled.checkpoints[compiled.checkpoints.length - 1];
  if (!finish) return fail('Track has no finish line');
  if (vdist(posAt(n - 1), finish.pos) > 25) return fail('Replay does not end at the finish line');

  // teleports (respawns are allowed, plus a little slack)
  const maxStep = TELEPORT_SPEED * (1 / hz) * 1.6;
  let teleports = 0;
  let prev = posAt(0);
  for (let i = 1; i < n; i++) {
    const cur = posAt(i);
    if (vdist(prev, cur) > maxStep) teleports++;
    prev = cur;
  }
  const allowedTeleports = Math.max(0, Math.floor(respawns)) + 2;
  if (teleports > allowedTeleports) return fail(`Replay has ${teleports} teleports (max ${allowedTeleports})`);

  // checkpoints in order: for each gate there must be a frame within 18 m, with increasing frame indices
  let from = 0;
  for (let c = 0; c < compiled.checkpoints.length; c++) {
    const gate = compiled.checkpoints[c];
    let hit = -1;
    for (let i = from; i < n; i++) {
      if (vdist(posAt(i), gate.pos) <= 18) { hit = i; break; }
    }
    if (hit < 0) return fail(gate.kind === 'finish' ? 'Replay never reaches the finish line' : `Checkpoint ${c + 1} was skipped`);
    from = hit + 1;
  }

  return { ok: true };
}
