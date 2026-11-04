// Awards: XP / coins / achievements applied to a Player, plus the shop endpoint.

import type { Env } from './index';
import type { BuyResponse } from '../shared/api';
import { COSMETICS, PAINT_COLORS, DEFAULT_CAR, isFreeCosmetic, type CarConfig, type CosmeticItem } from '../shared/game/carConfig';
import { ACHIEVEMENT_MAP, levelForXp, resolveAchievementId, type AchievementId } from '../shared/game/progression';
import { batch } from './db';
import { badRequest, forbidden, conflict, ApiError, asObject, uuid } from './http';
import { buildProfile, hasAchievement, savePlayer, type Player } from './players';
import { requireAuth } from './auth';
import type { Ctx } from './api';

/** Mutable award accumulator for one request. */
export interface Awards { xp: number; coins: number; achievements: string[] }
export const newAwards = (): Awards => ({ xp: 0, coins: 0, achievements: [] });

export function grant(p: Player, awards: Awards, xp: number, coins: number): void {
  awards.xp += xp;
  awards.coins += coins;
  p.xp += xp;
  p.coins += coins;
}

/** Unlocks an achievement once; returns true when it was newly unlocked. */
export function unlock(p: Player, awards: Awards, id: AchievementId, now = Date.now()): boolean {
  if (!ACHIEVEMENT_MAP[id] || hasAchievement(p, id)) return false;
  p.achievements.push({ id, unlockedAt: now });
  awards.achievements.push(id);
  return true;
}

/** Level before/after helper: returns the new level when the player leveled up. */
export function levelUp(xpBefore: number, xpAfter: number): number | null {
  const before = levelForXp(xpBefore), after = levelForXp(xpAfter);
  return after > before ? after : null;
}

/** Persists the player and inserts one 'achievement' notification per newly unlocked achievement. */
export async function commitAwards(env: Env, p: Player, awards: Awards, now = Date.now()): Promise<void> {
  await savePlayer(env, p);
  if (!awards.achievements.length) return;
  await batch(env.DB, awards.achievements.map((id) => {
    const def = ACHIEVEMENT_MAP[id];
    return env.DB
      .prepare('INSERT INTO notifications (id, player_id, kind, text, track_id, from_player_id, created_at, is_read) VALUES (?, ?, ?, ?, NULL, NULL, ?, 0)')
      .bind(uuid(), p.id, 'achievement', `Achievement unlocked: ${def.icon} ${def.name}`, now);
  }));
}

/* ---------- cosmetics ---------- */

const paintItemId = (hex: string) => `paint_${hex.toLowerCase().replace('#', '')}`;

function paintItem(itemId: string): CosmeticItem | null {
  const m = /^paint_#?([0-9a-fA-F]{6})$/.exec(itemId);
  if (!m) return null;
  const hex = `#${m[1].toLowerCase()}`;
  const color = PAINT_COLORS.find((c) => c.value === hex);
  if (!color) return null;
  return { id: paintItemId(hex), kind: 'paint', value: hex, name: color.name, cost: color.cost };
}

export function findCosmetic(itemId: string): CosmeticItem | null {
  return COSMETICS.find((i) => i.id === itemId) ?? paintItem(itemId);
}

export function ownsCosmetic(p: Player, item: CosmeticItem): boolean {
  return isFreeCosmetic(item) || p.unlocked.includes(item.id);
}

/**
 * Returns the id of the first car part the player does not own, or null when the car is fully owned.
 * Anything on the DEFAULT_CAR is always allowed, so a fresh player can save the stock car.
 */
export function checkCarOwnership(p: Player, car: CarConfig): string | null {
  const parts: [CosmeticItem['kind'], string, string][] = [
    ['body', car.body, DEFAULT_CAR.body], ['finish', car.finish, DEFAULT_CAR.finish], ['wheel', car.wheel, DEFAULT_CAR.wheel],
    ['trail', car.trail, DEFAULT_CAR.trail], ['decal', car.decal, DEFAULT_CAR.decal], ['effect', car.effect, DEFAULT_CAR.effect],
  ];
  for (const [kind, value, def] of parts) {
    if (value === def) continue;
    const item = COSMETICS.find((i) => i.kind === kind && i.value === value);
    if (item && !ownsCosmetic(p, item)) return item.id;
  }
  const defaultPaints = [DEFAULT_CAR.paint, DEFAULT_CAR.paint2, DEFAULT_CAR.underglow, DEFAULT_CAR.tireColor];
  for (const hex of [car.paint, car.paint2]) {
    if (defaultPaints.includes(hex)) continue;
    const color = PAINT_COLORS.find((c) => c.value === hex.toLowerCase());
    if (color && color.cost > 0 && !p.unlocked.includes(paintItemId(hex))) return paintItemId(hex);
  }
  return null;
}

/* ---------- POST /api/shop/buy ---------- */

export async function shopBuy(c: Ctx): Promise<BuyResponse> {
  const p = await requireAuth(c.request, c.env);
  const body = asObject(await c.body());
  const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
  const item = findCosmetic(itemId);
  if (!item) throw badRequest('Unknown item', 'unknown_item');
  if (isFreeCosmetic(item)) return { player: await buildProfile(c.env, p), item: item.id };
  if (p.unlocked.includes(item.id)) throw conflict('You already own this item', 'already_owned');
  const level = levelForXp(p.xp);
  if (item.unlockLevel && level < item.unlockLevel) throw forbidden(`Requires level ${item.unlockLevel}`, 'level_required');
  if (item.achievement && !hasAchievement(p, resolveAchievementId(item.achievement))) {
    const def = ACHIEVEMENT_MAP[resolveAchievementId(item.achievement)];
    throw forbidden(`Requires the ${def?.name ?? item.achievement} achievement`, 'achievement_required');
  }
  if (p.coins < item.cost) throw new ApiError(402, `Not enough coins (${item.cost} needed)`, 'insufficient_coins');
  p.coins -= item.cost;
  p.unlocked.push(item.id);
  await savePlayer(c.env, p);
  return { player: await buildProfile(c.env, p), item: item.id };
}
