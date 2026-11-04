// Autopilot that follows the track centerline. Used by automated track-completion tests
// (every official track must be completable) and as a reference for medal times.

import type { CompiledTrack } from '@shared/track/types';
import { nearestFrameIndex, nearestFrameIndexGlobal } from '@shared/track/compile';
import { vsub, vdot, vcross, vnorm, clamp } from '@shared/math';
import type { CarInput, CarPhysics } from './car';

export interface BotOptions {
  aggression?: number;     // 0.6 (safe) .. 1.2 (fast)
  lateralAccel?: number;   // m/s^2 cornering budget
}

export class BotDriver {
  private frameHint = 0;
  private lastSteer = 0;
  aggression: number;
  lateralAccel: number;

  constructor(private track: CompiledTrack, opts: BotOptions = {}) {
    this.aggression = opts.aggression ?? 1;
    this.lateralAccel = opts.lateralAccel ?? 38;
  }

  reset(car: CarPhysics) { this.frameHint = nearestFrameIndexGlobal(this.track.frames, car.position); this.lastSteer = 0; }

  get frameIndex() { return this.frameHint; }

  private frameAtDist(startIdx: number, extra: number) {
    const frames = this.track.frames;
    const target = frames[startIdx].dist + extra;
    let i = startIdx;
    while (i < frames.length - 1 && frames[i].dist < target) i++;
    return i;
  }

  /** Turning curvature (1/m) over the next `ahead` meters, measured in the road plane. */
  private maxCurvature(startIdx: number, from: number, to: number): number {
    const frames = this.track.frames;
    const i0 = this.frameAtDist(startIdx, from), i1 = this.frameAtDist(startIdx, to);
    let maxK = 0;
    for (let i = i0; i < i1; i += 2) {
      const a = frames[i], b = frames[Math.min(frames.length - 1, i + 2)];
      const ds = Math.max(0.5, b.dist - a.dist);
      // yaw rate component: change of tangent projected onto the right vector
      const dt = vsub(b.tangent, a.tangent);
      const k = Math.abs(vdot(dt, a.right)) / ds;
      if (k > maxK) maxK = k;
    }
    return maxK;
  }

  update(car: CarPhysics): CarInput {
    const frames = this.track.frames;
    this.frameHint = nearestFrameIndex(frames, car.position, this.frameHint, 80);
    const speed = car.telemetry.speedAbs;
    const look = clamp(9 + speed * 0.42, 10, 42);
    const ti = this.frameAtDist(this.frameHint, look);
    const target = frames[ti];
    // steer toward target in the road plane (use the road's up: more stable than the chassis up)
    const near = frames[this.frameHint];
    const toT = vsub(target.pos, car.position);
    const up = near.up;
    const flat = vnorm(vsub(toT, { x: up.x * vdot(toT, up), y: up.y * vdot(toT, up), z: up.z * vdot(toT, up) }));
    const fwdFlat = vnorm(vsub(car.forward, { x: up.x * vdot(car.forward, up), y: up.y * vdot(car.forward, up), z: up.z * vdot(car.forward, up) }));
    const sin = vdot(vcross(fwdFlat, flat), up); // + = target on the left
    const cos = vdot(fwdFlat, flat);
    const angle = Math.atan2(sin, cos);
    // cross-track correction (positive = car is right of the centerline -> steer left)
    const e = vdot(vsub(car.position, near.pos), near.right);
    let steer = clamp(angle * 2.4 + clamp(e * 0.05, -0.35, 0.35), -1, 1);
    steer = this.lastSteer + clamp(steer - this.lastSteer, -0.25, 0.25);
    this.lastSteer = steer;

    // speed planning from upcoming curvature
    const kNear = this.maxCurvature(this.frameHint, 0, 20 + speed * 0.3);
    const kFar = this.maxCurvature(this.frameHint, 20 + speed * 0.3, 55 + speed * 0.9);
    const vFor = (k: number) => (k < 1e-4 ? 999 : Math.sqrt(this.lateralAccel * this.aggression / k));
    const target1 = vFor(kNear);
    const target2 = vFor(kFar) + 6; // we have time to brake before far curves
    const vTarget = Math.min(target1, target2, 74 * this.aggression + 20);
    let throttle = 0, brake = 0;
    if (cos < -0.2 && speed < 5) { brake = 1; steer = -steer; } // wrong way: reverse
    else if (speed < vTarget - 1) throttle = 1;
    else if (speed > vTarget + 3) brake = 1;
    else throttle = 0.4;
    // keep speed on vertical sections (loops) regardless of planner
    if (car.up.y < 0.5 && car.telemetry.grounded) { throttle = 1; brake = 0; }
    // airborne: no pitch inputs so the auto-level lands the car flat
    if (!car.telemetry.grounded && car.telemetry.airTime > 0.15) { throttle = 0; brake = 0; }
    return { throttle, brake, steer, handbrake: false };
  }
}
