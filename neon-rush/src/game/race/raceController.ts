// Race timing, checkpoint logic, respawns, finish detection.
// Time is counted in fixed physics steps so it is independent of rendering frame rate.

import type { CompiledTrack, GateInfo } from '@shared/track/types';
import { crossesGate } from '@shared/track/compile';
import { Vec3, vadd, vscale } from '@shared/math';
import { PHYSICS_DT } from '../physics/world';

export type RaceState = 'idle' | 'countdown' | 'armed' | 'racing' | 'finished';

export interface SpawnPoint { pos: Vec3; forward: Vec3; up: Vec3 }

export interface RaceEvents {
  onCheckpoint?: (index: number, timeMs: number, splitDiffMs: number | null) => void;
  onFinish?: (timeMs: number, splits: number[]) => void;
  onStart?: () => void;
  onCountdown?: (value: number) => void;
  onRespawn?: (toStart: boolean) => void;
}

export class RaceController {
  state: RaceState = 'idle';
  steps = 0;
  nextCheckpoint = 0;
  splits: number[] = [];
  lastCheckpointSpawn: SpawnPoint;
  countdownSteps = 0;
  countdownTotal = 0;
  private lastCountdownValue = -1;
  respawnCount = 0;
  /** reference splits (personal best) for live diff display */
  referenceSplits: number[] | null = null;
  events: RaceEvents = {};
  readonly checkpoints: GateInfo[];

  constructor(public track: CompiledTrack) {
    this.checkpoints = track.checkpoints;
    this.lastCheckpointSpawn = { pos: track.start.pos, forward: track.start.forward, up: track.start.up };
  }

  get timeMs() { return Math.round(this.steps * PHYSICS_DT * 1000); }
  get checkpointCount() { return Math.max(0, this.checkpoints.length - 1); }
  get startSpawn(): SpawnPoint { return { pos: this.track.start.pos, forward: this.track.start.forward, up: this.track.start.up }; }

  /** Begin a race: with countdown (seconds) or "armed" (timer starts on first input). */
  reset(countdownSeconds: number) {
    this.steps = 0;
    this.nextCheckpoint = 0;
    this.splits = [];
    this.respawnCount = 0;
    this.lastCheckpointSpawn = this.startSpawn;
    this.lastCountdownValue = -1;
    if (countdownSeconds > 0) {
      this.state = 'countdown';
      this.countdownTotal = Math.round(countdownSeconds / PHYSICS_DT);
      this.countdownSteps = this.countdownTotal;
    } else {
      this.state = 'armed';
    }
  }

  /** Called every physics step. Returns true if the car should be frozen. */
  step(prevPos: Vec3, pos: Vec3, hasInput: boolean): boolean {
    switch (this.state) {
      case 'countdown': {
        this.countdownSteps--;
        const secs = Math.ceil(this.countdownSteps * PHYSICS_DT);
        if (secs !== this.lastCountdownValue) { this.lastCountdownValue = secs; this.events.onCountdown?.(secs); }
        if (this.countdownSteps <= 0) { this.state = 'racing'; this.events.onStart?.(); return false; }
        return true;
      }
      case 'armed':
        if (hasInput) { this.state = 'racing'; this.events.onStart?.(); return false; }
        return true;
      case 'racing': {
        this.steps++;
        const gate = this.checkpoints[this.nextCheckpoint];
        if (gate && crossesGate(gate, prevPos, pos)) {
          const t = this.timeMs;
          this.splits.push(t);
          if (gate.kind === 'finish') {
            this.state = 'finished';
            this.events.onFinish?.(t, this.splits.slice());
          } else {
            const ref = this.referenceSplits?.[this.nextCheckpoint];
            this.events.onCheckpoint?.(this.nextCheckpoint, t, ref != null ? t - ref : null);
            this.lastCheckpointSpawn = { pos: vadd(gate.pos, vscale(gate.forward, 2)), forward: gate.forward, up: gate.up };
            this.nextCheckpoint++;
          }
        }
        return false;
      }
      case 'finished':
        return false;
      default:
        return true;
    }
  }

  /** Respawn position: last checkpoint (or start). Timer keeps running (Trackmania style). */
  respawnPoint(): SpawnPoint {
    this.respawnCount++;
    const sp = this.lastCheckpointSpawn;
    this.events.onRespawn?.(this.nextCheckpoint === 0);
    return { pos: vadd(sp.pos, vscale(sp.up, 0.9)), forward: sp.forward, up: sp.up };
  }

  /** Fraction of the track completed, used for multiplayer positions. */
  progress(frameIndex: number): number {
    const frames = this.track.frames;
    if (!frames.length) return 0;
    const d = frames[Math.min(frameIndex, frames.length - 1)].dist;
    return this.track.length > 0 ? d / this.track.length : 0;
  }
}
