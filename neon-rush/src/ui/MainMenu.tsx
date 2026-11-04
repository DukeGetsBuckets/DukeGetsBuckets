import React from 'react';
import { useStore, type Screen } from '@app/store';

const ITEMS: { id: Screen; label: string; sub: string; color: string }[] = [
  { id: 'tracks', label: 'PLAY', sub: 'Time trials on 12 official tracks', color: '#22d3ee' },
  { id: 'multiplayer', label: 'MULTIPLAYER', sub: 'Live races with friends', color: '#f472b6' },
  { id: 'daily', label: 'DAILY CHALLENGE', sub: 'Today\'s featured track', color: '#facc15' },
  { id: 'garage', label: 'GARAGE', sub: 'Customize your ride', color: '#a855f7' },
  { id: 'leaderboards', label: 'LEADERBOARDS', sub: 'Global · School · Friends', color: '#a3e635' },
  { id: 'builder', label: 'TRACK BUILDER', sub: 'Create and share tracks', color: '#fb923c' },
  { id: 'profile', label: 'PROFILE', sub: 'Level, badges, friends', color: '#38bdf8' },
  { id: 'settings', label: 'SETTINGS', sub: 'Graphics, audio, controls', color: '#cbd5e1' },
];

export function MainMenu({ playerName, level, onOpen }: { playerName: string; level: number; onOpen: (s: Screen) => void }) {
  const online = useStore((s) => s.online);
  return (
    <div className="absolute inset-0 flex flex-col pointer-events-none" style={{ paddingTop: 'calc(var(--safe-top) + 12px)', paddingBottom: 'calc(var(--safe-bottom) + 12px)', paddingLeft: 'calc(var(--safe-left) + 16px)', paddingRight: 'calc(var(--safe-right) + 16px)' }}>
      <div className="flex items-start justify-between">
        <div className="anim-slide-left">
          <h1 className="font-display text-5xl md:text-7xl font-black tracking-[0.08em] gradient-text anim-gradient leading-none">NEON<br />RUSH</h1>
          <div className="mt-2 text-xs md:text-sm font-bold tracking-[0.3em] uppercase text-white/60">Race · Beat records · Build tracks</div>
        </div>
        <div className="anim-slide-right pointer-events-auto panel rounded-xl px-4 py-2 flex items-center gap-3 cursor-pointer" onClick={() => onOpen('profile')}>
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 flex items-center justify-center font-display font-black text-[#07061a]">{playerName.slice(0, 1).toUpperCase()}</div>
          <div>
            <div className="font-display text-sm font-bold">{playerName}</div>
            <div className="text-[10px] uppercase tracking-widest text-cyan-300/90 font-bold">Level {level} {online ? '' : '· offline'}</div>
          </div>
        </div>
      </div>
      <div className="mt-auto md:mt-6 grid grid-cols-2 md:grid-cols-1 gap-2 md:gap-2.5 md:w-[360px] pointer-events-auto stagger">
        {ITEMS.map((it, i) => (
          <button key={it.id} onClick={() => onOpen(it.id)} className={`btn rounded-xl text-left px-4 py-3 md:px-5 md:py-3.5 group ${i === 0 ? 'col-span-2 md:col-span-1 btn-primary' : ''}`} style={i === 0 ? {} : { borderColor: `${it.color}44` }}>
            <div className="flex items-center gap-3">
              <span className="w-1.5 h-7 rounded-full" style={{ background: i === 0 ? '#07061a' : it.color, boxShadow: i === 0 ? 'none' : `0 0 12px ${it.color}` }} />
              <div>
                <div className={`font-display text-base md:text-lg font-black tracking-wider ${i === 0 ? 'text-[#07061a]' : ''}`}>{it.label}</div>
                <div className={`text-[11px] md:text-xs font-semibold tracking-wide normal-case ${i === 0 ? 'text-[#07061a]/70' : 'text-white/55'}`}>{it.sub}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
