import { Container, getContainer } from "@cloudflare/containers";

export interface Env {
  TEMPO: DurableObjectNamespace<TempoContainer>;
  PUBLIC_URL: string;
  BETTER_AUTH_SECRET: string;
  REALTIME_JWT_SECRET: string;
  SNAPSHOT_TOKEN: string;
  ANTHROPIC_API_KEY?: string;
}

const CONTAINER_PORT = 8080;
/** Snapshot bytes are stored in the Durable Object in chunks well below the per-value limit. */
const CHUNK_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;

interface SnapshotInfo {
  slot: "a" | "b";
  chunks: number;
  size: number;
  sha256: string;
  savedAt: number;
}
interface SnapshotMeta extends SnapshotInfo {
  /** The previous generation, kept so a corrupt latest snapshot never destroys the only copy. */
  prev: SnapshotInfo | null;
}

const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

function wakingResponse(request: Request): Response {
  const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html") && request.headers.get("upgrade") !== "websocket";
  if (!wantsHtml) {
    return Response.json({ error: "starting", message: "The server is waking up, retry in a few seconds." }, { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="4"><title>Tempo is waking up</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1216;color:#eef0f3;font-family:-apple-system,system-ui,sans-serif}
.c{max-width:26rem;padding:2rem;text-align:center}.s{width:44px;height:44px;margin:0 auto 1.25rem;border:4px solid #2a313c;border-top-color:#f0a53a;border-radius:50%;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#9aa3b0;line-height:1.5;margin:0}</style></head>
<body><div class="c"><div class="s"></div><h1>Tempo is waking up</h1><p>This demo sleeps when nobody is using it. Starting the game server takes about a minute. This page reloads by itself.</p></div></body></html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "4", "cache-control": "no-store" } });
}

export class TempoContainer extends Container<Env> {
  defaultPort = CONTAINER_PORT;
  /** Unused while `onActivityExpired` is overridden below; kept so the base class has a valid value. */
  sleepAfter = "30m";
  enableInternet = true;

  private readonly appEnv: Env;
  private warming: Promise<void> | null = null;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.appEnv = env;
    this.envVars = {
      PUBLIC_URL: env.PUBLIC_URL,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      REALTIME_JWT_SECRET: env.REALTIME_JWT_SECRET,
      SNAPSHOT_TOKEN: env.SNAPSHOT_TOKEN,
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
    };
  }

  override onStop(params: unknown): void {
    console.log("container stopped", JSON.stringify(params));
  }

  /** This demo is intentionally always on: inactivity never stops the container. */
  override async onActivityExpired(): Promise<void> {
    this.renewActivityTimeout();
  }

  override onError(error: unknown): unknown {
    console.error("container error", error instanceof Error ? error.message : String(error));
    return undefined;
  }

  override async fetch(request: Request): Promise<Response> {
    this.renewActivityTimeout();
    const url = new URL(request.url);
    if (url.pathname === "/__tempo/snapshot") return this.snapshotEndpoint(request, url);
    if (url.pathname === "/__tempo/logs") return this.logsEndpoint(request);
    if (url.pathname === "/__tempo/reset") return this.resetEndpoint(request);
    if (url.pathname === "/__tempo/status") return this.statusEndpoint();
    if (url.pathname === "/__tempo/keepalive") {
      const up = await this.isUp();
      if (!up) void this.warm();
      return Response.json({ up }, { headers: { "cache-control": "no-store" } });
    }
    if (await this.isUp()) return super.fetch(request);
    void this.warm();
    return wakingResponse(request);
  }

  private async isUp(): Promise<boolean> {
    const state = await this.getState();
    return state.status === "healthy" && this.ctx.container?.running === true;
  }

  /** Start the container and wait (up to five minutes) until nginx listens; repeated calls share one start. */
  private warm(): Promise<void> {
    this.renewActivityTimeout();
    if (!this.warming) {
      this.warming = this.startAndWaitForPorts({
        ports: [CONTAINER_PORT],
        cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 300_000, waitInterval: 500 },
      })
        .catch((err: unknown) => console.error("container start failed", err instanceof Error ? err.message : String(err)))
        .finally(() => {
          this.warming = null;
        });
    }
    return this.warming;
  }

  private async statusEndpoint(): Promise<Response> {
    const state = await this.getState();
    const meta = await this.ctx.storage.get<SnapshotMeta>("snap:meta");
    return Response.json(
      { container: state.status, running: this.ctx.container?.running === true, snapshot: meta ? { size: meta.size, savedAt: new Date(meta.savedAt).toISOString(), hasPrevious: Boolean(meta.prev) } : null },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // ───────────── database snapshots (called by the container's supervisor) ─────────────

  private async snapshotEndpoint(request: Request, url: URL): Promise<Response> {
    const token = request.headers.get("x-tempo-snapshot-token") ?? "";
    if (!this.appEnv.SNAPSHOT_TOKEN || !safeEqual(token, this.appEnv.SNAPSHOT_TOKEN)) return new Response("forbidden", { status: 403 });
    if (request.method === "POST") return this.saveSnapshot(request);
    if (request.method === "GET") return this.loadSnapshot(url.searchParams.get("gen") === "prev" ? "prev" : "latest");
    return new Response("method not allowed", { status: 405 });
  }

  /**
   * Erase all demo data: kills the container immediately (no final snapshot) and deletes the stored
   * snapshots. The next start, which the cron heartbeat triggers within a minute, begins empty.
   */
  private async resetEndpoint(request: Request): Promise<Response> {
    const token = request.headers.get("x-tempo-snapshot-token") ?? "";
    if (!this.appEnv.SNAPSHOT_TOKEN || !safeEqual(token, this.appEnv.SNAPSHOT_TOKEN)) return new Response("forbidden", { status: 403 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    await this.destroy();
    for (let pass = 0; pass < 2; pass++) {
      const keys = [...(await this.ctx.storage.list({ prefix: "snap:" })).keys()];
      for (let i = 0; i < keys.length; i += 64) await this.ctx.storage.delete(keys.slice(i, i + 64));
      if (pass === 0) await new Promise((resolve) => setTimeout(resolve, 3000)); // catch an upload that was in flight
    }
    return Response.json({ ok: true });
  }

  // ───────────── container logs (shipped by the supervisor; the platform does not expose them) ─────────────

  private async logsEndpoint(request: Request): Promise<Response> {
    const token = request.headers.get("x-tempo-snapshot-token") ?? "";
    if (!this.appEnv.SNAPSHOT_TOKEN || !safeEqual(token, this.appEnv.SNAPSHOT_TOKEN)) return new Response("forbidden", { status: 403 });
    const storage = this.ctx.storage;
    if (request.method === "POST") {
      const boot = (request.headers.get("x-tempo-boot") ?? "unknown").replace(/[^a-z0-9]/gi, "").slice(0, 16) || "unknown";
      const text = (await request.text()).slice(-150_000);
      const index = (await storage.get<string[]>("logs:index")) ?? [];
      if (!index.includes(boot)) {
        index.push(boot);
        while (index.length > 4) await storage.delete(`logs:${index.shift()!}`);
        await storage.put("logs:index", index);
      }
      await storage.put(`logs:${boot}`, text);
      return new Response("ok");
    }
    if (request.method === "GET") {
      const index = (await storage.get<string[]>("logs:index")) ?? [];
      const parts: string[] = [];
      for (const boot of index) parts.push(`===== boot ${boot} =====\n${(await storage.get<string>(`logs:${boot}`)) ?? ""}`);
      return new Response(parts.join("\n\n") || "no logs yet", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("method not allowed", { status: 405 });
  }

  private async saveSnapshot(request: Request): Promise<Response> {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_SNAPSHOT_BYTES) return new Response("snapshot too large", { status: 413 });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SNAPSHOT_BYTES) return new Response("invalid snapshot size", { status: 400 });
    const sha256 = toHex(await crypto.subtle.digest("SHA-256", bytes));
    if (sha256 !== request.headers.get("x-snapshot-sha256")) return new Response("checksum mismatch", { status: 400 });

    const storage = this.ctx.storage;
    const current = await storage.get<SnapshotMeta>("snap:meta");
    const slot: "a" | "b" = current?.slot === "a" ? "b" : "a";
    const chunks = Math.ceil(bytes.byteLength / CHUNK_BYTES);
    for (let start = 0; start < chunks; start += 64) {
      const batch: Record<string, ArrayBuffer> = {};
      for (let i = start; i < Math.min(chunks, start + 64); i++) batch[`snap:${slot}:${i}`] = bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      await storage.put(batch);
    }
    const info: SnapshotInfo = { slot, chunks, size: bytes.byteLength, sha256, savedAt: Date.now() };
    const meta: SnapshotMeta = { ...info, prev: current ? { slot: current.slot, chunks: current.chunks, size: current.size, sha256: current.sha256, savedAt: current.savedAt } : null };
    await storage.put("snap:meta", meta);

    // The slot we just overwrote held the generation before the previous one; drop its leftover chunks.
    const staleFrom = chunks;
    const staleTo = current?.prev?.slot === slot ? current.prev.chunks : 0;
    const stale: string[] = [];
    for (let i = staleFrom; i < staleTo; i++) stale.push(`snap:${slot}:${i}`);
    for (let i = 0; i < stale.length; i += 64) await storage.delete(stale.slice(i, i + 64));
    return Response.json({ ok: true, size: bytes.byteLength });
  }

  private async loadSnapshot(gen: "latest" | "prev"): Promise<Response> {
    const storage = this.ctx.storage;
    const meta = await storage.get<SnapshotMeta>("snap:meta");
    const info = gen === "latest" ? meta : meta?.prev;
    if (!info) return new Response("no snapshot", { status: 404 });
    const out = new Uint8Array(info.size);
    let offset = 0;
    for (let start = 0; start < info.chunks; start += 64) {
      const keys: string[] = [];
      for (let i = start; i < Math.min(info.chunks, start + 64); i++) keys.push(`snap:${info.slot}:${i}`);
      const parts = await storage.get<ArrayBuffer>(keys);
      for (const key of keys) {
        const part = parts.get(key);
        if (!part) return new Response("snapshot is incomplete", { status: 500 });
        out.set(new Uint8Array(part), offset);
        offset += part.byteLength;
      }
    }
    return new Response(out, { headers: { "content-type": "application/gzip", "x-snapshot-sha256": info.sha256, "x-snapshot-saved-at": String(info.savedAt), "cache-control": "no-store" } });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // A single named instance holds all state (matchmaking, live games, database).
    return getContainer(env.TEMPO, "main").fetch(request);
  },

  /** Cron heartbeat (every minute): starts the container if it is not running, so it is always on. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      getContainer(env.TEMPO, "main")
        .fetch(new Request(`${env.PUBLIC_URL}/__tempo/keepalive`))
        .then((res) => res.text())
        .then((body) => console.log("keepalive", body))
        .catch((err: unknown) => console.error("keepalive failed", err instanceof Error ? err.message : String(err))),
    );
  },
} satisfies ExportedHandler<Env>;
