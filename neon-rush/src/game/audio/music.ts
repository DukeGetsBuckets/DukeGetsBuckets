// Procedural step-sequenced music for NEON RUSH. Everything is synthesized with the Web Audio API.
// Songs are pure data (tempo, key, chords, patterns, sections) rendered by a lookahead scheduler.

export type SongId = 'menu' | 'neonCity' | 'skyIslands' | 'sunsetCanyon' | 'cyberVoid' | 'tropicalRush' | 'crystalMountains';

interface SynthCfg {
  waves: OscillatorType[];
  detune: number;   // cents between the detuned oscillators
  cutoff: number;   // lowpass resting frequency
  env: number;      // filter envelope depth as a multiple of cutoff
  res: number;
  attack: number;
  decay: number;
  sustain: number;  // 0..1 of peak
  release: number;
  level: number;
  send: number;     // delay send
  bell?: boolean;   // sine + inharmonic partial instead of filtered oscillators
}

interface BassCfg { waves: OscillatorType[]; sub: number; cutoff: number; env: number; res: number; decay: number; level: number }
interface PadCfg { waves: OscillatorType[]; detune: number; cutoff: number; level: number; attack: number; release: number }
interface DrumKit { level: number; kickDecay: number; hatDecay: number; snareDecay: number; clap: boolean }
interface DrumPattern { kick?: string; snare?: string; hat?: string; perc?: string }
interface Section { bars: number; drums: string | null; bass: boolean; arp: number | null; pad: boolean; lead: boolean; fill?: boolean }

export interface Song {
  id: SongId;
  bpm: number;
  root: number;          // MIDI note of the key root in the bass register
  scale: number[];       // semitone steps of the scale
  swing: number;         // 0..0.5, delays odd 16ths
  chords: number[][];    // chord voicings as semitone offsets from root
  progression: number[]; // chord index per bar
  bass: string;          // 16-step tokens: semitone offset from chord root, '.' rest, '-' tie, '!' accent, '~' slide
  arps: string[];        // tokens: chord degree (wraps octaves), '.' rest, '-' tie
  lead: string;          // tokens: scale degree, '.' rest, '-' tie
  drums: Record<string, DrumPattern>; // chars: X accent, x hit, g ghost, o open hat, . rest
  sections: Section[];
  loopFrom: number;      // section index to return to after the last section
  oct: { pad: number; arp: number; lead: number };
  sound: { bass: BassCfg; arp: SynthCfg; lead: SynthCfg; pad: PadCfg; drums: DrumKit; offbeatChords: boolean; delayFeedback: number; delayLevel: number };
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const MAJ_PENTA = [0, 2, 4, 7, 9];

const SONGS: Record<SongId, Song> = {
  menu: {
    id: 'menu', bpm: 100, root: 38, scale: MAJOR, swing: 0.16,
    chords: [[0, 4, 7, 11], [5, 9, 12, 16], [9, 12, 16, 19], [7, 11, 14, 17]],
    progression: [0, 0, 1, 1, 2, 2, 3, 3],
    bass: '0 . . . . . 0 . . . 12 . . . 7 .',
    arps: ['0 . 2 . 4 . 2 . 1 . 3 . 5 . 3 .', '0 2 4 6 4 2 1 3 5 3 1 2 4 2 0 .'],
    lead: '4 - - . 6 - 7 - 9 - - - . . 7 - 6 - 4 - . . 2 - 4 - - - . . . .',
    drums: {
      light: { kick: 'X.....x...x.....', snare: '....x.......x...', hat: '..x...x...x...x.' },
      full: { kick: 'X.....x...X.....', snare: '....X.......X..g', hat: 'x.x.x.x.x.x.x.x.' },
      break: { hat: '..x...x...x...x.' },
    },
    sections: [
      { bars: 8, drums: null, bass: false, arp: 0, pad: true, lead: false },
      { bars: 8, drums: 'light', bass: true, arp: 0, pad: true, lead: false, fill: true },
      { bars: 8, drums: 'full', bass: true, arp: 1, pad: true, lead: true },
      { bars: 8, drums: 'break', bass: false, arp: 0, pad: true, lead: false, fill: true },
      { bars: 8, drums: 'full', bass: true, arp: 1, pad: true, lead: false },
    ],
    loopFrom: 1,
    oct: { pad: 24, arp: 36, lead: 36 },
    sound: {
      bass: { waves: ['sawtooth'], sub: 0.6, cutoff: 280, env: 2.5, res: 1.5, decay: 0.3, level: 0.42 },
      arp: { waves: ['triangle'], detune: 0, cutoff: 2200, env: 2, res: 1, attack: 0.005, decay: 0.25, sustain: 0, release: 0.1, level: 0.3, send: 0.35 },
      lead: { waves: ['triangle', 'sine'], detune: 6, cutoff: 1800, env: 1.5, res: 1, attack: 0.02, decay: 0.3, sustain: 0.5, release: 0.15, level: 0.26, send: 0.4 },
      pad: { waves: ['triangle', 'triangle'], detune: 7, cutoff: 1400, level: 0.2, attack: 0.5, release: 0.8 },
      drums: { level: 0.7, kickDecay: 0.35, hatDecay: 0.04, snareDecay: 0.16, clap: false },
      offbeatChords: false, delayFeedback: 0.35, delayLevel: 0.4,
    },
  },
  neonCity: {
    id: 'neonCity', bpm: 128, root: 33, scale: MINOR, swing: 0,
    chords: [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17], [5, 8, 12]],
    progression: [0, 1, 2, 3, 0, 1, 4, 3],
    bass: '0! . 0 0 12 . 0 . 0! . 0 0 12 . 7 .',
    arps: ['0 1 2 3 4 3 2 1 0 1 2 3 4 3 2 1', '0 . 2 . 3 . 2 . 0 . 2 . 5 . 3 .'],
    lead: '7 - - 6 - - 4 - - - . . 4 5 7 - 9 - - - 7 - - - 4 - 2 - 4 - - -',
    drums: {
      light: { kick: 'X...X...X...X...', hat: '..x...x...x...x.' },
      full: { kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'x.x.x.o.x.x.x.o.' },
      break: { snare: '............X...', hat: 'x.x.x.x.x.x.x.x.' },
    },
    sections: [
      { bars: 8, drums: 'light', bass: true, arp: 1, pad: true, lead: false, fill: true },
      { bars: 8, drums: 'full', bass: true, arp: 0, pad: true, lead: false },
      { bars: 16, drums: 'full', bass: true, arp: 0, pad: true, lead: true, fill: true },
      { bars: 8, drums: 'break', bass: false, arp: 1, pad: true, lead: false, fill: true },
      { bars: 8, drums: 'full', bass: true, arp: 1, pad: true, lead: true },
    ],
    loopFrom: 1,
    oct: { pad: 24, arp: 36, lead: 36 },
    sound: {
      bass: { waves: ['sawtooth'], sub: 0.4, cutoff: 320, env: 4, res: 4, decay: 0.2, level: 0.45 },
      arp: { waves: ['sawtooth', 'sawtooth'], detune: 12, cutoff: 2600, env: 3, res: 2, attack: 0.004, decay: 0.18, sustain: 0, release: 0.06, level: 0.2, send: 0.4 },
      lead: { waves: ['sawtooth', 'square'], detune: 10, cutoff: 2200, env: 2, res: 2, attack: 0.01, decay: 0.25, sustain: 0.6, release: 0.1, level: 0.24, send: 0.45 },
      pad: { waves: ['sawtooth', 'sawtooth'], detune: 9, cutoff: 900, level: 0.14, attack: 0.4, release: 0.6 },
      drums: { level: 0.9, kickDecay: 0.3, hatDecay: 0.035, snareDecay: 0.18, clap: true },
      offbeatChords: false, delayFeedback: 0.38, delayLevel: 0.45,
    },
  },
  skyIslands: {
    id: 'skyIslands', bpm: 136, root: 40, scale: MAJOR, swing: 0,
    chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12], [2, 5, 9]],
    progression: [0, 1, 2, 3, 0, 1, 3, 1],
    bass: '0 . 0 . 12 . 0 . 0 . 0 . 12 . 7 .',
    arps: ['0 . 2 . 4 2 . 0 . 2 5 . 2 . 0 .', '0 2 4 2 3 2 4 5 0 2 4 2 3 2 4 2'],
    lead: '4 - 2 - 4 - 7 - - - 6 - 4 - . . 2 - 4 - 5 - 4 - - - 2 - 1 - . .',
    drums: {
      light: { kick: 'X.......X.......', hat: 'x.x.x.x.x.x.x.x.' },
      full: { kick: 'X...x..xX...x...', snare: '....X.......X...', hat: 'xgxgxgxgxgxgxgxg' },
      break: { snare: '....g.......X...', hat: '..x...x...x...x.' },
    },
    sections: [
      { bars: 8, drums: 'light', bass: false, arp: 0, pad: true, lead: false, fill: true },
      { bars: 8, drums: 'full', bass: true, arp: 0, pad: true, lead: false },
      { bars: 16, drums: 'full', bass: true, arp: 1, pad: true, lead: true, fill: true },
      { bars: 8, drums: 'break', bass: false, arp: 0, pad: true, lead: false, fill: true },
    ],
    loopFrom: 1,
    oct: { pad: 24, arp: 36, lead: 36 },
    sound: {
      bass: { waves: ['sawtooth'], sub: 0.5, cutoff: 400, env: 3, res: 2, decay: 0.22, level: 0.42 },
      arp: { waves: ['square', 'triangle'], detune: 5, cutoff: 3000, env: 4, res: 1, attack: 0.003, decay: 0.12, sustain: 0, release: 0.05, level: 0.24, send: 0.35 },
      lead: { waves: ['sawtooth', 'triangle'], detune: 8, cutoff: 2800, env: 2, res: 1.5, attack: 0.01, decay: 0.2, sustain: 0.55, release: 0.12, level: 0.24, send: 0.4 },
      pad: { waves: ['triangle', 'triangle'], detune: 8, cutoff: 1800, level: 0.18, attack: 0.3, release: 0.6 },
      drums: { level: 0.85, kickDecay: 0.28, hatDecay: 0.05, snareDecay: 0.17, clap: false },
      offbeatChords: false, delayFeedback: 0.3, delayLevel: 0.4,
    },
  },
  sunsetCanyon: {
    id: 'sunsetCanyon', bpm: 124, root: 31, scale: MAJ_PENTA, swing: 0.12,
    chords: [[0, 4, 7], [5, 9, 12, 19], [9, 12, 16, 19], [7, 11, 14]],
    progression: [0, 0, 1, 1, 2, 2, 1, 3],
    bass: '0 . . . . . 7 . 0 . . . 12 . 7 .',
    arps: ['0 . 2 . 1 . 3 . 0 . 2 . 4 . 2 .', '0 2 1 2 3 2 1 2 0 2 4 2 3 2 1 2'],
    lead: '5 - 4 - 3 - - - 4 - 5 - 7 - - - 6 - 5 - 4 - - - 3 - 4 - 3 - - -',
    drums: {
      light: { kick: 'X.......X.......', hat: '..x...x...x...x.' },
      full: { kick: 'X.....x.X...x...', snare: '....X.......X..g', hat: 'x.x.x.x.x.x.x.x.' },
      break: { snare: '............X...', hat: 'x.x.x.x.x.x.x.x.' },
    },
    sections: [
      { bars: 8, drums: 'light', bass: false, arp: 0, pad: true, lead: false, fill: true },
      { bars: 8, drums: 'full', bass: true, arp: 0, pad: true, lead: false },
      { bars: 16, drums: 'full', bass: true, arp: 1, pad: true, lead: true, fill: true },
      { bars: 8, drums: 'break', bass: true, arp: 0, pad: true, lead: false, fill: true },
    ],
    loopFrom: 1,
    oct: { pad: 24, arp: 36, lead: 36 },
    sound: {
      bass: { waves: ['sawtooth'], sub: 0.7, cutoff: 300, env: 2.5, res: 1, decay: 0.3, level: 0.45 },
      arp: { waves: ['triangle', 'sawtooth'], detune: 6, cutoff: 1800, env: 2, res: 1, attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.08, level: 0.22, send: 0.3 },
      lead: { waves: ['sawtooth', 'triangle'], detune: 7, cutoff: 1600, env: 1.6, res: 1, attack: 0.02, decay: 0.25, sustain: 0.6, release: 0.15, level: 0.25, send: 0.35 },
      pad: { waves: ['sawtooth', 'triangle'], detune: 8, cutoff: 800, level: 0.16, attack: 0.5, release: 0.9 },
      drums: { level: 0.8, kickDecay: 0.32, hatDecay: 0.045, snareDecay: 0.18, clap: false },
      offbeatChords: false, delayFeedback: 0.3, delayLevel: 0.35,
    },
  },
  cyberVoid: {
    id: 'cyberVoid', bpm: 142, root: 40, scale: PHRYGIAN, swing: 0,
    chords: [[0, 3, 7], [1, 5, 8], [-2, 1, 5], [-4, 0, 3]],
    progression: [0, 0, 1, 0, 0, 0, 2, 1],
    bass: '0! . 0 12 0 . 0~ 12 0! 0 . 7 0 . 12~ 0',
    arps: ['0 3 0 3 4 3 0 3 0 3 0 3 5 3 4 3', '0 . 3 . 0 . 4 . 0 . 3 . 0 . 5 .'],
    lead: '7 - - - 8 - 7 - 6 - 4 - - - . . 4 - 5 - 4 - 2 - 1 - 0 - - - . .',
    drums: {
      light: { kick: 'X...X...X...X...', hat: '..x...x...x...x.' },
      full: { kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'x.xgx.xgx.xgx.xg', perc: '..x...x...x...x.' },
      break: { snare: '............X...', hat: 'x.x.x.x.x.x.x.x.' },
    },
    sections: [
      { bars: 8, drums: 'light', bass: true, arp: 1, pad: false, lead: false, fill: true },
      { bars: 16, drums: 'full', bass: true, arp: 0, pad: true, lead: false },
      { bars: 8, drums: 'break', bass: true, arp: 1, pad: true, lead: false, fill: true },
      { bars: 16, drums: 'full', bass: true, arp: 0, pad: true, lead: true, fill: true },
    ],
    loopFrom: 1,
    oct: { pad: 24, arp: 36, lead: 36 },
    sound: {
      bass: { waves: ['sawtooth'], sub: 0.3, cutoff: 180, env: 9, res: 12, decay: 0.16, level: 0.42 },
      arp: { waves: ['square', 'sawtooth'], detune: 6, cutoff: 1400, env: 2.5, res: 4, attack: 0.003, decay: 0.1, sustain: 0, release: 0.04, level: 0.18, send: 0.4 },
      lead: { waves: ['sawtooth', 'sawtooth'], detune: 14, cutoff: 1600, env: 3, res: 3, attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.1, level: 0.24, send: 0.5 },
      pad: { waves: ['sawtooth', 'triangle'], detune: 10, cutoff: 600, level: 0.14, attack: 0.6, release: 0.8 },
      drums: { level: 0.9, kickDecay: 0.3, hatDecay: 0.03, snareDecay: 0.16, clap: false },
      offbeatChords: false, delayFeedback: 0.4, delayLevel: 0.45,
    },
  },
  tropicalRush: {
    id: 'tropicalRush', bpm: 130, root: 36, scale: MAJOR, swing: 0.06,
    chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]],
    progression: [0, 1, 2, 3, 0, 1, 3, 1],
    bass: '0 . 12 . 0 . 12 . 0 . 12 . 7 . 12 .',
    arps: ['0 . 2 1 . 2 0 . 4 . 2 1 . 2 3 .', '0 2 1 2 3 2 1 2 0 2 4 2 3 2 5 2'],
    lead: '4 - 4 - 7 - 6 - 4 - - - . . 2 - 4 - 5 - 4 - 2 - 1 - - - . . . .',
    drums: {
      light: { kick: 'X...X...X...X...', perc: '..x..x..x...x.x.' },
      full: { kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'x.xgx.xgx.xgx.xg', perc: '..x..x..x...x.x.' },
      break: { snare: '....g.......X...', hat: 'xgxgxgxgxgxgxgxg', perc: '..x..x..x...x.x.' },
    },
    sections: [
      { bars: 8, drums: 'light', bass: false, arp: 0, pad: true, lead: false, fill: true },
      { bars: 8, drums: 'full', bass: true, arp: 0, pad: true, lead: false },
      { bars: 16, drums: 'full', bass: true, arp: 1, pad: true, lead: true, fill: true },
      { bars: 8, drums: 'break', bass: true, arp: 0, pad: true, lead: false, fill: true },
    ],
    loopFrom: 1,
    oct: { pad: 24, arp: 36, lead: 36 },
    sound: {
      bass: { waves: ['sawtooth'], sub: 0.6, cutoff: 500, env: 3, res: 2, decay: 0.15, level: 0.45 },
      arp: { waves: ['sine', 'triangle'], detune: 4, cutoff: 3500, env: 1.5, res: 0.7, attack: 0.002, decay: 0.18, sustain: 0, release: 0.05, level: 0.3, send: 0.3 },
      lead: { waves: ['square', 'triangle'], detune: 6, cutoff: 2400, env: 2, res: 1, attack: 0.01, decay: 0.15, sustain: 0.6, release: 0.1, level: 0.22, send: 0.35 },
      pad: { waves: ['sawtooth'], detune: 7, cutoff: 2200, level: 0.2, attack: 0.005, release: 0.12 },
      drums: { level: 0.9, kickDecay: 0.28, hatDecay: 0.04, snareDecay: 0.15, clap: true },
      offbeatChords: true, delayFeedback: 0.3, delayLevel: 0.35,
    },
  },
  crystalMountains: {
    id: 'crystalMountains', bpm: 120, root: 41, scale: LYDIAN, swing: 0,
    chords: [[0, 4, 7, 11], [2, 6, 9, 14], [-3, 0, 4, 7], [4, 7, 11, 14]],
    progression: [0, 0, 1, 1, 2, 2, 1, 3],
    bass: '0 . . . . . . . 0 . . . 12 . . .',
    arps: ['0 . 2 . 4 . 6 . 5 . 3 . 1 . 2 .', '0 2 4 6 7 6 4 2 0 2 4 6 5 4 2 1'],
    lead: '4 - - - 6 - 7 - 9 - - - 7 - 6 - 4 - - - 3 - 4 - 2 - - - . . . .',
    drums: {
      light: { kick: 'X.......X.......', hat: '..x...x...x...x.' },
      full: { kick: 'X.......X...x...', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
      break: { hat: '..x...x...x...x.' },
    },
    sections: [
      { bars: 8, drums: null, bass: false, arp: 0, pad: true, lead: false },
      { bars: 8, drums: 'light', bass: true, arp: 0, pad: true, lead: false, fill: true },
      { bars: 16, drums: 'full', bass: true, arp: 1, pad: true, lead: true, fill: true },
      { bars: 8, drums: 'break', bass: false, arp: 0, pad: true, lead: false, fill: true },
    ],
    loopFrom: 1,
    oct: { pad: 24, arp: 36, lead: 36 },
    sound: {
      bass: { waves: ['triangle'], sub: 0.8, cutoff: 300, env: 2, res: 1, decay: 0.5, level: 0.42 },
      arp: { waves: ['sine'], detune: 0, cutoff: 4000, env: 1, res: 0.5, attack: 0.002, decay: 0.7, sustain: 0, release: 0.1, level: 0.24, send: 0.5, bell: true },
      lead: { waves: ['triangle', 'sine'], detune: 6, cutoff: 2200, env: 1.5, res: 1, attack: 0.03, decay: 0.3, sustain: 0.6, release: 0.2, level: 0.24, send: 0.5 },
      pad: { waves: ['triangle', 'triangle'], detune: 9, cutoff: 2400, level: 0.2, attack: 0.8, release: 1.2 },
      drums: { level: 0.6, kickDecay: 0.35, hatDecay: 0.06, snareDecay: 0.2, clap: false },
      offbeatChords: false, delayFeedback: 0.45, delayLevel: 0.5,
    },
  },
};

export const SONG_IDS = Object.keys(SONGS) as SongId[];
export function hasSong(id: string): id is SongId { return Object.prototype.hasOwnProperty.call(SONGS, id); }

// ---- pattern parsing ------------------------------------------------------

interface NotePattern { len: number; note: (number | null)[]; dur: number[]; accent: boolean[]; slide: boolean[] }
interface DrumLane { vel: number[]; open: boolean[] }
interface ParsedDrums { kick?: DrumLane; snare?: DrumLane; hat?: DrumLane; perc?: DrumLane }
interface ParsedSong { def: Song; stepDur: number; bass: NotePattern; arps: NotePattern[]; lead: NotePattern; drums: Record<string, ParsedDrums> }

function parseNotes(src: string): NotePattern {
  const tokens = src.trim().split(/\s+/);
  const len = tokens.length;
  const note: (number | null)[] = [];
  const accent: boolean[] = [];
  const slide: boolean[] = [];
  for (const tok of tokens) {
    if (tok === '.' || tok === '-') { note.push(null); accent.push(false); slide.push(false); continue; }
    accent.push(tok.endsWith('!'));
    slide.push(tok.endsWith('~'));
    const n = parseInt(tok, 10);
    note.push(Number.isFinite(n) ? n : null);
  }
  const dur: number[] = [];
  for (let i = 0; i < len; i++) {
    let d = 1;
    for (let j = (i + 1) % len; tokens[j] === '-' && d < len; j = (j + 1) % len) d++;
    dur.push(d);
  }
  return { len, note, dur, accent, slide };
}

function parseLane(src: string): DrumLane {
  const vel: number[] = [];
  const open: boolean[] = [];
  for (let i = 0; i < 16; i++) {
    const c = src[i] ?? '.';
    vel.push(c === 'X' ? 1 : c === 'x' || c === 'o' ? 0.7 : c === 'g' ? 0.3 : 0);
    open.push(c === 'o');
  }
  return { vel, open };
}

const parsedCache = new Map<SongId, ParsedSong>();
function parseSong(id: SongId): ParsedSong {
  const cached = parsedCache.get(id);
  if (cached) return cached;
  const def = SONGS[id];
  const drums: Record<string, ParsedDrums> = {};
  for (const key of Object.keys(def.drums)) {
    const p = def.drums[key];
    drums[key] = {
      kick: p.kick ? parseLane(p.kick) : undefined,
      snare: p.snare ? parseLane(p.snare) : undefined,
      hat: p.hat ? parseLane(p.hat) : undefined,
      perc: p.perc ? parseLane(p.perc) : undefined,
    };
  }
  const parsed: ParsedSong = {
    def,
    stepDur: 60 / def.bpm / 4,
    bass: parseNotes(def.bass),
    arps: def.arps.map(parseNotes),
    lead: parseNotes(def.lead),
    drums,
  };
  parsedCache.set(id, parsed);
  return parsed;
}

// ---- helpers --------------------------------------------------------------

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const degreeOf = (steps: number[], d: number): number => {
  const n = steps.length;
  const o = Math.floor(d / n);
  return steps[d - o * n] + 12 * o;
};
const FILL = [0.35, 0, 0.45, 0, 0.55, 0.6, 0.75, 1];
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const MIN_GAIN = 0.0005;

// Freeze a param at its current value so later automation starts from there without a jump.
export function holdAt(p: AudioParam, t: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') { p.cancelAndHoldAtTime(t); return; }
  const v = p.value;
  p.cancelScheduledValues(t);
  p.setValueAtTime(v, t);
}

export function makeNoiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

interface PadVoice { gain: GainNode; oscs: OscillatorNode[]; chord: number }

// ---- player ---------------------------------------------------------------

export class MusicPlayer {
  private readonly ctx: AudioContext;
  private readonly noise: AudioBuffer;
  private readonly master: GainNode;
  private readonly drumBus: GainNode;
  private readonly scBus: GainNode;
  private readonly leadBus: GainNode;
  private readonly hatFilter: BiquadFilterNode;
  private readonly snareFilter: BiquadFilterNode;
  private readonly percFilter: BiquadFilterNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly delay: DelayNode;
  private readonly delayFb: GainNode;
  private readonly delayOut: GainNode;
  private readonly arpSend: GainNode;
  private readonly leadSend: GainNode;

  private song: ParsedSong;
  private pending: ParsedSong | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private sectionIdx = 0;
  private sectionBar = 0;
  private pad: PadVoice | null = null;
  private disposed = false;

  constructor(ctx: AudioContext, out: AudioNode, noise?: AudioBuffer) {
    this.ctx = ctx;
    this.noise = noise ?? makeNoiseBuffer(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(out);

    this.drumBus = ctx.createGain();
    this.scBus = ctx.createGain();
    this.leadBus = ctx.createGain();
    this.drumBus.connect(this.master);
    this.scBus.connect(this.master);
    this.leadBus.connect(this.master);

    this.hatFilter = ctx.createBiquadFilter();
    this.hatFilter.type = 'highpass';
    this.hatFilter.frequency.value = 7000;
    this.hatFilter.connect(this.drumBus);

    this.snareFilter = ctx.createBiquadFilter();
    this.snareFilter.type = 'bandpass';
    this.snareFilter.frequency.value = 1800;
    this.snareFilter.Q.value = 0.6;
    this.snareFilter.connect(this.drumBus);

    this.percFilter = ctx.createBiquadFilter();
    this.percFilter.type = 'bandpass';
    this.percFilter.frequency.value = 1600;
    this.percFilter.Q.value = 3;
    this.percFilter.connect(this.drumBus);

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 1200;
    this.padFilter.connect(this.scBus);

    this.delay = ctx.createDelay(1.5);
    this.delayFb = ctx.createGain();
    this.delayOut = ctx.createGain();
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = 'lowpass';
    delayTone.frequency.value = 2800;
    this.delay.connect(delayTone);
    delayTone.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    delayTone.connect(this.delayOut);
    this.delayOut.connect(this.master);
    this.arpSend = ctx.createGain();
    this.leadSend = ctx.createGain();
    this.arpSend.connect(this.delay);
    this.leadSend.connect(this.delay);

    this.song = parseSong('menu');
    this.applySongSettings(this.song);
  }

  get playing(): boolean { return this.running; }
  get songId(): SongId { return (this.pending ?? this.song).def.id; }

  setSong(id: string): boolean {
    if (!hasSong(id)) return false;
    const next = parseSong(id);
    if (this.running) {
      if (next !== this.song) this.pending = next;
      else this.pending = null;
    } else {
      this.song = next;
      this.pending = null;
      this.applySongSettings(next);
      this.resetPosition();
    }
    return true;
  }

  start(): void {
    if (this.disposed) return;
    if (this.stopTimer !== null) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0.8, now, 0.1);
    if (this.running) return;
    this.running = true;
    this.resetPosition();
    this.nextTime = now + 0.06;
    this.timer = setInterval(this.tick, LOOKAHEAD_MS);
  }

  stop(fadeSeconds = 0.8): void {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    const fade = Math.max(0.02, fadeSeconds);
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0, now, fade / 3);
    if (this.stopTimer !== null) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this.halt();
    }, fade * 1000 + 120);
  }

  dispose(): void {
    this.disposed = true;
    this.halt();
    if (this.stopTimer !== null) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    try { this.master.disconnect(); } catch { /* already gone */ }
  }

  private halt(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.running = false;
    this.releasePad(this.ctx.currentTime);
    if (this.pending) { this.song = this.pending; this.pending = null; this.applySongSettings(this.song); }
  }

  private resetPosition(): void {
    this.step = 0;
    this.bar = 0;
    this.sectionIdx = 0;
    this.sectionBar = 0;
  }

  private applySongSettings(s: ParsedSong): void {
    const now = this.ctx.currentTime;
    const snd = s.def.sound;
    this.delay.delayTime.setValueAtTime(Math.min(1.4, 0.75 * (60 / s.def.bpm)), now);
    this.delayFb.gain.setValueAtTime(snd.delayFeedback, now);
    this.delayOut.gain.setValueAtTime(snd.delayLevel, now);
    this.padFilter.frequency.setTargetAtTime(snd.pad.cutoff, now, 0.05);
    this.arpSend.gain.setValueAtTime(snd.arp.send, now);
    this.leadSend.gain.setValueAtTime(snd.lead.send, now);
  }

  private readonly tick = (): void => {
    const now = this.ctx.currentTime;
    // Resync after a stall (tab hidden, context suspended) instead of bursting every missed note.
    if (this.nextTime < now - 0.25) this.nextTime = now + 0.02;
    const ahead = typeof document !== 'undefined' && document.hidden ? 1.2 : SCHEDULE_AHEAD;
    const horizon = now + ahead;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) {
      if (this.pending && this.step % 4 === 0) this.switchSong(this.nextTime);
      try { this.scheduleStep(this.nextTime); } catch { /* keep the clock running */ }
      this.advance();
    }
  };

  private switchSong(t: number): void {
    if (!this.pending) return;
    this.releasePad(t);
    this.song = this.pending;
    this.pending = null;
    this.applySongSettings(this.song);
    this.resetPosition();
    this.master.gain.setTargetAtTime(0.3, Math.max(this.ctx.currentTime, t - 0.08), 0.03);
    this.master.gain.setTargetAtTime(0.8, t + 0.05, 0.25);
  }

  private advance(): void {
    this.nextTime += this.song.stepDur;
    this.step++;
    if (this.step % 16 !== 0) return;
    this.bar++;
    this.sectionBar++;
    const sections = this.song.def.sections;
    if (this.sectionBar >= sections[this.sectionIdx].bars) {
      this.sectionBar = 0;
      this.sectionIdx++;
      if (this.sectionIdx >= sections.length) this.sectionIdx = Math.min(this.song.def.loopFrom, sections.length - 1);
    }
  }

  private scheduleStep(t0: number): void {
    const s = this.song;
    const def = s.def;
    const step16 = this.step % 16;
    const section = def.sections[this.sectionIdx];
    const t = step16 % 2 === 1 ? t0 + def.swing * s.stepDur : t0;
    const chordIdx = def.progression[this.bar % def.progression.length];
    const chord = def.chords[chordIdx];
    const lastBar = this.sectionBar === section.bars - 1;

    if (section.drums) {
      const dp = s.drums[section.drums];
      if (dp) {
        if (dp.kick && dp.kick.vel[step16] > 0) this.kick(t, dp.kick.vel[step16]);
        let snareVel = dp.snare ? dp.snare.vel[step16] : 0;
        if (section.fill && lastBar && step16 >= 8) snareVel = Math.max(snareVel, FILL[step16 - 8]);
        if (snareVel > 0) this.snare(t, snareVel);
        if (dp.hat && dp.hat.vel[step16] > 0) this.hat(t, dp.hat.vel[step16], dp.hat.open[step16]);
        if (dp.perc && dp.perc.vel[step16] > 0) this.perc(t, dp.perc.vel[step16]);
      }
    }

    if (section.bass) {
      const p = s.bass;
      const i = this.step % p.len;
      const n = p.note[i];
      if (n !== null) {
        const midi = def.root + chord[0] + n;
        let slideTo: number | null = null;
        if (p.slide[i]) {
          for (let k = 1; k < p.len; k++) {
            const m = p.note[(i + k) % p.len];
            if (m !== null) { slideTo = def.root + chord[0] + m; break; }
          }
        }
        this.bass(t, midi, p.dur[i] * s.stepDur, p.accent[i], slideTo);
      }
    }

    if (section.arp !== null) {
      const p = s.arps[section.arp];
      if (p) {
        const i = this.step % p.len;
        const n = p.note[i];
        if (n !== null) this.synth(def.sound.arp, def.root + def.oct.arp + degreeOf(chord, n), t, p.dur[i] * s.stepDur, this.scBus, this.arpSend);
      }
    }

    if (section.lead) {
      const p = s.lead;
      const i = this.step % p.len;
      const n = p.note[i];
      if (n !== null) this.synth(def.sound.lead, def.root + def.oct.lead + degreeOf(def.scale, n), t, p.dur[i] * s.stepDur, this.leadBus, this.leadSend);
    }

    if (section.pad) {
      if (def.sound.offbeatChords) {
        if (step16 % 4 === 2) this.stab(chord, t);
      } else if (step16 === 0 && (this.pad === null || this.pad.chord !== chordIdx)) {
        this.releasePad(t);
        this.startPad(chord, chordIdx, t);
      }
    } else if (this.pad && step16 === 0) {
      this.releasePad(t);
    }
  }

  // ---- voices -------------------------------------------------------------

  private noiseSrc(): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    return src;
  }

  private kick(t: number, vel: number): void {
    const ctx = this.ctx;
    const k = this.song.def.sound.drums;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.linearRampToValueAtTime(vel * k.level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + k.kickDecay);
    o.connect(g);
    g.connect(this.drumBus);
    o.start(t);
    o.stop(t + k.kickDecay + 0.02);

    const n = this.noiseSrc();
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * 0.25 * k.level, t);
    ng.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.018);
    n.connect(ng);
    ng.connect(this.drumBus);
    n.start(t, Math.random());
    n.stop(t + 0.03);

    // Sidechain pump on bass, pad and arp.
    this.scBus.gain.setTargetAtTime(0.35, t, 0.004);
    this.scBus.gain.setTargetAtTime(1, t + 0.03, 0.07);
  }

  private snare(t: number, vel: number): void {
    const ctx = this.ctx;
    const k = this.song.def.sound.drums;
    const lvl = vel * 0.8 * k.level;
    const n = this.noiseSrc();
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    if (k.clap) {
      g.gain.linearRampToValueAtTime(lvl, t + 0.002);
      g.gain.exponentialRampToValueAtTime(lvl * 0.25, t + 0.011);
      g.gain.setValueAtTime(lvl, t + 0.013);
      g.gain.exponentialRampToValueAtTime(lvl * 0.25, t + 0.024);
      g.gain.setValueAtTime(lvl, t + 0.026);
      g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.026 + k.snareDecay);
    } else {
      g.gain.linearRampToValueAtTime(lvl, t + 0.002);
      g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + k.snareDecay);
      const body = ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.setValueAtTime(210, t);
      body.frequency.exponentialRampToValueAtTime(120, t + 0.08);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(lvl * 0.5, t);
      bg.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.1);
      body.connect(bg);
      bg.connect(this.drumBus);
      body.start(t);
      body.stop(t + 0.12);
    }
    n.connect(g);
    g.connect(this.snareFilter);
    n.start(t, Math.random());
    n.stop(t + k.snareDecay + 0.05);
  }

  private hat(t: number, vel: number, open: boolean): void {
    const k = this.song.def.sound.drums;
    const decay = open ? 0.25 : k.hatDecay;
    const n = this.noiseSrc();
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.linearRampToValueAtTime(vel * 0.45 * k.level, t + 0.001);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + decay);
    n.connect(g);
    g.connect(this.hatFilter);
    n.start(t, Math.random());
    n.stop(t + decay + 0.02);
  }

  private perc(t: number, vel: number): void {
    const ctx = this.ctx;
    const k = this.song.def.sound.drums;
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.linearRampToValueAtTime(vel * 0.2 * k.level, t + 0.001);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.06);
    for (const f of [587, 845]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(g);
      o.start(t);
      o.stop(t + 0.08);
    }
    g.connect(this.percFilter);
  }

  private bass(t: number, midi: number, dur: number, accent: boolean, slideTo: number | null): void {
    const ctx = this.ctx;
    const c = this.song.def.sound.bass;
    const f = mtof(midi);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = c.res;
    const peak = Math.min(12000, c.cutoff * c.env * (accent ? 1.6 : 1));
    flt.frequency.setValueAtTime(peak, t);
    flt.frequency.exponentialRampToValueAtTime(c.cutoff, t + Math.max(0.03, Math.min(dur, c.decay)));
    const g = ctx.createGain();
    const lvl = c.level * (accent ? 1.25 : 1);
    const end = t + Math.max(dur - 0.01, 0.03);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + 0.006);
    g.gain.setTargetAtTime(lvl * 0.65, t + 0.006, c.decay / 3);
    g.gain.setTargetAtTime(0, end, slideTo !== null ? 0.004 : 0.012);
    flt.connect(g);
    g.connect(this.scBus);
    const stopAt = end + 0.08;
    for (const w of c.waves) {
      const o = ctx.createOscillator();
      o.type = w;
      o.frequency.setValueAtTime(f, t);
      if (slideTo !== null) o.frequency.exponentialRampToValueAtTime(mtof(slideTo), end);
      o.connect(flt);
      o.start(t);
      o.stop(stopAt);
    }
    if (c.sub > 0) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(f, t);
      if (slideTo !== null) sub.frequency.exponentialRampToValueAtTime(mtof(slideTo), end);
      const sg = ctx.createGain();
      sg.gain.value = c.sub;
      sub.connect(sg);
      sg.connect(g);
      sub.start(t);
      sub.stop(stopAt);
    }
  }

  private synth(c: SynthCfg, midi: number, t: number, dur: number, bus: AudioNode, send: AudioNode): void {
    if (c.bell) { this.bell(c, midi, t, bus, send); return; }
    const ctx = this.ctx;
    const f = mtof(midi);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = c.res;
    flt.frequency.setValueAtTime(Math.min(14000, c.cutoff * c.env), t);
    flt.frequency.exponentialRampToValueAtTime(c.cutoff, t + c.decay + 0.01);
    const g = ctx.createGain();
    const rel = t + Math.max(dur - 0.01, c.attack + 0.02);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(c.level, t + c.attack);
    g.gain.setTargetAtTime(c.level * c.sustain, t + c.attack, c.decay / 3);
    g.gain.setTargetAtTime(0, rel, c.release / 3);
    flt.connect(g);
    g.connect(bus);
    g.connect(send);
    const n = c.waves.length;
    const stopAt = rel + c.release + 0.05;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = c.waves[i];
      o.frequency.value = f;
      if (n > 1) o.detune.value = c.detune * (i * 2 - (n - 1));
      o.connect(flt);
      o.start(t);
      o.stop(stopAt);
    }
  }

  private bell(c: SynthCfg, midi: number, t: number, bus: AudioNode, send: AudioNode): void {
    const ctx = this.ctx;
    const f = mtof(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.linearRampToValueAtTime(c.level, t + 0.003);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + c.decay);
    g.connect(bus);
    g.connect(send);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    o.start(t);
    o.stop(t + c.decay + 0.02);
    const p = ctx.createOscillator();
    p.type = 'sine';
    p.frequency.value = f * 2.76;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.22, t);
    pg.gain.exponentialRampToValueAtTime(0.001, t + c.decay * 0.45);
    p.connect(pg);
    pg.connect(g);
    p.start(t);
    p.stop(t + c.decay * 0.5);
  }

  private startPad(chord: number[], chordIdx: number, t: number): void {
    const ctx = this.ctx;
    const def = this.song.def;
    const c = def.sound.pad;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(c.level, t + c.attack);
    g.connect(this.padFilter);
    const oscs: OscillatorNode[] = [];
    const notes = chord.slice(0, 4);
    for (const note of notes) {
      const f = mtof(def.root + def.oct.pad + note);
      for (let i = 0; i < c.waves.length; i++) {
        const o = ctx.createOscillator();
        o.type = c.waves[i];
        o.frequency.value = f;
        o.detune.value = c.detune * (i % 2 === 0 ? 1 : -1) + (i >= 2 ? 3 : 0);
        o.connect(g);
        o.start(t);
        oscs.push(o);
      }
    }
    this.pad = { gain: g, oscs, chord: chordIdx };
  }

  private releasePad(t: number): void {
    const pad = this.pad;
    if (!pad) return;
    this.pad = null;
    const rel = this.song.def.sound.pad.release;
    const at = Math.max(t, this.ctx.currentTime);
    holdAt(pad.gain.gain, at);
    pad.gain.gain.setTargetAtTime(0, at, rel / 3);
    for (const o of pad.oscs) {
      try { o.stop(at + rel * 1.5 + 0.1); } catch { /* already stopped */ }
    }
  }

  private stab(chord: number[], t: number): void {
    const ctx = this.ctx;
    const def = this.song.def;
    const c = def.sound.pad;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(c.level, t + 0.005);
    g.gain.setTargetAtTime(0, t + 0.09, c.release / 3);
    g.connect(this.padFilter);
    for (const note of chord.slice(0, 3)) {
      const o = ctx.createOscillator();
      o.type = c.waves[0];
      o.frequency.value = mtof(def.root + def.oct.pad + note);
      o.detune.value = c.detune;
      o.connect(g);
      o.start(t);
      o.stop(t + 0.1 + c.release * 2);
    }
  }
}
