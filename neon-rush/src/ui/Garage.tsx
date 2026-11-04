import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '@app/store';
import { tryGame } from '@app/gameRef';
import { COSMETICS, PAINT_COLORS, type CarConfig, type CosmeticItem } from '@shared/game/carConfig';
import { CAR_BODY_NAMES } from '@game/car/carModel';
import { Button, Panel, Pill } from './components';
import { getAudio } from '@game/audio/audio';

type Tab = 'body' | 'paint' | 'accent' | 'finish' | 'underglow' | 'wheel' | 'tire' | 'trail' | 'decal' | 'effect';
const TABS: { id: Tab; label: string }[] = [
  { id: 'body', label: 'Body' }, { id: 'paint', label: 'Paint' }, { id: 'accent', label: 'Accent' }, { id: 'finish', label: 'Finish' },
  { id: 'underglow', label: 'Underglow' }, { id: 'wheel', label: 'Wheels' }, { id: 'tire', label: 'Rims' }, { id: 'trail', label: 'Trail' },
  { id: 'decal', label: 'Decal' }, { id: 'effect', label: 'Effect' },
];

export interface GarageOwnership {
  level: number;
  coins: number;
  unlocked: string[];
  achievements: string[];
  signedIn: boolean;
}

function itemLocked(item: CosmeticItem, own: GarageOwnership): { locked: boolean; reason: string; canBuy: boolean } {
  if (item.cost === 0 && !item.unlockLevel && !item.achievement) return { locked: false, reason: '', canBuy: false };
  if (own.unlocked.includes(item.id)) return { locked: false, reason: '', canBuy: false };
  if (item.achievement && !own.achievements.includes(item.achievement)) return { locked: true, reason: 'Achievement required', canBuy: false };
  if (item.unlockLevel && own.level < item.unlockLevel) return { locked: true, reason: `Level ${item.unlockLevel}`, canBuy: false };
  return { locked: true, reason: `${item.cost} coins`, canBuy: own.coins >= item.cost };
}

export function GarageScreen({ onBack, ownership, onBuy, onSave }: { onBack: () => void; ownership: GarageOwnership; onBuy: (item: CosmeticItem) => Promise<boolean>; onSave: (cfg: CarConfig) => void }) {
  const carConfig = useStore((s) => s.carConfig);
  const [cfg, setCfg] = useState<CarConfig>(carConfig);
  const [tab, setTab] = useState<Tab>('body');
  const [buying, setBuying] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; angle: number } | null>(null);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(carConfig);

  useEffect(() => { tryGame()?.setCarConfig(cfg); }, [cfg]);
  useEffect(() => () => { tryGame()?.setCarConfig(useStore.getState().carConfig); }, []);

  const update = (patch: Partial<CarConfig>) => { setCfg((c) => ({ ...c, ...patch })); getAudio().playSfx('click'); };
  const tryApply = async (item: CosmeticItem, patch: Partial<CarConfig>) => {
    const st = itemLocked(item, ownership);
    if (!st.locked) { update(patch); return; }
    if (!st.canBuy) { setMsg(st.reason === 'Achievement required' ? 'Unlock the achievement first.' : ownership.signedIn ? `Need ${st.reason} to unlock.` : 'Sign in to earn coins and unlock items.'); getAudio().playSfx('error'); return; }
    setBuying(item.id);
    const ok = await onBuy(item);
    setBuying(null);
    if (ok) { getAudio().playSfx('unlock'); update(patch); setMsg(`Unlocked ${item.name}!`); } else { getAudio().playSfx('error'); setMsg('Purchase failed.'); }
    setTimeout(() => setMsg(null), 2500);
  };

  const onPointerDown = (e: React.PointerEvent) => { dragRef.current = { x: e.clientX, angle: 0 }; };
  const onPointerMove = (e: React.PointerEvent) => { if (!dragRef.current) return; const dx = e.clientX - dragRef.current.x; dragRef.current.x = e.clientX; tryGame()?.nudgeGarageAngle(dx * 0.01); };
  const onPointerUp = () => { dragRef.current = null; };

  const renderItems = () => {
    const of = (kind: CosmeticItem['kind']) => COSMETICS.filter((i) => i.kind === kind);
    const Tile = ({ item, selected, patch, children }: { item: CosmeticItem; selected: boolean; patch: Partial<CarConfig>; children?: React.ReactNode }) => {
      const st = itemLocked(item, ownership);
      return (
        <button onClick={() => tryApply(item, patch)} className={`relative rounded-xl border px-3 py-2.5 text-left transition-all ${selected ? 'border-cyan-300/70 bg-cyan-400/15' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.08]'} ${st.locked ? 'opacity-80' : ''}`}>
          <div className="flex items-center gap-2">{children}<div className="font-display text-xs font-bold">{item.name}</div></div>
          {st.locked && <div className="mt-1"><Pill color={st.canBuy ? '#facc15' : '#94a3b8'}>{buying === item.id ? '…' : `🔒 ${st.reason}`}</Pill></div>}
        </button>
      );
    };
    switch (tab) {
      case 'body': return of('body').map((i) => <Tile key={i.id} item={i} selected={cfg.body === i.value} patch={{ body: i.value as CarConfig['body'] }}><span className="w-2 h-6 rounded bg-gradient-to-b from-cyan-300 to-fuchsia-400" /></Tile>);
      case 'paint':
      case 'accent': {
        const key = tab === 'paint' ? 'paint' : 'paint2';
        return PAINT_COLORS.map((c) => {
          const item: CosmeticItem = { id: `paint_${c.value}`, kind: 'paint', value: c.value, name: c.name, cost: c.cost };
          return <Tile key={c.value} item={item} selected={cfg[key] === c.value} patch={{ [key]: c.value } as Partial<CarConfig>}><span className="w-6 h-6 rounded-full border border-white/20" style={{ background: c.value, boxShadow: `0 0 10px ${c.value}` }} /></Tile>;
        });
      }
      case 'finish': return of('finish').map((i) => <Tile key={i.id} item={i} selected={cfg.finish === i.value} patch={{ finish: i.value as CarConfig['finish'] }} />);
      case 'underglow': return [{ id: 'underglow_none', kind: 'underglow' as const, value: 'none', name: 'Off', cost: 0 }, ...PAINT_COLORS.slice(0, 10).map((c) => ({ id: `ug_${c.value}`, kind: 'underglow' as const, value: c.value, name: c.name, cost: 0 }))].map((i) => <Tile key={i.id} item={i} selected={cfg.underglow === i.value} patch={{ underglow: i.value }}>{i.value !== 'none' && <span className="w-6 h-3 rounded-full" style={{ background: i.value, boxShadow: `0 0 12px ${i.value}` }} />}</Tile>);
      case 'wheel': return of('wheel').map((i) => <Tile key={i.id} item={i} selected={cfg.wheel === i.value} patch={{ wheel: i.value as CarConfig['wheel'] }} />);
      case 'tire': return PAINT_COLORS.slice(0, 12).map((c) => { const item: CosmeticItem = { id: `tire_${c.value}`, kind: 'tire', value: c.value, name: c.name, cost: 0 }; return <Tile key={c.value} item={item} selected={cfg.tireColor === c.value} patch={{ tireColor: c.value }}><span className="w-6 h-6 rounded-full border-4" style={{ borderColor: c.value, boxShadow: `0 0 8px ${c.value}` }} /></Tile>; });
      case 'trail': return of('trail').map((i) => <Tile key={i.id} item={i} selected={cfg.trail === i.value} patch={{ trail: i.value as CarConfig['trail'] }} />);
      case 'decal': return (
        <>
          {of('decal').map((i) => <Tile key={i.id} item={i} selected={cfg.decal === i.value} patch={{ decal: i.value as CarConfig['decal'] }} />)}
          {cfg.decal === 'number' && <div className="col-span-2 flex items-center gap-2"><span className="text-xs font-bold text-white/60">Number</span><input type="number" min={0} max={99} className="input rounded-lg px-2 py-1 w-20" value={cfg.number} onChange={(e) => setCfg((c) => ({ ...c, number: Math.max(0, Math.min(99, Number(e.target.value) || 0)) }))} /></div>}
        </>
      );
      case 'effect': return of('effect').map((i) => <Tile key={i.id} item={i} selected={cfg.effect === i.value} patch={{ effect: i.value as CarConfig['effect'] }} />);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col md:flex-row pointer-events-none" style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}>
      <div className="flex-1 pointer-events-auto cursor-grab active:cursor-grabbing" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
        <div className="absolute left-4 top-4 md:left-6 md:top-6 anim-slide-left pointer-events-none">
          <div className="font-display text-3xl md:text-5xl font-black tracking-wider gradient-text">GARAGE</div>
          <div className="text-xs md:text-sm font-bold tracking-widest uppercase text-white/55 mt-1">{CAR_BODY_NAMES[cfg.body]} · drag to rotate</div>
          <div className="mt-3 flex items-center gap-3 text-sm font-bold"><span className="text-yellow-300">🪙 {ownership.coins}</span><span className="text-cyan-300">Level {ownership.level}</span></div>
        </div>
      </div>
      <Panel className="pointer-events-auto m-3 md:m-5 md:w-[420px] max-h-[55vh] md:max-h-none flex flex-col anim-slide-right" onBack={onBack} right={<Button variant="primary" className="!px-4 !py-2 text-xs" disabled={!dirty} onClick={() => { onSave(cfg); getAudio().playSfx('unlock'); }}>{dirty ? 'Save' : 'Saved'}</Button>}>
        <div className="flex gap-1.5 overflow-x-auto scroll-thin pb-2 -mx-1 px-1">
          {TABS.map((t) => <button key={t.id} onClick={() => { setTab(t.id); getAudio().playSfx('hover'); }} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase border ${tab === t.id ? 'border-fuchsia-300/70 bg-fuchsia-400/20 text-fuchsia-100' : 'border-white/10 text-white/60 hover:bg-white/10'}`}>{t.label}</button>)}
        </div>
        <div className="grid grid-cols-2 gap-2 overflow-y-auto scroll-thin flex-1 mt-2 pr-1">{renderItems()}</div>
        {msg && <div className="mt-2 text-xs font-bold text-yellow-200 anim-fade-in">{msg}</div>}
        <div className="mt-2 text-[11px] text-white/40 font-semibold">All cars perform identically — cosmetics only. Earn coins by racing.</div>
      </Panel>
    </div>
  );
}
