// Player session: guest-by-default online profile, record submission, notifications.
// Everything degrades gracefully offline (local bests/replays keep working).
import { create } from 'zustand';
import { api, ApiError, getToken, clearToken } from './api';
import type { PlayerProfile, SubmitRecordRequest, SubmitRecordResponse, Notification } from '@shared/api';
import { levelForXp } from '@shared/game/progression';
import { useStore } from './store';
import { getAudio } from '@game/audio/audio';

interface SessionState {
  player: PlayerProfile | null;
  online: boolean;            // server reachable
  serverBests: Record<string, number>;
  notifications: Notification[];
  unread: number;
  busy: boolean;
  setPlayer: (p: PlayerProfile) => void;
}

export const useSession = create<SessionState>((set) => ({
  player: null,
  online: false,
  serverBests: {},
  notifications: [],
  unread: 0,
  busy: false,
  setPlayer: (player) => set({ player }),
}));

const seenNotifications = new Set<string>();
let pollTimer: number | null = null;

/** Sign in with the stored token, or create a guest profile with the chosen name. */
export async function initSession(name: string): Promise<void> {
  try {
    if (getToken()) {
      try {
        const { player } = await api.me.get();
        useSession.setState({ player, online: true });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { clearToken(); }
        else throw e;
      }
    }
    if (!useSession.getState().player) {
      const r = await api.auth.guest(name);
      useSession.setState({ player: r.player, online: true });
    }
    const p = useSession.getState().player;
    if (p) {
      // the server profile is the source of truth for the car once signed in
      if (p.car) useStore.getState().setCarConfig(p.car);
    }
    await refreshBests();
    await pollNotifications(true);
    if (pollTimer == null) pollTimer = window.setInterval(() => { void pollNotifications(false); }, 30000);
  } catch {
    useSession.setState({ online: false });
  }
}

export async function refreshProfile() {
  try { const { player } = await api.me.get(); useSession.setState({ player, online: true }); } catch { /* offline */ }
}

export async function refreshBests() {
  try { const { bests } = await api.records.bests(); useSession.setState({ serverBests: bests }); } catch { /* offline */ }
}

export async function pollNotifications(initial: boolean) {
  if (!useSession.getState().player) return;
  try {
    const r = await api.notifications.list();
    useSession.setState({ notifications: r.items, unread: r.unread });
    for (const n of r.items) {
      if (seenNotifications.has(n.id)) continue;
      seenNotifications.add(n.id);
      if (!initial && !n.read && (n.kind === 'rival_beat_you' || n.kind === 'challenge' || n.kind === 'rank_change' || n.kind === 'daily_result')) {
        useStore.getState().pushBanner({ text: n.text, kind: 'rival' });
        getAudio().playSfx('notify');
      }
    }
  } catch { /* offline */ }
}

export async function markNotificationsRead() {
  try { await api.notifications.markRead(); useSession.setState((s) => ({ unread: 0, notifications: s.notifications.map((n) => ({ ...n, read: true })) })); } catch { /* ignore */ }
}

export async function submitRecord(req: SubmitRecordRequest): Promise<SubmitRecordResponse | null> {
  if (!useSession.getState().player) return null;
  try {
    const r = await api.records.submit(req);
    if (r.player) useSession.setState({ player: r.player, online: true });
    if (r.accepted && r.isPb) useSession.setState((s) => ({ serverBests: { ...s.serverBests, [req.trackId]: req.timeMs } }));
    return r;
  } catch {
    useSession.setState({ online: false });
    return null;
  }
}

export async function saveCarToServer() {
  const p = useSession.getState().player;
  if (!p) return;
  try { const { player } = await api.me.update({ car: useStore.getState().carConfig }); useSession.setState({ player }); } catch { /* locked items or offline */ }
}

export async function registerAccount(name: string, password: string) {
  const r = await api.auth.register(name, password);
  useSession.setState({ player: r.player, online: true });
  return r.player;
}
export async function loginAccount(name: string, password: string) {
  const r = await api.auth.login(name, password);
  useSession.setState({ player: r.player, online: true });
  if (r.player.car) useStore.getState().setCarConfig(r.player.car);
  await refreshBests();
  return r.player;
}
export function logout() {
  clearToken();
  useSession.setState({ player: null, serverBests: {}, notifications: [], unread: 0 });
}

export function playerLevel(p: PlayerProfile | null) { return p ? levelForXp(p.xp) : 1; }
