/** Minimal per-key async mutex to serialize actions on the same game. */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.chains.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === chained) this.chains.delete(key);
    }
  }
}
