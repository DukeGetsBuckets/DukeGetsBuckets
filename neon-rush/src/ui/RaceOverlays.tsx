import React from 'react';
import { useStore } from '@app/store';
import { formatTime } from '@shared/math';
import { Button, Overlay, Panel } from './components';

export function Countdown() {
  const countdown = useStore((s) => s.countdown);
  const show = useStore((s) => s.showCountdown);
  if (!show) return null;
  const text = countdown > 0 ? String(countdown) : 'GO!';
  const color = countdown === 3 ? '#f472b6' : countdown === 2 ? '#facc15' : countdown === 1 ? '#22d3ee' : '#a3e635';
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div key={text} className="anim-countdown font-display font-black text-[22vw] md:text-[12rem] text-glow leading-none" style={{ color }}>{text}</div>
    </div>
  );
}

export function ArmedHint() {
  return (
    <div className="absolute inset-0 flex items-end justify-center pb-[30vh] pointer-events-none">
      <div className="anim-pulse font-display text-lg md:text-2xl font-bold tracking-widest uppercase text-cyan-200 text-glow-sm">Press accelerate to go</div>
    </div>
  );
}

export function PauseMenu({ onResume, onRestart, onQuit, onSettings }: { onResume: () => void; onRestart: () => void; onQuit: () => void; onSettings: () => void }) {
  return (
    <Overlay className="bg-black/50 backdrop-blur-sm anim-fade-in">
      <Panel className="w-full max-w-sm text-center">
        <div className="font-display text-3xl font-black tracking-widest gradient-text mb-6">PAUSED</div>
        <div className="flex flex-col gap-3 stagger">
          <Button variant="primary" onClick={onResume}>Resume</Button>
          <Button onClick={onRestart}>Restart (R)</Button>
          <Button onClick={onSettings}>Settings</Button>
          <Button variant="danger" onClick={onQuit}>Quit to menu</Button>
        </div>
      </Panel>
    </Overlay>
  );
}

const MEDAL_COLORS: Record<string, string> = { author: '#a3e635', gold: '#facc15', silver: '#cbd5e1', bronze: '#d97706' };

export function Results({ onRetry, onNext, onQuit, onLeaderboard, extra }: { onRetry: () => void; onNext?: () => void; onQuit: () => void; onLeaderboard?: () => void; extra?: React.ReactNode }) {
  const result = useStore((s) => s.result);
  const track = useStore((s) => s.track);
  if (!result || !track) return null;
  const medals = track.medals;
  return (
    <Overlay className="anim-fade-in">
      <Panel className="w-full max-w-lg text-center !bg-[rgba(8,6,30,0.78)]">
        <div className="font-display text-xs tracking-[0.4em] uppercase text-white/60 mb-1">Finish</div>
        {result.worldRecord ? (
          <div className="font-display text-3xl md:text-5xl font-black gradient-text anim-pop mb-1">WORLD RECORD!</div>
        ) : result.isPb ? (
          <div className="font-display text-3xl md:text-5xl font-black text-lime-300 text-glow anim-pop mb-1">NEW PERSONAL BEST!</div>
        ) : (
          <div className="font-display text-3xl md:text-5xl font-black text-white anim-pop mb-1">{track.name}</div>
        )}
        <div className="font-display text-5xl md:text-7xl font-black tabular-nums text-white my-3 anim-pop" style={{ animationDelay: '120ms' }}>{formatTime(result.timeMs)}</div>
        {result.prevPb != null && !result.isPb && <div className="text-sm text-white/60 font-bold">Personal best {formatTime(result.prevPb)} · {formatTime(result.timeMs - result.prevPb, true)}</div>}
        {result.prevPb != null && result.isPb && <div className="text-sm text-lime-300/90 font-bold">Improved by {formatTime(result.prevPb - result.timeMs)}</div>}
        <div className="flex justify-center gap-2 md:gap-3 my-4 flex-wrap stagger">
          {(['author', 'gold', 'silver', 'bronze'] as const).map((m) => {
            const earned = result.timeMs <= medals[m];
            return (
              <div key={m} className={`rounded-xl px-3 py-2 border ${earned ? 'border-white/30' : 'border-white/10 opacity-50'}`} style={{ background: earned ? `${MEDAL_COLORS[m]}22` : 'transparent' }}>
                <div className="text-[10px] uppercase tracking-widest font-bold" style={{ color: MEDAL_COLORS[m] }}>{m === 'author' ? 'Author' : m}</div>
                <div className="font-display text-sm font-bold tabular-nums">{formatTime(medals[m])}</div>
              </div>
            );
          })}
        </div>
        {(result.xp != null || result.rank != null) && (
          <div className="flex justify-center gap-6 mb-4 text-sm font-bold">
            {result.rank != null && <div><span className="text-white/50">Global rank </span><span className="text-cyan-300">#{result.rank}</span></div>}
            {result.xp != null && <div><span className="text-white/50">XP </span><span className="text-fuchsia-300">+{result.xp}</span></div>}
            {result.coins != null && <div><span className="text-white/50">Coins </span><span className="text-yellow-300">+{result.coins}</span></div>}
          </div>
        )}
        {result.achievements && result.achievements.length > 0 && (
          <div className="mb-4 flex flex-wrap justify-center gap-2">{result.achievements.map((a) => <span key={a} className="rounded-full bg-yellow-400/20 border border-yellow-300/40 text-yellow-200 text-xs font-bold px-3 py-1">🏆 {a}</span>)}</div>
        )}
        {extra}
        <div className="flex flex-wrap justify-center gap-3 mt-2">
          <Button variant="primary" onClick={onRetry}>Retry (R)</Button>
          {onNext && <Button onClick={onNext}>Next track</Button>}
          {onLeaderboard && <Button onClick={onLeaderboard}>Leaderboard</Button>}
          <Button variant="ghost" onClick={onQuit}>Menu</Button>
        </div>
      </Panel>
    </Overlay>
  );
}
