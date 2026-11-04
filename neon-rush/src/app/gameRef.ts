import type { Game } from '@game/Game';
import { OFFICIAL_TRACKS } from '@shared/track/officialTracks';
import { getAudio } from '@game/audio/audio';
(window as unknown as { __neonrushAudio?: unknown }).__neonrushAudio = getAudio();
(window as unknown as { __neonrushTracks?: unknown }).__neonrushTracks = OFFICIAL_TRACKS;
let gameInstance: Game | null = null;
export function setGame(g: Game | null) { gameInstance = g; (window as unknown as { __neonrush?: Game | null }).__neonrush = g; }
export function getGame(): Game { if (!gameInstance) throw new Error('Game not ready'); return gameInstance; }
export function tryGame(): Game | null { return gameInstance; }
