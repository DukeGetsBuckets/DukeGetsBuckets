/** In-memory sliding-window rate limiter keyed by user + action. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly rules: Record<string, { max: number; windowMs: number }>) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Returns true when the action is allowed. */
  allow(userId: string, action: string): boolean {
    const rule = this.rules[action];
    if (!rule) return true;
    const key = `${userId}:${action}`;
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < rule.windowMs);
    if (list.length >= rule.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, list] of this.hits) {
      const action = key.slice(key.indexOf(":") + 1);
      const rule = this.rules[action];
      const fresh = rule ? list.filter((t) => now - t < rule.windowMs) : [];
      if (fresh.length) this.hits.set(key, fresh);
      else this.hits.delete(key);
    }
  }
}

export const rateLimiter = new RateLimiter({
  "game:move:submit": { max: 40, windowMs: 1_000 },
  "game:chat:send": { max: 8, windowMs: 10_000 },
  "friend:request": { max: 30, windowMs: 60 * 60_000 },
  "user:search": { max: 60, windowMs: 60_000 },
  "challenge:create": { max: 12, windowMs: 60_000 },
  "queue:join": { max: 20, windowMs: 60_000 },
  "user:report": { max: 10, windowMs: 60 * 60_000 },
  "game:draw:offer": { max: 10, windowMs: 60_000 },
  "game:rematch:request": { max: 10, windowMs: 60_000 },
});
