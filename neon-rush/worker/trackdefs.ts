// Resolves a track id (official or community) to a TrackDefinition + a slim compiled
// form (gates / start / length only) used for validation and metadata. Cached per isolate.

import type { Env } from './index';
import { compileTrack } from '../shared/track/compile';
import { OFFICIAL_TRACK_MAP } from '../shared/track/officialTracks';
import type { CompiledTrack, GateInfo, Placement, ThemeId, TrackDefinition, TrackMedals } from '../shared/track/types';
import { hashString } from '../shared/math';
import { one, parseJson, type TrackRow } from './db';

export interface SlimCompiled {
  length: number;
  start: CompiledTrack['start'];
  checkpoints: GateInfo[];
  gates: GateInfo[];
  issues: string[];
}

export interface LoadedTrack {
  def: TrackDefinition;
  compiled: SlimCompiled;
  official: boolean;
  row: TrackRow | null;
}

export const THEME_IDS: ThemeId[] = ['neonCity', 'skyIslands', 'sunsetCanyon', 'cyberVoid', 'tropicalRush', 'crystalMountains'];
export function isThemeId(v: unknown): v is ThemeId { return typeof v === 'string' && (THEME_IDS as string[]).includes(v); }

export function slimCompile(pieces: Placement[]): SlimCompiled {
  const c = compileTrack({ pieces });
  return { length: c.length, start: c.start, checkpoints: c.checkpoints, gates: c.gates, issues: c.issues };
}

const officialCache = new Map<string, SlimCompiled>();
const communityCache = new Map<string, SlimCompiled>();

export function compiledOfficial(id: string): SlimCompiled | null {
  const def = OFFICIAL_TRACK_MAP[id];
  if (!def) return null;
  let c = officialCache.get(id);
  if (!c) { c = slimCompile(def.pieces); officialCache.set(id, c); }
  return c;
}

function compiledCommunity(row: TrackRow, placements: Placement[]): SlimCompiled {
  const key = `${row.id}:${row.updated_at}`;
  let c = communityCache.get(key);
  if (!c) {
    c = slimCompile(placements);
    if (communityCache.size >= 32) communityCache.delete(communityCache.keys().next().value as string);
    communityCache.set(key, c);
  }
  return c;
}

/** Medals for a community track derived from the author's validated time. */
export function communityMedals(authorTimeMs: number | null, lengthM: number): TrackMedals {
  const author = authorTimeMs && authorTimeMs > 0 ? authorTimeMs : Math.round((lengthM / 35) * 1000);
  return { author, gold: Math.round(author * 1.1), silver: Math.round(author * 1.25), bronze: Math.round(author * 1.5) };
}

export function placementsOf(row: TrackRow): Placement[] {
  const arr = parseJson<unknown>(row.placements, []);
  return Array.isArray(arr) ? (arr as Placement[]) : [];
}

export function definitionFromRow(row: TrackRow, authorName: string, placements = placementsOf(row)): TrackDefinition {
  return {
    id: row.id,
    name: row.name,
    theme: isThemeId(row.theme) ? row.theme : 'neonCity',
    difficulty: 2,
    description: row.description ?? '',
    author: authorName,
    pieces: placements,
    medals: communityMedals(row.author_time_ms, row.length_m),
    seed: hashString(row.id),
    official: false,
  };
}

export async function loadTrackRow(env: Env, id: string): Promise<TrackRow | null> {
  return one<TrackRow>(env.DB, 'SELECT * FROM tracks WHERE id = ?', id);
}

/**
 * Loads an official or community track. Community drafts are only visible to their author
 * (pass `viewerId`); published tracks are visible to everyone.
 */
export async function loadTrack(env: Env, trackId: string, viewerId: string | null = null): Promise<LoadedTrack | null> {
  const official = OFFICIAL_TRACK_MAP[trackId];
  if (official) return { def: official, compiled: compiledOfficial(trackId)!, official: true, row: null };
  const row = await loadTrackRow(env, trackId);
  if (!row) return null;
  if (!row.published && row.author_id !== viewerId) return null;
  const author = await one<{ name: string }>(env.DB, 'SELECT name FROM players WHERE id = ?', row.author_id);
  const placements = placementsOf(row);
  return { def: definitionFromRow(row, author?.name ?? 'Unknown', placements), compiled: compiledCommunity(row, placements), official: false, row };
}

/** Display name of a track, for notification texts. */
export async function trackName(env: Env, trackId: string): Promise<string> {
  const official = OFFICIAL_TRACK_MAP[trackId];
  if (official) return official.name;
  const row = await one<{ name: string }>(env.DB, 'SELECT name FROM tracks WHERE id = ?', trackId);
  return row?.name ?? 'a track';
}

export function isOfficial(trackId: string): boolean { return !!OFFICIAL_TRACK_MAP[trackId]; }
