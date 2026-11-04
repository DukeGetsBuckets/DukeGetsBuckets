// Compact replay format shared by client (recording / ghosts) and server (validation).
// Frames are sampled at a fixed rate: position (3 x float32) + rotation quaternion (4 x int16).

export const REPLAY_HZ = 30;
export const REPLAY_VERSION = 1;

export interface Replay {
  version: number;
  hz: number;
  timeMs: number;
  frameCount: number;
  /** 7 floats per frame: x y z qx qy qz qw */
  frames: Float32Array;
  splits: number[]; // checkpoint times incl. finish
}

export function encodeReplay(r: Replay): Uint8Array {
  const headerSize = 4 + 4 + 4 + 4 + 4 + r.splits.length * 4;
  const frameBytes = r.frameCount * (12 + 8);
  const buf = new ArrayBuffer(headerSize + frameBytes);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, r.version, true); o += 4;
  dv.setUint32(o, r.hz, true); o += 4;
  dv.setUint32(o, r.timeMs, true); o += 4;
  dv.setUint32(o, r.frameCount, true); o += 4;
  dv.setUint32(o, r.splits.length, true); o += 4;
  for (const s of r.splits) { dv.setUint32(o, s, true); o += 4; }
  for (let i = 0; i < r.frameCount; i++) {
    const b = i * 7;
    dv.setFloat32(o, r.frames[b], true); o += 4;
    dv.setFloat32(o, r.frames[b + 1], true); o += 4;
    dv.setFloat32(o, r.frames[b + 2], true); o += 4;
    for (let k = 3; k < 7; k++) { dv.setInt16(o, Math.round(Math.max(-1, Math.min(1, r.frames[b + k])) * 32767), true); o += 2; }
  }
  return new Uint8Array(buf);
}

export function decodeReplay(bytes: Uint8Array): Replay {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const version = dv.getUint32(o, true); o += 4;
  const hz = dv.getUint32(o, true); o += 4;
  const timeMs = dv.getUint32(o, true); o += 4;
  const frameCount = dv.getUint32(o, true); o += 4;
  const nSplits = dv.getUint32(o, true); o += 4;
  if (nSplits > 1000 || frameCount > 200000) throw new Error('replay too large');
  const splits: number[] = [];
  for (let i = 0; i < nSplits; i++) { splits.push(dv.getUint32(o, true)); o += 4; }
  const frames = new Float32Array(frameCount * 7);
  for (let i = 0; i < frameCount; i++) {
    const b = i * 7;
    frames[b] = dv.getFloat32(o, true); o += 4;
    frames[b + 1] = dv.getFloat32(o, true); o += 4;
    frames[b + 2] = dv.getFloat32(o, true); o += 4;
    for (let k = 3; k < 7; k++) { frames[b + k] = dv.getInt16(o, true) / 32767; o += 2; }
  }
  return { version, hz, timeMs, frameCount, frames, splits };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  return btoa(s);
}
export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Interpolated pose at time t (ms). */
export function sampleReplay(r: Replay, tMs: number, out: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }) {
  const f = (tMs / 1000) * r.hz;
  const i0 = Math.max(0, Math.min(r.frameCount - 1, Math.floor(f)));
  const i1 = Math.min(r.frameCount - 1, i0 + 1);
  const a = Math.max(0, Math.min(1, f - i0));
  const b0 = i0 * 7, b1 = i1 * 7;
  const fr = r.frames;
  out.x = fr[b0] + (fr[b1] - fr[b0]) * a;
  out.y = fr[b0 + 1] + (fr[b1 + 1] - fr[b0 + 1]) * a;
  out.z = fr[b0 + 2] + (fr[b1 + 2] - fr[b0 + 2]) * a;
  // slerp-ish (nlerp is fine for small deltas)
  let qx0 = fr[b0 + 3], qy0 = fr[b0 + 4], qz0 = fr[b0 + 5], qw0 = fr[b0 + 6];
  const qx1 = fr[b1 + 3], qy1 = fr[b1 + 4], qz1 = fr[b1 + 5], qw1 = fr[b1 + 6];
  if (qx0 * qx1 + qy0 * qy1 + qz0 * qz1 + qw0 * qw1 < 0) { qx0 = -qx0; qy0 = -qy0; qz0 = -qz0; qw0 = -qw0; }
  let x = qx0 + (qx1 - qx0) * a, y = qy0 + (qy1 - qy0) * a, z = qz0 + (qz1 - qz0) * a, w = qw0 + (qw1 - qw0) * a;
  const l = Math.hypot(x, y, z, w) || 1;
  out.qx = x / l; out.qy = y / l; out.qz = z / l; out.qw = w / l;
}
