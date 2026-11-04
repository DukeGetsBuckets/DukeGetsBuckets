import type { Env } from './index';

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export async function handleApi(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  if (path === '/health') return json({ ok: true, env: env.APP_ENV ?? 'dev', time: Date.now() });
  return json({ error: 'Not found' }, 404);
}
