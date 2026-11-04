import type { TrackDefinition } from '../shared/track/types';
import { compileTrack } from '../shared/track/compile';
import { initRapier, PhysicsWorld, PHYSICS_DT } from '../src/game/physics/world';
import { CarPhysics } from '../src/game/physics/car';
import { RaceController } from '../src/game/race/raceController';
import { BotDriver } from '../src/game/physics/bot';
import { vsub, vdot } from '../shared/math';

export interface DriveResult { finished: boolean; timeMs: number; respawns: number; maxSpeed: number; checkpoints: number; stuckAt?: { x: number; y: number; z: number; frame: number } }

export async function driveTrack(def: TrackDefinition, opts: { aggression?: number; maxSeconds?: number; log?: boolean; trace?: [number, number] } = {}): Promise<DriveResult> {
  const R = await initRapier();
  const pw = new PhysicsWorld(R);
  const compiled = compileTrack(def);
  if (compiled.issues.length) throw new Error(def.id + ': ' + compiled.issues.join(', '));
  pw.setTrack(compiled.collision);
  const car = new CarPhysics(pw, compiled.start.pos, compiled.start.forward, compiled.start.up);
  const race = new RaceController(compiled);
  const bot = new BotDriver(compiled, { aggression: opts.aggression ?? 1 });
  race.reset(0);
  car.frozen = false;
  bot.reset(car);
  let respawns = 0, maxSpeed = 0;
  const maxSteps = Math.round((opts.maxSeconds ?? 240) / PHYSICS_DT);
  let lastProgressDist = 0, lastProgressStep = 0;
  let boostInside = false;
  for (let s = 0; s < maxSteps; s++) {
    car.input = bot.update(car);
    // boost pads (same rule as Game.checkBoostPads)
    let inside = false;
    for (const b of compiled.boosts) {
      const rel = vsub(car.position, b.pos);
      if (Math.abs(vdot(rel, b.forward)) <= b.halfLength && Math.abs(vdot(rel, b.right)) <= b.halfWidth && Math.abs(vdot(rel, b.up)) < 4) { inside = true; break; }
    }
    if (inside && !boostInside) car.applyBoost();
    boostInside = inside;
    car.preStep();
    pw.step();
    car.postStep();
    race.step(car.prevPosition, car.position, true);
    maxSpeed = Math.max(maxSpeed, car.telemetry.speedAbs);
    if (opts.trace && s % 30 === 0) {
      const d = compiled.frames[bot.frameIndex].dist;
      if (d >= opts.trace[0] && d <= opts.trace[1]) {
        const f = compiled.frames[bot.frameIndex];
        const rel = { x: car.position.x - f.pos.x, y: car.position.y - f.pos.y, z: car.position.z - f.pos.z };
        const lat = rel.x * f.right.x + rel.y * f.right.y + rel.z * f.right.z;
        const upOff = rel.x * f.up.x + rel.y * f.up.y + rel.z * f.up.z;
        console.log(`t=${(s * PHYSICS_DT).toFixed(2)} dist=${d.toFixed(0)} piece=${compiled.pieceTypes[f.pieceIndex]} v=${car.telemetry.speedAbs.toFixed(1)} gw=${car.telemetry.groundedWheels} lat=${lat.toFixed(1)} upOff=${upOff.toFixed(1)} carUp=(${car.up.x.toFixed(2)},${car.up.y.toFixed(2)},${car.up.z.toFixed(2)}) fUp=(${f.up.x.toFixed(2)},${f.up.y.toFixed(2)},${f.up.z.toFixed(2)}) steer=${car.input.steer.toFixed(2)} thr=${car.input.throttle} brk=${car.input.brake}`);
      }
    }
    if (race.state === 'finished') { pw.dispose(); return { finished: true, timeMs: race.timeMs, respawns, maxSpeed, checkpoints: race.splits.length }; }
    const fell = car.position.y < compiled.bounds.min.y - 30;
    const upsideDown = car.up.y < -0.2 && car.telemetry.speedAbs < 2;
    const d = compiled.frames[bot.frameIndex].dist;
    if (d > lastProgressDist + 2) { lastProgressDist = d; lastProgressStep = s; }
    const stuck = s - lastProgressStep > 6 * 120;
    if (fell || upsideDown || stuck) {
      respawns++;
      if (opts.log) console.log(`${def.id}: respawn #${respawns} at t=${(s * PHYSICS_DT).toFixed(1)}s dist=${d.toFixed(0)} (${fell ? 'fell' : upsideDown ? 'flipped' : 'stuck'}) pos=(${car.position.x.toFixed(0)},${car.position.y.toFixed(0)},${car.position.z.toFixed(0)})`);
      if (respawns > 12) break;
      const sp = race.respawnPoint();
      car.teleport(sp.pos, sp.forward, sp.up);
      bot.reset(car);
      lastProgressStep = s; lastProgressDist = compiled.frames[bot.frameIndex].dist;
    }
  }
  const res: DriveResult = { finished: false, timeMs: race.timeMs, respawns, maxSpeed, checkpoints: race.splits.length, stuckAt: { ...car.position, frame: bot.frameIndex } };
  pw.dispose();
  return res;
}
