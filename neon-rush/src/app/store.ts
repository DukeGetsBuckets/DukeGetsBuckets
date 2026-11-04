import { create } from 'zustand';
import type { TrackDefinition } from '@shared/track/types';
import type { CarConfig } from '@shared/game/carConfig';
import { DEFAULT_CAR } from '@shared/game/carConfig';
import type { CameraMode } from '@game/camera/cameraRig';
import type { QualityLevel } from '@game/render/renderer';

export type Screen = 'loading' | 'menu' | 'tracks' | 'race' | 'garage' | 'leaderboards' | 'multiplayer' | 'builder' | 'profile' | 'settings' | 'daily' | 'community';
export type RaceMode = 'solo' | 'live' | 'daily' | 'test';

export interface Banner { id: number; text: string; sub?: string; kind: 'info' | 'pb' | 'wr' | 'checkpoint' | 'warn' | 'rival'; }

export interface Settings {
  quality: QualityLevel | 'auto';
  music: number;
  sfx: number;
  touchSensitivity: number;
  showGhost: boolean;
  showTouchControls: 'auto' | 'on' | 'off';
  cameraMode: CameraMode;
}

export interface RaceResult {
  timeMs: number;
  splits: number[];
  isPb: boolean;
  prevPb: number | null;
  medal: 'author' | 'gold' | 'silver' | 'bronze' | null;
  rank?: number | null;
  xp?: number;
  coins?: number;
  worldRecord?: boolean;
  achievements?: string[];
  rivalBeaten?: string[];
}

interface AppState {
  screen: Screen;
  prevScreen: Screen;
  track: TrackDefinition | null;
  raceMode: RaceMode;
  carConfig: CarConfig;
  settings: Settings;
  banners: Banner[];
  paused: boolean;
  result: RaceResult | null;
  countdown: number;
  showCountdown: boolean;
  loadingMessage: string;
  isTouch: boolean;
  online: boolean;
  setScreen: (s: Screen) => void;
  setTrack: (t: TrackDefinition | null) => void;
  setRaceMode: (m: RaceMode) => void;
  setCarConfig: (c: CarConfig) => void;
  setSettings: (s: Partial<Settings>) => void;
  pushBanner: (b: Omit<Banner, 'id'>) => void;
  popBanner: (id: number) => void;
  setPaused: (p: boolean) => void;
  setResult: (r: RaceResult | null) => void;
  setCountdown: (n: number, show: boolean) => void;
  setLoading: (m: string) => void;
  setOnline: (o: boolean) => void;
}

const SETTINGS_KEY = 'neonrush.settings.v1';
const CAR_KEY = 'neonrush.car.v1';

function loadJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } : fallback; } catch { return fallback; }
}

const defaultSettings: Settings = { quality: 'auto', music: 0.6, sfx: 0.8, touchSensitivity: 1, showGhost: true, showTouchControls: 'auto', cameraMode: 'chase' };
let bannerId = 1;

export const useStore = create<AppState>((set, get) => ({
  screen: 'loading',
  prevScreen: 'menu',
  track: null,
  raceMode: 'solo',
  carConfig: loadJson(CAR_KEY, DEFAULT_CAR),
  settings: loadJson(SETTINGS_KEY, defaultSettings),
  banners: [],
  paused: false,
  result: null,
  countdown: 0,
  showCountdown: false,
  loadingMessage: 'Warming up engines…',
  isTouch: typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window),
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  setScreen: (s) => set((st) => ({ screen: s, prevScreen: st.screen })),
  setTrack: (track) => set({ track }),
  setRaceMode: (raceMode) => set({ raceMode }),
  setCarConfig: (carConfig) => { localStorage.setItem(CAR_KEY, JSON.stringify(carConfig)); set({ carConfig }); },
  setSettings: (s) => { const settings = { ...get().settings, ...s }; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); set({ settings }); },
  pushBanner: (b) => {
    const id = bannerId++;
    set((st) => ({ banners: [...st.banners.slice(-3), { ...b, id }] }));
    setTimeout(() => get().popBanner(id), b.kind === 'wr' ? 4200 : 2600);
  },
  popBanner: (id) => set((st) => ({ banners: st.banners.filter((x) => x.id !== id) })),
  setPaused: (paused) => set({ paused }),
  setResult: (result) => set({ result }),
  setCountdown: (countdown, showCountdown) => set({ countdown, showCountdown }),
  setLoading: (loadingMessage) => set({ loadingMessage }),
  setOnline: (online) => set({ online }),
}));
