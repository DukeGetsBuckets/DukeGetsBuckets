// Typed client for the NEON RUSH REST API (shared/api.ts). Same-origin fetch with a bearer token
// kept in localStorage. Every non-2xx response (and network failure, status 0) throws ApiError.

import type {
  AuthResponse, GuestAuthRequest, RegisterRequest, LoginRequest, UpdateMeRequest, PlayerProfile, PlayerPublic,
  SubmitRecordRequest, SubmitRecordResponse, LeaderboardResponse, LeaderboardScope, ReplayResponse, PbHistoryResponse,
  AddFriendRequest, FriendsResponse, CreateSchoolRequest, JoinSchoolRequest, SchoolResponse, DailyResponse,
  NotificationsResponse, ChallengeRequest, TracksListResponse, TracksSort, SaveTrackRequest, SaveTrackResponse,
  BuyRequest, BuyResponse, LiveRaceResultRequest, LiveRaceResultResponse,
} from '@shared/api';

export const TOKEN_KEY = 'neonrush.token';
const BASE = '/api';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
  /** True when the request never reached the server (offline / network failure). */
  get offline() { return this.status === 0; }
}

let memoryToken: string | null = null;

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try { memoryToken = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }
  return memoryToken;
}
export function setToken(token: string): void {
  memoryToken = token;
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
}
export function clearToken(): void {
  memoryToken = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch (err) {
    throw new ApiError(0, typeof navigator !== 'undefined' && !navigator.onLine ? 'You are offline' : `Network error: ${(err as Error).message}`, 'network');
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; code?: string };
    if (res.status === 401 && e.code !== 'bad_credentials' && e.code !== 'bad_guest_token') clearToken();
    throw new ApiError(res.status, e.error ?? `Request failed (${res.status})`, e.code ?? 'error');
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),

  health: () => request<{ ok: boolean; env: string; time: number }>('GET', '/health'),

  auth: {
    /** Creates a guest profile and stores its token. */
    guest: async (name: string) => {
      const r = await request<AuthResponse>('POST', '/auth/guest', { name } satisfies GuestAuthRequest);
      setToken(r.token);
      return r;
    },
    /** Registers an account; pass the current guest token to upgrade the guest profile in place. */
    register: async (name: string, password: string, guestToken: string | null = getToken()) => {
      const r = await request<AuthResponse>('POST', '/auth/register', { name, password, ...(guestToken ? { guestToken } : {}) } satisfies RegisterRequest);
      setToken(r.token);
      return r;
    },
    login: async (name: string, password: string) => {
      const r = await request<AuthResponse>('POST', '/auth/login', { name, password } satisfies LoginRequest);
      setToken(r.token);
      return r;
    },
    logout: () => clearToken(),
  },

  me: {
    get: () => request<{ player: PlayerProfile }>('GET', '/me'),
    update: (req: UpdateMeRequest) => request<{ player: PlayerProfile }>('PUT', '/me', req),
  },

  records: {
    submit: (req: SubmitRecordRequest) => request<SubmitRecordResponse>('POST', '/records', req),
    history: (trackId: string) => request<PbHistoryResponse>('GET', `/records/history${qs({ track: trackId })}`),
    bests: () => request<{ bests: Record<string, number> }>('GET', '/records/bests'),
  },

  leaderboard: (trackId: string, scope: LeaderboardScope = 'global', limit = 20, offset = 0) =>
    request<LeaderboardResponse>('GET', `/leaderboard${qs({ track: trackId, scope, limit, offset })}`),

  replay: (recordId: string) => request<ReplayResponse>('GET', `/replay/${encodeURIComponent(recordId)}`),

  friends: {
    list: () => request<FriendsResponse>('GET', '/friends'),
    add: (code: string) => request<{ friend: PlayerPublic }>('POST', '/friends', { code } satisfies AddFriendRequest),
    remove: (playerId: string) => request<{ ok: true }>('DELETE', `/friends/${encodeURIComponent(playerId)}`),
  },

  schools: {
    create: (name: string) => request<SchoolResponse>('POST', '/schools', { name } satisfies CreateSchoolRequest),
    join: (code: string) => request<SchoolResponse>('POST', '/schools/join', { code } satisfies JoinSchoolRequest),
    leave: () => request<{ ok: true }>('POST', '/schools/leave', {}),
    mine: () => request<SchoolResponse | { school: null }>('GET', '/schools/mine'),
  },

  daily: () => request<DailyResponse>('GET', '/daily'),

  notifications: {
    list: () => request<NotificationsResponse>('GET', '/notifications'),
    /** Marks the given notifications (or all when omitted) as read. */
    markRead: (ids?: string[]) => request<{ ok: true }>('POST', '/notifications/read', ids ? { ids } : {}),
  },

  challenge: (friendId: string, trackId: string) => request<{ ok: true }>('POST', '/challenge', { friendId, trackId } satisfies ChallengeRequest),

  tracks: {
    list: (sort: TracksSort = 'new', q = '', limit = 20, offset = 0) => request<TracksListResponse>('GET', `/tracks${qs({ sort, q, limit, offset })}`),
    get: (id: string) => request<SaveTrackResponse>('GET', `/tracks/${encodeURIComponent(id)}`),
    byCode: (code: string) => request<SaveTrackResponse>('GET', `/tracks/code/${encodeURIComponent(code.trim().toUpperCase())}`),
    save: (req: SaveTrackRequest) => request<SaveTrackResponse>('POST', '/tracks', req),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/tracks/${encodeURIComponent(id)}`),
    like: (id: string) => request<{ likes: number; likedByMe: boolean }>('POST', `/tracks/${encodeURIComponent(id)}/like`, {}),
    play: (id: string) => request<{ ok: true }>('POST', `/tracks/${encodeURIComponent(id)}/play`, {}),
  },

  shop: {
    buy: (itemId: string) => request<BuyResponse>('POST', '/shop/buy', { itemId } satisfies BuyRequest),
  },

  live: {
    result: (req: LiveRaceResultRequest) => request<LiveRaceResultResponse>('POST', '/live/result', req),
  },
};

export type Api = typeof api;
