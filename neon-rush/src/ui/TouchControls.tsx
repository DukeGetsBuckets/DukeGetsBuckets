import React, { useEffect, useRef } from 'react';
import { tryGame } from '@app/gameRef';

function useHold(key: 'left' | 'right' | 'throttle' | 'brake' | 'drift') {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const set = (v: boolean) => { const g = tryGame(); if (g) g.input.touch[key] = v; el.classList.toggle('active', v); };
    const down = (e: PointerEvent) => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); set(true); };
    const up = (e: PointerEvent) => { e.preventDefault(); set(false); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeEventListener('pointerleave', up); set(false); };
  }, [key]);
  return ref;
}

export function TouchControls({ onRestart, onPause, onCamera }: { onRestart: () => void; onPause: () => void; onCamera: () => void }) {
  const left = useHold('left');
  const right = useHold('right');
  const gas = useHold('throttle');
  const brake = useHold('brake');
  const drift = useHold('drift');
  const big = 'w-[88px] h-[88px] md:w-[104px] md:h-[104px] text-3xl';
  return (
    <div className="absolute inset-0 pointer-events-none select-none" style={{ paddingBottom: 'calc(var(--safe-bottom) + 14px)', paddingLeft: 'calc(var(--safe-left) + 14px)', paddingRight: 'calc(var(--safe-right) + 14px)' }}>
      <div className="absolute left-0 bottom-0 flex gap-3 pointer-events-auto" style={{ padding: 'inherit' }}>
        <div ref={left} className={`touch-btn ${big}`}>◀</div>
        <div ref={right} className={`touch-btn ${big}`}>▶</div>
      </div>
      <div className="absolute right-0 bottom-0 flex items-end gap-3 pointer-events-auto" style={{ padding: 'inherit' }}>
        <div ref={drift} className="touch-btn w-[64px] h-[64px] text-sm">DRIFT</div>
        <div ref={brake} className={`touch-btn ${big}`}>▼</div>
        <div ref={gas} className={`touch-btn ${big} !border-cyan-300/60`}>▲</div>
      </div>
      <div className="absolute left-1/2 -translate-x-1/2 top-12 flex gap-3 pointer-events-auto" style={{ top: 'calc(var(--safe-top) + 64px)' }}>
        <button onClick={onRestart} className="touch-btn w-[52px] h-[52px] text-lg">↻</button>
        <button onClick={onCamera} className="touch-btn w-[52px] h-[52px] text-base">📷</button>
        <button onClick={onPause} className="touch-btn w-[52px] h-[52px] text-lg">II</button>
      </div>
    </div>
  );
}
