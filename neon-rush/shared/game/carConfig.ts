// Car customization model (shared between client and server).

export type CarBodyId = 'viper' | 'brute' | 'phantom' | 'formula' | 'wedge' | 'bolt';
export type FinishId = 'gloss' | 'metallic' | 'matte';
export type WheelId = 'classic' | 'blade' | 'turbo' | 'hex' | 'star';
export type TrailId = 'none' | 'neon' | 'fire' | 'rainbow' | 'stars' | 'ice';
export type DecalId = 'none' | 'stripes' | 'flames' | 'checker' | 'number' | 'lightning' | 'hex' | 'waves';
export type EffectId = 'none' | 'sparkles' | 'bubbles' | 'embers' | 'pixels' | 'hearts';

export interface CarConfig {
  body: CarBodyId;
  paint: string;
  paint2: string;
  finish: FinishId;
  underglow: string; // hex or 'none'
  tireColor: string;
  wheel: WheelId;
  trail: TrailId;
  decal: DecalId;
  effect: EffectId;
  number: number;
}

export const DEFAULT_CAR: CarConfig = {
  body: 'viper', paint: '#22d3ee', paint2: '#f472b6', finish: 'gloss', underglow: '#a855f7',
  tireColor: '#22d3ee', wheel: 'classic', trail: 'neon', decal: 'stripes', effect: 'none', number: 7,
};

export interface CosmeticItem {
  id: string;
  kind: 'body' | 'paint' | 'finish' | 'underglow' | 'tire' | 'wheel' | 'trail' | 'decal' | 'effect';
  value: string;
  name: string;
  cost: number;          // coins (0 = free)
  unlockLevel?: number;  // required level
  achievement?: string;  // required achievement id
}

export const PAINT_COLORS: { value: string; name: string; cost: number }[] = [
  { value: '#22d3ee', name: 'Electric Cyan', cost: 0 },
  { value: '#38bdf8', name: 'Sky Blue', cost: 0 },
  { value: '#a855f7', name: 'Neon Purple', cost: 0 },
  { value: '#ec4899', name: 'Hot Pink', cost: 0 },
  { value: '#fb923c', name: 'Vibrant Orange', cost: 0 },
  { value: '#a3e635', name: 'Lime Green', cost: 0 },
  { value: '#facc15', name: 'Sunset Yellow', cost: 0 },
  { value: '#f8fafc', name: 'Pearl White', cost: 150 },
  { value: '#0f172a', name: 'Midnight', cost: 150 },
  { value: '#ef4444', name: 'Crimson', cost: 200 },
  { value: '#14b8a6', name: 'Teal', cost: 200 },
  { value: '#f472b6', name: 'Bubblegum', cost: 250 },
  { value: '#6366f1', name: 'Indigo', cost: 250 },
  { value: '#fde68a', name: 'Gold Dust', cost: 400 },
  { value: '#c084fc', name: 'Lavender', cost: 300 },
  { value: '#34d399', name: 'Emerald', cost: 300 },
];

export const COSMETICS: CosmeticItem[] = [
  { id: 'body_viper', kind: 'body', value: 'viper', name: 'Viper GT', cost: 0 },
  { id: 'body_bolt', kind: 'body', value: 'bolt', name: 'Bolt', cost: 0 },
  { id: 'body_brute', kind: 'body', value: 'brute', name: 'Brute V8', cost: 500, unlockLevel: 3 },
  { id: 'body_wedge', kind: 'body', value: 'wedge', name: 'Wedge X', cost: 800, unlockLevel: 5 },
  { id: 'body_phantom', kind: 'body', value: 'phantom', name: 'Phantom Pod', cost: 1200, unlockLevel: 8 },
  { id: 'body_formula', kind: 'body', value: 'formula', name: 'Formula Zero', cost: 1600, unlockLevel: 12 },
  { id: 'finish_gloss', kind: 'finish', value: 'gloss', name: 'Gloss', cost: 0 },
  { id: 'finish_matte', kind: 'finish', value: 'matte', name: 'Matte', cost: 120 },
  { id: 'finish_metallic', kind: 'finish', value: 'metallic', name: 'Metallic', cost: 250, unlockLevel: 2 },
  { id: 'wheel_classic', kind: 'wheel', value: 'classic', name: 'Classic', cost: 0 },
  { id: 'wheel_blade', kind: 'wheel', value: 'blade', name: 'Blade', cost: 150 },
  { id: 'wheel_turbo', kind: 'wheel', value: 'turbo', name: 'Turbo', cost: 300, unlockLevel: 3 },
  { id: 'wheel_hex', kind: 'wheel', value: 'hex', name: 'Hex', cost: 450, unlockLevel: 5 },
  { id: 'wheel_star', kind: 'wheel', value: 'star', name: 'Star', cost: 700, unlockLevel: 7 },
  { id: 'trail_none', kind: 'trail', value: 'none', name: 'No Trail', cost: 0 },
  { id: 'trail_neon', kind: 'trail', value: 'neon', name: 'Neon Streak', cost: 0 },
  { id: 'trail_fire', kind: 'trail', value: 'fire', name: 'Afterburner', cost: 350, unlockLevel: 3 },
  { id: 'trail_ice', kind: 'trail', value: 'ice', name: 'Frost Trail', cost: 350, unlockLevel: 4 },
  { id: 'trail_rainbow', kind: 'trail', value: 'rainbow', name: 'Rainbow Road', cost: 900, unlockLevel: 6 },
  { id: 'trail_stars', kind: 'trail', value: 'stars', name: 'Stardust', cost: 1200, achievement: 'world_record' },
  { id: 'decal_none', kind: 'decal', value: 'none', name: 'Clean', cost: 0 },
  { id: 'decal_stripes', kind: 'decal', value: 'stripes', name: 'Racing Stripes', cost: 0 },
  { id: 'decal_number', kind: 'decal', value: 'number', name: 'Race Number', cost: 100 },
  { id: 'decal_checker', kind: 'decal', value: 'checker', name: 'Checker', cost: 200 },
  { id: 'decal_flames', kind: 'decal', value: 'flames', name: 'Flames', cost: 300, unlockLevel: 2 },
  { id: 'decal_lightning', kind: 'decal', value: 'lightning', name: 'Lightning', cost: 400, unlockLevel: 4 },
  { id: 'decal_hex', kind: 'decal', value: 'hex', name: 'Hex Mesh', cost: 500, unlockLevel: 6 },
  { id: 'decal_waves', kind: 'decal', value: 'waves', name: 'Sound Waves', cost: 600, unlockLevel: 8 },
  { id: 'effect_none', kind: 'effect', value: 'none', name: 'None', cost: 0 },
  { id: 'effect_sparkles', kind: 'effect', value: 'sparkles', name: 'Sparkles', cost: 250, unlockLevel: 2 },
  { id: 'effect_bubbles', kind: 'effect', value: 'bubbles', name: 'Bubbles', cost: 300, unlockLevel: 3 },
  { id: 'effect_embers', kind: 'effect', value: 'embers', name: 'Embers', cost: 450, unlockLevel: 5 },
  { id: 'effect_pixels', kind: 'effect', value: 'pixels', name: 'Pixels', cost: 600, unlockLevel: 7 },
  { id: 'effect_hearts', kind: 'effect', value: 'hearts', name: 'Hearts', cost: 800, achievement: 'ten_friends_beaten' },
];

export function isFreeCosmetic(item: CosmeticItem) { return item.cost === 0 && !item.unlockLevel && !item.achievement; }

export function sanitizeCarConfig(input: unknown): CarConfig {
  const c = (input && typeof input === 'object' ? input : {}) as Partial<CarConfig>;
  const hex = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback);
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  return {
    body: pick(c.body, ['viper', 'brute', 'phantom', 'formula', 'wedge', 'bolt'] as const, DEFAULT_CAR.body),
    paint: hex(c.paint, DEFAULT_CAR.paint),
    paint2: hex(c.paint2, DEFAULT_CAR.paint2),
    finish: pick(c.finish, ['gloss', 'metallic', 'matte'] as const, DEFAULT_CAR.finish),
    underglow: c.underglow === 'none' ? 'none' : hex(c.underglow, DEFAULT_CAR.underglow),
    tireColor: hex(c.tireColor, DEFAULT_CAR.tireColor),
    wheel: pick(c.wheel, ['classic', 'blade', 'turbo', 'hex', 'star'] as const, DEFAULT_CAR.wheel),
    trail: pick(c.trail, ['none', 'neon', 'fire', 'rainbow', 'stars', 'ice'] as const, DEFAULT_CAR.trail),
    decal: pick(c.decal, ['none', 'stripes', 'flames', 'checker', 'number', 'lightning', 'hex', 'waves'] as const, DEFAULT_CAR.decal),
    effect: pick(c.effect, ['none', 'sparkles', 'bubbles', 'embers', 'pixels', 'hearts'] as const, DEFAULT_CAR.effect),
    number: typeof c.number === 'number' && Number.isFinite(c.number) ? Math.max(0, Math.min(99, Math.floor(c.number))) : DEFAULT_CAR.number,
  };
}
