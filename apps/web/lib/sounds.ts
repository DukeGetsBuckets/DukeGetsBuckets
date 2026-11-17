"use client";

/**
 * Synthesised sounds via the Web Audio API — no licensed samples required.
 * iOS Safari requires the context to be unlocked by a user gesture; call `unlockAudio()` on first tap.
 */
type SoundName = "move" | "capture" | "check" | "castle" | "promote" | "start" | "end" | "lowTime" | "premove" | "notify";

let ctx: AudioContext | null = null;
let volume = 0.8;
let enabled = true;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

export function unlockAudio(): void {
  const c = context();
  if (c && c.state === "suspended") void c.resume();
}

export function configureSounds(opts: { enabled: boolean; volume: number }): void {
  enabled = opts.enabled;
  volume = Math.max(0, Math.min(1, opts.volume / 100));
}

function tone(c: AudioContext, opts: { freq: number; type?: OscillatorType; duration: number; gain?: number; at?: number; decay?: number; freqEnd?: number }): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  const start = c.currentTime + (opts.at ?? 0);
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, start);
  if (opts.freqEnd) osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, start + opts.duration);
  const peak = (opts.gain ?? 0.5) * volume;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), start + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, start + opts.duration * (opts.decay ?? 1));
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + opts.duration + 0.05);
}

function noise(c: AudioContext, duration: number, gain: number, at = 0): void {
  const buffer = c.createBuffer(1, Math.floor(c.sampleRate * duration), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900;
  const g = c.createGain();
  g.gain.value = gain * volume;
  src.connect(filter).connect(g).connect(c.destination);
  src.start(c.currentTime + at);
}

export function playSound(name: SoundName): void {
  if (!enabled) return;
  const c = context();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  switch (name) {
    case "move":
      noise(c, 0.05, 0.5);
      tone(c, { freq: 420, type: "triangle", duration: 0.07, gain: 0.25, freqEnd: 300 });
      break;
    case "capture":
      noise(c, 0.09, 0.9);
      tone(c, { freq: 220, type: "square", duration: 0.1, gain: 0.3, freqEnd: 120 });
      break;
    case "castle":
      noise(c, 0.05, 0.4);
      tone(c, { freq: 380, type: "triangle", duration: 0.07, gain: 0.22 });
      tone(c, { freq: 380, type: "triangle", duration: 0.07, gain: 0.22, at: 0.1 });
      break;
    case "check":
      tone(c, { freq: 880, type: "sine", duration: 0.12, gain: 0.35 });
      tone(c, { freq: 1320, type: "sine", duration: 0.14, gain: 0.25, at: 0.06 });
      break;
    case "promote":
      tone(c, { freq: 523, duration: 0.1, gain: 0.3 });
      tone(c, { freq: 659, duration: 0.1, gain: 0.3, at: 0.08 });
      tone(c, { freq: 784, duration: 0.16, gain: 0.3, at: 0.16 });
      break;
    case "premove":
      tone(c, { freq: 600, type: "triangle", duration: 0.05, gain: 0.15 });
      break;
    case "start":
      tone(c, { freq: 440, duration: 0.12, gain: 0.3 });
      tone(c, { freq: 660, duration: 0.18, gain: 0.3, at: 0.12 });
      break;
    case "end":
      tone(c, { freq: 523, duration: 0.14, gain: 0.3 });
      tone(c, { freq: 392, duration: 0.18, gain: 0.3, at: 0.14 });
      tone(c, { freq: 330, duration: 0.3, gain: 0.3, at: 0.3 });
      break;
    case "lowTime":
      tone(c, { freq: 1000, type: "square", duration: 0.05, gain: 0.12 });
      break;
    case "notify":
      tone(c, { freq: 740, duration: 0.1, gain: 0.25 });
      tone(c, { freq: 988, duration: 0.14, gain: 0.25, at: 0.1 });
      break;
  }
}

export function haptic(pattern: number | number[] = 10): void {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}
