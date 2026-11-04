// NEON RUSH Worker: serves the API, multiplayer WebSocket rooms (Durable Objects), and static assets.
export { RaceRoom } from './room';
import { handleApi } from './api';

export interface Env {
  DB: D1Database;
  RACE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_ENV: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/room/')) {
      const code = url.pathname.split('/')[3]?.toUpperCase();
      if (!code || !/^[A-Z0-9]{4,8}$/.test(code)) return new Response('Bad room code', { status: 400 });
      const id = env.RACE_ROOM.idFromName(code);
      return env.RACE_ROOM.get(id).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
