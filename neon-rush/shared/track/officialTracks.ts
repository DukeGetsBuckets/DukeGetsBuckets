// The 12 official NEON RUSH tracks. Authored as piece chains; compiled at load time.
import { chain, type ChainItem } from './chain';
import type { TrackDefinition, ThemeId } from './types';

interface TrackSpec {
  id: string; name: string; theme: ThemeId; difficulty: 1 | 2 | 3 | 4; description: string;
  items: ChainItem[]; medals: [number, number, number, number]; seed: number;
}

const W = (type: string): ChainItem => ({ type, walls: true });

const SPECS: TrackSpec[] = [
  {
    id: 'neon-sprint', name: 'Neon Sprint', theme: 'neonCity', difficulty: 1, seed: 101,
    description: 'A fast warm-up through downtown. Learn the brakes before the hairpin.',
    items: ['start', 'straight', 'curveR2', 'straight', 'boost', 'curveL2', 'curveL2', 'checkpoint', 'straight2', 'chicaneR', 'straight',
      'curveR3', 'checkpoint', 'slopeUp1', 'straight', 'slopeDown1', 'curveL2', 'straight', 'boost', 'straight2', 'finish', 'straight'],
    medals: [38000, 42000, 48000, 60000],
  },
  {
    id: 'cloud-runner', name: 'Cloud Runner', theme: 'skyIslands', difficulty: 2, seed: 202,
    description: 'Floating roads and two big jumps. Keep the throttle pinned over the gaps.',
    items: ['start', 'straight', 'curveL2', 'boost', 'kicker', 'gapDrop1', 'landing', 'checkpoint', 'curveR3', 'slopeUp2', 'straight', 'hill', 'curveL2',
      'checkpoint', 'bankR2', 'straight2', 'boost', 'kicker', 'gapDrop2', 'landing', 'curveR2', 'straight', 'finish', 'straight'],
    medals: [52000, 58000, 66000, 80000],
  },
  {
    id: 'loop-district', name: 'Loop District', theme: 'cyberVoid', difficulty: 3, seed: 303,
    description: 'A full loop, a corkscrew and a wall ride. Speed is your friend.',
    items: ['start', 'boost', 'straight', 'loopL', 'straight', 'checkpoint', 'curveR2', 'straight', 'boost', 'corkscrewL', 'checkpoint', 'bankL3', 'boost', 'wallrideR',
      'curveL2', W('tunnel'), W('tunnelCurveR2'), 'checkpoint', 'straight2', 'finish', 'straight'],
    medals: [50000, 56000, 64000, 80000],
  },
];

export function buildOfficialTrack(spec: TrackSpec): TrackDefinition {
  return {
    id: spec.id, name: spec.name, theme: spec.theme, difficulty: spec.difficulty, description: spec.description,
    author: 'NEON RUSH', pieces: chain({ x: 0, y: 0, z: 0, rot: 0 }, spec.items),
    medals: { author: spec.medals[0], gold: spec.medals[1], silver: spec.medals[2], bronze: spec.medals[3] },
    seed: spec.seed, official: true,
  };
}

export const OFFICIAL_TRACKS: TrackDefinition[] = SPECS.map(buildOfficialTrack);
export const OFFICIAL_TRACK_MAP: Record<string, TrackDefinition> = Object.fromEntries(OFFICIAL_TRACKS.map((t) => [t.id, t]));
export function getOfficialTrack(id: string): TrackDefinition | undefined { return OFFICIAL_TRACK_MAP[id]; }
export const DIFFICULTY_NAMES = ['', 'Beginner', 'Intermediate', 'Advanced', 'Expert'];
