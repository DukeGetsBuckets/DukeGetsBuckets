// NEON RUSH audio engine: Web Audio only (no files, no network). Every method is a no-op if audio is unavailable.
import { MusicPlayer, hasSong, holdAt, makeNoiseBuffer } from './music';

export type SfxName =
  | 'checkpoint' | 'finish' | 'countdown' | 'go' | 'crash' | 'land' | 'jump' | 'boost'
  | 'click' | 'hover' | 'back' | 'pb' | 'wr' | 'respawn' | 'error' | 'coin' | 'unlock'
  | 'lobbyJoin' | 'raceWin' | 'notify';

export interface EngineState {
  speed: number;     // m/s, 0..~95
  throttle: number;  // 0..1
  grounded: boolean;
  drifting: boolean;
  slip: number;      // lateral slip m/s, 0..10
  boost: boolean;
  airborne: boolean;
  braking: boolean;
}

const TOP_SPEED = 95;
const GEAR_THRESHOLDS = [25, 45, 65];
const SHIFT_TIME = 0.2;
const MIN_GAIN = 0.0005;

interface Graph {
  master: GainNode;
  compressor: DynamicsCompressorNode;
  musicGain: GainNode;
  duckGain: GainNode;
  sfxGain: GainNode;
  noise: AudioBuffer;
}

interface EngineNodes {
  bus: GainNode;
  saw: OscillatorNode;
  square: OscillatorNode;
  sub: OscillatorNode;
  bright: OscillatorNode;
  brightGain: GainNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  tireFilter: BiquadFilterNode;
  tireGain: GainNode;
  tireLfo: OscillatorNode;
  boostFilter: BiquadFilterNode;
  boostNoiseGain: GainNode;
  boostOscA: OscillatorNode;
  boostOscB: OscillatorNode;
  boostHarmGain: GainNode;
  sources: (OscillatorNode | AudioBufferSourceNode)[];
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  hold?: number;
  slideTo?: number;
  detune?: number;
  cutoff?: number;
}

interface NoiseOpts {
  type?: BiquadFilterType;
  freq?: number;
  freqTo?: number;
  q?: number;
  gain?: number;
  attack?: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const volumeCurve = (v: number): number => Math.pow(clamp(v, 0, 1), 1.6);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private music: MusicPlayer | null = null;
  private engine: EngineNodes | null = null;
  private musicVol = 0.6;
  private sfxVol = 0.8;
  private pendingMusic: string | null = null;
  private engineWanted = false;
  private disposed = false;
  private gestureBound = false;
  private lastHover = 0;
  private readonly paramCache = new Float32Array(24).fill(NaN);
  private readonly es = { pitch: 60, gear: 0, shiftTimer: 0, flutter: 0, lastBoost: false, gain: 0, cutoff: 400, wind: 0, tire: 0 };

  private readonly onGesture = (): void => { this.unlock(); };
  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.resumeContext();
  };
  private readonly onStateChange = (): void => { this.handleStateChange(); };

  constructor() {
    this.bindGesture();
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  unlock(): void {
    if (this.disposed || typeof window === 'undefined') return;
    if (!this.ctx) {
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AC = w.AudioContext ?? w.webkitAudioContext;
      if (!AC) return;
      let ctx: AudioContext;
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        try { ctx = new AC(); } catch { return; }
      }
      this.ctx = ctx;
      try {
        this.graph = this.buildGraph(ctx);
      } catch {
        this.graph = null;
        this.ctx = null;
        return;
      }
      ctx.addEventListener('statechange', this.onStateChange);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.resumeContext();
    this.handleStateChange();
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp(v, 0, 1);
    if (this.graph && this.ctx) this.graph.musicGain.gain.setTargetAtTime(volumeCurve(this.musicVol), this.ctx.currentTime, 0.05);
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp(v, 0, 1);
    if (this.graph && this.ctx) this.graph.sfxGain.gain.setTargetAtTime(volumeCurve(this.sfxVol), this.ctx.currentTime, 0.05);
  }

  playSfx(name: SfxName, intensity = 1): void {
    if (!this.ready || !this.graph || !this.ctx) return;
    const i = Number.isFinite(intensity) ? clamp(intensity, 0.1, 2) : 1;
    const t = this.ctx.currentTime + 0.01;
    try {
      switch (name) {
        case 'countdown': this.sfxCountdown(t); break;
        case 'go': this.sfxGo(t); break;
        case 'checkpoint': this.sfxCheckpoint(t); break;
        case 'finish': this.sfxFinish(t); break;
        case 'pb': this.sfxPb(t); break;
        case 'wr': this.sfxWr(t); break;
        case 'crash': this.sfxCrash(t, i); break;
        case 'land': this.sfxLand(t, i); break;
        case 'jump': this.sfxJump(t); break;
        case 'boost': this.sfxBoost(t); break;
        case 'click': this.sfxClick(t); break;
        case 'hover': this.sfxHover(t); break;
        case 'back': this.sfxBack(t); break;
        case 'respawn': this.sfxRespawn(t); break;
        case 'error': this.sfxError(t); break;
        case 'coin': this.sfxCoin(t); break;
        case 'unlock': this.sfxUnlock(t); break;
        case 'lobbyJoin': this.sfxLobbyJoin(t); break;
        case 'raceWin': this.sfxRaceWin(t); break;
        case 'notify': this.sfxNotify(t); break;
        default: break;
      }
    } catch {
      /* audio glitches must never break the game loop */
    }
  }

  startMusic(song: 'menu' | 'race', variant?: string): void {
    if (this.disposed) return;
    const id = song === 'menu' ? 'menu' : variant && hasSong(variant) ? variant : 'neonCity';
    this.pendingMusic = id;
    if (!this.ready) return;
    this.flushPendingMusic();
  }

  stopMusic(fade = 0.8): void {
    this.pendingMusic = null;
    if (this.music) {
      try { this.music.stop(fade); } catch { /* ignore */ }
    }
  }

  setEngineActive(on: boolean): void {
    this.engineWanted = on;
    if (!this.ctx || !this.graph) return;
    if (on) {
      if (!this.engine && this.ready) this.startEngine();
      return;
    }
    this.stopEngine();
  }

  updateEngine(state: EngineState, dt: number): void {
    const e = this.engine;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const es = this.es;
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0.016;
    const now = ctx.currentTime;
    const speed = Number.isFinite(state.speed) ? Math.max(0, state.speed) : 0;
    const throttle = clamp(state.throttle, 0, 1);
    const sN = clamp(speed / TOP_SPEED, 0, 1.25);
    const sN1 = Math.min(sN, 1);

    // Gear shift: brief pitch and volume dip when crossing speed thresholds.
    let gear = 0;
    for (const th of GEAR_THRESHOLDS) if (speed >= th) gear++;
    if (gear !== es.gear) { es.gear = gear; es.shiftTimer = SHIFT_TIME; }
    es.shiftTimer = Math.max(0, es.shiftTimer - step);
    const shift = es.shiftTimer > 0 ? Math.sin((es.shiftTimer / SHIFT_TIME) * Math.PI) : 0;

    let target = 45 + Math.pow(sN1, 0.85) * 215 + Math.max(0, sN - 1) * 80;
    target *= 1 + 0.1 * throttle;
    if (state.airborne) {
      es.flutter += step;
      target *= 1.06 + 0.03 * Math.sin(es.flutter * 22);
    } else {
      es.flutter = 0;
    }
    target *= 1 - 0.14 * shift;
    const smooth = 1 - Math.exp(-step * 10);
    es.pitch += (target - es.pitch) * smooth;

    const thr = throttle * (state.braking ? 0.5 : 1);
    const gainTarget = (0.28 + 0.4 * thr + 0.22 * sN1) * (1 - 0.35 * shift);
    es.gain += (gainTarget - es.gain) * smooth;
    const cutTarget = 250 + es.pitch * 5 + thr * 1200 + sN1 * 600;
    es.cutoff += (cutTarget - es.cutoff) * smooth;

    const p = es.pitch;
    this.setParam(0, e.saw.frequency, p, now);
    this.setParam(1, e.square.frequency, p * 0.5, now);
    this.setParam(2, e.sub.frequency, p, now);
    this.setParam(3, e.bright.frequency, p * 2, now);
    this.setParam(4, e.brightGain.gain, 0.05 + 0.2 * sN1 * (0.4 + 0.6 * throttle), now);
    this.setParam(5, e.filter.frequency, clamp(es.cutoff, 150, 6000), now);
    this.setParam(6, e.gain.gain, es.gain, now);
    this.setParam(7, e.lfo.frequency, clamp(p * 0.25, 6, 70), now);
    this.setParam(8, e.lfoDepth.gain, 0.14 * (1 - sN1) * (1 - 0.6 * throttle), now);

    // Wind: audible above ~20 m/s, thinner while airborne.
    const w = clamp((speed - 18) / 60, 0, 1);
    const windTarget = Math.pow(w, 1.3) * 0.55 * (state.airborne ? 0.55 : 1);
    es.wind += (windTarget - es.wind) * smooth;
    this.setParam(9, e.windGain.gain, es.wind, now);
    this.setParam(10, e.windFilter.frequency, 250 + w * 2800, now);

    // Tire screech from lateral slip and drifting.
    const slip = clamp((state.slip - 1.2) / 6, 0, 1);
    const tireTarget = state.grounded ? (slip * 0.55 + (state.drifting ? 0.22 : 0)) * clamp(speed / 15, 0, 1) : 0;
    es.tire += (tireTarget - es.tire) * (1 - Math.exp(-step * 18));
    this.setParam(11, e.tireGain.gain, es.tire, now);
    this.setParam(12, e.tireFilter.frequency, 900 + slip * 500, now);

    // Boost: whoosh on the rising edge, sustained harmonic layer while active.
    if (state.boost && !es.lastBoost) {
      e.boostFilter.frequency.cancelScheduledValues(now);
      e.boostFilter.frequency.setValueAtTime(300, now);
      e.boostFilter.frequency.exponentialRampToValueAtTime(3200, now + 0.5);
      holdAt(e.boostNoiseGain.gain, now);
      e.boostNoiseGain.gain.linearRampToValueAtTime(0.4, now + 0.12);
      e.boostNoiseGain.gain.exponentialRampToValueAtTime(0.06, now + 0.7);
    } else if (!state.boost && es.lastBoost) {
      holdAt(e.boostNoiseGain.gain, now);
      e.boostNoiseGain.gain.setTargetAtTime(0, now, 0.1);
    }
    es.lastBoost = state.boost;
    this.setParam(13, e.boostHarmGain.gain, state.boost ? 0.16 : 0, now);
    this.setParam(14, e.boostOscA.frequency, p * 3, now);
    this.setParam(15, e.boostOscB.frequency, p * 4, now);
  }

  duck(seconds: number): void {
    if (!this.graph || !this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.graph.duckGain.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0.25, now, 0.05);
    g.setTargetAtTime(1, now + Math.max(0, seconds), 0.4);
  }

  dispose(): void {
    this.disposed = true;
    this.unbindGesture();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.pendingMusic = null;
    this.engineWanted = false;
    if (this.music) { this.music.dispose(); this.music = null; }
    this.stopEngine(true);
    const ctx = this.ctx;
    this.ctx = null;
    this.graph = null;
    if (ctx) {
      ctx.removeEventListener('statechange', this.onStateChange);
      try { void ctx.close().catch(() => undefined); } catch { /* ignore */ }
    }
    if (instance === this) instance = null;
  }

  // ---- lifecycle ------------------------------------------------------------

  private bindGesture(): void {
    if (this.gestureBound || typeof window === 'undefined') return;
    this.gestureBound = true;
    const opts: AddEventListenerOptions = { passive: true };
    window.addEventListener('pointerdown', this.onGesture, opts);
    window.addEventListener('keydown', this.onGesture, opts);
    window.addEventListener('touchstart', this.onGesture, opts);
  }

  private unbindGesture(): void {
    if (!this.gestureBound || typeof window === 'undefined') return;
    this.gestureBound = false;
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    window.removeEventListener('touchstart', this.onGesture);
  }

  private resumeContext(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      void ctx.resume().then(() => this.handleStateChange()).catch(() => undefined);
      // iOS needs a real buffer to play inside the gesture before it treats the context as unlocked.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
  }

  private handleStateChange(): void {
    if (this.disposed) return;
    if (!this.ready) { this.bindGesture(); return; }
    this.unbindGesture();
    this.flushPendingMusic();
    if (this.engineWanted && !this.engine) this.startEngine();
  }

  private buildGraph(ctx: AudioContext): Graph {
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 20;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.25;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    compressor.connect(master);
    master.connect(ctx.destination);
    const musicGain = ctx.createGain();
    musicGain.gain.value = volumeCurve(this.musicVol);
    const duckGain = ctx.createGain();
    musicGain.connect(duckGain);
    duckGain.connect(compressor);
    const sfxGain = ctx.createGain();
    sfxGain.gain.value = volumeCurve(this.sfxVol);
    sfxGain.connect(compressor);
    return { master, compressor, musicGain, duckGain, sfxGain, noise: makeNoiseBuffer(ctx, 2) };
  }

  private flushPendingMusic(): void {
    const id = this.pendingMusic;
    if (!id || !this.ctx || !this.graph) return;
    try {
      if (!this.music) this.music = new MusicPlayer(this.ctx, this.graph.musicGain, this.graph.noise);
      const m = this.music;
      if (!(m.playing && m.songId === id)) {
        m.setSong(id);
        if (!m.playing) m.start();
      }
      this.pendingMusic = null;
    } catch {
      this.pendingMusic = null;
    }
  }

  // ---- engine layers --------------------------------------------------------

  private startEngine(): void {
    const ctx = this.ctx;
    const graph = this.graph;
    if (!ctx || !graph || this.engine) return;
    try {
      const now = ctx.currentTime;
      const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
      const osc = (type: OscillatorType, freq: number): OscillatorNode => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        sources.push(o);
        return o;
      };
      const loop = (): AudioBufferSourceNode => {
        const s = ctx.createBufferSource();
        s.buffer = graph.noise;
        s.loop = true;
        sources.push(s);
        return s;
      };
      const gainNode = (v: number): GainNode => { const g = ctx.createGain(); g.gain.value = v; return g; };

      const bus = gainNode(0);
      bus.connect(graph.sfxGain);
      bus.gain.setTargetAtTime(1, now, 0.12);

      // Engine core: saw + square an octave down + sub sine, through a lowpass with a lumpy idle LFO.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 500;
      filter.Q.value = 1.1;
      const gain = gainNode(0.3);
      filter.connect(gain);
      gain.connect(bus);
      const saw = osc('sawtooth', 60);
      const square = osc('square', 30);
      const sub = osc('sine', 60);
      const bright = osc('sawtooth', 120);
      bright.detune.value = 9;
      const sawGain = gainNode(0.3);
      const squareGain = gainNode(0.22);
      const subGain = gainNode(0.4);
      const brightGain = gainNode(0.05);
      saw.connect(sawGain); sawGain.connect(filter);
      square.connect(squareGain); squareGain.connect(filter);
      sub.connect(subGain); subGain.connect(gain);
      bright.connect(brightGain); brightGain.connect(filter);
      const lfo = osc('sine', 14);
      const lfoDepth = gainNode(0.12);
      lfo.connect(lfoDepth);
      lfoDepth.connect(gain.gain);

      // Wind: looped noise through a lowpass that opens with speed.
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 300;
      windFilter.Q.value = 0.5;
      const windGain = gainNode(0);
      loop().connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(bus);

      // Tire screech: bandpassed noise with a wobbling centre frequency.
      const tireFilter = ctx.createBiquadFilter();
      tireFilter.type = 'bandpass';
      tireFilter.frequency.value = 1100;
      tireFilter.Q.value = 6;
      const tireGain = gainNode(0);
      loop().connect(tireFilter);
      tireFilter.connect(tireGain);
      tireGain.connect(bus);
      const tireLfo = osc('sine', 6.5);
      const tireLfoDepth = gainNode(180);
      tireLfo.connect(tireLfoDepth);
      tireLfoDepth.connect(tireFilter.frequency);

      // Boost: rising noise whoosh plus a sustained harmonic layer.
      const boostFilter = ctx.createBiquadFilter();
      boostFilter.type = 'bandpass';
      boostFilter.frequency.value = 800;
      boostFilter.Q.value = 1.2;
      const boostNoiseGain = gainNode(0);
      loop().connect(boostFilter);
      boostFilter.connect(boostNoiseGain);
      boostNoiseGain.connect(bus);
      const boostOscA = osc('sawtooth', 180);
      const boostOscB = osc('triangle', 240);
      const boostHarmFilter = ctx.createBiquadFilter();
      boostHarmFilter.type = 'highpass';
      boostHarmFilter.frequency.value = 400;
      const boostHarmGain = gainNode(0);
      boostOscA.connect(boostHarmFilter);
      boostOscB.connect(boostHarmFilter);
      boostHarmFilter.connect(boostHarmGain);
      boostHarmGain.connect(bus);

      for (const s of sources) s.start(now);
      this.paramCache.fill(NaN);
      this.es.lastBoost = false;
      this.es.shiftTimer = 0;
      this.engine = {
        bus, saw, square, sub, bright, brightGain, filter, gain, lfo, lfoDepth,
        windFilter, windGain, tireFilter, tireGain, tireLfo,
        boostFilter, boostNoiseGain, boostOscA, boostOscB, boostHarmGain, sources,
      };
    } catch {
      this.engine = null;
    }
  }

  private stopEngine(immediate = false): void {
    const e = this.engine;
    const ctx = this.ctx;
    this.engine = null;
    if (!e || !ctx) return;
    const now = ctx.currentTime;
    const tail = immediate ? 0.02 : 0.4;
    try {
      e.bus.gain.cancelScheduledValues(now);
      e.bus.gain.setTargetAtTime(0, now, immediate ? 0.005 : 0.08);
      for (const s of e.sources) {
        try { s.stop(now + tail); } catch { /* already stopped */ }
      }
      setTimeout(() => { try { e.bus.disconnect(); } catch { /* ignore */ } }, tail * 1000 + 100);
    } catch {
      /* ignore */
    }
  }

  private setParam(slot: number, param: AudioParam, value: number, now: number): void {
    const prev = this.paramCache[slot];
    if (prev === value || Math.abs(prev - value) <= Math.abs(value) * 0.002) return;
    this.paramCache[slot] = value;
    param.setTargetAtTime(value, now, 0.03);
  }

  // ---- SFX primitives -------------------------------------------------------

  private tone(t: number, freq: number, dur: number, o: ToneOpts = {}): void {
    const ctx = this.ctx;
    const graph = this.graph;
    if (!ctx || !graph) return;
    const attack = o.attack ?? 0.005;
    const hold = o.hold ?? 0;
    const peak = o.gain ?? 0.3;
    const end = t + Math.max(dur, attack + hold + 0.01);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(o.slideTo, end);
    if (o.detune !== undefined) osc.detune.value = o.detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    if (hold > 0) g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
    let head: AudioNode = osc;
    if (o.cutoff !== undefined) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.cutoff;
      osc.connect(f);
      head = f;
    }
    head.connect(g);
    g.connect(graph.sfxGain);
    osc.start(t);
    osc.stop(end + 0.03);
  }

  private noiseBurst(t: number, dur: number, o: NoiseOpts = {}): void {
    const ctx = this.ctx;
    const graph = this.graph;
    if (!ctx || !graph) return;
    const attack = o.attack ?? 0.003;
    const peak = o.gain ?? 0.2;
    const end = t + Math.max(dur, attack + 0.01);
    const src = ctx.createBufferSource();
    src.buffer = graph.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.freq ?? 1000, t);
    if (o.freqTo !== undefined) f.frequency.exponentialRampToValueAtTime(o.freqTo, end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
    src.connect(f);
    f.connect(g);
    g.connect(graph.sfxGain);
    src.start(t, Math.random());
    src.stop(end + 0.03);
  }

  private bell(t: number, freq: number, dur: number, gain: number): void {
    this.tone(t, freq, dur, { type: 'sine', gain });
    this.tone(t, freq * 2.76, dur * 0.4, { type: 'sine', gain: gain * 0.2 });
  }

  private fanfare(t: number, notes: number[], stepTime: number, lastDur: number, gain: number): void {
    notes.forEach((f, k) => {
      const at = t + k * stepTime;
      const last = k === notes.length - 1;
      const dur = last ? lastDur : stepTime * 1.4;
      const hold = last ? lastDur * 0.45 : 0;
      this.tone(at, f, dur, { type: 'sawtooth', gain: gain * 0.6, cutoff: 2600, detune: -5, hold });
      this.tone(at, f, dur, { type: 'square', gain: gain * 0.35, cutoff: 1800, detune: 5, hold });
      this.tone(at, f, dur, { type: 'sine', gain: gain * 0.6, hold });
    });
  }

  // ---- SFX designs ----------------------------------------------------------

  private sfxCountdown(t: number): void {
    this.tone(t, 880, 0.14, { type: 'sine', gain: 0.5 });
    this.tone(t, 1760, 0.07, { type: 'sine', gain: 0.07 });
  }

  private sfxGo(t: number): void {
    this.tone(t, 1320, 0.2, { type: 'triangle', gain: 0.4 });
    this.tone(t, 1320, 0.2, { type: 'sine', gain: 0.3 });
    this.tone(t + 0.14, 1760, 0.55, { type: 'triangle', gain: 0.4, hold: 0.08 });
    this.tone(t + 0.14, 1760, 0.55, { type: 'sine', gain: 0.3, hold: 0.08 });
  }

  private sfxCheckpoint(t: number): void {
    [1046.5, 1318.5, 1568].forEach((f, k) => {
      const at = t + k * 0.055;
      this.tone(at, f, 0.32, { type: 'sine', gain: 0.32 });
      this.tone(at, f * 2, 0.16, { type: 'sine', gain: 0.07 });
    });
  }

  private sfxFinish(t: number): void {
    this.fanfare(t, [523.25, 659.25, 783.99, 1046.5], 0.13, 1.1, 0.3);
    this.tone(t + 0.39, 1318.5, 1.0, { type: 'sine', gain: 0.12, hold: 0.4 });
    this.tone(t + 0.39, 1568, 1.0, { type: 'sine', gain: 0.1, hold: 0.4 });
    this.noiseBurst(t + 0.36, 1.0, { type: 'highpass', freq: 5000, gain: 0.1, attack: 0.02 });
  }

  private sfxPb(t: number): void {
    [784, 988, 1175, 1568, 1976, 2349, 3136].forEach((f, k) => {
      const at = t + k * 0.06;
      this.tone(at, f, 0.38, { type: 'sine', gain: 0.28 });
      this.tone(at, f, 0.25, { type: 'triangle', gain: 0.08, detune: 6 });
    });
    this.noiseBurst(t + 0.2, 0.5, { type: 'highpass', freq: 6000, gain: 0.05, attack: 0.05 });
  }

  private sfxWr(t: number): void {
    const run = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349.3];
    run.forEach((f, k) => {
      const at = t + k * 0.13;
      this.tone(at, f, 0.5, { type: 'sine', gain: 0.26 });
      this.tone(at, f, 0.3, { type: 'triangle', gain: 0.09, detune: 7 });
    });
    const chordAt = t + 1.6;
    for (const f of [1046.5, 1318.5, 1568, 2093]) {
      this.tone(chordAt, f, 1.2, { type: 'sawtooth', gain: 0.1, cutoff: 3000, hold: 0.5, detune: -6 });
      this.tone(chordAt, f, 1.2, { type: 'sine', gain: 0.16, hold: 0.5 });
    }
    const ctx = this.ctx;
    const graph = this.graph;
    if (!ctx || !graph) return;
    const src = ctx.createBufferSource();
    src.buffer = graph.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(8000, t + 1.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.linearRampToValueAtTime(0.16, t + 1.6);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 2.6);
    src.connect(f);
    f.connect(g);
    g.connect(graph.sfxGain);
    src.start(t);
    src.stop(t + 2.65);
  }

  private sfxCrash(t: number, i: number): void {
    const amt = clamp(i, 0.2, 1.5);
    this.tone(t, 90, 0.4, { type: 'sine', gain: 0.8 * amt, slideTo: 28 });
    this.noiseBurst(t, 0.3, { type: 'lowpass', freq: 1500, freqTo: 250, gain: 0.5 * amt });
    this.noiseBurst(t, 0.12, { type: 'highpass', freq: 3000, gain: 0.22 * amt });
  }

  private sfxLand(t: number, i: number): void {
    const amt = clamp(i, 0.2, 1.5);
    this.tone(t, 110, 0.18, { type: 'sine', gain: 0.35 * amt, slideTo: 45 });
    this.noiseBurst(t, 0.1, { type: 'lowpass', freq: 700, gain: 0.12 * amt });
  }

  private sfxJump(t: number): void {
    this.noiseBurst(t, 0.3, { type: 'bandpass', freq: 500, freqTo: 2500, q: 1.5, gain: 0.22, attack: 0.03 });
    this.tone(t, 300, 0.25, { type: 'triangle', gain: 0.08, slideTo: 900 });
  }

  private sfxBoost(t: number): void {
    this.noiseBurst(t, 0.55, { type: 'bandpass', freq: 300, freqTo: 3500, q: 1.2, gain: 0.3, attack: 0.05 });
    this.tone(t, 180, 0.45, { type: 'sawtooth', gain: 0.12, slideTo: 720, cutoff: 1800, attack: 0.03 });
  }

  private sfxClick(t: number): void {
    this.tone(t, 1800, 0.05, { type: 'sine', gain: 0.22 });
    this.tone(t, 3600, 0.02, { type: 'square', gain: 0.03 });
  }

  private sfxHover(t: number): void {
    if (t - this.lastHover < 0.04) return;
    this.lastHover = t;
    this.tone(t, 2400, 0.03, { type: 'sine', gain: 0.05 });
  }

  private sfxBack(t: number): void {
    this.tone(t, 620, 0.09, { type: 'triangle', gain: 0.2, slideTo: 380 });
  }

  private sfxRespawn(t: number): void {
    this.tone(t, 880, 0.2, { type: 'triangle', gain: 0.28, slideTo: 440 });
    this.tone(t + 0.1, 440, 0.22, { type: 'sine', gain: 0.2, slideTo: 220 });
  }

  private sfxError(t: number): void {
    for (let k = 0; k < 2; k++) {
      const at = t + k * 0.14;
      this.tone(at, 110, 0.1, { type: 'square', gain: 0.18, cutoff: 500, hold: 0.06 });
      this.tone(at, 113, 0.1, { type: 'square', gain: 0.12, cutoff: 500, hold: 0.06 });
    }
  }

  private sfxCoin(t: number): void {
    this.tone(t, 988, 0.08, { type: 'sine', gain: 0.3, hold: 0.04 });
    this.tone(t + 0.08, 1318.5, 0.35, { type: 'sine', gain: 0.3, hold: 0.05 });
  }

  private sfxUnlock(t: number): void {
    [880, 1108.7, 1318.5, 1760].forEach((f, k) => this.bell(t + k * 0.11, f, 0.7, 0.24));
  }

  private sfxLobbyJoin(t: number): void {
    this.tone(t, 660, 0.18, { type: 'triangle', gain: 0.24 });
    this.tone(t + 0.13, 880, 0.3, { type: 'triangle', gain: 0.24 });
  }

  private sfxRaceWin(t: number): void {
    this.fanfare(t, [392, 523.25, 659.25, 783.99], 0.12, 0.9, 0.28);
    const chordAt = t + 0.6;
    for (const f of [1046.5, 1318.5, 1568, 2093]) {
      this.tone(chordAt, f, 1.1, { type: 'sawtooth', gain: 0.08, cutoff: 3000, hold: 0.45, detune: -6 });
      this.tone(chordAt, f, 1.1, { type: 'sine', gain: 0.14, hold: 0.45 });
    }
    this.noiseBurst(chordAt, 1.0, { type: 'highpass', freq: 5000, gain: 0.1, attack: 0.03 });
  }

  private sfxNotify(t: number): void {
    this.bell(t, 1046.5, 0.5, 0.2);
  }
}

let instance: AudioEngine | null = null;

export function getAudio(): AudioEngine {
  if (!instance) instance = new AudioEngine();
  return instance;
}
