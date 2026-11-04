import type { Vec3 } from '../math';

export type ThemeId = 'neonCity' | 'skyIslands' | 'sunsetCanyon' | 'cyberVoid' | 'tropicalRush' | 'crystalMountains';

export interface Placement {
  type: string;
  x: number;   // meters (world)
  y: number;
  z: number;
  rot: number; // quarter turns (0..3)
  walls?: boolean;
}

export interface TrackMedals {
  author: number; // ms
  gold: number;
  silver: number;
  bronze: number;
}

export interface TrackDefinition {
  id: string;
  name: string;
  theme: ThemeId;
  difficulty: 1 | 2 | 3 | 4; // beginner, intermediate, advanced, expert
  description: string;
  author: string;
  pieces: Placement[];
  medals: TrackMedals;
  /** stable seed for environment decoration */
  seed?: number;
  official?: boolean;
}

export interface Frame {
  pos: Vec3;
  tangent: Vec3;
  up: Vec3;
  right: Vec3;
  dist: number;     // distance along the whole track
  pieceIndex: number;
}

export interface GateInfo {
  kind: 'start' | 'checkpoint' | 'finish';
  index: number;    // checkpoint ordinal (start=-1, checkpoints 0..n-1, finish = n)
  pos: Vec3;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
  halfWidth: number;
  dist: number;
}

export interface BoostZone { pos: Vec3; forward: Vec3; up: Vec3; right: Vec3; halfLength: number; halfWidth: number }
export interface DecorInfo { kind: 'ring' | 'arch' | 'pylon'; pos: Vec3; forward: Vec3; up: Vec3; right: Vec3 }

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface CompiledTrack {
  frames: Frame[];
  length: number;
  surfaces: Record<'road' | 'wall' | 'wallride' | 'tunnel' | 'rail' | 'boost', MeshData>;
  collision: { positions: Float32Array; indices: Uint32Array };
  gates: GateInfo[];
  start: { pos: Vec3; forward: Vec3; up: Vec3; right: Vec3 };
  checkpoints: GateInfo[]; // ordered, finish last
  boosts: BoostZone[];
  decor: DecorInfo[];
  bounds: { min: Vec3; max: Vec3 };
  pieceFrames: { pieceIndex: number; start: number; end: number }[];
  pieceTypes: string[];
  issues: string[];
}
