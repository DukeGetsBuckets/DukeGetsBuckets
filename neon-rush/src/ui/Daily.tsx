import React, { useEffect, useState } from 'react';
import type { DailyResponse } from '@shared/api';
import { OFFICIAL_TRACK_MAP, DIFFICULTY_NAMES } from '@shared/track/officialTracks';
import { THEMES } from '@game/track/themes';
import { formatTime } from '@shared/math';
import { api } from '@app/api';
import { useSession } from '@app/session';
import { dayKey, dailyTrackId, dayEndsAt } from '@shared/game/daily';
import { OFFICIAL_TRACKS } from '@shared/track/officialTracks';
import { Button, Panel, Pill, Overlay } from './components';
import { LeaderboardTable } from './Leaderboards';
import type { TrackDefinition } from '@shared/track/types';

function useCountdown(endsAt: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ms = Math.max(0, endsAt - now);
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function DailyScreen({ onBack, onPlay }: { onBack: () => void; onPlay: (t: TrackDefinition) => void }) {
  const [data, setData] = useState<DailyResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const player = useSession((s) => s.player);
  useEffect(() => { api.daily().then(setData).catch((e) => setErr((e as Error).message)); }, []);
  // offline fallback: same deterministic rotation as the server
  const key = data?.dayKey ?? dayKey();
  const trackId = data?.trackId ?? dailyTrackId(key, OFFICIAL_TRACKS.map((t) => t.id));
  const track = OFFICIAL_TRACK_MAP[trackId];
  const left = useCountdown(data?.endsAt ?? dayEndsAt());
  const theme = THEMES[track.theme];
  const winner = data?.top[0];
  return (
    <Overlay>
      <Panel title="DAILY CHALLENGE" onBack={onBack} className="w-full max-w-3xl max-h-[92vh] flex flex-col anim-fade-up">
        <div className="grid md:grid-cols-2 gap-4 min-h-0 flex-1">
          <div className="flex flex-col gap-3">
            <div className="rounded-xl p-4 border" style={{ borderColor: `${theme.accent}66`, background: `linear-gradient(135deg, ${theme.accent}22, transparent)` }}>
              <div className="text-[10px] uppercase tracking-widest text-white/60 font-bold">{key} · featured track</div>
              <div className="font-display text-3xl font-black mt-1">{track.name}</div>
              <div className="flex gap-2 mt-2"><Pill color={theme.accent}>{theme.name}</Pill><Pill color="#cbd5e1">{DIFFICULTY_NAMES[track.difficulty]}</Pill></div>
              <div className="mt-3 text-sm text-white/70 font-semibold">{track.description}</div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-black/30 border border-white/10 p-2"><div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">Ends in</div><div className="font-display text-lg font-bold text-yellow-300 tabular-nums">{left}</div></div>
              <div className="rounded-xl bg-black/30 border border-white/10 p-2"><div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">Your rank</div><div className="font-display text-lg font-bold text-cyan-300">{data?.me ? `#${data.me.rank}` : '—'}</div></div>
              <div className="rounded-xl bg-black/30 border border-white/10 p-2"><div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">Racers</div><div className="font-display text-lg font-bold text-fuchsia-300">{data?.participants ?? '—'}</div></div>
            </div>
            {winner && <div className="rounded-xl bg-yellow-400/10 border border-yellow-300/40 p-3"><div className="text-[10px] uppercase tracking-widest text-yellow-200/80 font-bold">Today's fastest</div><div className="font-display text-lg font-bold">👑 {winner.name} · {formatTime(winner.timeMs)}</div></div>}
            {data?.me && <div className="text-sm font-bold text-white/70">Your best today: <span className="text-cyan-300">{formatTime(data.me.timeMs)}</span></div>}
            {data?.yesterday?.winner && <div className="text-xs text-white/50 font-semibold">Yesterday ({OFFICIAL_TRACK_MAP[data.yesterday.trackId]?.name}): {data.yesterday.winner.name} won with {formatTime(data.yesterday.winner.timeMs)}</div>}
            <Button variant="primary" className="mt-auto" onClick={() => onPlay(track)}>Race the daily</Button>
          </div>
          <div className="flex flex-col min-h-0">
            <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold mb-1">Top 10 today</div>
            <div className="overflow-y-auto scroll-thin flex-1 min-h-[160px]">
              {err ? <div className="text-sm text-white/50 font-semibold py-6 text-center">Leaderboards are offline right now — you can still practice.</div>
                : <LeaderboardTable data={data ? { trackId, scope: 'daily', entries: data.top, me: data.me ? { ...data.me, recordId: '' } : null, total: data.participants } : null} meId={player?.id} />}
            </div>
            {data && data.friends.length > 0 && (
              <>
                <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold mt-3 mb-1">Friends today</div>
                <LeaderboardTable data={{ trackId, scope: 'friends', entries: data.friends, me: null, total: data.friends.length }} meId={player?.id} />
              </>
            )}
          </div>
        </div>
      </Panel>
    </Overlay>
  );
}
