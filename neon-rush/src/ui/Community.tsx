import React, { useEffect, useState } from 'react';
import type { CommunityTrackSummary, TracksSort } from '@shared/api';
import type { TrackDefinition } from '@shared/track/types';
import { THEMES } from '@game/track/themes';
import { formatTime } from '@shared/math';
import { api } from '@app/api';
import { Button, Panel, Pill, Spinner } from './components';
import { fmtDate } from './Leaderboards';
import { getAudio } from '@game/audio/audio';

export function CommunityScreen({ onBack, onPlay, onBuild, onEdit }: { onBack: () => void; onPlay: (def: TrackDefinition) => void; onBuild: () => void; onEdit: (id: string) => void }) {
  const [sort, setSort] = useState<TracksSort>('top');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState<CommunityTrackSummary[] | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true; setTracks(null);
    api.tracks.list(sort, query, 40).then((r) => { if (alive) setTracks(r.tracks); }).catch((e) => { if (alive) { setTracks([]); setMsg((e as Error).message); } });
    return () => { alive = false; };
  }, [sort, query]);
  const play = async (id: string) => {
    try { const r = await api.tracks.get(id); void api.tracks.play(id); onPlay(r.definition); } catch (e) { setMsg((e as Error).message); }
  };
  const byCode = async () => {
    try { const r = await api.tracks.byCode(code); void api.tracks.play(r.track.id); onPlay(r.definition); } catch (e) { setMsg((e as Error).message); getAudio().playSfx('error'); }
  };
  const like = async (t: CommunityTrackSummary) => {
    try { const r = await api.tracks.like(t.id); setTracks((ts) => ts?.map((x) => (x.id === t.id ? { ...x, likes: r.likes, likedByMe: r.likedByMe } : x)) ?? null); getAudio().playSfx('click'); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="absolute inset-0 p-3 md:p-6 flex" style={{ paddingTop: 'calc(var(--safe-top) + 12px)', paddingBottom: 'calc(var(--safe-bottom) + 12px)' }}>
      <Panel title="COMMUNITY TRACKS" onBack={onBack} className="w-full max-w-5xl mx-auto flex flex-col anim-fade-up" right={<Button variant="primary" className="!px-4 !py-2 text-xs" onClick={onBuild}>+ Build a track</Button>}>
        <div className="flex flex-wrap gap-2 items-center mb-3">
          <div className="flex rounded-lg overflow-hidden border border-white/15">{(['top', 'new', 'played', 'mine'] as TracksSort[]).map((s) => <button key={s} onClick={() => setSort(s)} className={`px-3 py-1.5 text-[11px] font-bold uppercase ${sort === s ? 'bg-fuchsia-400/30' : 'text-white/60 hover:bg-white/10'}`}>{s === 'top' ? 'Most liked' : s === 'new' ? 'Newest' : s === 'played' ? 'Most played' : 'My tracks'}</button>)}</div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><input className="input rounded-lg px-3 py-1.5 text-sm w-40" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /><Button className="!px-3 !py-1.5 text-xs" type="submit">Go</Button></form>
          <div className="ml-auto flex gap-2"><input className="input rounded-lg px-3 py-1.5 text-sm w-28 font-display tracking-widest uppercase" placeholder="CODE" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /><Button className="!px-3 !py-1.5 text-xs" disabled={code.length < 4} onClick={byCode}>Play code</Button></div>
        </div>
        {msg && <div className="text-xs font-bold text-yellow-200 mb-2">{msg}</div>}
        <div className="flex-1 overflow-y-auto scroll-thin min-h-0">
          {tracks == null ? <div className="flex justify-center py-10"><Spinner /></div> : tracks.length === 0 ? (
            <div className="py-10 text-center text-white/55 font-semibold">{sort === 'mine' ? 'You have not built any tracks yet.' : 'No tracks here yet — build the first one!'}</div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 stagger">
              {tracks.map((t) => {
                const th = THEMES[t.theme];
                return (
                  <div key={t.id} className="rounded-xl border p-3 flex flex-col gap-2" style={{ borderColor: `${th.accent}44`, background: `linear-gradient(160deg, ${th.accent}18, rgba(255,255,255,0.02))` }}>
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0"><div className="font-display font-bold truncate">{t.name}</div><div className="text-[11px] text-white/55 font-semibold">by {t.authorName} · {fmtDate(t.updatedAt)}</div></div>
                      {!t.published && <Pill color="#94a3b8">Draft</Pill>}
                    </div>
                    <div className="flex gap-1.5 flex-wrap"><Pill color={th.accent}>{th.name}</Pill><Pill color="#cbd5e1">{t.pieces} pieces</Pill><Pill color="#cbd5e1">{Math.round(t.lengthM)} m</Pill></div>
                    <div className="flex items-center gap-3 text-xs font-bold text-white/70">
                      <span>▶ {t.plays}</span><span>♥ {t.likes}</span>{t.authorTimeMs != null && <span>Author {formatTime(t.authorTimeMs)}</span>}<span className="ml-auto font-display tracking-widest text-white/50">{t.code}</span>
                    </div>
                    <div className="flex gap-2 mt-auto">
                      {t.published && <Button variant="primary" className="flex-1 !py-2 text-xs" onClick={() => play(t.id)}>Race</Button>}
                      {t.published && <Button className="!px-3 !py-2 text-xs" onClick={() => like(t)}>{t.likedByMe ? '♥' : '♡'}</Button>}
                      {sort === 'mine' && <Button className="!px-3 !py-2 text-xs" onClick={() => onEdit(t.id)}>Edit</Button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
