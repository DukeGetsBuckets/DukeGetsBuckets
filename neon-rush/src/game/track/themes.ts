import type { ThemeId } from '@shared/track/types';

export type DecorKind = 'towers' | 'mountains' | 'islands' | 'crystals' | 'palms' | 'pillars' | 'rings' | 'mesas' | 'cubes' | 'platforms' | 'orbs';
export type GroundKind = 'none' | 'grid' | 'water' | 'sand' | 'snow' | 'city' | 'void';
export type PropKind = 'lamp' | 'crystal' | 'palm' | 'spire' | 'cube' | 'balloon' | 'none';

export interface Theme {
  id: ThemeId;
  name: string;
  tagline: string;
  sky: { top: string; horizon: string; bottom: string; sunColor: string; sunDir: [number, number, number]; sunSize: number; stars: boolean; aurora: boolean; auroraColor: string };
  fog: { color: string; near: number; far: number };
  light: { sun: string; sunIntensity: number; hemiSky: string; hemiGround: string; hemiIntensity: number; ambient: string };
  road: { base: string; line: string; arrow: string };
  rail: string;
  wall: { base: string; line: string };
  tunnel: { base: string; line: string };
  wallride: { base: string; line: string };
  boost: [string, string];
  gate: { start: string; checkpoint: string; finish: string };
  ground: { kind: GroundKind; color: string; line: string; depth: number };
  decor: { kind: DecorKind; count: number; color: string; color2: string; minDist: number; maxDist: number; scale: [number, number]; heightOffset: [number, number] }[];
  props: { kind: PropKind; spacing: number; color: string };
  supports: boolean;
  clouds: { color: string; count: number; height: number; opacity: number } | null;
  sparkles: { color: string; count: number };
  accent: string; // UI accent color
}

export const THEMES: Record<ThemeId, Theme> = {
  neonCity: {
    id: 'neonCity', name: 'Neon City', tagline: 'Glowing skyscrapers, tight corners and colorful tunnels.',
    sky: { top: '#0a0520', horizon: '#3b1a6e', bottom: '#120a2e', sunColor: '#ff5fd2', sunDir: [0.3, 0.25, -0.9], sunSize: 0.35, stars: true, aurora: false, auroraColor: '#7c3aed' },
    fog: { color: '#1a0b3a', near: 160, far: 900 },
    light: { sun: '#ffb3f0', sunIntensity: 1.3, hemiSky: '#7c3aed', hemiGround: '#0f0a2a', hemiIntensity: 0.9, ambient: '#2a1f55' },
    road: { base: '#1b1738', line: '#22d3ee', arrow: '#f472b6' },
    rail: '#22d3ee',
    wall: { base: '#1a1240', line: '#ec4899' },
    tunnel: { base: '#160d38', line: '#a855f7' },
    wallride: { base: '#1a1240', line: '#38bdf8' },
    boost: ['#facc15', '#fb923c'],
    gate: { start: '#a3e635', checkpoint: '#22d3ee', finish: '#f472b6' },
    ground: { kind: 'city', color: '#0b0724', line: '#4c1d95', depth: 70 },
    decor: [
      { kind: 'towers', count: 220, color: '#1e1b4b', color2: '#22d3ee', minDist: 40, maxDist: 520, scale: [0.6, 2.4], heightOffset: [0, 0] },
      { kind: 'pillars', count: 60, color: '#ec4899', color2: '#a855f7', minDist: 30, maxDist: 300, scale: [0.8, 1.6], heightOffset: [0, 0] },
      { kind: 'rings', count: 6, color: '#a855f7', color2: '#22d3ee', minDist: 120, maxDist: 400, scale: [1, 2], heightOffset: [40, 140] },
    ],
    props: { kind: 'lamp', spacing: 36, color: '#22d3ee' },
    supports: true,
    clouds: null,
    sparkles: { color: '#f472b6', count: 400 },
    accent: '#22d3ee',
  },
  skyIslands: {
    id: 'skyIslands', name: 'Sky Islands', tagline: 'Thousands of feet above the clouds. Do not look down.',
    sky: { top: '#1e3a8a', horizon: '#60a5fa', bottom: '#e0f2fe', sunColor: '#fff7cc', sunDir: [-0.4, 0.55, -0.7], sunSize: 0.6, stars: false, aurora: false, auroraColor: '#ffffff' },
    fog: { color: '#8ec5ff', near: 220, far: 1300 },
    light: { sun: '#fff5d6', sunIntensity: 1.6, hemiSky: '#bfdbfe', hemiGround: '#60a5fa', hemiIntensity: 0.8, ambient: '#5b7fb8' },
    road: { base: '#263a6b', line: '#facc15', arrow: '#ffffff' },
    rail: '#facc15',
    wall: { base: '#1e3a8a', line: '#facc15' },
    tunnel: { base: '#1e3a8a', line: '#38bdf8' },
    wallride: { base: '#1e3a8a', line: '#fb923c' },
    boost: ['#fb923c', '#facc15'],
    gate: { start: '#a3e635', checkpoint: '#facc15', finish: '#fb923c' },
    ground: { kind: 'none', color: '#bfdbfe', line: '#ffffff', depth: 400 },
    decor: [
      { kind: 'islands', count: 40, color: '#2f855a', color2: '#7c4a2d', minDist: 50, maxDist: 600, scale: [0.6, 2.2], heightOffset: [-160, 60] },
      { kind: 'orbs', count: 30, color: '#fde68a', color2: '#fb923c', minDist: 40, maxDist: 320, scale: [0.6, 1.4], heightOffset: [20, 120] },
      { kind: 'platforms', count: 30, color: '#1e40af', color2: '#facc15', minDist: 60, maxDist: 500, scale: [0.8, 2], heightOffset: [-120, 80] },
    ],
    props: { kind: 'balloon', spacing: 60, color: '#fb923c' },
    supports: false,
    clouds: { color: '#ffffff', count: 70, height: -60, opacity: 0.9 },
    sparkles: { color: '#ffffff', count: 250 },
    accent: '#facc15',
  },
  sunsetCanyon: {
    id: 'sunsetCanyon', name: 'Sunset Canyon', tagline: 'Orange cliffs, pink skies and high-speed cliffside driving.',
    sky: { top: '#3b0764', horizon: '#fb923c', bottom: '#f472b6', sunColor: '#fff1b8', sunDir: [0.6, 0.18, -0.78], sunSize: 1.2, stars: false, aurora: false, auroraColor: '#ffffff' },
    fog: { color: '#f08a6a', near: 260, far: 1400 },
    light: { sun: '#ffd1a1', sunIntensity: 1.5, hemiSky: '#f9a8d4', hemiGround: '#7c2d12', hemiIntensity: 0.9, ambient: '#6b3a3a' },
    road: { base: '#3b1f2b', line: '#fb923c', arrow: '#facc15' },
    rail: '#fb923c',
    wall: { base: '#4a1d2e', line: '#f472b6' },
    tunnel: { base: '#3b1038', line: '#fb923c' },
    wallride: { base: '#4a1d2e', line: '#facc15' },
    boost: ['#f472b6', '#facc15'],
    gate: { start: '#a3e635', checkpoint: '#fb923c', finish: '#f472b6' },
    ground: { kind: 'sand', color: '#9a3f2b', line: '#d97706', depth: 50 },
    decor: [
      { kind: 'mesas', count: 90, color: '#c2410c', color2: '#f97316', minDist: 45, maxDist: 700, scale: [0.8, 3], heightOffset: [0, 0] },
      { kind: 'mountains', count: 60, color: '#7c2d12', color2: '#ea580c', minDist: 300, maxDist: 1100, scale: [2, 5], heightOffset: [0, 0] },
      { kind: 'pillars', count: 25, color: '#facc15', color2: '#f472b6', minDist: 30, maxDist: 240, scale: [0.6, 1.2], heightOffset: [0, 0] },
    ],
    props: { kind: 'spire', spacing: 48, color: '#fb923c' },
    supports: true,
    clouds: { color: '#ffd6e7', count: 30, height: 220, opacity: 0.6 },
    sparkles: { color: '#fde68a', count: 200 },
    accent: '#fb923c',
  },
  cyberVoid: {
    id: 'cyberVoid', name: 'Cyber Void', tagline: 'Electric roads suspended in deep space.',
    sky: { top: '#020010', horizon: '#1a0b4a', bottom: '#050012', sunColor: '#60a5fa', sunDir: [-0.5, 0.3, -0.8], sunSize: 0.25, stars: true, aurora: true, auroraColor: '#7c3aed' },
    fog: { color: '#0a0530', near: 140, far: 800 },
    light: { sun: '#93c5fd', sunIntensity: 1.1, hemiSky: '#4c1d95', hemiGround: '#020010', hemiIntensity: 0.8, ambient: '#1e1b4b' },
    road: { base: '#0f0b2e', line: '#38bdf8', arrow: '#a855f7' },
    rail: '#8b5cf6',
    wall: { base: '#0f0b2e', line: '#38bdf8' },
    tunnel: { base: '#0a0628', line: '#a855f7' },
    wallride: { base: '#0f0b2e', line: '#ec4899' },
    boost: ['#38bdf8', '#a855f7'],
    gate: { start: '#a3e635', checkpoint: '#38bdf8', finish: '#a855f7' },
    ground: { kind: 'grid', color: '#06041a', line: '#4f46e5', depth: 90 },
    decor: [
      { kind: 'cubes', count: 160, color: '#1e1b4b', color2: '#38bdf8', minDist: 35, maxDist: 520, scale: [0.5, 2.5], heightOffset: [-120, 160] },
      { kind: 'rings', count: 10, color: '#a855f7', color2: '#38bdf8', minDist: 80, maxDist: 420, scale: [1, 2.5], heightOffset: [0, 120] },
      { kind: 'pillars', count: 50, color: '#38bdf8', color2: '#a855f7', minDist: 30, maxDist: 320, scale: [0.8, 2], heightOffset: [-60, 0] },
    ],
    props: { kind: 'cube', spacing: 30, color: '#38bdf8' },
    supports: false,
    clouds: null,
    sparkles: { color: '#a855f7', count: 600 },
    accent: '#a855f7',
  },
  tropicalRush: {
    id: 'tropicalRush', name: 'Tropical Rush', tagline: 'Turquoise water, floating roads and sunshine.',
    sky: { top: '#0369a1', horizon: '#7dd3fc', bottom: '#a7f3d0', sunColor: '#fffbe6', sunDir: [0.3, 0.7, -0.65], sunSize: 0.7, stars: false, aurora: false, auroraColor: '#ffffff' },
    fog: { color: '#9be7ff', near: 240, far: 1300 },
    light: { sun: '#fff8e1', sunIntensity: 1.7, hemiSky: '#bae6fd', hemiGround: '#0d9488', hemiIntensity: 0.9, ambient: '#4b8a9a' },
    road: { base: '#1f3b4d', line: '#a3e635', arrow: '#facc15' },
    rail: '#a3e635',
    wall: { base: '#164e63', line: '#fb923c' },
    tunnel: { base: '#134e4a', line: '#2dd4bf' },
    wallride: { base: '#164e63', line: '#f472b6' },
    boost: ['#f472b6', '#facc15'],
    gate: { start: '#facc15', checkpoint: '#a3e635', finish: '#fb923c' },
    ground: { kind: 'water', color: '#06b6d4', line: '#a5f3fc', depth: 40 },
    decor: [
      { kind: 'islands', count: 40, color: '#16a34a', color2: '#d9b36b', minDist: 40, maxDist: 650, scale: [0.6, 2.5], heightOffset: [0, 0] },
      { kind: 'palms', count: 120, color: '#15803d', color2: '#92400e', minDist: 30, maxDist: 500, scale: [0.8, 1.6], heightOffset: [0, 0] },
      { kind: 'mountains', count: 30, color: '#166534', color2: '#4ade80', minDist: 350, maxDist: 1100, scale: [2, 5], heightOffset: [0, 0] },
    ],
    props: { kind: 'palm', spacing: 44, color: '#a3e635' },
    supports: true,
    clouds: { color: '#ffffff', count: 40, height: 260, opacity: 0.85 },
    sparkles: { color: '#fef08a', count: 200 },
    accent: '#a3e635',
  },
  crystalMountains: {
    id: 'crystalMountains', name: 'Crystal Mountains', tagline: 'Snowy peaks, glowing crystals and steep drops.',
    sky: { top: '#0f172a', horizon: '#6d28d9', bottom: '#c7d2fe', sunColor: '#c4b5fd', sunDir: [-0.2, 0.4, -0.9], sunSize: 0.5, stars: true, aurora: true, auroraColor: '#22d3ee' },
    fog: { color: '#5b4b9e', near: 200, far: 1100 },
    light: { sun: '#e0e7ff', sunIntensity: 1.4, hemiSky: '#a5b4fc', hemiGround: '#312e81', hemiIntensity: 0.9, ambient: '#3f3a7a' },
    road: { base: '#1e1b4b', line: '#67e8f9', arrow: '#c084fc' },
    rail: '#67e8f9',
    wall: { base: '#312e81', line: '#22d3ee' },
    tunnel: { base: '#1e1b4b', line: '#c084fc' },
    wallride: { base: '#312e81', line: '#f0abfc' },
    boost: ['#22d3ee', '#c084fc'],
    gate: { start: '#a3e635', checkpoint: '#67e8f9', finish: '#c084fc' },
    ground: { kind: 'snow', color: '#c7d2fe', line: '#e0e7ff', depth: 60 },
    decor: [
      { kind: 'mountains', count: 70, color: '#e0e7ff', color2: '#6d28d9', minDist: 120, maxDist: 1000, scale: [1.5, 5], heightOffset: [0, 0] },
      { kind: 'crystals', count: 160, color: '#22d3ee', color2: '#c084fc', minDist: 25, maxDist: 450, scale: [0.6, 2.4], heightOffset: [0, 0] },
      { kind: 'pillars', count: 20, color: '#c084fc', color2: '#22d3ee', minDist: 40, maxDist: 300, scale: [0.6, 1.4], heightOffset: [0, 0] },
    ],
    props: { kind: 'crystal', spacing: 34, color: '#67e8f9' },
    supports: true,
    clouds: { color: '#e0e7ff', count: 30, height: 200, opacity: 0.5 },
    sparkles: { color: '#67e8f9', count: 500 },
    accent: '#67e8f9',
  },
};

export const THEME_LIST = Object.values(THEMES);
