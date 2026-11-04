import React, { useEffect, useState } from 'react';
import type { LeaderboardResponse, LeaderboardScope, PbHistoryResponse } from '@shared/api';
import type { TrackDefinition } from '@shared/track/types';
import { OFFICIAL_TRACKS, DIFFICULTY_NAMES } from '@shared/track/officialTracks';
import { THEMES } from '@game/track/themes';
import { formatTime } from '@shared/math';
import { api } from '@app/api';
import { useSession } from '@app/session';
import { Button, Panel, Pill, CarColorDot, Spinner } from './components';

const SCOPES: { id: LeaderboardScope; label: string }[] = [
  { id: 'global', label: 'Global' }, { id: 'school', label: 'School' }, { id: 'friends', label: 'Friends' }, { id: 'daily', label: 'Today' }, { id: 'weekly', label: 'This week' },
];

export function fmtDate(ts: number) {
  const d = new Date(ts); const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function LeaderboardTable({ data, onGhost, meId }: { data: LeaderboardResponse | null; onGhost?: (recordId: string, name: string) => void; meId?: string }) {
  if (!data) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (data.entries.length === 0) return <div className="py-8 text-center text-white/50 font-semibold">No times yet. Be the first!</div>;
  return (
    <div className="space-y-1">
      {data.entries.map((e) => (
        <div key={e.recordId + e.rank} className={`flex items-center gap-2 md:gap-3 rounded-lg px-2 md:px-3 py-2 ${e.playerId === meId ? 'bg-cyan-400/15 border border-cyan-300/40' : 'bg-white/[0.03] border border-transparent'}`}>
          <div className={`font-display font-black w-8 text-center ${e.rank === 1 ? 'text-yellow-300' : e.rank === 2 ? 'text-slate-300' : e.rank === 3 ? 'text-amber-500' : 'text-white/50'}`}>{e.rank}</div>
          <CarColorDot color={e.carColor} />
          <div className="flex-1 min-w-0">
            <div className="font-bold truncate text-sm md:text-base">{e.name} <span className="text-[10px] text-white/40 font-semibold">Lv {e.level}</span></div>
            {e.schoolName && <div className="text-[10px] text-white/40 font-semibold truncate">{e.schoolName}</div>}
          </div>
          <div className="text-right">
            <div className="font-display tabular-nums text-sm md:text-base">{formatTime(e.timeMs)}</div>
            <div className="text-[10px] text-white/40 font-semibold">{fmtDate(e.achievedAt)}</div>
          </div>
          {onGhost && e.hasReplay && <button onClick={() => onGhost(e.recordId, e.name)} className="btn rounded-lg px-2 py-1 text-[10px]" title="Race this ghost">👻</button>}
        </div>
      ))}
      {data.me && !data.entries.some((e) => e.playerId === meId) && (
        <div className="flex items-center gap-3 rounded-lg px-3 py-2 bg-cyan-400/15 border border-cyan-300/40 mt-2">
          <div className="font-display font-black w-8 text-center text-cyan-200">{data.me.rank}</div>
          <div className="flex-1 font-bold">You</div>
          <div className="font-display tabular-nums">{formatTime(data.me.timeMs)}</div>
        </div>
      )}
    </div>
  );
}

export function LeaderboardsScreen({ onBack, onGhost, initialTrack, extraTracks = [] }: { onBack: () => void; onGhost: (track: TrackDefinition, recordId: string, name: string) => void; initialTrack?: TrackDefinition | null; extraTracks?: TrackDefinition[] }) {
  const tracks = [...OFFICIAL_TRACKS, ...extraTracks];
  const [track, setTrack] = useState<TrackDefinition>(initialTrack ?? OFFICIAL_TRACKS[0]);
  const [scope, setScope] = useState<LeaderboardScope>('global');
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [hist, setHist] = useState<PbHistoryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const player = useSession((s) => s.player);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    api.leaderboard(track.id, scope, 25).then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) { setErr((e as Error).message); setData({ trackId: track.id, scope, entries: [], me: null, total: 0 }); } });
    api.records.history(track.id).then((h) => { if (alive) setHist(h); }).catch(() => { if (alive) setHist(null); });
    return () => { alive = false; };
  }, [track.id, scope]);

  const needsSchool = scope === 'school' && player && !player.schoolId;
  return (
    <div className="absolute inset-0 flex flex-col md:flex-row gap-3 md:gap-4 p-3 md:p-6" style={{ paddingTop: 'calc(var(--safe-top) + 12px)', paddingBottom: 'calc(var(--safe-bottom) + 12px)' }}>
      <Panel title="LEADERBOARDS" onBack={onBack} className="md:w-[320px] flex flex-col anim-slide-left max-h-[30vh] md:max-h-none">
        <div className="overflow-y-auto scroll-thin space-y-1 flex-1">
          {tracks.map((t) => (
            <button key={t.id} onClick={() => setTrack(t)} className={`w-full text-left rounded-lg px-3 py-2 border ${t.id === track.id ? 'border-cyan-300/70 bg-cyan-400/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'}`}>
              <div className="flex items-center gap-2"><span className="w-1.5 h-7 rounded-full" style={{ background: THEMES[t.theme].accent }} /><div className="min-w-0"><div className="font-display text-sm font-bold truncate">{t.name}</div><div className="text-[10px] text-white/50">{t.official ? DIFFICULTY_NAMES[t.difficulty] : 'Community'}</div></div></div>
            </button>
          ))}
        </div>
      </Panel>
      <div className="panel rounded-2xl p-4 md:p-6 flex-1 flex flex-col min-h-0 anim-fade-up">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="font-display text-xl md:text-2xl font-black mr-2">{track.name}</div>
          <Pill color={THEMES[track.theme].accent}>{THEMES[track.theme].name}</Pill>
          <div className="ml-auto flex rounded-lg overflow-hidden border border-white/15">
            {SCOPES.map((s) => <button key={s.id} onClick={() => setScope(s.id)} className={`px-2.5 md:px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider ${scope === s.id ? 'bg-fuchsia-400/30 text-fuchsia-100' : 'text-white/60 hover:bg-white/10'}`}>{s.label}</button>)}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin min-h-0">
          {needsSchool ? <div className="py-8 text-center text-white/60 font-semibold">Join your school from the Profile screen to compete in school rankings.</div>
            : <LeaderboardTable data={data} meId={player?.id} onGhost={(id, name) => onGhost(track, id, name)} />}
          {err && <div className="text-xs text-red-300 font-bold mt-2">Leaderboard server unreachable: {err}</div>}
        </div>
        {hist && hist.history.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/10">
            <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold mb-1">Your personal best history</div>
            <div className="flex gap-2 overflow-x-auto scroll-thin pb-1">
              {hist.history.slice().reverse().map((h, i) => (
                <div key={h.recordId} className={`shrink-0 rounded-lg px-3 py-1.5 border ${i === 0 ? 'border-lime-300/50 bg-lime-400/10' : 'border-white/10'}`}>
                  <div className="font-display text-sm tabular-nums">{formatTime(h.timeMs)}</div>
                  <div className="text-[10px] text-white/45">{fmtDate(h.achievedAt)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => onGhost(track, '', '')}>Race this track</Button></div>
      </div>
    </div>
  );
}
