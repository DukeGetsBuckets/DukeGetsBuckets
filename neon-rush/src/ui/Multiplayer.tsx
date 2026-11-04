import React, { useEffect, useRef, useState } from 'react';
import type { RoomState, RaceResultEntry } from '@shared/net';
import { OFFICIAL_TRACKS, DIFFICULTY_NAMES } from '@shared/track/officialTracks';
import { THEMES } from '@game/track/themes';
import { formatTime } from '@shared/math';
import { Button, Panel, Pill, CarColorDot, Overlay, Spinner } from './components';
import type { LiveClient } from '@app/net/liveClient';

export function MultiplayerHome({ onBack, onCreate, onJoin, busy, error, initialCode }: { onBack: () => void; onCreate: () => void; onJoin: (code: string) => void; busy: boolean; error: string | null; initialCode?: string }) {
  const [code, setCode] = useState(initialCode ?? '');
  return (
    <Overlay>
      <Panel title="MULTIPLAYER" onBack={onBack} className="w-full max-w-lg anim-fade-up">
        <div className="grid md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 p-4 flex flex-col gap-3">
            <div className="font-display font-black tracking-wider text-lg">CREATE A ROOM</div>
            <div className="text-sm text-white/65 font-semibold">Get a short code and a link to share. Up to 8 racers, no collisions, pure skill.</div>
            <Button variant="primary" disabled={busy} onClick={onCreate}>{busy ? 'Connecting…' : 'Create room'}</Button>
          </div>
          <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-4 flex flex-col gap-3">
            <div className="font-display font-black tracking-wider text-lg">JOIN A ROOM</div>
            <input className="input rounded-lg px-3 py-2 text-center font-display text-xl tracking-[0.3em] uppercase" placeholder="CODE" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && code.length >= 4) onJoin(code); }} />
            <Button disabled={busy || code.length < 4} onClick={() => onJoin(code)}>Join</Button>
          </div>
        </div>
        {error && <div className="mt-3 text-sm font-bold text-red-300">{error}</div>}
        <div className="mt-4 text-xs text-white/45 font-semibold">Tip: share the invite link from the lobby — friends join with one tap.</div>
      </Panel>
    </Overlay>
  );
}

export function Lobby({ client, room, onLeave, onSelectTrack }: { client: LiveClient; room: RoomState; onLeave: () => void; onSelectTrack: (id: string) => void }) {
  const me = room.players.find((p) => p.id === client.you);
  const isHost = room.hostId === client.you;
  const track = OFFICIAL_TRACKS.find((t) => t.id === room.trackId) ?? OFFICIAL_TRACKS[0];
  const theme = THEMES[track.theme];
  const [chat, setChat] = useState<{ name: string; text: string; id: number }[]>([]);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const allReady = room.players.filter((p) => p.connected).every((p) => p.ready) && room.players.length >= 2;
  const inviteLink = `${location.origin}${location.pathname}?room=${room.code}`;

  useEffect(() => client.on('chat', (_from, name, t) => { setChat((c) => [...c.slice(-40), { name, text: t, id: Date.now() + Math.random() }]); }), [client]);
  useEffect(() => { chatRef.current?.scrollTo({ top: 99999 }); }, [chat]);

  const copy = async (what: 'code' | 'link') => {
    const v = what === 'code' ? room.code : inviteLink;
    try { await navigator.clipboard.writeText(v); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };
  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: { title: string; text: string; url: string }) => Promise<void> };
    if (nav.share) { try { await nav.share({ title: 'NEON RUSH', text: `Race me in NEON RUSH! Room ${room.code}`, url: inviteLink }); } catch { /* ignore */ } }
    else copy('link');
  };

  return (
    <div className="absolute inset-0 p-3 md:p-6 flex flex-col md:flex-row gap-4 pointer-events-none" style={{ paddingTop: 'calc(var(--safe-top) + 12px)', paddingBottom: 'calc(var(--safe-bottom) + 12px)' }}>
      <Panel className="pointer-events-auto md:w-[400px] flex flex-col anim-slide-left" title="LOBBY" onBack={onLeave}>
        <div className="rounded-xl bg-black/30 border border-white/10 p-3 flex items-center gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">Room code</div>
            <div className="font-display text-3xl font-black tracking-[0.25em] gradient-text">{room.code}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <Button className="!px-3 !py-2 text-xs" onClick={() => copy('code')}>{copied === 'code' ? 'Copied!' : 'Copy'}</Button>
            <Button className="!px-3 !py-2 text-xs" onClick={share}>{copied === 'link' ? 'Link copied!' : 'Invite'}</Button>
          </div>
        </div>
        <div className="mt-3 text-[10px] uppercase tracking-widest text-white/50 font-bold">Racers ({room.players.length}/8)</div>
        <div className="mt-1 space-y-1.5 flex-1 overflow-y-auto scroll-thin">
          {room.players.map((p) => (
            <div key={p.id} className={`flex items-center gap-3 rounded-lg px-3 py-2 border ${p.id === client.you ? 'border-cyan-300/50 bg-cyan-400/10' : 'border-white/10 bg-white/[0.03]'} ${!p.connected ? 'opacity-40' : ''}`}>
              <CarColorDot color={p.car.paint} size={14} />
              <div className="font-display font-bold text-sm flex-1 truncate">{p.name}{p.id === client.you ? ' (you)' : ''}</div>
              {p.wins > 0 && <Pill color="#facc15">{p.wins} 🏆</Pill>}
              {p.isHost && <Pill color="#f472b6">Host</Pill>}
              <Pill color={p.ready ? '#a3e635' : '#94a3b8'}>{p.ready ? 'Ready' : 'Waiting'}</Pill>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant={me?.ready ? 'ghost' : 'primary'} className="flex-1" onClick={() => client.setReady(!me?.ready)}>{me?.ready ? 'Not ready' : 'Ready!'}</Button>
          {isHost && <Button variant={allReady ? 'primary' : 'default'} className="flex-1" onClick={() => client.start()}>Start race</Button>}
        </div>
        {!isHost && <div className="mt-2 text-xs text-white/50 font-semibold text-center">{allReady ? 'All ready — waiting for the host to start.' : 'The race starts when everyone is ready.'}</div>}
        <div className="mt-3 rounded-xl bg-black/30 border border-white/10 p-2 flex flex-col h-32">
          <div ref={chatRef} className="flex-1 overflow-y-auto scroll-thin text-xs space-y-0.5 px-1">
            {chat.length === 0 && <div className="text-white/35 font-semibold">Say hi to your rivals…</div>}
            {chat.map((c) => <div key={c.id}><span className="font-bold text-cyan-300">{c.name}: </span><span className="text-white/85">{c.text}</span></div>)}
          </div>
          <form className="flex gap-2 mt-1" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { client.chat(text.trim()); setText(''); } }}>
            <input className="input rounded-lg px-2 py-1 text-xs flex-1" placeholder="Chat" maxLength={120} value={text} onChange={(e) => setText(e.target.value)} />
            <Button className="!px-3 !py-1 text-xs" type="submit">Send</Button>
          </form>
        </div>
      </Panel>
      <div className="flex-1 flex flex-col justify-end pointer-events-none">
        <div className="panel rounded-2xl p-4 md:p-6 pointer-events-auto anim-fade-up" style={{ borderColor: `${theme.accent}55` }}>
          <div className="flex items-center gap-2 mb-1"><Pill color={theme.accent}>{theme.name}</Pill><Pill color="#cbd5e1">{DIFFICULTY_NAMES[track.difficulty]}</Pill><span className="ml-auto text-xs text-white/50 font-bold">Round {room.round + 1}</span></div>
          <div className="font-display text-2xl md:text-3xl font-black tracking-wider">{track.name}</div>
          <div className="text-white/65 text-sm font-semibold">{track.description}</div>
          {isHost ? (
            <div className="mt-3 flex gap-2 overflow-x-auto scroll-thin pb-1">
              {OFFICIAL_TRACKS.map((t) => (
                <button key={t.id} onClick={() => onSelectTrack(t.id)} className={`shrink-0 rounded-lg px-3 py-2 border text-left ${t.id === room.trackId ? 'border-cyan-300/70 bg-cyan-400/15' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'}`}>
                  <div className="flex items-center gap-2"><span className="w-1.5 h-6 rounded-full" style={{ background: THEMES[t.theme].accent }} /><div><div className="font-display text-xs font-bold">{t.name}</div><div className="text-[10px] text-white/50">{DIFFICULTY_NAMES[t.difficulty]}</div></div></div>
                </button>
              ))}
            </div>
          ) : <div className="mt-3 text-xs text-white/45 font-semibold">The host picks the track.</div>}
        </div>
      </div>
    </div>
  );
}

export function LiveResults({ results, room, you, onRematch, onLeave, waiting }: { results: RaceResultEntry[]; room: RoomState; you: string | null; onRematch: () => void; onLeave: () => void; waiting: boolean }) {
  const podium = results.slice(0, 3);
  const medalColors = ['#facc15', '#cbd5e1', '#d97706'];
  const mine = results.find((r) => r.id === you);
  return (
    <Overlay className="anim-fade-in">
      <Panel className="w-full max-w-xl text-center !bg-[rgba(8,6,30,0.8)]">
        <div className="font-display text-xs tracking-[0.4em] uppercase text-white/60">Race results · Round {room.round + 1}</div>
        <div className={`font-display text-3xl md:text-5xl font-black my-2 anim-pop ${mine?.position === 1 ? 'gradient-text' : 'text-white'}`}>{mine ? (mine.position === 1 ? 'VICTORY!' : mine.dnf ? 'DID NOT FINISH' : `${ordinal(mine.position)} PLACE`) : 'FINISHED'}</div>
        <div className="flex items-end justify-center gap-3 my-4 stagger">
          {[1, 0, 2].map((i) => podium[i] ? (
            <div key={podium[i].id} className="flex flex-col items-center" style={{ order: i }}>
              <CarColorDot color={podium[i].carColor} size={18} />
              <div className="font-display font-bold text-sm mt-1 max-w-[110px] truncate">{podium[i].name}</div>
              <div className="text-xs text-white/70 tabular-nums">{podium[i].dnf || podium[i].timeMs == null ? 'DNF' : formatTime(podium[i].timeMs)}</div>
              <div className="rounded-t-xl w-24 md:w-28 mt-2 flex items-start justify-center font-display font-black text-[#07061a] text-2xl pt-1" style={{ height: i === 0 ? 90 : i === 1 ? 64 : 48, background: medalColors[i], boxShadow: `0 0 24px ${medalColors[i]}` }}>{i + 1}</div>
            </div>
          ) : <div key={i} style={{ order: i }} className="w-24 md:w-28" />)}
        </div>
        <div className="max-h-40 overflow-y-auto scroll-thin text-sm">
          {results.map((r) => (
            <div key={r.id} className={`flex items-center gap-3 px-3 py-1.5 rounded-lg ${r.id === you ? 'bg-cyan-400/10' : ''}`}>
              <div className="font-display font-black w-6 text-white/60">{r.position}</div>
              <CarColorDot color={r.carColor} />
              <div className="flex-1 text-left font-bold truncate">{r.name}</div>
              <div className="tabular-nums text-white/80">{r.dnf || r.timeMs == null ? 'DNF' : formatTime(r.timeMs)}</div>
            </div>
          ))}
        </div>
        <div className="flex justify-center gap-3 mt-4">
          <Button variant="primary" onClick={onRematch} disabled={waiting}>{waiting ? 'Waiting for lobby…' : 'Rematch'}</Button>
          <Button variant="ghost" onClick={onLeave}>Leave room</Button>
        </div>
      </Panel>
    </Overlay>
  );
}

export function LiveWaiting({ message }: { message: string }) {
  return (
    <Overlay className="pointer-events-none">
      <div className="panel rounded-2xl px-6 py-4 flex items-center gap-4 anim-fade-in"><Spinner /><div className="font-display font-bold tracking-wider">{message}</div></div>
    </Overlay>
  );
}

export function ordinal(n: number) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

/** Live position list shown during a race. */
export function LivePositions({ room, you }: { room: RoomState; you: string | null }) {
  const sorted = [...room.players].filter((p) => p.connected || p.finished).sort((a, b) => a.position - b.position);
  return (
    <div className="absolute left-4 top-24 md:top-28 flex flex-col gap-1 pointer-events-none" style={{ paddingLeft: 'var(--safe-left)' }}>
      {sorted.slice(0, 8).map((p) => (
        <div key={p.id} className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-bold backdrop-blur-sm ${p.id === you ? 'bg-cyan-400/25 border border-cyan-300/50' : 'bg-black/35'}`}>
          <span className="font-display w-4 text-white/80">{p.position || '-'}</span>
          <CarColorDot color={p.car.paint} size={10} />
          <span className="truncate max-w-[110px]">{p.name}</span>
          {p.finished && p.finishTimeMs != null && <span className="text-lime-300 tabular-nums">{formatTime(p.finishTimeMs)}</span>}
        </div>
      ))}
    </div>
  );
}
