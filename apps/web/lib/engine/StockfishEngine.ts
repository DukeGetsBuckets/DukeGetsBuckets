import { parseBestMove, parseEloOption, parseInfoLine, type InfoLine, type UciScore } from "./uci";

/**
 * Stockfish running on the device in a Web Worker (stockfish.js "lite single-threaded" build: ≈1.8 MB,
 * no cross-origin isolation needed, works in iPad Safari). Searches are serialised: a new search waits
 * for the previous one to finish (or be stopped) before the engine is reconfigured.
 */

export const ENGINE_URL = "/engine/stockfish-19-lite-single.js";

export interface EngineLine {
  multipv: number;
  /** First move of the line. */
  uci: string;
  pv: string[];
  /** Side-to-move point of view, as reported by UCI. */
  score: UciScore;
  depth: number;
}

export interface SearchSnapshot {
  depth: number;
  nodes: number;
  nps: number;
  /** Ordered by rank (multipv 1 first). */
  lines: EngineLine[];
}

export interface SearchResult extends SearchSnapshot {
  bestmove: string | null;
  aborted: boolean;
  elapsedMs: number;
}

export interface SearchOptions {
  fen: string;
  movetimeMs: number;
  multipv: number;
  /** Playing strength via UCI_LimitStrength/UCI_Elo; null searches at full strength. */
  elo: number | null;
  onUpdate?: (snap: SearchSnapshot) => void;
  signal?: AbortSignal;
}

type Listener = (line: string) => void;

/** Side-to-move score as one comparable number (mates beyond any centipawn value, nearer mates better). */
export function scoreValue(s: UciScore): number {
  if (s.mate != null && s.mate !== 0) return s.mate > 0 ? 100_000 - s.mate : -100_000 - s.mate;
  if (s.mate === 0) return -100_000;
  return s.cp ?? 0;
}

/**
 * Candidate lines from the deepest depth at which every line was reported, best first, with
 * `multipv` renumbered as the rank. Exported for tests.
 */
export function rankedLines(byDepth: Map<number, Map<string, EngineLine>>, multipv: number): EngineLine[] {
  let full = 0;
  for (const m of byDepth.values()) full = Math.max(full, m.size);
  full = Math.min(full, multipv);
  let best: Map<string, EngineLine> | null = null;
  let bestDepth = -1;
  for (const [d, m] of byDepth) {
    if (m.size >= full && d > bestDepth) {
      best = m;
      bestDepth = d;
    }
  }
  if (!best) return [];
  return [...best.values()]
    .sort((a, b) => scoreValue(b.score) - scoreValue(a.score))
    .slice(0, multipv)
    .map((l, i) => ({ ...l, multipv: i + 1 }));
}

export class StockfishEngine {
  private worker: Worker | null = null;
  private listeners = new Set<Listener>();
  private readyPromise: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private configuredElo: number | null | undefined = undefined;
  private configuredMultiPv = 0;
  private terminated = false;
  eloRange = { min: 1320, max: 3190 };

  constructor(private readonly url: string = ENGINE_URL) {}

  /** Loads the engine (downloads the wasm on first use) and completes the UCI handshake. */
  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.boot().catch((err) => {
        this.readyPromise = null;
        this.worker?.terminate();
        this.worker = null;
        throw err;
      });
    }
    return this.readyPromise;
  }

  private async boot(): Promise<void> {
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") throw new Error("This browser cannot run the engine (no Web Worker / WebAssembly support).");
    const worker = new Worker(this.url);
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data ?? "");
      for (const line of data.split("\n")) {
        if (!line) continue;
        for (const l of [...this.listeners]) l(line);
      }
    };
    const failed = new Promise<never>((_, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || "The engine failed to load."));
    });
    failed.catch(() => undefined); // a late worker error must not surface as an unhandled rejection
    const options: string[] = [];
    const collect: Listener = (line) => {
      if (line.startsWith("option ")) options.push(line);
    };
    this.listeners.add(collect);
    try {
      await Promise.race([this.sendAndWait("uci", (l) => l === "uciok", 30_000), failed]);
    } finally {
      this.listeners.delete(collect);
    }
    for (const o of options) {
      const r = parseEloOption(o);
      if (r) this.eloRange = r;
    }
    this.post("setoption name Hash value 32");
    await Promise.race([this.sendAndWait("isready", (l) => l === "readyok", 15_000), failed]);
  }

  private post(cmd: string) {
    if (!this.worker) throw new Error("Engine not loaded");
    this.worker.postMessage(cmd);
  }

  private sendAndWait(cmd: string, done: (line: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Engine did not answer "${cmd}" in time.`));
      }, timeoutMs);
      const listener: Listener = (line) => {
        if (!done(line)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(line);
      };
      this.listeners.add(listener);
      this.post(cmd);
    });
  }

  /** Clears the engine's hash/history between games. */
  newGame(): Promise<void> {
    return this.enqueue(async () => {
      await this.ready();
      this.post("ucinewgame");
      await this.sendAndWait("isready", (l) => l === "readyok", 15_000);
    });
  }

  search(opts: SearchOptions): Promise<SearchResult> {
    return this.enqueue(() => this.runSearch(opts));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runSearch(opts: SearchOptions): Promise<SearchResult> {
    const started = Date.now();
    const empty = (aborted: boolean): SearchResult => ({ depth: 0, nodes: 0, nps: 0, lines: [], bestmove: null, aborted, elapsedMs: Date.now() - started });
    if (opts.signal?.aborted || this.terminated) return empty(true);
    await this.ready();
    if (opts.signal?.aborted || this.terminated) return empty(true);

    if (opts.elo !== this.configuredElo) {
      if (opts.elo == null) {
        this.post("setoption name UCI_LimitStrength value false");
      } else {
        const elo = Math.max(this.eloRange.min, Math.min(this.eloRange.max, Math.round(opts.elo)));
        this.post("setoption name UCI_LimitStrength value true");
        this.post(`setoption name UCI_Elo value ${elo}`);
      }
      this.configuredElo = opts.elo;
    }
    if (opts.multipv !== this.configuredMultiPv) {
      this.post(`setoption name MultiPV value ${opts.multipv}`);
      this.configuredMultiPv = opts.multipv;
    }
    await this.sendAndWait("isready", (l) => l === "readyok", 15_000);

    // Lines are grouped by the depth they were reported at. When the time limit stops a MultiPV search
    // part-way through an iteration, some lines are a ply deeper than others (and Stockfish lists them
    // by search order, not score), so candidates always come from the deepest *complete* depth and are
    // ranked by score.
    const byDepth = new Map<number, Map<string, EngineLine>>();
    let depth = 0;
    let nodes = 0;
    let nps = 0;
    let lastEmit = 0;
    let pendingEmit: ReturnType<typeof setTimeout> | null = null;
    const snapshot = (): SearchSnapshot => ({ depth, nodes, nps, lines: rankedLines(byDepth, opts.multipv) });
    const emit = () => {
      pendingEmit = null;
      lastEmit = Date.now();
      opts.onUpdate?.(snapshot());
    };
    const onInfo = (info: InfoLine) => {
      if (info.bound) return; // fail-high/low scores are not exact; wait for the resolved line
      let atDepth = byDepth.get(info.depth);
      if (!atDepth) byDepth.set(info.depth, (atDepth = new Map()));
      atDepth.set(info.pv[0]!, { multipv: info.multipv, uci: info.pv[0]!, pv: info.pv, score: info.score, depth: info.depth });
      depth = Math.max(depth, info.depth);
      if (info.nodes != null) nodes = info.nodes;
      if (info.nps != null) nps = info.nps;
      if (!opts.onUpdate) return;
      // Throttle UI updates to ~8 per second.
      const wait = 120 - (Date.now() - lastEmit);
      if (wait <= 0) emit();
      else if (!pendingEmit) pendingEmit = setTimeout(emit, wait);
    };

    const onAbort = () => this.worker?.postMessage("stop");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const infoListener: Listener = (line) => {
      const info = parseInfoLine(line);
      if (info) onInfo(info);
    };
    this.listeners.add(infoListener);
    try {
      this.post(`position fen ${opts.fen}`);
      const bestLine = await this.sendAndWait(`go movetime ${Math.max(50, Math.round(opts.movetimeMs))}`, (l) => l.startsWith("bestmove"), opts.movetimeMs + 15_000);
      if (pendingEmit) clearTimeout(pendingEmit);
      const parsed = parseBestMove(bestLine);
      const result: SearchResult = { ...snapshot(), bestmove: parsed?.best ?? null, aborted: Boolean(opts.signal?.aborted), elapsedMs: Date.now() - started };
      if (!result.aborted) opts.onUpdate?.(snapshot());
      return result;
    } finally {
      if (pendingEmit) clearTimeout(pendingEmit);
      this.listeners.delete(infoListener);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  terminate() {
    this.terminated = true;
    this.worker?.terminate();
    this.worker = null;
    this.listeners.clear();
  }
}
