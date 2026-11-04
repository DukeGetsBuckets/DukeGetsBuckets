import type { TrackDefinition } from '../shared/track/types';
import { compileTrack } from '../shared/track/compile';
import { initRapier, PhysicsWorld, PHYSICS_DT } from '../src/game/physics/world';
import { CarPhysics } from '../src/game/physics/car';
import { RaceController } from '../src/game/race/raceController';
import { BotDriver } from '../src/game/physics/bot';

export interface DriveResult { finished: boolean; timeMs: number; respawns: number; maxSpeed: number; checkpoints: number; stuckAt?: { x: number; y: number; z: number; frame: number } }

export async function driveTrack(def: TrackDefinition, opts: { aggression?: number; maxSeconds?: number; log?: boolean } = {}): Promise<DriveResult> {
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
  for (let s = 0; s < maxSteps; s++) {
    car.input = bot.update(car);
    car.preStep();
    pw.step();
    car.postStep();
    race.step(car.prevPosition, car.position, true);
    maxSpeed = Math.max(maxSpeed, car.telemetry.speedAbs);
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
