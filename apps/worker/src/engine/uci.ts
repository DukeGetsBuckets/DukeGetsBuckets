import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { logger } from "../logger";

export interface EngineLine {
  multipv: number;
  /** Centipawns from the side-to-move's point of view (null when mate). */
  cp: number | null;
  /** Mate in N moves from the side-to-move's point of view (positive = side to move mates). */
  mate: number | null;
  depth: number;
  pv: string[];
  nodes?: number;
}

export interface AnalysisResult {
  fen: string;
  lines: EngineLine[];
  bestMove: string | null;
  depth: number;
  timeMs: number;
}

export interface AnalyzeOptions {
  depth?: number;
  movetimeMs?: number;
  multipv?: number;
}

export interface EngineOptions {
  path: string;
  threads: number;
  hashMb: number;
}

/**
 * Thin, robust wrapper over a Stockfish UCI process. One analysis at a time per instance.
 * Stockfish is GPL-3.0; it runs as a separate process and is not linked into this code.
 */
export class StockfishEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lines: ((line: string) => void) | null = null;
  private ready: Promise<void> | null = null;
  private busy = false;
  private crashed = false;
  name = "Stockfish";
  version: string | null = null;

  constructor(private readonly opts: EngineOptions) {}

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.boot();
    return this.ready;
  }

  private async boot(): Promise<void> {
    const proc = spawn(this.opts.path, [], { stdio: "pipe" });
    this.proc = proc;
    this.crashed = false;
    proc.on("exit", (code, signal) => {
      logger.warn({ code, signal }, "stockfish exited");
      this.crashed = true;
      this.proc = null;
      this.ready = null;
    });
    proc.on("error", (err) => {
      logger.error({ err }, "stockfish spawn error");
      this.crashed = true;
    });
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.lines?.(line));
    proc.stderr.on("data", (d) => logger.debug({ stderr: String(d).trim() }, "stockfish stderr"));

    await this.command("uci", (line) => {
      const m = /^id name (.+)$/.exec(line);
      if (m) {
        this.name = m[1]!.trim();
        const v = /Stockfish\s+([\d.]+(?:-dev)?)/i.exec(this.name);
        this.version = v ? v[1]! : null;
      }
      return line === "uciok";
    });
    this.send(`setoption name Threads value ${this.opts.threads}`);
    this.send(`setoption name Hash value ${this.opts.hashMb}`);
    this.send("setoption name UCI_AnalyseMode value true");
    await this.command("isready", (line) => line === "readyok");
    logger.info({ engine: this.name, threads: this.opts.threads, hash: this.opts.hashMb }, "engine ready");
  }

  private send(cmd: string): void {
    if (!this.proc) throw new Error("Engine not running");
    this.proc.stdin.write(cmd + "\n");
  }

  private command(cmd: string, until: (line: string) => boolean, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lines = null;
        reject(new Error(`Engine timeout waiting for response to "${cmd.split(" ")[0]}"`));
      }, timeoutMs);
      this.lines = (line) => {
        if (until(line)) {
          clearTimeout(timer);
          this.lines = null;
          resolve();
        }
      };
      this.send(cmd);
    });
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async analyze(fen: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
    if (this.busy) throw new Error("Engine is busy");
    if (!this.proc || this.crashed) {
      this.ready = null;
      await this.start();
    }
    this.busy = true;
    const started = Date.now();
    const multipv = Math.max(1, options.multipv ?? 1);
    const depth = options.depth ?? 16;
    try {
      this.send("ucinewgame");
      await this.command("isready", (l) => l === "readyok");
      this.send(`setoption name MultiPV value ${multipv}`);
      this.send(`position fen ${fen}`);
      const byPv = new Map<number, EngineLine>();
      let bestMove: string | null = null;
      let reachedDepth = 0;
      const go = options.movetimeMs && options.movetimeMs > 0 ? `go movetime ${options.movetimeMs}` : `go depth ${depth}`;
      await this.command(
        go,
        (line) => {
          if (line.startsWith("info ")) {
            const parsed = parseInfo(line);
            if (parsed && parsed.pv.length) {
              // Keep the deepest line per multipv slot.
              const existing = byPv.get(parsed.multipv);
              if (!existing || parsed.depth >= existing.depth) byPv.set(parsed.multipv, parsed);
              reachedDepth = Math.max(reachedDepth, parsed.depth);
            }
            return false;
          }
          if (line.startsWith("bestmove")) {
            const m = /^bestmove (\S+)/.exec(line);
            bestMove = m && m[1] !== "(none)" ? m[1]! : null;
            return true;
          }
          return false;
        },
        Math.max(120_000, (options.movetimeMs ?? 0) * 3),
      );
      const lines = [...byPv.values()].sort((a, b) => a.multipv - b.multipv);
      return { fen, lines, bestMove, depth: reachedDepth, timeMs: Date.now() - started };
    } finally {
      this.busy = false;
    }
  }

  async quit(): Promise<void> {
    if (!this.proc) return;
    try {
      this.send("quit");
    } catch {
      /* ignore */
    }
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/** Parse a UCI `info` line into a structured engine line. Returns null for lines without a score/pv. */
export function parseInfo(line: string): EngineLine | null {
  const tokens = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let cp: number | null = null;
  let mate: number | null = null;
  let nodes: number | undefined;
  const pv: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t) {
      case "depth":
        depth = Number(tokens[++i]);
        break;
      case "multipv":
        multipv = Number(tokens[++i]);
        break;
      case "nodes":
        nodes = Number(tokens[++i]);
        break;
      case "score": {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        if (kind === "cp") cp = value;
        else if (kind === "mate") mate = value;
        // skip bound markers
        if (tokens[i + 1] === "lowerbound" || tokens[i + 1] === "upperbound") i++;
        break;
      }
      case "pv":
        for (let j = i + 1; j < tokens.length; j++) pv.push(tokens[j]!);
        i = tokens.length;
        break;
      default:
        break;
    }
  }
  if (cp == null && mate == null) return null;
  return { multipv, cp, mate, depth, pv, nodes };
}
