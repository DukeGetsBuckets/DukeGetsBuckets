// Progression data shared by the Worker (awards) and the client (display):
// achievement catalog, XP / coin reward tables, level curve and medal helpers.

import type { TrackMedals } from '../track/types';

export type AchievementId =
  | 'first_finish' | 'first_victory' | 'speed_demon' | 'perfect_run' | 'world_record' | 'races_100'
  | 'friends_beaten_10' | 'all_tracks' | 'all_gold' | 'author_medal' | 'daily_winner' | 'track_builder'
  | 'socialite' | 'school_spirit' | 'comeback';

export interface AchievementDef { id: AchievementId; name: string; description: string; icon: string }

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_finish', name: 'First Lap', description: 'Finish your first race.', icon: '🏁' },
  { id: 'first_victory', name: 'First Victory', description: 'Win a live multiplayer race.', icon: '🏆' },
  { id: 'speed_demon', name: 'Speed Demon', description: 'Reach a top speed of 300 km/h (83 m/s) in a finished run.', icon: '⚡' },
  { id: 'perfect_run', name: 'Perfect Run', description: 'Finish with zero respawns and a gold medal or better.', icon: '💎' },
  { id: 'world_record', name: 'World Record Holder', description: 'Set the fastest time in the world on any track.', icon: '🌍' },
  { id: 'races_100', name: '100 Races Completed', description: 'Complete 100 races.', icon: '💯' },
  { id: 'friends_beaten_10', name: '10 Friends Beaten', description: 'Beat the records of your friends ten times.', icon: '😎' },
  { id: 'all_tracks', name: 'Grand Tour', description: 'Finish every official track.', icon: '🗺️' },
  { id: 'all_gold', name: 'Golden Driver', description: 'Earn gold or better on every official track.', icon: '🥇' },
  { id: 'author_medal', name: "Author's Rival", description: 'Beat an author time.', icon: '✍️' },
  { id: 'daily_winner', name: 'Daily Champion', description: 'Finish rank 1 in a daily challenge.', icon: '📅' },
  { id: 'track_builder', name: 'Architect', description: 'Publish a track in the community hub.', icon: '🏗️' },
  { id: 'socialite', name: 'Squad Up', description: 'Add five friends.', icon: '🤝' },
  { id: 'school_spirit', name: 'School Spirit', description: 'Join a school.', icon: '🎓' },
  { id: 'comeback', name: 'Never Give Up', description: "Beat a friend's record by less than half a second.", icon: '🔥' },
];

export const ACHIEVEMENT_MAP: Record<string, AchievementDef> = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Older cosmetic definitions reference achievement ids by a different name. */
export const ACHIEVEMENT_ALIASES: Record<string, AchievementId> = { ten_friends_beaten: 'friends_beaten_10' };
export function resolveAchievementId(id: string): string { return ACHIEVEMENT_ALIASES[id] ?? id; }

export type Medal = 'author' | 'gold' | 'silver' | 'bronze';
export const MEDAL_ORDER: Medal[] = ['bronze', 'silver', 'gold', 'author'];
/** 0 = no medal, 1 = bronze … 4 = author. */
export const MEDAL_TIER: Record<Medal, number> = { bronze: 1, silver: 2, gold: 3, author: 4 };

export function medalFor(timeMs: number, medals: TrackMedals): Medal | null {
  if (timeMs <= medals.author) return 'author';
  if (timeMs <= medals.gold) return 'gold';
  if (timeMs <= medals.silver) return 'silver';
  if (timeMs <= medals.bronze) return 'bronze';
  return null;
}
export function medalTier(medal: Medal | null): number { return medal ? MEDAL_TIER[medal] : 0; }

export const XP_REWARDS = {
  finishBase: 50,
  finishPerDifficulty: 25,
  personalBest: 40,
  medal: { bronze: 20, silver: 40, gold: 80, author: 150 } as Record<Medal, number>,
  worldRecord: 300,
  rivalBeaten: 30,
  /** index = position - 1; later positions use the last entry */
  live: [100, 60, 40, 25],
  dailyParticipation: 60,
};

export const COIN_REWARDS = {
  finishBase: 20,
  finishPerDifficulty: 10,
  personalBest: 15,
  medal: { bronze: 25, silver: 50, gold: 100, author: 200 } as Record<Medal, number>,
  worldRecord: 400,
  live: [80, 50, 30, 15],
};

/** Community tracks count as this difficulty for rewards. */
export const COMMUNITY_DIFFICULTY = 2;

export function finishXp(difficulty: number): number { return XP_REWARDS.finishBase + difficulty * XP_REWARDS.finishPerDifficulty; }
export function finishCoins(difficulty: number): number { return COIN_REWARDS.finishBase + difficulty * COIN_REWARDS.finishPerDifficulty; }
export function liveXp(position: number): number { return XP_REWARDS.live[Math.min(XP_REWARDS.live.length, Math.max(1, position)) - 1]; }
export function liveCoins(position: number): number { return COIN_REWARDS.live[Math.min(COIN_REWARDS.live.length, Math.max(1, position)) - 1]; }

/** Level curve: level = floor(sqrt(xp / 60)) + 1. */
export function levelForXp(xp: number): number { return Math.floor(Math.sqrt(Math.max(0, xp) / 60)) + 1; }
/** Total XP required to reach `level`. */
export function xpForLevel(level: number): number { const l = Math.max(1, Math.floor(level)); return (l - 1) * (l - 1) * 60; }
/** Progress within the current level, for progress bars. */
export function levelProgress(xp: number): { level: number; current: number; needed: number; fraction: number } {
  const level = levelForXp(xp);
  const base = xpForLevel(level), next = xpForLevel(level + 1);
  return { level, current: xp - base, needed: next - base, fraction: Math.max(0, Math.min(1, (xp - base) / (next - base))) };
}
