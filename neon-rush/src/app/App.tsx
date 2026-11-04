import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore, type Screen } from './store';
import { Game } from '@game/Game';
import { setGame, tryGame } from './gameRef';
import type { TrackDefinition } from '@shared/track/types';
import { OFFICIAL_TRACKS } from '@shared/track/officialTracks';
import { formatTime } from '@shared/math';
import type { Replay } from '@shared/game/replay';
import type { CosmeticItem } from '@shared/game/carConfig';
import { Hud } from '@ui/Hud';
import { MainMenu } from '@ui/MainMenu';
import { TrackSelect } from '@ui/TrackSelect';
import { TouchControls } from '@ui/TouchControls';
import { Countdown, ArmedHint, PauseMenu, Results } from '@ui/RaceOverlays';
import { Spinner, Button } from '@ui/components';
import { GarageScreen } from '@ui/Garage';
import { SettingsScreen } from '@ui/Settings';
import { MultiplayerHome, Lobby, LiveResults, LiveWaiting, LivePositions } from '@ui/Multiplayer';
import { NamePrompt } from '@ui/NamePrompt';
import { liveSession, type LiveState } from './liveSession';
import { loadBests, saveBests, saveLocalReplay, loadLocalReplay, loadLocalName, saveLocalName, medalFor } from './localData';
import { getAudio } from '@game/audio/audio';
import { useSession, initSession, submitRecord, saveCarToServer, refreshProfile, playerLevel } from './session';
import { api } from './api';
import { encodeReplay, decodeReplay, bytesToBase64, base64ToBytes } from '@shared/game/replay';
import { ACHIEVEMENT_MAP, levelForXp } from '@shared/game/progression';
import { LeaderboardsScreen } from '@ui/Leaderboards';
import { DailyScreen } from '@ui/Daily';
import { ProfileScreen } from '@ui/Profile';
import { CommunityScreen } from '@ui/Community';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screen = useStore((s) => s.screen);
  const setScreen = useStore((s) => s.setScreen);
  const track = useStore((s) => s.track);
  const setTrack = useStore((s) => s.setTrack);
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const result = useStore((s) => s.result);
  const setResult = useStore((s) => s.setResult);
  const pushBanner = useStore((s) => s.pushBanner);
  const setCountdown = useStore((s) => s.setCountdown);
  const settings = useStore((s) => s.settings);
  const carConfig = useStore((s) => s.carConfig);
  const setCarConfig = useStore((s) => s.setCarConfig);
  const isTouch = useStore((s) => s.isTouch);
  const loadingMessage = useStore((s) => s.loadingMessage);
  const [ready, setReady] = useState(false);
  const [bests, setBests] = useState<Record<string, number>>(loadBests);
  const [armed, setArmed] = useState(false);
  const [name, setName] = useState<string | null>(loadLocalName);
  const [live, setLive] = useState<LiveState>(liveSession.state);
  const [mpBusy, setMpBusy] = useState(false);
  const [mpError, setMpError] = useState<string | null>(null);
  const [pendingRoom, setPendingRoom] = useState<string | null>(() => new URLSearchParams(location.search).get('room'));
  const player = useSession((st) => st.player);
  const serverBests = useSession((st) => st.serverBests);
  const unread = useSession((st) => st.unread);
  const mergedBests = React.useMemo(() => {
    const m: Record<string, number> = { ...bests };
    for (const [k, v] of Object.entries(serverBests)) if (m[k] == null || v < m[k]) m[k] = v;
    return m;
  }, [bests, serverBests]);
  const [raceMode, setRaceModeLocal] = useState<'solo' | 'daily'>('solo');
  const [ghostLabel, setGhostLabel] = useState<string | null>(null);
  const [lbTrack, setLbTrack] = useState<TrackDefinition | null>(null);
  const [communityDefs, setCommunityDefs] = useState<TrackDefinition[]>([]);
  const bestsRef = useRef(bests);
  bestsRef.current = bests;
  const mergedBestsRef = useRef(mergedBests);
  mergedBestsRef.current = mergedBests;
  const ghostDirty = useRef(false);
  const showTouch = settings.showTouchControls === 'on' || (settings.showTouchControls === 'auto' && isTouch);

  // boot the game
  useEffect(() => {
    let disposed = false;
    (async () => {
      const canvas = canvasRef.current!;
      const game = await Game.create(canvas, settings.quality === 'auto' ? undefined : settings.quality);
      if (disposed) { game.dispose(); return; }
      setGame(game);
      game.setCarConfig(carConfig);
      game.input.touchSteerSensitivity = settings.touchSensitivity;
      await game.loadTrack(OFFICIAL_TRACKS[0]);
      game.setSceneMode('menu');
      game.start();
      const audio = getAudio();
      audio.setMusicVolume(settings.music); audio.setSfxVolume(settings.sfx);
      audio.startMusic('menu');
      setReady(true);
      setScreen('menu');
    })();
    return () => { disposed = true; tryGame()?.dispose(); setGame(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => liveSession.subscribe(setLive), []);
  useEffect(() => { if (ready && name) void initSession(name); }, [ready, name]);
  useEffect(() => {
    liveSession.onRaceFinished = (position, playerCount, timeMs) => {
      const room = liveSession.state.room;
      if (!useSession.getState().player || !room) return;
      api.live.result({ roomCode: room.code, trackId: room.trackId, position, playerCount, timeMs })
        .then((r) => { useSession.getState().setPlayer(r.player); for (const a of r.achievements) pushBanner({ text: `${ACHIEVEMENT_MAP[a]?.icon ?? '🏆'} ${ACHIEVEMENT_MAP[a]?.name ?? a}`, sub: 'Achievement unlocked', kind: 'pb' }); })
        .catch(() => { /* offline */ });
    };
    liveSession.resolveTrack = async (id, source) => {
      if (source === 'official') return OFFICIAL_TRACKS.find((t) => t.id === id) ?? null;
      try { return (await api.tracks.get(id)).definition; } catch { return null; }
    };
  }, [pushBanner]);
  useEffect(() => { if (ready && screen !== 'garage') tryGame()?.setCarConfig(carConfig); }, [carConfig, ready, screen]);
  useEffect(() => {
    const on = () => useStore.getState().setOnline(true), off = () => useStore.getState().setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const goMenu = useCallback(() => {
    const g = tryGame();
    setResult(null); setPaused(false);
    g?.setPaused(false);
    if (g) g.raceMode = 'solo';
    g?.setGhost(null);
    g?.setSceneMode('menu');
    setScreen('menu');
    getAudio().startMusic('menu');
  }, [setResult, setPaused, setScreen]);

  /* ---------------- solo racing ---------------- */
  const forcedGhost = useRef<{ replay: Replay; name: string } | null>(null);
  const applyGhost = useCallback((g: Game, t: TrackDefinition) => {
    if (forcedGhost.current) {
      g.setGhost(forcedGhost.current.replay, forcedGhost.current.name, '#f472b6');
      g.setReferenceSplits(forcedGhost.current.replay.splits);
      return;
    }
    const rep = settings.showGhost ? loadLocalReplay(t.id) : null;
    g.setGhost(rep, 'Your best', '#67e8f9');
    g.setReferenceSplits(rep ? rep.splits : null);
  }, [settings.showGhost]);

  const startRace = useCallback(async (t: TrackDefinition, opts: { ghost?: { replay: Replay; name: string } | null; mode?: 'solo' | 'daily' } = {}) => {
    forcedGhost.current = opts.ghost ?? null;
    setGhostLabel(opts.ghost ? opts.ghost.name : null);
    const mode = opts.mode ?? 'solo';
    setRaceModeLocal(mode);
    const g = tryGame(); if (!g) return;
    setResult(null); setPaused(false); g.setPaused(false);
    g.raceMode = 'solo';
    if (g.trackDef?.id !== t.id) { useStore.getState().setLoading('Building ' + t.name + '…'); setScreen('loading'); await g.loadTrack(t); }
    setTrack(t);
    g.setCameraMode(settings.cameraMode);
    ghostDirty.current = false;
    g.callbacks = {
      onCountdown: (n) => setCountdown(n, true),
      onStart: () => { setCountdown(0, true); setArmed(false); setTimeout(() => setCountdown(0, false), 700); },
      onCheckpoint: (i, _t, diff) => pushBanner({ text: `Checkpoint ${i + 1}`, sub: diff != null ? formatTime(diff, true) : undefined, kind: 'checkpoint' }),
      onFinish: (timeMs, splits, replay: Replay) => {
        const prev = mergedBestsRef.current[t.id] ?? null;
        const isPb = prev == null || timeMs < prev;
        if (isPb) { const nb = { ...bestsRef.current, [t.id]: timeMs }; setBests(nb); saveBests(nb); saveLocalReplay(t.id, replay); ghostDirty.current = true; }
        else if (bestsRef.current[t.id] == null || timeMs < bestsRef.current[t.id]) { const nb = { ...bestsRef.current, [t.id]: timeMs }; setBests(nb); saveBests(nb); saveLocalReplay(t.id, replay); }
        const medal = medalFor(timeMs, t.medals);
        const base = { timeMs, splits, isPb, prevPb: prev, medal } as const;
        setTimeout(() => { if (!useStore.getState().result) setResult({ ...base }); }, 900);
        if (isPb) { if (prev != null) pushBanner({ text: 'NEW PERSONAL BEST!', sub: formatTime(prev - timeMs) + ' faster', kind: 'pb' }); getAudio().playSfx('pb'); }
        // online submission (server validates the replay)
        if (useSession.getState().player && g.runRealtimeRatio > 0.6) {
          void submitRecord({
            trackId: t.id, timeMs, splits, replay: bytesToBase64(encodeReplay(replay)), car: useStore.getState().carConfig,
            respawns: g.race?.respawnCount ?? 0, topSpeed: g.runTopSpeed, mode: forcedGhost.current ? 'ghost' : mode, clientVersion: '1.0.0',
          }).then((r) => {
            if (!r) return;
            if (!r.accepted) { pushBanner({ text: 'Run not ranked', sub: r.reason, kind: 'warn' }); return; }
            const cur = useStore.getState().result;
            const merged = { ...base, ...(cur ?? {}), rank: r.rank, xp: r.xp, coins: r.coins, worldRecord: r.worldRecord, achievements: r.achievements.map((a) => `${ACHIEVEMENT_MAP[a]?.icon ?? '🏆'} ${ACHIEVEMENT_MAP[a]?.name ?? a}`) };
            setResult(merged);
            if (r.worldRecord) { pushBanner({ text: 'WORLD RECORD!', sub: `#1 on ${t.name}`, kind: 'wr' }); getAudio().playSfx('wr'); g.celebrate(true); }
            else if (r.isPb && r.rank != null && r.rank <= 10) pushBanner({ text: `You're now #${r.rank} on ${t.name}!`, kind: 'rival' });
            for (const rv of r.rivalsBeaten.slice(0, 2)) pushBanner({ text: `You beat ${rv.name}'s record!`, sub: `by ${formatTime(rv.byMs)}`, kind: 'rival' });
            if (r.levelUp) { pushBanner({ text: `LEVEL ${r.levelUp}!`, sub: 'New cosmetics may be unlocked in the garage', kind: 'pb' }); getAudio().playSfx('unlock'); }
          });
        }
      },
      onRestart: () => { setResult(null); setArmed(true); setCountdown(0, false); if (ghostDirty.current) { ghostDirty.current = false; applyGhost(g, t); } },
      onPause: () => { const p = !useStore.getState().paused; setPaused(p); g.setPaused(p); },
    };
    applyGhost(g, t);
    setArmed(false);
    setScreen('race');
    getAudio().startMusic('race', t.theme);
    g.startRace(3);
  }, [setResult, setPaused, setScreen, setTrack, settings.cameraMode, setCountdown, pushBanner, applyGhost]);

  const raceVsRecord = useCallback(async (t: TrackDefinition, recordId: string, label: string) => {
    if (!recordId) { // world record ghost (falls back to your own ghost offline)
      try {
        const lb = await api.leaderboard(t.id, 'global', 1);
        const top = lb.entries[0];
        if (top && top.hasReplay && top.playerId !== useSession.getState().player?.id) { recordId = top.recordId; label = `WR · ${top.name}`; }
      } catch { /* offline */ }
    }
    if (!recordId) { void startRace(t); return; }
    try {
      const r = await api.replay(recordId);
      void startRace(t, { ghost: { replay: decodeReplay(base64ToBytes(r.replay)), name: label || r.player.name } });
    } catch { void startRace(t); }
  }, [startRace]);

  const retry = useCallback(() => { const g = tryGame(); setResult(null); g?.restart(); if (g?.raceMode !== 'live') setArmed(true); }, [setResult]);
  const nextTrack = track ? (() => { const i = OFFICIAL_TRACKS.findIndex((x) => x.id === track.id); const n = OFFICIAL_TRACKS[i + 1]; return n ? () => startRace(n) : undefined; })() : undefined;

  /* ---------------- multiplayer ---------------- */
  const joinInfo = useCallback(() => ({ name: name ?? 'Racer', car: useStore.getState().carConfig, playerId: null, token: null }), [name]);
  const mpCreate = useCallback(async () => { setMpBusy(true); setMpError(null); try { await liveSession.create(joinInfo()); } catch (e) { setMpError((e as Error).message); } setMpBusy(false); }, [joinInfo]);
  const mpJoin = useCallback(async (code: string) => { setMpBusy(true); setMpError(null); try { await liveSession.join(code, joinInfo()); } catch (e) { setMpError((e as Error).message); } setMpBusy(false); }, [joinInfo]);
  const mpLeave = useCallback(() => { liveSession.leave(); goMenu(); }, [goMenu]);
  useEffect(() => {
    if (ready && name && pendingRoom && screen === 'menu') {
      const code = pendingRoom; setPendingRoom(null);
      history.replaceState(null, '', location.pathname);
      setScreen('multiplayer');
      void mpJoin(code);
    }
  }, [ready, name, pendingRoom, screen, mpJoin, setScreen]);
  useEffect(() => {
    if (live.phase === 'countdown' || live.phase === 'racing') { if (track) getAudio().startMusic('race', track.theme); }
    // room went back to the lobby (rematch / auto-return): everyone follows
    if (live.phase === 'lobby' && useStore.getState().screen === 'race') { setResult(null); setPaused(false); getAudio().startMusic('menu'); setScreen('multiplayer'); }
  }, [live.phase, track, setScreen, setResult, setPaused]);

  const openBuilderTrack = async (_id: string) => { setScreen('builder'); };
  const builderElement = (
    <div className="absolute inset-0 flex items-center justify-center"><div className="panel rounded-2xl p-8 text-center"><div className="font-display text-2xl font-black gradient-text mb-3">TRACK BUILDER</div><Button onClick={goMenu}>Back</Button></div></div>
  );
  const open = (s: Screen) => { getAudio().playSfx('click'); setScreen(s); };
  const ownership = { level: playerLevel(player), coins: player?.coins ?? 0, unlocked: player?.unlocked ?? [], achievements: (player?.achievements ?? []).map((a) => a.id), signedIn: !!player };
  const buyItem = async (item: CosmeticItem) => {
    try { const r = await api.shop.buy(item.id); useSession.getState().setPlayer(r.player); getAudio().playSfx('coin'); return true; } catch { return false; }
  };

  const inLive = live.phase === 'countdown' || live.phase === 'racing' || live.phase === 'results';
  const me = live.room?.players.find((p) => p.id === live.you);

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#07061a]">
      <canvas id="game-canvas" ref={canvasRef} tabIndex={0} />
      {(!ready || screen === 'loading') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#07061a] z-50">
          <div className="font-display text-5xl md:text-7xl font-black gradient-text anim-gradient tracking-widest">NEON RUSH</div>
          <div className="mt-6"><Spinner /></div>
          <div className="mt-4 text-sm font-bold tracking-widest uppercase text-white/50">{loadingMessage}</div>
        </div>
      )}
      {ready && !name && <NamePrompt onDone={(n) => { saveLocalName(n); setName(n); getAudio().playSfx('unlock'); }} />}
      {ready && name && screen === 'menu' && <MainMenu playerName={player?.name ?? name} level={ownership.level} onOpen={open} unread={unread} />}
      {ready && screen === 'tracks' && <TrackSelect onBack={goMenu} onPlay={(t) => startRace(t)} onGhost={(t) => raceVsRecord(t, '', '')} bests={mergedBests} />}
      {ready && screen === 'garage' && <GarageScreen onBack={goMenu} ownership={ownership} onBuy={buyItem} onSave={(cfg) => { setCarConfig(cfg); void saveCarToServer(); }} />}
      {ready && screen === 'settings' && <SettingsScreen onBack={() => { useStore.getState().prevScreen === 'race' ? setScreen('race') : goMenu(); }} inRace={useStore.getState().prevScreen === 'race'} />}
      {ready && screen === 'multiplayer' && !inLive && (
        live.phase === 'lobby' && live.room ? (
          <>
            <Lobby client={liveSession.client} room={live.room} onLeave={mpLeave} onSelectTrack={(id) => liveSession.client.selectTrack(id, 'official')} />
            {live.loadingTrack && <LiveWaiting message="Loading track…" />}
          </>
        ) : (
          <>
            <MultiplayerHome onBack={goMenu} onCreate={mpCreate} onJoin={mpJoin} busy={mpBusy || live.phase === 'connecting'} error={mpError ?? live.error} initialCode={pendingRoom ?? undefined} />
            {live.phase === 'connecting' && <LiveWaiting message="Connecting to room…" />}
          </>
        )
      )}
      {ready && screen === 'race' && track && (
        <>
          <Hud ghostLabel={inLive ? null : ghostLabel} pb={inLive ? null : mergedBests[track.id] ?? null} position={inLive && me ? me.position || null : null} playerCount={live.room?.players.length} />
          {inLive && live.room && <LivePositions room={live.room} you={live.you} />}
          <Countdown />
          {armed && !result && !paused && !inLive && <ArmedHint />}
          {showTouch && !paused && !result && live.phase !== 'results' && <TouchControls onRestart={retry} onPause={() => { setPaused(true); tryGame()?.setPaused(!inLive); if (inLive) { const g = tryGame(); if (g) g.input.enabled = false; } }} onCamera={() => tryGame()?.cycleCamera()} />}
          {paused && <PauseMenu onResume={() => { setPaused(false); tryGame()?.setPaused(false); const g = tryGame(); if (g) g.input.enabled = true; }} onRestart={() => { setPaused(false); tryGame()?.setPaused(false); retry(); }} onQuit={inLive ? mpLeave : goMenu} onSettings={() => setScreen('settings')} />}
          {!inLive && result && <Results onRetry={retry} onQuit={goMenu} onNext={raceMode === 'daily' ? undefined : nextTrack} onLeaderboard={() => { setLbTrack(track); setResult(null); const g = tryGame(); g?.setGhost(null); g?.setSceneMode('menu'); setScreen('leaderboards'); }} />}
          {live.phase === 'results' && live.results && live.room && (
            <LiveResults results={live.results} room={live.room} you={live.you} waiting={false} onRematch={() => { liveSession.client.rematch(); setScreen('multiplayer'); }} onLeave={mpLeave} />
          )}
          {inLive && live.phase === 'racing' && live.myFinish != null && !live.results && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-[18%] pointer-events-none"><div className="panel rounded-xl px-4 py-2 text-sm font-bold text-white/80 anim-fade-in">Finished in {formatTime(live.myFinish)} · waiting for other racers…</div></div>
          )}
        </>
      )}
      {ready && screen === 'leaderboards' && <LeaderboardsScreen onBack={goMenu} initialTrack={lbTrack} extraTracks={communityDefs} onGhost={(t, id, label) => raceVsRecord(t, id, label)} />}
      {ready && screen === 'daily' && <DailyScreen onBack={goMenu} onPlay={(t) => startRace(t, { mode: 'daily' })} />}
      {ready && screen === 'profile' && <ProfileScreen onBack={goMenu} localBests={bests} />}
      {ready && screen === 'community' && <CommunityScreen onBack={goMenu} onPlay={(def) => { setCommunityDefs((d) => [def, ...d.filter((x) => x.id !== def.id)].slice(0, 10)); void startRace(def); }} onBuild={() => setScreen('builder')} onEdit={(id) => { void openBuilderTrack(id); }} />}
      {ready && screen === 'builder' && builderElement}
    </div>
  );
}
