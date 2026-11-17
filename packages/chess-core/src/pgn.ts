import { Chess } from "chess.js";
import { START_FEN, applyUci } from "./rules";

export interface PgnOptions {
  event?: string;
  site?: string;
  date?: Date;
  round?: string;
  white: string;
  black: string;
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  whiteElo?: number | null;
  blackElo?: number | null;
  timeControl?: string;
  termination?: string;
  eco?: string | null;
  opening?: string | null;
  initialFen?: string;
  /** SAN moves in order. */
  sans: string[];
  /** Optional per-move clock comments in milliseconds (remaining after the move). */
  clocksMs?: number[];
  /** Optional per-move evaluations (centipawns, white POV) for annotated exports. */
  evals?: (number | null | undefined)[];
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function formatPgnDate(d: Date): string {
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

export function clockComment(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `[%clk ${h}:${pad(m)}:${pad(s)}]`;
}

export function resultString(result: "WHITE_WINS" | "BLACK_WINS" | "DRAW" | null | undefined): PgnOptions["result"] {
  if (result === "WHITE_WINS") return "1-0";
  if (result === "BLACK_WINS") return "0-1";
  if (result === "DRAW") return "1/2-1/2";
  return "*";
}

export function buildPgn(opts: PgnOptions): string {
  const headers: [string, string][] = [
    ["Event", opts.event ?? "Casual game"],
    ["Site", opts.site ?? "Tempo"],
    ["Date", formatPgnDate(opts.date ?? new Date())],
    ["Round", opts.round ?? "-"],
    ["White", opts.white],
    ["Black", opts.black],
    ["Result", opts.result],
  ];
  if (opts.whiteElo != null) headers.push(["WhiteElo", String(Math.round(opts.whiteElo))]);
  if (opts.blackElo != null) headers.push(["BlackElo", String(Math.round(opts.blackElo))]);
  if (opts.timeControl) headers.push(["TimeControl", opts.timeControl]);
  if (opts.termination) headers.push(["Termination", opts.termination]);
  if (opts.eco) headers.push(["ECO", opts.eco]);
  if (opts.opening) headers.push(["Opening", opts.opening]);
  if (opts.initialFen && opts.initialFen !== START_FEN) {
    headers.push(["SetUp", "1"]);
    headers.push(["FEN", opts.initialFen]);
  }
  const lines = headers.map(([k, v]) => `[${k} "${v.replace(/"/g, '\\"')}"]`);
  const tokens: string[] = [];
  let moveNumber = 1;
  let whiteToMove = true;
  if (opts.initialFen && opts.initialFen !== START_FEN) {
    const parts = opts.initialFen.split(" ");
    whiteToMove = parts[1] !== "b";
    moveNumber = Number(parts[5] ?? 1);
    if (!whiteToMove) tokens.push(`${moveNumber}...`);
  }
  opts.sans.forEach((san, i) => {
    if (whiteToMove) tokens.push(`${moveNumber}.`);
    let token = san;
    const comments: string[] = [];
    const ev = opts.evals?.[i];
    if (ev != null) comments.push(`[%eval ${(ev / 100).toFixed(2)}]`);
    const clk = opts.clocksMs?.[i];
    if (clk != null) comments.push(clockComment(clk));
    if (comments.length) token += ` { ${comments.join(" ")} }`;
    tokens.push(token);
    if (!whiteToMove) moveNumber++;
    whiteToMove = !whiteToMove;
  });
  tokens.push(opts.result);
  // wrap movetext at ~80 columns
  const body: string[] = [];
  let current = "";
  for (const t of tokens) {
    if ((current + " " + t).trim().length > 80) {
      body.push(current.trim());
      current = t;
    } else {
      current = `${current} ${t}`;
    }
  }
  if (current.trim()) body.push(current.trim());
  return `${lines.join("\n")}\n\n${body.join("\n")}\n`;
}

export interface ParsedPgn {
  headers: Record<string, string>;
  sans: string[];
  ucis: string[];
  fens: string[];
  initialFen: string;
}

/** Parse a PGN (single game) into SAN/UCI lists using chess.js. Throws on invalid input. */
export function parsePgn(pgn: string): ParsedPgn {
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: false });
  const headers = chess.getHeaders();
  const initialFen = headers["FEN"] ?? START_FEN;
  const history = chess.history({ verbose: true });
  const replay = new Chess(initialFen);
  const fens = [replay.fen()];
  const ucis: string[] = [];
  const sans: string[] = [];
  for (const m of history) {
    const uci = `${m.from}${m.to}${m.promotion ?? ""}`;
    const applied = applyUci(replay, uci);
    if (!applied) throw new Error(`Illegal move in PGN: ${m.san}`);
    ucis.push(uci);
    sans.push(applied.san);
    fens.push(applied.fenAfter);
  }
  return { headers, sans, ucis, fens, initialFen };
}
