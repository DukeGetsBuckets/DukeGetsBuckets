// Compiles a list of placed pieces into renderable mesh data, physics collision data,
// gates (start / checkpoints / finish), boost zones and a continuous centerline.
// Pure TypeScript: used by the game client AND the Worker (server-side validation).

import { Vec3, v3, vadd, vsub, vscale, vcross, vdot, vnorm, vlen, rotYQuarter, vmadd } from '../math';
import { getPiece, ROAD_HALF, type Strip, type PieceDef } from './pieces';
import type { CompiledTrack, Frame, GateInfo, MeshData, Placement, TrackDefinition, BoostZone, DecorInfo } from './types';

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  get vertexCount() { return this.positions.length / 3; }
  push(p: Vec3, n: Vec3, u: number, v: number) {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
  }
  tri(a: number, b: number, c: number) { this.indices.push(a, b, c); }
  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
  }
}

interface LocalFrame { pos: Vec3; tangent: Vec3; up: Vec3; right: Vec3; t: number }

function toWorld(local: Vec3, pl: Placement): Vec3 {
  const r = rotYQuarter(local, pl.rot);
  return v3(r.x + pl.x, r.y + pl.y, r.z + pl.z);
}
function dirToWorld(local: Vec3, pl: Placement): Vec3 {
  return rotYQuarter(local, pl.rot);
}

/** Sample a piece's centerline in local space with consistent orthonormal frames. */
export function samplePiece(def: PieceDef, segments: number): LocalFrame[] {
  const out: LocalFrame[] = [];
  const eps = 1e-3;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const t0 = Math.max(0, t - eps), t1 = Math.min(1, t + eps);
    const a = def.curve(t0).pos, b = def.curve(t1).pos;
    const s = def.curve(t);
    let tangent = vnorm(vsub(b, a));
    if (vlen(vsub(b, a)) < 1e-9) tangent = v3(0, 0, 1);
    // re-orthogonalize up against tangent
    let up = vsub(s.up, vscale(tangent, vdot(s.up, tangent)));
    if (vlen(up) < 1e-6) up = v3(0, 1, 0);
    up = vnorm(up);
    const right = vnorm(vcross(tangent, up));
    out.push({ pos: s.pos, tangent, up, right, t });
  }
  return out;
}

function segmentsFor(def: PieceDef): number {
  const step = def.step ?? 2;
  return Math.max(2, Math.ceil(def.length / step));
}

function sweepStrip(
  frames: Frame[], strip: Strip, mb: MeshBuilder, uScale = 1, vRange: [number, number] = [0, 1],
) {
  const pts = strip.pts;
  const n = pts.length;
  if (n < 2 || frames.length < 2) return;
  // 2D normals per profile point (smooth: average adjacent segment normals; else duplicate per segment)
  const segNormals: [number, number][] = [];
  for (let j = 0; j < n - 1; j++) {
    const dx = pts[j + 1][0] - pts[j][0], dy = pts[j + 1][1] - pts[j][1];
    const l = Math.hypot(dx, dy) || 1;
    segNormals.push([-dy / l, dx / l]);
  }
  const smooth = strip.smooth ?? false;
  // profile arc-length for v coordinate
  const cum: number[] = [0];
  for (let j = 0; j < n - 1; j++) cum.push(cum[j] + Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1]));
  const total = cum[n - 1] || 1;

  if (smooth) {
    const base = mb.vertexCount;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      for (let j = 0; j < n; j++) {
        const p = vadd(f.pos, vadd(vscale(f.right, pts[j][0]), vscale(f.up, pts[j][1])));
        let nx: number, ny: number;
        if (j === 0) [nx, ny] = segNormals[0];
        else if (j === n - 1) [nx, ny] = segNormals[n - 2];
        else { nx = segNormals[j - 1][0] + segNormals[j][0]; ny = segNormals[j - 1][1] + segNormals[j][1]; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l; }
        const nrm = vnorm(vadd(vscale(f.right, nx), vscale(f.up, ny)));
        const v = vRange[0] + (vRange[1] - vRange[0]) * (cum[j] / total);
        mb.push(p, nrm, f.dist * uScale, v);
      }
    }
    for (let i = 0; i < frames.length - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        const a = base + i * n + j, b = base + (i + 1) * n + j, c = base + (i + 1) * n + j + 1, d = base + i * n + j + 1;
        mb.tri(a, c, b);
        mb.tri(a, d, c);
      }
    }
  } else {
    for (let j = 0; j < n - 1; j++) {
      const base = mb.vertexCount;
      const [nx, ny] = segNormals[j];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const nrm = vnorm(vadd(vscale(f.right, nx), vscale(f.up, ny)));
        const p0 = vadd(f.pos, vadd(vscale(f.right, pts[j][0]), vscale(f.up, pts[j][1])));
        const p1 = vadd(f.pos, vadd(vscale(f.right, pts[j + 1][0]), vscale(f.up, pts[j + 1][1])));
        const v0 = vRange[0] + (vRange[1] - vRange[0]) * (cum[j] / total);
        const v1 = vRange[0] + (vRange[1] - vRange[0]) * (cum[j + 1] / total);
        mb.push(p0, nrm, f.dist * uScale, v0);
        mb.push(p1, nrm, f.dist * uScale, v1);
      }
      for (let i = 0; i < frames.length - 1; i++) {
        const a = base + i * 2, d = base + i * 2 + 1, b = base + (i + 1) * 2, c = base + (i + 1) * 2 + 1;
        mb.tri(a, c, b);
        mb.tri(a, d, c);
      }
    }
  }
}

export function compileTrack(def: TrackDefinition | { pieces: Placement[] }): CompiledTrack {
  const pieces = def.pieces;
  const frames: Frame[] = [];
  const builders = {
    road: new MeshBuilder(), wall: new MeshBuilder(), wallride: new MeshBuilder(),
    tunnel: new MeshBuilder(), rail: new MeshBuilder(), boost: new MeshBuilder(),
  };
  const collision = new MeshBuilder();
  const gates: GateInfo[] = [];
  const boosts: BoostZone[] = [];
  const decor: DecorInfo[] = [];
  const pieceFrames: CompiledTrack['pieceFrames'] = [];
  const issues: string[] = [];
  const min = v3(Infinity, Infinity, Infinity), max = v3(-Infinity, -Infinity, -Infinity);
  let dist = 0;
  let cpCount = 0;

  const extend = (p: Vec3) => {
    if (p.x < min.x) min.x = p.x; if (p.y < min.y) min.y = p.y; if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x; if (p.y > max.y) max.y = p.y; if (p.z > max.z) max.z = p.z;
  };

  pieces.forEach((pl, pieceIndex) => {
    let defn: PieceDef;
    try { defn = getPiece(pl.type); } catch (e) { issues.push(String((e as Error).message)); return; }
    const local = samplePiece(defn, segmentsFor(defn));
    const world: Frame[] = [];
    let prev: Vec3 | null = frames.length ? frames[frames.length - 1].pos : null;
    for (let i = 0; i < local.length; i++) {
      const lf = local[i];
      const pos = toWorld(lf.pos, pl);
      const tangent = dirToWorld(lf.tangent, pl);
      const up = dirToWorld(lf.up, pl);
      const right = dirToWorld(lf.right, pl);
      if (prev && !(i === 0 && defn.gap)) dist += vlen(vsub(pos, prev));
      prev = pos;
      const f: Frame = { pos, tangent, up, right, dist, pieceIndex };
      world.push(f);
      extend(pos);
    }
    // gaps contribute to the centerline (for position tracking) but produce no geometry
    const startIdx = frames.length;
    frames.push(...world);
    pieceFrames.push({ pieceIndex, start: startIdx, end: frames.length - 1 });
    if (defn.gap) return;

    const strips = defn.profile(!!pl.walls);
    for (const strip of strips) {
      const target = strip.kind === 'boost' ? builders.boost : builders[strip.kind];
      sweepStrip(world, strip, target);
      sweepStrip(world, strip, collision);
    }
    // neon rails at the road edges
    const road = strips.find((s) => s.kind === 'road');
    if (road) {
      const half = Math.abs(road.pts[0][0]);
      const railW = 0.7, lift = 0.05;
      sweepStrip(world, { kind: 'road', pts: [[-half - 0.15, lift], [-half - 0.15 + railW, lift]] }, builders.rail, 1, [0, 0]);
      sweepStrip(world, { kind: 'road', pts: [[half + 0.15 - railW, lift], [half + 0.15, lift]] }, builders.rail, 1, [1, 1]);
      if (defn.boost) {
        const [t0, t1] = defn.boost;
        const sub = world.filter((_, i) => i / (world.length - 1) >= t0 - 1e-6 && i / (world.length - 1) <= t1 + 1e-6);
        if (sub.length >= 2) {
          sweepStrip(sub, { kind: 'boost', pts: [[-half + 0.6, 0.06], [half - 0.6, 0.06]] }, builders.boost);
          const mid = sub[Math.floor(sub.length / 2)];
          boosts.push({ pos: mid.pos, forward: mid.tangent, up: mid.up, right: mid.right, halfLength: (sub[sub.length - 1].dist - sub[0].dist) / 2 + 1, halfWidth: half });
        }
      }
    }
    const frameAt = (t: number) => world[Math.round(t * (world.length - 1))];
    for (const g of defn.gates ?? []) {
      const f = frameAt(g.t);
      const halfWidth = (road ? Math.abs(road.pts[0][0]) : ROAD_HALF) + 3;
      const gate: GateInfo = { kind: g.kind, index: -1, pos: f.pos, forward: f.tangent, up: f.up, right: f.right, halfWidth, dist: f.dist };
      if (g.kind === 'checkpoint') gate.index = cpCount++;
      gates.push(gate);
    }
    for (const d of defn.decor ?? []) {
      const f = frameAt(d.t);
      decor.push({ kind: d.kind, pos: f.pos, forward: f.tangent, up: f.up, right: f.right });
    }
  });

  const startGate = gates.find((g) => g.kind === 'start');
  const finishGate = gates.find((g) => g.kind === 'finish');
  if (!startGate) issues.push('Track has no start line.');
  if (!finishGate) issues.push('Track has no finish line.');
  if (gates.filter((g) => g.kind === 'start').length > 1) issues.push('Track has more than one start line.');
  if (gates.filter((g) => g.kind === 'finish').length > 1) issues.push('Track has more than one finish line.');
  if (startGate && finishGate && finishGate.dist <= startGate.dist) issues.push('Finish must come after the start.');
  if (pieces.length > 400) issues.push('Track has too many pieces (max 400).');

  const checkpoints = gates.filter((g) => g.kind === 'checkpoint').sort((a, b) => a.dist - b.dist);
  checkpoints.forEach((c, i) => (c.index = i));
  if (finishGate) { finishGate.index = checkpoints.length; checkpoints.push(finishGate); }

  // Spawn: a few meters before the start gate, on the start piece
  let start = { pos: v3(0, 0, 0), forward: v3(0, 0, 1), up: v3(0, 1, 0), right: v3(-1, 0, 0) };
  if (startGate) {
    const back = vmadd(startGate.pos, startGate.forward, -6);
    start = { pos: vadd(back, vscale(startGate.up, 0.9)), forward: startGate.forward, up: startGate.up, right: startGate.right };
  } else if (frames.length) {
    const f = frames[0];
    start = { pos: vadd(f.pos, vscale(f.up, 0.9)), forward: f.tangent, up: f.up, right: f.right };
  }

  if (!Number.isFinite(min.x)) { min.x = min.y = min.z = -10; max.x = max.y = max.z = 10; }

  return {
    frames,
    length: dist,
    surfaces: {
      road: builders.road.build(), wall: builders.wall.build(), wallride: builders.wallride.build(),
      tunnel: builders.tunnel.build(), rail: builders.rail.build(), boost: builders.boost.build(),
    },
    collision: { positions: new Float32Array(collision.positions), indices: new Uint32Array(collision.indices) },
    gates,
    start,
    checkpoints,
    boosts,
    decor,
    bounds: { min, max },
    pieceFrames,
    pieceTypes: pieces.map((p) => p.type),
    issues,
  };
}

/** Closest centerline frame index (coarse search, cached start index for incremental tracking). */
export function nearestFrameIndex(frames: Frame[], p: Vec3, hint = 0, window = 60): number {
  let best = hint, bestD = Infinity;
  const lo = Math.max(0, hint - window), hi = Math.min(frames.length - 1, hint + window);
  for (let i = lo; i <= hi; i++) {
    const f = frames[i].pos;
    const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2 + (f.z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function nearestFrameIndexGlobal(frames: Frame[], p: Vec3): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i].pos;
    const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2 + (f.z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** True if segment a->b crosses the gate plane within its bounds. */
export function crossesGate(gate: GateInfo, a: Vec3, b: Vec3): boolean {
  const da = vdot(vsub(a, gate.pos), gate.forward);
  const db = vdot(vsub(b, gate.pos), gate.forward);
  if (!(da < 0 && db >= 0)) return false;
  const t = da / (da - db);
  const hit = v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  const rel = vsub(hit, gate.pos);
  const lateral = Math.abs(vdot(rel, gate.right));
  const vertical = vdot(rel, gate.up);
  return lateral <= gate.halfWidth + 6 && vertical > -3 && vertical < 60;
}
