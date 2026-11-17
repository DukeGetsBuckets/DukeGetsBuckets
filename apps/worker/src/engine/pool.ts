import { StockfishEngine, type AnalysisResult, type AnalyzeOptions, type EngineOptions } from "./uci";

/** Bounded set of engine processes so analysis can never exhaust the host. */
export class EnginePool {
  private readonly engines: StockfishEngine[] = [];
  private readonly waiters: ((e: StockfishEngine) => void)[] = [];

  constructor(
    private readonly size: number,
    private readonly opts: EngineOptions,
  ) {}

  async start(): Promise<StockfishEngine> {
    for (let i = 0; i < this.size; i++) {
      const e = new StockfishEngine(this.opts);
      await e.start();
      this.engines.push(e);
    }
    return this.engines[0]!;
  }

  private acquire(): Promise<StockfishEngine> {
    const free = this.engines.find((e) => !e.isBusy && !this.reserved.has(e));
    if (free) {
      this.reserved.add(free);
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  private readonly reserved = new Set<StockfishEngine>();

  private release(e: StockfishEngine): void {
    const next = this.waiters.shift();
    if (next) next(e);
    else this.reserved.delete(e);
  }

  async analyze(fen: string, options: AnalyzeOptions): Promise<AnalysisResult> {
    const engine = await this.acquire();
    try {
      return await engine.analyze(fen, options);
    } finally {
      this.release(engine);
    }
  }

  get info(): { name: string; version: string | null } {
    const e = this.engines[0];
    return { name: e?.name ?? "Stockfish", version: e?.version ?? null };
  }

  async quit(): Promise<void> {
    await Promise.all(this.engines.map((e) => e.quit()));
  }
}
