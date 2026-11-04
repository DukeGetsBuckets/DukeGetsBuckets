// Modular track piece library.
// Every piece is defined in its own local space: entry at the origin, heading +Z, up +Y.
// "Left" is +X (a +1 quarter-turn rotates the heading from +Z toward +X).
// The compiler sweeps a cross-section profile along each piece's centerline.

import { Vec3, v3, smoothstep } from '../math';

export const CELL = 24;          // grid cell size in meters
export const ROAD_HALF = 7;      // half road width (14 m wide road)
export const HEIGHT_STEP = 8;    // standard elevation change of a 1-cell slope

export type StripKind = 'road' | 'wall' | 'wallride' | 'tunnel' | 'boost';
export interface Strip { kind: StripKind; pts: [number, number][]; smooth?: boolean }

export interface CurveSample { pos: Vec3; up: Vec3 }
export interface LocalGate { kind: 'start' | 'checkpoint' | 'finish'; t: number }
export interface LocalDecor { kind: 'ring' | 'arch' | 'pylon'; t: number }

export type PieceCategory = 'road' | 'turn' | 'elevation' | 'stunt' | 'tunnel' | 'gate' | 'gap';

export interface PieceDef {
  id: string;
  name: string;
  category: PieceCategory;
  /** approximate centerline length in meters */
  length: number;
  /** exit cursor in local space (meters) and quarter-turn delta */
  exit: { x: number; y: number; z: number; rot: number };
  curve: (t: number) => CurveSample;
  /** cross-section strips (road + optional wall/wallride/tunnel). */
  profile: (walls: boolean) => Strip[];
  gates?: LocalGate[];
  decor?: LocalDecor[];
  /** boost zone as [t0, t1] along the piece */
  boost?: [number, number];
  /** no geometry: advances the cursor only (jump gaps) */
  gap?: boolean;
  /** suggested segment step in meters (smaller = smoother) */
  step?: number;
  /** piece uses its own twisting up-vector; do not re-level */
  twisted?: boolean;
  /** approximate bounding half-width for footprint/overlap checks */
  halfWidth?: number;
}

const UP = v3(0, 1, 0);

/* ---------- profile builders ---------- */

export function roadStrip(half = ROAD_HALF): Strip {
  return { kind: 'road', pts: [[-half, 0], [half, 0]] };
}
export function wallStrips(half = ROAD_HALF, height = 2.4): Strip[] {
  const x = half + 0.9;
  return [
    { kind: 'wall', pts: [[-x, height], [-x, 0]] },
    { kind: 'wall', pts: [[x, 0], [x, height]] },
  ];
}
function basicProfile(half = ROAD_HALF) {
  return (walls: boolean): Strip[] => (walls ? [roadStrip(half), ...wallStrips(half)] : [roadStrip(half)]);
}
function boostProfile(walls: boolean): Strip[] {
  return walls ? [roadStrip(), ...wallStrips()] : [roadStrip()];
}
function wallrideProfile(side: 1 | -1) {
  // quarter pipe on the left (+1) or right (-1) side, radius 15, tangent to the road edge
  const R = 15;
  const pts: [number, number][] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    pts.push([side * (ROAD_HALF + R * Math.sin(a)), R - R * Math.cos(a)]);
  }
  if (side < 0) pts.reverse();
  return (walls: boolean): Strip[] => {
    const strips: Strip[] = [roadStrip(), { kind: 'wallride', pts, smooth: true }];
    if (walls) {
      const x = ROAD_HALF + 0.9;
      strips.push(side > 0 ? { kind: 'wall', pts: [[-x, 2.4], [-x, 0]] } : { kind: 'wall', pts: [[x, 0], [x, 2.4]] });
    }
    return strips;
  };
}
function tunnelProfile(_walls: boolean): Strip[] {
  const R = 9.5, base = 3;
  const pts: [number, number][] = [[R, 0], [R, base]];
  const steps = 14;
  for (let i = 1; i < steps; i++) {
    const a = (i / steps) * Math.PI;
    pts.push([R * Math.cos(a), base + R * Math.sin(a) * 0.85]);
  }
  pts.push([-R, base], [-R, 0]);
  return [roadStrip(), { kind: 'tunnel', pts, smooth: true }];
}

/* ---------- curve builders ---------- */

function straightCurve(len: number, yAt?: (t: number) => number) {
  return (t: number): CurveSample => ({ pos: v3(0, yAt ? yAt(t) : 0, len * t), up: UP });
}

/**
 * Circular arc of `radius` turning `dir` (+1 left / -1 right) through `angle` radians.
 * Optional bank (radians) and rise (meters, applied with smoothstep).
 */
function arcCurve(radius: number, angle: number, dir: 1 | -1, bank = 0, rise = 0) {
  return (t: number): CurveSample => {
    const a = angle * t;
    const x = dir * (radius - radius * Math.cos(a));
    const z = radius * Math.sin(a);
    const y = rise !== 0 ? rise * smoothstep(t) : 0;
    let up = UP;
    if (bank !== 0) {
      // ease the banking in and out
      const w = Math.sin(Math.PI * t);
      const b = bank * w;
      // tangent direction (horizontal)
      const tx = dir * Math.sin(a), tz = Math.cos(a);
      // right = tangent x up (world up) = (tz, 0, -tx) for tangent (tx,0,tz)
      const rx = -tz, rz = tx; // tangent x (0,1,0) = (tz*... computed: (ty*0 - tz*1, tz*0 - tx*0, tx*1 - ty*0) = (-tz, 0, tx)
      // banked up = cos(b) U - dir sin(b) R
      up = v3(-dir * Math.sin(b) * rx, Math.cos(b), -dir * Math.sin(b) * rz);
    }
    return { pos: v3(x, y, z), up };
  };
}

function chicaneCurve(len: number, shift: number) {
  return (t: number): CurveSample => ({ pos: v3(shift * smoothstep(t), 0, len * t), up: UP });
}

function loopCurve(dir: 1 | -1) {
  // 48 m long: 24 m lead-in, vertical circle of radius 18 shifting 1 cell sideways (eased), 24 m lead-out
  const R = 18, lead = 24, total = 48;
  const circLen = 2 * Math.PI * R;
  const L = lead + circLen + (total - lead);
  return (t: number): CurveSample => {
    const s = t * L;
    if (s < lead) return { pos: v3(0, 0, s), up: UP };
    if (s < lead + circLen) {
      const k = (s - lead) / circLen;
      const th = k * Math.PI * 2;
      const x = dir * CELL * smoothstep(k);
      const y = R - R * Math.cos(th);
      const z = lead + R * Math.sin(th);
      // up points to circle center (x, R, lead)
      const up = v3(0, (R - y) / R, (lead - z) / R);
      return { pos: v3(x, y, z), up };
    }
    const s2 = s - lead - circLen;
    return { pos: v3(dir * CELL, 0, lead + s2), up: UP };
  };
}

function corkscrewCurve(dir: 1 | -1) {
  // 144 m long: eased full barrel roll around a helix of radius 8 (tangent-continuous at both ends)
  const r = 8, lead = 10, len = CELL * 6, helixLen = len - 2 * lead;
  return (t: number): CurveSample => {
    const z = t * len;
    if (z < lead || z > len - lead) return { pos: v3(0, 0, z), up: UP };
    const k = (z - lead) / helixLen;
    const th = smoothstep(k) * Math.PI * 2;
    const x = dir * r * Math.sin(th);
    const y = r - r * Math.cos(th);
    const up = v3(-dir * Math.sin(th), Math.cos(th), 0);
    return { pos: v3(x, y, z), up };
  };
}

function kickerCurve(len: number, h: number) {
  // y = h * t^2 -> ramp ending with a nose-up angle
  return (t: number): CurveSample => ({ pos: v3(0, h * t * t, len * t), up: UP });
}

function hillCurve(len: number, h: number) {
  return (t: number): CurveSample => ({ pos: v3(0, h * Math.sin(Math.PI * t) ** 2, len * t), up: UP });
}

/* ---------- piece table ---------- */

const R1 = CELL / 2, R2 = CELL * 1.5, R3 = CELL * 2.5;
const Q = Math.PI / 2;
const deg = (d: number) => (d * Math.PI) / 180;

function straight(id: string, name: string, len: number, extra: Partial<PieceDef> = {}): PieceDef {
  return {
    id, name, category: 'road', length: len,
    exit: { x: 0, y: 0, z: len, rot: 0 },
    curve: straightCurve(len),
    profile: basicProfile(),
    step: 6,
    ...extra,
  };
}

function turn(id: string, name: string, radius: number, dir: 1 | -1, extra: Partial<PieceDef> = {}): PieceDef {
  return {
    id, name, category: 'turn', length: radius * Q,
    exit: { x: dir * radius, y: 0, z: radius, rot: dir },
    curve: arcCurve(radius, Q, dir),
    profile: basicProfile(),
    step: 1.5,
    ...extra,
  };
}

function slope(id: string, name: string, len: number, dy: number): PieceDef {
  return {
    id, name, category: 'elevation', length: Math.hypot(len, dy),
    exit: { x: 0, y: dy, z: len, rot: 0 },
    curve: straightCurve(len, (t) => dy * smoothstep(t)),
    profile: basicProfile(),
    step: 1.5,
  };
}

function gapPiece(id: string, name: string, len: number, dy: number): PieceDef {
  return {
    id, name, category: 'gap', length: Math.hypot(len, dy), exit: { x: 0, y: dy, z: len, rot: 0 },
    curve: (t) => ({ pos: v3(0, dy * t, len * t), up: UP }), profile: () => [], gap: true, step: 6,
  };
}

const list: PieceDef[] = [
  // ---- gates ----
  straight('start', 'Start Line', CELL, { category: 'gate', gates: [{ kind: 'start', t: 0.5 }] }),
  straight('checkpoint', 'Checkpoint', CELL, { category: 'gate', gates: [{ kind: 'checkpoint', t: 0.5 }] }),
  straight('finish', 'Finish Line', CELL, { category: 'gate', gates: [{ kind: 'finish', t: 0.5 }] }),

  // ---- roads ----
  straight('straight', 'Straight', CELL),
  straight('straight2', 'Long Straight', CELL * 2),
  straight('boost', 'Boost Pad', CELL, { boost: [0.2, 0.8], profile: boostProfile }),
  straight('narrow', 'Narrow Road', CELL, { profile: basicProfile(4), halfWidth: 4 }),
  straight('wide', 'Wide Road', CELL * 2, { profile: basicProfile(13), halfWidth: 13 }),
  straight('landing', 'Landing Zone', CELL * 3, { profile: basicProfile(14), halfWidth: 14 }),
  straight('ring', 'Energy Ring', CELL, { decor: [{ kind: 'ring', t: 0.5 }] }),
  straight('arch', 'Neon Arch', CELL, { decor: [{ kind: 'arch', t: 0.5 }] }),
  {
    id: 'chicaneL', name: 'Chicane Left', category: 'turn', length: CELL * 2.2,
    exit: { x: CELL, y: 0, z: CELL * 2, rot: 0 }, curve: chicaneCurve(CELL * 2, CELL), profile: basicProfile(), step: 1.5,
  },
  {
    id: 'chicaneR', name: 'Chicane Right', category: 'turn', length: CELL * 2.2,
    exit: { x: -CELL, y: 0, z: CELL * 2, rot: 0 }, curve: chicaneCurve(CELL * 2, -CELL), profile: basicProfile(), step: 1.5,
  },

  // ---- turns ----
  turn('curveL1', 'Tight Left', R1, 1),
  turn('curveR1', 'Tight Right', R1, -1),
  turn('curveL2', 'Curve Left', R2, 1),
  turn('curveR2', 'Curve Right', R2, -1),
  turn('curveL3', 'Sweeper Left', R3, 1),
  turn('curveR3', 'Sweeper Right', R3, -1),
  turn('bankL2', 'Banked Left', R2, 1, { curve: arcCurve(R2, Q, 1, deg(38)), name: 'Banked Left' }),
  turn('bankR2', 'Banked Right', R2, -1, { curve: arcCurve(R2, Q, -1, deg(38)) }),
  turn('bankL3', 'Banked Sweeper L', R3, 1, { curve: arcCurve(R3, Q, 1, deg(32)) }),
  turn('bankR3', 'Banked Sweeper R', R3, -1, { curve: arcCurve(R3, Q, -1, deg(32)) }),
  {
    id: 'hairpinL', name: 'Hairpin Left', category: 'turn', length: R1 * Math.PI,
    exit: { x: 2 * R1, y: 0, z: 0, rot: 2 }, curve: arcCurve(R1, Math.PI, 1), profile: basicProfile(), step: 1.2,
  },
  {
    id: 'hairpinR', name: 'Hairpin Right', category: 'turn', length: R1 * Math.PI,
    exit: { x: -2 * R1, y: 0, z: 0, rot: -2 }, curve: arcCurve(R1, Math.PI, -1), profile: basicProfile(), step: 1.2,
  },
  {
    id: 'hairpinL2', name: 'Wide Hairpin Left', category: 'turn', length: R2 * Math.PI,
    exit: { x: 2 * R2, y: 0, z: 0, rot: 2 }, curve: arcCurve(R2, Math.PI, 1, deg(28)), profile: basicProfile(), step: 1.5,
  },
  {
    id: 'hairpinR2', name: 'Wide Hairpin Right', category: 'turn', length: R2 * Math.PI,
    exit: { x: -2 * R2, y: 0, z: 0, rot: -2 }, curve: arcCurve(R2, Math.PI, -1, deg(28)), profile: basicProfile(), step: 1.5,
  },

  // ---- elevation ----
  slope('slopeUp1', 'Slope Up', CELL, HEIGHT_STEP),
  slope('slopeDown1', 'Slope Down', CELL, -HEIGHT_STEP),
  slope('slopeUp2', 'Long Slope Up', CELL * 2, HEIGHT_STEP * 2),
  slope('slopeDown2', 'Long Slope Down', CELL * 2, -HEIGHT_STEP * 2),
  slope('climb', 'Steep Climb', CELL * 2, HEIGHT_STEP * 4),
  slope('plunge', 'Plunge', CELL * 2, -HEIGHT_STEP * 4),
  {
    id: 'hill', name: 'Hill Jump', category: 'elevation', length: CELL * 2.1,
    exit: { x: 0, y: 0, z: CELL * 2, rot: 0 }, curve: hillCurve(CELL * 2, 7), profile: basicProfile(), step: 1.5,
  },
  turn('curveUpL2', 'Spiral Up Left', R2, 1, { category: 'elevation', curve: arcCurve(R2, Q, 1, 0, HEIGHT_STEP * 2), exit: { x: R2, y: HEIGHT_STEP * 2, z: R2, rot: 1 } }),
  turn('curveUpR2', 'Spiral Up Right', R2, -1, { category: 'elevation', curve: arcCurve(R2, Q, -1, 0, HEIGHT_STEP * 2), exit: { x: -R2, y: HEIGHT_STEP * 2, z: R2, rot: -1 } }),
  turn('curveDownL2', 'Spiral Down Left', R2, 1, { category: 'elevation', curve: arcCurve(R2, Q, 1, 0, -HEIGHT_STEP * 2), exit: { x: R2, y: -HEIGHT_STEP * 2, z: R2, rot: 1 } }),
  turn('curveDownR2', 'Spiral Down Right', R2, -1, { category: 'elevation', curve: arcCurve(R2, Q, -1, 0, -HEIGHT_STEP * 2), exit: { x: -R2, y: -HEIGHT_STEP * 2, z: R2, rot: -1 } }),

  // ---- stunts ----
  {
    id: 'loopL', name: 'Loop (left exit)', category: 'stunt', length: 48 + 2 * Math.PI * 18,
    exit: { x: CELL, y: 0, z: CELL * 2, rot: 0 }, curve: loopCurve(1), profile: basicProfile(), step: 1.2, twisted: true,
  },
  {
    id: 'loopR', name: 'Loop (right exit)', category: 'stunt', length: 48 + 2 * Math.PI * 18,
    exit: { x: -CELL, y: 0, z: CELL * 2, rot: 0 }, curve: loopCurve(-1), profile: basicProfile(), step: 1.2, twisted: true,
  },
  {
    id: 'corkscrewL', name: 'Corkscrew Left', category: 'stunt', length: 160,
    exit: { x: 0, y: 0, z: CELL * 6, rot: 0 }, curve: corkscrewCurve(1), profile: basicProfile(), step: 1.0, twisted: true,
  },
  {
    id: 'corkscrewR', name: 'Corkscrew Right', category: 'stunt', length: 160,
    exit: { x: 0, y: 0, z: CELL * 6, rot: 0 }, curve: corkscrewCurve(-1), profile: basicProfile(), step: 1.0, twisted: true,
  },
  {
    id: 'kicker', name: 'Jump Ramp', category: 'stunt', length: CELL,
    exit: { x: 0, y: 4, z: CELL, rot: 0 }, curve: kickerCurve(CELL, 4), profile: basicProfile(), step: 1.5,
  },
  {
    id: 'kickerBig', name: 'Big Jump Ramp', category: 'stunt', length: CELL * 2,
    exit: { x: 0, y: 7, z: CELL * 2, rot: 0 }, curve: kickerCurve(CELL * 2, 7), profile: basicProfile(), step: 1.5,
  },
  {
    id: 'wallrideL', name: 'Wall Ride Left', category: 'stunt', length: CELL * 2,
    exit: { x: 0, y: 0, z: CELL * 2, rot: 0 }, curve: straightCurve(CELL * 2), profile: wallrideProfile(1), step: 3, halfWidth: 22,
  },
  {
    id: 'wallrideR', name: 'Wall Ride Right', category: 'stunt', length: CELL * 2,
    exit: { x: 0, y: 0, z: CELL * 2, rot: 0 }, curve: straightCurve(CELL * 2), profile: wallrideProfile(-1), step: 3, halfWidth: 22,
  },
  turn('wallCurveL2', 'Wall Curve Left', R2, 1, { category: 'stunt', profile: wallrideProfile(-1), halfWidth: 22 }),
  turn('wallCurveR2', 'Wall Curve Right', R2, -1, { category: 'stunt', profile: wallrideProfile(1), halfWidth: 22 }),

  // ---- tunnels ----
  straight('tunnel', 'Tunnel', CELL * 2, { category: 'tunnel', profile: tunnelProfile, step: 3 }),
  turn('tunnelCurveL2', 'Tunnel Curve Left', R2, 1, { category: 'tunnel', profile: tunnelProfile }),
  turn('tunnelCurveR2', 'Tunnel Curve Right', R2, -1, { category: 'tunnel', profile: tunnelProfile }),
  slope('tunnelDown', 'Tunnel Dive', CELL * 2, -HEIGHT_STEP * 2),

  // ---- gaps (no geometry) ----
  gapPiece('gap1', 'Gap (1 cell)', CELL, 0),
  gapPiece('gap2', 'Gap (2 cells)', CELL * 2, 0),
  gapPiece('gap3', 'Gap (3 cells)', CELL * 3, 0),
  gapPiece('gapDrop1', 'Gap + Drop', CELL, -HEIGHT_STEP),
  gapPiece('gapDrop2', 'Long Gap + Drop', CELL * 2, -HEIGHT_STEP * 2),
  gapPiece('gapDrop3', 'Huge Gap + Drop', CELL * 3, -HEIGHT_STEP * 3),
];

// fix up tunnelDown profile (slope helper used basic profile)
const td = list.find((p) => p.id === 'tunnelDown')!;
td.profile = tunnelProfile; td.category = 'tunnel';

export const PIECES: Record<string, PieceDef> = Object.fromEntries(list.map((p) => [p.id, p]));
export const PIECE_LIST: PieceDef[] = list;

export function getPiece(id: string): PieceDef {
  const p = PIECES[id];
  if (!p) throw new Error(`Unknown track piece: ${id}`);
  return p;
}

/** Pieces exposed in the Track Builder palette, grouped by category. */
export const BUILDER_CATEGORIES: { id: PieceCategory; label: string }[] = [
  { id: 'road', label: 'Roads' },
  { id: 'turn', label: 'Turns' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'stunt', label: 'Stunts' },
  { id: 'tunnel', label: 'Tunnels' },
  { id: 'gate', label: 'Gates' },
  { id: 'gap', label: 'Jump Gaps' },
];
