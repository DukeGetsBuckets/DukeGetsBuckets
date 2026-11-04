// Author tracks by chaining pieces: each piece is placed at the previous piece's exit.
import { rotYQuarter } from '../math';
import { getPiece } from './pieces';
import type { Placement } from './types';

export interface Cursor { x: number; y: number; z: number; rot: number }
export type ChainItem = string | { type: string; walls?: boolean };

export function advanceCursor(cursor: Cursor, type: string): Cursor {
  const def = getPiece(type);
  const e = rotYQuarter({ x: def.exit.x, y: def.exit.y, z: def.exit.z }, cursor.rot);
  return {
    x: Math.round((cursor.x + e.x) * 1000) / 1000,
    y: Math.round((cursor.y + e.y) * 1000) / 1000,
    z: Math.round((cursor.z + e.z) * 1000) / 1000,
    rot: (((cursor.rot + def.exit.rot) % 4) + 4) % 4,
  };
}

export function chain(start: Cursor, items: ChainItem[]): Placement[] {
  let cur = { ...start };
  const out: Placement[] = [];
  for (const item of items) {
    const type = typeof item === 'string' ? item : item.type;
    const walls = typeof item === 'string' ? undefined : item.walls;
    out.push({ type, x: cur.x, y: cur.y, z: cur.z, rot: cur.rot, ...(walls ? { walls: true } : {}) });
    cur = advanceCursor(cur, type);
  }
  return out;
}

/** Cursor at the end of a placement list (where the next piece would go). */
export function endCursor(pieces: Placement[]): Cursor {
  if (!pieces.length) return { x: 0, y: 0, z: 0, rot: 0 };
  const last = pieces[pieces.length - 1];
  return advanceCursor({ x: last.x, y: last.y, z: last.z, rot: last.rot }, last.type);
}
