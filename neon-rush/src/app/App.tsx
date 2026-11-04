import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore, type Screen } from './store';
import { Game } from '@game/Game';
import { setGame, tryGame } from './gameRef';
import type { TrackDefinition } from '@shared/track/types';
import { OFFICIAL_TRACKS } from '@shared/track/officialTracks';
import { formatTime } from '@shared/math';
import { Hud } from '@ui/Hud';
import { MainMenu } from '@ui/MainMenu';
import { TrackSelect } from '@ui/TrackSelect';
import { TouchControls } from '@ui/TouchControls';
import { Countdown, ArmedHint, PauseMenu, Results } from '@ui/RaceOverlays';
import { Spinner } from '@ui/components';

const BESTS_KEY = 'neonrush.bests.v1';
function loadBests(): Record<string, number> { try { return JSON.parse(localStorage.getItem(BESTS_KEY) || '{}'); } catch { return {}; } }

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
  const isTouch = useStore((s) => s.isTouch);
  const loadingMessage = useStore((s) => s.loadingMessage);
  const [ready, setReady] = useState(false);
  const [bests, setBests] = useState<Record<string, number>>(loadBests);
  const [armed, setArmed] = useState(false);
  const bestsRef = useRef(bests);
  bestsRef.current = bests;

  // boot the game
  useEffect(() => {
    let disposed = false;
    (async () => {
      const canvas = canvasRef.current!;
      const game = await Game.create(canvas, settings.quality === 'auto' ? undefined : settings.quality);
      if (disposed) { game.dispose(); return; }
      setGame(game);
      game.setCarConfig(carConfig);
      await game.loadTrack(OFFICIAL_TRACKS[0]);
      game.setSceneMode('menu');
      game.start();
      setReady(true);
      setScreen('menu');
    })();
    return () => { disposed = true; tryGame()?.dispose(); setGame(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the game's car config in sync
  useEffect(() => { tryGame()?.setCarConfig(carConfig); }, [carConfig, ready]);

  const goMenu = useCallback(() => {
    const g = tryGame();
    setResult(null); setPaused(false);
    g?.setPaused(false);
    g?.setSceneMode('menu');
    setScreen('menu');
  }, [setResult, setPaused, setScreen]);

  const startRace = useCallback(async (t: TrackDefinition, withGhost = false) => {
    const g = tryGame(); if (!g) return;
    setResult(null); setPaused(false); g.setPaused(false);
    if (g.trackDef?.id !== t.id) { useStore.getState().setLoading('Building ' + t.name + '…'); setScreen('loading'); await g.loadTrack(t); }
    setTrack(t);
    g.setCameraMode(settings.cameraMode);
    g.callbacks = {
      onCountdown: (n) => setCountdown(n, true),
      onStart: () => { setCountdown(0, true); setArmed(false); setTimeout(() => setCountdown(0, false), 700); },
      onCheckpoint: (i, _t, diff) => pushBanner({ text: `Checkpoint ${i + 1}`, sub: diff != null ? formatTime(diff, true) : undefined, kind: 'checkpoint' }),
      onFinish: (timeMs, splits) => {
        const prev = bestsRef.current[t.id] ?? null;
        const isPb = prev == null || timeMs < prev;
        if (isPb) { const nb = { ...bestsRef.current, [t.id]: timeMs }; setBests(nb); localStorage.setItem(BESTS_KEY, JSON.stringify(nb)); }
        const medal = timeMs <= t.medals.author ? 'author' : timeMs <= t.medals.gold ? 'gold' : timeMs <= t.medals.silver ? 'silver' : timeMs <= t.medals.bronze ? 'bronze' : null;
        setTimeout(() => setResult({ timeMs, splits, isPb, prevPb: prev, medal }), 900);
        if (isPb && prev != null) pushBanner({ text: 'NEW PERSONAL BEST!', sub: formatTime(prev - timeMs, false) + ' faster', kind: 'pb' });
      },
      onRestart: () => { setResult(null); setArmed(true); setCountdown(0, false); },
      onPause: () => { const p = !useStore.getState().paused; setPaused(p); g.setPaused(p); },
    };
    g.setReferenceSplits(null);
    g.setGhost(null);
    setArmed(false);
    setScreen('race');
    g.startRace(3);
  }, [setResult, setPaused, setScreen, setTrack, settings.cameraMode, setCountdown, pushBanner]);

  const retry = useCallback(() => { const g = tryGame(); setResult(null); g?.restart(); setArmed(true); }, [setResult]);

  const open = (s: Screen) => setScreen(s);

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
      {ready && screen === 'menu' && <MainMenu playerName="Racer" level={1} onOpen={open} />}
      {ready && screen === 'tracks' && <TrackSelect onBack={goMenu} onPlay={(t) => startRace(t)} onGhost={(t) => startRace(t, true)} bests={bests} />}
      {ready && screen === 'race' && track && (
        <>
          <Hud pb={bests[track.id] ?? null} />
          <Countdown />
          {armed && !result && !paused && <ArmedHint />}
          {isTouch && !paused && !result && <TouchControls onRestart={retry} onPause={() => { setPaused(true); tryGame()?.setPaused(true); }} onCamera={() => tryGame()?.cycleCamera()} />}
          {paused && <PauseMenu onResume={() => { setPaused(false); tryGame()?.setPaused(false); }} onRestart={() => { setPaused(false); tryGame()?.setPaused(false); retry(); }} onQuit={goMenu} onSettings={() => setScreen('settings')} />}
          {result && <Results onRetry={retry} onQuit={goMenu} onNext={(() => { const i = OFFICIAL_TRACKS.findIndex((x) => x.id === track.id); const n = OFFICIAL_TRACKS[i + 1]; return n ? () => startRace(n) : undefined; })()} />}
        </>
      )}
      {ready && !['menu', 'tracks', 'race', 'loading'].includes(screen) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
          <div className="panel rounded-2xl p-8 text-center">
            <div className="font-display text-2xl font-black gradient-text mb-4">{screen.toUpperCase()}</div>
            <div className="text-white/60 mb-4">Coming up next in the build.</div>
            <button className="btn rounded-xl px-5 py-3" onClick={goMenu}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}
