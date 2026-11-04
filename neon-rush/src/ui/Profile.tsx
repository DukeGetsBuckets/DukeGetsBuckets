import React, { useEffect, useState } from 'react';
import type { FriendsResponse, SchoolResponse } from '@shared/api';
import { ACHIEVEMENTS, levelProgress } from '@shared/game/progression';
import { OFFICIAL_TRACKS, OFFICIAL_TRACK_MAP } from '@shared/track/officialTracks';
import { formatTime } from '@shared/math';
import { api, ApiError } from '@app/api';
import { useSession, registerAccount, loginAccount, logout, refreshProfile, markNotificationsRead } from '@app/session';
import { Button, Panel, Pill, CarColorDot, Overlay } from './components';
import { fmtDate } from './Leaderboards';
import { getAudio } from '@game/audio/audio';

type Tab = 'overview' | 'friends' | 'school' | 'inbox' | 'account';

function errMsg(e: unknown) { return e instanceof ApiError ? e.message : (e as Error).message; }

export function ProfileScreen({ onBack, localBests }: { onBack: () => void; localBests: Record<string, number> }) {
  const player = useSession((s) => s.player);
  const online = useSession((s) => s.online);
  const unread = useSession((s) => s.unread);
  const [tab, setTab] = useState<Tab>('overview');
  useEffect(() => { void refreshProfile(); }, []);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' }, { id: 'friends', label: 'Friends' }, { id: 'school', label: 'School' }, { id: 'inbox', label: unread ? `Inbox (${unread})` : 'Inbox' }, { id: 'account', label: 'Account' },
  ];
  return (
    <Overlay>
      <Panel title="PROFILE" onBack={onBack} className="w-full max-w-3xl h-[90vh] flex flex-col anim-fade-up">
        {!player ? (
          <div className="py-10 text-center text-white/60 font-semibold">{online ? 'Loading profile…' : 'The game server is unreachable. Your times are still saved on this device.'}</div>
        ) : (
          <>
            <ProfileHeader />
            <div className="flex gap-1.5 my-3 overflow-x-auto scroll-thin">
              {tabs.map((t) => <button key={t.id} onClick={() => { setTab(t.id); if (t.id === 'inbox') void markNotificationsRead(); }} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border ${tab === t.id ? 'border-cyan-300/70 bg-cyan-400/20 text-cyan-100' : 'border-white/10 text-white/60 hover:bg-white/10'}`}>{t.label}</button>)}
            </div>
            <div className="flex-1 overflow-y-auto scroll-thin min-h-0 pr-1">
              {tab === 'overview' && <Overview localBests={localBests} />}
              {tab === 'friends' && <Friends />}
              {tab === 'school' && <SchoolTab />}
              {tab === 'inbox' && <Inbox />}
              {tab === 'account' && <Account />}
            </div>
          </>
        )}
      </Panel>
    </Overlay>
  );
}

function ProfileHeader() {
  const p = useSession((s) => s.player)!;
  const lp = levelProgress(p.xp);
  return (
    <div className="flex items-center gap-4">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center font-display font-black text-2xl text-[#07061a]" style={{ background: `linear-gradient(135deg, ${p.car.paint}, ${p.car.paint2})`, boxShadow: `0 0 24px ${p.car.paint}88` }}>{p.name[0]?.toUpperCase()}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap"><div className="font-display text-xl font-black truncate">{p.name}</div>{p.isGuest ? <Pill color="#94a3b8">Guest</Pill> : <Pill color="#a3e635">Account</Pill>}{p.schoolName && <Pill color="#38bdf8">{p.schoolName}</Pill>}</div>
        <div className="flex items-center gap-2 mt-1">
          <div className="font-display text-sm font-bold text-cyan-300">LV {lp.level}</div>
          <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden max-w-xs"><div className="h-full bg-gradient-to-r from-cyan-400 via-fuchsia-400 to-orange-300" style={{ width: `${Math.round(lp.fraction * 100)}%` }} /></div>
          <div className="text-[11px] text-white/50 font-bold">{lp.current}/{lp.needed} XP</div>
        </div>
      </div>
      <div className="text-right"><div className="text-yellow-300 font-display font-bold">🪙 {p.coins}</div><div className="text-[10px] text-white/50 font-bold uppercase tracking-widest">Friend code</div><div className="font-display font-bold tracking-widest">{p.friendCode}</div></div>
    </div>
  );
}

function Overview({ localBests }: { localBests: Record<string, number> }) {
  const p = useSession((s) => s.player)!;
  const serverBests = useSession((s) => s.serverBests);
  const st = p.stats;
  const stats: [string, number][] = [['Races', st.races], ['Finishes', st.finishes], ['Wins', st.wins], ['Personal bests', st.personalBests], ['Gold medals', st.goldMedals], ['Author medals', st.authorMedals], ['World records', st.worldRecords], ['Friends beaten', st.friendsBeaten]];
  const unlocked = new Set(p.achievements.map((a) => a.id));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">{stats.map(([l, v]) => <div key={l} className="rounded-xl bg-black/30 border border-white/10 p-2 text-center"><div className="font-display text-lg font-bold">{v}</div><div className="text-[10px] uppercase tracking-wider text-white/50 font-bold">{l}</div></div>)}</div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold mb-1">Achievements · {unlocked.size}/{ACHIEVEMENTS.length}</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {ACHIEVEMENTS.map((a) => (
            <div key={a.id} className={`rounded-xl border p-2 flex items-center gap-2 ${unlocked.has(a.id) ? 'border-yellow-300/50 bg-yellow-400/10' : 'border-white/10 opacity-50'}`}>
              <div className="text-2xl">{unlocked.has(a.id) ? a.icon : '🔒'}</div>
              <div className="min-w-0"><div className="font-display text-xs font-bold truncate">{a.name}</div><div className="text-[10px] text-white/55 leading-tight">{a.description}</div></div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold mb-1">Personal bests</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
          {OFFICIAL_TRACKS.map((t) => { const b = Math.min(serverBests[t.id] ?? Infinity, localBests[t.id] ?? Infinity); return <div key={t.id} className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-1.5 text-sm"><span className="font-semibold truncate">{t.name}</span><span className="font-display tabular-nums text-white/80">{Number.isFinite(b) ? formatTime(b) : '—'}</span></div>; })}
        </div>
      </div>
    </div>
  );
}

function Friends() {
  const [data, setData] = useState<FriendsResponse | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [challengeFor, setChallengeFor] = useState<string | null>(null);
  const load = () => api.friends.list().then(setData).catch((e) => setMsg(errMsg(e)));
  useEffect(() => { void load(); }, []);
  const add = async () => {
    try { const r = await api.friends.add(code); setMsg(`Added ${r.friend.name}!`); setCode(''); getAudio().playSfx('unlock'); void load(); void refreshProfile(); } catch (e) { setMsg(errMsg(e)); getAudio().playSfx('error'); }
  };
  const challenge = async (friendId: string, trackId: string) => {
    try { await api.challenge(friendId, trackId); setMsg('Challenge sent!'); setChallengeFor(null); getAudio().playSfx('notify'); } catch (e) { setMsg(errMsg(e)); }
  };
  const myBests = useSession((s) => s.serverBests);
  return (
    <div className="space-y-3">
      <div className="flex gap-2"><input className="input rounded-lg px-3 py-2 flex-1 font-display tracking-widest uppercase" placeholder="Friend code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /><Button variant="primary" disabled={code.length < 4} onClick={add}>Add friend</Button></div>
      {msg && <div className="text-xs font-bold text-yellow-200">{msg}</div>}
      {data && data.friends.length === 0 && <div className="text-sm text-white/50 font-semibold py-4 text-center">Share your friend code so friends can add you, then compare times on every track.</div>}
      {data?.friends.map((f) => {
        const ahead = OFFICIAL_TRACKS.filter((t) => f.bests[t.id] != null && myBests[t.id] != null && myBests[t.id] < f.bests[t.id]).length;
        const behind = OFFICIAL_TRACKS.filter((t) => f.bests[t.id] != null && (myBests[t.id] == null || myBests[t.id] > f.bests[t.id])).length;
        return (
          <div key={f.id} className="rounded-xl bg-white/[0.04] border border-white/10 p-3">
            <div className="flex items-center gap-3">
              <CarColorDot color={f.carColor} size={14} />
              <div className="flex-1 min-w-0"><div className="font-display font-bold truncate">{f.name} <span className="text-[10px] text-white/40">Lv {f.level}</span></div><div className="text-[10px] text-white/45 font-semibold">seen {fmtDate(f.lastSeen)}{f.schoolName ? ` · ${f.schoolName}` : ''}</div></div>
              <div className="text-xs font-bold"><span className="text-lime-300">You lead {ahead}</span> · <span className="text-orange-300">They lead {behind}</span></div>
              <Button className="!px-3 !py-1.5 text-[11px]" onClick={() => setChallengeFor(challengeFor === f.id ? null : f.id)}>Challenge</Button>
            </div>
            {challengeFor === f.id && (
              <div className="mt-2 flex flex-wrap gap-1.5">{OFFICIAL_TRACKS.map((t) => <button key={t.id} onClick={() => challenge(f.id, t.id)} className="rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-bold hover:bg-white/10">{t.name}{f.bests[t.id] != null ? ` · ${formatTime(f.bests[t.id])}` : ''}</button>)}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SchoolTab() {
  const p = useSession((s) => s.player)!;
  const [data, setData] = useState<SchoolResponse | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [view, setView] = useState<'all' | 'weekly'>('weekly');
  useEffect(() => { if (p.schoolId) api.schools.mine().then((r) => { if ('rankings' in r) setData(r); }).catch((e) => setMsg(errMsg(e))); }, [p.schoolId]);
  const done = (r: SchoolResponse) => { setData(r); void refreshProfile(); getAudio().playSfx('unlock'); };
  if (!p.schoolId || !data) {
    return (
      <div className="grid md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-4 space-y-2">
          <div className="font-display font-black">JOIN YOUR SCHOOL</div>
          <div className="text-xs text-white/60 font-semibold">Ask a classmate for the school code.</div>
          <input className="input rounded-lg px-3 py-2 w-full font-display tracking-widest uppercase" placeholder="School code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <Button variant="primary" className="w-full" disabled={code.length < 4} onClick={async () => { try { done(await api.schools.join(code)); } catch (e) { setMsg(errMsg(e)); } }}>Join</Button>
        </div>
        <div className="rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 p-4 space-y-2">
          <div className="font-display font-black">CREATE A SCHOOL GROUP</div>
          <div className="text-xs text-white/60 font-semibold">Start the rivalry and share the code.</div>
          <input className="input rounded-lg px-3 py-2 w-full" placeholder="School name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          <Button className="w-full" disabled={name.trim().length < 3} onClick={async () => { try { done(await api.schools.create(name.trim())); } catch (e) { setMsg(errMsg(e)); } }}>Create</Button>
        </div>
        {msg && <div className="text-xs font-bold text-yellow-200 md:col-span-2">{msg}</div>}
      </div>
    );
  }
  const rows = view === 'weekly' ? data.weekly.rankings : data.rankings;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="font-display text-xl font-black">{data.school.name}</div>
        <Pill color="#38bdf8">{data.school.memberCount} racers</Pill>
        <div className="text-xs text-white/60 font-bold">Code <span className="font-display tracking-widest text-white">{data.school.code}</span></div>
        <Button variant="ghost" className="ml-auto !px-3 !py-1.5 text-[11px]" onClick={async () => { await api.schools.leave(); setData(null); void refreshProfile(); }}>Leave</Button>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1"><div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">Championship</div>
            <div className="ml-auto flex rounded-lg overflow-hidden border border-white/15">{(['weekly', 'all'] as const).map((v) => <button key={v} onClick={() => setView(v)} className={`px-2 py-1 text-[10px] font-bold uppercase ${view === v ? 'bg-cyan-400/30' : 'text-white/60'}`}>{v === 'weekly' ? `Week ${data.weekly.weekKey.split('-W')[1]}` : 'All-time'}</button>)}</div></div>
          {view === 'weekly' && <div className="text-[10px] text-white/40 font-semibold mb-1">Ends {new Date(data.weekly.endsAt).toLocaleDateString(undefined, { weekday: 'long' })}</div>}
          <div className="space-y-1">{rows.length === 0 ? <div className="text-xs text-white/50 py-3">No points yet this period.</div> : rows.map((r) => (
            <div key={r.playerId} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${r.playerId === p.id ? 'bg-cyan-400/15' : 'bg-white/[0.03]'}`}><span className="font-display font-black w-6 text-white/60">{r.rank}</span><CarColorDot color={r.carColor} /><span className="flex-1 font-bold truncate">{r.name}</span><span className="font-display text-fuchsia-300">{r.points} pts</span></div>
          ))}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold mb-1">School records</div>
          <div className="space-y-1">{data.records.map((r) => <div key={r.trackId} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 text-sm"><span className="flex-1 truncate font-semibold">{OFFICIAL_TRACK_MAP[r.trackId]?.name ?? r.trackName}</span><span className="text-white/60 truncate max-w-[90px]">{r.playerName}</span><span className="font-display tabular-nums">{formatTime(r.timeMs)}</span></div>)}</div>
          {data.rivalries.length > 0 && <>
            <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold mt-3 mb-1">Rivalries</div>
            {data.rivalries.slice(0, 5).map((rv) => <div key={rv.a.id + rv.b.id} className="flex items-center gap-2 text-sm rounded-lg bg-white/[0.03] px-2 py-1.5"><span className="font-bold truncate flex-1 text-right">{rv.a.name}</span><span className="font-display text-orange-300">{rv.aWins} – {rv.bWins}</span><span className="font-bold truncate flex-1">{rv.b.name}</span></div>)}
          </>}
        </div>
      </div>
    </div>
  );
}

function Inbox() {
  const items = useSession((s) => s.notifications);
  if (items.length === 0) return <div className="text-sm text-white/50 font-semibold py-6 text-center">No messages yet. Beat a friend's time and they'll hear about it!</div>;
  const icon = (k: string) => (k === 'rival_beat_you' ? '⚔️' : k === 'you_beat_rival' ? '😎' : k === 'rank_change' ? '📈' : k === 'achievement' ? '🏆' : k === 'challenge' ? '🎯' : k === 'school_record' ? '🎓' : k === 'daily_result' ? '📅' : '🔔');
  return <div className="space-y-1.5">{items.map((n) => <div key={n.id} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${n.read ? 'bg-white/[0.03]' : 'bg-fuchsia-400/10 border border-fuchsia-300/30'}`}><span className="text-xl">{icon(n.kind)}</span><span className="flex-1 text-sm font-semibold">{n.text}</span><span className="text-[10px] text-white/40">{fmtDate(n.createdAt)}</span></div>)}</div>;
}

function Account() {
  const p = useSession((s) => s.player)!;
  const [name, setName] = useState(p.isGuest ? p.name : '');
  const [pw, setPw] = useState('');
  const [mode, setMode] = useState<'register' | 'login'>(p.isGuest ? 'register' : 'login');
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async () => {
    try {
      if (mode === 'register') { await registerAccount(name, pw); setMsg('Account created! Your progress now syncs across devices.'); }
      else { await loginAccount(name, pw); setMsg('Signed in.'); }
      getAudio().playSfx('unlock'); setPw('');
    } catch (e) { setMsg(errMsg(e)); getAudio().playSfx('error'); }
  };
  return (
    <div className="max-w-md space-y-3">
      {p.isGuest ? <div className="text-sm text-white/70 font-semibold">You're playing as a guest. Create an account to keep your records, coins and cars on any device — your current progress comes with you.</div>
        : <div className="text-sm text-white/70 font-semibold">Signed in as <span className="text-white font-bold">{p.name}</span>. You can sign in with a different account below.</div>}
      <div className="flex rounded-lg overflow-hidden border border-white/15 w-fit">{(['register', 'login'] as const).map((m) => <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 text-xs font-bold uppercase ${mode === m ? 'bg-cyan-400/30' : 'text-white/60'}`}>{m === 'register' ? 'Create account' : 'Sign in'}</button>)}</div>
      <input className="input rounded-lg px-3 py-2 w-full" placeholder="Username" maxLength={16} value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" />
      <input className="input rounded-lg px-3 py-2 w-full" placeholder="Password (8+ characters)" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
      <Button variant="primary" disabled={name.length < 3 || pw.length < 8} onClick={submit}>{mode === 'register' ? 'Create account' : 'Sign in'}</Button>
      {msg && <div className="text-xs font-bold text-yellow-200">{msg}</div>}
      {!p.isGuest && <Button variant="ghost" onClick={() => { logout(); location.reload(); }}>Sign out</Button>}
      <div className="text-[11px] text-white/40 font-semibold">Passwords are hashed on the server. Never reuse your school password.</div>
    </div>
  );
}
