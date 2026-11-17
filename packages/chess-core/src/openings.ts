import { Chess } from "chess.js";
import { START_FEN, applyUci, positionKey } from "./rules";
import rawData from "./openings-data.json";

export interface Opening {
  eco: string;
  name: string;
  /** SAN moves of the reference line. */
  moves: string[];
  /** Position key (FEN without counters) at the end of the reference line. */
  epd: string;
  plies: number;
}

type Row = [string, string, string, string, number];

let byPosition: Map<string, Opening> | null = null;
let all: Opening[] | null = null;

function load(): { byPosition: Map<string, Opening>; all: Opening[] } {
  if (byPosition && all) return { byPosition, all };
  all = (rawData as Row[]).map(([eco, name, moves, epd, plies]) => ({ eco, name, moves: moves.split(" "), epd, plies }));
  byPosition = new Map();
  for (const o of all) {
    // Prefer the shorter line for identical positions (more canonical name).
    const existing = byPosition.get(o.epd);
    if (!existing || o.plies < existing.plies) byPosition.set(o.epd, o);
  }
  return { byPosition, all };
}

/** Look up the opening that exactly matches this position (by EPD), if any. */
export function openingForPosition(fen: string): Opening | null {
  return load().byPosition.get(positionKey(fen)) ?? null;
}

/**
 * Identify the opening of a game from its UCI moves: the deepest position along the game that
 * exists in the database wins. This naturally handles transpositions.
 * Returns the opening plus the ply at which it was last matched.
 */
export function identifyOpening(ucis: string[], initialFen: string = START_FEN): { opening: Opening; ply: number } | null {
  if (initialFen !== START_FEN) return null;
  const chess = new Chess(initialFen);
  let best: { opening: Opening; ply: number } | null = null;
  const maxPlies = Math.min(ucis.length, 40);
  for (let i = 0; i < maxPlies; i++) {
    const uci = ucis[i]!;
    if (!applyUci(chess, uci)) break;
    const o = openingForPosition(chess.fen());
    if (o) best = { opening: o, ply: i + 1 };
  }
  return best;
}

/** Whether a position is part of known opening theory (used for "Book" move classification). */
export function isBookPosition(fen: string): boolean {
  return load().byPosition.has(positionKey(fen));
}

export function searchOpenings(query: string, limit = 20): Opening[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return load()
    .all.filter((o) => o.name.toLowerCase().includes(q) || o.eco.toLowerCase() === q)
    .slice(0, limit);
}

/** A family name like "Sicilian Defense" from "Sicilian Defense: Najdorf Variation". */
export function openingFamily(name: string): string {
  return name.split(":")[0]!.trim();
}
