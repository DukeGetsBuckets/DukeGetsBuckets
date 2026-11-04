import React, { useState } from 'react';
import type { TrackDefinition } from '@shared/track/types';
import { OFFICIAL_TRACKS, DIFFICULTY_NAMES } from '@shared/track/officialTracks';
import { THEMES } from '@game/track/themes';
import { formatTime } from '@shared/math';
import { Button, Panel, Pill } from './components';

const DIFF_COLORS = ['', '#a3e635', '#22d3ee', '#fb923c', '#f472b6'];

export function TrackSelect({ onBack, onPlay, onGhost, bests }: { onBack: () => void; onPlay: (t: TrackDefinition) => void; onGhost: (t: TrackDefinition) => void; bests: Record<string, number> }) {
  const [sel, setSel] = useState<TrackDefinition>(OFFICIAL_TRACKS[0]);
  const theme = THEMES[sel.theme];
  const medal = (t: TrackDefinition) => {
    const b = bests[t.id]; if (b == null) return null;
    if (b <= t.medals.author) return { name: 'Author', color: '#a3e635' };
    if (b <= t.medals.gold) return { name: 'Gold', color: '#facc15' };
    if (b <= t.medals.silver) return { name: 'Silver', color: '#cbd5e1' };
    if (b <= t.medals.bronze) return { name: 'Bronze', color: '#d97706' };
    return { name: 'Done', color: '#94a3b8' };
  };
  return (
    <div className="absolute inset-0 flex items-stretch p-3 md:p-6 gap-4 pointer-events-none" style={{ paddingTop: 'calc(var(--safe-top) + 12px)', paddingBottom: 'calc(var(--safe-bottom) + 12px)' }}>
      <Panel title="TRACKS" onBack={onBack} className="pointer-events-auto w-full md:w-[420px] flex flex-col anim-slide-left">
        <div className="overflow-y-auto scroll-thin flex-1 -mx-2 px-2 space-y-1.5">
          {OFFICIAL_TRACKS.map((t, i) => {
            const m = medal(t);
            const th = THEMES[t.theme];
            return (
              <button key={t.id} onClick={() => setSel(t)} onDoubleClick={() => onPlay(t)} className={`w-full text-left rounded-xl px-3 py-2.5 border transition-all ${sel.id === t.id ? 'border-cyan-300/70 bg-cyan-400/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'}`}>
                <div className="flex items-center gap-3">
                  <div className="font-display text-lg font-black w-7 text-white/40">{String(i + 1).padStart(2, '0')}</div>
                  <div className="w-2 h-9 rounded-full" style={{ background: th.accent, boxShadow: `0 0 10px ${th.accent}` }} />
                  <div className="flex-1 min-w-0">
                    <div className="font-display font-bold text-sm md:text-base truncate">{t.name}</div>
                    <div className="text-[11px] text-white/55 font-semibold">{th.name} · <span style={{ color: DIFF_COLORS[t.difficulty] }}>{DIFFICULTY_NAMES[t.difficulty]}</span></div>
                  </div>
                  <div className="text-right">
                    <div className="font-display text-xs md:text-sm tabular-nums text-white/90">{bests[t.id] != null ? formatTime(bests[t.id]) : '—'}</div>
                    {m && <Pill color={m.color}>{m.name}</Pill>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </Panel>
      <div className="hidden md:flex flex-col justify-end flex-1 pointer-events-none">
        <div className="panel rounded-2xl p-6 max-w-xl pointer-events-auto anim-fade-up" key={sel.id} style={{ borderColor: `${theme.accent}55` }}>
          <div className="flex items-center gap-3 mb-2">
            <Pill color={theme.accent}>{theme.name}</Pill>
            <Pill color={DIFF_COLORS[sel.difficulty]}>{DIFFICULTY_NAMES[sel.difficulty]}</Pill>
          </div>
          <div className="font-display text-3xl font-black tracking-wider">{sel.name}</div>
          <div className="text-white/70 mt-1 font-semibold">{sel.description}</div>
          <div className="text-white/50 text-sm mt-1">{theme.tagline}</div>
          <div className="flex gap-4 mt-4 text-sm font-bold">
            <div><span className="text-lime-300">Author</span> {formatTime(sel.medals.author)}</div>
            <div><span className="text-yellow-300">Gold</span> {formatTime(sel.medals.gold)}</div>
            <div><span className="text-slate-300">Silver</span> {formatTime(sel.medals.silver)}</div>
            <div><span className="text-amber-600">Bronze</span> {formatTime(sel.medals.bronze)}</div>
          </div>
          <div className="flex gap-3 mt-5">
            <Button variant="primary" onClick={() => onPlay(sel)}>Race</Button>
            <Button onClick={() => onGhost(sel)}>Race vs ghost</Button>
          </div>
        </div>
      </div>
      <div className="md:hidden absolute bottom-4 left-0 right-0 flex justify-center gap-3 pointer-events-auto px-4">
        <Button variant="primary" className="flex-1" onClick={() => onPlay(sel)}>Race {sel.name}</Button>
      </div>
    </div>
  );
}
