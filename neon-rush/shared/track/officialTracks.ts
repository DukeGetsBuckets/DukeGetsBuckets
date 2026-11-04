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
    description: 'A fast warm-up through downtown. Learn the brakes before the sweeper.',
    items: ['start', 'straight', 'curveR2', 'straight', 'curveL2', 'curveL2', 'checkpoint', 'boost', 'ring', 'straight2', 'straight', 'chicaneR', 'straight',
      'curveR3', 'checkpoint', 'slopeUp2', 'straight', 'slopeDown2', 'straight2', 'curveL2', 'straight', 'boost', 'arch', 'straight2', 'finish', 'straight'],
    medals: [21400, 23700, 27100, 33400],
  },
  {
    id: 'canyon-dash', name: 'Canyon Dash', theme: 'sunsetCanyon', difficulty: 1, seed: 404,
    description: 'Flowing banked sweepers along the cliffs and one big hill to fly over.',
    items: ['start', 'straight', 'curveL3', 'straight', 'bankR2', 'bankR2', 'checkpoint', 'straight2', 'hill', 'straight2', 'straight', 'curveL2', 'checkpoint',
      'chicaneL', 'straight', 'boost', 'ring', 'straight2', 'curveR3', 'straight', 'finish', 'straight'],
    medals: [20700, 23000, 26300, 32300],
  },
  {
    id: 'palm-breeze', name: 'Palm Breeze', theme: 'tropicalRush', difficulty: 1, seed: 505,
    description: 'Sunny island cruising: a tunnel, a boost and a friendly little jump.',
    items: ['start', 'boost', 'straight', 'straight', 'curveR2', 'straight', W('tunnel'), 'straight', 'checkpoint', 'curveL2', 'curveL2', 'straight', 'kicker', 'gapDrop1', 'landing', 'straight2',
      'checkpoint', 'curveR3', 'boost', 'arch', 'straight2', 'finish', 'straight'],
    medals: [17300, 19200, 21900, 27000],
  },
  {
    id: 'cloud-runner', name: 'Cloud Runner', theme: 'skyIslands', difficulty: 2, seed: 202,
    description: 'Floating roads and two big jumps. Keep the throttle pinned over the gaps.',
    items: ['start', 'straight', 'curveL2', 'straight', 'kicker', 'gapDrop1', 'landing', 'straight2', 'checkpoint', 'curveR3', 'slopeUp2', 'straight', 'hill', 'straight2', 'curveL2',
      'checkpoint', 'bankR2', 'straight', 'kicker', 'gapDrop2', 'landing', 'straight2', 'ring', 'boost', 'straight2', 'finish', 'straight'],
    medals: [24700, 27400, 31400, 38600],
  },
  {
    id: 'crystal-climb', name: 'Crystal Climb', theme: 'crystalMountains', difficulty: 2, seed: 606,
    description: 'Climb the glowing peak, then plunge back down through the crystals.',
    items: ['start', 'straight', 'slopeUp2', 'curveUpL2', 'straight', 'checkpoint', 'curveR2', 'slopeUp1', 'straight2', 'hairpinL2', 'checkpoint', 'plunge',
      'straight2', 'straight', 'curveDownR2', 'boost', 'straight2', 'checkpoint', 'chicaneR', 'curveL2', 'arch', 'finish', 'straight'],
    medals: [22400, 24800, 28400, 34900],
  },
  {
    id: 'skyline-circuit', name: 'Skyline Circuit', theme: 'neonCity', difficulty: 2, seed: 707,
    description: 'Neon tunnels, a wall-riding curve and banked bends between the towers.',
    items: ['start', 'straight2', 'bankL2', W('tunnelCurveR2'), W('tunnel'), 'checkpoint', 'curveR2', 'boost', 'straight', 'wallCurveL2', 'straight', 'checkpoint',
      'chicaneR', 'bankR3', 'straight', 'hill', 'straight2', 'straight', 'curveL2', 'checkpoint', 'boost', 'ring', 'straight2', 'finish', 'straight'],
    medals: [21900, 24300, 27800, 34200],
  },
  {
    id: 'loop-district', name: 'Loop District', theme: 'cyberVoid', difficulty: 3, seed: 303,
    description: 'A full loop, a corkscrew and a wall ride. Speed is your friend.',
    items: ['start', 'boost', 'straight', 'loopL', 'straight2', 'checkpoint', 'curveR2', 'straight2', 'corkscrewL', 'boost', 'straight', 'checkpoint', 'bankL3', 'boost', 'wallrideR',
      'straight', 'curveL2', W('tunnel'), W('tunnelCurveR2'), 'checkpoint', 'ring', 'straight', 'finish', 'straight'],
    medals: [21500, 23800, 27300, 33500],
  },
  {
    id: 'island-hopper', name: 'Island Hopper', theme: 'tropicalRush', difficulty: 3, seed: 808,
    description: 'Jump from island to island, then roll through a corkscrew over the sea.',
    items: ['start', 'straight2', 'kicker', 'gapDrop1', 'landing', 'straight2', 'checkpoint', 'curveR2', 'straight', 'kickerBig', 'gapDrop2', 'landing', 'straight2', 'straight2',
      'checkpoint', 'curveL3', 'straight', 'corkscrewR', 'boost', 'straight', 'checkpoint', 'bankL2', 'boost', 'ring', 'straight2', 'finish', 'straight'],
    medals: [25200, 27900, 32000, 39300],
  },
  {
    id: 'thunder-peak', name: 'Thunder Peak', theme: 'crystalMountains', difficulty: 3, seed: 909,
    description: 'A steep climb into a loop, then a plunge and a hill jump down the mountain.',
    items: ['start', 'straight', 'climb', 'straight', 'checkpoint', 'boost', 'loopR', 'straight2', 'straight', 'curveL2', 'checkpoint', 'plunge', 'straight', 'bankR3', 'straight', 'hill',
      'straight2', 'straight', 'checkpoint', 'curveUpL2', 'arch', 'boost', 'straight2', 'finish', 'straight'],
    medals: [21900, 24300, 27800, 34200],
  },
  {
    id: 'void-spiral', name: 'Void Spiral', theme: 'cyberVoid', difficulty: 4, seed: 1010,
    description: 'Corkscrew, loop, wall ride, a narrow bridge and a huge drop. Expert only.',
    items: ['start', 'boost', 'straight', 'corkscrewL', 'straight', 'checkpoint', 'curveR2', 'boost', 'loopL', 'straight2', 'checkpoint', 'wallrideL', 'straight', 'narrow', 'narrow',
      'checkpoint', 'curveR2', 'straight', 'kickerBig', 'gapDrop2', 'landing', 'straight2', 'straight2', 'checkpoint', 'curveR3', 'boost', 'ring', 'straight2', 'finish', 'straight'],
    medals: [25900, 28600, 32800, 40300],
  },
  {
    id: 'mesa-madness', name: 'Mesa Madness', theme: 'sunsetCanyon', difficulty: 4, seed: 1111,
    description: 'Tight hairpins, a tunnel dive and a jump over the canyon. Precision required.',
    items: ['start', 'straight', 'curveR1', 'straight', 'curveL1', 'curveL1', 'checkpoint', 'straight', 'hill', 'straight2', 'straight', 'hairpinR', 'checkpoint', 'boost',
      W('tunnelDown'), W('tunnel'), 'kicker', 'gapDrop1', 'landing', 'straight2', 'checkpoint', 'bankL3', 'straight', 'chicaneR', 'curveR2', 'arch', 'boost', 'straight2', 'finish', 'straight'],
    medals: [24800, 27500, 31500, 38700],
  },
  {
    id: 'stratosphere', name: 'Stratosphere', theme: 'skyIslands', difficulty: 4, seed: 1212,
    description: 'The grand finale above the clouds: loop, mega jump, corkscrew and a wall curve.',
    items: ['start', 'boost', 'straight', 'loopR', 'straight2', 'checkpoint', 'bankL3', 'straight', 'kickerBig', 'gapDrop3', 'landing', 'straight2', 'straight2', 'checkpoint', 'curveR2',
      'straight', 'corkscrewL', 'boost', 'straight', 'checkpoint', 'wallCurveR2', 'straight', 'boost', 'hill', 'straight2', 'straight2', 'checkpoint', 'hairpinL2', 'ring', 'straight', 'finish', 'straight'],
    medals: [31500, 34900, 40000, 49200],
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
