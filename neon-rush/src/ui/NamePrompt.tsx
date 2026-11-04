import React, { useState } from 'react';
import { sanitizeName } from '@shared/game/names';
import { Button, Overlay, Panel } from './components';

const SUGGESTIONS = ['NeonFox', 'TurboKid', 'PixelRacer', 'SkyDrifter', 'VoltRunner', 'NovaBlitz', 'ZoomZoom', 'CometCruiser'];

export function NamePrompt({ onDone, initial }: { onDone: (name: string) => void; initial?: string }) {
  const [name, setName] = useState(initial ?? '');
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const clean = sanitizeName(name);
    if (!clean) { setErr('Use 3–16 letters, numbers or underscores (keep it friendly).'); return; }
    onDone(clean);
  };
  return (
    <Overlay className="bg-black/40 backdrop-blur-sm z-40">
      <Panel className="w-full max-w-md text-center anim-pop">
        <div className="font-display text-xs tracking-[0.4em] uppercase text-white/60">Welcome to</div>
        <div className="font-display text-4xl font-black gradient-text anim-gradient my-1">NEON RUSH</div>
        <div className="text-sm text-white/70 font-semibold mb-4">Pick a racer name. You can create an account later to save progress across devices.</div>
        <input autoFocus className="input rounded-xl px-4 py-3 w-full text-center font-display text-xl tracking-wider" placeholder="Racer name" maxLength={16} value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        {err && <div className="mt-2 text-xs font-bold text-red-300">{err}</div>}
        <div className="flex flex-wrap justify-center gap-1.5 mt-3">
          {SUGGESTIONS.map((s) => <button key={s} onClick={() => setName(s + Math.floor(10 + Math.random() * 89))} className="rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-bold text-white/70 hover:bg-white/10">{s}</button>)}
        </div>
        <Button variant="primary" className="mt-4 w-full" onClick={submit}>Let's race</Button>
      </Panel>
    </Overlay>
  );
}
