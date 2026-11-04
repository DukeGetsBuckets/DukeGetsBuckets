import { it } from 'vitest';
import { chain } from '../shared/track/chain';
import { compileTrack } from '../shared/track/compile';
import { initRapier, PhysicsWorld, PHYSICS_DT } from '../src/game/physics/world';
import { CarPhysics } from '../src/game/physics/car';
import { BotDriver } from '../src/game/physics/bot';

it('corkscrew diagnostics', async () => {
  const pieces = chain({ x: 0, y: 0, z: 0, rot: 0 }, ['start', 'straight', 'boost', 'straight', 'corkscrewL', 'straight2', 'finish']);
  const compiled = compileTrack({ pieces });
  const R = await initRapier();
  const pw = new PhysicsWorld(R);
  pw.setTrack(compiled.collision);
  const car = new CarPhysics(pw, compiled.start.pos, compiled.start.forward, compiled.start.up);
  const bot = new BotDriver(compiled, { aggression: 0.95 });
  car.frozen = false; bot.reset(car);
  for (let s = 0; s < 120 * 14; s++) {
    const inp = bot.update(car);
    car.input = inp;
    car.preStep(); pw.step(); car.postStep();
    if (s % 30 === 0 && car.position.z > 60) {
      const f = compiled.frames[bot.frameIndex];
      console.log(`t=${(s * PHYSICS_DT).toFixed(2)} pos=(${car.position.x.toFixed(1)},${car.position.y.toFixed(1)},${car.position.z.toFixed(1)}) up=(${car.up.x.toFixed(2)},${car.up.y.toFixed(2)},${car.up.z.toFixed(2)}) fwd=(${car.forward.x.toFixed(2)},${car.forward.y.toFixed(2)},${car.forward.z.toFixed(2)}) v=${car.telemetry.speedAbs.toFixed(1)} gw=${car.telemetry.groundedWheels} steer=${inp.steer.toFixed(2)} thr=${inp.throttle} frame=(${f.pos.x.toFixed(1)},${f.pos.y.toFixed(1)},${f.pos.z.toFixed(1)}) fup=(${f.up.x.toFixed(2)},${f.up.y.toFixed(2)},${f.up.z.toFixed(2)})`);
    }
    if (car.position.y < -20) { console.log('FELL at', car.position); break; }
  }
  pw.dispose();
});
