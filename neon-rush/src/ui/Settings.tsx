import React from 'react';
import { useStore } from '@app/store';
import { Button, Panel, Overlay } from './components';
import { tryGame } from '@app/gameRef';
import type { QualityLevel } from '@game/render/renderer';
import type { CameraMode } from '@game/camera/cameraRig';
import { getAudio } from '@game/audio/audio';

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
      <div className="w-36 md:w-44 shrink-0"><div className="font-display text-sm font-bold">{label}</div>{hint && <div className="text-[11px] text-white/45 font-semibold">{hint}</div>}</div>
      <div className="flex-1 flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}
function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-white/15">
      {options.map((o) => <button key={o.v} onClick={() => onChange(o.v)} className={`px-3 py-1.5 text-xs font-bold tracking-wider uppercase ${o.v === value ? 'bg-cyan-400/30 text-cyan-200' : 'bg-white/[0.03] text-white/60 hover:bg-white/10'}`}>{o.l}</button>)}
    </div>
  );
}

export function SettingsScreen({ onBack, inRace, account }: { onBack: () => void; inRace?: boolean; account?: React.ReactNode }) {
  const settings = useStore((s) => s.settings);
  const set = useStore((s) => s.setSettings);
  const isTouch = useStore((s) => s.isTouch);
  return (
    <Overlay className={inRace ? 'bg-black/50 backdrop-blur-sm' : ''}>
      <Panel title="SETTINGS" onBack={onBack} className="w-full max-w-xl max-h-[90vh] overflow-y-auto scroll-thin anim-fade-up">
        <Row label="Graphics quality" hint="Auto picks based on your device">
          <Seg value={settings.quality} options={[{ v: 'auto', l: 'Auto' }, { v: 'low', l: 'Low' }, { v: 'medium', l: 'Medium' }, { v: 'high', l: 'High' }]} onChange={(v) => { set({ quality: v }); if (v !== 'auto') tryGame()?.setQuality(v as QualityLevel); }} />
        </Row>
        <Row label="Music volume">
          <input type="range" min={0} max={1} step={0.05} value={settings.music} onChange={(e) => { const v = Number(e.target.value); set({ music: v }); getAudio().setMusicVolume(v); }} className="w-40 accent-fuchsia-400" />
          <span className="text-xs text-white/60 w-8">{Math.round(settings.music * 100)}%</span>
        </Row>
        <Row label="Sound effects">
          <input type="range" min={0} max={1} step={0.05} value={settings.sfx} onChange={(e) => { const v = Number(e.target.value); set({ sfx: v }); getAudio().setSfxVolume(v); getAudio().playSfx('click'); }} className="w-40 accent-cyan-400" />
          <span className="text-xs text-white/60 w-8">{Math.round(settings.sfx * 100)}%</span>
        </Row>
        <Row label="Default camera">
          <Seg value={settings.cameraMode} options={[{ v: 'chase', l: 'Chase' }, { v: 'close', l: 'Close' }, { v: 'hood', l: 'Hood' }, { v: 'cinematic', l: 'Cinematic' }]} onChange={(v) => { set({ cameraMode: v as CameraMode }); tryGame()?.setCameraMode(v as CameraMode); }} />
        </Row>
        <Row label="Ghost car" hint="Show your best run while racing">
          <Seg value={settings.showGhost ? 'on' : 'off'} options={[{ v: 'on', l: 'On' }, { v: 'off', l: 'Off' }]} onChange={(v) => set({ showGhost: v === 'on' })} />
        </Row>
        <Row label="Touch controls" hint={isTouch ? 'Touch screen detected' : 'No touch screen detected'}>
          <Seg value={settings.showTouchControls} options={[{ v: 'auto', l: 'Auto' }, { v: 'on', l: 'On' }, { v: 'off', l: 'Off' }]} onChange={(v) => set({ showTouchControls: v })} />
        </Row>
        <Row label="Steering sensitivity" hint="Touch steering strength">
          <input type="range" min={0.5} max={1.5} step={0.05} value={settings.touchSensitivity} onChange={(e) => { const v = Number(e.target.value); set({ touchSensitivity: v }); const g = tryGame(); if (g) g.input.touchSteerSensitivity = v; }} className="w-40 accent-lime-400" />
          <span className="text-xs text-white/60 w-10">{settings.touchSensitivity.toFixed(2)}×</span>
        </Row>
        <div className="mt-4 rounded-xl bg-black/30 border border-white/10 p-3 text-xs text-white/60 font-semibold leading-relaxed">
          <div className="font-display text-white/80 mb-1 tracking-wider">CONTROLS</div>
          W / ↑ accelerate · S / ↓ brake & reverse · A / ← and D / → steer · Space drift · R instant restart · Backspace respawn at checkpoint · C change camera · Esc pause. Gamepads work too.
        </div>
        {account && <div className="mt-4">{account}</div>}
        <div className="mt-4 flex justify-end"><Button variant="primary" onClick={onBack}>Done</Button></div>
      </Panel>
    </Overlay>
  );
}
