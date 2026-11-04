// REST API router for the NEON RUSH Worker. See shared/api.ts for the contract.

import type { Env } from './index';
import { ApiError, json, readJson } from './http';
import { ensureSchema } from './db';
import { authGuest, authRegister, authLogin, getMe, updateMe } from './auth';
import { submitRecord, getLeaderboard, getReplay, getHistory, getBests } from './records';
import {
  listFriends, addFriend, removeFriend, createSchool, joinSchoolByCode, leaveSchool, mySchool, listNotifications, markNotificationsRead, challengeFriend,
} from './social';
import { getDaily } from './daily';
import { listTracks, getTrack, getTrackByCode, saveTrack, deleteTrack, likeTrack, playTrack } from './tracks';
import { shopBuy } from './progression';
import { liveResult } from './live';

export { json };

export interface Ctx {
  request: Request;
  env: Env;
  exec: ExecutionContext;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON body (cached, 2 MB cap). */
  body: () => Promise<unknown>;
  query: (name: string) => string | null;
}

export type Handler = (c: Ctx) => Promise<unknown>;

interface Route { method: string; segments: string[]; handler: Handler }
const routes: Route[] = [];
const add = (method: string, path: string, handler: Handler) => routes.push({ method, segments: path.split('/').filter(Boolean), handler });

add('POST', '/auth/guest', authGuest);
add('POST', '/auth/register', authRegister);
add('POST', '/auth/login', authLogin);
add('GET', '/me', getMe);
add('PUT', '/me', updateMe);

add('POST', '/records', submitRecord);
add('GET', '/leaderboard', getLeaderboard);
add('GET', '/replay/:recordId', getReplay);
add('GET', '/records/history', getHistory);
add('GET', '/records/bests', getBests);

add('GET', '/friends', listFriends);
add('POST', '/friends', addFriend);
add('DELETE', '/friends/:id', removeFriend);

add('POST', '/schools', createSchool);
add('POST', '/schools/join', joinSchoolByCode);
add('POST', '/schools/leave', leaveSchool);
add('GET', '/schools/mine', mySchool);

add('GET', '/daily', getDaily);
add('GET', '/notifications', listNotifications);
add('POST', '/notifications/read', markNotificationsRead);
add('POST', '/challenge', challengeFriend);

add('GET', '/tracks', listTracks);
add('GET', '/tracks/code/:code', getTrackByCode);
add('GET', '/tracks/:id', getTrack);
add('POST', '/tracks', saveTrack);
add('DELETE', '/tracks/:id', deleteTrack);
add('POST', '/tracks/:id/like', likeTrack);
add('POST', '/tracks/:id/play', playTrack);

add('POST', '/shop/buy', shopBuy);
add('POST', '/live/result', liveResult);

function matchRoute(route: Route, parts: string[]): Record<string, string> | null {
  if (route.segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = route.segments[i];
    if (seg.startsWith(':')) {
      try { params[seg.slice(1)] = decodeURIComponent(parts[i]); } catch { return null; }
    } else if (seg !== parts[i]) return null;
  }
  return params;
}

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  if (path === '/health') return json({ ok: true, env: env.APP_ENV ?? 'dev', time: Date.now() });

  const parts = path.split('/').filter(Boolean);
  let pathMatched = false;
  for (const route of routes) {
    const params = matchRoute(route, parts);
    if (!params) continue;
    pathMatched = true;
    if (route.method !== request.method) continue;
    try {
      await ensureSchema(env.DB);
      let bodyPromise: Promise<unknown> | null = null;
      const c: Ctx = {
        request, env, exec: ctx, url, params,
        body: () => (bodyPromise ??= readJson(request)),
        query: (name) => url.searchParams.get(name),
      };
      const result = await route.handler(c);
      return result instanceof Response ? result : json(result);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message, code: err.code }, err.status);
      console.error(`[api] ${request.method} ${url.pathname} failed:`, err);
      return json({ error: 'Internal error', code: 'internal' }, 500);
    }
  }
  if (pathMatched) return json({ error: 'Method not allowed', code: 'method_not_allowed' }, 405);
  return json({ error: 'Not found', code: 'not_found' }, 404);
}
