// Minimal vector/quaternion helpers shared by the game client and the Worker.
// Plain objects so they interoperate with both three.js and Rapier without copies.

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vclone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const vadd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vdot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const vlen = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const vdist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const vnorm = (a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 1, z: 0 };
};
export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export const vmadd = (a: Vec3, b: Vec3, s: number): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });

/** Rotate a vector around the Y axis by `rad` radians (counter-clockwise seen from above). */
export function rotY(a: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: a.x * c + a.z * s, y: a.y, z: -a.x * s + a.z * c };
}

export function rotYQuarter(a: Vec3, quarter: number): Vec3 {
  const q = ((quarter % 4) + 4) % 4;
  switch (q) {
    case 0: return vclone(a);
    case 1: return { x: a.z, y: a.y, z: -a.x };
    case 2: return { x: -a.x, y: a.y, z: -a.z };
    default: return { x: -a.z, y: a.y, z: a.x };
  }
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (t: number): number => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
export const smootherstep = (t: number): number => { const x = clamp(t, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); };
/** Frame-rate independent exponential damping factor. */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

export function quatFromAxisAngle(axis: Vec3, rad: number): Quat {
  const h = rad / 2, s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // v' = q * v * q^-1
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

/** Build a quaternion from an orthonormal basis (right, up, forward) as matrix columns. */
export function quatFromBasis(right: Vec3, up: Vec3, forward: Vec3): Quat {
  // Columns of rotation matrix: X axis = right, Y axis = up, Z axis = forward
  const m00 = right.x, m01 = up.x, m02 = forward.x;
  const m10 = right.y, m11 = up.y, m12 = forward.y;
  const m20 = right.z, m21 = up.z, m22 = forward.z;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return { x, y, z, w };
}

/** Quaternion with local +Z = forward and local +Y = up (car / track convention; right = forward x up). */
export function quatLookUp(forward: Vec3, up: Vec3): Quat {
  const f = vnorm(forward);
  let r = vcross(f, up);
  if (vlen(r) < 1e-6) r = vcross(f, { x: 1, y: 0, z: 0 });
  r = vnorm(r);
  const u = vcross(r, f);
  // local X axis must map to "left" (= -right) because right = forward x up in our convention
  return quatFromBasis(vscale(r, -1), u, f);
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic seeded PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatTime(ms: number, showSign = false): string {
  const sign = ms < 0 ? '-' : showSign ? '+' : '';
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  const millis = Math.floor(abs % 1000);
  const mm = minutes > 0 ? `${minutes}:` : '';
  const ss = minutes > 0 ? String(seconds).padStart(2, '0') : String(seconds);
  return `${sign}${mm}${ss}.${String(millis).padStart(3, '0')}`;
}
