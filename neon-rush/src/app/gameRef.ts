import type { Game } from '@game/Game';
let gameInstance: Game | null = null;
export function setGame(g: Game | null) { gameInstance = g; (window as unknown as { __neonrush?: Game | null }).__neonrush = g; }
export function getGame(): Game { if (!gameInstance) throw new Error('Game not ready'); return gameInstance; }
export function tryGame(): Game | null { return gameInstance; }
