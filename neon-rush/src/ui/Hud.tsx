import React, { useEffect, useRef } from 'react';
import { useStore } from '@app/store';
import { tryGame } from '@app/gameRef';
import { formatTime } from '@shared/math';
import { DIFFICULTY_NAMES } from '@shared/track/officialTracks';

/** High-frequency HUD values are written straight into the DOM every frame (no React re-renders). */
export function Hud({ pb, position, playerCount, ghostLabel }: { pb: number | null; position?: number | null; playerCount?: number; ghostLabel?: string | null }) {
  const timeRef = useRef<HTMLDivElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  const speedBarRef = useRef<HTMLDivElement>(null);
  const cpRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const boostRef = useRef<HTMLDivElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const driftRef = useRef<HTMLDivElement>(null);
  const progRef = useRef<HTMLDivElement>(null);
  const track = useStore((s) => s.track);
  const banners = useStore((s) => s.banners);
  const isTouch = useStore((s) => s.isTouch);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const g = tryGame();
      if (!g) return;
      const h = g.hud;
      if (timeRef.current) timeRef.current.textContent = formatTime(h.timeMs);
      const kmh = Math.round(h.gearSpeed * 3.6);
      if (speedRef.current) speedRef.current.textContent = String(kmh);
      if (speedBarRef.current) speedBarRef.current.style.width = `${Math.min(100, (h.gearSpeed / 95) * 100)}%`;
      if (cpRef.current) cpRef.current.textContent = `${Math.min(h.checkpoint, h.checkpointTotal)} / ${h.checkpointTotal}`;
      if (diffRef.current) {
        if (h.diffMs != null && h.diffAge < 2.5) {
          diffRef.current.style.opacity = String(1 - Math.max(0, h.diffAge - 1.8) / 0.7);
          diffRef.current.textContent = formatTime(h.diffMs, true);
          diffRef.current.style.color = h.diffMs <= 0 ? '#4ade80' : '#f87171';
        } else diffRef.current.style.opacity = '0';
      }
      if (boostRef.current) boostRef.current.style.opacity = h.boost > 0 ? '1' : '0';
      if (driftRef.current) driftRef.current.style.opacity = h.drifting ? '1' : '0';
      if (fadeRef.current) fadeRef.current.style.opacity = String(h.respawning * 0.9);
      if (progRef.current) progRef.current.style.width = `${Math.round(h.progress * 100)}%`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none select-none" style={{ paddingTop: 'var(--safe-top)', paddingLeft: 'var(--safe-left)', paddingRight: 'var(--safe-right)' }}>
      <div ref={fadeRef} className="absolute inset-0 bg-[#07061a] opacity-0 transition-none" />
      {/* top-left: timer */}
      <div className="absolute left-4 top-3 md:left-6 md:top-5 anim-slide-left">
        <div ref={timeRef} className="font-display text-4xl md:text-6xl font-black tracking-wider text-white hud-shadow tabular-nums">0.000</div>
        <div className="flex items-center gap-3 mt-1">
          <div className="text-xs md:text-sm font-bold tracking-widest text-cyan-300/90 hud-shadow uppercase">Best {pb != null ? formatTime(pb) : '—'}</div>
          {ghostLabel && <div className="text-[10px] md:text-xs font-bold tracking-widest uppercase text-pink-300 hud-shadow">vs {ghostLabel}</div>}
          <div ref={diffRef} className="font-display text-sm md:text-lg font-bold hud-shadow tabular-nums opacity-0 transition-opacity">+0.000</div>
        </div>
      </div>
      {/* top-right: track + checkpoints */}
      <div className="absolute right-4 top-3 md:right-6 md:top-5 text-right anim-slide-right">
        <div className="font-display text-sm md:text-lg font-bold text-white/90 hud-shadow truncate max-w-[40vw]">{track?.name}</div>
        <div className="text-[10px] md:text-xs font-bold tracking-widest uppercase text-fuchsia-300/90 hud-shadow">{track ? DIFFICULTY_NAMES[track.difficulty] : ''}</div>
        <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-black/35 px-3 py-1 backdrop-blur-sm">
          <span className="text-[10px] md:text-xs uppercase tracking-widest text-white/60 font-bold">CP</span>
          <span ref={cpRef} className="font-display text-sm md:text-lg font-bold text-cyan-300 tabular-nums">0 / 0</span>
        </div>
        {position != null && (
          <div className="mt-2 inline-flex items-baseline gap-1 rounded-full bg-black/35 px-3 py-1 backdrop-blur-sm ml-2">
            <span className="font-display text-xl md:text-2xl font-black text-yellow-300">{position}</span>
            <span className="text-[10px] uppercase tracking-widest text-white/60 font-bold">/ {playerCount}</span>
          </div>
        )}
      </div>
      {/* bottom-right: speedometer */}
      <div className={`absolute right-4 md:right-8 ${isTouch ? 'bottom-32' : 'bottom-6 md:bottom-8'} text-right anim-fade-up`} style={{ paddingBottom: 'var(--safe-bottom)' }}>
        <div className="flex items-baseline justify-end gap-2">
          <div ref={speedRef} className="font-display text-5xl md:text-7xl font-black text-white hud-shadow tabular-nums leading-none">0</div>
          <div className="text-xs md:text-sm font-bold tracking-widest text-white/60 uppercase">km/h</div>
        </div>
        <div className="mt-2 h-2 w-40 md:w-56 rounded-full bg-white/10 overflow-hidden ml-auto">
          <div ref={speedBarRef} className="h-full rounded-full" style={{ width: '0%', background: 'linear-gradient(90deg,#22d3ee,#a855f7,#f472b6,#fb923c)' }} />
        </div>
        <div className="flex justify-end gap-2 mt-2">
          <div ref={driftRef} className="opacity-0 transition-opacity text-[11px] font-black tracking-widest uppercase text-fuchsia-300 text-glow-sm">DRIFT</div>
          <div ref={boostRef} className="opacity-0 transition-opacity text-[11px] font-black tracking-widest uppercase text-orange-300 text-glow-sm">BOOST</div>
        </div>
      </div>
      {/* progress bar */}
      <div className="absolute left-1/2 -translate-x-1/2 top-2 w-[34vw] max-w-sm h-1.5 rounded-full bg-white/10 overflow-hidden hidden md:block">
        <div ref={progRef} className="h-full bg-gradient-to-r from-cyan-400 to-fuchsia-400" style={{ width: '0%' }} />
      </div>
      {/* banners */}
      <div className="absolute left-1/2 -translate-x-1/2 top-[18%] flex flex-col items-center gap-2">
        {banners.map((b) => (
          <div key={b.id} className={`anim-banner text-center ${b.kind === 'wr' ? 'scale-110' : ''}`}>
            <div className={`font-display font-black tracking-widest uppercase text-glow ${b.kind === 'pb' ? 'text-3xl md:text-5xl text-lime-300' : b.kind === 'wr' ? 'text-4xl md:text-6xl gradient-text' : b.kind === 'checkpoint' ? 'text-xl md:text-3xl text-cyan-300' : b.kind === 'rival' ? 'text-2xl md:text-4xl text-orange-300' : b.kind === 'warn' ? 'text-xl md:text-2xl text-red-300' : 'text-xl md:text-3xl text-white'}`}>{b.text}</div>
            {b.sub && <div className="font-body text-sm md:text-lg font-bold text-white/85 hud-shadow mt-1">{b.sub}</div>}
          </div>
        ))}
      </div>
      {!isTouch && (
        <div className="absolute left-4 bottom-4 text-[10px] md:text-xs font-bold tracking-widest uppercase text-white/35 hud-shadow hidden md:block">R restart · Backspace respawn · C camera · Space drift · Esc pause</div>
      )}
    </div>
  );
}
